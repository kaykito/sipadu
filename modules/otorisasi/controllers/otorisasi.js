const db = require('../../../database');
const { checkAccess } = require('../../../helpers/accessControl');

exports.index = async function (req, res) {
    try {
        if (!checkAccess(req, 'view')) {
            return res.status(403).send('Tidak memiliki akses');
        }

        const pool = await db.poolPromise;
        const kelompok = await pool.request().query(`
            SELECT k.keyKLP, k.nmKLP, COUNT(u.keyUSER) as userCount
            FROM KELOMPOK k
            LEFT JOIN [APPUSER] u ON k.keyKLP = u.keyKLP
            GROUP BY k.keyKLP, k.nmKLP
            ORDER BY k.nmKLP
        `);
        const fitur = await pool.request().query('SELECT keyFITUR, kdFITUR, nmFITUR, parentKeyFITUR FROM FITUR ORDER BY kdFITUR');
        const otorisasi = await pool.request().query('SELECT keyFITUR, keyKLP, aksi FROM OTORISASI');
        const vars = {
            title: 'Data Kelompok',
            subtitle: 'Daftar Kelompok',
            module: 'kelompok',
            error_msg: req.query.error_msg || '',
            kelompok: kelompok.recordset,
            fitur: fitur.recordset,
            otorisasi: otorisasi.recordset
        };


        const viewPath = 'otorisasi/views/vw_data.html';
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

// Update hak akses kelompok (POST)
exports.update = async function (req, res) {
    if (!checkAccess(req, 'edit')) {
        return res.status(403).json({ success: false, message: 'Tidak memiliki akses' });
    }

    // req.body: { keyKLP, akses: [{keyFITUR, aksi}, ...] }
    const { keyKLP, akses } = req.body;
    try {
        const pool = await db.poolPromise;
        // Hapus semua otorisasi lama untuk kelompok ini
        await pool.request()
            .input('keyKLP', db.sql.BigInt, keyKLP)
            .query('DELETE FROM OTORISASI WHERE keyKLP = @keyKLP');

        // Insert otorisasi baru
        if (Array.isArray(akses)) {
            for (const item of akses) {
                await pool.request()
                    .input('keyKLP', db.sql.BigInt, keyKLP)
                    .input('keyFITUR', db.sql.BigInt, item.keyFITUR)
                    .input('aksi', db.sql.NVarChar, item.aksi)
                    .query('INSERT INTO OTORISASI (keyFITUR, keyKLP, aksi) VALUES (@keyFITUR, @keyKLP, @aksi)');
            }
        }
        res.json({ success: true, message: 'Hak akses berhasil diperbarui' });
    } catch (err) {
        res.json({ success: false, message: err.message });
    }
};

// Create new role (POST)
exports.createRole = async function (req, res) {
    if (!checkAccess(req, 'add')) {
        return res.status(403).json({ success: false, message: 'Tidak memiliki akses' });
    }

    const { roleName, permissions } = req.body;
    try {
        const pool = await db.poolPromise;

        // Insert new role
        const result = await pool.request()
            .input('nmKLP', db.sql.NVarChar, roleName)
            .query('INSERT INTO KELOMPOK (nmKLP) OUTPUT INSERTED.keyKLP VALUES (@nmKLP)');

        const newRoleId = result.recordset[0].keyKLP;

        // Insert permissions for the new role
        if (Array.isArray(permissions)) {
            for (const permission of permissions) {
                await pool.request()
                    .input('keyFITUR', db.sql.BigInt, permission.keyFITUR)
                    .input('keyKLP', db.sql.BigInt, newRoleId)
                    .input('aksi', db.sql.NVarChar, permission.aksi)
                    .query('INSERT INTO OTORISASI (keyFITUR, keyKLP, aksi) VALUES (@keyFITUR, @keyKLP, @aksi)');
            }
        }

        res.json({ success: true, message: 'Role created successfully', roleId: newRoleId });
    } catch (err) {
        console.error('Error creating role:', err);
        res.json({ success: false, message: err.message });
    }
};

// Update existing role (PUT)
exports.updateRole = async function (req, res) {
    if (!checkAccess(req, 'edit')) {
        return res.status(403).json({ success: false, message: 'Tidak memiliki akses' });
    }

    const { roleId, roleName, permissions } = req.body;
    try {
        const pool = await db.poolPromise;

        // Update role name
        await pool.request()
            .input('keyKLP', db.sql.BigInt, roleId)
            .input('nmKLP', db.sql.NVarChar, roleName)
            .query('UPDATE KELOMPOK SET nmKLP = @nmKLP WHERE keyKLP = @keyKLP');

        // Delete existing permissions
        await pool.request()
            .input('keyKLP', db.sql.BigInt, roleId)
            .query('DELETE FROM OTORISASI WHERE keyKLP = @keyKLP');

        // Insert new permissions
        if (Array.isArray(permissions)) {
            for (const permission of permissions) {
                await pool.request()
                    .input('keyFITUR', db.sql.BigInt, permission.keyFITUR)
                    .input('keyKLP', db.sql.BigInt, roleId)
                    .input('aksi', db.sql.NVarChar, permission.aksi)
                    .query('INSERT INTO OTORISASI (keyFITUR, keyKLP, aksi) VALUES (@keyFITUR, @keyKLP, @aksi)');
            }
        }

        res.json({ success: true, message: 'Role updated successfully' });
    } catch (err) {
        console.error('Error updating role:', err);
        res.json({ success: false, message: err.message });
    }
};

// Delete existing role (DELETE)
exports.deleteRole = async function (req, res) {
    if (!checkAccess(req, 'delete')) {
        return res.status(403).json({ success: false, message: 'Tidak memiliki akses' });
    }

    const roleId = req.params.id || req.query.id;
    if (!roleId) {
        return res.json({ success: false, message: 'Role tidak valid' });
    }

    try {
        const pool = await db.poolPromise;

        const role = await pool.request()
            .input('keyKLP', db.sql.BigInt, roleId)
            .query('SELECT TOP 1 nmKLP FROM KELOMPOK WHERE keyKLP = @keyKLP');

        if (!role.recordset.length) {
            return res.json({ success: false, message: 'Peran tidak ditemukan' });
        }

        if (String(role.recordset[0].nmKLP || '').toLowerCase() === 'admin') {
            return res.json({ success: false, message: 'Peran Admin tidak bisa dihapus.' });
        }

        const used = await pool.request()
            .input('keyKLP', db.sql.BigInt, roleId)
            .query('SELECT COUNT(*) AS total FROM APPUSER WHERE keyKLP = @keyKLP');

        const userCount = used.recordset[0] ? Number(used.recordset[0].total || 0) : 0;
        if (userCount > 0) {
            return res.json({ success: false, message: `Peran masih digunakan oleh ${userCount} pengguna.` });
        }

        await pool.request()
            .input('keyKLP', db.sql.BigInt, roleId)
            .query('DELETE FROM OTORISASI WHERE keyKLP = @keyKLP');

        const result = await pool.request()
            .input('keyKLP', db.sql.BigInt, roleId)
            .query('DELETE FROM KELOMPOK WHERE keyKLP = @keyKLP');

        if (!result.rowsAffected[0]) {
            return res.json({ success: false, message: 'Peran tidak ditemukan' });
        }

        res.json({ success: true, message: 'Peran berhasil dihapus' });
    } catch (err) {
        console.error('Error deleting role:', err);
        res.json({ success: false, message: err.message });
    }
};
