-- ===================== USERS (HR / Admin login) =====================
CREATE TABLE IF NOT EXISTS users (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  username TEXT UNIQUE NOT NULL,
  password_hash TEXT NOT NULL,
  full_name TEXT,
  role TEXT NOT NULL DEFAULT 'hr', -- 'hr' | 'admin'
  created_at TEXT DEFAULT (datetime('now'))
);

-- ===================== BAGS / AKUN LIVE =====================
-- HR bisa nambah akun baru kapan saja lewat UI
CREATE TABLE IF NOT EXISTS bags (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT UNIQUE NOT NULL,
  active INTEGER NOT NULL DEFAULT 1,
  sort_order INTEGER DEFAULT 0,
  department TEXT NOT NULL DEFAULT 'host_live', -- 'host_live' | 'packing' | 'admin'
  location TEXT NOT NULL DEFAULT 'tangerang', -- 'jakarta' | 'tangerang' -- lokasi live/tim, tidak boleh dicampur antar lokasi
  shifts TEXT, -- daftar shift yang benar-benar dipakai bag ini, mis. 'P,S' atau 'P,S,M'.
               -- NULL = pakai default department (lihat DEPT_SHIFTS di lib/scheduler.js).
               -- Dipakai supaya bag yang memang tidak buka shift Malam (mis. sebagian
               -- akun di Tangerang) tidak terus-terusan digenerate kolom kosong.
  created_at TEXT DEFAULT (datetime('now'))
);

-- ===================== HOSTS =====================
-- "hosts" menyimpan semua orang yang dijadwalkan: host live, packing, & admin
-- dibedakan lewat kolom department.
CREATE TABLE IF NOT EXISTS hosts (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT UNIQUE NOT NULL,
  active INTEGER NOT NULL DEFAULT 1,
  notes TEXT,
  max_shifts_per_week INTEGER DEFAULT 6,
  department TEXT NOT NULL DEFAULT 'host_live', -- 'host_live' | 'packing' | 'admin'
  location TEXT NOT NULL DEFAULT 'tangerang', -- 'jakarta' | 'tangerang' -- host cuma boleh dijadwalkan di lokasinya sendiri
  created_at TEXT DEFAULT (datetime('now'))
);

-- ===================== SCHEDULE ENTRIES =====================
-- Satu baris = satu penempatan orang pada tanggal + bag/tim + shift tertentu.
-- Untuk department 'packing'/'admin', bag_id menunjuk ke "bag virtual" (satu
-- baris di tabel bags mewakili tim tsb), bukan akun live.
CREATE TABLE IF NOT EXISTS schedule_entries (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  date TEXT NOT NULL,           -- format YYYY-MM-DD
  bag_id INTEGER NOT NULL REFERENCES bags(id) ON DELETE CASCADE,
  shift TEXT NOT NULL CHECK (shift IN ('P','S','M','MID')),
  host_id INTEGER REFERENCES hosts(id) ON DELETE SET NULL,
  source TEXT NOT NULL DEFAULT 'manual', -- 'manual' | 'ai' | 'rule'
  locked INTEGER NOT NULL DEFAULT 0,     -- HR override, jangan diubah AI lagi
  created_at TEXT DEFAULT (datetime('now')),
  UNIQUE(date, bag_id, shift)
);

-- ===================== LEAVE REQUESTS (permintaan libur host) =====================
CREATE TABLE IF NOT EXISTS leave_requests (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  host_id INTEGER NOT NULL REFERENCES hosts(id) ON DELETE CASCADE,
  date_start TEXT NOT NULL,
  date_end TEXT NOT NULL,
  reason TEXT,
  status TEXT NOT NULL DEFAULT 'pending', -- 'pending' | 'approved' | 'rejected'
  requested_at TEXT DEFAULT (datetime('now')),
  reviewed_by INTEGER REFERENCES users(id),
  reviewed_at TEXT
);

-- ===================== SHIFT REQUESTS (permintaan shift/jadwal dari host) =====================
-- Beda dari leave_requests: ini host MINTA ditempatkan di shift tertentu
-- (bukan minta libur). Kalau disetujui HR, otomatis mengisi/menimpa slot
-- schedule_entries yang bersangkutan (dan dikunci supaya tidak ditimpa AI).
CREATE TABLE IF NOT EXISTS shift_requests (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  host_id INTEGER NOT NULL REFERENCES hosts(id) ON DELETE CASCADE,
  date TEXT NOT NULL,
  bag_id INTEGER NOT NULL REFERENCES bags(id) ON DELETE CASCADE,
  shift TEXT NOT NULL CHECK (shift IN ('P','S','M','MID')),
  reason TEXT,
  status TEXT NOT NULL DEFAULT 'pending', -- 'pending' | 'approved' | 'rejected'
  requested_at TEXT DEFAULT (datetime('now')),
  reviewed_by INTEGER REFERENCES users(id),
  reviewed_at TEXT
);

-- ===================== GENERATION LOG =====================
-- Menyimpan riwayat setiap kali jadwal digenerate, termasuk alasan/insight dari AI
CREATE TABLE IF NOT EXISTS generation_logs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  week_start TEXT NOT NULL,
  week_end TEXT NOT NULL,
  summary TEXT,          -- ringkasan analisa AI (pola, fairness, dsb)
  groq_key_used TEXT,    -- label key mana yang berhasil dipakai (bukan key asli)
  created_at TEXT DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_schedule_date ON schedule_entries(date);
CREATE INDEX IF NOT EXISTS idx_schedule_host ON schedule_entries(host_id);
CREATE INDEX IF NOT EXISTS idx_leave_host ON leave_requests(host_id);
CREATE INDEX IF NOT EXISTS idx_shiftreq_host ON shift_requests(host_id);
CREATE INDEX IF NOT EXISTS idx_shiftreq_date ON shift_requests(date);
