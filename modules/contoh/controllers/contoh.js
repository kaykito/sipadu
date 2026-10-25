const db = require('../../../database');
const { checkAccess } = require('../../../helpers/accessControl');

// Modul referensi CRUD: tabel CONTOH dengan DataTables server-side (paging, cari, urut di SQL).
// Salin folder ini sebagai titik awal modul baru.

// Kolom yang boleh dipakai untuk ORDER BY (index sesuai urutan kolom di DataTables)
const ORDERABLE_COLUMNS = { 1: 'kdCONTOH', 2: 'nmCONTOH', 3: 'ketCONTOH' };

// Tampilkan halaman daftar contoh
exports.index = async function (req, res) {
    try {
        if (!checkAccess(req, 'view')) {
            return res.status(403).send('Tidak memiliki akses');
        }

        const vars = {
            title: 'Contoh',
            subtitle: 'Data Contoh',
            module: 'contoh',
            akses: req.session.aksesMenu.contoh || {},
        };

        const viewPath = 'contoh/views/vw_data.html';
        if (req.xhr || req.headers['x-requested-with'] === 'XMLHttpRequest') {
            res.render(viewPath, vars);
        } else {
            vars.content = viewPath;
            res.render('index', vars);
        }
    } catch (err) {
        console.error('Error in contoh.index:', err);
        res.status(500).send('Error: ' + err.message);
    }
};

// Ambil data untuk DataTables (server-side processing)
exports.data = async function (req, res) {
    const draw = parseInt(req.query.draw) || 1;
    try {
        if (!checkAccess(req, 'view')) {
            return res.status(403).json({
                draw,
                recordsTotal: 0,
                recordsFiltered: 0,
                data: [],
                error: 'Tidak memiliki akses untuk melihat data'
            });
        }

        const start = Math.max(parseInt(req.query.start) || 0, 0);
        const length = Math.min(Math.max(parseInt(req.query.length) || 10, 1), 1000);
        const search = (req.query.search && req.query.search.value) || '';
        const order = (req.query.order && req.query.order[0]) || {};
        const orderColumn = ORDERABLE_COLUMNS[order.column] || 'kdCONTOH';
        const orderDir = order.dir === 'desc' ? 'DESC' : 'ASC';

        const where = 'WHERE kdCONTOH LIKE @search OR nmCONTOH LIKE @search OR ketCONTOH LIKE @search';

        const pool = await db.poolPromise;
        const result = await pool.request()
            .input('search', db.sql.NVarChar, '%' + search + '%')
            .input('start', db.sql.Int, start)
            .input('length', db.sql.Int, length)
            .query(`
                SELECT COUNT(*) AS total FROM CONTOH;
                SELECT COUNT(*) AS total FROM CONTOH ${where};
                SELECT keyCONTOH, kdCONTOH, nmCONTOH, ketCONTOH
                FROM CONTOH
                ${where}
                ORDER BY ${orderColumn} ${orderDir}
                OFFSET @start ROWS FETCH NEXT @length ROWS ONLY;
            `);

        res.json({
            draw,
            recordsTotal: result.recordsets[0][0].total,
            recordsFiltered: result.recordsets[1][0].total,
            data: result.recordsets[2],
            error: null
        });
    } catch (err) {
        res.json({
            draw,
            recordsTotal: 0,
            recordsFiltered: 0,
            data: [],
            error: err.message
        });
    }
};

// Detail satu data untuk modal edit
exports.detail = async function (req, res) {
    if (!checkAccess(req, 'view')) {
        return res.status(403).json({ success: false, message: 'Tidak memiliki akses' });
    }

    const id = req.params.id || req.query.id;
    try {
        const pool = await db.poolPromise;
        const result = await pool.request()
            .input('keyCONTOH', db.sql.BigInt, id)
            .query('SELECT keyCONTOH, kdCONTOH, nmCONTOH, ketCONTOH FROM CONTOH WHERE keyCONTOH = @keyCONTOH');

        if (result.recordset.length === 0) {
            return res.json({ success: false, message: 'Data tidak ditemukan' });
        }
        res.json({ success: true, data: result.recordset[0] });
    } catch (err) {
        res.json({ success: false, message: err.message });
    }
};

// Simpan data baru
exports.insert = async function (req, res) {
    if (!checkAccess(req, 'add')) {
        return res.status(403).json({ success: false, message: 'Tidak memiliki akses' });
    }

    const info = req.body;
    if (!info.kdCONTOH || !info.nmCONTOH) {
        return res.json({ success: false, message: 'Kode dan nama wajib diisi' });
    }

    try {
        const pool = await db.poolPromise;
        await pool.request()
            .input('kdCONTOH', db.sql.NVarChar, info.kdCONTOH)
            .input('nmCONTOH', db.sql.NVarChar, info.nmCONTOH)
            .input('ketCONTOH', db.sql.NVarChar, info.ketCONTOH || null)
            .query('INSERT INTO CONTOH (kdCONTOH, nmCONTOH, ketCONTOH) VALUES (@kdCONTOH, @nmCONTOH, @ketCONTOH)');

        res.json({ success: true, message: 'Data berhasil ditambahkan' });
    } catch (err) {
        res.json({ success: false, message: err.message });
    }
};

// Perbarui data
exports.update = async function (req, res) {
    if (!checkAccess(req, 'edit')) {
        return res.status(403).json({ success: false, message: 'Tidak memiliki akses' });
    }

    const info = req.body;
    if (!info.keyCONTOH || !info.kdCONTOH || !info.nmCONTOH) {
        return res.json({ success: false, message: 'Kode dan nama wajib diisi' });
    }

    try {
        const pool = await db.poolPromise;
        await pool.request()
            .input('keyCONTOH', db.sql.BigInt, info.keyCONTOH)
            .input('kdCONTOH', db.sql.NVarChar, info.kdCONTOH)
            .input('nmCONTOH', db.sql.NVarChar, info.nmCONTOH)
            .input('ketCONTOH', db.sql.NVarChar, info.ketCONTOH || null)
            .query(`UPDATE CONTOH SET
                kdCONTOH = @kdCONTOH,
                nmCONTOH = @nmCONTOH,
                ketCONTOH = @ketCONTOH
              WHERE keyCONTOH = @keyCONTOH`);

        res.json({ success: true, message: 'Data berhasil diperbarui' });
    } catch (err) {
        res.json({ success: false, message: err.message });
    }
};

// Hapus data
exports.delete = async function (req, res) {
    if (!checkAccess(req, 'delete')) {
        return res.status(403).json({ success: false, message: 'Tidak memiliki akses' });
    }

    const id = req.params.id || req.query.id;
    try {
        const pool = await db.poolPromise;
        await pool.request()
            .input('keyCONTOH', db.sql.BigInt, id)
            .query('DELETE FROM CONTOH WHERE keyCONTOH = @keyCONTOH');

        res.json({ success: true, message: 'Data berhasil dihapus' });
    } catch (err) {
        res.json({ success: false, message: err.message });
    }
};
