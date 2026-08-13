const { db } = require('../db/init');
const { callGroq } = require('./groqRouter');

const SHIFTS = ['P', 'S', 'M', 'MID'];
const SHIFT_LABEL = { P: 'Pagi', S: 'Siang', M: 'Malam', MID: 'Middle' };

// Shift yang berlaku per department. Host Live tetap 3 shift (Pagi/Siang/Malam),
// Packing 3 shift (Pagi/Middle/Siang), Admin 2 shift (Pagi/Siang).
const DEPARTMENTS = ['host_live', 'packing', 'admin'];
const DEPT_LABEL = { host_live: 'Host Live', packing: 'Packing', admin: 'Admin' };
const DEPT_SHIFTS = {
  host_live: ['P', 'S', 'M'],
  packing: ['P', 'MID', 'S'],
  admin: ['P', 'S'],
};

// Lokasi live/tim. Host & bag dari satu lokasi TIDAK BOLEH tertukar/dijadwalkan
// ke lokasi lain -- ini dijaga dengan memfilter hosts & bags by location di
// setiap query/generate, bukan cuma di UI.
const LOCATIONS = ['jakarta', 'tangerang'];
const LOCATION_LABEL = { jakarta: 'Jakarta', tangerang: 'Tangerang' };

function toDateStr(d) {
  return d.toISOString().slice(0, 10);
}

function weekDates(weekStartStr) {
  const start = new Date(weekStartStr + 'T00:00:00');
  return Array.from({ length: 7 }, (_, i) => {
    const d = new Date(start);
    d.setDate(d.getDate() + i);
    return toDateStr(d);
  });
}

function prevDate(dateStr) {
  const d = new Date(dateStr + 'T00:00:00');
  d.setDate(d.getDate() - 1);
  return toDateStr(d);
}

/**
 * Cek apakah host boleh ditempatkan pada (date, shift) berdasarkan histori penempatan
 * yang SUDAH ada di working set `placed` (map hostId -> Map(date -> Set(shift))).
 *
 * Aturan keras (sesuai kesepakatan HR):
 *  1. Host BOLEH dijadwalkan di 2 akun/bag berbeda pada HARI YANG SAMA
 *     (misal Pagi di bag A dan Siang di bag B, hari yang sama) — ini diizinkan.
 *  2. Host TIDAK BOLEH dapat shift Siang (S) di hari n lalu shift Pagi (P) di hari n+1 ("jumping"),
 *     berlaku lintas bag.
 *  3. Host TIDAK BOLEH dobel di shift & tanggal yang SAMA PERSIS di bag berbeda (itu bentrok waktu,
 *     karena secara fisik tidak mungkin live di 2 bag pada jam yang sama).
 *  4. Host tidak boleh kerja saat cuti disetujui.
 *  5. Host tidak boleh ditempatkan lagi kalau jumlah shift-nya MINGGU INI sudah mencapai
 *     batas `max_shifts_per_week` (kolom di tabel hosts, default 6/minggu). Dengan pola
 *     umum 1 shift/hari, batas 6 dari 7 hari otomatis menyisakan minimal 1 hari libur.
 *     `weeklyShiftCount` HARUS berisi hitungan shift host tsb HANYA untuk minggu yang
 *     sedang digenerate (bukan histori minggu-minggu sebelumnya).
 */
function isAllowed(hostId, date, shift, placed, approvedLeaveDates, weeklyShiftCount, maxShiftsByHost) {
  const leaves = approvedLeaveDates.get(hostId);
  if (leaves && leaves.has(date)) return false;

  const hostMap = placed.get(hostId);
  const todayShifts = hostMap?.get(date);
  if (todayShifts && todayShifts.has(shift)) return false; // bentrok waktu: shift sama, tanggal sama

  const yesterday = prevDate(date);
  const yesterdayShifts = hostMap?.get(yesterday);
  if (yesterdayShifts && yesterdayShifts.has('S') && shift === 'P') return false; // aturan jumping

  if (weeklyShiftCount && maxShiftsByHost) {
    const used = weeklyShiftCount.get(hostId) || 0;
    const max = maxShiftsByHost.get(hostId) ?? 6;
    if (used >= max) return false; // pastikan tetap ada jatah libur minggu ini
  }

  return true;
}

