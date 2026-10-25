var createError = require('http-errors');
var express = require('express');
var path = require('path');
var cookieParser = require('cookie-parser');
var logger = require('morgan');
var flash = require('express-flash');
var session = require('express-session');
var fs = require('fs');

// Load environment variables
require('dotenv').config();

var cors = require('cors');
var app = express();
app.set('trust proxy', 1);
var bodyParser = require('body-parser');
var https = require('https');
var http = require('http');
const db = require('./database');
const router = require('./router');
var SequelizeStore = require('connect-session-sequelize')(session.Store);

const PORT = process.env.PORT || 2301;

// Inisialisasi session store
var sessionStore = new SequelizeStore({
    db: db.sequelize,
    // tableName: 'Sessions', // opsional, default 'Sessions'
});

// Sync table session agar otomatis dibuat jika belum ada
sessionStore.sync().catch((err) => {
    console.error('❌ Gagal menyiapkan tabel Sessions:', err.message);
});

const defaultCorsOrigins = [`http://localhost:${PORT}`, `http://127.0.0.1:${PORT}`];

function getAllowedCorsOrigins() {
    return (process.env.CORS_ORIGINS || defaultCorsOrigins.join(','))
        .split(',')
        .map((origin) => origin.trim())
        .filter(Boolean);
}

function isAllowedCorsOrigin(origin) {
    if (!origin) return true;
    return getAllowedCorsOrigins().includes(origin);
}

app.use(cors({
    origin: function (origin, callback) {
        callback(null, isAllowedCorsOrigin(origin));
    },
    credentials: true,
    methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
    allowedHeaders: ['Origin', 'X-Requested-With', 'Content-Type', 'Accept', 'Authorization'],
}));

// Basic hardening for bot scans and burst traffic
const ipSecurityState = new Map();
const SECURITY_WINDOW_MS = 60 * 1000; // 1 minute
const SECURITY_MAX_REQUESTS = 300; // per IP per minute
const SECURITY_BLOCK_MS = 5 * 60 * 1000; // 5 minutes
const PROBE_BLOCK_MS = 15 * 60 * 1000; // 15 minutes
const PROBE_MAX = 10; // suspicious hits before block

const suspiciousPathPatterns = [
    /^\/\.env(?:$|[./])/i,
    /^\/\.git(?:$|\/)/i,
    /^\/admin\/config\.php$/i,
    /^\/webui(?:$|\/)/i,
    /^\/geoserver(?:$|\/)/i,
    /^\/sitemap\.xml$/i,
];

function getClientIp(req) {
    const xff = req.headers['x-forwarded-for'];
    if (xff && typeof xff === 'string') {
        return xff.split(',')[0].trim();
    }
    const connIp = req.connection && req.connection.remoteAddress ? req.connection.remoteAddress : null;
    return req.ip || connIp || 'unknown';
}

function isSuspiciousPath(pathname) {
    if (!pathname) return false;
    return suspiciousPathPatterns.some((pattern) => pattern.test(pathname));
}

app.use((req, res, next) => {
    const now = Date.now();
    const ip = getClientIp(req);
    const pathname = req.path || '/';
    const suspicious = isSuspiciousPath(pathname);

    let state = ipSecurityState.get(ip);
    if (!state || now > state.resetAt) {
        state = {
            count: 0,
            resetAt: now + SECURITY_WINDOW_MS,
            blockedUntil: 0,
            probeHits: 0,
        };
    }

    // Temporary block
    if (state.blockedUntil && now < state.blockedUntil) {
        ipSecurityState.set(ip, state);
        return res.status(429).send('Too Many Requests');
    }

    // Handle suspicious scanning paths (return 404, not redirect/login)
    if (suspicious) {
        state.probeHits += 1;
        if (state.probeHits >= PROBE_MAX) {
            state.blockedUntil = now + PROBE_BLOCK_MS;
            ipSecurityState.set(ip, state);
            return res.status(429).send('Too Many Requests');
        }
        ipSecurityState.set(ip, state);
        return res.status(404).send('Not Found');
    }

    // Normal per-IP rate limit
    state.count += 1;
    if (state.count > SECURITY_MAX_REQUESTS) {
        state.blockedUntil = now + SECURITY_BLOCK_MS;
        ipSecurityState.set(ip, state);
        return res.status(429).send('Too Many Requests');
    }

    ipSecurityState.set(ip, state);
    next();
});

