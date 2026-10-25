const bcrypt = require('bcrypt');
const db = require('../../../database');
const { checkAccess } = require('../../../helpers/accessControl');

const BCRYPT_ROUNDS = 10;
// Kolom APPUSER yang aman dikirim ke browser (tanpa PWD)
const USER_COLUMNS = 'a.keyUSER, a.userID, a.keyKLP, a.nmUSER, a.ketUSER, a.avatar, a.statusUSER';

// Tampilkan halaman data user
exports.index = async function (req, res) {
  try {
    if (!checkAccess(req, 'view')) {
      return res.status(403).send('Tidak memiliki akses');
    }

    const vars = {
      title: 'Data User',
      subtitle: 'Data User',
      userid: req.session.user_id,
      username: req.session.user,
    };

    const viewPath = 'user/views/vw_data.html';
    if (req.xhr || req.headers['x-requested-with'] === 'XMLHttpRequest') {
      res.render(viewPath, vars);
    } else {
      vars.content = viewPath;
      res.render('index', vars);
    }
  } catch (err) {
    console.error('Error in user.index:', err);
    res.status(500).send('Error: ' + err.message);
  }
};

// Tampilkan form tambah user
exports.add = function (req, res) {
  if (!checkAccess(req, 'add')) {
    return res.status(403).send('Tidak memiliki akses');
  }

  const vars = {
    title: 'Form User',
    subtitle: 'Input data user',
    module: 'user',
    mode: 'add',
    user: null
  };
  if (req.xhr || req.headers['x-requested-with'] === 'XMLHttpRequest') {
    res.render('vw_form.html', vars);
  } else {
    vars.content = 'user/views/vw_form.html';
    res.render('index', vars);
  }
};

// Ambil data user by userID
exports.rowId = async function (req, res) {
  if (!checkAccess(req, 'view')) {
    return res.status(403).json({ success: false, message: 'Tidak memiliki akses' });
  }

  const userID = req.query.id;
  try {
    const pool = await db.poolPromise;
    const result = await pool.request()
      .input('userID', db.sql.NVarChar, userID)
      .query(`SELECT ${USER_COLUMNS} FROM APPUSER a WHERE a.userID = @userID`);
    if (result.recordset.length === 0) {
      return res.json({ success: false });
    }
    res.json(result.recordset[0]);
  } catch (err) {
    res.json({ success: false, error: err.message });
  }
};

// Detail user untuk modal edit
exports.detail = async function (req, res) {
  if (!checkAccess(req, 'view')) {
    return res.status(403).json({ success: false, message: 'Tidak memiliki akses' });
  }

  const id = req.params.id || req.query.id;
  try {
    const pool = await db.poolPromise;
    const result = await pool.request()
      .input('userID', db.sql.NVarChar, id)
      .query(`
        SELECT ${USER_COLUMNS}, c.nmKLP
        FROM APPUSER a
        LEFT JOIN KELOMPOK c ON a.keyKLP = c.keyKLP
        WHERE a.userID = @userID
      `);
    if (result.recordset.length === 0) {
      return res.json({ success: false, message: 'User tidak ditemukan' });
    }
    res.json({ success: true, data: result.recordset[0] });
  } catch (err) {
    res.json({ success: false, message: err.message });
  }
};


// Tampilkan form edit user
exports.edit = async function (req, res) {
  if (!checkAccess(req, 'edit')) {
    return res.status(403).send('Tidak memiliki akses');
  }

  const id = req.params.id || req.query.id;
  try {
    const pool = await db.poolPromise;
    const result = await pool.request()
      .input('userID', db.sql.NVarChar, id)
      .query(`
        SELECT ${USER_COLUMNS}, c.nmKLP
        FROM APPUSER a
        LEFT JOIN KELOMPOK c ON a.keyKLP = c.keyKLP
        WHERE a.userID = @userID
      `);

    if (result.recordset.length === 0) {
      return res.redirect('/user/index?error_msg=User tidak ditemukan');
    }

    const user = result.recordset[0];
    const vars = {
      title: 'Form User',
      subtitle: 'Edit User',
      module: 'user',
      mode: 'edit',
      user
    };

    if (req.xhr || req.headers['x-requested-with'] === 'XMLHttpRequest') {
      res.render('user/views/vw_form.html', vars);
    } else {
      vars.content = 'user/views/vw_form.html';
      res.render('index', vars);
    }
  } catch (err) {
    console.error('Error in user.edit:', err);
    res.redirect('/user/index/?error_msg=' + encodeURIComponent(err.message));
  }
};

