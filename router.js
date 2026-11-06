const express = require('express');
const path = require('path');
const auth = require('./auth');
const loginController = require('./modules/login/controllers/login');
const verifyTurnstile = require('./middleware/verifyTurnstile');
const { getTurnstileSiteKey } = require('./middleware/turnstileConfig');

const router = express.Router();

const MODULE_NAME_PATTERN = /^[A-Za-z][A-Za-z0-9_-]{0,79}$/;
const ACTION_NAME_PATTERN = /^[A-Za-z][A-Za-z0-9_]{0,79}$/;
const SKIP_DYNAMIC_MODULES = new Set(['favicon.ico', 'assets', 'css', 'js', 'img', 'fonts', 'uploads']);
const SKIP_DYNAMIC_INDEX_MODULES = new Set([...SKIP_DYNAMIC_MODULES, 'login', 'logout']);

// Action yang TIDAK BOLEH dipanggil lewat dispatch dinamis walaupun lolos allow-list di bawah.
// Pertahankan daftar ini sebagai pengaman bila nanti menambah handler yang menjalankan
// perintah shell / operasi server.
const DENIED_DYNAMIC_ACTIONS = new Set(['backupDatabase', 'checkMigrations', 'checkoutTag', 'clearLogs', 'createTag', 'executeCommand', 'generate', 'getEnvVars', 'getMetrics', 'getPM2Status', 'getSystemInfo', 'gitPull', 'gitStatus', 'npmCleanInstall', 'npmInstall', 'pull', 'rebootServer', 'restartService', 'runMigrations', 'startService', 'stopService', 'viewLogs']);

// Action dengan nama persis yang diizinkan.
const EXACT_DYNAMIC_ACTIONS = new Set(['add', 'buildModule', 'changePassword', 'createRole', 'data', 'detail', 'edit', 'index', 'list', 'logout', 'logoutDevice', 'parents', 'resetAvatar', 'rowId', 'search']);

// Action yang diawali prefix ini otomatis diizinkan (contoh: getXxx, saveXxx, deleteXxx).
const DYNAMIC_ACTION_PREFIXES = ['combo', 'data', 'delete', 'detail', 'download', 'edit', 'export', 'get', 'hapus', 'import', 'insert', 'lookup', 'preview', 'save', 'select', 'tambah', 'update', 'upload', 'validasi', 'view'];

function wantsJson(req) {
    return req.xhr || req.headers['x-requested-with'] === 'XMLHttpRequest' || (req.headers.accept || '').includes('application/json');
}

function sendDynamicNotFound(req, res, message) {
    if (wantsJson(req)) {
        return res.status(404).json({ success: false, message });
    }
    return res.status(404).send(message);
}

function isSafeDynamicName(value, pattern) {
    return typeof value === 'string' && pattern.test(value) && !value.includes('..');
}

function isAllowedDynamicAction(action) {
    if (!isSafeDynamicName(action, ACTION_NAME_PATTERN)) return false;
    if (DENIED_DYNAMIC_ACTIONS.has(action)) return false;
    if (EXACT_DYNAMIC_ACTIONS.has(action)) return true;

    return DYNAMIC_ACTION_PREFIXES.some((prefix) => {
        return action === prefix || action.startsWith(prefix[0].toLowerCase() + prefix.slice(1)) || action.startsWith(prefix[0].toUpperCase() + prefix.slice(1));
    });
}

function loadDynamicController(moduleName) {
    const modulesRoot = path.resolve(__dirname, 'modules');
    const controllerPath = path.resolve(modulesRoot, moduleName, 'controllers', `${moduleName}.js`);
    const modulesRootWithSep = modulesRoot.endsWith(path.sep) ? modulesRoot : modulesRoot + path.sep;

    if (!controllerPath.startsWith(modulesRootWithSep)) {
        const error = new Error('Module tidak valid.');
        error.status = 404;
        throw error;
    }

    return require(controllerPath);
}

async function dispatchDynamicAction(req, res, next, defaultAction = null) {
    const moduleName = req.params.module;
    const action = defaultAction || req.params.action;

    if ((defaultAction === 'index' && SKIP_DYNAMIC_INDEX_MODULES.has(moduleName)) || SKIP_DYNAMIC_MODULES.has(moduleName)) {
        return next();
    }

    if (!isSafeDynamicName(moduleName, MODULE_NAME_PATTERN)) {
        return sendDynamicNotFound(req, res, 'Module tidak valid.');
    }

    if (!isAllowedDynamicAction(action)) {
        return sendDynamicNotFound(req, res, 'Action tidak diizinkan.');
    }

    try {
        const controller = loadDynamicController(moduleName);
        const handler = Object.prototype.hasOwnProperty.call(controller, action) ? controller[action] : null;

        if (typeof handler !== 'function') {
            return next();
        }

        return await handler(req, res, next);
    } catch (err) {
        if (err.code === 'MODULE_NOT_FOUND' || err.status === 404) {
            return next();
        }

        return next(err);
    }
}

// Teks identitas di halaman login; bisa diganti lewat .env
function getLoginBranding() {
    return {
        instansi1: process.env.LOGIN_INSTANSI_1 || 'PEMERINTAH PROVINSI BALI',
        instansi2: process.env.LOGIN_INSTANSI_2 || 'RUMAH SAKIT MATA BALI MANDARA',
        judul: process.env.LOGIN_JUDUL || 'SIPADU',
        judulAksen: process.env.LOGIN_JUDUL_AKSEN || 'BLUD',
        tagline: process.env.LOGIN_TAGLINE || 'Sistem Integrasi Pendapatan Pasien Terpadu ke BLUD',
        pengembang: process.env.LOGIN_PENGEMBANG || 'PT Quantum Sistem Intermatika',
        kontakAdmin: process.env.LOGIN_KONTAK_ADMIN || '',
    };
}

function renderLogin(req, res) {
    const flashInfo = req.flash ? req.flash('info') : [];
    const flashSuccess = req.flash ? req.flash('success') : [];
    res.render('vw_login', {
        nameapp: process.env.APP_NAME || 'Express MSSQL Boilerplate',
        msg: req.query.msg || '',
        error_msg: flashInfo[0] || req.query.error_msg || '',
        success_msg: flashSuccess[0] || '',
        turnstileSiteKey: getTurnstileSiteKey(),
        branding: getLoginBranding(),
    });
}

// Halaman utama: login atau redirect ke dashboard
router.get('/', function (req, res) {
    if (!req.session.logged_in) {
        return renderLogin(req, res);
    }
    res.redirect('/home');
});

// Route login page harus berada sebelum route dinamis /:module.
router.get('/login', function (req, res) {
    if (req.session.logged_in) {
        return res.redirect('/');
    }
    renderLogin(req, res);
});

router.post('/login/process', verifyTurnstile, loginController.process);

const protectedRoute = [auth.check_login, auth.check_session_valid];

// Route untuk /module (langsung panggil controller index)
router.get('/:module', protectedRoute, async function (req, res, next) {
    return dispatchDynamicAction(req, res, next, 'index');
});

// Routing dinamis: /:module/:action dan /:module/:action/:id -> controller[action]
['get', 'post', 'put', 'delete'].forEach((method) => {
    router[method]('/:module/:action', protectedRoute, async function (req, res, next) {
        return dispatchDynamicAction(req, res, next);
    });
    router[method]('/:module/:action/:id', protectedRoute, async function (req, res, next) {
        return dispatchDynamicAction(req, res, next);
    });
});

module.exports = router;
