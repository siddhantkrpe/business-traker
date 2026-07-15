// ---------- DATABASE (sql.js / SQLite, runs entirely in the browser) ----------
const SCHEMA_SQL = `
PRAGMA foreign_keys = ON;
CREATE TABLE IF NOT EXISTS clients (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  category TEXT NOT NULL DEFAULT 'other',
  phone TEXT,
  email TEXT,
  status TEXT NOT NULL DEFAULT 'in progress',
  notes TEXT,
  created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS payments (
  id TEXT PRIMARY KEY,
  client_id TEXT NOT NULL REFERENCES clients(id) ON DELETE CASCADE,
  type TEXT NOT NULL CHECK (type IN ('charge','payment')),
  amount NUMERIC NOT NULL,
  description TEXT,
  date TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS followups (
  id TEXT PRIMARY KEY,
  client_id TEXT NOT NULL REFERENCES clients(id) ON DELETE CASCADE,
  description TEXT NOT NULL,
  due_date TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','done'))
);
CREATE INDEX IF NOT EXISTS idx_payments_client ON payments(client_id);
CREATE INDEX IF NOT EXISTS idx_followups_client ON followups(client_id);
CREATE INDEX IF NOT EXISTS idx_clients_category ON clients(category);
CREATE VIEW IF NOT EXISTS client_balances AS
SELECT c.id AS client_id, c.name,
  COALESCE(SUM(CASE WHEN p.type='charge' THEN p.amount END),0) AS total_charged,
  COALESCE(SUM(CASE WHEN p.type='payment' THEN p.amount END),0) AS total_paid,
  COALESCE(SUM(CASE WHEN p.type='charge' THEN p.amount END),0) - COALESCE(SUM(CASE WHEN p.type='payment' THEN p.amount END),0) AS balance_due
FROM clients c LEFT JOIN payments p ON p.client_id = c.id
GROUP BY c.id, c.name;
CREATE VIEW IF NOT EXISTS open_followups AS
SELECT f.id, f.client_id, c.name AS client_name, f.description, f.due_date
FROM followups f JOIN clients c ON c.id = f.client_id
WHERE f.status='pending';
`;

let db = null;

async function initDb() {
  const SQL = await initSqlJs({ locateFile: f => 'https://cdn.jsdelivr.net/npm/sql.js@1.10.2/dist/' + f });
  let bytes = null;
  try {
    const res = await window.storage.get('db-binary', false);
    if (res && res.value) bytes = Uint8Array.from(atob(res.value), c => c.charCodeAt(0));
  } catch (e) { /* no saved db yet */ }
  db = bytes ? new SQL.Database(bytes) : new SQL.Database();
  db.run(SCHEMA_SQL);
  if (!bytes) await persistDb();
}

async function persistDb() {
  const bytes = db.export();
  let binary = '';
  for (let i = 0; i < bytes.length; i++) binary += String.fromCharCode(bytes[i]);
  const b64 = btoa(binary);
  try { await window.storage.set('db-binary', b64, false); }
  catch (e) { console.error('db persist failed', e); }
}

function queryAll(sql, params = []) {
  const stmt = db.prepare(sql);
  stmt.bind(params);
  const rows = [];
  while (stmt.step()) rows.push(stmt.getAsObject());
  stmt.free();
  return rows;
}

const CATEGORIES = {
  hotel: { label: 'Hotel', color: '#1F6F5C' },
  clinic: { label: 'Clinic', color: '#2E6FA3' },
  restaurant: { label: 'Restaurant', color: '#D9784F' },
  salon: { label: 'Salon', color: '#B4568A' },
  gym: { label: 'Gym', color: '#5E8C3E' },
  retail: { label: 'Retail', color: '#7A5EA8' },
  other: { label: 'Other', color: '#8A857A' }
};

let state = {
  view: 'dashboard',
  clients: null,
  detailId: null,
  detail: null,
  modal: null,
  categoryFilter: 'all',
  loading: true
};

function uid() { return Date.now().toString(36) + Math.random().toString(36).slice(2, 7); }
function fmtMoney(n) { return '$' + Number(n || 0).toLocaleString(undefined, { maximumFractionDigits: 2 }); }
function todayStr() { return new Date().toISOString().slice(0, 10); }
function daysUntil(dateStr) {
  const d = new Date(dateStr + 'T00:00:00');
  const t = new Date(todayStr() + 'T00:00:00');
  return Math.round((d - t) / 86400000);
}

