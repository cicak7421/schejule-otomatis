const path = require('path');
const { createClient } = require('@libsql/client');

/**
 * Koneksi database.
 * - Production (Vercel): set TURSO_DATABASE_URL + TURSO_AUTH_TOKEN -> koneksi remote
 *   ke Turso lewat protokol libSQL (aman untuk serverless, tidak butuh native binding,
 *   dan datanya persisten antar-invocation/deploy).
 * - Dev lokal tanpa TURSO_DATABASE_URL: fallback ke file SQLite lokal (data.sqlite)
 *   supaya bisa langsung coba tanpa bikin akun Turso dulu.
 */
let client;
function getDb() {
  if (client) return client;

  const url = process.env.TURSO_DATABASE_URL || `file:${path.join(__dirname, '..', 'data.sqlite')}`;
  const authToken = process.env.TURSO_AUTH_TOKEN || undefined;

  if (!process.env.TURSO_DATABASE_URL && process.env.VERCEL) {
    console.warn(
      '[db] PERINGATAN: TURSO_DATABASE_URL belum di-set. Di Vercel, database file lokal TIDAK akan tersimpan permanen!'
    );
  }

  client = createClient({ url, authToken });
  return client;
}

module.exports = { getDb };
