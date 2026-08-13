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

// `days` biasanya 7 (mingguan, sesuai desain sistem). Bisa diisi angka lain
// untuk generate SATU KALI rentang khusus (misal 9 hari) waktu menyambung
// histori yang belum sejalan dengan siklus Minggu-Sabtu -- lihat catatan di
// seed data Tangerang (db/init.js). Minggu-minggu berikutnya tetap 7 hari.
function weekDates(weekStartStr, days = 7) {
  const start = new Date(weekStartStr + 'T00:00:00');
  return Array.from({ length: days }, (_, i) => {
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
 * Cek apakah host boleh ditempatkan pada (date, shift, bagId) berdasarkan histori
 * penempatan yang SUDAH ada di working set `placed`
 * (map hostId -> Map(date -> { shifts: Set(shift), bags: Set(bagId) })).
 *
 * Aturan keras (sesuai kesepakatan HR):
 *  1. Host MAKSIMAL 1 shift per HARI, di bag manapun (tidak boleh dijadwalkan
 *     2x di hari yang sama, baik di bag yang sama maupun bag berbeda).
 *  2. Host TIDAK BOLEH dapat shift Siang (S) di hari n lalu shift Pagi (P) di hari n+1 ("jumping"),
 *     berlaku lintas bag.
 *  3. Host tidak boleh kerja saat cuti disetujui.
 *  4. Host tidak boleh ditempatkan lagi kalau jumlah shift-nya MINGGU INI sudah mencapai
 *     batas `max_shifts_per_week` (kolom di tabel hosts, default 6/minggu). Dengan pola
 *     1 shift/hari, batas 6 dari 7 hari otomatis menyisakan minimal 1 hari libur.
 *     `weeklyShiftCount` HARUS berisi hitungan shift host tsb HANYA untuk minggu yang
 *     sedang digenerate (bukan histori minggu-minggu sebelumnya).
 */
function isAllowed(hostId, date, shift, bagId, placed, approvedLeaveDates, weeklyShiftCount, maxShiftsByHost) {
  const leaves = approvedLeaveDates.get(hostId);
  if (leaves && leaves.has(date)) return false;

  const hostMap = placed.get(hostId);
  const today = hostMap?.get(date);
  if (today && today.shifts.size > 0) return false; // sudah dapat 1 shift hari ini (bag manapun) -> tidak boleh dobel

  const yesterday = prevDate(date);
  const yesterdayData = hostMap?.get(yesterday);
  if (yesterdayData?.shifts.has('S') && shift === 'P') return false; // aturan jumping

  if (weeklyShiftCount && maxShiftsByHost) {
    const used = weeklyShiftCount.get(hostId) || 0;
    const max = maxShiftsByHost.get(hostId) ?? 6;
    if (used >= max) return false; // pastikan tetap ada jatah libur minggu ini
  }

  return true;
}

function markPlaced(hostId, date, shift, bagId, placed) {
  if (!placed.has(hostId)) placed.set(hostId, new Map());
  const hostMap = placed.get(hostId);
  if (!hostMap.has(date)) hostMap.set(date, { shifts: new Set(), bags: new Set() });
  const entry = hostMap.get(date);
  entry.shifts.add(shift);
  entry.bags.add(bagId);
}

function unmarkPlaced(hostId, date, shift, bagId, placed) {
  const hostMap = placed.get(hostId);
  const entry = hostMap?.get(date);
  if (entry) {
    entry.shifts.delete(shift);
    entry.bags.delete(bagId);
  }
}

/**
 * ===================== ROTASI HARI LIBUR (anti-bentrok) =====================
 * Sebelumnya, hari libur cuma "efek samping" dari batas `max_shifts_per_week`:
 * karena semua host di satu departemen mulai dari titik yang sama & diproses
 * dengan aturan fairness yang identik, mereka cenderung mencapai batas
 * shift-nya di HARI YANG SAMA -> semua libur bareng di hari yang sama
 * (termasuk kasus ekstrim: satu departemen kosong total di 1 hari).
 *
 * Fungsi di bawah ini secara eksplisit MENENTUKAN LEBIH DULU siapa libur di
 * tanggal berapa (sebelum slot shift diisi), dengan aturan:
 *  - Tiap host dapat jumlah hari libur = jumlah_hari_dijadwalkan - max_shifts_per_week
 *    (dikurangi cuti yang sudah disetujui di rentang itu, karena cuti sudah
 *    otomatis jadi hari libur).
 *  - Hari libur disebar SERATA MUNGKIN supaya TIDAK ADA 2 host di departemen
 *    yang sama libur di tanggal yang sama, kecuali kalau jumlah kebutuhan
 *    libur memang lebih besar dari jumlah hari yang tersedia (baru dipaksa
 *    numpuk, itu pun diseimbangkan sebisa mungkin).
 *  - Urutan host yang "milih duluan" dirotasi tiap minggu (berdasar tanggal
 *    mulai) supaya yang kebagian libur di hari favorit juga bergantian adil,
 *    bukan selalu host yang sama.
 *  - `preferredDates` (opsional) dipakai untuk PAIRING lintas departemen:
 *    misal admin & packing supaya "usahain" libur bareng di tanggal yang
 *    sama (lihat `getDeptRestDatesFromDb` & `computeForcedRestDates`).
 */
function weekRotationOffset(dates, modulo) {
  if (!modulo) return 0;
  const t = new Date(dates[0] + 'T00:00:00').getTime();
  const weekNum = Math.floor(t / (7 * 24 * 3600 * 1000));
  return ((weekNum % modulo) + modulo) % modulo;
}

// Hitung & pasang libur paksa untuk SATU rentang tanggal (idealnya persis 7 hari).
// Dipisah dari `assignRestDays` supaya bisa dipanggil per-chunk mingguan (lihat di bawah).
function assignRestDaysForWindow(dates, deptHosts, approvedLeaveDates, preferredDates) {
  const restMap = new Map(deptHosts.map((h) => [h.id, new Set()]));
  if (!deptHosts.length || !dates.length) return restMap;

  const preferredSet = new Set(preferredDates);
  const restCountByDate = new Map(dates.map((d) => [d, 0]));

  const restNeeded = new Map();
  for (const h of deptHosts) {
    const leaveDates = approvedLeaveDates.get(h.id) || new Set();
    const leaveInWindow = dates.filter((d) => leaveDates.has(d)).length;
    const max = h.max_shifts_per_week ?? 6;
    restNeeded.set(h.id, Math.max(0, dates.length - max - leaveInWindow));
  }

  // Rotasi urutan pemrosesan tiap minggu supaya giliran "pilih duluan" adil dari minggu ke minggu
  const offset = weekRotationOffset(dates, deptHosts.length);
  const rotated = [...deptHosts.slice(offset), ...deptHosts.slice(0, offset)];
  const order = [...rotated].sort((a, b) => (restNeeded.get(b.id) - restNeeded.get(a.id)) || 0);

  for (const h of order) {
    const leaveDates = approvedLeaveDates.get(h.id) || new Set();
    let need = restNeeded.get(h.id);
    while (need > 0) {
      const candidates = dates.filter((d) => !leaveDates.has(d) && !restMap.get(h.id).has(d));
      if (!candidates.length) break;
      candidates.sort((a, b) => {
        const aPref = preferredSet.has(a) ? 0 : 1;
        const bPref = preferredSet.has(b) ? 0 : 1;
        if (aPref !== bPref) return aPref - bPref;
        return restCountByDate.get(a) - restCountByDate.get(b);
      });
      const chosen = candidates[0];
      restMap.get(h.id).add(chosen);
      restCountByDate.set(chosen, restCountByDate.get(chosen) + 1);
      need--;
    }
  }

  return restMap;
}

/**
 * PENTING: `dates` yang masuk ke sini bisa lebih dari 7 hari kalau HR memakai mode
 * "rentang khusus" (field jumlah hari di-generate diisi angka lain dari 7, misal
 * dipakai sekali waktu buat nyambung histori Tangerang yang belum sejalan siklus
 * Minggu-Sabtu). Dulu `restNeeded` dihitung langsung dari SELURUH panjang `dates`
 * (mis. 10 hari - 6 = 4 hari libur paksa per host) -- jauh lebih besar dari jatah
 * libur mingguan yang wajar (harusnya cuma ~1), dan bikin sebagian host libur
 * berhari-hari beruntun sementara yang lain nyaris kerja tanpa jeda. Sekarang
 * `dates` dipecah jadi potongan 7-harian (dari awal rentang) dan jatah libur
 * dihitung PER POTONGAN, supaya rentang custom sepanjang apapun tetap menghasilkan
 * jatah libur yang proporsional per minggu, bukan numpuk di satu rentang besar.
 */
function assignRestDays(dates, deptHosts, approvedLeaveDates, preferredDates = []) {
  const restMap = new Map(deptHosts.map((h) => [h.id, new Set()]));
  if (!deptHosts.length || !dates.length) return restMap;

  for (let i = 0; i < dates.length; i += 7) {
    const chunk = dates.slice(i, i + 7);
    const chunkRest = assignRestDaysForWindow(chunk, deptHosts, approvedLeaveDates, preferredDates);
    for (const [hostId, set] of chunkRest) {
      for (const d of set) restMap.get(hostId).add(d);
    }
  }

  return restMap;
}

// Departemen yang "usahain" libur bareng satu sama lain (best-effort pairing),
// sesuai kesepakatan HR: admin cuma 2 orang, jadi diusahakan 1 admin & 1
// packing libur di tanggal yang sama.
const PAIRED_DEPARTMENTS = { admin: 'packing', packing: 'admin' };

/**
 * Lihat tanggal mana saja yang SUDAH jadi hari libur (ada host yg 0 shift di
 * hari itu) untuk departemen tertentu dari jadwal yang SUDAH tersimpan di DB
 * minggu ini -- dipakai sebagai "preferensi" saat menyusun libur departemen
 * pasangannya (misal packing sudah digenerate duluan, admin ikut nyocokin).
 */
async function getDeptRestDatesFromDb(dates, department, location) {
  if (!department || !location || !dates.length) return new Set();
  const bagRows = (
    await db.execute({
      sql: 'SELECT id FROM bags WHERE department = ? AND location = ? AND active = 1',
      args: [department, location],
    })
  ).rows;
  const bagIds = bagRows.map((b) => b.id);
  if (!bagIds.length) return new Set();

  const hostRows = (
    await db.execute({
      sql: 'SELECT id FROM hosts WHERE department = ? AND location = ? AND active = 1',
      args: [department, location],
    })
  ).rows;
  if (!hostRows.length) return new Set();

  const weekStart = dates[0];
  const weekEnd = dates[dates.length - 1];
  const entries = (
    await db.execute({
      sql: `SELECT date, host_id FROM schedule_entries
            WHERE date BETWEEN ? AND ? AND host_id IS NOT NULL
            AND bag_id IN (${bagIds.map(() => '?').join(',')})`,
      args: [weekStart, weekEnd, ...bagIds],
    })
  ).rows;

  const workedByHost = new Map(); // hostId -> Set(dates worked)
  for (const e of entries) {
    if (!workedByHost.has(e.host_id)) workedByHost.set(e.host_id, new Set());
    workedByHost.get(e.host_id).add(e.date);
  }

  const restDates = new Set();
  for (const h of hostRows) {
    const worked = workedByHost.get(h.id) || new Set();
    for (const d of dates) {
      if (!worked.has(d)) restDates.add(d);
    }
  }
  return restDates;
}

/**
 * Gabungkan cuti yang sudah disetujui + hari libur rotasi (per departemen,
 * anti-bentrok) jadi satu map "tidak tersedia" yang dipakai baik oleh
 * baseline rule-based maupun validasi usulan AI -- jadi aturan "libur harus
 * beda-beda" ini SELALU dijaga di kedua mode, bukan cuma rule-based.
 */
async function computeForcedRestDates(dates, hosts, bags, approvedLeaveDates, location) {
  const merged = new Map();
  for (const [hid, set] of approvedLeaveDates) merged.set(hid, new Set(set));

  const depts = [...new Set(bags.map((b) => b.department))];
  for (const dept of depts) {
    const deptHosts = hosts.filter((h) => h.department === dept);
    if (!deptHosts.length) continue;

    let preferredDates = [];
    const counterpart = PAIRED_DEPARTMENTS[dept];
    if (counterpart && location) {
      preferredDates = [...(await getDeptRestDatesFromDb(dates, counterpart, location))];
    }

    const restMap = assignRestDays(dates, deptHosts, approvedLeaveDates, preferredDates);
    for (const [hid, set] of restMap) {
      if (!merged.has(hid)) merged.set(hid, new Set());
      for (const d of set) merged.get(hid).add(d);
    }
  }

  return merged;
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
  const placed = new Map(); // hostId -> Map(date -> {shifts, bags}), mulai dari histori (buat cek continuity hari pertama minggu ini)
  for (const h of history) {
    markPlaced(h.host_id, h.date, h.shift, h.bag_id, placed);
  }

  const shiftCount = new Map(hosts.map((h) => [h.id, 0])); // buat load-balancing SEKALIGUS batas libur mingguan
  const maxShiftsByHost = new Map(hosts.map((h) => [h.id, h.max_shifts_per_week ?? 6]));
  const assignments = []; // {date, bag_id, shift, host_id}

  // Kalau jumlah host di satu departemen TIDAK CUKUP untuk mengisi semua slot semua
  // bag di hari itu (misal 5 host tapi 2 bag x 3 shift = 6 slot/hari), dulu kode ini
  // selalu mengisi bag pertama (by sort_order) sampai penuh dulu baru bag berikutnya
  // -> akibatnya bag terakhir SELALU yang kehabisan orang, hari demi hari, bukannya
  // kekurangan itu dibagi rata. Diperbaiki dengan 2 langkah:
  //  1. Rotasi urutan prioritas bag tiap hari (bag yang "kebagian belakangan" hari
  //     ini, besok gilirannya di depan).
  //  2. Isi slot per-shift secara interleaved lintas bag (semua Pagi dulu lintas
  //     bag, baru semua Siang, baru semua Malam) bukan bag-per-bag sampai habis --
  //     supaya kalau memang orangnya kurang, yang kosong tersebar di berbagai
  //     bag/shift/hari, bukan selalu bag & shift yang sama.
  // CATATAN: ini TIDAK menambah kapasitas -- kalau total slot yang dibutuhkan per
  // minggu (jumlah bag x shift x 7 hari) lebih besar dari total kapasitas host
  // (jumlah host x max_shifts_per_week), akan tetap ada slot kosong. Itu artinya
  // perlu nambah host / kurangi shift, bukan cuma soal urutan algoritma.
  dates.forEach((date, dateIdx) => {
    const bagOffset = bags.length ? dateIdx % bags.length : 0;
    const rotatedBags = [...bags.slice(bagOffset), ...bags.slice(0, bagOffset)];
    const maxShiftSlots = Math.max(0, ...rotatedBags.map((b) => (DEPT_SHIFTS[b.department] || SHIFTS).length));

    for (let shiftIdx = 0; shiftIdx < maxShiftSlots; shiftIdx++) {
      for (const bag of rotatedBags) {
        const shiftsForBag = DEPT_SHIFTS[bag.department] || SHIFTS;
        const shift = shiftsForBag[shiftIdx];
        if (!shift) continue; // bag ini tidak punya shift ke-N (mis. admin cuma 2 shift)

        // urutkan host by paling sedikit shift dulu (fairness), hanya dari department yang sama dengan bag
        const candidates = hosts
          .filter((h) => h.department === bag.department)
          .filter((h) => isAllowed(h.id, date, shift, bag.id, placed, approvedLeaveDates, shiftCount, maxShiftsByHost))
          .sort((a, b) => shiftCount.get(a.id) - shiftCount.get(b.id));

        const chosen = candidates[0];
        if (chosen) {
          markPlaced(chosen.id, date, shift, bag.id, placed);
          shiftCount.set(chosen.id, shiftCount.get(chosen.id) + 1);
          assignments.push({ date, bag_id: bag.id, shift, host_id: chosen.id });
        } else {
          assignments.push({ date, bag_id: bag.id, shift, host_id: null }); // slot kosong, HR isi manual
        }
      }
    }
  });

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
2. Seorang host MAKSIMAL 1 shift per HARI, di bag manapun -- TIDAK BOLEH muncul 2x di tanggal yang sama, baik di bag yang sama maupun bag berbeda.
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
  for (const h of history) markPlaced(h.host_id, h.date, h.shift, h.bag_id, placed);
  for (const a of baseline) if (a.host_id) markPlaced(a.host_id, a.date, a.shift, a.bag_id, placed);

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
      unmarkPlaced(oldHostId, c.date, c.shift, bagId, placed);
      shiftCount.set(oldHostId, Math.max(0, (shiftCount.get(oldHostId) || 0) - 1));
    }

    if (isAllowed(hostId, c.date, c.shift, bagId, placed, approvedLeaveDates, shiftCount, maxShiftsByHost)) {
      markPlaced(hostId, c.date, c.shift, bagId, placed);
      shiftCount.set(hostId, (shiftCount.get(hostId) || 0) + 1);
      validChanges.push({ date: c.date, bag_id: bagId, shift: c.shift, host_id: hostId });
    } else if (oldHostId) {
      // gagal validasi, kembalikan slot lama biar konsisten
      markPlaced(oldHostId, c.date, c.shift, bagId, placed);
      shiftCount.set(oldHostId, (shiftCount.get(oldHostId) || 0) + 1);
    }
  }

  return { changes: validChanges, summary: parsed.summary || '', keyUsed };
}

/**
 * Entry point utama. Generate jadwal untuk 1 minggu (weekStart = tanggal Minggu/Sunday, format YYYY-MM-DD).
 * Entry yang sudah `locked` (di-override manual oleh HR) tidak akan ditimpa.
 */
async function generateWeeklySchedule(weekStart, { bagIds = null, department = null, location = null, useAI = true, days = 7 } = {}) {
  const dates = weekDates(weekStart, days);
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

  // Hari libur dihitung LEBIH DULU secara eksplisit per departemen (anti-bentrok
  // antar host satu departemen, + usahain admin & packing libur bareng), baru
  // dipakai sebagai batasan "tidak tersedia" yang sama seperti cuti disetujui.
  const forcedUnavailable = await computeForcedRestDates(dates, hosts, bags, approvedLeaveDates, location);

  let baseline = generateBaseline(dates, bags, hosts, forcedUnavailable, history);
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
        approvedLeaveDates: forcedUnavailable,
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