// Cleanup old IP states (prevent unbounded map growth)
setInterval(() => {
    const now = Date.now();
    for (const [ip, state] of ipSecurityState.entries()) {
        if (now > state.resetAt && now > (state.blockedUntil || 0)) {
            ipSecurityState.delete(ip);
        }
    }
}, 10 * 60 * 1000).unref();

app.use(
    bodyParser.json({
        limit: '100mb',
        extended: true,
    })
);
app.use(
    bodyParser.urlencoded({
        limit: '100mb',
        extended: true,
        parameterLimit: 100000,
    })
);

// Timeout yang lebih besar untuk request yang lama
app.use((req, res, next) => {
    // Set timeout 5 menit untuk route import
    if (req.path.includes('/import')) {
        req.setTimeout(300000); // 5 menit
        res.setTimeout(300000); // 5 menit
    }
    next();
});

// view engine setup
app.engine('html', require('ejs').renderFile);
app.set('views', [path.join(__dirname, 'views'), path.join(__dirname, 'modules')]);
app.set('view engine', 'ejs');

app.use(
    logger('dev', {
        skip: (req) => isSuspiciousPath(req.path),
    })
);
app.use(cookieParser());

// Template .html hanya boleh dirender lewat res.render, bukan diakses langsung
app.use('/', (req, res, next) => {
    if (req.path.endsWith('.html')) {
        return res.status(403).send('Access to HTML files is forbidden');
    }
    next();
});

// Static asset dengan cache 30 hari
app.use(
    express.static(path.join(__dirname, 'public'), {
        maxAge: '30d',
        setHeaders: function (res, filePath) {
            if (filePath.match(/\.(js|css|png|jpg|jpeg|gif|svg|woff|woff2|ttf|eot)$/)) {
                res.setHeader('Cache-Control', 'public, max-age=2592000, immutable');
            }
        },
    })
);

app.get('/favicon.ico', (req, res) => res.status(204).end());

const sessionSecret = process.env.SESSION_SECRET || (process.env.NODE_ENV === 'production' ? '' : 'dev-session-secret-change-me');
const secureSessionCookie = process.env.COOKIE_SECURE
    ? process.env.COOKIE_SECURE === 'true'
    : process.env.NODE_ENV === 'production';

if (!sessionSecret) {
    throw new Error('SESSION_SECRET wajib disiapkan untuk production.');
}

app.use(
    session({
        secret: sessionSecret,
        cookie: {
            httpOnly: true,
            secure: secureSessionCookie,
            sameSite: process.env.COOKIE_SAME_SITE || 'lax',
            maxAge: parseInt(process.env.SESSION_MAX_AGE) || 1000 * 60 * 60 * 24 * 7, // 7 hari
        },
        resave: false, // best practice
        saveUninitialized: false, // best practice
        store: sessionStore,
    })
);

// Flash messages (requires session middleware)
app.use(flash());

// Reset session variable per-modul saat pindah menu (sebelum router)
const resetMenuSession = require('./middleware/resetMenuSession');
app.use(resetMenuSession);

