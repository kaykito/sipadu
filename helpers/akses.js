const db = require('../database');
async function buildAksesMenuFiturMap(keyKLP) {
  const pool = await db.poolPromise;
  const fitur = await pool.request().query('SELECT keyFITUR, kdFITUR, nmFITUR FROM FITUR');
  const aksesUser = await pool.request()
    .input('keyKLP', db.sql.BigInt, keyKLP)
    .query(`
      SELECT O.keyFITUR, F.kdFITUR, F.nmFITUR, O.aksi
      FROM OTORISASI O
      JOIN FITUR F ON O.keyFITUR = F.keyFITUR
      WHERE O.keyKLP = @keyKLP
    `);

  let aksesMenu = {};
  let fiturMap = {};
  aksesUser.recordset.forEach(row => {
    if (!aksesMenu[row.nmFITUR]) aksesMenu[row.nmFITUR] = {};
    aksesMenu[row.nmFITUR][row.aksi] = true;
  });
  console.log('aksesMenu:', aksesMenu);
  fitur.recordset.forEach(f => { fiturMap[f.nmFITUR] = f.keyFITUR; });
  return { aksesMenu, fiturMap };
}
module.exports = { buildAksesMenuFiturMap };