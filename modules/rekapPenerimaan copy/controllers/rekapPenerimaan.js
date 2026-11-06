const db = require('../../../database');
const { checkAccess } = require('../../../helpers/accessControl');
const { isValidDate, periodeRekap, emptyDataTables, dataTablesParams, catatLog, getPengaturan } = require('../../../helpers/integrasi');

// Rekap harian transaksi penerimaan SIM RS (REKAP_PENERIMAAN) sebelum dikirim ke SIPKD BLUD.
// Bukti kas masuk ke rekap lewat KAS_SIMRS.keyREKAP: satu bukti hanya bisa masuk satu rekap.
// Bukti yang masuk ditentukan periodeRekap (cut off harian TBP & STS, lihat helpers/integrasi.js).

const ORDERABLE_COLUMNS = { 1: 'noREKAP', 2: 'tglREKAP', 3: 'jenis', 4: 'uraian', 5: 'tglSetor', 6: 'statusApi' };
const JENIS = ['TBP', 'STS'];

// Nomor rekap berikutnya, contoh RKP-00004
const NEXT_NO_SQL = `'RKP-' + RIGHT('00000' + CAST(ISNULL(MAX(CAST(SUBSTRING(noREKAP, 5, 10) AS INT)), 0) + 1 AS VARCHAR(10)), 5)`;

const SELECT_REKAP = `
    SELECT keyREKAP, noREKAP AS noRekap, CONVERT(VARCHAR(10), tglREKAP, 23) AS tanggal, jenis, uraian,
           CONVERT(VARCHAR(10), tglSetor, 23) AS tglSetor, bank, noRek, nmRek, statusApi
    FROM REKAP_PENERIMAAN`;

function validasiInput(info) {
    if (!isValidDate(info.tanggal) || !isValidDate(info.tglSetor) || !info.uraian) return 'Tanggal, uraian, dan tanggal setor wajib diisi';
    if (!JENIS.includes(info.jenis)) return 'Jenis harus TBP atau STS';
    if (!periodeRekap(info.tanggal)) return 'Transaksi hari Sabtu direkap pada tanggal Minggu';
    return null;
}

// Bind field rekap beserta batas periode bukti kas (@mulai inklusif, @akhir eksklusif)
function inputRekap(request, info) {
    const periode = periodeRekap(info.tanggal);
    return request
        .input('mulai', db.sql.VarChar, periode.mulai)
        .input('akhir', db.sql.VarChar, periode.akhir)
        .input('tanggal', db.sql.VarChar, info.tanggal)
        .input('jenis', db.sql.VarChar, info.jenis)
        .input('uraian', db.sql.NVarChar, info.uraian)
        .input('tglSetor', db.sql.VarChar, info.tglSetor)
        .input('bank', db.sql.NVarChar, info.bank || null)
        .input('noRek', db.sql.NVarChar, info.noRek || null)
        .input('nmRek', db.sql.NVarChar, info.nmRek || null);
}

// Tampilkan halaman rekap
exports.index = async function (req, res) {
    try {
        if (!checkAccess(req, 'view')) {
            return res.status(403).send('Tidak memiliki akses');
        }

        const pool = await db.poolPromise;
        const pengaturan = await getPengaturan(pool);

        const vars = {
            title: 'Rekap Transaksi Penerimaan',
            subtitle: 'Rekap harian sebelum dikirim ke SIPKD BLUD',
            module: 'rekapPenerimaan',
            akses: req.session.aksesMenu.rekapPenerimaan || {},
            bank: { bank: pengaturan.bankBlud || '', noRek: pengaturan.noRekBlud || '', nmRek: pengaturan.nmRekBlud || '' },
        };

        const viewPath = 'rekapPenerimaan/views/vw_data.html';
        if (req.xhr || req.headers['x-requested-with'] === 'XMLHttpRequest') {
            res.render(viewPath, vars);
        } else {
            vars.content = viewPath;
            res.render('index', vars);
        }
    } catch (err) {
        console.error('Error in rekapPenerimaan.index:', err);
        res.status(500).send('Error: ' + err.message);
    }
};

