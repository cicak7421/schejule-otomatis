const express = require('express');
const bcrypt = require('bcryptjs');
const { db } = require('../db/init');

const router = express.Router();

router.post('/login', async (req, res, next) => {
  try {
    const { username, password } = req.body || {};
    if (!username || !password) {
      return res.status(400).json({ error: 'Username dan password wajib diisi' });
    }
    const user = (
      await db.execute({ sql: 'SELECT * FROM users WHERE username = ?', args: [username] })
    ).rows[0];
    if (!user || !bcrypt.compareSync(password, user.password_hash)) {
      return res.status(401).json({ error: 'Username atau password salah' });
    }
    req.session.userId = user.id;
    req.session.username = user.username;
    req.session.role = user.role;
    res.json({ ok: true, user: { username: user.username, role: user.role, full_name: user.full_name } });
  } catch (err) {
    next(err);
  }
});

router.post('/logout', (req, res) => {
  req.session = null; // cookie-session: cara resmi untuk hapus sesi
  res.json({ ok: true });
});

router.get('/me', (req, res) => {
  if (!req.session || !req.session.userId) return res.status(401).json({ error: 'Belum login' });
  res.json({ username: req.session.username, role: req.session.role });
});

module.exports = router;
