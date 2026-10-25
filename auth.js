const { sql, poolPromise } = require('./database');
var asyncjs = require('async');
var sesi;

var Auth = {
	genAccess: function (req, res, next) {
		var baseurl = req.url;
		var mdl = baseurl.split("/");
		req.session.cls = mdl[1];
		sesi = req.session;
		if (!sesi.logged_in) {
			next();
		} else {
			asyncjs.waterfall([menu_role, menu], function (err, result) {
				next();
			});
		}
	},
	check_login: function (req, res, next) {
		if (!req.session.logged_in) {
			req.flash('info', 'Maaf, Sesi anda abis!');
			if (req.xhr || req.headers['x-requested-with'] === 'XMLHttpRequest' || (req.headers.accept || '').includes('application/json')) {
				return res.status(401).json({
					success: false,
					message: 'Sesi login berakhir. Silakan login kembali.',
					redirect: '/login'
				});
			}
			return res.redirect('/');
		}
		next();
	},
	check_session_valid: async function (req, res, next) {
		// Only check for logged in users
		if (!req.session.logged_in || !req.session.user_id) {
			return next();
		}

		try {
			const { poolPromise } = require('./database');
			const pool = await poolPromise;
			
			// Check if current session ID still exists in USER_DEVICES as active
			const sessionId = req.sessionID;
			const userId = req.session.user_id;
			
			const result = await pool.request()
				.input('sessionID', sql.NVarChar, sessionId)
				.input('userID', sql.NVarChar, userId)
				.query(`
					SELECT COUNT(*) as count 
					FROM USER_DEVICES 
					WHERE sessionID = @sessionID 
					  AND userID = @userID 
					  AND isActive = 1
				`);
			
		// If session not found or device not active, destroy session
		if (result.recordset[0].count === 0) {
			console.log(`⚠️ Invalid session detected for user ${userId}, destroying...`);

			// For AJAX requests, return 401 immediately before destroying
			if (req.xhr || req.headers['x-requested-with'] === 'XMLHttpRequest') {
				req.session.destroy(function(err) {
					if (err) console.error('Error destroying invalid session:', err);
				});
				return res.status(401).json({ 
					success: false, 
					message: 'Session tidak valid. Silakan login kembali.',
					redirect: '/login'
				});
			}

			// For normal requests, redirect to login with query parameter
			const message = 'Sesi Anda telah diakhiri dari perangkat lain.';
			const encodedMsg = encodeURIComponent(message);
			const redirectUrl = `/login?msg=${encodedMsg}`;

			// Destroy session and redirect; return immediately to avoid calling next() before redirect
			req.session.destroy(function(err) {
				if (err) console.error('Error destroying invalid session:', err);
				try {
					return res.redirect(redirectUrl);
				} catch (e) {
					console.error('Redirect failed after destroying session:', e);
				}
			});

			return; // prevent next() from executing while redirect is pending
		}

		// Session is valid, continue
		next();
		} catch (err) {
			console.error('Error checking session validity:', err);
			next(); // Continue even if check fails
		}
	}
};

// Dummy role menu: semua akses diizinkan
var menu_role = async function(callback) {
    try {
        const keyKLP = sesi.keyKLP; // pastikan keyKLP sudah ada di session user
        const pool = await poolPromise;
        const result = await pool.request()
          .input('keyKLP', sql.BigInt, keyKLP)
          .query('SELECT keyFITUR, aksi FROM OTORISASI WHERE keyKLP = @keyKLP');
        let roleme = {};
        result.recordset.forEach(row => {
            if (!roleme[row.keyFITUR]) roleme[row.keyFITUR] = {};
            roleme[row.keyFITUR][row.aksi] = true;
        });
        callback(null, roleme);
    } catch (err) {
        callback(err);
    }
};

var menu = function(rolemenu, callback) {
    const keyFITUR = sesi.keyFITUR; // pastikan keyFITUR sudah diketahui (misal dari route/menu aktif)
    let akses = {};
    if (rolemenu[keyFITUR]) {
        akses = {
            view: !!rolemenu[keyFITUR]['view'],
            add: !!rolemenu[keyFITUR]['add'],
            edit: !!rolemenu[keyFITUR]['edit'],
            del: !!rolemenu[keyFITUR]['delete'],
            exp: !!rolemenu[keyFITUR]['export'],
            valid: !!rolemenu[keyFITUR]['validasi'],
            // tambahkan aksi lain jika ada
        };
    }
    sesi.akses = akses;
    callback(null, true);
};

module.exports = Auth;
