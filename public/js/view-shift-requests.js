const SHIFT_REQ_LABEL = { P: 'Pagi', S: 'Siang', M: 'Malam', MID: 'Middle' };

async function renderShiftRequestsView(container) {
  container.innerHTML = '';
  container.appendChild(el('h1', { class: 'page-title', text: 'Request Shift' }));
  container.appendChild(el('p', { class: 'page-sub', text: 'Tinjau permintaan host yang minta ditempatkan di shift tertentu. Menyetujui akan langsung mengisi & mengunci slot jadwal terkait.' }));

  const linkPanel = el('div', { class: 'panel' });
  linkPanel.appendChild(el('div', { class: 'row', html: `Link untuk dibagikan ke host: <a href="/request-libur.html" target="_blank" style="color:var(--accent);font-weight:700;">/request-libur.html</a> (tab "Request Shift")` }));
  container.appendChild(linkPanel);

  const listPanel = el('div', { class: 'panel' });
  const requests = await apiFetch('/api/shift-requests');
  if (!requests.length) {
    listPanel.appendChild(el('div', { class: 'empty-state', text: 'Belum ada permintaan shift.' }));
  } else {
    const table = el('table');
    table.appendChild(el('thead', {}, el('tr', {}, [
      el('th', { text: 'Host' }), el('th', { text: 'Tanggal' }), el('th', { text: 'Bag' }), el('th', { text: 'Shift' }), el('th', { text: 'Alasan' }), el('th', { text: 'Status' }), el('th', { text: 'Aksi' }),
    ])));
    const tbody = el('tbody');
    for (const sr of requests) {
      const tr = el('tr');
      tr.appendChild(el('td', { text: sr.host_name }));
      tr.appendChild(el('td', { text: sr.date }));
      tr.appendChild(el('td', { text: sr.bag_name }));
      tr.appendChild(el('td', { text: SHIFT_REQ_LABEL[sr.shift] || sr.shift }));
      tr.appendChild(el('td', { text: sr.reason || '-' }));
      tr.appendChild(el('td', {}, el('span', { class: 'badge ' + sr.status, text: labelShiftStatus(sr.status) })));
      const actionsTd = el('td');
      if (sr.status === 'pending') {
        const approveBtn = el('button', { class: 'btn sm secondary' }, 'Setujui');
        const rejectBtn = el('button', { class: 'btn sm danger', style: 'margin-left:6px;' }, 'Tolak');
        approveBtn.addEventListener('click', () => reviewShiftRequest(container, sr.id, 'approved'));
        rejectBtn.addEventListener('click', () => reviewShiftRequest(container, sr.id, 'rejected'));
        actionsTd.appendChild(approveBtn);
        actionsTd.appendChild(rejectBtn);
      } else {
        actionsTd.appendChild(el('span', { class: 'page-sub', text: '—' }));
      }
      tr.appendChild(actionsTd);
      tbody.appendChild(tr);
    }
    table.appendChild(tbody);
    listPanel.appendChild(table);
  }
  container.appendChild(listPanel);
}

async function reviewShiftRequest(container, id, status) {
  try {
    await apiFetch(`/api/shift-requests/${id}/review`, { method: 'POST', body: JSON.stringify({ status }) });
    showToast(status === 'approved' ? 'Permintaan shift disetujui & slot jadwal diisi' : 'Permintaan shift ditolak');
    renderShiftRequestsView(container);
  } catch (err) {
    showToast(err.message, true);
  }
}

function labelShiftStatus(s) {
  return { pending: 'Menunggu', approved: 'Disetujui', rejected: 'Ditolak' }[s] || s;
}
