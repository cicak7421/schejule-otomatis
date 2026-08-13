// Entry point untuk Vercel serverless function.
// Vercel akan mem-build folder /api sebagai function; file ini cukup
// mengekspor Express app dari server.js (app tidak app.listen() di sini).
module.exports = require('../server.js');
