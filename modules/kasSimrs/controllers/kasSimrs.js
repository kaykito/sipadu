const db = require('../../../database');
const { checkAccess } = require('../../../helpers/accessControl');
const { isValidDate, emptyDataTables, dataTablesParams, catatLog } = require('../../../helpers/integrasi');
const simrs = require('../../../helpers/simrsClient');

// Transaksi kas (TBP/STS) dari API SIM RS (KasBlud) yang disimpan di KAS_SIMRS + KAS_SIMRS_DETAIL.
// Tanggal dikirim sebagai string lewat CONVERT supaya tidak bergeser zona waktu di driver mssql.

const ORDERABLE_COLUMNS = { 1: 'tglKAS', 2: 'noBukti', 3: 'penyetor', 5: 'jenis', 6: 'total', 7: 'statusSync' };
const MAKS_HARI_SINKRON = 31;
const DATETIME_LOCAL = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/;

// Nilai input datetime-local ('YYYY-MM-DDTHH:mm') -> 'YYYY-MM-DD HH:mm:ss' untuk CONVERT(..., 120); detik diisi untuk batas awal/akhir
function waktuFilter(value, detik) {
    return typeof value === 'string' && DATETIME_LOCAL.test(value) ? value.replace('T', ' ') + ':' + detik : null;
}

// Tampilkan halaman data kas
exports.index = async function (req, res) {
    try {
        if (!checkAccess(req, 'view')) {
            return res.status(403).send('Tidak memiliki akses');
        }

        const vars = {
            title: 'Data Kas SIM RS',
            subtitle: 'Transaksi kas yang tercatat dari SIM RS, siap disinkronkan',
            module: 'kasSimrs',
            akses: req.session.aksesMenu.kasSimrs || {},
            maksHariSinkron: MAKS_HARI_SINKRON,
        };

        const viewPath = 'kasSimrs/views/vw_data.html';
        if (req.xhr || req.headers['x-requested-with'] === 'XMLHttpRequest') {
            res.render(viewPath, vars);
        } else {
            vars.content = viewPath;
            res.render('index', vars);
        }
    } catch (err) {
        console.error('Error in kasSimrs.index:', err);
        res.status(500).send('Error: ' + err.message);
    }
};

// Data kas untuk DataTables, dengan filter jenis dan rentang tanggal-jam (batas awal & akhir inklusif per menit).
// grandTotal = jumlah total seluruh baris yang lolos filter & pencarian (bukan hanya halaman ini).
exports.data = async function (req, res) {
    if (!checkAccess(req, 'view')) {
        return res.status(403).json(emptyDataTables(req, 'Tidak memiliki akses untuk melihat data'));
    }
    try {
        const p = dataTablesParams(req.query, ORDERABLE_COLUMNS, 'tglKAS');
        const jenis = ['TBP', 'STS'].includes(req.query.jenis) ? req.query.jenis : null;
        const dari = waktuFilter(req.query.dari, '00');
        const sampai = waktuFilter(req.query.sampai, '59.997');

        const filter = `(@jenis IS NULL OR jenis = @jenis)
            AND (@dari IS NULL OR tglKAS >= CONVERT(DATETIME, @dari, 121))
            AND (@sampai IS NULL OR tglKAS <= CONVERT(DATETIME, @sampai, 121))`;
        const where = `WHERE ${filter} AND (noBukti LIKE @search OR penyetor LIKE @search)`;

        const pool = await db.poolPromise;
        const result = await pool.request()
            .input('jenis', db.sql.VarChar, jenis)
            .input('dari', db.sql.VarChar, dari)
            .input('sampai', db.sql.VarChar, sampai)
            .input('search', db.sql.NVarChar, '%' + p.search + '%')
            .input('start', db.sql.Int, p.start)
            .input('length', db.sql.Int, p.length)
            .query(`
                SELECT COUNT(*) AS total FROM KAS_SIMRS WHERE ${filter};
                SELECT COUNT(*) AS total, ISNULL(SUM(total), 0) AS grandTotal FROM KAS_SIMRS ${where};
                SELECT noBukti, CONVERT(VARCHAR(19), tglKAS, 126) AS tanggal, penyetor, jenis, total,
                       bank, noRek, statusSync AS status
                FROM KAS_SIMRS
                ${where}
                ORDER BY ${p.orderColumn} ${p.orderDir}
                OFFSET @start ROWS FETCH NEXT @length ROWS ONLY;
            `);

        res.json({
            draw: p.draw,
            recordsTotal: result.recordsets[0][0].total,
            recordsFiltered: result.recordsets[1][0].total,
            grandTotal: result.recordsets[1][0].grandTotal,
            data: result.recordsets[2],
            error: null
        });
    } catch (err) {
        res.json(emptyDataTables(req, err.message));
    }
};

