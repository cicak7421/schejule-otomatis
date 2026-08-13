const path = require('path');
const fs = require('fs');
const bcrypt = require('bcryptjs');
const { getDb } = require('../lib/db');

const db = getDb();

// Tambah kolom baru dengan aman ke database yang sudah ada (Turso/production)
// tanpa menghapus data lama. SQLite tidak punya "ADD COLUMN IF NOT EXISTS",
// jadi errornya (duplicate column) sengaja diabaikan.
async function safeAlter(sql) {
  try {
    await db.execute(sql);
  } catch (err) {
    if (!/duplicate column/i.test(err.message)) throw err;
  }
}

// Longgarkan constraint shift lama (P/S/M saja) supaya menerima 'MID' (shift
// tengah untuk Packing), dengan cara rebuild tabel + copy data kalau perlu.
async function migrateShiftCheck() {
  const row = (
    await db.execute("SELECT sql FROM sqlite_master WHERE type='table' AND name='schedule_entries'")
  ).rows[0];
  if (!row || !row.sql || row.sql.includes('MID')) return; // sudah termigrasi / belum ada tabel

  await db.execute('ALTER TABLE schedule_entries RENAME TO schedule_entries_old');
  await db.execute(`CREATE TABLE schedule_entries (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    date TEXT NOT NULL,
    bag_id INTEGER NOT NULL REFERENCES bags(id) ON DELETE CASCADE,
    shift TEXT NOT NULL CHECK (shift IN ('P','S','M','MID')),
    host_id INTEGER REFERENCES hosts(id) ON DELETE SET NULL,
    source TEXT NOT NULL DEFAULT 'manual',
    locked INTEGER NOT NULL DEFAULT 0,
    created_at TEXT DEFAULT (datetime('now')),
    UNIQUE(date, bag_id, shift)
  )`);
  await db.execute(`INSERT INTO schedule_entries (id, date, bag_id, shift, host_id, source, locked, created_at)
    SELECT id, date, bag_id, shift, host_id, source, locked, created_at FROM schedule_entries_old`);
  await db.execute('DROP TABLE schedule_entries_old');
  console.log('[migrate] schedule_entries.shift constraint diperluas untuk mendukung MID (Packing)');
}

async function migrate() {
  await safeAlter("ALTER TABLE hosts ADD COLUMN department TEXT NOT NULL DEFAULT 'host_live'");
  await safeAlter("ALTER TABLE bags ADD COLUMN department TEXT NOT NULL DEFAULT 'host_live'");
  // Kolom lokasi baru. Data lama (sebelum ada Jakarta) otomatis kebagian
  // default 'tangerang' -- itu memang lokasi asal sistem ini sebelum Jakarta
  // ditambahkan, jadi tidak perlu migrasi data manual lebih lanjut.
  await safeAlter("ALTER TABLE hosts ADD COLUMN location TEXT NOT NULL DEFAULT 'tangerang'");
  await safeAlter("ALTER TABLE bags ADD COLUMN location TEXT NOT NULL DEFAULT 'tangerang'");
  await migrateShiftCheck();
  await db.execute('CREATE INDEX IF NOT EXISTS idx_schedule_date ON schedule_entries(date)');
  await db.execute('CREATE INDEX IF NOT EXISTS idx_schedule_host ON schedule_entries(host_id)');
}

