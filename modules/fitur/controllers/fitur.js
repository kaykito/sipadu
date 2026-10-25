const db = require('../../../database');

// Tampilkan halaman daftar fitur
exports.index = async function (req, res) {
    try {
        // Check if user has access to view Data Fitur
        // if (!req.session.aksesMenu?.['Data Fitur']?.view) {
        //     return res.status(403).send('Tidak memiliki akses');
        // }

        const vars = {
            title: 'Data Fitur',
            subtitle: 'Daftar Fitur',
            module: 'fitur',
            error_msg: req.query.error_msg || '',
            // Pass permissions to view
            permissions: req.session.aksesMenu?.['Data Fitur'] || {},
        };

        const viewPath = 'fitur/views/vw_data.html';
        if (req.xhr || req.headers['x-requested-with'] === 'XMLHttpRequest') {
            res.render(viewPath, vars);
        } else {
            vars.content = viewPath;
            res.render('index', vars);
        }
    } catch (err) {
        console.error('Error in fitur.index:', err);
        res.status(500).send('Error: ' + err.message);
    }
};

// Ambil data untuk DataTables
exports.data = async function (req, res) {
    try {
        const pool = await db.poolPromise;
        const result = await pool.request().query(`
            SELECT f.keyFITUR, f.kdFITUR, f.nmFITUR, f.parentKeyFITUR, p.nmFITUR as parentNmFITUR, f.url
            FROM FITUR f
            LEFT JOIN FITUR p ON f.parentKeyFITUR = p.keyFITUR
            ORDER BY f.kdFITUR
        `);
        res.json({
            data: result.recordset
        });
    } catch (err) {
        console.error('Error in fitur.data:', err);
        res.status(500).json({ error: err.message });
    }
};

// Insert fitur baru
exports.insert = async function (req, res) {
    const { kdFITUR, nmFITUR, parentKeyFITUR, url } = req.body;
    console.log(req.body);
    if (!kdFITUR || !nmFITUR) {
        return res.json({ success: false, message: 'Parameter tidak lengkap.' });
    }

    try {
        const pool = await db.poolPromise;
        const sql = `
            INSERT INTO FITUR (kdFITUR, nmFITUR, parentKeyFITUR, url)
            VALUES (@kdFITUR, @nmFITUR, @parentKeyFITUR, @url)
        `;
        await pool
            .request()
            .input('kdFITUR', db.sql.NVarChar, kdFITUR)
            .input('nmFITUR', db.sql.NVarChar, nmFITUR)
            .input('parentKeyFITUR', db.sql.BigInt, parentKeyFITUR || null)
            .input('url', db.sql.NVarChar, url || '')
            .query(sql);

        res.json({ success: true, message: 'Fitur berhasil ditambahkan.' });
    } catch (err) {
        res.json({ success: false, message: err.message });
    }
};

// Tambahkan method untuk get data fitur by id (untuk modal edit)
exports.get = async function (req, res) {
    const { id } = req.params;
    if (!id) {
        return res.json({ success: false, message: 'Parameter tidak lengkap.' });
    }
    try {
        const pool = await db.poolPromise;
        const sql = `
            SELECT f.*, p.nmFITUR as parentNmFITUR
            FROM FITUR f
            LEFT JOIN FITUR p ON f.parentKeyFITUR = p.keyFITUR
            WHERE f.keyFITUR = @keyFITUR
        `;
        const result = await pool.request().input('keyFITUR', db.sql.BigInt, id).query(sql);

        if (result.recordset.length > 0) {
            res.json({ success: true, data: result.recordset[0] });
        } else {
            res.json({ success: false, message: 'Data tidak ditemukan.' });
        }
    } catch (err) {
        res.json({ success: false, message: err.message });
    }
};

// Update fitur (mirip update di saldoAwalSAL, try update then insert if not exists)
exports.update = async function (req, res) {
    const { keyFITUR, kdFITUR, nmFITUR, parentKeyFITUR, url } = req.body;
    if (!keyFITUR || !kdFITUR || !nmFITUR) {
        return res.json({ success: false, message: 'Parameter tidak lengkap.' });
    }
    try {
        const pool = await db.poolPromise;
        const sql = `
            UPDATE FITUR SET
                kdFITUR = @kdFITUR,
                nmFITUR = @nmFITUR,
                parentKeyFITUR = @parentKeyFITUR,
                url = @url
            WHERE keyFITUR = @keyFITUR
        `;
        await pool
            .request()
            .input('kdFITUR', db.sql.NVarChar, kdFITUR)
            .input('nmFITUR', db.sql.NVarChar, nmFITUR)
            .input('parentKeyFITUR', db.sql.BigInt, parentKeyFITUR || null)
            .input('url', db.sql.NVarChar, url || '')
            .input('keyFITUR', db.sql.BigInt, keyFITUR)
            .query(sql);

        res.json({ success: true, message: 'Fitur berhasil diupdate.' });
    } catch (err) {
        res.json({ success: false, message: err.message });
    }
};

// Hapus fitur
exports.delete = async function (req, res) {
    try {
        // if (!req.session.aksesMenu?.['Data Fitur']?.delete) {
        //     return res.status(403).send('Tidak memiliki akses');
        // }

        const { id } = req.params;
        const pool = await db.poolPromise;
        
        // Check if has children
        const children = await pool.request()
            .input('keyFITUR', db.sql.BigInt, id)
            .query('SELECT COUNT(*) as count FROM FITUR WHERE parentKeyFITUR = @keyFITUR');
        
        if (children.recordset[0].count > 0) {
            return res.json({ success: false, message: 'Tidak dapat menghapus fitur yang memiliki sub-fitur' });
        }

        await pool.request()
            .input('keyFITUR', db.sql.BigInt, id)
            .query('DELETE FROM FITUR WHERE keyFITUR = @keyFITUR');

        res.json({ success: true, message: 'Fitur berhasil dihapus' });
    } catch (err) {
        console.error('Error in fitur.delete:', err);
        res.json({ success: false, message: err.message });
    }
};

// Ambil daftar parent fitur untuk select option
exports.parents = async function (req, res) {
    try {
        const pool = await db.poolPromise;
        const result = await pool.request().query(`
            SELECT keyFITUR, nmFITUR
            FROM FITUR
            ORDER BY nmFITUR
        `);
        res.json({ data: result.recordset });
    } catch (err) {
        res.json({ data: [], error: err.message });
    }
};
