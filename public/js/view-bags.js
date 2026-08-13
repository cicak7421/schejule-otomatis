const BAG_LOC_LABEL = { jakarta: 'Jakarta', tangerang: 'Tangerang' };
let _bagsFilterLoc = 'jakarta';

async function renderBagsView(container) {
  container.innerHTML = '';
  container.appendChild(el('h1', { class: 'page-title', text: 'Bag / Akun Live' }));
  container.appendChild(el('p', { class: 'page-sub', text: 'Kelola akun live (bag) yang butuh dijadwalkan host-nya. Bisa nambah kapan saja. (Khusus Host Live — untuk Packing/Admin cukup tambah orangnya di menu "Host / Staff".)' }));

  const formPanel = el('div', { class: 'panel' });
  const nameInput = el('input', { placeholder: 'Nama bag baru, mis. HITS BAG', style: 'min-width:220px;' });
  const locSelect = el('select', { style: 'min-width:140px;' }, [
    el('option', { value: 'jakarta' }, 'Jakarta'),
    el('option', { value: 'tangerang' }, 'Tangerang'),
  ]);
  const addBtn = el('button', {}, 'Tambah Bag');
  formPanel.appendChild(el('div', { class: 'row' }, [
    el('div', { class: 'field', style: 'margin:0;' }, [el('label', { text: 'Nama Bag' }), nameInput]),
    el('div', { class: 'field', style: 'margin:0;' }, [el('label', { text: 'Lokasi' }), locSelect]),
    el('div', { style: 'margin-top:18px;' }, addBtn),
  ]));
  container.appendChild(formPanel);

  addBtn.addEventListener('click', async () => {
    if (!nameInput.value.trim()) return showToast('Nama bag wajib diisi', true);
    try {
      await apiFetch('/api/bags', { method: 'POST', body: JSON.stringify({ name: nameInput.value.trim(), location: locSelect.value }) });
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
      el('th', { text: 'Nama Bag' }), el('th', { text: 'Lokasi' }), el('th', { text: 'Status' }), el('th', { text: 'Aksi' }),
    ])));
    const tbody = el('tbody');
    for (const b of bags) {
      const tr = el('tr');
      tr.appendChild(el('td', { text: b.name }));
      tr.appendChild(el('td', { text: BAG_LOC_LABEL[b.location] || b.location }));
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
