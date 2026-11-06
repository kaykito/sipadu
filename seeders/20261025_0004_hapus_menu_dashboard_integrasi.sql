-- Dashboard integrasi dipindah ke modul home. Hapus menu lama 'dashboardIntegrasi/index'
-- (dan hak aksesnya) yang sempat terbuat oleh seed menu integrasi versi awal.

DECLARE @keyFITUR BIGINT = (SELECT TOP 1 keyFITUR FROM FITUR WHERE url = 'dashboardIntegrasi/index');

IF @keyFITUR IS NOT NULL
BEGIN
    DELETE FROM OTORISASI WHERE keyFITUR = @keyFITUR;
    DELETE FROM FITUR WHERE keyFITUR = @keyFITUR;
END
GO
