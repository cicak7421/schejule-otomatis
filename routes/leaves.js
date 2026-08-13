const express = require('express');
const { db } = require('../db/init');

const router = express.Router();

// Publik: dipakai host untuk request libur tanpa perlu login
router.post('/request', async (req, res, next) => {
  try {
    const { host_id, date_start, date_end, reason } = req.body || {};
    if (!host_id || !date_start || !date_end) {
      return res.status(400).json({ error: 'Host, tanggal mulai, dan tanggal selesai wajib diisi' });
    }
    if (date_end < date_start) {
      return res.status(400).json({ error: 'Tanggal selesai tidak boleh sebelum tanggal mulai' });
    }
    const host = (
      await db.execute({
        sql: 'SELECT * FROM hosts WHERE id = ? AND active = 1',
        args: [host_id],
      })
    ).rows[0];
    if (!host) return res.status(404).json({ error: 'Host tidak ditemukan' });

    const info = await db.execute({
      sql: 'INSERT INTO leave_requests (host_id, date_start, date_end, reason) VALUES (?, ?, ?, ?)',
      args: [host_id, date_start, date_end, reason || null],
    });
    const row = (
      await db.execute({
        sql: 'SELECT * FROM leave_requests WHERE id = ?',
        args: [Number(info.lastInsertRowid)],
      })
    ).rows[0];
    res.json(row);
  } catch (err) {
    next(err);
  }
});

// Protected: HR lihat semua request
router.get('/', async (req, res, next) => {
  try {
    const rows = (
      await db.execute(
        `SELECT lr.*, h.name as host_name FROM leave_requests lr
         JOIN hosts h ON h.id = lr.host_id
         ORDER BY lr.status = 'pending' DESC, lr.requested_at DESC`
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
      await db.execute({ sql: 'SELECT * FROM leave_requests WHERE id = ?', args: [req.params.id] })
    ).rows[0];
    if (!existing) return res.status(404).json({ error: 'Request tidak ditemukan' });

    await db.execute({
      sql: `UPDATE leave_requests SET status = ?, reviewed_by = ?, reviewed_at = datetime('now') WHERE id = ?`,
      args: [status, req.session.userId, req.params.id],
    });

    // kalau disetujui, otomatis kosongkan slot jadwal yang belum locked di rentang tanggal itu
    if (status === 'approved') {
      await db.execute({
        sql: `UPDATE schedule_entries SET host_id = NULL
              WHERE host_id = ? AND date BETWEEN ? AND ? AND locked = 0`,
        args: [existing.host_id, existing.date_start, existing.date_end],
      });
    }

    const row = (
      await db.execute({ sql: 'SELECT * FROM leave_requests WHERE id = ?', args: [req.params.id] })
    ).rows[0];
    res.json(row);
  } catch (err) {
    next(err);
  }
});

module.exports = router;
