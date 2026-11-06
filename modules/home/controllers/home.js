const db = require('../../../database');
const { isValidDate } = require('../../../helpers/integrasi');

// Dashboard/home: ringkasan integrasi pendapatan SIM RS ke BLUD, dihitung dari KAS_SIMRS, REKAP_PENERIMAAN, dan LOG_API.
// Tanggal acuan: ?tanggal=YYYY-MM-DD, default tanggal kas terakhir yang ada datanya.

const LABEL_JENIS = { TBP: 'TBP (Tanda Bukti Pembayaran)', STS: 'STS (Surat Tanda Setoran)' };

function persen(bagian, total) {
  return total ? Math.round((bagian / total) * 1000) / 10 : 0;
}

function parseBody(body) {
  try {
    return JSON.parse(body) || {};
  } catch (e) {
    return {};
  }
}

// Tampilkan halaman dashboard/home
exports.index = async function (req, res) {
  try {
    const pool = await db.poolPromise;
    const result = await pool.request()
      .input('tanggalParam', db.sql.VarChar, isValidDate(req.query.tanggal) ? req.query.tanggal : null)
      .query(`
        DECLARE @tgl DATE = ISNULL(CAST(@tanggalParam AS DATE), ISNULL((SELECT MAX(CAST(tglKAS AS DATE)) FROM KAS_SIMRS), CAST(GETDATE() AS DATE)));
        DECLARE @tglSebelum DATE = (SELECT MAX(CAST(tglKAS AS DATE)) FROM KAS_SIMRS WHERE CAST(tglKAS AS DATE) < @tgl);

        -- 0: ringkasan hari ini
        SELECT CONVERT(VARCHAR(10), @tgl, 23) AS tanggal,
               ISNULL(SUM(total), 0) AS pendapatan,
               COUNT(*) AS transaksi,
               SUM(CASE WHEN jenis = 'TBP' THEN 1 ELSE 0 END) AS jumlahTbp,
               (SELECT SUM(total) FROM KAS_SIMRS WHERE CAST(tglKAS AS DATE) = @tglSebelum) AS pendapatanSebelum,
               (SELECT COUNT(*) FROM REKAP_PENERIMAAN WHERE statusApi = 'pending') AS menungguUnggah,
               (SELECT COUNT(*) FROM REKAP_PENERIMAAN WHERE statusApi = 'failed') AS gagalKirim
        FROM KAS_SIMRS WHERE CAST(tglKAS AS DATE) = @tgl;

        -- 1: tren per jam
        SELECT DATEPART(HOUR, tglKAS) AS jam, SUM(total) AS nilai
        FROM KAS_SIMRS WHERE CAST(tglKAS AS DATE) = @tgl
        GROUP BY DATEPART(HOUR, tglKAS);

        -- 2: komposisi per rekening SIM RS
        SELECT d.nmRekening AS label, SUM(d.nilai) AS nilai
        FROM KAS_SIMRS_DETAIL d JOIN KAS_SIMRS k ON k.keyKAS = d.keyKAS
        WHERE CAST(k.tglKAS AS DATE) = @tgl
        GROUP BY d.nmRekening
        ORDER BY nilai DESC;

        -- 3: jenis penerimaan 30 hari terakhir s.d. tanggal acuan
        SELECT jenis, SUM(total) AS nilai, COUNT(*) AS jumlah
        FROM KAS_SIMRS
        WHERE CAST(tglKAS AS DATE) BETWEEN DATEADD(DAY, -29, @tgl) AND @tgl
        GROUP BY jenis;

        -- 4: aktivitas terkini
        SELECT TOP 5 CONVERT(VARCHAR(16), waktu, 120) AS waktu, httpCode, metode, ref, body
        FROM LOG_API ORDER BY waktu DESC, keyLOG DESC;
      `);

    const [ringkasanRows, trenRows, komposisiRows, jenisRows, logRows] = result.recordsets;
    const ringkasan = ringkasanRows[0];
    const pendapatan = Number(ringkasan.pendapatan);
    const sebelum = ringkasan.pendapatanSebelum == null ? null : Number(ringkasan.pendapatanSebelum);

    // Rentang jam minimal 07:00–14:00, diperlebar bila ada transaksi di luar itu
    const jamData = {};
    trenRows.forEach(r => { jamData[r.jam] = Number(r.nilai); });
    const jamAda = Object.keys(jamData).map(Number);
    const jamAwal = Math.min(7, ...jamAda);
    const jamAkhir = Math.max(14, ...jamAda);
    const trenPerJam = { jam: [], nilai: [] };
    for (let j = jamAwal; j <= jamAkhir; j++) {
      trenPerJam.jam.push(String(j).padStart(2, '0') + ':00');
      trenPerJam.nilai.push(jamData[j] || 0);
    }

    const jenisPenerimaan = ['TBP', 'STS'].map(jenis => {
      const row = jenisRows.find(r => r.jenis === jenis);
      return { label: LABEL_JENIS[jenis], nilai: row ? Number(row.nilai) : 0 };
    });

    const aktivitas = logRows.map(l => {
      const body = parseBody(l.body);
      return {
        tipe: l.httpCode >= 400 ? 'err' : (l.metode === 'POST' ? 'ok' : 'info'),
        teks: body.message || body.error || (l.metode + ' ' + (l.ref || '')),
        kode: l.ref || '',
        akhir: '',
        waktu: l.waktu,
      };
    });

    const persenTbp = persen(ringkasan.jumlahTbp || 0, ringkasan.transaksi);
    const vars = {
      title: 'Dashboard',
      subtitle: 'Ringkasan integrasi pendapatan SIM RS ke BLUD',
      userid: req.session.user_id,
      username: req.session.user,
      nmKLP: req.session.nmKLP || '',
      dash: {
        tanggal: ringkasan.tanggal,
        pendapatanHariIni: pendapatan,
        deltaPersen: sebelum ? Math.round(((pendapatan - sebelum) / sebelum) * 1000) / 10 : null,
        transaksi: ringkasan.transaksi,
        persenTbp,
        persenSts: ringkasan.transaksi ? Math.round((100 - persenTbp) * 10) / 10 : 0,
        menungguUnggah: ringkasan.menungguUnggah,
        gagalKirim: ringkasan.gagalKirim,
        trenPerJam,
        komposisi: komposisiRows.map(r => ({ label: r.label, nilai: Number(r.nilai) })),
        jenisPenerimaan,
        jumlahBuktiPeriode: jenisRows.reduce((s, r) => s + r.jumlah, 0),
        aktivitas,
      },
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
