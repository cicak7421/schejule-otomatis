const express = require('express');
const { db } = require('../db/init');
const { DEPARTMENTS, LOCATIONS } = require('../lib/scheduler');

const router = express.Router();

function normDept(d) {
  return DEPARTMENTS.includes(d) ? d : 'host_live';
}
function normLoc(l) {
  return LOCATIONS.includes(l) ? l : 'tangerang';
}

router.get('/', async (req, res, next) => {
  try {
    const conds = [];
    const args = [];
    if (req.query.department && DEPARTMENTS.includes(req.query.department)) {
      conds.push('department = ?');
      args.push(req.query.department);
    }
    if (req.query.location && LOCATIONS.includes(req.query.location)) {
      conds.push('location = ?');
      args.push(req.query.location);
    }
    const where = conds.length ? `WHERE ${conds.join(' AND ')}` : '';
    const rows = (
      await db.execute({
        sql: `SELECT * FROM hosts ${where} ORDER BY active DESC, name`,
        args,
      })
    ).rows;
    res.json(rows);
  } catch (err) {
    next(err);
  }
});

router.post('/', async (req, res, next) => {
  try {
    const { name, notes, max_shifts_per_week, department, location } = req.body || {};
    if (!name || !name.trim()) return res.status(400).json({ error: 'Nama wajib diisi' });
    try {
      const info = await db.execute({
        sql: 'INSERT INTO hosts (name, notes, max_shifts_per_week, department, location) VALUES (?, ?, ?, ?, ?)',
        args: [name.trim(), notes || null, max_shifts_per_week || 6, normDept(department), normLoc(location)],
      });
      const row = (
        await db.execute({
          sql: 'SELECT * FROM hosts WHERE id = ?',
          args: [Number(info.lastInsertRowid)],
        })
      ).rows[0];
      res.json(row);
    } catch (e) {
      res.status(400).json({ error: 'Nama sudah ada' });
    }
  } catch (err) {
    next(err);
  }
});

router.put('/:id', async (req, res, next) => {
  try {
    const { name, notes, active, max_shifts_per_week, department, location } = req.body || {};
    const existing = (
      await db.execute({ sql: 'SELECT * FROM hosts WHERE id = ?', args: [req.params.id] })
    ).rows[0];
    if (!existing) return res.status(404).json({ error: 'Data tidak ditemukan' });
    await db.execute({
      sql: 'UPDATE hosts SET name = ?, notes = ?, active = ?, max_shifts_per_week = ?, department = ?, location = ? WHERE id = ?',
      args: [
        name ?? existing.name,
        notes ?? existing.notes,
        active === undefined ? existing.active : active ? 1 : 0,
        max_shifts_per_week ?? existing.max_shifts_per_week,
        department ? normDept(department) : existing.department,
        location ? normLoc(location) : existing.location,
        req.params.id,
      ],
    });
    const row = (
      await db.execute({ sql: 'SELECT * FROM hosts WHERE id = ?', args: [req.params.id] })
    ).rows[0];
    res.json(row);
  } catch (err) {
    next(err);
  }
});

router.delete('/:id', async (req, res, next) => {
  try {
    await db.execute({ sql: 'UPDATE hosts SET active = 0 WHERE id = ?', args: [req.params.id] });
    res.json({ ok: true });
  } catch (err) {
    next(err);
  }
});

module.exports = router;
