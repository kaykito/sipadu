const db = require('../../../database');
const { checkAccess } = require('../../../helpers/accessControl');
const { isValidDate, emptyDataTables, dataTablesParams } = require('../../../helpers/integrasi');

// Berita Acara Penutupan Kas Harian (BERITA_ACARA) beserta pengesahan (tanda tangan).

const ORDERABLE_COLUMNS = { 1: 'noBA', 2: 'tglKas', 3: 'totalSetoran', 4: 'jumlahBukti', 5: 'status', 6: 'ttdOleh' };

const SELECT_BA = `
    SELECT noBA, CONVERT(VARCHAR(10), tglKas, 23) AS tglKas, totalSetoran, jumlahBukti, status, ttdOleh,
           CONVERT(VARCHAR(19), tglTtd, 126) AS tglTtd, catatan
    FROM BERITA_ACARA`;

// Tampilkan halaman berita acara
exports.index = async function (req, res) {
    try {
        if (!checkAccess(req, 'view')) {
            return res.status(403).send('Tidak memiliki akses');
        }

        const vars = {
            title: 'Berita Acara Penutupan Kas Harian',
            subtitle: 'Dokumen penutupan kas harian dan tanda tangan pengesahan',
            module: 'beritaAcara',
            akses: req.session.aksesMenu.beritaAcara || {},
        };

        const viewPath = 'beritaAcara/views/vw_data.html';
        if (req.xhr || req.headers['x-requested-with'] === 'XMLHttpRequest') {
            res.render(viewPath, vars);
        } else {
            vars.content = viewPath;
            res.render('index', vars);
        }
    } catch (err) {
        console.error('Error in beritaAcara.index:', err);
        res.status(500).send('Error: ' + err.message);
    }
};

