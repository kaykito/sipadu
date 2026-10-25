const db = require('../../../database');
const { checkAccess } = require('../../../helpers/accessControl');

// Tampilkan halaman daftar kelompok
exports.index = async function (req, res) {
    try {
        if (!checkAccess(req, 'view')) {
            return res.status(403).send('Tidak memiliki akses');
        }

        const vars = {
            title: 'Data Kelompok',
            subtitle: 'Daftar Kelompok',
            module: 'kelompok',
            error_msg: req.query.error_msg || ''
        };

        const viewPath = 'kelompok/views/vw_data.html';
        if (req.xhr || req.headers['x-requested-with'] === 'XMLHttpRequest') {
            res.render(viewPath, vars);
        } else {
            vars.content = viewPath;
            res.render('index', vars);
        }
    } catch (err) {
        console.error('Error in kelompok.index:', err);
        res.status(500).send('Error: ' + err.message);
    }
};

// Ambil data untuk DataTables
exports.data = async function (req, res) {
    try {
        if (!checkAccess(req, 'view')) {
            return res.status(403).json({
                draw: req.query.draw || 1,
                recordsTotal: 0,
                recordsFiltered: 0,
                data: [],
                error: 'Tidak memiliki akses untuk melihat data'
            });
        }

        const pool = await db.poolPromise;
        const result = await pool.request()
            .query('SELECT keyKLP, nmKLP, ketKLP FROM KELOMPOK WHERE nmKLP <> \'Developer\' ORDER BY keyKLP');

        res.json({
            draw: req.query.draw || 1,
            recordsTotal: result.recordset.length,
            recordsFiltered: result.recordset.length,
            data: result.recordset,
            error: null
        });
    } catch (err) {
        res.json({
            draw: req.query.draw || 1,
            recordsTotal: 0,
            recordsFiltered: 0,
            data: [],
            error: err.message
        });
    }
};

// Tampilkan form tambah kelompok
exports.add = function (req, res) {
    if (!checkAccess(req, 'add')) {
        return res.status(403).send('Tidak memiliki akses');
    }

    const vars = {
        title: 'Form Kelompok',
        subtitle: 'Tambah data kelompok',
        module: 'kelompok',
        mode: 'add',
        kelompok: null
    };

    if (req.xhr || req.headers['x-requested-with'] === 'XMLHttpRequest') {
        res.render('modules/kelompok/views/vw_form.html', vars);
    } else {
        vars.content = '../modules/kelompok/views/vw_form.html';
        res.render('index', vars);
    }
};

// Insert kelompok baru
exports.insert = async function (req, res) {
    if (!checkAccess(req, 'add')) {
        return res.status(403).json({ success: false, message: 'Tidak memiliki akses' });
    }

    const info = req.body;
    console.log('Insert kelompok info:', info);

    try {
        const pool = await db.poolPromise;
        await pool.request()
            .input('nmKLP', db.sql.NVarChar, info.nmKLP)
            .input('ketKLP', db.sql.NVarChar, info.ketKLP || null)
            .query(`INSERT INTO KELOMPOK (nmKLP, ketKLP) 
              VALUES (@nmKLP, @ketKLP)`);
        res.json({ success: true, message: 'Kelompok berhasil ditambahkan' });
    } catch (err) {
        res.json({ success: false, message: err.message });
    }
};

// Tampilkan form edit kelompok
exports.edit = async function (req, res) {
    if (!checkAccess(req, 'edit')) {
        return res.status(403).send('Tidak memiliki akses');
    }

    const id = req.params.id || req.query.id;

    try {
        const pool = await db.poolPromise;
        const result = await pool.request()
            .input('keyKLP', db.sql.BigInt, id)
            .query('SELECT * FROM KELOMPOK WHERE keyKLP = @keyKLP');

        if (result.recordset.length === 0) {
            return res.redirect('/kelompok/index?error_msg=Kelompok tidak ditemukan');
        }

        const kelompok = result.recordset[0];
        const vars = {
            title: 'Form Kelompok',
            subtitle: 'Edit data kelompok',
            module: 'kelompok',
            mode: 'edit',
            kelompok
        };

        if (req.xhr || req.headers['x-requested-with'] === 'XMLHttpRequest') {
            res.render('modules/kelompok/views/vw_form.html', vars);
        } else {
            vars.content = '../modules/kelompok/views/vw_form.html';
            res.render('index', vars);
        }
    } catch (err) {
        console.error('Error in kelompok.edit:', err);
        res.redirect('/kelompok/index/?error_msg=' + encodeURIComponent(err.message));
    }
};