function loadClients() {
  state.clients = queryAll(
    "SELECT id, name, category, phone, email, status, notes, created_at AS createdAt FROM clients ORDER BY created_at DESC"
  );
}
function loadDetail(id) {
  return {
    payments: queryAll("SELECT id, type, amount, description AS desc, date FROM payments WHERE client_id=? ORDER BY date DESC", [id]),
    followups: queryAll("SELECT id, description AS desc, due_date AS dueDate, status FROM followups WHERE client_id=? ORDER BY due_date ASC", [id])
  };
}

function clientBalance(payments) {
  let owed = 0, paid = 0;
  (payments || []).forEach(p => {
    if (p.type === 'charge') owed += Number(p.amount);
    else paid += Number(p.amount);
  });
  return { owed, paid, balance: owed - paid };
}

async function init() {
  await initDb();
  loadClients();
  state.loading = false;
  render();
}

async function goToClient(id) {
  state.detailId = id;
  state.detail = loadDetail(id);
  state.view = 'detail';
  render();
}

function goToView(v) { state.view = v; state.detailId = null; render(); }

function openModal(type, payload) { state.modal = { type, payload: payload || {} }; render(); }
function closeModal() { state.modal = null; render(); }

async function submitAddClient(e) {
  e.preventDefault();
  const fd = new FormData(e.target);
  const c = {
    id: uid(),
    name: (fd.get('clientName') || '').trim(),
    category: fd.get('category'),
    phone: (fd.get('phone') || '').trim(),
    email: (fd.get('email') || '').trim(),
    status: fd.get('status'),
    notes: (fd.get('notes') || '').trim(),
    createdAt: todayStr()
  };
  if (!c.name) return;
  db.run("INSERT INTO clients (id,name,category,phone,email,status,notes,created_at) VALUES (?,?,?,?,?,?,?,?)",
    [c.id, c.name, c.category, c.phone, c.email, c.status, c.notes, c.createdAt]);
  db.run("INSERT INTO followups (id,client_id,description,due_date,status) VALUES (?,?,?,?,?)",
    [uid(), c.id, 'Send first draft', addDays(3), 'pending']);
  await persistDb();
  loadClients();
  closeModal();
  goToClient(c.id);
}

function addDays(n) {
  const d = new Date();
  d.setDate(d.getDate() + n);
  return d.toISOString().slice(0, 10);
}

async function submitPayment(e) {
  e.preventDefault();
  const fd = new FormData(e.target);
  const entry = {
    id: uid(),
    type: fd.get('type'),
    amount: parseFloat(fd.get('amount')) || 0,
    desc: (fd.get('desc') || '').trim(),
    date: fd.get('date') || todayStr()
  };
  db.run("INSERT INTO payments (id,client_id,type,amount,description,date) VALUES (?,?,?,?,?,?)",
    [entry.id, state.detailId, entry.type, entry.amount, entry.desc, entry.date]);
  await persistDb();
  state.detail = loadDetail(state.detailId);
  closeModal();
  render();
}

async function submitFollowup(e) {
  e.preventDefault();
  const fd = new FormData(e.target);
  const entry = { id: uid(), desc: (fd.get('desc') || '').trim(), dueDate: fd.get('dueDate') || todayStr(), status: 'pending' };
  if (!entry.desc) return;
  db.run("INSERT INTO followups (id,client_id,description,due_date,status) VALUES (?,?,?,?,?)",
    [entry.id, state.detailId, entry.desc, entry.dueDate, entry.status]);
  await persistDb();
  state.detail = loadDetail(state.detailId);
  closeModal();
  render();
}

async function toggleFollowup(clientId, taskId, fromDashboard) {
  db.run("UPDATE followups SET status = CASE WHEN status='done' THEN 'pending' ELSE 'done' END WHERE id=?", [taskId]);
  await persistDb();
  if (!fromDashboard) state.detail = loadDetail(clientId);
  render();
}

async function deleteClient(id) {
  if (!confirm('Delete this client and all their records?')) return;
  db.run("DELETE FROM clients WHERE id=?", [id]);
  await persistDb();
  loadClients();
  goToView('clients');
}

function getAllFollowups() {
  const rows = queryAll(
    "SELECT id, client_id AS clientId, client_name AS clientName, description AS desc, due_date AS dueDate FROM open_followups"
  );
  rows.sort((a, b) => daysUntil(a.dueDate) - daysUntil(b.dueDate));
  return rows;
}

function dueBadge(dateStr) {
  const d = daysUntil(dateStr);
  if (d < 0) return `<span class="badge overdue">overdue</span>`;
  if (d === 0) return `<span class="badge today">today</span>`;
  if (d <= 3) return `<span class="badge soon">in ${d}d</span>`;
  return `<span class="badge soon" style="background:var(--teal-tint);color:var(--ink-soft)">in ${d}d</span>`;
}

