-- Rekap_SIMRS: penghubung REKAP_PENERIMAAN <-> KAS_SIMRS (menggantikan KAS_SIMRS.keyREKAP), plus stored procedure:
--   sp_RekapSIMRS_Generate   -> isi bukti otomatis sesuai jendela cut off tanggal rekap
--   sp_RekapSIMRS_TambahBukti -> tambah bukti manual (modal "Tambah Nomor Bukti Baru")
--   sp_RekapSIMRS_HapusBukti  -> lepas satu bukti dari rekap
-- Satu bukti hanya boleh masuk satu rekap (UQ nomorBUKTI). KAS_SIMRS.keyREKAP tidak dipakai lagi.

-- FK lama dilepas: selain tidak dipakai, ON DELETE SET NULL-nya membuat jalur cascade ganda ke Rekap_SIMRS
IF OBJECT_ID(N'dbo.FK_KAS_SIMRS_REKAP_PENERIMAAN', N'F') IS NOT NULL
    ALTER TABLE [dbo].[KAS_SIMRS] DROP CONSTRAINT [FK_KAS_SIMRS_REKAP_PENERIMAAN];
GO

IF OBJECT_ID(N'dbo.Rekap_SIMRS', N'U') IS NULL
BEGIN
    CREATE TABLE [dbo].[Rekap_SIMRS] (
    [keyREKAPSIMRS] BIGINT IDENTITY(1,1) NOT NULL,
    [nomorREKAP] NVARCHAR(20) NOT NULL,
    [nomorBUKTI] NVARCHAR(30) NOT NULL,
    CONSTRAINT [PK_Rekap_SIMRS] PRIMARY KEY CLUSTERED ([keyREKAPSIMRS] ASC),
    CONSTRAINT [UQ_Rekap_SIMRS_nomorBUKTI] UNIQUE NONCLUSTERED ([nomorBUKTI] ASC),
    CONSTRAINT [FK_Rekap_SIMRS_REKAP_PENERIMAAN] FOREIGN KEY ([nomorREKAP]) REFERENCES [dbo].[REKAP_PENERIMAAN] ([noREKAP]) ON DELETE CASCADE,
    CONSTRAINT [FK_Rekap_SIMRS_KAS_SIMRS] FOREIGN KEY ([nomorBUKTI]) REFERENCES [dbo].[KAS_SIMRS] ([noBukti]) ON DELETE CASCADE
    );
END
GO

IF NOT EXISTS (SELECT 1 FROM sys.indexes WHERE object_id = OBJECT_ID(N'dbo.Rekap_SIMRS') AND name = N'idx_Rekap_SIMRS_nomorREKAP')
BEGIN
    CREATE NONCLUSTERED INDEX [idx_Rekap_SIMRS_nomorREKAP] ON [dbo].[Rekap_SIMRS] ([nomorREKAP] ASC);
END
GO

-- Pindahkan hubungan lama dari KAS_SIMRS.keyREKAP
INSERT INTO dbo.Rekap_SIMRS (nomorREKAP, nomorBUKTI)
SELECT r.noREKAP, k.noBukti
FROM dbo.KAS_SIMRS k
JOIN dbo.REKAP_PENERIMAAN r ON r.keyREKAP = k.keyREKAP
WHERE NOT EXISTS (SELECT 1 FROM dbo.Rekap_SIMRS rs WHERE rs.nomorBUKTI = k.noBukti);
GO

-- Isi bukti kas (jenis sama, belum masuk rekap lain) yang tglKAS-nya di jendela cut off tanggal rekap.
-- Jendela [batasAwal, batasAkhir), sama dengan periodeRekap di helpers/integrasi.js:
--   Senin        00.00 Senin        s.d. 14.00 Senin
--   Selasa-Kamis 14.01 hari kemarin s.d. 14.00 hari itu
--   Jumat        14.01 Kamis        s.d. 13.00 Jumat
--   Minggu       13.01 Jumat        s.d. 23.59 Minggu (mencakup Sabtu)
--   Sabtu        tidak ada rekap tersendiri -> tidak menyisipkan apa pun
-- Kompatibel SQL Server 2014: tanpa CREATE OR ALTER (2016 SP1+) / OPENJSON (2016+); buat stub lalu ALTER.
IF OBJECT_ID(N'dbo.sp_RekapSIMRS_Generate', N'P') IS NULL
    EXEC (N'CREATE PROCEDURE dbo.sp_RekapSIMRS_Generate AS RETURN 0;');
GO

ALTER PROCEDURE dbo.sp_RekapSIMRS_Generate
    @noREKAP NVARCHAR(20)
