# Express MSSQL Boilerplate

Kerangka aplikasi web server-rendered dengan Node.js/Express dan SQL Server. Sudah berisi login, satu sesi aktif per perangkat, menu dan hak akses berbasis database, serta generator modul CRUD.

Diturunkan dari inti aplikasi Gov-Fina BLUD. Semua modul bisnisnya sudah dibuang.

## Isi

| Bagian | Keterangan |
|---|---|
| Login | Password bcrypt; Cloudflare Turnstile opsional |
| Single-session | Login baru menutup sesi lama. Daftar perangkat ada di tabel `USER_DEVICES` |
| Menu & hak akses | Menu diambil dari tabel `FITUR`. Hak akses per kelompok dan per aksi (`view/add/edit/delete/validasi/export`) diambil dari tabel `OTORISASI` |
| Dispatch dinamis | URL `/:module/:action/:id` langsung memanggil `modules/<module>/controllers/<module>.js` → `exports[action]` |
| Modul bawaan | `home`, `user`, `userProfile`, `kelompok`, `fitur`, `otorisasi`, `generateModule`, `contoh` |
| UI | Template Sneat (Bootstrap 5), DataTables, Select2, SweetAlert2 |

## Persiapan

```bash
npm install
cp .env.example .env        # isi DB_*, SESSION_SECRET, dll.
npm run db:migrate          # buat tabel inti + data awal
npm run dev                 # http://localhost:2301
```

Login awal: **admin / admin123**. Segera ganti password lewat menu *Profil Saya → Keamanan*.

Tabel `Sessions` (penyimpanan sesi) dibuat otomatis saat aplikasi pertama kali jalan.

## Perintah

| Perintah | Fungsi |
|---|---|
| `npm run dev` | Jalankan dengan nodemon |
| `npm start` | Jalankan untuk production |
| `npm run build` | Cek sintaks semua file JS server (`node --check`) |
| `npm run db:migrate` | Jalankan file `migrations/*.sql` yang belum pernah dijalankan (dicatat di tabel `SchemaMigrations`) |
| `npm run db:migrate:baseline` | Tandai semua migration sebagai sudah dijalankan tanpa mengeksekusinya |
| `npm run generate:tables:db` | Dump `CREATE TABLE` dari database aktif ke `migrations/tables/` |

## Struktur

```
app.js                 middleware: rate limit, session, menu dari FITUR/OTORISASI, override res.render
router.js              route login + dispatch dinamis /:module/:action/:id
auth.js                check_login, check_session_valid (single-session)
database.js            pool mssql (data) + Sequelize (session store)
helpers/accessControl  checkAccess(req, aksi)
middleware/            Turnstile, reset session saat pindah menu
migrations/*.sql       migration berurutan menurut nama file
modules/<nama>/
  controllers/<nama>.js
  views/*.html         template EJS
views/                 layout (header, sidebar, footer), login, error
```

## Menambah modul baru

1. Tulis tabelnya di file migration baru, misalnya `migrations/20261101_0001_produk.sql`, lalu jalankan `npm run db:migrate`.
2. Buat modulnya dengan salah satu cara:
   - **Generator**: buka *Setting → Developer → Generate Module*, pilih tabel, lalu isi nama modul. Generator hanya aktif saat `NODE_ENV` bukan `production`.
   - **Manual**: salin `modules/contoh/` dan ganti nama tabel serta kolomnya. Nama folder harus sama dengan nama file controller dan segmen URL.
3. Daftarkan menu di *Setting → Developer → Fitur Menu*. Isi URL tanpa slash di depan, misalnya `produk/index`.
4. Beri hak akses lewat *Setting → Data User → Hak Akses*.

Aturan dispatch di `router.js`:

- Nama action harus cocok dengan salah satu aturan izin:
  - ada di `EXACT_DYNAMIC_ACTIONS`, atau
  - diawali salah satu prefix di `DYNAMIC_ACTION_PREFIXES` (`get`, `save`, `insert`, `update`, `delete`, `data`, `detail`, ...).
- Nama action **tidak boleh** ada di `DENIED_DYNAMIC_ACTIONS`.
- Action yang tidak lolos aturan di atas menghasilkan 404, walaupun fungsinya ada di controller.

Setiap action wajib memanggil `checkAccess(req, '<aksi>')`. Router hanya memastikan user sudah login, tidak mengecek hak akses.

## Branding

Ganti file berikut dengan logo dan gambar Anda sendiri:

- `public/logo.png` (halaman login)
- `public/logo1.png` (favicon dan sidebar saat diciutkan)
- `public/logo2.png` (sidebar)
- `public/background.png` (sampul halaman login)

Nama aplikasi diambil dari `APP_NAME` di `.env`.
