-- Data awal: kelompok admin, user admin, struktur menu, dan hak akses penuh untuk admin.
-- Login default: admin / admin123  (SEGERA ganti password lewat menu Profil Saya).
-- Aman dijalankan ulang: setiap insert dicek dulu.

IF NOT EXISTS (SELECT 1 FROM KELOMPOK WHERE nmKLP = N'admin')
    INSERT INTO KELOMPOK (nmKLP, ketKLP) VALUES (N'admin', N'Administrator aplikasi');
GO

DECLARE @keyKLP BIGINT = (SELECT TOP 1 keyKLP FROM KELOMPOK WHERE nmKLP = N'admin');

IF NOT EXISTS (SELECT 1 FROM APPUSER WHERE userID = N'admin')
    INSERT INTO APPUSER (userID, PWD, keyKLP, nmUSER, ketUSER, statusUSER)
    VALUES (N'admin', N'$2b$10$ng97bXrkqCTHSrcC9IbXoOO.sU.vNSRMx0rwIG58OwajrkwAAFjlC', @keyKLP, N'Administrator', NULL, 1);
GO

-- Menu. url ditulis tanpa slash di depan (sidebar merender href="/<url>").
DECLARE @menu TABLE (kdFITUR NVARCHAR(20), nmFITUR NVARCHAR(100), kdParent NVARCHAR(20), url VARCHAR(255));
INSERT INTO @menu (kdFITUR, nmFITUR, kdParent, url) VALUES
    (N'1',       N'Dashboard',       NULL,    'home'),
    (N'2',       N'Contoh',          NULL,    'contoh/index'),
    (N'9',       N'Setting',         NULL,    '#'),
    (N'9.01',    N'Data User',       N'9',    '#'),
    (N'9.01.01', N'Kelompok',        N'9.01', 'kelompok/index'),
    (N'9.01.02', N'Hak Akses',       N'9.01', 'otorisasi/index'),
    (N'9.01.03', N'User Aplikasi',   N'9.01', 'user/index'),
    (N'9.02',    N'Developer',       N'9',    '#'),
    (N'9.02.01', N'Fitur Menu',      N'9.02', 'fitur/index'),
    (N'9.02.02', N'Generate Module', N'9.02', 'generateModule/index');

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

-- Admin mendapat semua aksi di semua menu
DECLARE @keyKLP BIGINT = (SELECT TOP 1 keyKLP FROM KELOMPOK WHERE nmKLP = N'admin');

INSERT INTO OTORISASI (keyFITUR, keyKLP, aksi)
SELECT f.keyFITUR, @keyKLP, a.aksi
FROM FITUR f
CROSS JOIN (VALUES (N'view'), (N'add'), (N'edit'), (N'delete'), (N'validasi'), (N'export')) a(aksi)
WHERE NOT EXISTS (
    SELECT 1 FROM OTORISASI o
    WHERE o.keyFITUR = f.keyFITUR AND o.keyKLP = @keyKLP AND o.aksi = a.aksi
);
GO
