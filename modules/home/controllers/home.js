const db = require('../../../database');

// Tampilkan halaman dashboard/home
exports.index = async function (req, res) {
  try {
    // Ringkasan sederhana untuk dashboard; ganti dengan statistik aplikasi Anda
    const pool = await db.poolPromise;
    const result = await pool.request().query(`
      SELECT
        (SELECT COUNT(*) FROM APPUSER) AS totalUser,
        (SELECT COUNT(*) FROM KELOMPOK) AS totalKelompok,
        (SELECT COUNT(*) FROM FITUR) AS totalFitur
    `);

    const vars = {
      title: 'Dashboard',
      subtitle: 'Selamat datang di ' + (process.env.APP_NAME || 'Express MSSQL Boilerplate'),
      userid: req.session.user_id,
      username: req.session.user,
      nmKLP: req.session.nmKLP || '',
      stats: result.recordset[0] || {},
    };

    const viewPath = 'home/views/vw_dashboard.html';
    if (req.xhr || req.headers['x-requested-with'] === 'XMLHttpRequest') {
      res.render(viewPath, vars);
    } else {
      vars.content = viewPath;
      res.render('index', vars);
    }
  } catch (err) {
    console.error('Error in home.index:', err);
    res.status(500).send('Error: ' + err.message);
  }
};