function icon(name) {
  const icons = {
    dashboard: '<circle cx="9" cy="9" r="7"/>'
  };
  return `<svg width="14" height="14" viewBox="0 0 18 18" fill="none" stroke="currentColor" stroke-width="1.6">${icons[name] || ''}</svg>`;
}

// ---------- RENDER ----------
async function render() {
  const app = document.getElementById('app');
  if (state.loading) { app.innerHTML = '<div style="padding:40px;color:#5B655F">Loading...</div>'; return; }

  let mainHtml = '';
  if (state.view === 'dashboard') mainHtml = await renderDashboard();
  else if (state.view === 'clients') mainHtml = renderClients();
  else if (state.view === 'detail') mainHtml = renderDetail();

  app.innerHTML = `
    <div class="sidebar">
      <div class="brand">Client tracker</div>
      <div class="brand-sub">Websites for local shops</div>
      <div class="nav-item ${state.view === 'dashboard' ? 'active' : ''}" onclick="goToView('dashboard')">
        <span class="nav-dot"></span> Dashboard
      </div>
      <div class="nav-item ${state.view === 'clients' || state.view === 'detail' ? 'active' : ''}" onclick="goToView('clients')">
        <span class="nav-dot"></span> Clients
      </div>
      <a class="nav-item" href="data.sql" target="_blank" rel="noopener">
        <span class="nav-dot"></span> Schema
      </a>
    </div>
    <div class="main">${mainHtml}</div>
    ${state.modal ? renderModal() : ''}
  `;
}

async function renderDashboard() {
  const tasks = await getAllFollowups();
  const overdue = tasks.filter(t => daysUntil(t.dueDate) < 0);
  const todayTasks = tasks.filter(t => daysUntil(t.dueDate) === 0);
  const upcoming = tasks.filter(t => daysUntil(t.dueDate) > 0).slice(0, 8);

  let totalRevenue = 0, totalOwed = 0;
  for (const c of state.clients) {
    const d = await loadDetail(c.id);
    const b = clientBalance(d.payments);
    totalRevenue += b.paid;
    totalOwed += Math.max(b.balance, 0);
  }

  const taskRow = t => `
    <div class="task-row" onclick="goToClient('${t.clientId}')">
      <div class="task-check ${t.status === 'done' ? 'done' : ''}" onclick="event.stopPropagation(); toggleFollowup('${t.clientId}','${t.id}', true)"></div>
      <div class="task-body">
        <div class="task-title">${escapeHtml(t.desc)}</div>
        <div class="task-meta">${escapeHtml(t.clientName)}</div>
      </div>
      ${dueBadge(t.dueDate)}
    </div>`;

  return `
    <h1 class="page-title">Dashboard</h1>
    <p class="page-sub">What needs your attention today.</p>
    <div class="stat-row">
      <div class="stat-card"><div class="stat-num">${state.clients.length}</div><div class="stat-label">Total clients</div></div>
      <div class="stat-card"><div class="stat-num">${fmtMoney(totalRevenue)}</div><div class="stat-label">Total received</div></div>
      <div class="stat-card"><div class="stat-num">${fmtMoney(totalOwed)}</div><div class="stat-label">Outstanding balance</div></div>
      <div class="stat-card"><div class="stat-num">${overdue.length}</div><div class="stat-label">Overdue follow-ups</div></div>
    </div>

    <p class="section-label">Overdue & due today</p>
    <div class="card-list" style="margin-bottom:28px;">
      ${overdue.concat(todayTasks).length ? overdue.concat(todayTasks).map(taskRow).join('') : '<div class="empty">Nothing overdue — you are on top of it.</div>'}
    </div>

    <p class="section-label">Coming up</p>
    <div class="card-list">
      ${upcoming.length ? upcoming.map(taskRow).join('') : '<div class="empty">No upcoming follow-ups yet.</div>'}
    </div>
  `;
}

function renderClients() {
  const filtered = state.clients.filter(c => state.categoryFilter === 'all' || c.category === state.categoryFilter);
  const catOptions = Object.entries(CATEGORIES).map(([k, v]) => `<option value="${k}">${v.label}</option>`).join('');

  return `
    <h1 class="page-title">Clients</h1>
    <p class="page-sub">${state.clients.length} total</p>
    <div class="toolbar">
      <select onchange="state.categoryFilter=this.value; render()">
        <option value="all" ${state.categoryFilter === 'all' ? 'selected' : ''}>All categories</option>
        ${Object.entries(CATEGORIES).map(([k, v]) => `<option value="${k}" ${state.categoryFilter === k ? 'selected' : ''}>${v.label}</option>`).join('')}
      </select>
      <button class="btn" onclick="openModal('addClient')" style="margin-left:auto;">+ Add client</button>
    </div>
    <div class="card-list">
      ${filtered.length ? filtered.map(renderClientRow).join('') : '<div class="empty">No clients yet — add your first one.</div>'}
    </div>
  `;
}

