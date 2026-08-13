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
        sql: `SELECT * FROM bags ${where} ORDER BY active DESC, sort_order, name`,
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
    const { name, sort_order, department, location } = req.body || {};
    if (!name || !name.trim()) return res.status(400).json({ error: 'Nama bag wajib diisi' });
    try {
      const info = await db.execute({
        sql: 'INSERT INTO bags (name, sort_order, department, location) VALUES (?, ?, ?, ?)',
        args: [name.trim(), sort_order || 0, normDept(department), normLoc(location)],
      });
      const row = (
        await db.execute({
          sql: 'SELECT * FROM bags WHERE id = ?',
          args: [Number(info.lastInsertRowid)],
        })
      ).rows[0];
      res.json(row);
    } catch (e) {
      res.status(400).json({ error: 'Nama bag sudah ada' });
    }
  } catch (err) {
    next(err);
  }
});

router.put('/:id', async (req, res, next) => {
  try {
    const { name, active, sort_order, location } = req.body || {};
    const existing = (
      await db.execute({ sql: 'SELECT * FROM bags WHERE id = ?', args: [req.params.id] })
    ).rows[0];
    if (!existing) return res.status(404).json({ error: 'Bag tidak ditemukan' });
    await db.execute({
      sql: 'UPDATE bags SET name = ?, active = ?, sort_order = ?, location = ? WHERE id = ?',
      args: [
        name ?? existing.name,
        active === undefined ? existing.active : active ? 1 : 0,
        sort_order ?? existing.sort_order,
        location ? normLoc(location) : existing.location,
        req.params.id,
      ],
    });
    const row = (
      await db.execute({ sql: 'SELECT * FROM bags WHERE id = ?', args: [req.params.id] })
    ).rows[0];
    res.json(row);
  } catch (err) {
    next(err);
  }
});

router.delete('/:id', async (req, res, next) => {
  try {
    await db.execute({ sql: 'UPDATE bags SET active = 0 WHERE id = ?', args: [req.params.id] });
    res.json({ ok: true });
  } catch (err) {
    next(err);
  }
});

module.exports = router;