// Rincian rekening per nomor bukti
exports.detail = async function (req, res) {
    if (!checkAccess(req, 'view')) {
        return res.status(403).json({ success: false, message: 'Tidak memiliki akses' });
    }
    const id = req.params.id || req.query.id;
    try {
        const pool = await db.poolPromise;
        const result = await pool.request()
            .input('noBukti', db.sql.NVarChar, id)
            .query(`
                SELECT keyKAS, noBukti, CONVERT(VARCHAR(19), tglKAS, 126) AS tanggal, penyetor, jenis, total, bank, noRek, statusSync AS status
                FROM KAS_SIMRS WHERE noBukti = @noBukti;
                SELECT d.kdREK AS kdRek, d.nmRekening AS rekening, d.uraian, d.nilai
                FROM KAS_SIMRS_DETAIL d JOIN KAS_SIMRS k ON k.keyKAS = d.keyKAS
                WHERE k.noBukti = @noBukti
                ORDER BY d.keyKASDTL;
            `);

        if (result.recordsets[0].length === 0) {
            return res.json({ success: false, message: 'Data tidak ditemukan' });
        }
        const { keyKAS, ...kas } = result.recordsets[0][0];
        res.json({ success: true, data: { ...kas, rincian: result.recordsets[1] } });
    } catch (err) {
        res.json({ success: false, message: err.message });
    }
};

// Kelompokkan baris KasBlud (satu baris per rincian, noBukti bersufiks -1, -2, ...) menjadi header bukti + detail
function kelompokkanKasBlud(rows) {
    const headers = {};
    const details = [];
    rows.forEach(r => {
        const noBukti = String(r.noBukti || '').trim().replace(/-\d+$/, '');
        if (!noBukti || !r.kasBludId) return;
        const nilai = Number(r.nilai) || 0;
        if (!headers[noBukti]) {
            headers[noBukti] = {
                noBukti,
                tglKAS: String(r.kasBludDate || '').slice(0, 19),
                penyetor: String(r.penyetor || '').trim(),
                jenis: String(r.jenisPenerimaan || '').trim().toUpperCase(),
                total: 0,
                bank: String(r.bankNasName || '').trim() || null,
                noRek: String(r.rekBlud || '').trim() || null,
            };
        }
        headers[noBukti].total += nilai;
        details.push({
            kasBludId: String(r.kasBludId).trim(),
            noBukti,
            kdREK: String(r.rekId || '').trim(),
            nmRekening: String(r.rekName || '').trim(),
            uraian: String(r.uraian || '').trim() || null,
            nilai,
        });
    });
    return { headers: Object.values(headers), details };
}