function renderClientRow(c) {
  return `<div class="client-card-wrap" data-id="${c.id}"></div>`;
}

// build client rows with async balance via placeholder then hydrate
function renderClientRowSync(c, balanceText, balanceClass) {
  const cat = CATEGORIES[c.category] || CATEGORIES.other;
  return `
    <div class="client-card" onclick="goToClient('${c.id}')">
      <div class="cat-dot" style="background:${cat.color}"></div>
      <div>
        <div class="client-name">${escapeHtml(c.name)}</div>
        <div class="client-meta">${cat.label} · ${c.status || 'in progress'}</div>
      </div>
      <div class="client-balance ${balanceClass}">${balanceText}</div>
    </div>`;
}

function renderDetail() {
  const c = state.clients.find(x => x.id === state.detailId);
  if (!c) return '<div class="empty">Client not found.</div>';
  const cat = CATEGORIES[c.category] || CATEGORIES.other;
  const b = clientBalance(state.detail.payments);

  const payRows = state.detail.payments.slice().reverse().map(p => `
    <div class="row-item">
      <span>${escapeHtml(p.desc || (p.type === 'charge' ? 'Charge' : 'Payment'))} <span style="color:var(--ink-soft)">· ${p.date}</span></span>
      <span style="color:${p.type === 'charge' ? 'var(--red)' : 'var(--teal-dark)'};font-weight:600">${p.type === 'charge' ? '+' : '-'}${fmtMoney(p.amount)}</span>
    </div>`).join('') || '<div class="empty">No payments recorded yet.</div>';

  const pendingTasks = state.detail.followups.filter(t => t.status !== 'done');
  const doneTasks = state.detail.followups.filter(t => t.status === 'done');
  const taskRows = pendingTasks.map(t => `
    <div class="row-item">
      <div style="display:flex;align-items:center;gap:10px;">
        <div class="task-check" onclick="toggleFollowup('${c.id}','${t.id}')" style="cursor:pointer"></div>
        <span>${escapeHtml(t.desc)}</span>
      </div>
      ${dueBadge(t.dueDate)}
    </div>`).join('') || '<div class="empty">No open follow-ups.</div>';
  const doneRows = doneTasks.map(t => `
    <div class="row-item" style="opacity:.55">
      <div style="display:flex;align-items:center;gap:10px;">
        <div class="task-check done" onclick="toggleFollowup('${c.id}','${t.id}')" style="cursor:pointer"></div>
        <span style="text-decoration:line-through">${escapeHtml(t.desc)}</span>
      </div>
    </div>`).join('');

  return `
    <span class="back-link" onclick="goToView('clients')">&larr; Back to clients</span>
    <div class="detail-head">
      <div class="cat-dot" style="width:14px;height:14px;background:${cat.color}"></div>
      <div class="detail-name">${escapeHtml(c.name)}</div>
      <button class="btn danger" style="margin-left:auto;" onclick="deleteClient('${c.id}')">Delete client</button>
    </div>

    <div class="detail-grid">
      <div class="panel">
        <p class="section-label" style="margin-bottom:10px;">Client info</p>
        <div class="info-row"><span>Category</span><span>${cat.label}</span></div>
        <div class="info-row"><span>Status</span><span>${c.status || '—'}</span></div>
        <div class="info-row"><span>Phone</span><span>${escapeHtml(c.phone) || '—'}</span></div>
        <div class="info-row"><span>Email</span><span>${escapeHtml(c.email) || '—'}</span></div>
        <div class="info-row"><span>Client since</span><span>${c.createdAt}</span></div>
        ${c.notes ? `<div style="margin-top:10px;font-size:13px;color:var(--ink-soft)">${escapeHtml(c.notes)}</div>` : ''}
      </div>
      <div class="panel">
        <p class="section-label" style="margin-bottom:10px;">Balance</p>
        <div class="info-row"><span>Total charged</span><span>${fmtMoney(b.owed)}</span></div>
        <div class="info-row"><span>Total paid</span><span>${fmtMoney(b.paid)}</span></div>
        <div class="info-row"><span style="font-weight:600;color:var(--ink)">Balance due</span><span style="font-weight:700;color:${b.balance > 0 ? 'var(--red)' : 'var(--teal-dark)'}">${fmtMoney(b.balance)}</span></div>
      </div>
    </div>

    <div class="panel">
      <div class="panel-head">
        <p class="section-label" style="margin:0;">Payments</p>
        <button class="btn secondary" onclick="openModal('addPayment')">+ Add entry</button>
      </div>
      ${payRows}
    </div>

    <div class="panel">
      <div class="panel-head">
        <p class="section-label" style="margin:0;">Follow-ups</p>
        <button class="btn secondary" onclick="openModal('addFollowup')">+ Add task</button>
      </div>
      ${taskRows}
      ${doneRows}
    </div>
  `;
}

