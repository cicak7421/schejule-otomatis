function requireAuth(req, res, next) {
  if (req.session && req.session.userId) return next();
  if (req.originalUrl.startsWith('/api/')) {
    return res.status(401).json({ error: 'Belum login' });
  }
  return res.redirect('/login.html');
}

module.exports = { requireAuth };
