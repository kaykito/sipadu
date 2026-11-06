-- Menu modul Integrasi SIM RS – BLUD + hak akses penuh untuk kelompok admin.
-- Tabel bisnisnya dibuat di migrations/20261025_0003_integrasi_schema.sql.
-- Aman dijalankan ulang: setiap insert dicek dulu.

DECLARE @menu TABLE (kdFITUR NVARCHAR(20), nmFITUR NVARCHAR(100), kdParent NVARCHAR(20), url VARCHAR(255));
INSERT INTO @menu (kdFITUR, nmFITUR, kdParent, url) VALUES
    (N'3',    N'Integrasi SIM RS',           NULL,  '#'),
    (N'3.01', N'Mapping Layanan & RBA',      N'3',  'mappingRba/index'),
    (N'3.02', N'Data Kas SIM RS',            N'3',  'kasSimrs/index'),
    (N'3.03', N'Rekap Transaksi Penerimaan', N'3',  'rekapPenerimaan/index'),
    (N'3.04', N'Berita Acara Penutupan',     N'3',  'beritaAcara/index'),
    (N'3.05', N'Log API & Audit',            N'3',  'logApi/index'),
    (N'3.06', N'Pengaturan Integrasi',       N'3',  'pengaturanIntegrasi/index');

-- Insert berurutan menurut kdFITUR supaya parent selalu sudah ada
DECLARE @kd NVARCHAR(20), @nm NVARCHAR(100), @kdParent NVARCHAR(20), @url VARCHAR(255);
DECLARE menu_cursor CURSOR LOCAL FAST_FORWARD FOR SELECT kdFITUR, nmFITUR, kdParent, url FROM @menu ORDER BY kdFITUR;
OPEN menu_cursor;
FETCH NEXT FROM menu_cursor INTO @kd, @nm, @kdParent, @url;
WHILE @@FETCH_STATUS = 0
BEGIN
    IF NOT EXISTS (SELECT 1 FROM FITUR WHERE kdFITUR = @kd)
        INSERT INTO FITUR (kdFITUR, nmFITUR, parentKeyFITUR, url)
        VALUES (@kd, @nm, (SELECT keyFITUR FROM FITUR WHERE kdFITUR = @kdParent), @url);
    FETCH NEXT FROM menu_cursor INTO @kd, @nm, @kdParent, @url;
END
CLOSE menu_cursor;
DEALLOCATE menu_cursor;
GO

-- Admin mendapat semua aksi di menu integrasi
DECLARE @keyKLP BIGINT = (SELECT TOP 1 keyKLP FROM KELOMPOK WHERE nmKLP = N'admin');

INSERT INTO OTORISASI (keyFITUR, keyKLP, aksi)
SELECT f.keyFITUR, @keyKLP, a.aksi
FROM FITUR f
CROSS JOIN (VALUES (N'view'), (N'add'), (N'edit'), (N'delete'), (N'validasi'), (N'export')) a(aksi)
WHERE @keyKLP IS NOT NULL
  AND (f.kdFITUR = N'3' OR f.kdFITUR LIKE N'3.%')
  AND NOT EXISTS (
    SELECT 1 FROM OTORISASI o
    WHERE o.keyFITUR = f.keyFITUR AND o.keyKLP = @keyKLP AND o.aksi = a.aksi
  );
GO
