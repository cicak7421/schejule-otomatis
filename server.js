require('dotenv').config();
const path = require('path');
const express = require('express');
const cookieSession = require('cookie-session');

const { ensureReady } = require('./db/init');

const { requireAuth } = require('./middleware/auth');
const authRoutes = require('./routes/auth');
const hostRoutes = require('./routes/hosts');
const bagRoutes = require('./routes/bags');
const leaveRoutes = require('./routes/leaves');
const shiftRequestRoutes = require('./routes/shift-requests');
const scheduleRoutes = require('./routes/schedule');

const app = express();
const PORT = process.env.PORT || 3000;

// Wajib di Vercel/reverse proxy lain: tanpa ini, Express nganggep koneksi
// selalu HTTP (req.secure = false) walau browser sebenarnya connect via
// HTTPS. Akibatnya cookie-session dengan `secure: true` gagal di-set diam-
// diam, session kosong, dan requireAuth() bakal terus redirect balik ke
// /login.html walaupun login-nya sukses (looping).
app.set('trust proxy', 1);

app.use(express.json());
app.use(
  cookieSession({
    name: 'session',
    secret: process.env.SESSION_SECRET || 'ganti-secret-ini-di-env',
    maxAge: 1000 * 60 * 60 * 12, // 12 jam
    sameSite: 'lax',
    secure: process.env.NODE_ENV === 'production',
  })
);

// Pastikan schema + seed database sudah siap sebelum request apa pun diproses.
// Memoized di db/init.js, jadi hanya benar-benar jalan sekali per instance.
app.use((req, res, next) => {
  ensureReady()
    .then(() => next())
    .catch(next);
});

// Rute publik (tidak perlu login)
app.use('/api/auth', authRoutes);
// GET publik: dropdown nama host di halaman request libur
app.get('/api/hosts/public', (req, res, next) => {
  req.url = '/';
  hostRoutes.handle(req, res, next);
});
// POST publik: host submit request libur tanpa login
app.post('/api/leaves/request', (req, res, next) => {
  req.url = '/request';
  leaveRoutes.handle(req, res, next);
});
// POST publik: host submit request shift tanpa login
app.post('/api/shift-requests/request', (req, res, next) => {
  req.url = '/request';
  shiftRequestRoutes.handle(req, res, next);
});
// GET publik: bag list dipakai beberapa halaman ringan (opsional, aman ditampilkan)
app.get('/api/bags/public', (req, res, next) => {
  req.url = '/';
  bagRoutes.handle(req, res, next);
});

// Static files publik (login page, request libur page, aset)
app.use(express.static(path.join(__dirname, 'public')));

// Mulai sini semua butuh login
app.use('/api/hosts', requireAuth, hostRoutes);
app.use('/api/bags', requireAuth, bagRoutes);
app.use('/api/leaves', requireAuth, leaveRoutes);
app.use('/api/shift-requests', requireAuth, shiftRequestRoutes);
app.use('/api/schedule', requireAuth, scheduleRoutes);

app.get('/', requireAuth, (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'dashboard.html'));
});

app.use((req, res) => {
  if (req.path.startsWith('/api/')) return res.status(404).json({ error: 'Not found' });
  res.status(404).sendFile(path.join(__dirname, 'public', 'login.html'));
});

// eslint-disable-next-line no-unused-vars
app.use((err, req, res, next) => {
  console.error(err);
  res.status(500).json({ error: 'Terjadi kesalahan di server' });
});

// Hanya jalankan app.listen() saat dijalankan langsung (node server.js / npm start).
// Di Vercel, app di-import sebagai handler oleh api/index.js, jadi tidak perlu listen.
if (require.main === module) {
  app.listen(PORT, () => {
    console.log(`Host Scheduler berjalan di http://localhost:${PORT}`);
  });
}

module.exports = app;
