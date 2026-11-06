const db = require('../../../database');
const { checkAccess } = require('../../../helpers/accessControl');
const { isValidDate } = require('../../../helpers/integrasi');

// Jejak permintaan API dan status pengiriman ke SIPKD (LOG_API).

// Tampilkan halaman log
exports.index = async function (req, res) {
    try {
        if (!checkAccess(req, 'view')) {
            return res.status(403).send('Tidak memiliki akses');
        }

        const vars = {
            title: 'Log API & Audit',
            subtitle: 'Jejak permintaan API dan status pengiriman ke SIPKD',
            module: 'logApi',
            akses: req.session.aksesMenu.logApi || {},
        };

        const viewPath = 'logApi/views/vw_data.html';
        if (req.xhr || req.headers['x-requested-with'] === 'XMLHttpRequest') {
            res.render(viewPath, vars);
        } else {
            vars.content = viewPath;
            res.render('index', vars);
        }
    } catch (err) {
        console.error('Error in logApi.index:', err);
        res.status(500).send('Error: ' + err.message);
    }
};

// Daftar log (maks. 200 terbaru) dengan filter tanggal (YYYY-MM-DD) dan status (success | failed)
exports.data = async function (req, res) {
    if (!checkAccess(req, 'view')) {
        return res.status(403).json({ success: false, message: 'Tidak memiliki akses', data: [] });
    }
    const tanggal = isValidDate(req.query.tanggal) ? req.query.tanggal : null;
    const status = ['success', 'failed'].includes(req.query.status) ? req.query.status : null;
    try {
        const pool = await db.poolPromise;
        const result = await pool.request()
            .input('tanggal', db.sql.VarChar, tanggal)
            .input('status', db.sql.VarChar, status)
            .query(`
                SELECT TOP 200 keyLOG AS id, CONVERT(VARCHAR(19), waktu, 126) AS waktu, httpCode, metode, endpoint, ref, body
                FROM LOG_API
                WHERE (@tanggal IS NULL OR CAST(waktu AS DATE) = CAST(@tanggal AS DATE))
                  AND (@status IS NULL OR (@status = 'success' AND httpCode < 400) OR (@status = 'failed' AND httpCode >= 400))
                ORDER BY waktu DESC, keyLOG DESC
            `);

        const data = result.recordset.map(row => {
            let body;
            try {
                body = JSON.parse(row.body);
            } catch (e) {
                body = row.body;
            }
            return { ...row, body };
        });
        res.json({ success: true, data });
    } catch (err) {
        res.json({ success: false, message: err.message, data: [] });
    }
};
