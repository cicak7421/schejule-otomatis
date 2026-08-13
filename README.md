# Host Scheduler — Jadwal Host Live Otomatis

Website untuk menggantikan proses manual pembuatan jadwal mingguan host live.
Sistem ini bisa menganalisa histori jadwal, menghindari host "jumping" shift,
menerima request libur dari host, dan membuat jadwal otomatis dengan bantuan AI (Groq).

## Fitur

- **Multi-lokasi (Jakarta & Tangerang)** — dua tempat live yang benar-benar terpisah. Host dan bag
  dari satu lokasi tidak pernah bisa dijadwalkan/ditukar ke lokasi lain (dijaga di level backend,
  bukan cuma tampilan). Pilih lokasi lewat tab 📍 di menu Jadwal, Host/Staff, dan Bag/Akun.
  Packing saat ini baru ada di Jakarta (Tangerang belum) — tinggal tambah host dept "Packing" +
  lokasi "Tangerang" kapan saja lewat menu Host/Staff kalau sudah mulai jalan di sana.
- **Login HR/Admin** dengan password.
- **Kelola Host** — tambah/nonaktifkan host kapan saja.
- **Kelola Bag/Akun** — HR bebas menambah akun live baru sewaktu-waktu.
- **Request Libur** — host isi form publik (`/request-libur.html`, tanpa login) untuk minta libur;
  HR menyetujui/menolak lewat dashboard. Kalau disetujui, slot jadwal yang belum dikunci otomatis dikosongkan.
- **Generate Jadwal Otomatis**
  - Mode **Rule-based**: algoritma greedy yang menjamin semua aturan keras terpenuhi meski AI mati.
  - Mode **AI (Groq)**: AI menganalisa histori jadwal 2 minggu terakhir lalu mengusulkan rotasi yang lebih
    adil dan natural. Setiap usulan AI tetap divalidasi ulang oleh aturan keras sebelum disimpan —
    AI tidak pernah bisa melanggar aturan.
  - Aturan keras yang selalu dijaga:
    1. Host **tidak boleh** dapat shift Siang (S) lalu besoknya shift Pagi (P), lintas bag.
    2. Host **boleh** dijadwalkan di 2 bag berbeda pada hari yang sama (shift berbeda).
    3. Host **tidak boleh** dobel di shift & tanggal yang sama persis di bag berbeda (bentrok waktu).
    4. Host yang sedang cuti disetujui tidak akan dijadwalkan.
- **Override manual** — HR bisa ganti host langsung dari dropdown di tabel jadwal; slot yang diubah manual
  otomatis terkunci (🔒) supaya tidak ditimpa saat generate ulang. Klik ikon kunci untuk membuka lagi.
- **Router 5 API key Groq** — kalau satu key kena rate-limit / error, sistem otomatis pindah ke key berikutnya.

## Instalasi (Lokal)

Butuh Node.js 18+.

```bash
cd host-scheduler
npm install
cp .env.example .env
# edit .env: isi minimal 1 GROQ_API_KEY_x, ganti SESSION_SECRET & ADMIN_PASSWORD
npm start
```

Buka `http://localhost:3000`. Login pertama pakai `ADMIN_USERNAME` / `ADMIN_PASSWORD` di `.env`
(default `admin` / `admin123` — **segera ganti**).

Kalau `TURSO_DATABASE_URL` di `.env` dikosongkan, database otomatis pakai file lokal (`data.sqlite`)
— cocok buat coba-coba di komputer sendiri. Untuk deploy (lihat bagian bawah), wajib pakai Turso.

Database dibuat otomatis saat pertama kali jalan, sudah terisi data awal:
- **Tangerang**: Bag OKE OKE BAG, LARIS BAG. Host: Ayu, Yuni, Sulis, Izmi, Sarah.
- **Jakarta**: Bag BAGUS BAG, CERIA BAG, Tim Packing Jakarta. Host live: Via, Windari, Icha, Syifa,
  Melvi, Wilda, Vina. Host packing: Naufal, Akbar, Ridho.
- Histori jadwal Jakarta 10–16 Agt 2026 (dari jadwal manual HR) diinput langsung sebagai bahan
  belajar AI & histori resmi (locked, tidak akan ketimpa generate ulang).

Kamu bisa langsung tambah/edit host & bag lain lewat dashboard.

## Cara Dapat API Key Groq

