const express = require('express');
const { db } = require('../db/init');
const { DEPT_SHIFTS } = require('../lib/scheduler');

const router = express.Router();

// Publik: dipakai host untuk request shift tanpa perlu login
router.post('/request', async (req, res, next) => {
  try {
    const { host_id, date, bag_id, shift, reason } = req.body || {};
    if (!host_id || !date || !bag_id || !shift) {
      return res.status(400).json({ error: 'Host, tanggal, bag, dan shift wajib diisi' });
    }

    const host = (
      await db.execute({ sql: 'SELECT * FROM hosts WHERE id = ? AND active = 1', args: [host_id] })
    ).rows[0];
    if (!host) return res.status(404).json({ error: 'Host tidak ditemukan' });

    const bag = (
      await db.execute({ sql: 'SELECT * FROM bags WHERE id = ? AND active = 1', args: [bag_id] })
    ).rows[0];
    if (!bag) return res.status(404).json({ error: 'Bag/akun tidak ditemukan' });

    if (bag.department !== host.department) {
      return res.status(400).json({ error: 'Bag yang dipilih bukan dari departemen host ini' });
    }
    const allowedShifts = DEPT_SHIFTS[bag.department] || [];
    if (!allowedShifts.includes(shift)) {
      return res.status(400).json({ error: 'Shift tidak tersedia untuk departemen ini' });
    }

    const info = await db.execute({
      sql: 'INSERT INTO shift_requests (host_id, date, bag_id, shift, reason) VALUES (?, ?, ?, ?, ?)',
      args: [host_id, date, bag_id, shift, reason || null],
    });
    const row = (
      await db.execute({ sql: 'SELECT * FROM shift_requests WHERE id = ?', args: [Number(info.lastInsertRowid)] })
    ).rows[0];
    res.json(row);
  } catch (err) {
    next(err);
  }
});

// Protected: HR lihat semua request shift
router.get('/', async (req, res, next) => {
  try {
    const rows = (
      await db.execute(
        `SELECT sr.*, h.name as host_name, b.name as bag_name FROM shift_requests sr
         JOIN hosts h ON h.id = sr.host_id
         JOIN bags b ON b.id = sr.bag_id
         ORDER BY sr.status = 'pending' DESC, sr.requested_at DESC`
      )
    ).rows;
    res.json(rows);
  } catch (err) {
    next(err);
  }
});

router.post('/:id/review', async (req, res, next) => {
  try {
    const { status } = req.body || {}; // 'approved' | 'rejected'
    if (!['approved', 'rejected'].includes(status)) {
      return res.status(400).json({ error: 'Status tidak valid' });
    }
    const existing = (
      await db.execute({ sql: 'SELECT * FROM shift_requests WHERE id = ?', args: [req.params.id] })
    ).rows[0];
    if (!existing) return res.status(404).json({ error: 'Request tidak ditemukan' });

    await db.execute({
      sql: `UPDATE shift_requests SET status = ?, reviewed_by = ?, reviewed_at = datetime('now') WHERE id = ?`,
      args: [status, req.session.userId, req.params.id],
    });

    // kalau disetujui, isi/timpa slot jadwal yang bersangkutan. Tidak dikunci --
    // tetap bisa ditimpa oleh Generate Rule-based/AI berikutnya, sama seperti
    // edit manual lewat dropdown (tidak ada slot yang otomatis terkunci).
    // (aturan hard-constraint lain seperti "jumping" tidak dicek di sini karena
    // ini keputusan eksplisit HR meng-override untuk slot spesifik)
    if (status === 'approved') {
      await db.execute({
        sql: `INSERT INTO schedule_entries (date, bag_id, shift, host_id, source, locked)
              VALUES (?, ?, ?, ?, 'manual', 0)
              ON CONFLICT(date, bag_id, shift) DO UPDATE SET
                host_id = excluded.host_id, source = 'manual', locked = 0`,
        args: [existing.date, existing.bag_id, existing.shift, existing.host_id],
      });
    }

    const row = (
      await db.execute({ sql: 'SELECT * FROM shift_requests WHERE id = ?', args: [req.params.id] })
    ).rows[0];
    res.json(row);
  } catch (err) {
    next(err);
  }
});

module.exports = router;