// DataTable: ambil semua user (bisa ditambah filter/paging sesuai kebutuhan)
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
      .query(`
        SELECT a.userID, a.nmUSER, c.nmKLP, a.ketUSER, a.statusUSER FROM APPUSER a
        LEFT JOIN KELOMPOK c ON c.keyKLP = a.keyKLP
        ORDER BY a.userID
      `);
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

// Insert user baru
exports.insert = async function (req, res) {
  if (!checkAccess(req, 'add')) {
    return res.status(403).json({ success: false, message: 'Tidak memiliki akses' });
  }

  const info = req.body;
  if (!info.userID || !info.PWD || !info.keyKLP) {
    return res.json({ success: false, message: 'User ID, password, dan kelompok wajib diisi' });
  }

  try {
    const hashedPassword = await bcrypt.hash(info.PWD, BCRYPT_ROUNDS);
    const pool = await db.poolPromise;
    await pool.request()
      .input('userID', db.sql.NVarChar, info.userID)
      .input('PWD', db.sql.NVarChar, hashedPassword)
      .input('keyKLP', db.sql.BigInt, info.keyKLP)
      .input('nmUSER', db.sql.NVarChar, info.nmUSER)
      .input('ketUSER', db.sql.NVarChar, info.ketUSER || null)
      .input('statusUSER', db.sql.Int, info.statusUSER || 1)
      .query(`INSERT INTO APPUSER (userID, PWD, keyKLP, nmUSER, ketUSER, statusUSER)
                        VALUES (@userID, @PWD, @keyKLP, @nmUSER, @ketUSER, @statusUSER)`);
    res.json({ success: true, message: 'Success' });
  } catch (err) {
    res.json({ success: false, message: err.message });
  }
};

// Update user
exports.update = async function (req, res) {
  if (!checkAccess(req, 'edit')) {
    return res.status(403).json({ success: false, message: 'Tidak memiliki akses' });
  }

  const info = req.body;
  const changePassword = info.PWD && info.PWD !== '';

  try {
    const pool = await db.poolPromise;

    const request = pool.request()
      .input('userID', db.sql.NVarChar, info.userID)
      .input('keyKLP', db.sql.BigInt, info.keyKLP)
      .input('nmUSER', db.sql.NVarChar, info.nmUSER)
      .input('ketUSER', db.sql.NVarChar, info.ketUSER || null)
      .input('statusUSER', db.sql.Int, info.statusUSER || 1);

    // Password hanya diubah jika diisi
    if (changePassword) {
      request.input('PWD', db.sql.NVarChar, await bcrypt.hash(info.PWD, BCRYPT_ROUNDS));
    }

    await request.query(`UPDATE APPUSER SET
          keyKLP = @keyKLP,
          nmUSER = @nmUSER,
          ketUSER = @ketUSER,
          statusUSER = @statusUSER${changePassword ? ',\n          PWD = @PWD' : ''}
          WHERE userID = @userID`);

    res.json({ success: true, message: 'User berhasil diperbarui' });
  } catch (err) {
    res.json({ success: false, message: err.message });
  }
};

// Delete user
exports.delete = async function (req, res) {
  const acceptHeader = req.headers.accept || '';
  const isAjaxRequest = req.xhr || req.headers['x-requested-with'] === 'XMLHttpRequest' || acceptHeader.includes('json');

  if (!checkAccess(req, 'delete')) {
    if (isAjaxRequest) {
      return res.status(403).json({ success: false, message: 'Tidak memiliki akses' });
    } else {
      return res.status(403).send('Tidak memiliki akses');
    }
  }

  // Ambil ID dari params atau query
  const userID = req.params.id || req.query.id;

  if (userID === req.session.user_id) {
    const message = 'Tidak dapat menghapus user yang sedang login';
    return isAjaxRequest ? res.json({ success: false, message }) : res.redirect('/user/index?error_msg=' + encodeURIComponent(message));
  }

  try {
    const pool = await db.poolPromise;

    // Cek apakah user ada
    const checkResult = await pool.request()
      .input('userID', db.sql.NVarChar, userID)
      .query('SELECT COUNT(*) AS count FROM APPUSER WHERE userID = @userID');

    if (checkResult.recordset[0].count === 0) {
      return res.json({ success: false, message: 'User tidak ditemukan' });
    }

    // Hapus user
    await pool.request()
      .input('userID', db.sql.NVarChar, userID)
      .query('DELETE FROM APPUSER WHERE userID = @userID');

    if (isAjaxRequest) {
      return res.json({ success: true, message: 'User berhasil dihapus' });
    } else {
      return res.redirect('/user/index?msg=User berhasil dihapus');
    }
  } catch (err) {
    console.error('Error deleting user:', err);

    if (isAjaxRequest) {
      return res.json({ success: false, message: err.message });
    } else {
      return res.redirect('/user/index?error_msg=' + encodeURIComponent(err.message));
    }
  }
};
