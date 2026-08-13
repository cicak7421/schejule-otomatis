async function renderLeavesView(container) {
  container.innerHTML = '';
  container.appendChild(el('h1', { class: 'page-title', text: 'Request Libur' }));
  container.appendChild(el('p', { class: 'page-sub', text: 'Tinjau permintaan libur dari host. Menyetujui akan otomatis mengosongkan slot jadwal yang belum dikunci.' }));

  const linkPanel = el('div', { class: 'panel' });
  linkPanel.appendChild(el('div', { class: 'row', html: `Link untuk dibagikan ke host: <a href="/request-libur.html" target="_blank" style="color:var(--accent);font-weight:700;">/request-libur.html</a>` }));
  container.appendChild(linkPanel);

  const listPanel = el('div', { class: 'panel' });
  const leaves = await apiFetch('/api/leaves');
  if (!leaves.length) {
    listPanel.appendChild(el('div', { class: 'empty-state', text: 'Belum ada permintaan libur.' }));
  } else {
    const table = el('table');
    table.appendChild(el('thead', {}, el('tr', {}, [
      el('th', { text: 'Host' }), el('th', { text: 'Tanggal' }), el('th', { text: 'Alasan' }), el('th', { text: 'Status' }), el('th', { text: 'Aksi' }),
    ])));
    const tbody = el('tbody');
    for (const lr of leaves) {
      const tr = el('tr');
      tr.appendChild(el('td', { text: lr.host_name }));
      tr.appendChild(el('td', { text: lr.date_start === lr.date_end ? lr.date_start : `${lr.date_start} — ${lr.date_end}` }));
      tr.appendChild(el('td', { text: lr.reason || '-' }));
      tr.appendChild(el('td', {}, el('span', { class: 'badge ' + lr.status, text: labelStatus(lr.status) })));
      const actionsTd = el('td');
      if (lr.status === 'pending') {
        const approveBtn = el('button', { class: 'btn sm secondary' }, 'Setujui');
        const rejectBtn = el('button', { class: 'btn sm danger', style: 'margin-left:6px;' }, 'Tolak');
        approveBtn.addEventListener('click', () => reviewLeave(container, lr.id, 'approved'));
        rejectBtn.addEventListener('click', () => reviewLeave(container, lr.id, 'rejected'));
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

async function reviewLeave(container, id, status) {
  try {
    await apiFetch(`/api/leaves/${id}/review`, { method: 'POST', body: JSON.stringify({ status }) });
    showToast(status === 'approved' ? 'Permintaan disetujui' : 'Permintaan ditolak');
    renderLeavesView(container);
  } catch (err) {
    showToast(err.message, true);
  }
}

function labelStatus(s) {
  return { pending: 'Menunggu', approved: 'Disetujui', rejected: 'Ditolak' }[s] || s;
}
