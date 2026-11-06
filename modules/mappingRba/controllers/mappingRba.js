const db = require('../../../database');
const { checkAccess } = require('../../../helpers/accessControl');
const { emptyDataTables, dataTablesParams, catatLog } = require('../../../helpers/integrasi');

// Mapping kode layanan rumah sakit (LAYANAN_RS) ke rekening pendapatan RBA BLUD (REKENING_RBA).

const ORDERABLE_LAYANAN = { 1: 'kdLAYANAN', 2: 'uraian' };

// Tampilkan halaman mapping
exports.index = async function (req, res) {
    try {
        if (!checkAccess(req, 'view')) {
            return res.status(403).send('Tidak memiliki akses');
        }

        const vars = {
            title: 'Mapping Layanan & RBA',
            subtitle: 'Pemetaan kode layanan rumah sakit ke rekening pendapatan RBA',
            module: 'mappingRba',
            akses: req.session.aksesMenu.mappingRba || {},
        };

        const viewPath = 'mappingRba/views/vw_data.html';
        if (req.xhr || req.headers['x-requested-with'] === 'XMLHttpRequest') {
            res.render(viewPath, vars);
        } else {
            vars.content = viewPath;
            res.render('index', vars);
        }
    } catch (err) {
        console.error('Error in mappingRba.index:', err);
        res.status(500).send('Error: ' + err.message);
    }
};

// Data layanan RS untuk DataTables
exports.dataLayanan = async function (req, res) {
    if (!checkAccess(req, 'view')) {
        return res.status(403).json(emptyDataTables(req, 'Tidak memiliki akses untuk melihat data'));
    }
    try {
        const p = dataTablesParams(req.query, ORDERABLE_LAYANAN, 'kdLAYANAN');
        const where = 'WHERE kdLAYANAN LIKE @search OR uraian LIKE @search';

        const pool = await db.poolPromise;
        const result = await pool.request()
            .input('search', db.sql.NVarChar, '%' + p.search + '%')
            .input('start', db.sql.Int, p.start)
            .input('length', db.sql.Int, p.length)
            .query(`
                SELECT COUNT(*) AS total FROM LAYANAN_RS;
                SELECT COUNT(*) AS total FROM LAYANAN_RS ${where};
                SELECT kdLAYANAN AS kdLayanan, uraian
                FROM LAYANAN_RS
                ${where}
                ORDER BY ${p.orderColumn} ${p.orderDir}
                OFFSET @start ROWS FETCH NEXT @length ROWS ONLY;
            `);

        res.json({
            draw: p.draw,
            recordsTotal: result.recordsets[0][0].total,
            recordsFiltered: result.recordsets[1][0].total,
            data: result.recordsets[2],
            error: null
        });
    } catch (err) {
        res.json(emptyDataTables(req, err.message));
    }
};

// Daftar uraian layanan (DISTINCT KAS_SIMRS_DETAIL.uraian) untuk satu layanan / kode rekening SIM RS
exports.detailLayanan = async function (req, res) {
    if (!checkAccess(req, 'view')) {
        return res.status(403).json({ success: false, message: 'Tidak memiliki akses' });
    }
    const id = req.params.id || req.query.id;
    try {
        const pool = await db.poolPromise;
        const result = await pool.request()
            .input('kdREK', db.sql.NVarChar, id)
            .query(`
                SELECT DISTINCT ISNULL(uraian, '-') AS uraian
                FROM KAS_SIMRS_DETAIL
                WHERE kdREK = @kdREK
                ORDER BY uraian;
            `);
        res.json({ success: true, data: result.recordset });
    } catch (err) {
        res.json({ success: false, message: err.message });
    }
};

// Sinkronisasi daftar layanan dari hasil SIM RS: DISTINCT kdREK/nmRekening di KAS_SIMRS_DETAIL di-MERGE ke LAYANAN_RS.
// Layanan baru otomatis dipetakan ke REKENING_RBA dengan kode yang sama (bila ada); mapping yang sudah ada tidak diubah.
exports.updateSinkronisasi = async function (req, res) {
    if (!checkAccess(req, 'edit')) {
        return res.status(403).json({ success: false, message: 'Tidak memiliki akses' });
    }
    try {
        const pool = await db.poolPromise;
        const result = await pool.request().query(`
            DECLARE @hasil TABLE (aksi NVARCHAR(10));
            MERGE LAYANAN_RS AS t
            USING (
                SELECT d.kdREK, MAX(d.nmRekening) AS nmRekening, MAX(r.keyREK) AS keyREK
                FROM KAS_SIMRS_DETAIL d LEFT JOIN REKENING_RBA r ON r.kdREK = d.kdREK
                GROUP BY d.kdREK
            ) AS s ON t.kdLAYANAN = s.kdREK
            WHEN MATCHED AND t.uraian <> s.nmRekening THEN UPDATE SET uraian = s.nmRekening
            WHEN NOT MATCHED THEN INSERT (kdLAYANAN, uraian, keyREK) VALUES (s.kdREK, s.nmRekening, s.keyREK)
            OUTPUT $action INTO @hasil;
            SELECT
                (SELECT COUNT(*) FROM @hasil WHERE aksi = 'INSERT') AS baru,
                (SELECT COUNT(*) FROM @hasil WHERE aksi = 'UPDATE') AS diubah,
                (SELECT COUNT(*) FROM LAYANAN_RS) AS jumlah,
                (SELECT COUNT(*) FROM LAYANAN_RS WHERE keyREK IS NULL) AS belumMapping;
        `);
        const r = result.recordset[0];

        await catatLog(pool, {
            httpCode: 200, metode: 'SYNC', endpoint: 'mapping-rba', ref: 'MAPPING',
            body: { job: 'sinkronisasi-mapping', status: 200, message: 'Layanan RS disinkronkan dari data kas SIM RS', baru: r.baru, diubah: r.diubah, jumlah_layanan: r.jumlah, belum_mapping: r.belumMapping, dipicu_oleh: req.session.user },
        });
        res.json({ success: true, message: 'Sinkronisasi selesai: ' + r.baru + ' layanan baru, ' + r.diubah + ' diperbarui, ' + r.jumlah + ' total (' + r.belumMapping + ' belum dipetakan)' });
    } catch (err) {
        res.json({ success: false, message: err.message });
    }
};
