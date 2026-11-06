const db = require('../../../database');
const { checkAccess } = require('../../../helpers/accessControl');
const { getPengaturan, catatLog } = require('../../../helpers/integrasi');
const simrs = require('../../../helpers/simrsClient');
const { rerunAllSeeders } = require('../../../scripts/migrate');

const ADMIN_USER_ID = 'admin';

// Reset data hanya untuk development, dan hanya boleh dilakukan user admin
function isResetEnabled() {
    return process.env.NODE_ENV === 'development';
}

// Tabel identity yang dikosongkan total saat reset (urutan aman terhadap foreign key)
const RESET_TABLES = ['KAS_SIMRS_DETAIL', 'KAS_SIMRS', 'REKAP_PENERIMAAN', 'BERITA_ACARA', 'LOG_API', 'LAYANAN_RS', 'REKENING_RBA', 'CONTOH'];

// Konfigurasi endpoint SIPKD BLUD, rekening BLUD default, dan jadwal sinkronisasi otomatis
// (PENGATURAN_INTEGRASI, selalu satu baris keyPENGATURAN = 1).
// TODO: hubungkan autoSync/jamSync ke scheduler, dan pertimbangkan enkripsi apiToken.

// Tampilkan form pengaturan; token tidak pernah dikirim balik ke browser
exports.index = async function (req, res) {
    try {
        if (!checkAccess(req, 'view')) {
            return res.status(403).send('Tidak memiliki akses');
        }

        const pool = await db.poolPromise;
        const { apiToken, ...pengaturan } = await getPengaturan(pool);

        const vars = {
            title: 'Pengaturan Integrasi',
            subtitle: 'Konfigurasi endpoint SIPKD dan jadwal sinkronisasi otomatis',
            module: 'pengaturanIntegrasi',
            akses: req.session.aksesMenu.pengaturanIntegrasi || {},
            pengaturan,
            adaToken: !!apiToken,
            simrs: {
                baseUrl: process.env.SIMRS_API_BASE_URL || '',
                consId: process.env.SIMRS_CONS_ID || '',
                adaSecret: !!process.env.SIMRS_SECRET_KEY,
            },
            bolehReset: isResetEnabled() && req.session.user_id === ADMIN_USER_ID,
        };

        const viewPath = 'pengaturanIntegrasi/views/vw_data.html';
        if (req.xhr || req.headers['x-requested-with'] === 'XMLHttpRequest') {
            res.render(viewPath, vars);
        } else {
            vars.content = viewPath;
            res.render('index', vars);
        }
    } catch (err) {
        console.error('Error in pengaturanIntegrasi.index:', err);
        res.status(500).send('Error: ' + err.message);
    }
};

// Tes koneksi ke API SIM RS: minta token baru (kredensial dari .env)
exports.getTesKoneksiSimrs = async function (req, res) {
    if (!checkAccess(req, 'view')) {
        return res.status(403).json({ success: false, message: 'Tidak memiliki akses' });
    }
    try {
        await simrs.getToken(true);
        res.json({ success: true, message: 'Terhubung ke API SIM RS, token berhasil diambil' });
    } catch (err) {
        res.json({ success: false, message: err.message });
    }
};

