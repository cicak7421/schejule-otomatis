const VIEWS = {
  schedule: renderScheduleView,
  hosts: renderHostsView,
  bags: renderBagsView,
  leaves: renderLeavesView,
  shiftRequests: renderShiftRequestsView,
};

async function switchView(name) {
  document.querySelectorAll('.nav-item').forEach((n) => n.classList.toggle('active', n.dataset.view === name));
  const container = document.getElementById('view');
  container.innerHTML = '<div class="empty-state">Memuat...</div>';
  try {
    await VIEWS[name](container);
  } catch (err) {
    container.innerHTML = `<div class="empty-state">Gagal memuat: ${err.message}</div>`;
  }
}

document.querySelectorAll('.nav-item').forEach((item) => {
  item.addEventListener('click', () => switchView(item.dataset.view));
});

document.getElementById('logoutBtn').addEventListener('click', async () => {
  await apiFetch('/api/auth/logout', { method: 'POST' });
  window.location.href = '/login.html';
});

(async function init() {
  try {
    const me = await apiFetch('/api/auth/me');
    document.getElementById('userBox').textContent = `Login sebagai ${me.username} (${me.role})`;
  } catch {
    /* apiFetch sudah redirect ke login kalau 401 */
  }
  switchView('schedule');
})();