function renderModal() {
  const m = state.modal;
  const catOptions = Object.entries(CATEGORIES).map(([k, v]) => `<option value="${k}">${v.label}</option>`).join('');

  if (m.type === 'addClient') {
    return `<div class="overlay" onclick="if(event.target===this) closeModal()">
      <div class="modal">
        <h3>Add client</h3>
        <form onsubmit="submitAddClient(event)">
          <div class="field"><label>Business name</label><input type="text" name="clientName" required autofocus></div>
          <div class="field"><label>Category</label><select name="category">${catOptions}</select></div>
          <div class="field"><label>Status</label>
            <select name="status">
              <option value="not started">Not started</option>
              <option value="in progress" selected>In progress</option>
              <option value="delivered">Delivered</option>
              <option value="needs update">Needs update</option>
            </select>
          </div>
          <div class="field"><label>Phone</label><input type="text" name="phone"></div>
          <div class="field"><label>Email</label><input type="text" name="email"></div>
          <div class="field"><label>Notes</label><textarea name="notes" rows="2"></textarea></div>
          <div class="modal-actions">
            <button type="button" class="btn secondary" onclick="closeModal()">Cancel</button>
            <button type="submit" class="btn">Add client</button>
          </div>
        </form>
      </div>
    </div>`;
  }
  if (m.type === 'addPayment') {
    return `<div class="overlay" onclick="if(event.target===this) closeModal()">
      <div class="modal">
        <h3>Add payment entry</h3>
        <form onsubmit="submitPayment(event)">
          <div class="field">
            <label>Type</label>
            <div class="type-toggle">
              <label><input type="radio" name="type" value="charge" checked><span>Charge (owed)</span></label>
              <label><input type="radio" name="type" value="payment"><span>Payment (received)</span></label>
            </div>
          </div>
          <div class="field"><label>Amount</label><input type="number" name="amount" step="0.01" min="0" required autofocus></div>
          <div class="field"><label>Description</label><input type="text" name="desc" placeholder="e.g. 50% upfront"></div>
          <div class="field"><label>Date</label><input type="date" name="date" value="${todayStr()}"></div>
          <div class="modal-actions">
            <button type="button" class="btn secondary" onclick="closeModal()">Cancel</button>
            <button type="submit" class="btn">Save entry</button>
          </div>
        </form>
      </div>
    </div>`;
  }
  if (m.type === 'addFollowup') {
    return `<div class="overlay" onclick="if(event.target===this) closeModal()">
      <div class="modal">
        <h3>Add follow-up</h3>
        <form onsubmit="submitFollowup(event)">
          <div class="field"><label>Task</label><input type="text" name="desc" placeholder="e.g. check in after launch" required autofocus></div>
          <div class="field"><label>Due date</label><input type="date" name="dueDate" value="${todayStr()}"></div>
          <div class="modal-actions">
            <button type="button" class="btn secondary" onclick="closeModal()">Cancel</button>
            <button type="submit" class="btn">Add task</button>
          </div>
        </form>
      </div>
    </div>`;
  }
  return '';
}

function escapeHtml(s) {
  return (s || '').replace(/[&<>"']/g, m => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[m]));
}

// Hydrate client rows with balances after initial render (clients view)
const origRender = render;
render = async function () {
  await origRender();
  if (state.view === 'clients') {
    const wraps = document.querySelectorAll('.client-card-wrap');
    for (const w of wraps) {
      const id = w.dataset.id;
      const c = state.clients.find(x => x.id === id);
      const d = await loadDetail(id);
      const b = clientBalance(d.payments);
      const text = b.balance > 0 ? `${fmtMoney(b.balance)} due` : 'Paid up';
      const cls = b.balance > 0 ? 'owe' : 'clear';
      w.outerHTML = renderClientRowSync(c, text, cls);
    }
  }
};

init();