// Data rekap untuk DataTables
exports.data = async function (req, res) {
    if (!checkAccess(req, 'view')) {
        return res.status(403).json(emptyDataTables(req, 'Tidak memiliki akses untuk melihat data'));
    }
    try {
        const p = dataTablesParams(req.query, ORDERABLE_COLUMNS, 'noREKAP');
        const where = 'WHERE noREKAP LIKE @search OR uraian LIKE @search';

        const pool = await db.poolPromise;
        const result = await pool.request()
            .input('search', db.sql.NVarChar, '%' + p.search + '%')
            .input('start', db.sql.Int, p.start)
            .input('length', db.sql.Int, p.length)
            .query(`
                SELECT COUNT(*) AS total FROM REKAP_PENERIMAAN;
                SELECT COUNT(*) AS total FROM REKAP_PENERIMAAN ${where};
                SELECT noREKAP AS noRekap, CONVERT(VARCHAR(10), tglREKAP, 23) AS tanggal, jenis, uraian,
                       CONVERT(VARCHAR(10), tglSetor, 23) AS tglSetor, statusApi
                FROM REKAP_PENERIMAAN
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

// Detail rekap: data header, rincian per nomor bukti, dan rekap per rekening BLUD
exports.detail = async function (req, res) {
    if (!checkAccess(req, 'view')) {
        return res.status(403).json({ success: false, message: 'Tidak memiliki akses' });
    }
    const id = req.params.id || req.query.id;
    try {
        const pool = await db.poolPromise;
        const result = await pool.request()
            .input('noREKAP', db.sql.NVarChar, id)
            .query(`
                ${SELECT_REKAP} WHERE noREKAP = @noREKAP;
                SELECT k.noBukti, CONVERT(VARCHAR(19), k.tglKAS, 126) AS tanggal, k.penyetor, k.total
                FROM KAS_SIMRS k JOIN REKAP_PENERIMAAN r ON r.keyREKAP = k.keyREKAP
                WHERE r.noREKAP = @noREKAP
                ORDER BY k.tglKAS;
                SELECT d.kdREK AS kdRek, d.nmRekening AS rekening, SUM(d.nilai) AS nilai
                FROM KAS_SIMRS_DETAIL d
                JOIN KAS_SIMRS k ON k.keyKAS = d.keyKAS
                JOIN REKAP_PENERIMAAN r ON r.keyREKAP = k.keyREKAP
                WHERE r.noREKAP = @noREKAP
                GROUP BY d.kdREK, d.nmRekening
                ORDER BY d.kdREK, d.nmRekening;
            `);

        if (result.recordsets[0].length === 0) {
            return res.json({ success: false, message: 'Data tidak ditemukan' });
        }
        const { keyREKAP, ...rekap } = result.recordsets[0][0];
        const bukti = result.recordsets[1];
        res.json({
            success: true,
            data: { ...rekap, periode: periodeRekap(rekap.tanggal), bukti, rekening: result.recordsets[2], total: bukti.reduce((s, k) => s + Number(k.total), 0) },
        });
    } catch (err) {
        res.json({ success: false, message: err.message });
    }
};

// Nomor rekap berikutnya untuk modal Generate (nomor final ditentukan saat insert)
exports.getNomorBaru = async function (req, res) {
    if (!checkAccess(req, 'add')) {
        return res.status(403).json({ success: false, message: 'Tidak memiliki akses' });
    }
    try {
        const pool = await db.poolPromise;
        const result = await pool.request().query(`SELECT ${NEXT_NO_SQL} AS noRekap FROM REKAP_PENERIMAAN`);
        res.json({ success: true, data: { noRekap: result.recordset[0].noRekap } });
    } catch (err) {
        res.json({ success: false, message: err.message });
    }
};

// Generate rekap baru dan masukkan bukti kas (jenis sama, dalam periode cut off) yang belum masuk rekap lain
exports.insert = async function (req, res) {
    if (!checkAccess(req, 'add')) {
        return res.status(403).json({ success: false, message: 'Tidak memiliki akses' });
    }
    const info = req.body;
    const error = validasiInput(info);
    if (error) {
        return res.json({ success: false, message: error });
    }

    try {
        const pool = await db.poolPromise;
        const result = await inputRekap(pool.request(), info)
            .input('createdBy', db.sql.NVarChar, req.session.user || null)
            .query(`
                SET XACT_ABORT ON;
                BEGIN TRAN;
                DECLARE @noREKAP NVARCHAR(20) = (SELECT ${NEXT_NO_SQL} FROM REKAP_PENERIMAAN WITH (UPDLOCK, HOLDLOCK));
                INSERT INTO REKAP_PENERIMAAN (noREKAP, tglREKAP, jenis, uraian, tglSetor, bank, noRek, nmRek, statusApi, createdBy)
                VALUES (@noREKAP, CAST(@tanggal AS DATE), @jenis, @uraian, CAST(@tglSetor AS DATE), @bank, @noRek, @nmRek, 'pending', @createdBy);
                DECLARE @keyREKAP BIGINT = SCOPE_IDENTITY();
                UPDATE KAS_SIMRS SET keyREKAP = @keyREKAP
                WHERE keyREKAP IS NULL AND jenis = @jenis
                  AND tglKAS >= CONVERT(DATETIME, @mulai, 120) AND tglKAS < CONVERT(DATETIME, @akhir, 120);
                DECLARE @jumlah INT = @@ROWCOUNT;
                COMMIT;
                SELECT @noREKAP AS noRekap, @jumlah AS jumlah;
            `);

        const row = result.recordset[0];
        res.json({ success: true, message: 'Rekap ' + row.noRekap + ' berhasil dibuat (' + row.jumlah + ' bukti)' });
    } catch (err) {
        res.json({ success: false, message: err.message });
    }
};

// Perbarui rekap yang belum terkirim; bukti kas dihubungkan ulang sesuai periode & jenis baru
exports.update = async function (req, res) {
    if (!checkAccess(req, 'edit')) {
        return res.status(403).json({ success: false, message: 'Tidak memiliki akses' });
    }
    const info = req.body;
    const error = validasiInput(info);
    if (error || !info.noRekap) {
        return res.json({ success: false, message: error || 'Nomor rekap wajib diisi' });
    }

    try {
        const pool = await db.poolPromise;
        const result = await inputRekap(pool.request(), info)
            .input('noREKAP', db.sql.NVarChar, info.noRekap)
            .query(`
                SET XACT_ABORT ON;
                DECLARE @keyREKAP BIGINT, @statusApi VARCHAR(10);
                SELECT @keyREKAP = keyREKAP, @statusApi = statusApi FROM REKAP_PENERIMAAN WHERE noREKAP = @noREKAP;

                IF @keyREKAP IS NULL OR @statusApi = 'success'
                    SELECT @keyREKAP AS keyREKAP, @statusApi AS statusApi;
                ELSE
                BEGIN
                    BEGIN TRAN;
                    UPDATE REKAP_PENERIMAAN SET
                        tglREKAP = CAST(@tanggal AS DATE), jenis = @jenis, uraian = @uraian, tglSetor = CAST(@tglSetor AS DATE),
                        bank = @bank, noRek = @noRek, nmRek = @nmRek
                    WHERE keyREKAP = @keyREKAP;
                    UPDATE KAS_SIMRS SET keyREKAP = NULL WHERE keyREKAP = @keyREKAP;
                    UPDATE KAS_SIMRS SET keyREKAP = @keyREKAP
                    WHERE keyREKAP IS NULL AND jenis = @jenis
                      AND tglKAS >= CONVERT(DATETIME, @mulai, 120) AND tglKAS < CONVERT(DATETIME, @akhir, 120);
                    COMMIT;
                    SELECT @keyREKAP AS keyREKAP, @statusApi AS statusApi;
                END
            `);

        const row = result.recordset[0];
        if (!row.keyREKAP) {
            return res.json({ success: false, message: 'Data tidak ditemukan' });
        }
        if (row.statusApi === 'success') {
            return res.json({ success: false, message: 'Rekap yang sudah terkirim tidak dapat diubah' });
        }
        res.json({ success: true, message: 'Data berhasil diperbarui' });
    } catch (err) {
        res.json({ success: false, message: err.message });
    }
};

// Hapus rekap yang belum terkirim; bukti kas dilepas otomatis (FK ON DELETE SET NULL)
exports.delete = async function (req, res) {
    if (!checkAccess(req, 'delete')) {
        return res.status(403).json({ success: false, message: 'Tidak memiliki akses' });
    }
    const id = req.params.id || req.query.id;
    try {
        const pool = await db.poolPromise;
        const result = await pool.request()
            .input('noREKAP', db.sql.NVarChar, id)
            .query(`
                SELECT statusApi FROM REKAP_PENERIMAAN WHERE noREKAP = @noREKAP;
                DELETE FROM REKAP_PENERIMAAN WHERE noREKAP = @noREKAP AND statusApi <> 'success';
            `);

        if (result.recordset.length === 0) {
            return res.json({ success: false, message: 'Data tidak ditemukan' });
        }
        if (result.recordset[0].statusApi === 'success') {
            return res.json({ success: false, message: 'Rekap yang sudah terkirim tidak dapat dihapus' });
        }
        res.json({ success: true, message: 'Data berhasil dihapus' });
    } catch (err) {
        res.json({ success: false, message: err.message });
    }
};

// Nilai tetap dokumen TBP di SIPKD BLUD (unit RS Mata Bali Mandara, bendahara penerimaan)
const SIPKD_TBP = {
    unitKey: '239_', keyBend: '1099_', kdStatus: '60', idxKode: 1,
    penyetor: 'Bendahara Penerimaan', alamat: 'RSM Bali Mandara', noJetra: '11',
};

// Nama database SIPKD tujuan (SIPKD_DB_NAME), dikutip sebagai identifier SQL; satu server dengan DB_*.
function sipkdDb() {
    const nama = process.env.SIPKD_DB_NAME;
    if (!nama || !/^[\w@$#-]+$/.test(nama)) {
        throw new Error('SIPKD_DB_NAME belum diatur atau tidak valid di .env');
    }
    return '[' + nama + ']';
}

// Kirim (ulang) rekap TBP ke SIPKD dalam satu transaksi: header ke <SIPKD_DB_NAME>.dbo.TBP, rincian per rekening ke
// dbo.TBPDETD (nmRekening SIM RS dicocokkan ke MATANGD.NMPER), lalu tandai rekap terkirim. Bila ada nama rekening yang
// tidak ditemukan di MATANGD, pengiriman dibatalkan supaya nilai TBP di SIPKD tidak kurang dari rekap.
// NOREG diisi ulang oleh trigger TI_TBP di SIPKD. Hasil (berhasil/gagal) dicatat ke LOG_API.
exports.updateKirimUlang = async function (req, res) {
    if (!checkAccess(req, 'validasi')) {
        return res.status(403).json({ success: false, message: 'Tidak memiliki akses' });
    }
    const id = req.params.id || req.body.noRekap;
    const endpoint = 'SIPKD dbo.TBP';
    let pool, rekap;
    try {
        pool = await db.poolPromise;
        const found = await pool.request()
            .input('noREKAP', db.sql.NVarChar, id)
            .query(`${SELECT_REKAP} WHERE noREKAP = @noREKAP`);

        rekap = found.recordset[0];
        if (!rekap) {
            return res.json({ success: false, message: 'Data tidak ditemukan' });
        }
        if (rekap.statusApi === 'success') {
            return res.json({ success: false, message: 'Rekap sudah terkirim' });
        }
        if (rekap.jenis !== 'TBP') {
            return res.json({ success: false, message: 'Pengiriman rekap ' + rekap.jenis + ' ke SIPKD belum tersedia' });
        }

        const result = await pool.request()
            .input('keyREKAP', db.sql.BigInt, rekap.keyREKAP)
            .input('noTBP', db.sql.VarChar, rekap.noRekap)
            .input('tglTBP', db.sql.VarChar, rekap.tanggal)
            .input('uraian', db.sql.VarChar, rekap.uraian)
            .input('noReg', db.sql.VarChar, rekap.noRekap.slice(-5))
            .input('unitKey', db.sql.VarChar, SIPKD_TBP.unitKey)
            .input('keyBend', db.sql.VarChar, SIPKD_TBP.keyBend)
            .input('kdStatus', db.sql.VarChar, SIPKD_TBP.kdStatus)
            .input('idxKode', db.sql.Int, SIPKD_TBP.idxKode)
            .input('penyetor', db.sql.VarChar, SIPKD_TBP.penyetor)
            .input('alamat', db.sql.VarChar, SIPKD_TBP.alamat)
            .input('noJetra', db.sql.VarChar, SIPKD_TBP.noJetra)
            .query(`
                SET XACT_ABORT ON;
                BEGIN TRAN;
                DECLARE @baru BIT = 0;
                IF NOT EXISTS (SELECT 1 FROM ${sipkdDb()}.dbo.TBP WHERE UNITKEY = @unitKey AND NOTBP = @noTBP)
                BEGIN
                    INSERT INTO ${sipkdDb()}.dbo.TBP
                        (UNITKEY, NOTBP, KEYBEND1, KDSTATUS, KEYBEND2, IDXKODE, TGLTBP, PENYETOR, ALAMAT, URAITBP, TGLVALID, NOREG)
                    VALUES (@unitKey, @noTBP, @keyBend, @kdStatus, @keyBend, @idxKode, CAST(@tglTBP AS DATETIME), @penyetor, @alamat,
                            @uraian, CAST(@tglTBP AS DATETIME), @noReg);
                    SET @baru = 1;
                END

                -- Rincian per rekening; collation dibedakan antar database jadi perbandingan nama di-COLLATE
                DECLARE @rinci TABLE (nmRekening NVARCHAR(100), mtgKey VARCHAR(10), nilai DECIMAL(18,2));
                INSERT INTO @rinci (nmRekening, mtgKey, nilai)
                SELECT LTRIM(RTRIM(d.nmRekening)), MAX(m.MTGKEY), SUM(d.nilai)
                FROM KAS_SIMRS k
                JOIN KAS_SIMRS_DETAIL d ON d.keyKAS = k.keyKAS
                LEFT JOIN ${sipkdDb()}.dbo.MATANGD m
                    ON LTRIM(RTRIM(m.NMPER)) COLLATE DATABASE_DEFAULT = LTRIM(RTRIM(d.nmRekening))
                WHERE k.keyREKAP = @keyREKAP
                GROUP BY LTRIM(RTRIM(d.nmRekening));

                DECLARE @tanpaAkun NVARCHAR(MAX) = (SELECT STRING_AGG(nmRekening, ', ') FROM @rinci WHERE mtgKey IS NULL);
                IF @tanpaAkun IS NOT NULL
                BEGIN
                    DECLARE @pesan NVARCHAR(2048) = N'Rekening tidak ditemukan di MATANGD SIPKD: ' + @tanpaAkun;
                    THROW 50001, @pesan, 1;
                END

                DECLARE @jumlahRinci INT = 0;
                IF NOT EXISTS (SELECT 1 FROM ${sipkdDb()}.dbo.TBPDETD WHERE UNITKEY = @unitKey AND NOTBP = @noTBP)
                BEGIN
                    INSERT INTO ${sipkdDb()}.dbo.TBPDETD (MTGKEY, NOJETRA, UNITKEY, NOTBP, NILAI)
                    SELECT mtgKey, @noJetra, @unitKey, @noTBP, SUM(nilai)
                    FROM @rinci
                    GROUP BY mtgKey;
                    SET @jumlahRinci = @@ROWCOUNT;
                END

                UPDATE REKAP_PENERIMAAN SET statusApi = 'success' WHERE keyREKAP = @keyREKAP;
                COMMIT;
                SELECT @baru AS baru, @jumlahRinci AS jumlahRinci;
            `);
        const { baru, jumlahRinci } = result.recordset[0];

        await catatLog(pool, {
            httpCode: 200, metode: 'INSERT', endpoint, ref: rekap.noRekap,
            body: { status: 200, message: baru ? 'TBP berhasil dicatat di SIPKD' : 'TBP sudah ada di SIPKD, rekap ditandai terkirim', noTBP: rekap.noRekap, rincian: jumlahRinci, dipicu_oleh: req.session.user },
        });
        res.json({ success: true, message: 'Rekap ' + rekap.noRekap + ' berhasil dikirim ke SIPKD (' + jumlahRinci + ' rincian rekening)' + (baru ? '' : ', TBP sudah ada sebelumnya') });
    } catch (err) {
        if (rekap) {
            try {
                await pool.request()
                    .input('keyREKAP', db.sql.BigInt, rekap.keyREKAP)
                    .query("UPDATE REKAP_PENERIMAAN SET statusApi = 'failed' WHERE keyREKAP = @keyREKAP AND statusApi <> 'success'");
                await catatLog(pool, {
                    httpCode: 500, metode: 'INSERT', endpoint, ref: rekap.noRekap,
                    body: { status: 500, message: err.message, noTBP: rekap.noRekap, dipicu_oleh: req.session.user },
                });
            } catch (logErr) {
                console.error('Gagal mencatat kegagalan kirim SIPKD:', logErr);
            }
        }
        res.json({ success: false, message: 'Gagal kirim ke SIPKD: ' + err.message });
    }
};
