const SHIFT_LABELS = { P: 'Pagi', S: 'Siang', M: 'Malam', MID: 'Middle' };
const DAY_NAMES = ['Minggu', 'Senin', 'Selasa', 'Rabu', 'Kamis', "Jumat", 'Sabtu'];
const DEPT_TABS = [
  { id: 'host_live', label: '🎥 Host Live' },
  { id: 'packing', label: '📦 Packing' },
  { id: 'admin', label: '🗂️ Admin' },
];
const LOCATION_TABS = [
  { id: 'jakarta', label: '📍 Jakarta' },
  { id: 'tangerang', label: '📍 Tangerang' },
];

let _scheduleState = { weekStart: weekStartOf(new Date()), department: 'host_live', location: 'jakarta', days: 7 };

// Senin dipakai sebagai hari pertama dalam seminggu (semua lokasi, Jakarta
// maupun Tangerang, sekarang memakai siklus mingguan yang sama: Senin-Minggu).
function weekStartOf(date) {
  const d = new Date(date);
  const day = d.getDay(); // 0 = Minggu ... 6 = Sabtu
  const diffToMonday = (day + 6) % 7; // Minggu(0) -> 6 hari mundur ke Senin lalu
  d.setDate(d.getDate() - diffToMonday);
  return d.toISOString().slice(0, 10);
}

function addDays(dateStr, n) {
  const d = new Date(dateStr + 'T00:00:00');
  d.setDate(d.getDate() + n);
  return d.toISOString().slice(0, 10);
}

function fmtDateLabel(dateStr) {
  const d = new Date(dateStr + 'T00:00:00');
  return `${DAY_NAMES[d.getDay()]}, ${d.getDate()}/${d.getMonth() + 1}`;
}