async function seed() {
  const adminUser = process.env.ADMIN_USERNAME || 'admin';
  const adminPass = process.env.ADMIN_PASSWORD || 'admin123';

  const hasUser = (await db.execute('SELECT COUNT(*) c FROM users')).rows[0].c;
  if (!hasUser) {
    const hash = bcrypt.hashSync(adminPass, 10);
    await db.execute({
      sql: 'INSERT INTO users (username, password_hash, full_name, role) VALUES (?, ?, ?, ?)',
      args: [adminUser, hash, 'HR Admin', 'admin'],
    });
    console.log(`[seed] User admin dibuat -> username: ${adminUser} / password: ${adminPass} (SEGERA GANTI!)`);
  }

  const bagCount = (await db.execute('SELECT COUNT(*) c FROM bags')).rows[0].c;
  if (!bagCount) {
    await db.batch(
      [
        { sql: 'INSERT INTO bags (name, sort_order, department) VALUES (?, ?, ?)', args: ['OKE OKE BAG', 1, 'host_live'] },
        { sql: 'INSERT INTO bags (name, sort_order, department) VALUES (?, ?, ?)', args: ['LARIS BAG', 2, 'host_live'] },
      ],
      'write'
    );
    console.log('[seed] Bag awal dibuat: OKE OKE BAG, LARIS BAG');
  }

  // "Bag virtual" untuk tim Packing & Admin (bukan akun live, cuma wadah
  // supaya jadwal packing/admin bisa dipakai lewat mesin scheduler yang sama).
  const packingBag = (await db.execute("SELECT id FROM bags WHERE department = 'packing'")).rows[0];
  if (!packingBag) {
    await db.execute({
      sql: 'INSERT INTO bags (name, sort_order, department) VALUES (?, ?, ?)',
      args: ['Tim Packing', 10, 'packing'],
    });
    console.log('[seed] Bag virtual dibuat: Tim Packing');
  }
  const adminBag = (await db.execute("SELECT id FROM bags WHERE department = 'admin'")).rows[0];
  if (!adminBag) {
    await db.execute({
      sql: 'INSERT INTO bags (name, sort_order, department) VALUES (?, ?, ?)',
      args: ['Tim Admin', 20, 'admin'],
    });
    console.log('[seed] Bag virtual dibuat: Tim Admin');
  }

  const hostCount = (await db.execute('SELECT COUNT(*) c FROM hosts')).rows[0].c;
  if (!hostCount) {
    await db.batch(
      ['Ayu', 'Yuni', 'Sulis', 'Izmi', 'Sarah'].map((n) => ({
        sql: "INSERT INTO hosts (name, department) VALUES (?, 'host_live')",
        args: [n],
      })),
      'write'
    );
    console.log('[seed] Host awal dibuat: Ayu, Yuni, Sulis, Izmi, Sarah');
  }

  // ===================== LOKASI JAKARTA =====================
  // Jakarta ditambahkan sebagai lokasi live kedua (terpisah total dari
  // Tangerang -- host/bag tidak pernah tertukar antar lokasi, dijaga di
  // level query lewat kolom `location`). Data awal diisi dari jadwal manual
  // Jakarta minggu 10-16 Agt 2026 (screenshot HR), sekaligus jadi histori
  // bahan belajar AI untuk generate minggu berikutnya.
  const jakartaBagCheck = (
    await db.execute("SELECT id FROM bags WHERE name = 'BAGUS BAG'")
  ).rows[0];
  if (!jakartaBagCheck) {
    await db.batch(
      [
        { sql: 'INSERT INTO bags (name, sort_order, department, location) VALUES (?, ?, ?, ?)', args: ['BAGUS BAG', 1, 'host_live', 'jakarta'] },
        { sql: 'INSERT INTO bags (name, sort_order, department, location) VALUES (?, ?, ?, ?)', args: ['CERIA BAG', 2, 'host_live', 'jakarta'] },
        { sql: 'INSERT INTO bags (name, sort_order, department, location) VALUES (?, ?, ?, ?)', args: ['Tim Packing Jakarta', 10, 'packing', 'jakarta'] },
      ],
      'write'
    );
    console.log('[seed] Bag Jakarta dibuat: BAGUS BAG, CERIA BAG, Tim Packing Jakarta');
  }

  const jakartaHostCheck = (
    await db.execute("SELECT id FROM hosts WHERE name = 'Syifa'")
  ).rows[0];
  if (!jakartaHostCheck) {
    await db.batch(
      [
        ...['Via', 'Windari', 'Icha', 'Syifa', 'Melvi', 'Wilda', 'Vina'].map((n) => ({
          sql: "INSERT INTO hosts (name, department, location) VALUES (?, 'host_live', 'jakarta')",
          args: [n],
        })),
        ...['Naufal', 'Akbar', 'Ridho'].map((n) => ({
          sql: "INSERT INTO hosts (name, department, location) VALUES (?, 'packing', 'jakarta')",
          args: [n],
        })),
      ],
      'write'
    );
    console.log('[seed] Host Jakarta dibuat: Via, Windari, Icha, Syifa (Bagus Bag/Ceria Bag) & Naufal, Akbar, Ridho (Packing)');
  }

  // Histori jadwal Jakarta 10-16 Agt 2026, hasil input dari jadwal manual HR.
  // Disimpan locked=1 (source='manual') supaya tidak pernah ditimpa saat
  // generate ulang -- ini data histori asli, bukan hasil generator.
  const jakartaScheduleCheck = (
    await db.execute("SELECT id FROM schedule_entries WHERE date = '2026-08-10' LIMIT 1")
  ).rows[0];
  if (!jakartaBagCheck && !jakartaScheduleCheck) {
    const bagRow = async (name) => (await db.execute({ sql: 'SELECT id FROM bags WHERE name = ?', args: [name] })).rows[0].id;
    const hostRow = async (name) => (await db.execute({ sql: 'SELECT id FROM hosts WHERE name = ?', args: [name] })).rows[0].id;

    const bagusId = await bagRow('BAGUS BAG');
    const ceriaId = await bagRow('CERIA BAG');
    const packingId = await bagRow('Tim Packing Jakarta');

    const H = {};
    for (const n of ['Via', 'Windari', 'Icha', 'Syifa', 'Melvi', 'Wilda', 'Vina', 'Naufal', 'Akbar', 'Ridho']) {
      H[n] = await hostRow(n);
    }

    // { date: { P, S, M } }  (null = KOSONG)
    const bagusSchedule = {
      '2026-08-10': { P: 'Via', S: 'Windari', M: 'Icha' },
      '2026-08-11': { P: 'Syifa', S: 'Windari', M: 'Icha' },
      '2026-08-12': { P: 'Syifa', S: 'Windari', M: 'Icha' },
      '2026-08-13': { P: 'Syifa', S: 'Via', M: 'Icha' },
      '2026-08-14': { P: 'Syifa', S: 'Windari', M: null },
      '2026-08-15': { P: 'Syifa', S: 'Windari', M: 'Icha' },
      '2026-08-16': { P: 'Syifa', S: 'Windari', M: 'Icha' },
    };
    const ceriaSchedule = {
      '2026-08-10': { P: 'Melvi', S: 'Wilda', M: 'Vina' },
      '2026-08-11': { P: 'Melvi', S: 'Via', M: 'Vina' },
      '2026-08-12': { P: 'Melvi', S: 'Wilda', M: null },
      '2026-08-13': { P: 'Melvi', S: 'Wilda', M: 'Vina' },
      '2026-08-14': { P: 'Melvi', S: 'Wilda', M: 'Vina' },
      '2026-08-15': { P: 'Melvi', S: 'Wilda', M: 'Vina' },
      '2026-08-16': { P: 'Via', S: 'Wilda', M: 'Vina' },
    };
    // Packing: P=07.00-16.00, MID=12.00-21.00, S=14.00-23.00.
    // Catatan: 10 & 12 Agt di jadwal aslinya ditulis gabungan "X & Y (jam 9-6)"
    // untuk 2 orang tsb sepanjang hari (bukan pola 3-shift biasa) -- diinput
    // sebagai perkiraan terdekat (P + MID terisi, S dikosongkan) supaya tetap
    // konsisten dengan struktur 3-shift sistem; boleh disesuaikan manual di
    // dashboard kalau perlu.
    const packingSchedule = {
      '2026-08-10': { P: 'Ridho', MID: 'Akbar', S: null },
      '2026-08-11': { P: 'Naufal', MID: 'Akbar', S: 'Ridho' },
      '2026-08-12': { P: 'Naufal', MID: 'Akbar', S: null },
      '2026-08-13': { P: 'Naufal', MID: null, S: 'Ridho' },
      '2026-08-14': { P: 'Naufal', MID: 'Akbar', S: 'Ridho' },
      '2026-08-15': { P: 'Naufal', MID: 'Akbar', S: 'Ridho' },
      '2026-08-16': { P: 'Naufal', MID: 'Akbar', S: 'Ridho' },
    };

    const stmts = [];
    const addRows = (bagId, schedule) => {
      for (const [date, shifts] of Object.entries(schedule)) {
        for (const [shift, hostName] of Object.entries(shifts)) {
          stmts.push({
            sql: `INSERT INTO schedule_entries (date, bag_id, shift, host_id, source, locked)
                  VALUES (?, ?, ?, ?, 'manual', 1)`,
            args: [date, bagId, shift, hostName ? H[hostName] : null],
          });
        }
      }
    };
    addRows(bagusId, bagusSchedule);
    addRows(ceriaId, ceriaSchedule);
    addRows(packingId, packingSchedule);

    await db.batch(stmts, 'write');
    console.log('[seed] Histori jadwal Jakarta 10-16 Agt 2026 diinput (Bagus Bag, Ceria Bag, Packing)');
  }

  // CATATAN: dulu di sini ada data jadwal historis hardcoded (10-14 Agt 2026,
  // Senin-Jumat saja) hasil import dari foto "JADWAL HOST LIVE TANGERANG"
  // punya SPV lama. Data itu sudah dihapus dari seed karena:
  //  1. Cuma nutup 5 hari kerja (Senin-Jumat), sedangkan sistem sekarang
  //     jalan mingguan penuh (Minggu-Sabtu, 7 hari) — jadi bikin bingung
  //     kalau ikut ke-generate ulang tiap kali database di-reset/redeploy.
  //  2. locked=1 di semua slotnya bikin AI/rule-based generator tidak bisa
  //     menyesuaikan slot itu lagi walau datanya sudah basi.
  // Sekarang jadwal SELALU mulai kosong dan diisi lewat tombol "Generate"
  // di dashboard (rule-based atau AI) — lebih rapi & konsisten untuk
  // pemakaian mingguan yang berkelanjutan. Kalau butuh data historis lagi
  // sebagai bahan belajar AI, tinggal generate & kunci manual dari UI.
}

// Memoized: schema + seed cuma dijalankan sekali per instance lambda/server,
// bukan di setiap request.
let readyPromise = null;
function ensureReady() {
  if (!readyPromise) {
    readyPromise = (async () => {
      const schemaSql = fs.readFileSync(path.join(__dirname, 'schema.sql'), 'utf8');
      const statements = schemaSql
        .split(';')
        .map((s) => s.trim())
        .filter(Boolean);
      for (const stmt of statements) {
        await db.execute(stmt);
      }
      await migrate();
      await seed();
    })().catch((err) => {
      readyPromise = null; // biar retry di request berikutnya kalau gagal (misal db lagi cold)
      throw err;
    });
  }
  return readyPromise;
}

module.exports = { db, ensureReady };