// Tarik data kas dari API SIM RS (KasBlud) untuk rentang tanggal, lalu simpan ke KAS_SIMRS + KAS_SIMRS_DETAIL.
// Bukti baru ditambahkan, bukti lama diperbarui; bukti yang sudah masuk rekap tidak diubah.
exports.updateSinkronisasi = async function (req, res) {
    if (!checkAccess(req, 'edit')) {
        return res.status(403).json({ success: false, message: 'Tidak memiliki akses' });
    }

    const dari = req.body.dari;
    const sampai = req.body.sampai || dari;
    if (!isValidDate(dari) || !isValidDate(sampai) || dari > sampai) {
        return res.json({ success: false, message: 'Rentang tanggal tidak valid' });
    }
    if ((new Date(sampai) - new Date(dari)) / 86400000 > MAKS_HARI_SINKRON - 1) {
        return res.json({ success: false, message: 'Rentang maksimal ' + MAKS_HARI_SINKRON + ' hari per sinkronisasi' });
    }

    const pool = await db.poolPromise;
    const ref = 'KAS ' + dari + (sampai !== dari ? ' s.d. ' + sampai : '');
    let api;
    try {
        api = await simrs.getKasBlud(dari, sampai);
    } catch (err) {
        await catatLog(pool, {
            httpCode: err.status || 500, metode: 'GET', endpoint: 'SIM RS KasBlud', ref,
            body: { job: 'sinkronisasi-kas', status: err.status || 500, error: err.message, response: err.body, dipicu_oleh: req.session.user },
        }).catch(() => {});
        return res.json({ success: false, message: err.message });
    }

    try {
        const { headers, details } = kelompokkanKasBlud(api.rows);
        const invalid = headers.find(h => !['TBP', 'STS'].includes(h.jenis) || !/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/.test(h.tglKAS));
        if (invalid) {
            throw new Error('Data SIM RS tidak valid pada bukti ' + invalid.noBukti + ' (jenis/tanggal)');
        }

        let hasil = { baru: 0, diperbarui: 0, dilewati: 0 };
        if (headers.length) {
            const result = await pool.request()
                .input('headers', db.sql.NVarChar(db.sql.MAX), JSON.stringify(headers))
                .input('details', db.sql.NVarChar(db.sql.MAX), JSON.stringify(details))
                .query(`
                    SET XACT_ABORT ON;
                    DECLARE @h TABLE (noBukti NVARCHAR(30) PRIMARY KEY, tglKAS DATETIME, penyetor NVARCHAR(150), jenis VARCHAR(3), total DECIMAL(18,2), bank NVARCHAR(100), noRek NVARCHAR(50));
                    INSERT INTO @h
                    SELECT noBukti, CONVERT(DATETIME, tglKAS, 120), penyetor, jenis, total, bank, noRek
                    FROM OPENJSON(@headers) WITH (
                        noBukti NVARCHAR(30), tglKAS VARCHAR(19), penyetor NVARCHAR(150), jenis VARCHAR(3),
                        total DECIMAL(18,2), bank NVARCHAR(100), noRek NVARCHAR(50));

                    DECLARE @d TABLE (kasBludId NVARCHAR(30) PRIMARY KEY, noBukti NVARCHAR(30), kdREK NVARCHAR(30), nmRekening NVARCHAR(100), uraian NVARCHAR(200), nilai DECIMAL(18,2));
                    INSERT INTO @d
                    SELECT kasBludId, noBukti, kdREK, nmRekening, uraian, nilai
                    FROM OPENJSON(@details) WITH (
                        kasBludId NVARCHAR(30), noBukti NVARCHAR(30), kdREK NVARCHAR(30), nmRekening NVARCHAR(100),
                        uraian NVARCHAR(200), nilai DECIMAL(18,2));

                    DECLARE @dilewati INT = (SELECT COUNT(*) FROM @h h JOIN KAS_SIMRS k ON k.noBukti = h.noBukti WHERE EXISTS (SELECT 1 FROM Rekap_SIMRS rs WHERE rs.nomorBUKTI = k.noBukti));
                    DECLARE @diperbarui INT, @baru INT;

                    BEGIN TRAN;
                    UPDATE k SET tglKAS = h.tglKAS, penyetor = h.penyetor, jenis = h.jenis, total = h.total,
                                 bank = h.bank, noRek = h.noRek, statusSync = 'success', syncedAt = GETDATE()
                    FROM KAS_SIMRS k JOIN @h h ON h.noBukti = k.noBukti
                    WHERE NOT EXISTS (SELECT 1 FROM Rekap_SIMRS rs WHERE rs.nomorBUKTI = k.noBukti);
                    SET @diperbarui = @@ROWCOUNT;

                    INSERT INTO KAS_SIMRS (noBukti, tglKAS, penyetor, jenis, total, bank, noRek, statusSync, syncedAt)
                    SELECT h.noBukti, h.tglKAS, h.penyetor, h.jenis, h.total, h.bank, h.noRek, 'success', GETDATE()
                    FROM @h h
                    WHERE NOT EXISTS (SELECT 1 FROM KAS_SIMRS k WHERE k.noBukti = h.noBukti);
                    SET @baru = @@ROWCOUNT;

                    -- Rincian bukti yang boleh diubah diganti total dengan data terbaru
                    DELETE d FROM KAS_SIMRS_DETAIL d
                    JOIN KAS_SIMRS k ON k.keyKAS = d.keyKAS
                    JOIN @h h ON h.noBukti = k.noBukti
                    WHERE NOT EXISTS (SELECT 1 FROM Rekap_SIMRS rs WHERE rs.nomorBUKTI = k.noBukti);

                    INSERT INTO KAS_SIMRS_DETAIL (keyKAS, kasBludId, kdREK, nmRekening, uraian, nilai)
                    SELECT k.keyKAS, d.kasBludId, d.kdREK, d.nmRekening, d.uraian, d.nilai
                    FROM @d d JOIN KAS_SIMRS k ON k.noBukti = d.noBukti
                    WHERE NOT EXISTS (SELECT 1 FROM Rekap_SIMRS rs WHERE rs.nomorBUKTI = k.noBukti);
                    COMMIT;

                    SELECT @baru AS baru, @diperbarui AS diperbarui, @dilewati AS dilewati;
                `);
            hasil = result.recordset[0];
        }

        const message = 'Sinkronisasi ' + ref + ': ' + api.rows.length + ' baris dari SIM RS, '
            + hasil.baru + ' bukti baru, ' + hasil.diperbarui + ' diperbarui'
            + (hasil.dilewati ? ', ' + hasil.dilewati + ' dilewati (sudah masuk rekap)' : '');

        await catatLog(pool, {
            httpCode: api.status, metode: 'GET', endpoint: 'SIM RS ' + api.endpoint, ref,
            body: { job: 'sinkronisasi-kas', status: api.status, message, jumlah_baris: api.rows.length, jumlah_bukti: headers.length, ...hasil, dipicu_oleh: req.session.user },
        });
        res.json({ success: true, message, data: hasil });
    } catch (err) {
        await catatLog(pool, {
            httpCode: 500, metode: 'GET', endpoint: 'SIM RS ' + api.endpoint, ref,
            body: { job: 'sinkronisasi-kas', status: 500, error: 'Gagal menyimpan data kas: ' + err.message, dipicu_oleh: req.session.user },
        }).catch(() => {});
        res.json({ success: false, message: 'Gagal menyimpan data kas: ' + err.message });
    }
};
