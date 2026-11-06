-- Kolom pendukung sinkronisasi dari API SIM RS (KasBlud):
--   KAS_SIMRS_DETAIL.kasBludId  -> id baris dari SIM RS, unik, dipakai supaya sinkron ulang tidak dobel
--   KAS_SIMRS.syncedAt          -> waktu terakhir bukti ditarik dari SIM RS

IF COL_LENGTH(N'dbo.KAS_SIMRS_DETAIL', N'kasBludId') IS NULL
    ALTER TABLE [dbo].[KAS_SIMRS_DETAIL] ADD [kasBludId] NVARCHAR(30) NULL;
GO

IF NOT EXISTS (SELECT 1 FROM sys.indexes WHERE object_id = OBJECT_ID(N'dbo.KAS_SIMRS_DETAIL') AND name = N'UX_KAS_SIMRS_DETAIL_kasBludId')
    CREATE UNIQUE NONCLUSTERED INDEX [UX_KAS_SIMRS_DETAIL_kasBludId]
    ON [dbo].[KAS_SIMRS_DETAIL] ([kasBludId] ASC)
    WHERE [kasBludId] IS NOT NULL;
GO

IF COL_LENGTH(N'dbo.KAS_SIMRS', N'syncedAt') IS NULL
    ALTER TABLE [dbo].[KAS_SIMRS] ADD [syncedAt] DATETIME NULL;
GO