function markPlaced(hostId, date, shift, placed) {
  if (!placed.has(hostId)) placed.set(hostId, new Map());
  const hostMap = placed.get(hostId);
  if (!hostMap.has(date)) hostMap.set(date, new Set());
  hostMap.get(date).add(shift);
}

function unmarkPlaced(hostId, date, shift, placed) {
  const hostMap = placed.get(hostId);
  const set = hostMap?.get(date);
  if (set) set.delete(shift);
}

/**
 * Ambil data konteks yang dibutuhkan untuk generate: host aktif, bag aktif,
 * cuti yang disetujui dalam rentang minggu, dan histori 2 minggu terakhir
 * (dipakai sebagai bahan analisa pola oleh AI & baseline fairness).
 */
async function getContext(weekStart, weekEnd, bagIds, department, location) {
  let hosts = (await db.execute('SELECT * FROM hosts WHERE active = 1 ORDER BY name')).rows;
  let bags = (await db.execute('SELECT * FROM bags WHERE active = 1 ORDER BY sort_order, name')).rows;
  if (department) {
    bags = bags.filter((b) => b.department === department);
  }
  if (location) {
    bags = bags.filter((b) => b.location === location);
    hosts = hosts.filter((h) => h.location === location);
  }
  if (bagIds && bagIds.length) {
    bags = bags.filter((b) => bagIds.includes(b.id));
  }

  const leaveRows = (
    await db.execute({
      sql: `SELECT * FROM leave_requests WHERE status = 'approved'
            AND date_start <= ? AND date_end >= ?`,
      args: [weekEnd, weekStart],
    })
  ).rows;

  const approvedLeaveDates = new Map(); // hostId -> Set(dates)
  for (const lr of leaveRows) {
    const dates = new Set();
    let d = new Date(lr.date_start + 'T00:00:00');
    const end = new Date(lr.date_end + 'T00:00:00');
    while (d <= end) {
      dates.add(toDateStr(d));
      d.setDate(d.getDate() + 1);
    }
    if (!approvedLeaveDates.has(lr.host_id)) approvedLeaveDates.set(lr.host_id, new Set());
    for (const dt of dates) approvedLeaveDates.get(lr.host_id).add(dt);
  }

  // histori 14 hari sebelum weekStart, buat lihat pola & continuity (shift terakhir sebelum minggu ini)
  const historyStart = (() => {
    const d = new Date(weekStart + 'T00:00:00');
    d.setDate(d.getDate() - 14);
    return toDateStr(d);
  })();
  const history = (
    await db.execute({
      sql: `SELECT se.date, se.shift, se.host_id, se.bag_id, b.name as bag_name
            FROM schedule_entries se JOIN bags b ON b.id = se.bag_id
            WHERE se.date >= ? AND se.date < ? AND se.host_id IS NOT NULL
            ORDER BY se.date`,
      args: [historyStart, weekStart],
    })
  ).rows;

  const bagIdSet = new Set(bags.map((b) => b.id));
  const scopedHistory = history.filter((h) => bagIdSet.has(h.bag_id));

  return { hosts, bags, approvedLeaveDates, history: scopedHistory };
}

/**
 * Baseline generator: rule-based, greedy, least-shifts-first untuk fairness.
 * Menghasilkan assignment yang MENJAMIN semua hard constraint terpenuhi.
 * Ini adalah fallback yang selalu valid meski AI tidak tersedia.
 */