// Middleware untuk load menu dinamis dari database MSSQL
app.use(async (req, res, next) => {
    if (req.session.logged_in && req.session.keyKLP) {
        try {
            const pool = await db.poolPromise;
            // Query semua FITUR untuk struktur menu
            const fiturResult = await pool.request().query('SELECT keyFITUR, nmFITUR, kdFITUR, parentKeyFITUR, url FROM FITUR ORDER BY kdFITUR');

            // Query OTORISASI berdasarkan keyKLP
            const otorisasiResult = await pool.request()
                .input('keyKLP', db.sql.BigInt, req.session.keyKLP)
                .query('SELECT keyFITUR, aksi FROM OTORISASI WHERE keyKLP = @keyKLP');

            // Bangun akses per fitur
            const aksesFitur = {};
            otorisasiResult.recordset.forEach(row => {
                if (!aksesFitur[row.keyFITUR]) {
                    aksesFitur[row.keyFITUR] = {};
                }
                aksesFitur[row.keyFITUR][row.aksi] = true;
            });

            // Bangun struktur menu sebagai array untuk sidebar loop
            const menuArray = [];
            const menuMap = {};

            fiturResult.recordset.forEach(fitur => {
                const akses = aksesFitur[fitur.keyFITUR];
                if (akses && akses.view) {
                    const menuItem = {
                        ...fitur,
                        hasSub: fiturResult.recordset.some(sub => sub.parentKeyFITUR == fitur.keyFITUR && aksesFitur[sub.keyFITUR] && aksesFitur[sub.keyFITUR].view),
                        subMenus: []
                    };
                    menuMap[fitur.keyFITUR] = menuItem;
                    if (!fitur.parentKeyFITUR) {
                        menuArray.push(menuItem);
                    }
                }
            });

            // Build sub menus
            fiturResult.recordset.forEach(fitur => {
                if (fitur.parentKeyFITUR && menuMap[fitur.keyFITUR]) {
                    const parent = menuMap[fitur.parentKeyFITUR];
                    if (parent) {
                        parent.subMenus.push(menuMap[fitur.keyFITUR]);
                    }
                }
            });

            // Sort subMenus by kdFITUR
            menuArray.forEach(item => {
                item.subMenus.sort((a, b) => a.kdFITUR.localeCompare(b.kdFITUR));
                item.subMenus.forEach(sub => {
                    if (sub.subMenus) {
                        sub.subMenus.sort((a, b) => a.kdFITUR.localeCompare(b.kdFITUR));
                    }
                });
            });

            req.session.menuArray = menuArray;

            // Gunakan nama module dari URL sebagai key di aksesMenu (untuk access control)
            const aksesMenu = {};
            fiturResult.recordset.forEach(fitur => {
                if (aksesFitur[fitur.keyFITUR] && fitur.url) {
                    // Ekstrak nama module dari URL (tanpa slash dan /index)
                    // Contoh: "/otorisasi/index" -> "otorisasi"
                    const moduleName = fitur.url.split('/').filter(Boolean)[0];
                    if (moduleName) {
                        aksesMenu[moduleName] = aksesFitur[fitur.keyFITUR];
                    }
                }
            });
            req.session.aksesMenu = aksesMenu;
        } catch (err) {
            console.error('Error loading menu:', err);
        }
    }
    next();
});

// Middleware untuk refresh user data dari database
app.use(async (req, res, next) => {
    if (req.session.logged_in && req.session.user_id) {
        try {
            const pool = await db.poolPromise;
            const result = await pool.request()
                .input('userID', db.sql.NVarChar, req.session.user_id)
                .query('SELECT avatar, nmUSER FROM APPUSER WHERE userID = @userID');

            if (result.recordset.length > 0) {
                const userData = result.recordset[0];
                req.session.avatar = userData.avatar;
                req.session.user = userData.nmUSER;
            }
        } catch (err) {
            console.error('Error refreshing user data:', err);
        }
    }
    next();
});

app.use((req, res, next) => {
    res.locals.nameapp = process.env.APP_NAME || 'Express MSSQL Boilerplate';
    res.locals.aksesMenu = req.session.aksesMenu || {};
    res.locals.fiturMap = req.session.fiturMap || {};
    res.locals.menuArray = req.session.menuArray || [];
    res.locals.akses = req.session.akses || {};
    res.locals.logged_in = req.session.logged_in;
    res.locals.user_id = req.session.user_id;
    res.locals.nmKLP = req.session.nmKLP; // nama kelompok

    // User object dengan semua data untuk view
    res.locals.user = {
        userID: req.session.user_id,
        nmUSER: req.session.user,
        keyKLP: req.session.keyKLP,
        ketUSER: req.session.ketUSER,
        avatar: req.session.avatar,
    };

    res.locals.keyKLP = req.session.keyKLP;
    res.locals.ketUSER = req.session.ketUSER;

    next();
});