1. Buka https://console.groq.com/keys
2. Bikin sampai 5 API key (bisa pakai beberapa akun kalau mau kuota lebih besar)
3. Isi ke `.env`: `GROQ_API_KEY_1`, `GROQ_API_KEY_2`, dst. Minimal isi 1, sisanya boleh kosong.

## Deploy ke Vercel

Vercel itu serverless — filesystem-nya **tidak persisten** (tiap request bisa kena instance
berbeda dan berubah-ubah), jadi project ini pakai [Turso](https://turso.tech) (database SQLite
yang jalan di remote/edge) untuk penyimpanan data, dan cookie-based session (bukan in-memory)
supaya login tetap konsisten di serverless.

### 1. Siapkan database Turso (gratis)
```bash
# install CLI turso (lihat https://docs.turso.tech/cli/installation)
turso auth signup          # atau: turso auth login
turso db create host-scheduler
turso db show host-scheduler --url        # -> salin jadi TURSO_DATABASE_URL
turso db tokens create host-scheduler      # -> salin jadi TURSO_AUTH_TOKEN
```

### 2. Push ke GitHub, lalu import ke Vercel
1. Push folder project ini ke repo GitHub.
2. Di [vercel.com](https://vercel.com) → **Add New Project** → import repo tsb.
3. Vercel otomatis mendeteksi `vercel.json` + folder `api/` — tidak perlu ubah build settings.
4. Di tab **Environment Variables**, isi:
   - `TURSO_DATABASE_URL`, `TURSO_AUTH_TOKEN` (dari langkah 1)
   - `SESSION_SECRET` — string acak yang panjang
   - `ADMIN_USERNAME`, `ADMIN_PASSWORD` — akun HR pertama
   - `GROQ_API_KEY_1` (minimal 1, sampai `GROQ_API_KEY_5`)
   - `NODE_ENV` = `production`
5. Klik **Deploy**. Setelah selesai, buka domain `*.vercel.app` yang diberikan — schema tabel &
   data awal (bag/host/histori) otomatis dibuat saat request pertama masuk.

### Deploy ulang / update kode
Push ke branch yang di-connect ke Vercel → otomatis re-deploy. Data di Turso **tidak ikut hilang**
karena terpisah dari deployment (beda dengan `data.sqlite` versi lama).

### VPS sendiri (alternatif, kalau tidak mau pakai Vercel/Turso)
Karena `TURSO_DATABASE_URL` opsional, project ini tetap bisa jalan dengan file SQLite lokal biasa
di VPS — cukup jangan isi `TURSO_DATABASE_URL` di `.env`-nya.
```bash
git clone <repo-kamu>
cd host-scheduler
npm install --production
cp .env.example .env   # isi env
npm install -g pm2
pm2 start server.js --name host-scheduler
pm2 save
pm2 startup   # supaya auto-start kalau server reboot
```
Pasang Nginx sebagai reverse proxy + SSL (Let's Encrypt/certbot) kalau mau akses via domain dengan HTTPS.

## Struktur Folder

```
host-scheduler/
  server.js            Express app (di-export, tidak listen() saat di Vercel)
  api/index.js         entry point serverless function untuk Vercel
  vercel.json           konfigurasi routing Vercel
  db/
    schema.sql         struktur tabel
    init.js            init schema + seed data awal (async, via lib/db.js)
  lib/
    db.js              koneksi libSQL (Turso, fallback file lokal)
    scheduler.js        mesin generate jadwal (rule-based + AI)
    groqRouter.js        multi-key router ke Groq API
  routes/               API endpoints (auth, hosts, bags, leaves, schedule)
  middleware/auth.js     proteksi login
  public/                frontend (HTML/CSS/JS polos, tanpa build step)
```

## Backup Data

- **Pakai Turso**: `turso db shell host-scheduler ".dump" > backup.sql`, atau lihat
  [dokumentasi backup Turso](https://docs.turso.tech).
- **Pakai file lokal** (VPS/dev): backup cukup salin file `data.sqlite` (dan `data.sqlite-wal` / `-shm` kalau ada).

## Catatan Keamanan

- Ganti `ADMIN_PASSWORD` dan `SESSION_SECRET` di `.env` sebelum dipakai serius.
- Kalau mau tambah user HR lain, saat ini paling gampang lewat SQL langsung ke tabel `users`
  (bisa ditambahkan halaman manajemen user kalau dibutuhkan ke depannya).