function generateBaseline(dates, bags, hosts, approvedLeaveDates, history) {
  const placed = new Map(); // hostId -> {date: shift}, mulai dari histori (buat cek continuity hari pertama minggu ini)
  for (const h of history) {
    markPlaced(h.host_id, h.date, h.shift, placed);
  }

  const shiftCount = new Map(hosts.map((h) => [h.id, 0])); // buat load-balancing SEKALIGUS batas libur mingguan
  const maxShiftsByHost = new Map(hosts.map((h) => [h.id, h.max_shifts_per_week ?? 6]));
  const assignments = []; // {date, bag_id, shift, host_id}

  for (const date of dates) {
    for (const bag of bags) {
      const shiftsForBag = DEPT_SHIFTS[bag.department] || SHIFTS;
      for (const shift of shiftsForBag) {
        // urutkan host by paling sedikit shift dulu (fairness), hanya dari department yang sama dengan bag
        const candidates = hosts
          .filter((h) => h.department === bag.department)
          .filter((h) => isAllowed(h.id, date, shift, placed, approvedLeaveDates, shiftCount, maxShiftsByHost))
          .sort((a, b) => shiftCount.get(a.id) - shiftCount.get(b.id));

        const chosen = candidates[0];
        if (chosen) {
          markPlaced(chosen.id, date, shift, placed);
          shiftCount.set(chosen.id, shiftCount.get(chosen.id) + 1);
          assignments.push({ date, bag_id: bag.id, shift, host_id: chosen.id });
        } else {
          assignments.push({ date, bag_id: bag.id, shift, host_id: null }); // slot kosong, HR isi manual
        }
      }
    }
  }

  return assignments;
}

/**
 * Minta Groq menganalisa pola histori & baseline, lalu usulkan perbaikan
 * (misal: rotasi lebih natural, hindari host itu2 saja di bag yang sama).
 * Hasil AI TETAP divalidasi ulang lewat isAllowed() sebelum dipakai —
 * AI tidak pernah diizinkan melanggar hard constraint.
 */
