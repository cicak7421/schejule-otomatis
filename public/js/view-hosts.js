const HOST_DEPT_LABEL = { host_live: 'Host Live', packing: 'Packing', admin: 'Admin' };
const HOST_LOC_LABEL = { jakarta: 'Jakarta', tangerang: 'Tangerang' };
let _hostsFilterDept = 'host_live';
let _hostsFilterLoc = 'jakarta';

async function renderHostsView(container) {
  container.innerHTML = '';
  container.appendChild(el('h1', { class: 'page-title', text: 'Host / Staff' }));
  container.appendChild(el('p', { class: 'page-sub', text: 'Kelola daftar orang yang bisa dijadwalkan: Host Live, Packing, atau Admin' }));
  container.appendChild(el('p', { class: 'page-sub', text: '💡 "Maks Shift/Minggu" otomatis dijaga saat Generate — misal diisi 6, sistem akan berhenti menempatkan orang itu setelah 6 shift supaya minimal ada 1 hari libur dalam seminggu.' }));

  const formPanel = el('div', { class: 'panel' });
  const nameInput = el('input', { placeholder: 'Nama baru', style: 'min-width:200px;' });
  const locSelect = el('select', { style: 'min-width:140px;' }, [
    el('option', { value: 'jakarta' }, 'Jakarta'),
    el('option', { value: 'tangerang' }, 'Tangerang'),
  ]);
  const deptSelect = el('select', { style: 'min-width:160px;' }, [
    el('option', { value: 'host_live' }, 'Host Live'),
    el('option', { value: 'packing' }, 'Packing'),
    el('option', { value: 'admin' }, 'Admin'),
  ]);
  const maxInput = el('input', { type: 'number', placeholder: 'Maks shift/minggu', value: '6', style: 'width:150px;' });
  const addBtn = el('button', {}, 'Tambah');
  formPanel.appendChild(el('div', { class: 'row' }, [
    el('div', { class: 'field', style: 'margin:0;' }, [el('label', { text: 'Nama' }), nameInput]),
    el('div', { class: 'field', style: 'margin:0;' }, [el('label', { text: 'Lokasi' }), locSelect]),
    el('div', { class: 'field', style: 'margin:0;' }, [el('label', { text: 'Departemen' }), deptSelect]),
    el('div', { class: 'field', style: 'margin:0;' }, [el('label', { text: 'Maks shift/minggu' }), maxInput]),
    el('div', { style: 'margin-top:18px;' }, addBtn),
  ]));
  container.appendChild(formPanel);

  addBtn.addEventListener('click', async () => {
    if (!nameInput.value.trim()) return showToast('Nama wajib diisi', true);
    try {
      await apiFetch('/api/hosts', {
        method: 'POST',
        body: JSON.stringify({
          name: nameInput.value.trim(),
          department: deptSelect.value,
          location: locSelect.value,
          max_shifts_per_week: Number(maxInput.value) || 6,
        }),
      });
      showToast('Berhasil ditambahkan');
      renderHostsView(container);
    } catch (err) {
      showToast(err.message, true);
    }
  });

  // Tab filter lokasi -- host Jakarta & Tangerang benar-benar terpisah
  const locRow = el('div', { class: 'row', style: 'gap:8px;margin-bottom:8px;' });
  for (const [id, label] of Object.entries(HOST_LOC_LABEL)) {
    const btn = el('button', {
      class: 'btn sm ' + (_hostsFilterLoc === id ? '' : 'ghost'),
      onclick: () => { _hostsFilterLoc = id; renderHostsView(container); },
    }, '📍 ' + label);
    locRow.appendChild(btn);
  }
  container.appendChild(locRow);

  // Tab filter departemen
  const tabRow = el('div', { class: 'row', style: 'gap:8px;margin-bottom:14px;' });
  for (const [id, label] of Object.entries(HOST_DEPT_LABEL)) {
    const btn = el('button', {
      class: 'btn sm ' + (_hostsFilterDept === id ? '' : 'ghost'),
      onclick: () => { _hostsFilterDept = id; renderHostsView(container); },
    }, label);
    tabRow.appendChild(btn);
  }
  container.appendChild(tabRow);

  const listPanel = el('div', { class: 'panel' });
  const hosts = await apiFetch(`/api/hosts?department=${_hostsFilterDept}&location=${_hostsFilterLoc}`);
  if (!hosts.length) {
    listPanel.appendChild(el('div', { class: 'empty-state', text: `Belum ada orang di ${HOST_LOC_LABEL[_hostsFilterLoc]} - departemen ${HOST_DEPT_LABEL[_hostsFilterDept]}.` }));
  } else {
    const table = el('table');
    table.appendChild(el('thead', {}, el('tr', {}, [
      el('th', { text: 'Nama' }), el('th', { text: 'Lokasi' }), el('th', { text: 'Departemen' }), el('th', { text: 'Status' }), el('th', { text: 'Maks Shift/Minggu' }), el('th', { text: 'Aksi' }),
    ])));
    const tbody = el('tbody');
    for (const h of hosts) {
      const tr = el('tr');
      tr.appendChild(el('td', { text: h.name }));
      tr.appendChild(el('td', { text: HOST_LOC_LABEL[h.location] || h.location }));
      tr.appendChild(el('td', { text: HOST_DEPT_LABEL[h.department] || h.department }));
      tr.appendChild(el('td', {}, el('span', { class: 'badge ' + (h.active ? 'active' : 'inactive'), text: h.active ? 'Aktif' : 'Nonaktif' })));
      tr.appendChild(el('td', { text: String(h.max_shifts_per_week) }));
      const actionsTd = el('td');
      const toggleBtn = el('button', { class: 'btn sm ' + (h.active ? 'danger' : 'secondary') }, h.active ? 'Nonaktifkan' : 'Aktifkan');
      toggleBtn.addEventListener('click', async () => {
        await apiFetch(`/api/hosts/${h.id}`, { method: 'PUT', body: JSON.stringify({ active: h.active ? 0 : 1 }) });
        showToast('Status diperbarui');
        renderHostsView(container);
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