// Reset semua data aplikasi ke kondisi awal (khusus NODE_ENV=development, khusus user admin).
// Dikosongkan: data integrasi, CONTOH, user selain admin + perangkatnya, kelompok selain kelompok admin.
// Dipertahankan: user admin, kelompok admin, menu FITUR, hak akses kelompok admin, PENGATURAN_INTEGRASI.
// Setelah itu semua seeder dijalankan ulang supaya data awal (user admin, menu, hak akses) lengkap kembali.
// Data kas hanya berasal dari API SIM RS, jadi tarik ulang lewat Sinkronisasi Data bila perlu.
exports.deleteSemuaData = async function (req, res) {
    if (!isResetEnabled()) {
        return res.status(403).json({ success: false, message: 'Reset data hanya tersedia saat NODE_ENV=development' });
    }
    if (!checkAccess(req, 'delete') || req.session.user_id !== ADMIN_USER_ID) {
        return res.status(403).json({ success: false, message: 'Reset data hanya boleh dilakukan user admin' });
    }
    if (req.body.konfirmasi !== 'RESET') {
        return res.json({ success: false, message: 'Ketik RESET untuk konfirmasi' });
    }

    try {
        const pool = await db.poolPromise;
        const deletes = RESET_TABLES.map(t => `DELETE FROM ${t};`).join('\n');
        const reseeds = RESET_TABLES.map(t => `
            IF (SELECT last_value FROM sys.identity_columns WHERE object_id = OBJECT_ID(N'dbo.${t}')) IS NOT NULL
                DBCC CHECKIDENT ('dbo.${t}', RESEED, 0) WITH NO_INFOMSGS;`).join('');

        await pool.request()
            .input('adminUserID', db.sql.NVarChar, ADMIN_USER_ID)
            .query(`
                SET XACT_ABORT ON;
                IF NOT EXISTS (SELECT 1 FROM APPUSER WHERE userID = @adminUserID)
                    THROW 50001, 'User admin tidak ditemukan, reset dibatalkan', 1;

                BEGIN TRAN;
                ${deletes}

                -- Kelompok yang dipertahankan: kelompok milik user admin + kelompok bernama admin
                DECLARE @klpAdmin TABLE (keyKLP BIGINT PRIMARY KEY);
                INSERT INTO @klpAdmin
                SELECT keyKLP FROM APPUSER WHERE userID = @adminUserID
                UNION SELECT keyKLP FROM KELOMPOK WHERE nmKLP = N'admin';

                DELETE FROM USER_DEVICES WHERE userID <> @adminUserID;
                DELETE FROM APPUSER WHERE userID <> @adminUserID;
                DELETE FROM OTORISASI WHERE keyKLP NOT IN (SELECT keyKLP FROM @klpAdmin);
                DELETE FROM KELOMPOK WHERE keyKLP NOT IN (SELECT keyKLP FROM @klpAdmin);
                ${reseeds}
                COMMIT;
            `);

        const seeders = await rerunAllSeeders(pool);
        await catatLog(pool, {
            httpCode: 200, metode: 'RESET', endpoint: 'reset-data', ref: 'DEV',
            body: { job: 'reset-data', status: 200, message: 'Data aplikasi direset ke kondisi awal', tabel: RESET_TABLES, seeder: seeders, dipicu_oleh: req.session.user },
        });

        res.json({ success: true, message: 'Data direset dan ' + seeders.length + ' seeder dijalankan ulang' });
    } catch (err) {
        console.error('Error in pengaturanIntegrasi.deleteSemuaData:', err);
        res.json({ success: false, message: err.message });
    }
};

// Simpan konfigurasi; token kosong berarti token lama dipertahankan
exports.save = async function (req, res) {
    if (!checkAccess(req, 'edit')) {
        return res.status(403).json({ success: false, message: 'Tidak memiliki akses' });
    }
    const info = req.body;

    let url;
    try {
        url = new URL(info.apiBaseUrl);
    } catch (e) {
        return res.json({ success: false, message: 'URL Base API tidak valid' });
    }
    if (!['http:', 'https:'].includes(url.protocol)) {
        return res.json({ success: false, message: 'URL Base API harus http/https' });
    }
    if (!/^([01]\d|2[0-3]):[0-5]\d$/.test(info.jamSync || '')) {
        return res.json({ success: false, message: 'Waktu eksekusi tidak valid' });
    }

    try {
        const pool = await db.poolPromise;
        await pool.request()
            .input('apiBaseUrl', db.sql.NVarChar, url.href)
            .input('apiToken', db.sql.NVarChar, info.apiToken || null)
            .input('autoSync', db.sql.Bit, info.autoSync === '1')
            .input('jamSync', db.sql.Char(5), info.jamSync)
            .input('bankBlud', db.sql.NVarChar, info.bankBlud || null)
            .input('noRekBlud', db.sql.NVarChar, info.noRekBlud || null)
            .input('nmRekBlud', db.sql.NVarChar, info.nmRekBlud || null)
            .input('updatedBy', db.sql.NVarChar, req.session.user || null)
            .query(`
                MERGE PENGATURAN_INTEGRASI AS t
                USING (SELECT 1 AS keyPENGATURAN) AS s ON t.keyPENGATURAN = s.keyPENGATURAN
                WHEN MATCHED THEN UPDATE SET
                    apiBaseUrl = @apiBaseUrl,
                    apiToken = ISNULL(@apiToken, t.apiToken),
                    autoSync = @autoSync,
                    jamSync = @jamSync,
                    bankBlud = @bankBlud,
                    noRekBlud = @noRekBlud,
                    nmRekBlud = @nmRekBlud,
                    updatedBy = @updatedBy,
                    updatedAt = GETDATE()
                WHEN NOT MATCHED THEN
                    INSERT (keyPENGATURAN, apiBaseUrl, apiToken, autoSync, jamSync, bankBlud, noRekBlud, nmRekBlud, updatedBy)
                    VALUES (1, @apiBaseUrl, @apiToken, @autoSync, @jamSync, @bankBlud, @noRekBlud, @nmRekBlud, @updatedBy);
            `);

        res.json({ success: true, message: 'Konfigurasi berhasil disimpan' });
    } catch (err) {
        res.json({ success: false, message: err.message });
    }
};