async function refineWithAI({ dates, bags, hosts, approvedLeaveDates, history, baseline }) {
  const bagById = Object.fromEntries(bags.map((b) => [b.id, b.name]));
  const hostById = Object.fromEntries(hosts.map((h) => [h.id, h.name]));

  const historyText = history
    .slice(-60)
    .map((h) => `${h.date} ${h.bag_name} ${h.shift}=${hostById[h.host_id] || h.host_id}`)
    .join('\n');

  const baselineText = baseline
    .map((a) => `${a.date} ${bagById[a.bag_id]} ${a.shift}=${a.host_id ? hostById[a.host_id] : 'KOSONG'}`)
    .join('\n');

  const hostList = hosts.map((h) => h.name).join(', ');

  const systemPrompt = `Kamu adalah asisten HR yang membantu menghaluskan jadwal kerja host live streaming.
Aturan KERAS yang TIDAK BOLEH dilanggar:
1. Seorang host TIDAK BOLEH mendapat shift Siang (S) lalu besoknya shift Pagi (P), di bag manapun.
2. Seorang host TIDAK BOLEH ditempatkan di shift yang sama pada tanggal yang sama di lebih dari satu bag (bentrok waktu).
3. Host yang sedang cuti/libur yang disetujui TIDAK BOLEH dijadwalkan.
Tujuanmu: usulkan perbaikan rotasi supaya adil (jumlah shift merata) dan pola terasa alami berdasarkan histori, TANPA melanggar aturan di atas.
Jawab HANYA dengan JSON, format:
{"changes": [{"date":"YYYY-MM-DD","bag":"nama_bag","shift":"P|S|M","host":"nama_host"}], "summary":"ringkasan singkat analisa dalam bahasa Indonesia"}
Hanya sertakan "changes" untuk slot yang menurutmu perlu diganti dari baseline. Kalau baseline sudah baik, "changes" boleh kosong array.`;

  const userPrompt = `Daftar host aktif: ${hostList}

Histori jadwal 2 minggu terakhir (tanggal bag shift=host):
${historyText || '(belum ada histori)'}

Baseline jadwal minggu ini yang sudah valid secara aturan (tanggal bag shift=host):
${baselineText}

Tolong review baseline di atas dan usulkan perbaikan rotasi/fairness jika perlu, dalam format JSON yang diminta.`;

  const { content, keyUsed } = await callGroq(
    [
      { role: 'system', content: systemPrompt },
      { role: 'user', content: userPrompt },
    ],
    { json: true, temperature: 0.5, maxTokens: 3000 }
  );

  let parsed;
  try {
    parsed = JSON.parse(content);
  } catch {
    return { changes: [], summary: 'AI tidak mengembalikan JSON valid, memakai baseline rule-based apa adanya.', keyUsed };
  }

  const nameToHostId = Object.fromEntries(hosts.map((h) => [h.name.toLowerCase(), h.id]));
  const nameToBagId = Object.fromEntries(bags.map((b) => [b.name.toLowerCase(), b.id]));
  const baselineByKey = new Map(baseline.map((a) => [`${a.date}|${a.bag_id}|${a.shift}`, a]));

  // working "placed" map di-rebuild dari baseline supaya validasi perubahan tetap konsisten
  const placed = new Map();
  for (const h of history) markPlaced(h.host_id, h.date, h.shift, placed);
  for (const a of baseline) if (a.host_id) markPlaced(a.host_id, a.date, a.shift, placed);

  // shiftCount minggu ini (dari baseline) + batas max_shifts_per_week, supaya AI juga
  // tidak boleh melanggar jatah libur mingguan saat mengusulkan perubahan.
  const shiftCount = new Map(hosts.map((h) => [h.id, 0]));
  for (const a of baseline) if (a.host_id) shiftCount.set(a.host_id, (shiftCount.get(a.host_id) || 0) + 1);
  const maxShiftsByHost = new Map(hosts.map((h) => [h.id, h.max_shifts_per_week ?? 6]));

  const validChanges = [];
  for (const c of parsed.changes || []) {
    const bagId = nameToBagId[(c.bag || '').toLowerCase()];
    const hostId = nameToHostId[(c.host || '').toLowerCase()];
    if (!bagId || !hostId || !SHIFTS.includes(c.shift) || !dates.includes(c.date)) continue;

    const key = `${c.date}|${bagId}|${c.shift}`;
    const oldAssignment = baselineByKey.get(key);
    const oldHostId = oldAssignment?.host_id || null;
    if (oldHostId === hostId) continue; // tidak ada perubahan nyata

    // lepas dulu slot lama (kalau ada) supaya cek cap/continuity host baru akurat
    if (oldHostId) {
      unmarkPlaced(oldHostId, c.date, c.shift, placed);
      shiftCount.set(oldHostId, Math.max(0, (shiftCount.get(oldHostId) || 0) - 1));
    }

    if (isAllowed(hostId, c.date, c.shift, placed, approvedLeaveDates, shiftCount, maxShiftsByHost)) {
      markPlaced(hostId, c.date, c.shift, placed);
      shiftCount.set(hostId, (shiftCount.get(hostId) || 0) + 1);
      validChanges.push({ date: c.date, bag_id: bagId, shift: c.shift, host_id: hostId });
    } else if (oldHostId) {
      // gagal validasi, kembalikan slot lama biar konsisten
      markPlaced(oldHostId, c.date, c.shift, placed);
      shiftCount.set(oldHostId, (shiftCount.get(oldHostId) || 0) + 1);
    }
  }

  return { changes: validChanges, summary: parsed.summary || '', keyUsed };
}

/**
 * Entry point utama. Generate jadwal untuk 1 minggu (weekStart = tanggal Minggu/Sunday, format YYYY-MM-DD).
 * Entry yang sudah `locked` (di-override manual oleh HR) tidak akan ditimpa.
 */
