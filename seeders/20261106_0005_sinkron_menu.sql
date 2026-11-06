-- Sinkronkan menu (FITUR), kelompok (KELOMPOK), dan hak akses (OTORISASI) dengan susunan
-- database development per 2026-11-06. Menimpa susunan dari seeder 0001/0002 sebelumnya:
--   - menu 'Contoh' dan induk 'Integrasi SIM RS' dihapus; menu integrasi jadi menu utama (3.02-3.06)
--   - 'Berita Acara Penutupan' -> 'Penutupan Kas Harian'
--   - 'Pengaturan Integrasi' pindah ke Setting (9.00)
-- Aman di database baru (setelah 0001/0002) maupun yang sudah pernah di-seed: menu dicocokkan lewat kdFITUR,
-- hak akses lama pada menu yang tetap ada tidak dihapus. Kompatibel SQL Server 2014.
-- Perbandingan tabel vs tabel variabel memakai COLLATE DATABASE_DEFAULT di kedua sisi: collation tempdb,
-- database, dan kolom tabel bisa berbeda-beda (di DB development kolomnya SQL_Latin1_General_CP1_CI_AS).
SET XACT_ABORT ON;
SET NOCOUNT ON;
BEGIN TRAN;

-- 1. Kelompok
DECLARE @klp TABLE (nmKLP NVARCHAR(50) COLLATE DATABASE_DEFAULT, ketKLP NVARCHAR(255) COLLATE DATABASE_DEFAULT);
INSERT INTO @klp (nmKLP, ketKLP) VALUES
    (N'Admin',     N'Kelompok administrator'),
    (N'Operator',  N'Kelompok operator'),
    (N'Keuangan',  N'Bagian Akuntansi'),
    (N'Developer', N'Hidden');

INSERT INTO KELOMPOK (nmKLP, ketKLP)
SELECT k.nmKLP, k.ketKLP FROM @klp k
WHERE NOT EXISTS (SELECT 1 FROM KELOMPOK x WHERE x.nmKLP COLLATE DATABASE_DEFAULT = k.nmKLP);

-- 2. Menu. url tanpa slash di depan (sidebar merender href="/<url>").
DECLARE @menu TABLE (kdFITUR NVARCHAR(20) COLLATE DATABASE_DEFAULT PRIMARY KEY, nmFITUR NVARCHAR(100) COLLATE DATABASE_DEFAULT, kdParent NVARCHAR(20) COLLATE DATABASE_DEFAULT, url VARCHAR(255) COLLATE DATABASE_DEFAULT);
INSERT INTO @menu (kdFITUR, nmFITUR, kdParent, url) VALUES
    (N'1',       N'Dashboard',                  NULL,    'home'),
    (N'3.02',    N'Mapping Layanan & RBA',      NULL,    'mappingRba/index'),
    (N'3.03',    N'Data Kas SIM RS',            NULL,    'kasSimrs/index'),
    (N'3.04',    N'Rekap Transaksi Penerimaan', NULL,    'rekapPenerimaan/index'),
    (N'3.05',    N'Penutupan Kas Harian',       NULL,    'beritaAcara/index'),
    (N'3.06',    N'Log API & Audit',            NULL,    'logApi/index'),
    (N'9',       N'Setting',                    NULL,    '#'),
    (N'9.00',    N'Pengaturan Integrasi',       N'9',    'pengaturanIntegrasi/index'),
    (N'9.01',    N'Data User',                  N'9',    '#'),
    (N'9.01.01', N'Kelompok',                   N'9.01', 'kelompok/index'),
    (N'9.01.02', N'Hak Akses',                  N'9.01', 'otorisasi/index'),
    (N'9.01.03', N'User Aplikasi',              N'9.01', 'user/index'),
    (N'9.02',    N'Developer',                  N'9',    '#'),
    (N'9.02.01', N'Fitur Menu',                 N'9.02', 'fitur/index'),
    (N'9.02.02', N'Generate Module',            N'9.02', 'generateModule/index');

-- Menu yang tidak ada di daftar dihapus beserta hak aksesnya
DELETE o FROM OTORISASI o
JOIN FITUR f ON f.keyFITUR = o.keyFITUR
WHERE NOT EXISTS (SELECT 1 FROM @menu m WHERE m.kdFITUR = f.kdFITUR COLLATE DATABASE_DEFAULT);

DELETE f FROM FITUR f
WHERE NOT EXISTS (SELECT 1 FROM @menu m WHERE m.kdFITUR = f.kdFITUR COLLATE DATABASE_DEFAULT);

-- Hak akses yatim (menunjuk menu/kelompok yang sudah tidak ada)
DELETE o FROM OTORISASI o
WHERE NOT EXISTS (SELECT 1 FROM FITUR f WHERE f.keyFITUR = o.keyFITUR)
   OR NOT EXISTS (SELECT 1 FROM KELOMPOK k WHERE k.keyKLP = o.keyKLP);

-- Tambah menu baru dulu (tanpa parent), lalu samakan nama/url/parent semua menu
INSERT INTO FITUR (kdFITUR, nmFITUR, parentKeyFITUR, url)
SELECT m.kdFITUR, m.nmFITUR, NULL, m.url FROM @menu m
WHERE NOT EXISTS (SELECT 1 FROM FITUR f WHERE f.kdFITUR COLLATE DATABASE_DEFAULT = m.kdFITUR);

UPDATE f SET
    nmFITUR = m.nmFITUR,
    url = m.url,
    parentKeyFITUR = (SELECT p.keyFITUR FROM FITUR p WHERE p.kdFITUR COLLATE DATABASE_DEFAULT = m.kdParent)
FROM FITUR f
JOIN @menu m ON m.kdFITUR = f.kdFITUR COLLATE DATABASE_DEFAULT;

-- 3. Hak akses: Admin semua aksi di semua menu; Operator semua aksi di Dashboard
DECLARE @aksi TABLE (aksi NVARCHAR(20) COLLATE DATABASE_DEFAULT);
INSERT INTO @aksi (aksi) VALUES (N'view'), (N'add'), (N'edit'), (N'delete'), (N'validasi'), (N'export');

DECLARE @oto TABLE (nmKLP NVARCHAR(50) COLLATE DATABASE_DEFAULT, kdFITUR NVARCHAR(20) COLLATE DATABASE_DEFAULT);
INSERT INTO @oto (nmKLP, kdFITUR) SELECT N'Admin', kdFITUR FROM @menu;
INSERT INTO @oto (nmKLP, kdFITUR) VALUES (N'Operator', N'1');

INSERT INTO OTORISASI (keyFITUR, keyKLP, aksi)
SELECT f.keyFITUR, k.keyKLP, a.aksi
FROM @oto t
JOIN FITUR f ON f.kdFITUR COLLATE DATABASE_DEFAULT = t.kdFITUR
JOIN KELOMPOK k ON k.keyKLP = (SELECT TOP 1 keyKLP FROM KELOMPOK WHERE nmKLP COLLATE DATABASE_DEFAULT = t.nmKLP ORDER BY keyKLP)
CROSS JOIN @aksi a
WHERE NOT EXISTS (
    SELECT 1 FROM OTORISASI o
    WHERE o.keyFITUR = f.keyFITUR AND o.keyKLP = k.keyKLP AND o.aksi COLLATE DATABASE_DEFAULT = a.aksi
);

COMMIT;