async function renderScheduleView(container) {
  const weekStart = _scheduleState.weekStart;
  const department = _scheduleState.department || 'host_live';
  const location = _scheduleState.location || 'jakarta';
  const days = _scheduleState.days || 7;
  container.innerHTML = '';
  container.appendChild(el('h1', { class: 'page-title', text: 'Jadwal Mingguan' }));
  container.appendChild(el('p', { class: 'page-sub', text: 'Kelola & generate jadwal Host Live, Packing, dan Admin otomatis dengan bantuan AI' }));

  // Tab lokasi -- Jakarta & Tangerang benar-benar terpisah (host/bag tidak
  // pernah tertukar antar lokasi), jadi ini dipilih dulu sebelum departemen.
  const locRow = el('div', { class: 'row', style: 'gap:8px;margin-bottom:8px;' });
  for (const tab of LOCATION_TABS) {
    const btn = el('button', {
      class: 'btn sm ' + (location === tab.id ? '' : 'ghost'),
      onclick: () => { _scheduleState.location = tab.id; renderScheduleView(container); },
    }, tab.label);
    locRow.appendChild(btn);
  }
  container.appendChild(locRow);

  // Tab departemen
  const tabRow = el('div', { class: 'row', style: 'gap:8px;margin-bottom:14px;' });
  for (const tab of DEPT_TABS) {
    const btn = el('button', {
      class: 'btn sm ' + (department === tab.id ? '' : 'ghost'),
      onclick: () => { _scheduleState.department = tab.id; renderScheduleView(container); },
    }, tab.label);
    tabRow.appendChild(btn);
  }
  container.appendChild(tabRow);

  const controls = el('div', { class: 'panel' });
  const weekRow = el('div', { class: 'row between' });
  const leftControls = el('div', { class: 'row' }, [
    el('button', { class: 'btn ghost sm', onclick: () => { _scheduleState.weekStart = addDays(weekStart, -7); renderScheduleView(container); } }, '‹ Minggu lalu'),
    // Catatan: tanggal yang dipilih di sini TIDAK dipaksa ke hari Minggu lagi,
    // supaya bisa dipakai buat generate rentang khusus (mis. mulai Sabtu)
    // waktu menyambung histori yang belum sejalan ke siklus mingguan biasa.
    el('input', { type: 'date', id: 'weekPicker', value: weekStart, onchange: (e) => { _scheduleState.weekStart = e.target.value; renderScheduleView(container); } }),
    el('button', { class: 'btn ghost sm', onclick: () => { _scheduleState.weekStart = addDays(weekStart, 7); renderScheduleView(container); } }, 'Minggu depan ›'),
    el('label', { style: 'display:flex;align-items:center;gap:6px;font-size:12.5px;color:var(--muted);margin-left:6px;' }, [
      el('span', { text: 'Jumlah hari' }),
      el('input', {
        type: 'number', min: '1', max: '31', value: String(days), style: 'width:60px;padding:6px;',
        onchange: (e) => { _scheduleState.days = Math.min(31, Math.max(1, parseInt(e.target.value, 10) || 7)); renderScheduleView(container); },
      }),
    ]),
  ]);
  const rightControls = el('div', { class: 'row' }, [
    el('button', { class: 'btn secondary', onclick: () => doGenerate(container, weekStart, department, location, false, days) }, '⚙️ Generate Rule-based'),
    el('button', { class: 'btn', onclick: () => doGenerate(container, weekStart, department, location, true, days) }, '✨ Generate dengan AI'),
  ]);
  weekRow.appendChild(leftControls);
  weekRow.appendChild(rightControls);
  controls.appendChild(weekRow);
  if (days !== 7) {
    controls.appendChild(el('p', { class: 'page-sub', style: 'margin:8px 0 0;', text: `Mode rentang khusus: ${days} hari mulai ${fmtDateLabel(weekStart)}. Set ulang ke 7 buat kembali ke mode mingguan biasa.` }));
  }
  container.appendChild(controls);

  const data = await apiFetch(`/api/schedule/week/${weekStart}?department=${department}&location=${location}&days=${days}`);
  // Tiap bag punya daftar shift-nya sendiri (mis. Tangerang cuma Pagi & Siang,
  // tanpa Malam) -- jangan diseragamkan, supaya tidak ada kolom kosong percuma.
  for (const b of data.bags) b.shifts_list = b.shifts_list && b.shifts_list.length ? b.shifts_list : ['P', 'S', 'M'];

  if (data.lastLog && data.lastLog.summary) {
    container.appendChild(el('div', {
      class: 'summary-box',
      html: `<strong>Insight AI:</strong> ${escapeHtml(data.lastLog.summary)}`
    }));
  }

  if (!data.bags.length) {
    container.appendChild(el('div', { class: 'empty-state', text: 'Belum ada tim/bag aktif untuk departemen ini. Tambahkan dulu di menu "Bag / Akun" (khusus Host Live) atau hubungi admin sistem.' }));
    return;
  }
  if (!data.hosts.length) {
    container.appendChild(el('div', { class: 'empty-state', text: 'Belum ada orang aktif di departemen ini. Tambahkan dulu di menu "Host / Staff".' }));
    return;
  }

  const entryMap = new Map();
  for (const e of data.entries) entryMap.set(`${e.date}|${e.bag_id}|${e.shift}`, e);
  const eventDateSet = new Set(data.eventDates || []);

  if (eventDateSet.size) {
    container.appendChild(el('div', {
      class: 'summary-box event',
      html: `<strong>📅 Ada tanggal event minggu ini:</strong> ${[...eventDateSet].map(fmtDateLabel).join(', ')} — usahakan tidak ada yang libur di tanggal ini.`
    }));
  }

  const panel = el('div', { class: 'panel', style: 'overflow-x:auto;' });
  const table = el('table', { class: 'sched-table' });

  const headRow1 = el('tr');
  headRow1.appendChild(el('th', { text: 'TANGGAL' }));
  for (const bag of data.bags) headRow1.appendChild(el('th', { colspan: String(bag.shifts_list.length), text: bag.name }));
  const headRow2 = el('tr');
  headRow2.appendChild(el('th', {}));
  for (const bag of data.bags) {
    bag.shifts_list.forEach((s) => headRow2.appendChild(el('th', { text: SHIFT_LABELS[s] || s })));
  }
  const thead = el('thead', {}, [headRow1, headRow2]);
  table.appendChild(thead);

  const tbody = el('tbody');
  for (const date of data.dates) {
    const dow = new Date(date + 'T00:00:00').getDay();
    const isWeekend = dow === 0 || dow === 6;
    const isEvent = eventDateSet.has(date);
    const tr = el('tr', { class: (isWeekend ? 'weekend-row' : '') + (isEvent ? ' event-row' : '') });
    tr.appendChild(el('td', { class: 'sched-date-col' + (isWeekend ? ' weekend' : ''), text: fmtDateLabel(date) + (isEvent ? ' 📅' : '') }));
    for (const bag of data.bags) {
      for (const shift of bag.shifts_list) {
        const entry = entryMap.get(`${date}|${bag.id}|${shift}`);
        const td = el('td', { class: 'slot-cell' + (entry?.locked ? ' locked' : '') + (entry?.source === 'ai' ? ' ai' : '') + (!entry?.host_id ? ' empty' : '') });
        const select = el('select', { class: 'slot-select' });
        select.appendChild(el('option', { value: '' }, '— kosong —'));
        for (const h of data.hosts) {
          const opt = el('option', { value: h.id }, h.name);
          if (entry && entry.host_id === h.id) opt.setAttribute('selected', 'selected');
          select.appendChild(opt);
        }
        select.addEventListener('change', async () => {
          try {
            await apiFetch('/api/schedule/entry', {
              method: 'PUT',
              body: JSON.stringify({ date, bag_id: bag.id, shift, host_id: select.value ? Number(select.value) : null }),
            });
            showToast('Slot diperbarui');
            renderScheduleView(container);
          } catch (err) {
            showToast(err.message, true);
          }
        });
        td.appendChild(select);
        if (entry?.locked) td.appendChild(el('span', { class: 'lock-icon', title: 'Dikunci manual, klik untuk buka kunci', onclick: async (ev) => {
          ev.stopPropagation();
          await apiFetch('/api/schedule/entry/unlock', { method: 'PUT', body: JSON.stringify({ date, bag_id: bag.id, shift }) });
          showToast('Kunci dibuka, slot ini bisa digenerate ulang');
          renderScheduleView(container);
        } }, '🔒'));
        tr.appendChild(td);
      }
    }
    tbody.appendChild(tr);
  }
  table.appendChild(tbody);
  panel.appendChild(table);
  container.appendChild(panel);

  container.appendChild(el('p', { class: 'page-sub', html: 'latar hijau muda = hasil AI &nbsp;•&nbsp; ganti orang langsung lewat dropdown, tetap bisa ditimpa ulang oleh Generate berikutnya &nbsp;•&nbsp; 🔒 = sisa entri histori lama yang dikunci, klik untuk buka kunci' }));
}

async function doGenerate(container, weekStart, department, location, useAI, days) {
  try {
    showToast(useAI ? 'Meminta AI menyusun jadwal...' : 'Menyusun jadwal rule-based...');
    const result = await apiFetch('/api/schedule/generate', {
      method: 'POST',
      body: JSON.stringify({ weekStart, department, location, useAI, days: days || 7 }),
    });
    showToast(`Jadwal minggu ${weekStart} berhasil dibuat (${result.count} slot)`);
    renderScheduleView(container);
  } catch (err) {
    showToast(err.message, true);
  }
}

function escapeHtml(str) {
  return String(str).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}