async function generateWeeklySchedule(weekStart, { bagIds = null, department = null, location = null, useAI = true } = {}) {
  const dates = weekDates(weekStart);
  const weekEnd = dates[dates.length - 1];
  const { hosts, bags, approvedLeaveDates, history } = await getContext(weekStart, weekEnd, bagIds, department, location);

  const deptLabel = department ? DEPT_LABEL[department] || department : null;
  const locLabel = location ? LOCATION_LABEL[location] || location : null;
  if (!bags.length) {
    throw new Error(
      deptLabel
        ? `Belum ada tim/bag aktif untuk ${deptLabel}${locLabel ? ' di ' + locLabel : ''}.`
        : 'Belum ada bag/akun aktif. Tambahkan bag dulu.'
    );
  }
  const relevantDepartments = new Set(bags.map((b) => b.department));
  const hasEligibleHost = hosts.some((h) => relevantDepartments.has(h.department));
  if (!hasEligibleHost) {
    throw new Error(
      deptLabel
        ? `Belum ada orang aktif di department ${deptLabel}. Tambahkan dulu di menu Host/Staff.`
        : 'Belum ada host aktif. Tambahkan host dulu.'
    );
  }

  const lockedRows = (
    await db.execute({
      sql: `SELECT * FROM schedule_entries WHERE date BETWEEN ? AND ? AND locked = 1`,
      args: [weekStart, weekEnd],
    })
  ).rows;
  const lockedKey = new Set(lockedRows.map((r) => `${r.date}|${r.bag_id}|${r.shift}`));

  let baseline = generateBaseline(dates, bags, hosts, approvedLeaveDates, history);
  // buang slot yang sudah locked dari baseline (biarkan tetap seperti aslinya)
  baseline = baseline.filter((a) => !lockedKey.has(`${a.date}|${a.bag_id}|${a.shift}`));

  let summary = 'Jadwal dibuat dengan aturan rule-based (tanpa AI).';
  let keyUsed = null;
  let finalAssignments = baseline;

  if (useAI) {
    try {
      const { changes, summary: aiSummary, keyUsed: usedKey } = await refineWithAI({
        dates,
        bags,
        hosts,
        approvedLeaveDates,
        history,
        baseline,
      });
      keyUsed = usedKey;
      if (aiSummary) summary = aiSummary;

      const changeMap = new Map(changes.map((c) => [`${c.date}|${c.bag_id}|${c.shift}`, c]));
      finalAssignments = baseline.map((a) => {
        const key = `${a.date}|${a.bag_id}|${a.shift}`;
        return changeMap.has(key) ? changeMap.get(key) : a;
      });
    } catch (err) {
      summary = `AI tidak tersedia (${err.message}), memakai jadwal rule-based sebagai cadangan.`;
    }
  }

  const source = keyUsed ? 'ai' : 'rule';
  const stmts = finalAssignments.map((r) => ({
    sql: `INSERT INTO schedule_entries (date, bag_id, shift, host_id, source, locked)
          VALUES (?, ?, ?, ?, ?, 0)
          ON CONFLICT(date, bag_id, shift) DO UPDATE SET
            host_id = excluded.host_id, source = excluded.source
          WHERE schedule_entries.locked = 0`,
    args: [r.date, r.bag_id, r.shift, r.host_id, source],
  }));
  if (stmts.length) {
    await db.batch(stmts, 'write');
  }

  await db.execute({
    sql: `INSERT INTO generation_logs (week_start, week_end, summary, groq_key_used) VALUES (?, ?, ?, ?)`,
    args: [weekStart, weekEnd, summary, keyUsed],
  });

  return { dates, weekEnd, summary, keyUsed, count: finalAssignments.length };
}

module.exports = {
  SHIFTS,
  SHIFT_LABEL,
  DEPARTMENTS,
  DEPT_LABEL,
  DEPT_SHIFTS,
  LOCATIONS,
  LOCATION_LABEL,
  weekDates,
  generateWeeklySchedule,
  getContext,
};
