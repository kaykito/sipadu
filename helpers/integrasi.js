const db = require('../database');

// Helper bersama modul Integrasi SIM RS – BLUD.

const DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;

function isValidDate(value) {
    return typeof value === 'string' && DATE_PATTERN.test(value) && !isNaN(new Date(value + 'T00:00:00').getTime());
}

// Cut off rekap harian (TBP & STS) ke SIPKD BLUD, per hari dokumen (0 = Minggu ... 6 = Sabtu):
//   Senin        00.00 Senin        s.d. 14.00 Senin
//   Selasa-Kamis 14.01 hari kemarin s.d. 14.00 hari itu
//   Jumat        14.01 Kamis        s.d. 13.00 Jumat
//   Minggu       13.01 Jumat        s.d. 23.59 Minggu (mencakup Sabtu; Sabtu tidak punya dokumen sendiri)
// jamAkhir = menit pertama SETELAH cut off, jadi periode = [mulai, akhir) dan antar-hari tidak ada celah/tumpang tindih.
const CUTOFF_REKAP = {
    0: { mundurHari: 2, jamMulai: '13:01', jamAkhir: '24:00' },
    1: { mundurHari: 0, jamMulai: '00:00', jamAkhir: '14:01' },
    2: { mundurHari: 1, jamMulai: '14:01', jamAkhir: '14:01' },
    3: { mundurHari: 1, jamMulai: '14:01', jamAkhir: '14:01' },
    4: { mundurHari: 1, jamMulai: '14:01', jamAkhir: '14:01' },
    5: { mundurHari: 1, jamMulai: '14:01', jamAkhir: '13:01' },
};

function geserTanggal(tanggal, hari) {
    const d = new Date(tanggal + 'T00:00:00Z');
    d.setUTCDate(d.getUTCDate() + hari);
    return d.toISOString().slice(0, 10);
}

// Periode transaksi (waktu lokal, 'YYYY-MM-DD HH:mm:ss') untuk rekap pada tanggal dokumen tertentu.
// Berlaku sama untuk TBP dan STS. Mengembalikan null untuk hari Sabtu (direkap pada tanggal Minggu).
function periodeRekap(tanggal) {
    const aturan = CUTOFF_REKAP[new Date(tanggal + 'T00:00:00Z').getUTCDay()];
    if (!aturan) return null;
    const akhir = aturan.jamAkhir === '24:00' ? geserTanggal(tanggal, 1) + ' 00:00' : tanggal + ' ' + aturan.jamAkhir;
    return { mulai: geserTanggal(tanggal, -aturan.mundurHari) + ' ' + aturan.jamMulai + ':00', akhir: akhir + ':00' };
}

// Respons kosong DataTables untuk akses ditolak / error
function emptyDataTables(req, error) {
    return { draw: parseInt(req.query.draw) || 1, recordsTotal: 0, recordsFiltered: 0, data: [], error };
}

// Ambil parameter paging/cari/urut DataTables; orderableColumns: { indexKolom: 'ekspresi SQL' }
function dataTablesParams(query, orderableColumns, defaultOrder) {
    const order = (query.order && query.order[0]) || {};
    return {
        draw: parseInt(query.draw) || 1,
        start: Math.max(parseInt(query.start) || 0, 0),
        length: Math.min(Math.max(parseInt(query.length) || 10, 1), 1000),
        search: (query.search && query.search.value) || '',
        orderColumn: orderableColumns[order.column] || defaultOrder,
        orderDir: order.dir === 'desc' ? 'DESC' : 'ASC',
    };
}

// Catat satu entri ke LOG_API. Bisa dipanggil dengan pool atau transaction.
async function catatLog(executor, entry) {
    await new db.sql.Request(executor)
        .input('httpCode', db.sql.Int, entry.httpCode)
        .input('metode', db.sql.NVarChar, entry.metode)
        .input('endpoint', db.sql.NVarChar, entry.endpoint)
        .input('ref', db.sql.NVarChar, entry.ref || null)
        .input('body', db.sql.NVarChar(db.sql.MAX), JSON.stringify(entry.body || {}))
        .query('INSERT INTO LOG_API (httpCode, metode, endpoint, ref, body) VALUES (@httpCode, @metode, @endpoint, @ref, @body)');
}

async function getPengaturan(pool) {
    const result = await pool.request().query(`
        SELECT apiBaseUrl, apiToken, autoSync, jamSync, bankBlud, noRekBlud, nmRekBlud
        FROM PENGATURAN_INTEGRASI WHERE keyPENGATURAN = 1`);
    return result.recordset[0] || { apiBaseUrl: '', apiToken: null, autoSync: false, jamSync: '23:59', bankBlud: '', noRekBlud: '', nmRekBlud: '' };
}

module.exports = { isValidDate, periodeRekap,emptyDataTables, dataTablesParams, catatLog, getPengaturan };