// Data berita acara untuk DataTables
exports.data = async function (req, res) {
    if (!checkAccess(req, 'view')) {
        return res.status(403).json(emptyDataTables(req, 'Tidak memiliki akses untuk melihat data'));
    }
    try {
        const p = dataTablesParams(req.query, ORDERABLE_COLUMNS, 'tglKas');
        const where = 'WHERE noBA LIKE @search OR ttdOleh LIKE @search';

        const pool = await db.poolPromise;
        const result = await pool.request()
            .input('search', db.sql.NVarChar, '%' + p.search + '%')
            .input('start', db.sql.Int, p.start)
            .input('length', db.sql.Int, p.length)
            .query(`
                SELECT COUNT(*) AS total FROM BERITA_ACARA;
                SELECT COUNT(*) AS total FROM BERITA_ACARA ${where};
                ${SELECT_BA}
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

// Detail satu berita acara
exports.detail = async function (req, res) {
    if (!checkAccess(req, 'view')) {
        return res.status(403).json({ success: false, message: 'Tidak memiliki akses' });
    }
    const id = req.params.id || req.query.id;
    try {
        const pool = await db.poolPromise;
        const result = await pool.request()
            .input('noBA', db.sql.NVarChar, id)
            .query(`${SELECT_BA} WHERE noBA = @noBA`);

        if (result.recordset.length === 0) {
            return res.json({ success: false, message: 'Data tidak ditemukan' });
        }
        res.json({ success: true, data: result.recordset[0] });
    } catch (err) {
        res.json({ success: false, message: err.message });
    }
};

// Buat berita acara untuk satu tanggal kas; total dan jumlah bukti dihitung dari KAS_SIMRS
exports.insert = async function (req, res) {
    if (!checkAccess(req, 'add')) {
        return res.status(403).json({ success: false, message: 'Tidak memiliki akses' });
    }
    const info = req.body;
    if (!isValidDate(info.tglKas)) {
        return res.json({ success: false, message: 'Tanggal kas wajib diisi' });
    }

    const noBA = 'BA-' + info.tglKas.replace(/-/g, '');
    try {
        const pool = await db.poolPromise;
        const result = await pool.request()
            .input('noBA', db.sql.NVarChar, noBA)
            .input('tglKas', db.sql.VarChar, info.tglKas)
            .input('catatan', db.sql.NVarChar, info.catatan || null)
            .input('createdBy', db.sql.NVarChar, req.session.user || null)
            .query(`
                IF EXISTS (SELECT 1 FROM BERITA_ACARA WHERE tglKas = CAST(@tglKas AS DATE))
                    SELECT CAST(1 AS BIT) AS sudahAda, 0 AS jumlahBukti;
                ELSE
                BEGIN
                    INSERT INTO BERITA_ACARA (noBA, tglKas, totalSetoran, jumlahBukti, status, catatan, createdBy)
                    SELECT @noBA, CAST(@tglKas AS DATE), ISNULL(SUM(total), 0), COUNT(*), 'menunggu', @catatan, @createdBy
                    FROM KAS_SIMRS WHERE CAST(tglKAS AS DATE) = CAST(@tglKas AS DATE);
                    SELECT CAST(0 AS BIT) AS sudahAda, jumlahBukti FROM BERITA_ACARA WHERE noBA = @noBA;
                END
            `);

        const row = result.recordset[0];
        if (row.sudahAda) {
            return res.json({ success: false, message: 'Berita acara untuk tanggal tersebut sudah ada' });
        }
        res.json({ success: true, message: 'Berita acara ' + noBA + ' berhasil dibuat (' + row.jumlahBukti + ' bukti)' });
    } catch (err) {
        res.json({ success: false, message: err.message });
    }
};

// Tandatangani / sahkan berita acara
exports.validasi = async function (req, res) {
    if (!checkAccess(req, 'validasi')) {
        return res.status(403).json({ success: false, message: 'Tidak memiliki akses' });
    }
    const id = req.params.id || req.body.noBA;
    try {
        const pool = await db.poolPromise;
        const result = await pool.request()
            .input('noBA', db.sql.NVarChar, id)
            .input('ttdOleh', db.sql.NVarChar, req.session.user || 'Kepala Keuangan BLUD')
            .query(`
                SELECT status FROM BERITA_ACARA WHERE noBA = @noBA;
                UPDATE BERITA_ACARA SET status = 'selesai', ttdOleh = @ttdOleh, tglTtd = GETDATE()
                WHERE noBA = @noBA AND status = 'menunggu';
            `);

        if (result.recordset.length === 0) {
            return res.json({ success: false, message: 'Data tidak ditemukan' });
        }
        if (result.recordset[0].status === 'selesai') {
            return res.json({ success: false, message: 'Berita acara sudah ditandatangani' });
        }
        res.json({ success: true, message: 'Berita acara ' + id + ' berhasil ditandatangani' });
    } catch (err) {
        res.json({ success: false, message: err.message });
    }
};

const HARI = ['Minggu', 'Senin', 'Selasa', 'Rabu', 'Kamis', 'Jumat', 'Sabtu'];
const BULAN = ['Januari', 'Februari', 'Maret', 'April', 'Mei', 'Juni', 'Juli', 'Agustus', 'September', 'Oktober', 'November', 'Desember'];
const SATUAN = ['', 'satu', 'dua', 'tiga', 'empat', 'lima', 'enam', 'tujuh', 'delapan', 'sembilan', 'sepuluh', 'sebelas'];

// Angka bulat -> kata, contoh 1250 -> 'seribu dua ratus lima puluh'
function terbilang(n) {
    n = Math.floor(Math.abs(n));
    if (n < 12) return SATUAN[n];
    if (n < 20) return terbilang(n - 10) + ' belas';
    if (n < 100) return (terbilang(Math.floor(n / 10)) + ' puluh ' + terbilang(n % 10)).trim();
    if (n < 200) return ('seratus ' + terbilang(n - 100)).trim();
    if (n < 1000) return (terbilang(Math.floor(n / 100)) + ' ratus ' + terbilang(n % 100)).trim();
    if (n < 2000) return ('seribu ' + terbilang(n - 1000)).trim();
    const skala = [[1e12, 'triliun'], [1e9, 'miliar'], [1e6, 'juta'], [1e3, 'ribu']];
    for (const [nilai, nama] of skala) {
        if (n >= nilai) return (terbilang(Math.floor(n / nilai)) + ' ' + nama + ' ' + terbilang(n % nilai)).trim();
    }
    return '';
}

// Halaman cetak berita acara (dibuka di tab baru, dicetak lewat dialog print browser).
// Format: BA penitipan uang kasir (pihak kedua) ke bendahara penerimaan (pihak pertama).
exports.exportCetak = async function (req, res) {
    if (!checkAccess(req, 'export')) {
        return res.status(403).send('Tidak memiliki akses');
    }
    const id = req.params.id || req.query.id;
    try {
        const pool = await db.poolPromise;
        const result = await pool.request()
            .input('noBA', db.sql.NVarChar, id)
            .query(`
                SELECT noBA, CONVERT(VARCHAR(10), tglKas, 23) AS tglKas, totalSetoran, jumlahBukti, status, ttdOleh,
                       CONVERT(VARCHAR(10), tglTtd, 23) AS tglTtd, catatan, createdBy
                FROM BERITA_ACARA WHERE noBA = @noBA;
            `);

        const ba = result.recordsets[0][0];
        if (!ba) {
            return res.status(404).send('Berita acara tidak ditemukan');
        }
        const tgl = new Date(ba.tglKas + 'T00:00:00Z');
        const total = Number(ba.totalSetoran);
        const kapital = (s) => s.replace(/\b\w/g, (c) => c.toUpperCase());

        res.render('beritaAcara/views/vw_cetak.html', {
            ba,
            hari: HARI[tgl.getUTCDay()],
            tanggalKata: kapital(terbilang(tgl.getUTCDate())),
            bulan: BULAN[tgl.getUTCMonth()],
            tahunKata: kapital(terbilang(tgl.getUTCFullYear())),
            tanggalTtd: tgl.getUTCDate() + ' ' + BULAN[tgl.getUTCMonth()] + ' ' + tgl.getUTCFullYear(),
            terbilang: kapital(total > 0 ? terbilang(total) + ' rupiah' : 'nol rupiah'),
            // Identitas para pihak; bisa diganti lewat .env tanpa ubah kode
            pihakPertama: {
                nama: process.env.BA_BENDAHARA_NAMA || 'Ida Ayu Putri Agustina Mayawati, SE., MM',
                nip: process.env.BA_BENDAHARA_NIP || '196908301990032006',
                jabatan: process.env.BA_BENDAHARA_JABATAN || 'Bendahara Penerimaan RS Mata Bali Mandara',
            },
            pihakKedua: {
                nama: process.env.BA_KASIR_NAMA || 'I Komang Ranandika',
                nip: process.env.BA_KASIR_NIP || '-',
                jabatan: process.env.BA_KASIR_JABATAN || 'Kasir',
            },
            rupiah: (v) => Number(v || 0).toLocaleString('id-ID', { maximumFractionDigits: 0 }),
        });
    } catch (err) {
        console.error('Error in beritaAcara.exportCetak:', err);
        res.status(500).send('Error: ' + err.message);
    }
};
