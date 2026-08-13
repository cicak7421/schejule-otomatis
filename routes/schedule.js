const express = require('express');
const { db } = require('../db/init');
const {
  generateWeeklySchedule,
  weekDates,
  SHIFTS,
  DEPARTMENTS,
  DEPT_LABEL,
  DEPT_SHIFTS,
  LOCATIONS,
  LOCATION_LABEL,
} = require('../lib/scheduler');

const router = express.Router();

// Departemen yang bisa dijadwalkan lewat sistem ini
router.get('/departments', (req, res) => {
  res.json(DEPARTMENTS.map((d) => ({ id: d, label: DEPT_LABEL[d], shifts: DEPT_SHIFTS[d] })));
});

// Lokasi live/tim yang tersedia (Jakarta, Tangerang, dst)
router.get('/locations', (req, res) => {
  res.json(LOCATIONS.map((l) => ({ id: l, label: LOCATION_LABEL[l] })));
});

// Ambil jadwal untuk 1 minggu (weekStart = Minggu/Sunday, YYYY-MM-DD), auto-buat slot kosong kalau belum ada
// ?department=host_live|packing|admin -> filter bag & host sesuai tim (default host_live)
// ?location=jakarta|tangerang -> filter sesuai lokasi live (default tangerang). Host & bag
// dari lokasi berbeda TIDAK PERNAH digabung/ditukar di sini.
router.get('/week/:weekStart', async (req, res, next) => {
  try {
    const { weekStart } = req.params;
    const department = DEPARTMENTS.includes(req.query.department) ? req.query.department : 'host_live';
    const location = LOCATIONS.includes(req.query.location) ? req.query.location : 'tangerang';
    const days = Math.min(31, Math.max(1, parseInt(req.query.days, 10) || 7));
    const dates = weekDates(weekStart, days);
    const weekEnd = dates[dates.length - 1];

    const bags = (
      await db.execute({
        sql: 'SELECT * FROM bags WHERE active = 1 AND department = ? AND location = ? ORDER BY sort_order, name',
        args: [department, location],
      })
    ).rows;
    const hosts = (
      await db.execute({
        sql: 'SELECT * FROM hosts WHERE active = 1 AND department = ? AND location = ? ORDER BY name',
        args: [department, location],
      })
    ).rows;
    const bagIds = bags.map((b) => b.id);
    const entries = bagIds.length
      ? (
          await db.execute({
            sql: `SELECT se.*, h.name as host_name, b.name as bag_name
                  FROM schedule_entries se
                  LEFT JOIN hosts h ON h.id = se.host_id
                  JOIN bags b ON b.id = se.bag_id
                  WHERE se.date BETWEEN ? AND ? AND se.bag_id IN (${bagIds.map(() => '?').join(',')})`,
            args: [weekStart, weekEnd, ...bagIds],
          })
        ).rows
      : [];

    const log = (
      await db.execute({
        sql: 'SELECT * FROM generation_logs WHERE week_start = ? ORDER BY created_at DESC LIMIT 1',
        args: [weekStart],
      })
    ).rows[0];

    res.json({ dates, bags, hosts, entries, lastLog: log || null, department, location, shifts: DEPT_SHIFTS[department] });
  } catch (err) {
    next(err);
  }
});

// Generate / re-generate jadwal dengan bantuan AI.
// `days` normalnya 7 (mingguan) -- bisa diisi nilai lain untuk generate SATU
// KALI rentang khusus (misal 9 hari, buat menyambung histori yang belum
// sejalan dengan siklus Minggu-Sabtu). Minggu berikutnya kembali ke 7 hari.
router.post('/generate', async (req, res) => {
  const { weekStart, bagIds, department, location, useAI, days } = req.body || {};
  if (!weekStart) return res.status(400).json({ error: 'weekStart wajib diisi (format YYYY-MM-DD)' });
  try {
    const result = await generateWeeklySchedule(weekStart, {
      bagIds: bagIds && bagIds.length ? bagIds : null,
      department: DEPARTMENTS.includes(department) ? department : null,
      location: LOCATIONS.includes(location) ? location : 'tangerang',
      useAI: useAI !== false,
      days: Math.min(31, Math.max(1, parseInt(days, 10) || 7)),
    });
    res.json(result);
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

// Edit manual satu slot (HR override) -> otomatis locked supaya tidak ditimpa AI lagi
router.put('/entry', async (req, res, next) => {
  try {
    const { date, bag_id, shift, host_id } = req.body || {};
    if (!date || !bag_id || !SHIFTS.includes(shift)) {
      return res.status(400).json({ error: 'date, bag_id, shift wajib valid' });
    }
    await db.execute({
      sql: `INSERT INTO schedule_entries (date, bag_id, shift, host_id, source, locked)
            VALUES (?, ?, ?, ?, 'manual', 1)
            ON CONFLICT(date, bag_id, shift) DO UPDATE SET
              host_id = excluded.host_id, source = 'manual', locked = 1`,
      args: [date, bag_id, shift, host_id || null],
    });
    res.json({ ok: true });
  } catch (err) {
    next(err);
  }
});

// Lepas kunci manual supaya slot bisa digenerate ulang oleh AI
router.put('/entry/unlock', async (req, res, next) => {
  try {
    const { date, bag_id, shift } = req.body || {};
    await db.execute({
      sql: `UPDATE schedule_entries SET locked = 0 WHERE date = ? AND bag_id = ? AND shift = ?`,
      args: [date, bag_id, shift],
    });
    res.json({ ok: true });
  } catch (err) {
    next(err);
  }
});

module.exports = router;