// Update kelompok
exports.update = async function (req, res) {
    if (!checkAccess(req, 'edit')) {
        return res.status(403).json({ success: false, message: 'Tidak memiliki akses' });
    }

    const info = req.body;

    try {
        const pool = await db.poolPromise;
        await pool.request()
            .input('keyKLP', db.sql.BigInt, info.keyKLP)
            .input('nmKLP', db.sql.NVarChar, info.nmKLP)
            .input('ketKLP', db.sql.NVarChar, info.ketKLP || null)
            .query(`UPDATE KELOMPOK 
              SET nmKLP = @nmKLP, ketKLP = @ketKLP 
              WHERE keyKLP = @keyKLP`);

        res.json({ success: true, message: 'Kelompok berhasil diperbarui' });
    } catch (err) {
        res.json({ success: false, message: err.message });
    }
};

// Hapus kelompok
exports.delete = async function (req, res) {
    if (!checkAccess(req, 'delete')) {
        return res.status(403).json({ success: false, message: 'Tidak memiliki akses' });
    }

    const id = req.params.id || req.query.id;

    try {
        // Cek apakah kelompok digunakan di tabel APPUSER
        const pool = await db.poolPromise;
        const checkResult = await pool.request()
            .input('keyKLP', db.sql.BigInt, id)
            .query('SELECT COUNT(*) AS count FROM APPUSER WHERE keyKLP = @keyKLP');

        if (checkResult.recordset[0].count > 0) {
            return res.json({
                success: false,
                message: 'Kelompok tidak dapat dihapus karena masih digunakan oleh user'
            });
        }

        // Jika tidak digunakan, hapus kelompok
        await pool.request()
            .input('keyKLP', db.sql.BigInt, id)
            .query('DELETE FROM KELOMPOK WHERE keyKLP = @keyKLP');

        res.json({ success: true, message: 'Kelompok berhasil dihapus' });
    } catch (err) {
        res.json({ success: false, message: err.message });
    }
};

// Ambil data untuk combobox/select2
exports.comboData = async function (req, res) {
    try {
        const search = req.query.search || '';
        const page = parseInt(req.query.page) || 1;
        const limit = parseInt(req.query.limit) || 10;
        const offset = (page - 1) * limit;

        const pool = await db.poolPromise;

        // Query dengan filter pencarian
        let query = `
            SELECT keyKLP as id, nmKLP as text, ketKLP as description
            FROM KELOMPOK
            WHERE nmKLP LIKE @search
              AND nmKLP <> 'Developer'
            ORDER BY nmKLP
            OFFSET @offset ROWS
            FETCH NEXT @limit ROWS ONLY
        `;

        // Query untuk total data
        let countQuery = `
            SELECT COUNT(*) as total
            FROM KELOMPOK
            WHERE nmKLP LIKE @search
              AND nmKLP <> 'Developer'
        `;

        // Eksekusi query data
        const result = await pool.request()
            .input('search', db.sql.NVarChar, '%' + search + '%')
            .input('offset', db.sql.Int, offset)
            .input('limit', db.sql.Int, limit)
            .query(query);

        // Eksekusi query count
        const countResult = await pool.request()
            .input('search', db.sql.NVarChar, '%' + search + '%')
            .query(countQuery);

        const total = countResult.recordset[0].total;

        // Format response untuk Select2
        res.json({
            results: result.recordset,
            pagination: {
                more: (offset + limit) < total
            }
        });
    } catch (err) {
        res.status(500).json({
            error: true,
            message: err.message
        });
    }
};

// Endpoint detail kelompok untuk modal edit (JSON)
exports.detail = async function (req, res) {
    if (!checkAccess(req, 'view')) {
        return res.status(403).json({ success: false, message: 'Tidak memiliki akses' });
    }

    const id = req.params.id || req.query.id;
    try {
        const pool = await db.poolPromise;
        const result = await pool.request()
            .input('keyKLP', db.sql.BigInt, id)
            .query('SELECT keyKLP, nmKLP, ketKLP FROM KELOMPOK WHERE keyKLP = @keyKLP');
        if (result.recordset.length === 0) {
            return res.json({ success: false, message: 'Kelompok tidak ditemukan' });
        }
        res.json({ success: true, data: result.recordset[0] });
    } catch (err) {
        res.json({ success: false, message: err.message });
    }
};