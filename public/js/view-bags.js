const BAG_LOC_LABEL = { jakarta: 'Jakarta', tangerang: 'Tangerang' };
const BAG_SHIFT_OPTIONS = [
  { id: 'P', label: 'Pagi' },
  { id: 'S', label: 'Siang' },
  { id: 'M', label: 'Malam' },
];
let _bagsFilterLoc = 'jakarta';

function shiftCheckboxRow(checkedShifts) {
  const wrap = el('div', { class: 'row', style: 'gap:12px;' });
  const boxes = {};
  for (const opt of BAG_SHIFT_OPTIONS) {
    const cb = el('input', { type: 'checkbox' });
    cb.checked = checkedShifts.includes(opt.id);
    boxes[opt.id] = cb;
    wrap.appendChild(el('label', { style: 'display:flex;align-items:center;gap:5px;font-weight:600;color:var(--ink);text-transform:none;' }, [cb, opt.label]));
  }
  wrap.getChecked = () => BAG_SHIFT_OPTIONS.map((o) => o.id).filter((id) => boxes[id].checked);
  return wrap;
}

async function renderBagsView(container) {
  container.innerHTML = '';
  container.appendChild(el('h1', { class: 'page-title', text: 'Bag / Akun Live' }));
  container.appendChild(el('p', { class: 'page-sub', text: 'Kelola akun live (bag) yang butuh dijadwalkan host-nya. Bisa nambah kapan saja. Centang shift yang benar-benar dibuka bag ini -- kalau bag tidak buka Malam, jangan dicentang, biar jadwal tidak penuh "kosong" percuma. (Khusus Host Live — untuk Packing/Admin cukup tambah orangnya di menu "Host / Staff".)' }));

  const formPanel = el('div', { class: 'panel' });
  const nameInput = el('input', { placeholder: 'Nama bag baru, mis. HITS BAG', style: 'min-width:220px;' });
  const locSelect = el('select', { style: 'min-width:140px;' }, [
    el('option', { value: 'jakarta' }, 'Jakarta'),
    el('option', { value: 'tangerang' }, 'Tangerang'),
  ]);
  const newShiftBoxes = shiftCheckboxRow(['P', 'S', 'M']);
  const addBtn = el('button', {}, 'Tambah Bag');
  formPanel.appendChild(el('div', { class: 'row' }, [
    el('div', { class: 'field', style: 'margin:0;' }, [el('label', { text: 'Nama Bag' }), nameInput]),
    el('div', { class: 'field', style: 'margin:0;' }, [el('label', { text: 'Lokasi' }), locSelect]),
    el('div', { class: 'field', style: 'margin:0;' }, [el('label', { text: 'Shift dibuka' }), newShiftBoxes]),
    el('div', { style: 'margin-top:18px;' }, addBtn),
  ]));
  container.appendChild(formPanel);

  addBtn.addEventListener('click', async () => {
    if (!nameInput.value.trim()) return showToast('Nama bag wajib diisi', true);
    const shifts = newShiftBoxes.getChecked();
    if (!shifts.length) return showToast('Pilih minimal 1 shift', true);
    try {
      await apiFetch('/api/bags', { method: 'POST', body: JSON.stringify({ name: nameInput.value.trim(), location: locSelect.value, shifts }) });
      showToast('Bag ditambahkan');
      renderBagsView(container);
    } catch (err) {
      showToast(err.message, true);
    }
  });

  // Tab filter lokasi -- bag Jakarta & Tangerang benar-benar terpisah
  const locRow = el('div', { class: 'row', style: 'gap:8px;margin-bottom:14px;' });
  for (const [id, label] of Object.entries(BAG_LOC_LABEL)) {
    const btn = el('button', {
      class: 'btn sm ' + (_bagsFilterLoc === id ? '' : 'ghost'),
      onclick: () => { _bagsFilterLoc = id; renderBagsView(container); },
    }, '📍 ' + label);
    locRow.appendChild(btn);
  }
  container.appendChild(locRow);

  const listPanel = el('div', { class: 'panel' });
  const bags = await apiFetch(`/api/bags?department=host_live&location=${_bagsFilterLoc}`);
  if (!bags.length) {
    listPanel.appendChild(el('div', { class: 'empty-state', text: `Belum ada bag di ${BAG_LOC_LABEL[_bagsFilterLoc]}.` }));
  } else {
    const table = el('table');
    table.appendChild(el('thead', {}, el('tr', {}, [
      el('th', { text: 'Nama Bag' }), el('th', { text: 'Lokasi' }), el('th', { text: 'Shift Dibuka' }), el('th', { text: 'Status' }), el('th', { text: 'Aksi' }),
    ])));
    const tbody = el('tbody');
    for (const b of bags) {
      const tr = el('tr');
      tr.appendChild(el('td', { text: b.name }));
      tr.appendChild(el('td', { text: BAG_LOC_LABEL[b.location] || b.location }));
      const currentShifts = b.shifts ? b.shifts.split(',').map((s) => s.trim()) : ['P', 'S', 'M'];
      const shiftTd = el('td');
      const shiftBoxes = shiftCheckboxRow(currentShifts);
      shiftTd.appendChild(shiftBoxes);
      const saveShiftBtn = el('button', { class: 'btn sm secondary', style: 'margin-top:6px;' }, 'Simpan shift');
      saveShiftBtn.addEventListener('click', async () => {
        const shifts = shiftBoxes.getChecked();
        if (!shifts.length) return showToast('Pilih minimal 1 shift', true);
        await apiFetch(`/api/bags/${b.id}`, { method: 'PUT', body: JSON.stringify({ shifts }) });
        showToast('Shift bag diperbarui');
        renderBagsView(container);
      });
      shiftTd.appendChild(saveShiftBtn);
      tr.appendChild(shiftTd);
      tr.appendChild(el('td', {}, el('span', { class: 'badge ' + (b.active ? 'active' : 'inactive'), text: b.active ? 'Aktif' : 'Nonaktif' })));
      const actionsTd = el('td');
      const toggleBtn = el('button', { class: 'btn sm ' + (b.active ? 'danger' : 'secondary') }, b.active ? 'Nonaktifkan' : 'Aktifkan');
      toggleBtn.addEventListener('click', async () => {
        await apiFetch(`/api/bags/${b.id}`, { method: 'PUT', body: JSON.stringify({ active: b.active ? 0 : 1 }) });
        showToast('Status bag diperbarui');
        renderBagsView(container);
      });
      actionsTd.appendChild(toggleBtn);
      tr.appendChild(actionsTd);
      tbody.appendChild(tr);
    }
    table.appendChild(tbody);
    listPanel.appendChild(table);
  }
  container.appendChild(listPanel);
}