// Override res.render untuk mencari view di folder modular
app.use(function (req, res, next) {
    const originalRender = res.render;

    res.render = function (view, options, callback) {
        // Jika view tidak memiliki path (misal: 'vw_data.html' bukan 'modules/user/vw_data.html')
        if (!view.includes('/') && !view.includes('\\')) {
            const urlParts = req.path.split('/').filter(Boolean);

            // Pengecekan khusus untuk URL /modules/...
            if (urlParts[0] === 'modules' && urlParts.length >= 2) {
                const modularViewPath = `modules/${urlParts[1]}/views/${view}`;
                if (fs.existsSync(path.join(__dirname, modularViewPath))) {
                    return originalRender.call(this, modularViewPath, options, callback);
                }
            }

            // Ambil modul dari URL (misal: /users/index -> users, lalu user)
            let moduleCandidates = [];
            if (urlParts.length > 0) {
                moduleCandidates = [urlParts[0], urlParts[0].endsWith('s') ? urlParts[0].slice(0, -1) : urlParts[0]];
            }

            for (const moduleName of moduleCandidates) {
                const modularViewPath = `modules/${moduleName}/views/${view}`;
                if (fs.existsSync(path.join(__dirname, modularViewPath))) {
                    return originalRender.call(this, modularViewPath, options, callback);
                }
            }
        }

        // Jika tidak ditemukan, gunakan render default (folder views/)
        return originalRender.call(this, view, options, callback);
    };

    next();
});

app.use('/', router);

// catch 404 and forward to error handler
app.use(function (req, res, next) {
    next(createError(404, 'Halaman tidak ditemukan'));
});

// error handler
app.use(function (err, req, res, next) {
    console.error('ERROR:', err);
    const acceptsJson = req.xhr || (req.headers.accept && req.headers.accept.indexOf('json') > -1);
    if (acceptsJson) {
        res.status(err.status || 500).json({ error: err.message });
    } else {
        const statusCode = err.status || 500;
        res.locals.message = statusCode === 404 ? 'Halaman yang Anda cari tidak ditemukan.' : 'Terjadi kesalahan pada server.';
        res.locals.error = {
            status: statusCode
        };
        res.status(statusCode);
        res.render('error');
    }
});

function resolveSslPath(sslPath) {
    if (!sslPath) return null;
    return path.isAbsolute(sslPath) ? sslPath : path.join(__dirname, sslPath);
}

function createAppServer(appInstance) {
    const sslEnabled = process.env.SSL_ENABLED === 'true';
    if (!sslEnabled) {
        console.log('SSL disabled. Starting HTTP server.');
        return http.createServer(appInstance);
    }

    const keyPath = resolveSslPath(process.env.SSL_KEY_PATH);
    const certPath = resolveSslPath(process.env.SSL_CERT_PATH);
    const caPath = resolveSslPath(process.env.SSL_CA_PATH);

    if (!keyPath || !certPath) {
        console.warn('SSL enabled but SSL_KEY_PATH or SSL_CERT_PATH is missing. Falling back to HTTP.');
        return http.createServer(appInstance);
    }

    try {
        const httpsOptions = {
            key: fs.readFileSync(keyPath, 'utf8'),
            cert: fs.readFileSync(certPath, 'utf8'),
        };

        if (caPath) {
            httpsOptions.ca = fs.readFileSync(caPath, 'utf8');
        }

        console.log(`SSL enabled. Starting HTTPS server with certificate: ${certPath}`);
        return https.createServer(httpsOptions, appInstance);
    } catch (error) {
        console.error(`Failed to initialize HTTPS (${error.message}). Falling back to HTTP.`);
        return http.createServer(appInstance);
    }
}

const server = createAppServer(app);

// Cek koneksi database saat startup
db.poolPromise
    .then(() => {
        console.log('✅ Database connected!');
    })
    .catch((err) => {
        console.error('❌ Database connection failed:', err.message);
    });

server.listen(PORT, () => {
    console.log(`app listening on port ${PORT}!`);
});

module.exports = app;