AS
BEGIN
    SET NOCOUNT ON;

    DECLARE @tgl DATE, @jenis VARCHAR(3), @dow INT, @batasAwal DATETIME, @batasAkhir DATETIME;
    SELECT @tgl = tglREKAP, @jenis = jenis FROM dbo.REKAP_PENERIMAAN WHERE noREKAP = @noREKAP;

    -- dow: 0=Senin ... 5=Sabtu, 6=Minggu (1900-01-01 hari Senin, tidak tergantung SET DATEFIRST)
    SET @dow = DATEDIFF(DAY, '19000101', @tgl) % 7;
    SET @batasAwal = CASE @dow
        WHEN 0 THEN CAST(@tgl AS DATETIME)                                          -- Senin: 00.00
        WHEN 6 THEN DATEADD(MINUTE, 781, CAST(DATEADD(DAY, -2, @tgl) AS DATETIME))  -- Minggu: Jumat 13.01
        ELSE        DATEADD(MINUTE, 841, CAST(DATEADD(DAY, -1, @tgl) AS DATETIME))  -- Selasa..Jumat: kemarin 14.01
    END;
    SET @batasAkhir = CASE @dow
        WHEN 4 THEN DATEADD(MINUTE, 781, CAST(@tgl AS DATETIME))                    -- Jumat: s.d. 13.00
        WHEN 5 THEN NULL                                                            -- Sabtu
        WHEN 6 THEN CAST(DATEADD(DAY, 1, @tgl) AS DATETIME)                         -- Minggu: s.d. 23.59
        ELSE        DATEADD(MINUTE, 841, CAST(@tgl AS DATETIME))                    -- Senin..Kamis: s.d. 14.00
    END;

    IF @tgl IS NULL OR @batasAkhir IS NULL
    BEGIN
        SELECT 0 AS jumlah;
        RETURN;
    END

    INSERT INTO dbo.Rekap_SIMRS (nomorREKAP, nomorBUKTI)
    SELECT @noREKAP, k.noBukti
    FROM dbo.KAS_SIMRS k
    WHERE k.jenis = @jenis
      AND k.tglKAS >= @batasAwal AND k.tglKAS < @batasAkhir
      AND NOT EXISTS (SELECT 1 FROM dbo.Rekap_SIMRS rs WHERE rs.nomorBUKTI = k.noBukti);

    SELECT @@ROWCOUNT AS jumlah;
END
GO

-- Tambah bukti manual ke rekap. @daftarBukti = JSON array nomor bukti, mis. ["DX0228042A","DX0228044A"].
-- Bukti yang jenisnya beda atau sudah masuk rekap lain dilewati.
-- Array dipecah manual (tanpa OPENJSON); nilai berisi koma/kurung/kutip memang tidak akan cocok dengan noBukti mana pun.
IF OBJECT_ID(N'dbo.sp_RekapSIMRS_TambahBukti', N'P') IS NULL
    EXEC (N'CREATE PROCEDURE dbo.sp_RekapSIMRS_TambahBukti AS RETURN 0;');
GO

ALTER PROCEDURE dbo.sp_RekapSIMRS_TambahBukti
    @noREKAP NVARCHAR(20),
    @daftarBukti NVARCHAR(MAX)
AS
BEGIN
    SET NOCOUNT ON;

    DECLARE @jenis VARCHAR(3), @statusApi VARCHAR(10);
    SELECT @jenis = jenis, @statusApi = statusApi FROM dbo.REKAP_PENERIMAAN WHERE noREKAP = @noREKAP;

    IF @jenis IS NULL
        THROW 50002, N'Rekap tidak ditemukan', 1;
    IF @statusApi = 'success'
        THROW 50003, N'Rekap yang sudah terkirim tidak dapat diubah', 1;

    DECLARE @bukti TABLE (noBukti NVARCHAR(30));
    DECLARE @sisa NVARCHAR(MAX) = REPLACE(REPLACE(ISNULL(@daftarBukti, N''), N'[', N''), N']', N'');
    DECLARE @pos INT, @item NVARCHAR(MAX);
    WHILE LEN(@sisa) > 0
    BEGIN
        SET @pos = CHARINDEX(N',', @sisa);
        IF @pos = 0 SET @pos = LEN(@sisa) + 1;
        SET @item = LTRIM(RTRIM(REPLACE(LEFT(@sisa, @pos - 1), N'"', N'')));
        SET @sisa = SUBSTRING(@sisa, @pos + 1, LEN(@sisa));
        IF LEN(@item) BETWEEN 1 AND 30
            INSERT INTO @bukti (noBukti) VALUES (@item);
    END

    INSERT INTO dbo.Rekap_SIMRS (nomorREKAP, nomorBUKTI)
    SELECT DISTINCT @noREKAP, k.noBukti
    FROM @bukti j
    JOIN dbo.KAS_SIMRS k ON k.noBukti = j.noBukti
    WHERE k.jenis = @jenis
      AND NOT EXISTS (SELECT 1 FROM dbo.Rekap_SIMRS rs WHERE rs.nomorBUKTI = k.noBukti);

    SELECT @@ROWCOUNT AS jumlah;
END
GO

IF OBJECT_ID(N'dbo.sp_RekapSIMRS_HapusBukti', N'P') IS NULL
    EXEC (N'CREATE PROCEDURE dbo.sp_RekapSIMRS_HapusBukti AS RETURN 0;');
GO

ALTER PROCEDURE dbo.sp_RekapSIMRS_HapusBukti
    @noREKAP NVARCHAR(20),
    @noBukti NVARCHAR(30)
AS
BEGIN
    SET NOCOUNT ON;

    DECLARE @statusApi VARCHAR(10);
    SELECT @statusApi = statusApi FROM dbo.REKAP_PENERIMAAN WHERE noREKAP = @noREKAP;

    IF @statusApi IS NULL
        THROW 50002, N'Rekap tidak ditemukan', 1;
    IF @statusApi = 'success'
        THROW 50003, N'Rekap yang sudah terkirim tidak dapat diubah', 1;

    DELETE FROM dbo.Rekap_SIMRS WHERE nomorREKAP = @noREKAP AND nomorBUKTI = @noBukti;

    SELECT @@ROWCOUNT AS jumlah;
END
GO
