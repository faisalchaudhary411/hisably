/* ============================================
   Hisably v2 – Full Inventory + Invoicing
   ============================================ */

(function () {
  'use strict';

  const STORAGE = {
    products: 'sb_products_v2',
    invoices: 'sb_invoices_v2',
    customers: 'sb_customers_v2',
    suppliers: 'sb_suppliers_v2',
    expenses: 'sb_expenses_v2',
    stockMovements: 'sb_stock_v2',
    purchases: 'sb_purchases_v2',
    settings: 'sb_settings_v2',
    counter: 'sb_counter_v2',
    tombs: 'sb_tombstones_v3'      // ids deleted locally, waiting to be deleted in the cloud
  };
  const OWNER_KEY = 'hisably_data_owner_v1';        // which account the local data belongs to
  const LEGACY_FLAG = 'sb_legacy_reset_pending';    // v1 -> v2 id migration needs a clean cloud
  const SYNC_COLLECTIONS = ['products', 'customers', 'suppliers', 'invoices', 'expenses', 'stockMovements', 'purchases'];
  const DB_TABLE = { stockMovements: 'stock_movements' };
  const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

  function load(key, fallback) {
    try {
      const raw = localStorage.getItem(key);
      return raw ? JSON.parse(raw) : fallback;
    } catch { return fallback; }
  }
  let _storageWarned = false;
  function save(key, val) {
    try {
      localStorage.setItem(key, JSON.stringify(val));
    } catch (e) {
      // Storage full (logo/QR images are big) - tell the user instead of silently losing data
      if (!_storageWarned) {
        _storageWarned = true;
        try { toast('Storage is full! Export a backup and remove old data.', 6000); } catch (_) {}
      }
      console.error('save failed', key, e);
    }
  }

  let products = load(STORAGE.products, []);
  let invoices = load(STORAGE.invoices, []);
  let customers = load(STORAGE.customers, []);
  let suppliers = load(STORAGE.suppliers, []);
  let expenses = load(STORAGE.expenses, []);
  let stockMovements = load(STORAGE.stockMovements, []);
  let purchases = load(STORAGE.purchases, []);
  function defaultSettings() {
    return {
      businessName: 'My Business',
      ownerName: '',
      phone: '',
      email: '',
      address: '',
      city: '',
      taxId: '',
      currency: 'PKR',
      invoicePrefix: 'INV',
      taxRate: 0,
      invoiceTheme: 'teal',
      pinSalt: '',
      pinHash: '',
      staffHash: '',
      lowStockDefault: 5,
      logo: '',
      paymentQr: '',
      paymentNote: 'Pay via JazzCash / EasyPaisa / Bank'
    };
  }
  let settings = Object.assign(defaultSettings(), load(STORAGE.settings, {}));
  let invoiceCounter = load(STORAGE.counter, 1001);
  let docCtx = {};                 // {type:'return', ref:invoice} set before opening the create form
  let tombs = load(STORAGE.tombs, {});

  let currentView = 'dashboard';
  let previousView = null;
  let editingId = null;
  let scanner = null;

  const $ = (s, c = document) => c.querySelector(s);
  const $$ = (s, c = document) => [...c.querySelectorAll(s)];

  // Real UUIDs: they are also the primary keys in the cloud database
  function uid() {
    if (window.crypto && typeof crypto.randomUUID === 'function') return crypto.randomUUID();
    return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, c => {
      const r = Math.random() * 16 | 0;
      return (c === 'x' ? r : (r & 3 | 8)).toString(16);
    });
  }
  function round2(n) { return Math.round((Number(n) || 0) * 100) / 100; }
  function lowLimit(p) { return (p.lowStock ?? settings.lowStockDefault); }
  function money(n) {
    return (Number(n) || 0).toLocaleString('en-PK', { minimumFractionDigits: 0, maximumFractionDigits: 2 });
  }
  function formatDate(iso) {
    return new Date(iso).toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: 'numeric' });
  }
  function initials(name) {
    return (name || '?').split(/\s+/).map(w => w[0]).join('').slice(0, 2).toUpperCase();
  }
  function escapeHtml(str) {
    if (str === 0) return '0';
    if (!str) return '';
    return String(str).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;').replace(/'/g,'&#39;');
  }

  // Custom dropdown helper (searchable, matches app design)

  function invoiceBelongsToCustomer(inv, customerId, customerName, customerPhone) {
    if (customerId && inv.customerId === customerId) return true;
    const invName = (inv.customerName || '').trim().toLowerCase();
    const name = (customerName || '').trim().toLowerCase();
    if (!name || invName !== name) return false;
    // Same name: also match phone if both have phone
    const invPhone = (inv.customerPhone || '').replace(/\D/g, '');
    const phone = (customerPhone || '').replace(/\D/g, '');
    if (phone && invPhone) return invPhone === phone || invPhone.endsWith(phone) || phone.endsWith(invPhone);
    // If invoice has customerId pointing elsewhere, don't steal it
    if (inv.customerId && customerId && inv.customerId !== customerId) return false;
    return true;
  }

  // Document kinds: 'sale' (default), 'return' (credit note, reverses a sale), 'estimate' (no effect on books)
  function docSign(inv) { return inv.docType === 'return' ? -1 : (inv.docType === 'estimate' ? 0 : 1); }
  function docWord(inv) { return inv.docType === 'return' ? 'Credit Note' : (inv.docType === 'estimate' ? 'Quotation' : 'Invoice'); }
  function nextDocNumber(prefix) {
    let mx = 1000;
    invoices.forEach(i => {
      const m = String(i.number).match(/^(.*?)-?(\d+)\s*$/);
      if (m && m[1] === prefix) mx = Math.max(mx, parseInt(m[2], 10));
    });
    return `${prefix}-${mx + 1}`;
  }
  function returnedQty(refId) {
    const r = {};
    invoices.forEach(i => {
      if (i.docType === 'return' && i.meta && i.meta.refId === refId) (i.items || []).forEach(it => { r[it.productId] = (r[it.productId] || 0) + (it.qty || 0); });
    });
    return r;
  }
  // Net sales / cost / receivable across all documents (returns subtract, estimates ignored)
  function netTotals() {
    let revenue = 0, cogs = 0, recv = 0;
    invoices.forEach(i => {
      const g = docSign(i); if (!g) return;
      revenue += g * (i.total || 0);
      cogs += g * (i.items || []).reduce((a, it) => a + ((it.cost || 0) * it.qty), 0);
      recv += g * Math.max(0, (i.total || 0) - (i.paidAmount || 0));
    });
    return { revenue: round2(revenue), cogs: round2(cogs), receivable: Math.max(0, round2(recv)) };
  }

  function customerBalance(customerId, customerName, customerPhone) {
    let net = 0, paid = 0, total = 0, count = 0;
    invoices.forEach(inv => {
      if (!invoiceBelongsToCustomer(inv, customerId, customerName, customerPhone)) return;
      const g = docSign(inv); if (!g) return;
      total += g * (inv.total || 0);
      paid += g * (inv.paidAmount || 0);
      net += g * Math.max(0, (inv.total || 0) - (inv.paidAmount || 0));
      count++;
    });
    return { due: Math.max(0, round2(net)), credit: Math.max(0, round2(-net)), paid, total, count };
  }

  function findOrCreateCustomer(name, phone) {
    name = (name || '').trim();
    phone = (phone || '').trim();
    if (!name || name === 'Walk-in Customer') return null;
    const phoneDigits = phone.replace(/\D/g, '');
    // Prefer match by name + phone
    let c = customers.find(x => {
      const sameName = x.name.toLowerCase() === name.toLowerCase();
      if (!sameName) return false;
      if (!phoneDigits) return true;
      const xp = (x.phone || '').replace(/\D/g, '');
      return !xp || xp === phoneDigits || xp.endsWith(phoneDigits) || phoneDigits.endsWith(xp);
    });
    if (c) {
      if (phone && !c.phone) { c.phone = phone; persist(); }
      return c;
    }
    // Exact name only if unique
    const sameName = customers.filter(x => x.name.toLowerCase() === name.toLowerCase());
    if (sameName.length === 1 && !phoneDigits) return sameName[0];
    // Create new (respect the Free-plan customer limit instead of silently exceeding it)
    if (window.HisablyFreemium && !HisablyFreemium.canAdd('customers', customers.length).ok) return null;
    c = { id: uid(), name, phone, address: '', notes: '' };
    customers.push(c);
    persist();
    return c;
  }

  // One-time migration: link invoices to customers by name, migrate old storage keys
  function getList(n) {
    return { products, customers, suppliers, invoices, expenses, stockMovements, purchases }[n];
  }
  function setList(n, list) {
    if (n === 'products') products = list;
    else if (n === 'customers') customers = list;
    else if (n === 'suppliers') suppliers = list;
    else if (n === 'invoices') invoices = list;
    else if (n === 'expenses') expenses = list;
    else if (n === 'stockMovements') stockMovements = list;
    else if (n === 'purchases') purchases = list;
  }
  function ts(x) { const t = Date.parse(x); return isNaN(t) ? 0 : t; }

  // Backups / old data may be missing fields - never let that crash a screen
  function normalizeData() {
    const nowIso = new Date().toISOString();
    SYNC_COLLECTIONS.forEach(n => {
      const list = getList(n);
      if (!Array.isArray(list)) { setList(n, []); return; }
      setList(n, list.filter(r => r && typeof r === 'object'));
    });
    products.forEach(p => {
      p.name = String(p.name || 'Unnamed');
      p.price = Number(p.price) || 0; p.cost = Number(p.cost) || 0;
      p.stock = Math.round(Number(p.stock) || 0);
      p.updatedAt = p.updatedAt || p.createdAt || nowIso;
    });
    customers.forEach(c => { c.name = String(c.name || 'Unnamed'); c.updatedAt = c.updatedAt || nowIso; });
    suppliers.forEach(c => { c.name = String(c.name || 'Unnamed'); c.updatedAt = c.updatedAt || nowIso; });
    expenses.forEach(e => {
      e.amount = Number(e.amount) || 0;
      e.date = e.date || nowIso.slice(0, 10);
      e.updatedAt = e.updatedAt || e.date || nowIso;
    });
    invoices.forEach(i => {
      if (!Array.isArray(i.items)) i.items = [];
      i.total = Number(i.total) || 0;
      i.paidAmount = Number(i.paidAmount) || 0;
      i.number = String(i.number == null ? '' : i.number);
      i.docType = i.docType || 'sale';
      if (!i.meta || typeof i.meta !== 'object') i.meta = {};
      i.date = i.date || nowIso;
      i.updatedAt = i.updatedAt || i.date;
    });
    purchases.forEach(p => {
      if (!Array.isArray(p.items)) p.items = [];
      p.total = Number(p.total) || 0; p.paidAmount = Number(p.paidAmount) || 0;
      p.number = String(p.number == null ? '' : p.number); p.date = p.date || nowIso;
      p.updatedAt = p.updatedAt || p.date;
      if (!p.meta || typeof p.meta !== 'object') p.meta = {};
    });
    stockMovements.forEach(m => { m.qty = Number(m.qty) || 0; m.date = m.date || nowIso; m.updatedAt = m.updatedAt || m.date; });
    // Never reuse an invoice number that already exists (other device / restored backup)
    const maxNum = invoices.reduce((mx, i) => {
      const m = String(i.number).match(/(\d+)\s*$/);
      return m ? Math.max(mx, parseInt(m[1], 10)) : mx;
    }, 0);
    if (maxNum >= invoiceCounter) invoiceCounter = maxNum + 1;
  }

  // v1 used non-UUID ids. The cloud needs UUIDs, so convert once and fix references.
  function migrateIds() {
    const map = { products: {}, customers: {} };
    let legacy = false;
    const fix = (list, key) => list.forEach(r => {
      if (!r.id || !UUID_RE.test(r.id)) {
        const n = uid();
        if (r.id && key) map[key][r.id] = n;
        r.id = n;
        legacy = true;
      }
    });
    fix(products, 'products'); fix(customers, 'customers'); fix(suppliers);
    fix(expenses); fix(invoices); fix(stockMovements);
    if (!legacy) return;
    const remap = (val, m) => (val ? (m[val] || (UUID_RE.test(val) ? val : null)) : val);
    invoices.forEach(inv => {
      inv.customerId = remap(inv.customerId, map.customers);
      (inv.items || []).forEach(it => { it.productId = remap(it.productId, map.products); });
    });
    stockMovements.forEach(m => { m.productId = remap(m.productId, map.products); });
    try { localStorage.setItem(LEGACY_FLAG, '1'); } catch (e) {}
    saveAll();
  }

  // ---- change tracking: stamps updatedAt on edited records, tombstones deleted ones ----
  let _snap = {};
  let _settingsSnap = '';
  let _snapReady = false;
  function snapKey(r) { const { updatedAt, ...rest } = r; return JSON.stringify(rest); }
  function settingsKey() { const { updatedAt, ...rest } = settings; return JSON.stringify(rest); }
  function resnap() {
    SYNC_COLLECTIONS.forEach(n => {
      const m = new Map();
      getList(n).forEach(r => { if (r && r.id) m.set(r.id, snapKey(r)); });
      _snap[n] = m;
    });
    _settingsSnap = settingsKey();
    _snapReady = true;
  }
  function stampChanges() {
    if (!_snapReady) resnap();
    const now = new Date().toISOString();
    SYNC_COLLECTIONS.forEach(n => {
      const old = _snap[n] || new Map();
      const cur = new Map();
      getList(n).forEach(r => {
        if (!r.id) r.id = uid();
        const k = snapKey(r);
        if (old.get(r.id) !== k || !r.updatedAt) r.updatedAt = now;
        cur.set(r.id, k);
      });
      old.forEach((_, id) => {
        if (!cur.has(id)) (tombs[n] = tombs[n] || {})[id] = now;
      });
      if (tombs[n]) cur.forEach((_, id) => { delete tombs[n][id]; });
      _snap[n] = cur;
    });
    const sk = settingsKey();
    if (sk !== _settingsSnap) { settings.updatedAt = now; _settingsSnap = sk; }
  }

  function migrateData() {
    try {
      if (!localStorage.getItem('sb_migrated_v3')) {
        ['products','invoices','customers','suppliers'].forEach(k => {
          const old = localStorage.getItem('stockbill_' + k) || localStorage.getItem('sb_' + k);
          if (old && !localStorage.getItem('sb_' + k + '_v2')) {
            localStorage.setItem('sb_' + k + '_v2', old);
          }
        });
        localStorage.setItem('sb_migrated_v3', '1');
      }
    } catch(e) {}
    normalizeData();
    migrateIds();
    if (!_snapReady) resnap();
    // Link orphan invoices to customers by name/phone
    let changed = false;
    invoices.forEach(inv => {
      if (inv.customerId) return;
      const name = (inv.customerName || '').trim();
      if (!name || name === 'Walk-in Customer') return;
      const c = findOrCreateCustomer(name, inv.customerPhone || '');
      if (c) { inv.customerId = c.id; changed = true; }
    });
    if (changed) persist();
  }


  function customSelect(name, options, selectedValue, placeholder, searchable) {
    const selected = options.find(o => o.value === selectedValue) || options[0];
    const label = selected ? selected.label : (placeholder || 'Select...');
    const searchHtml = searchable ? `
      <div class="custom-select-search">
        <input type="search" class="custom-select-search-input" placeholder="Search..." data-action="filter-select" autocomplete="off" />
      </div>` : '';
    return `
      <div class="custom-select${searchable ? ' searchable' : ''}" data-name="${name}">
        <input type="hidden" name="${name}" value="${escapeHtml(selectedValue || '')}" class="custom-select-hidden" />
        <button type="button" class="custom-select-trigger" data-action="toggle-select">${escapeHtml(label)}</button>
        <div class="custom-select-options">
          ${searchHtml}
          <div class="custom-select-options-list">
            ${options.map(o => `
              <div class="custom-select-option ${o.value === selectedValue ? 'selected' : ''}"
                   data-action="select-option" data-value="${escapeHtml(o.value)}" data-label="${escapeHtml(o.label)}" data-search="${escapeHtml((o.label || '').toLowerCase())}">
                ${escapeHtml(o.label)}
              </div>`).join('')}
          </div>
        </div>
      </div>`;
  }
  let _toastTimer = null;
  // Never show developer-style errors to shop owners
  function friendlyMsg(m) {
    const t = String(m == null ? '' : m);
    if (/failed to fetch|networkerror|load failed|network request|fetch failed/i.test(t)) return 'No internet connection. Check your connection and try again.';
    if (/row-level security|permission denied|\brls\b/i.test(t)) return 'You are not allowed to do that. Please sign in again.';
    if (/\bjwt\b/i.test(t)) return 'Your session expired. Please sign in again.';
    if (/pgrst|does not exist|syntax error|violates|duplicate key|supabase|\bsql\b|edge function|deploy|\.md\b|\.js\b|typeerror|referenceerror|is not a function|undefined|cannot read|\bhttp \d{3}\b|\bdb (get|post|patch)/i.test(t)) return 'Something went wrong. Please try again. If it keeps happening, contact support.';
    return t;
  }

  function toast(msg, ms = 2500) {
    msg = friendlyMsg(msg);
    const el = $('#toast');
    if (!el) return;
    clearTimeout(_toastTimer);
    el.textContent = msg;
    el.hidden = false;
    requestAnimationFrame(() => el.classList.add('show'));
    _toastTimer = setTimeout(() => {
      el.classList.remove('show');
      setTimeout(() => el.hidden = true, 250);
    }, ms);
  }
  let _cloudPushTimer = null;
  let _cloudSyncing = false;
  let _cloudAutoEnabled = true; // auto push/pull when signed in

  function saveAll() {
    save(STORAGE.products, products);
    save(STORAGE.invoices, invoices);
    save(STORAGE.customers, customers);
    save(STORAGE.suppliers, suppliers);
    save(STORAGE.expenses, expenses);
    save(STORAGE.stockMovements, stockMovements);
    save(STORAGE.purchases, purchases);
    save(STORAGE.settings, settings);
    save(STORAGE.counter, invoiceCounter);
    save(STORAGE.tombs, tombs);
  }

  function persist() {
    stampChanges();
    saveAll();
    // Auto-sync to cloud ~2s after last change (debounced)
    scheduleCloudPush();
  }

  function scheduleCloudPush() {
    if (!_cloudAutoEnabled) return;
    if (!window.HisablyCloud || !HisablyCloud.ready()) return;
    if (!HisablyCloud.getSession()) return;
    clearTimeout(_cloudPushTimer);
    _cloudPushTimer = setTimeout(() => {
      doCloudSync({ silent: true });
    }, 2000);
  }

  // ---------- Navigation ----------
  function setView(view, options = {}) {
    if (isStaff()) {
      if (!STAFF_VIEWS.includes(view)) { toast('Only the owner can open that'); view = 'dashboard'; }
      if (view === 'create-invoice' && docCtx.type === 'purchase') docCtx = {};
    }
    if (!options.keepHistory) previousView = currentView;
    currentView = view;
    $$('.nav-item').forEach(b => b.classList.toggle('active', b.dataset.view === view));
    const showBack = ['customers','suppliers','reports','expenses','stock-history','purchases','daybook'].includes(view);
    $('#backBtn').hidden = !showBack;
    render();
    window.scrollTo(0, 0);
  }

  // ---------- Render Router ----------
  function render() {
    const content = $('#appContent');
    const title = $('#headerTitle');
    const right = $('#headerRight');
    right.innerHTML = '';

    const map = {
      dashboard: () => { title.textContent = 'Dashboard'; content.innerHTML = viewDashboard(); },
      products: () => {
        title.textContent = 'Products';
        if (!isStaff()) right.innerHTML = `<button class="btn btn-secondary btn-sm" data-action="bulk-tools" style="margin-right:8px">Bulk</button><button class="icon-btn" data-action="add-product" aria-label="Add"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2"><line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/></svg></button>`;
        content.innerHTML = viewProducts();
      },
      invoices: () => { title.textContent = 'Invoices'; content.innerHTML = viewInvoices(); },
      daybook: () => { title.textContent = 'Day Book'; content.innerHTML = viewDayBook(); },
      purchases: () => {
        title.textContent = 'Purchases';
        right.innerHTML = `<button class="icon-btn" data-action="new-purchase"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2"><line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/></svg></button>`;
        content.innerHTML = viewPurchases();
      },
      'create-invoice': () => { title.textContent = (docCtx.type === 'purchase' ? 'New Purchase' : docCtx.type === 'return' ? 'Sale Return' : docCtx.type === 'estimate' ? 'New Quotation' : 'New Invoice'); content.innerHTML = viewCreateInvoice(); bindCreateInvoice(); },
      more: () => { title.textContent = 'More'; content.innerHTML = viewMore(); },
      customers: () => {
        title.textContent = 'Customers';
        right.innerHTML = `<button class="icon-btn" data-action="add-customer"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2"><line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/></svg></button>`;
        content.innerHTML = viewCustomers();
      },
      suppliers: () => {
        title.textContent = 'Suppliers';
        right.innerHTML = `<button class="icon-btn" data-action="add-supplier"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2"><line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/></svg></button>`;
        content.innerHTML = viewSuppliers();
      },
      reports: () => { title.textContent = 'Reports'; content.innerHTML = viewReports(); },
      expenses: () => {
        title.textContent = 'Expenses';
        right.innerHTML = `<button class="icon-btn" data-action="add-expense"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2"><line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/></svg></button>`;
        content.innerHTML = viewExpenses();
      },
      'stock-history': () => {
        title.textContent = 'Stock History';
        content.innerHTML = viewStockHistory();
      }
    };

    (map[currentView] || map.dashboard)();
  }

  // ---------- Dashboard ----------
  function viewDashboard() {
    const totalProducts = products.length;
    const low = products.filter(p => p.stock > 0 && p.stock <= lowLimit(p)).length;
    const out = products.filter(p => p.stock <= 0).length;
    const { revenue, cogs, receivable } = netTotals();
    const totalExpenses = expenses.reduce((s, e) => s + (e.amount || 0), 0);
    const profit = revenue - cogs - totalExpenses;
    const recent = [...invoices].sort((a,b) => new Date(b.date) - new Date(a.date)).slice(0, 5);

    if (isStaff()) return `<div class="fade-in">
      <div class="stats-grid" style="grid-template-columns:repeat(3,1fr)">
        <div class="stat-card"><div class="stat-label">Products</div><div class="stat-value primary">${totalProducts}</div></div>
        <div class="stat-card"><div class="stat-label">Low Stock</div><div class="stat-value warning">${low}</div></div>
        <div class="stat-card"><div class="stat-label">Out</div><div class="stat-value danger">${out}</div></div>
      </div>
      <div class="section-header"><h2 class="section-title">Recent Invoices</h2></div>
      ${recent.length === 0 ? emptyState('invoice', 'No invoices yet', 'Create an invoice with the + button.', 'Create Invoice', 'create-invoice') : `<div class="list">${recent.map(inv => listInvoice(inv)).join('')}</div>`}
    </div>`;
    return `<div class="fade-in">
      ${typeof planBannerHTML === 'function' ? planBannerHTML() : ''}
      <div class="stats-grid">
        <div class="stat-card"><div class="stat-label">Products</div><div class="stat-value primary">${totalProducts}</div></div>
        <div class="stat-card"><div class="stat-label">Revenue</div><div class="stat-value success">${settings.currency} ${money(revenue)}</div></div>
        <div class="stat-card"><div class="stat-label">Expenses</div><div class="stat-value danger">${settings.currency} ${money(totalExpenses)}</div></div>
        <div class="stat-card"><div class="stat-label">Net Profit</div><div class="stat-value ${profit >= 0 ? 'success' : 'danger'}">${settings.currency} ${money(profit)}</div></div>
      </div>
      <div class="stats-grid" style="margin-top:-8px;grid-template-columns:repeat(2,1fr)">
        <div class="stat-card"><div class="stat-label">To Collect</div><div class="stat-value success" style="font-size:1.125rem">${settings.currency} ${money(receivable)}</div></div>
        <div class="stat-card" data-view="purchases" style="cursor:pointer"><div class="stat-label">To Pay</div><div class="stat-value ${totalPayable() > 0 ? 'danger' : 'success'}" style="font-size:1.125rem">${settings.currency} ${money(totalPayable())}</div></div>
      </div>
      <div class="stats-grid" style="margin-top:-8px;margin-bottom:20px;grid-template-columns:repeat(2,1fr)">
        <div class="stat-card"><div class="stat-label">Low Stock</div><div class="stat-value warning">${low}</div></div>
        <div class="stat-card"><div class="stat-label">Out of Stock</div><div class="stat-value danger">${out}</div></div>
      </div>
      <div class="section-header">
        <h2 class="section-title">Recent Invoices</h2>
        ${invoices.length > 5 ? `<button class="section-link" data-view="invoices">See all</button>` : ''}
      </div>
      ${recent.length === 0 ? emptyState('invoice', 'No invoices yet', 'Create your first invoice with the + button.', 'Create Invoice', 'create-invoice') :
        `<div class="list">${recent.map(inv => listInvoice(inv)).join('')}</div>`}
    </div>`;
  }

  // ---------- Products ----------
  function viewProducts() {
    if (products.length === 0) {
      return emptyState('box', 'No products yet', 'Add your first product to start tracking stock and creating invoices.', 'Add Product', null, 'add-product');
    }
    if (productCat && productCat !== '__none__' && !categoryList().includes(productCat)) productCat = '';
    return `<div class="fade-in">
      <div class="search-wrap">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="11" cy="11" r="8"/><line x1="21" y1="21" x2="16.65" y2="16.65"/></svg>
        <input type="search" class="search-input" id="productSearch" placeholder="Search name, barcode or category..." />
      </div>
      ${categoryChipsHTML()}
      <div class="list" id="productList">${productListHTML('')}</div>
    </div>`;
  }

  function listProduct(p) {
    let badge = p.stock <= 0 ? '<span class="list-item-badge badge-out">Out of stock</span>' :
                p.stock <= lowLimit(p) ? `<span class="list-item-badge badge-low">Low · ${p.stock}</span>` :
                `<span class="list-item-badge badge-ok">${p.stock} in stock</span>`;
    return `<div class="list-item" data-action="edit-product" data-id="${p.id}">
      <div class="list-item-icon">${initials(p.name)}</div>
      <div class="list-item-body">
        <div class="list-item-title">${escapeHtml(p.name)}</div>
        <div class="list-item-sub">${settings.currency} ${money(p.price)} · ${escapeHtml(p.unit || 'pcs')}${p.barcode ? ' · ' + escapeHtml(p.barcode) : ''}</div>
      </div>
      <div class="list-item-right">${badge}</div>
    </div>`;
  }

  // ---------- Invoices ----------
  let invFilter = 'all';
  function viewInvoices() {
    if (invoices.length === 0) {
      return emptyState('invoice', 'No invoices yet', 'Create invoices for customers and track sales.', 'Create Invoice', 'create-invoice');
    }
    const kinds = [['all', 'All'], ['sale', 'Sales'], ['estimate', 'Quotes'], ['return', 'Returns']];
    const list = invoices.filter(i => invFilter === 'all' || (i.docType || 'sale') === invFilter)
      .sort((a, b) => new Date(b.date) - new Date(a.date));
    return `<div class="fade-in">
      <div class="cat-chips">${kinds.map(k => `<button class="cat-chip${invFilter === k[0] ? ' active' : ''}" data-action="inv-filter" data-kind="${k[0]}">${k[1]}</button>`).join('')}
        <button class="cat-chip" data-action="new-estimate">+ Quotation</button><button class="cat-chip" data-action="new-return">+ Sale Return</button></div>
      ${list.length ? `<div class="list">${list.map(inv => listInvoice(inv)).join('')}</div>` : '<div class="doc-empty">Nothing here yet</div>'}
    </div>`;
  }

  function listInvoice(inv) {
    const status = inv.paymentStatus || 'unpaid';
    const paid = inv.paidAmount || 0;
    const isRet = inv.docType === 'return';
    let badge = '';
    if (inv.docType === 'estimate') {
      badge = inv.meta && inv.meta.convertedTo ? `<span class="list-item-badge badge-ok">Invoiced · ${escapeHtml(inv.meta.convertedTo)}</span>` : '<span class="list-item-badge badge-low">Quotation</span>';
    } else if (isRet) {
      badge = paid >= inv.total ? '<span class="list-item-badge badge-ok">Refunded</span>'
        : `<span class="list-item-badge badge-low">Credit · ${settings.currency} ${money(Math.max(0, inv.total - paid))}</span>`;
    } else if (status === 'paid' || paid >= inv.total) {
      badge = '<span class="list-item-badge badge-ok">Paid</span>';
    } else if (status === 'partial' || paid > 0) {
      badge = `<span class="list-item-badge badge-low">Partial · ${settings.currency} ${money(paid)}</span>`;
    } else {
      badge = '<span class="list-item-badge badge-out">Unpaid</span>';
    }
    if (isOverdue(inv)) badge += ' <span class="list-item-badge badge-out">Overdue</span>';
    return `<div class="list-item" data-action="view-invoice" data-id="${inv.id}">
      <div class="list-item-icon">${initials(inv.customerName || 'C')}</div>
      <div class="list-item-body">
        <div class="list-item-title">${escapeHtml(inv.customerName || 'Walk-in Customer')}</div>
        <div class="list-item-sub">${isRet ? 'Return ' : (inv.docType === 'estimate' ? 'Quote ' : '#')}${escapeHtml(inv.number)} · ${formatDate(inv.date)} · ${inv.items.length} item${inv.items.length !== 1 ? 's' : ''}</div>
        ${badge}
      </div>
      <div class="list-item-right"><div class="list-item-price"${isRet ? ' style="color:var(--danger)"' : ''}>${isRet ? '−' : ''}${settings.currency} ${money(inv.total)}</div></div>
    </div>`;
  }

  // ---------- Customer payments, ledger / statement, reminders ----------
  // Money received (or refunded) against one document. Keeps a dated history in meta.payments.
  function addPayment(inv, amt, mode, note, dateIso) {
    const left = Math.max(0, round2((inv.total || 0) - (inv.paidAmount || 0)));
    amt = round2(Math.min(Number(amt) || 0, left));
    if (amt <= 0) return 0;
    inv.meta = inv.meta || {};
    (inv.meta.payments = inv.meta.payments || []).push({ date: dateIso || new Date().toISOString(), amount: amt, mode: mode || 'Cash', note: note || '' });
    inv.paidAmount = round2((inv.paidAmount || 0) + amt);
    inv.paymentStatus = inv.paidAmount >= inv.total ? 'paid' : 'partial';
    inv.updatedAt = new Date().toISOString();
    return amt;
  }
  function custDocs(cust) {
    return invoices.filter(i => docSign(i) && invoiceBelongsToCustomer(i, cust.id, cust.name, cust.phone));
  }
  function isOverdue(inv) {
    if (!(inv.meta && inv.meta.dueDate) || (inv.docType !== undefined && docSign(inv) <= 0)) return false;
    return (inv.total || 0) - (inv.paidAmount || 0) > 0.001 && inv.meta.dueDate < new Date().toISOString().slice(0, 10);
  }
  // Chronological ledger: debit = customer owes more, credit = customer owes less
  function customerLedger(cust) {
    const rows = [];
    custDocs(cust).forEach(inv => {
      const ret = inv.docType === 'return';
      rows.push({ t: ts(inv.date), date: inv.date, text: (ret ? 'Credit note ' : 'Invoice ') + inv.number, debit: ret ? 0 : inv.total, credit: ret ? inv.total : 0 });
      const pays = (inv.meta && inv.meta.payments) || [];
      const sumP = pays.reduce((s, p) => s + p.amount, 0);
      const first = round2((inv.paidAmount || 0) - sumP);
      if (first > 0.001) rows.push({ t: ts(inv.date) + 1, date: inv.date, text: (ret ? 'Refund paid' : 'Payment received') + ((inv.meta && inv.meta.paymentMode) ? ' · ' + inv.meta.paymentMode : '') + ' (' + inv.number + ')', debit: ret ? first : 0, credit: ret ? 0 : first });
      pays.forEach(p => rows.push({ t: ts(p.date) + 1, date: p.date, text: (ret ? 'Refund paid' : 'Payment received') + (p.mode ? ' · ' + p.mode : '') + (p.note ? ' · ' + p.note : '') + ' (' + inv.number + ')', debit: ret ? p.amount : 0, credit: ret ? 0 : p.amount }));
    });
    rows.sort((a, b) => a.t - b.t);
    let bal = 0;
    rows.forEach(r => { bal = round2(bal + r.debit - r.credit); r.balance = bal; });
    return rows;
  }

  function openReceiveModal(cust) {
    const bal = customerBalance(cust.id, cust.name, cust.phone);
    const saleDue = custDocs(cust).filter(i => docSign(i) > 0).reduce((s, i) => s + Math.max(0, (i.total || 0) - (i.paidAmount || 0)), 0);
    const today = new Date().toISOString().slice(0, 10);
    $('#modalRoot').innerHTML = `
      <div class="modal-overlay"><div class="modal-sheet">
        <div class="modal-handle"></div>
        <div class="modal-header"><h3 class="modal-title">Receive Payment</h3>
          <button class="modal-close" data-action="close-modal"><svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg></button></div>
        <div class="text-secondary text-sm mb-8">${escapeHtml(cust.name)} · Due ${settings.currency} ${money(bal.due)}</div>
        ${saleDue <= 0 ? '<div class="doc-empty">This customer has nothing pending.</div>' : `
        <form id="receiveForm" autocomplete="off">
          <div class="form-group"><label class="form-label">Amount (${settings.currency})</label>
            <input type="number" inputmode="decimal" class="form-input" id="rcvAmt" min="0" step="any" value="${saleDue}" /></div>
          <div class="chip-row mb-8" id="rcvMode">
            <button type="button" class="cat-chip active" data-mode="Cash">Cash</button><button type="button" class="cat-chip" data-mode="Bank">Bank</button>
            <button type="button" class="cat-chip" data-mode="Online">Online</button><button type="button" class="cat-chip" data-mode="Cheque">Cheque</button></div>
          <div class="form-row">
            <div class="form-group"><label class="form-label">Date</label><input type="date" class="form-input" id="rcvDate" value="${today}" max="${today}" /></div>
            <div class="form-group"><label class="form-label">Note</label><input type="text" class="form-input" id="rcvNote" maxlength="40" placeholder="Optional" /></div>
          </div>
          <div class="text-sm text-secondary">The amount settles the oldest unpaid invoices first.</div>
          <button type="submit" class="btn btn-primary btn-block mt-16">Save Payment</button>
        </form>`}
      </div></div>`;
    const f = document.getElementById('receiveForm'); if (!f) return;
    let mode = 'Cash';
    document.querySelectorAll('#rcvMode .cat-chip').forEach(b => b.addEventListener('click', () => {
      mode = b.dataset.mode; document.querySelectorAll('#rcvMode .cat-chip').forEach(x => x.classList.toggle('active', x === b));
    }));
    f.addEventListener('submit', e => {
      e.preventDefault();
      let amt = round2(parseFloat(document.getElementById('rcvAmt').value) || 0);
      if (amt <= 0) { toast('Enter an amount'); return; }
      if (amt > saleDue + 0.001) { toast(`Only ${settings.currency} ${money(saleDue)} is due`, 3500); return; }
      const d = document.getElementById('rcvDate').value;
      const dateIso = (d && d !== today) ? new Date(d + 'T12:00:00').toISOString() : new Date().toISOString();
      const note = document.getElementById('rcvNote').value.trim();
      const open = custDocs(cust).filter(i => docSign(i) > 0 && (i.total || 0) - (i.paidAmount || 0) > 0.001)
        .sort((a, b) => ts(a.date) - ts(b.date));
      let n = 0;
      for (const inv of open) { if (amt <= 0.001) break; const used = addPayment(inv, amt, mode, note, dateIso); if (used > 0) { amt = round2(amt - used); n++; } }
      persist();
      toast(`Payment saved · ${n} invoice${n !== 1 ? 's' : ''} updated`);
      render();
      openCustomerDetail(cust);
    });
  }

  function statementText(cust) {
    const rows = customerLedger(cust);
    const bal = customerBalance(cust.id, cust.name, cust.phone);
    let t = `*${settings.businessName}*\nStatement for ${cust.name}\n\n`;
    rows.slice(-12).forEach(r => {
      t += `${formatDate(r.date)} · ${r.text}: ${r.debit ? '+' : '-'}${settings.currency} ${money(r.debit || r.credit)}\n`;
    });
    t += `\n*${bal.credit > 0 ? 'Credit with us' : 'Balance due'}: ${settings.currency} ${money(bal.credit > 0 ? bal.credit : bal.due)}*`;
    if (settings.phone) t += `\n\nContact: ${settings.phone}`;
    return t;
  }
  function reminderText(cust, onlyInv) {
    const docs = onlyInv ? [onlyInv] : custDocs(cust).filter(i => docSign(i) > 0 && (i.total || 0) - (i.paidAmount || 0) > 0.001).sort((a, b) => ts(a.date) - ts(b.date));
    const due = round2(docs.reduce((s, i) => s + (i.total - (i.paidAmount || 0)), 0));
    let t = `Assalam o Alaikum ${cust.name || ''},\n\nA friendly reminder from *${settings.businessName}*: you have *${settings.currency} ${money(due)}* pending.\n\n`;
    docs.slice(0, 6).forEach(i => {
      t += `• ${i.number} (${formatDate(i.date)}): ${settings.currency} ${money(i.total - (i.paidAmount || 0))}${i.meta && i.meta.dueDate ? ' · due ' + formatDate(i.meta.dueDate) : ''}\n`;
    });
    if (docs.length > 6) t += `…and ${docs.length - 6} more\n`;
    t += `\nKindly arrange the payment at your earliest convenience.`;
    if (settings.paymentNote) t += `\n${settings.paymentNote}`;
    if (settings.phone) t += `\nContact: ${settings.phone}`;
    t += `\n\nThank you!`;
    return t;
  }
  // Local numbers like 0300-1234567 need the country code for wa.me
  function waNumber(phone) {
    let d = (phone || '').replace(/\D/g, '');
    const cc = { PKR: '92', INR: '91', BDT: '880' }[settings.currency];
    if (cc && d.startsWith('0')) d = cc + d.slice(1);
    return d;
  }
  function sendWhatsApp(phone, text) {
    window.open(`https://wa.me/${waNumber(phone)}?text=${encodeURIComponent(text)}`, '_blank');
  }
  function custOfInvoice(inv) {
    return customers.find(c => c.id === inv.customerId) || { id: inv.customerId, name: inv.customerName, phone: inv.customerPhone };
  }

  function openStatement(cust) {
    const rows = customerLedger(cust);
    const bal = customerBalance(cust.id, cust.name, cust.phone);
    $('#modalRoot').innerHTML = `
      <div class="modal-overlay"><div class="modal-sheet">
        <div class="modal-handle"></div>
        <div class="modal-header"><h3 class="modal-title">Statement · ${escapeHtml(cust.name)}</h3>
          <button class="modal-close" data-action="close-modal"><svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg></button></div>
        <div class="stats-grid mb-16">
          <div class="stat-card"><div class="stat-label">Net Sales</div><div class="stat-value primary">${settings.currency} ${money(bal.total)}</div></div>
          <div class="stat-card"><div class="stat-label">${bal.credit > 0 ? 'Credit' : 'Balance due'}</div><div class="stat-value ${bal.due > 0 ? 'danger' : 'success'}">${settings.currency} ${money(bal.credit > 0 ? bal.credit : bal.due)}</div></div>
        </div>
        ${rows.length ? `<div class="ledger">${rows.slice().reverse().map(r => `
          <div class="led-row"><div class="led-main"><div class="led-text">${escapeHtml(r.text)}</div><div class="text-sm text-secondary">${formatDate(r.date)}</div></div>
            <div class="led-amts"><div class="${r.debit ? 'led-dr' : 'led-cr'}">${r.debit ? '+' : '−'}${money(r.debit || r.credit)}</div><div class="text-sm text-secondary">Bal ${money(r.balance)}</div></div></div>`).join('')}</div>` : '<div class="doc-empty">No transactions yet</div>'}
        <div class="flex gap-8 mt-16">
          <button class="btn btn-secondary" style="flex:1" data-action="statement-pdf" data-id="${cust.id}">PDF</button>
          <button class="btn btn-primary" style="flex:1" data-action="statement-wa" data-id="${cust.id}">WhatsApp</button>
        </div>
      </div></div>`;
  }

  function statementPDF(cust) {
    const { jsPDF } = window.jspdf;
    const doc = new jsPDF({ unit: 'mm', format: 'a4' });
    const W = 210, m = 16;
    const TH = HisablyReceipt.themeOf(settings), D = HisablyReceipt.hexRgb(TH.dark);
    const rows = customerLedger(cust);
    const bal = customerBalance(cust.id, cust.name, cust.phone);
    let y = 20;
    doc.setFont('helvetica', 'bold'); doc.setFontSize(16); doc.setTextColor(D[0], D[1], D[2]);
    doc.text(settings.businessName || 'Business', m, y);
    doc.setFontSize(11); doc.text('STATEMENT OF ACCOUNT', W - m, y, { align: 'right' });
    y += 8; doc.setFontSize(9); doc.setFont('helvetica', 'normal'); doc.setTextColor(100);
    if (settings.phone) { doc.text(settings.phone, m, y); }
    doc.text('Date: ' + formatDate(new Date().toISOString()), W - m, y, { align: 'right' });
    y += 8; doc.setTextColor(15, 23, 42); doc.setFont('helvetica', 'bold'); doc.setFontSize(11);
    doc.text('Customer: ' + cust.name, m, y); y += 5;
    doc.setFont('helvetica', 'normal'); doc.setFontSize(9); doc.setTextColor(100);
    if (cust.phone) { doc.text(cust.phone, m, y); y += 5; }
    y += 3;
    const head = () => {
      doc.setFillColor(241, 245, 249); doc.roundedRect(m, y, W - 2 * m, 8, 1.5, 1.5, 'F');
      doc.setFont('helvetica', 'bold'); doc.setFontSize(8); doc.setTextColor(100);
      doc.text('DATE', m + 3, y + 5.5); doc.text('DETAILS', m + 28, y + 5.5);
      doc.text('DEBIT', m + 118, y + 5.5, { align: 'right' }); doc.text('CREDIT', m + 144, y + 5.5, { align: 'right' }); doc.text('BALANCE', W - m - 3, y + 5.5, { align: 'right' });
      y += 12;
    };
    head();
    doc.setFont('helvetica', 'normal'); doc.setFontSize(8.5); doc.setTextColor(15, 23, 42);
    rows.forEach(r => {
      if (y > 275) { doc.addPage(); y = 20; head(); doc.setFont('helvetica', 'normal'); doc.setFontSize(8.5); doc.setTextColor(15, 23, 42); }
      doc.text(formatDate(r.date), m + 3, y);
      const t = doc.splitTextToSize(r.text, 82);
      doc.text(t[0], m + 28, y);
      if (r.debit) doc.text(money(r.debit), m + 118, y, { align: 'right' });
      if (r.credit) doc.text(money(r.credit), m + 144, y, { align: 'right' });
      doc.text(money(r.balance), W - m - 3, y, { align: 'right' });
      y += 6.5;
    });
    if (y > 262) { doc.addPage(); y = 20; }
    y += 4; doc.setDrawColor(226, 232, 240); doc.line(m, y, W - m, y); y += 8;
    doc.setFont('helvetica', 'bold'); doc.setFontSize(11); doc.setTextColor(D[0], D[1], D[2]);
    doc.text(bal.credit > 0 ? 'Credit with us' : 'Balance due', W - m - 60, y);
    doc.text(`${settings.currency} ${money(bal.credit > 0 ? bal.credit : bal.due)}`, W - m, y, { align: 'right' });
    doc.save(`Statement-${(cust.name || 'customer').replace(/[^a-z0-9]+/gi, '-')}.pdf`);
  }

  // ---------- Security: PIN lock + staff mode ----------
  // Device-level protection (keeps casual access out). It is not a server-side permission system.
  const ROLE_KEY = 'hisably_role_v1';
  const STAFF_VIEWS = ['dashboard', 'products', 'create-invoice', 'invoices', 'customers', 'more'];
  const STAFF_BLOCK = /^(add-product|edit-product|delete-|bulk-|stock-in|open-settings|open-plans|open-shopify|shopify-|export-data|import-data|clear-data|add-expense|edit-expense|new-purchase|view-purchase|purchase-|view-supplier|pay-supplier|add-supplier|edit-supplier|cloud-auth|sign-out-user|submit-payment|db-|pick-|remove-|pin-)/;
  let _lastHidden = 0, _pinFails = 0, _pinWaitUntil = 0;
  function lockEnabled() { return !!settings.pinHash && !!(window.HisablyFreemium && HisablyFreemium.hasFeature('passcode')); }
  function getRole() { try { return sessionStorage.getItem(ROLE_KEY) || ''; } catch (e) { return ''; } }
  function setRole(r) { try { if (r) sessionStorage.setItem(ROLE_KEY, r); else sessionStorage.removeItem(ROLE_KEY); } catch (e) {} }
  function isStaff() { return lockEnabled() && getRole() === 'staff'; }
  async function pinHash(pin) {
    const str = `${settings.pinSalt || ''}:${pin}`;
    try {
      if (window.crypto && crypto.subtle) {
        const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(str));
        return Array.from(new Uint8Array(buf)).map(b => b.toString(16).padStart(2, '0')).join('');
      }
    } catch (e) {}
    let h = 5381;                                   // fallback where crypto.subtle is unavailable
    for (let r = 0; r < 2000; r++) for (let i = 0; i < str.length; i++) h = ((h * 33) ^ str.charCodeAt(i) ^ r) >>> 0;
    return 'f' + h.toString(16);
  }

  function showLock(mode) {
    if (!lockEnabled()) return;
    setRole('');
    let el = document.getElementById('lockScreen');
    if (!el) { el = document.createElement('div'); el.id = 'lockScreen'; el.className = 'lock-screen'; document.body.appendChild(el); }
    el.hidden = false;
    if (mode === 'forgot') renderForgot(el); else renderLock(el, '');
  }
  function hideLock() { const el = document.getElementById('lockScreen'); if (el) el.hidden = true; }
  function renderLock(el, entered, msg) {
    const keys = ['1', '2', '3', '4', '5', '6', '7', '8', '9', '', '0', '⌫'];
    el.innerHTML = `<div class="lock-box">
      <div class="logo-circle" style="margin:0 auto 12px">H</div>
      <div class="lock-title">${escapeHtml(settings.businessName || 'Hisably')}</div>
      <div class="lock-sub">${msg ? escapeHtml(msg) : 'Enter your PIN'}</div>
      <div class="lock-dots">${[0, 1, 2, 3].map(i => `<span class="${i < entered.length ? 'on' : ''}"></span>`).join('')}</div>
      <div class="lock-pad">${keys.map(k => k === '' ? '<span></span>' : `<button type="button" data-k="${k}">${k}</button>`).join('')}</div>
      <button type="button" class="lock-link" data-lock="forgot">Forgot PIN?</button></div>`;
    el.querySelectorAll('[data-k]').forEach(b => b.addEventListener('click', () => keyPress(el, entered, b.dataset.k)));
    const f = el.querySelector('[data-lock="forgot"]'); if (f) f.addEventListener('click', () => renderForgot(el));
  }
  async function keyPress(el, entered, k) {
    if (k === '⌫') return renderLock(el, entered.slice(0, -1));
    if (entered.length >= 4) return;
    entered += k;
    renderLock(el, entered);
    if (entered.length < 4) return;
    if (Date.now() < _pinWaitUntil) { renderLock(el, '', `Too many tries. Wait ${Math.ceil((_pinWaitUntil - Date.now()) / 1000)}s`); return; }
    const h = await pinHash(entered);
    if (h === settings.pinHash) { _pinFails = 0; setRole('owner'); hideLock(); render(); return; }
    if (settings.staffHash && h === settings.staffHash) { _pinFails = 0; setRole('staff'); hideLock(); setView('dashboard'); return; }
    _pinFails++;
    if (_pinFails >= 5) { _pinWaitUntil = Date.now() + 30000; _pinFails = 0; }
    const box = el.querySelector('.lock-box'); if (box) box.classList.add('shake');
    setTimeout(() => renderLock(el, '', 'Wrong PIN'), 350);
  }
  function renderForgot(el) {
    const cloud = window.HisablyCloud && HisablyCloud.ready() && HisablyCloud.getSession();
    el.innerHTML = `<div class="lock-box">
      <div class="lock-title">Reset PIN</div>
      ${cloud ? `<div class="lock-sub">Enter your account password to remove the PIN lock.</div>
        <input type="password" class="form-input" id="lockPw" placeholder="Account password" autocomplete="current-password" />
        <button type="button" class="btn btn-primary btn-block mt-12" id="lockReset">Remove PIN lock</button>`
        : `<div class="lock-sub">Sign in to your cloud account on this device to reset the PIN. Without a cloud account the PIN cannot be reset.</div>`}
      <button type="button" class="lock-link" id="lockBack">Back</button></div>`;
    el.querySelector('#lockBack').addEventListener('click', () => renderLock(el, ''));
    const rb = el.querySelector('#lockReset');
    if (rb) rb.addEventListener('click', async () => {
      const pw = el.querySelector('#lockPw').value;
      const email = HisablyCloud.getSession().user.email;
      rb.disabled = true;
      try { await HisablyCloud.signIn(email, pw); settings.pinHash = ''; settings.staffHash = ''; persist(); setRole('owner'); hideLock(); toast('PIN lock removed'); render(); }
      catch (e) { toast('Wrong password'); rb.disabled = false; }
    });
  }
  function openPinModal(kind) {
    const staff = kind === 'staff';
    if (!window.HisablyFreemium || !HisablyFreemium.hasFeature('passcode')) { toast('PIN lock and staff mode are Pro features.', 4500); openPlansModal && openPlansModal(); return; }
    if (staff && !settings.pinHash) { toast('Set the owner PIN first'); return; }
    $('#modalRoot').innerHTML = `
      <div class="modal-overlay"><div class="modal-sheet">
        <div class="modal-handle"></div>
        <div class="modal-header"><h3 class="modal-title">${staff ? 'Staff PIN' : 'Owner PIN'}</h3>
          <button class="modal-close" data-action="close-modal"><svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg></button></div>
        <div class="text-sm text-secondary mb-8">${staff ? 'Staff can make sales, quotations and returns and receive payments. They cannot see profit, costs, reports or settings, and cannot delete anything.' : 'The owner PIN opens everything. Choose 4 digits you will remember.'}</div>
        <form id="pinForm" autocomplete="off">
          <div class="form-group"><label class="form-label">New PIN (4 digits)</label><input type="password" inputmode="numeric" maxlength="4" pattern="[0-9]{4}" class="form-input" id="pin1" /></div>
          <div class="form-group"><label class="form-label">Repeat PIN</label><input type="password" inputmode="numeric" maxlength="4" pattern="[0-9]{4}" class="form-input" id="pin2" /></div>
          <button type="submit" class="btn btn-primary btn-block mt-12">Save PIN</button>
        </form></div></div>`;
    document.getElementById('pinForm').addEventListener('submit', async e => {
      e.preventDefault();
      const a = document.getElementById('pin1').value, b = document.getElementById('pin2').value;
      if (!/^\d{4}$/.test(a)) { toast('PIN must be 4 digits'); return; }
      if (a !== b) { toast('PINs do not match'); return; }
      if (!settings.pinSalt) settings.pinSalt = uid().replace(/-/g, '');
      const h = await pinHash(a);
      if (staff && h === settings.pinHash) { toast('Staff PIN must be different from the owner PIN'); return; }
      if (!staff && settings.staffHash && h === settings.staffHash) { toast('Owner PIN must be different from the staff PIN'); return; }
      if (staff) settings.staffHash = h; else { settings.pinHash = h; setRole('owner'); }
      persist(); toast(staff ? 'Staff PIN saved' : 'Owner PIN saved. The app will lock when you leave it.');
      openSettingsModal();
    });
  }
  function themePickerHTML() {
    const cur = settings.invoiceTheme || 'teal';
    const ok = window.HisablyFreemium && HisablyFreemium.hasFeature('themes');
    const T = HisablyReceipt.THEMES;
    const th = T[cur] || T.teal, band = th.style === 'band';
    return `<div class="doc-card" id="themePicker" style="margin-top:12px">
      <div class="doc-label">Invoice style (PDF, image &amp; A4 print)</div>
      <div class="chip-row mb-8">${Object.keys(T).map(k => `<button type="button" class="cat-chip${k === cur ? ' active' : ''}" data-action="pick-theme" data-theme="${k}"><span class="theme-dot" style="background:${T[k].accent}"></span>${T[k].name}${T[k].pro && !ok ? ' 🔒' : ''}</button>`).join('')}</div>
      <div class="theme-prev" style="${band ? `background:${th.accent};color:#fff` : `border-bottom:3px solid ${th.accent}`}">
        <b>${escapeHtml(settings.businessName || 'Your business')}</b><span>INVOICE</span></div>
      <div class="theme-prev-tot" style="background:${th.soft};color:${th.dark}"><span>Total</span><b>${escapeHtml(settings.currency || '')} 1,000</b></div>
      ${ok ? '' : '<div class="text-sm text-secondary mt-8">🔒 More styles are available on Pro.</div>'}
    </div>`;
  }
  function securityHTML() {
    const ok = window.HisablyFreemium && HisablyFreemium.hasFeature('passcode');
    return `<div class="doc-card" style="margin-top:12px">
      <div class="doc-label">App lock &amp; staff ${ok ? '' : '<span style="font-size:10px;background:var(--primary);color:#fff;border-radius:6px;padding:1px 6px;margin-left:6px">PRO</span>'}</div>
      <div class="text-sm text-secondary mb-8">${settings.pinHash ? 'Lock is ON.' + (settings.staffHash ? ' Staff PIN is set.' : ' No staff PIN yet.') : 'Protect the app with a PIN and give your staff a limited login.'}</div>
      <div class="flex gap-8" style="flex-wrap:wrap">
        <button type="button" class="btn btn-secondary btn-sm" data-action="pin-set-owner">${settings.pinHash ? 'Change owner PIN' : 'Set owner PIN'}</button>
        ${settings.pinHash ? `<button type="button" class="btn btn-secondary btn-sm" data-action="pin-set-staff">${settings.staffHash ? 'Change staff PIN' : 'Set staff PIN'}</button>
        <button type="button" class="btn btn-ghost btn-sm" data-action="pin-remove">Remove lock</button>` : ''}
      </div></div>`;
  }
  function staffMoreHTML() {
    return `<div class="fade-in">
      <div class="card mb-16"><div class="text-sm text-secondary">Signed in as</div><div class="font-semibold" style="font-size:1.0625rem">Staff</div></div>
      <div class="menu-list mb-16">
        <button class="menu-item" data-view="customers">Customers<svg class="menu-item-arrow" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="9 18 15 12 9 6"/></svg></button>
        <button class="menu-item" data-action="cloud-sync">Sync now<svg class="menu-item-arrow" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="9 18 15 12 9 6"/></svg></button>
        <button class="menu-item" data-action="lock-now">Lock app<svg class="menu-item-arrow" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="9 18 15 12 9 6"/></svg></button>
      </div></div>`;
  }
  document.addEventListener('visibilitychange', () => {
    if (document.hidden) { _lastHidden = Date.now(); return; }
    if (lockEnabled() && _lastHidden && Date.now() - _lastHidden > 60000) showLock();
  });

  // ---------- Day Book / cash flow ----------
  let dbRange = 'today', dbMode = 'all';
  const PAY_MODES = ['Cash', 'Bank', 'Online', 'Cheque'];
  function dayKey(iso) {
    if (/^\d{4}-\d{2}-\d{2}$/.test(String(iso))) return iso;
    const d = new Date(iso);
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
  }
  function modeChips(id) {
    return `<div class="chip-row mt-8" id="${id}">${PAY_MODES.map((m, i) => `<button type="button" class="cat-chip${i ? '' : ' active'}" data-action="rp-mode" data-mode="${m}">${m}</button>`).join('')}</div>`;
  }
  function pickedMode(id) {
    const a = document.querySelector('#' + id + ' .cat-chip.active');
    return a ? a.dataset.mode : 'Cash';
  }
  // Every rupee that actually moved: payments in, refunds / purchase payments / expenses out
  function cashEntries() {
    const out = [];
    const split = (doc, label, dir, party) => {
      const pays = (doc.meta && doc.meta.payments) || [];
      const first = round2((doc.paidAmount || 0) - pays.reduce((s, p) => s + p.amount, 0));
      if (first > 0.001) out.push({ date: doc.date, mode: (doc.meta && doc.meta.paymentMode) || 'Cash', dir, amount: first, text: `${label} ${doc.number}`, party });
      pays.forEach(p => out.push({ date: p.date, mode: p.mode || 'Cash', dir, amount: p.amount, text: `${label} ${doc.number}${p.note ? ' · ' + p.note : ''}`, party }));
    };
    invoices.forEach(inv => {
      const g = docSign(inv); if (!g) return;
      if (g > 0) split(inv, 'Payment in', 'in', inv.customerName);
      else split(inv, 'Refund', 'out', inv.customerName);
    });
    purchases.forEach(p => split(p, 'Paid for', 'out', p.supplierName));
    expenses.forEach(e => out.push({ date: e.date, mode: 'Cash', dir: 'out', amount: e.amount || 0, text: 'Expense · ' + (e.title || e.category || ''), party: '' }));
    out.forEach(r => { r.day = dayKey(r.date); r.t = /^\d{4}-\d{2}-\d{2}$/.test(String(r.date)) ? ts(r.date + 'T12:00:00') : ts(r.date); });
    return out.filter(r => r.amount > 0).sort((a, b) => b.t - a.t);
  }
  function viewDayBook() {
    const now = new Date();
    const key = off => { const d = new Date(now); d.setDate(d.getDate() - off); return dayKey(d.toISOString()); };
    const ranges = { today: [key(0), key(0)], yesterday: [key(1), key(1)], week: [key(6), key(0)], month: [key(29), key(0)], all: ['0000', '9999'] };
    const [from, to] = ranges[dbRange] || ranges.today;
    const all = cashEntries().filter(r => r.day >= from && r.day <= to);
    const rows = all.filter(r => dbMode === 'all' || r.mode === dbMode);
    const sum = (list, dir) => round2(list.filter(r => r.dir === dir).reduce((s, r) => s + r.amount, 0));
    const inn = sum(rows, 'in'), outt = sum(rows, 'out'), net = round2(inn - outt);
    const cur = settings.currency;
    const rl = [['today', 'Today'], ['yesterday', 'Yesterday'], ['week', '7 days'], ['month', '30 days'], ['all', 'All']];
    const modes = ['all'].concat(PAY_MODES);
    const byMode = PAY_MODES.map(m => { const l = all.filter(r => r.mode === m); return { m, i: sum(l, 'in'), o: sum(l, 'out') }; }).filter(x => x.i || x.o);
    const days = [];
    rows.forEach(r => { let d = days[days.length - 1]; if (!d || d.day !== r.day) { d = { day: r.day, list: [] }; days.push(d); } d.list.push(r); });
    return `<div class="fade-in">
      <div class="cat-chips">${rl.map(r => `<button class="cat-chip${dbRange === r[0] ? ' active' : ''}" data-action="db-range" data-v="${r[0]}">${r[1]}</button>`).join('')}</div>
      <div class="cat-chips">${modes.map(m => `<button class="cat-chip${dbMode === m ? ' active' : ''}" data-action="db-mode" data-v="${m}">${m === 'all' ? 'All modes' : m}</button>`).join('')}</div>
      <div class="stats-grid" style="grid-template-columns:repeat(2,1fr)">
        <div class="stat-card"><div class="stat-label">Money In</div><div class="stat-value success" style="font-size:1.125rem">${cur} ${money(inn)}</div></div>
        <div class="stat-card"><div class="stat-label">Money Out</div><div class="stat-value danger" style="font-size:1.125rem">${cur} ${money(outt)}</div></div>
      </div>
      <div class="doc-card tot-row" style="margin-top:-4px"><span>Net cash flow</span><b style="color:var(--${net >= 0 ? 'success' : 'danger'})">${net < 0 ? '−' : ''}${cur} ${money(Math.abs(net))}</b></div>
      ${byMode.length ? `<div class="doc-card"><div class="doc-label">By payment mode</div>${byMode.map(x => `
        <div class="tot-row"><span>${x.m}</span><span class="text-sm"><span style="color:var(--success)">+${money(x.i)}</span> &nbsp; <span style="color:var(--danger)">−${money(x.o)}</span> &nbsp; <b>${money(round2(x.i - x.o))}</b></span></div>`).join('')}</div>` : ''}
      ${days.length === 0 ? '<div class="doc-empty">No money moved in this period</div>' : days.map(d => {
        const dn = round2(sum(d.list, 'in') - sum(d.list, 'out'));
        return `<div class="section-header"><h2 class="section-title">${formatDate(d.day + 'T12:00:00')}</h2><span class="text-sm" style="color:var(--${dn >= 0 ? 'success' : 'danger'});font-weight:700">${dn < 0 ? '−' : ''}${money(Math.abs(dn))}</span></div>
        <div class="list">${d.list.map(r => `
          <div class="list-item"><div class="list-item-body"><div class="list-item-title">${escapeHtml(r.text)}</div>
            <div class="list-item-sub">${escapeHtml(r.party || '')}${r.party ? ' · ' : ''}${escapeHtml(r.mode)}</div></div>
            <div class="list-item-right"><div class="list-item-price" style="color:var(--${r.dir === 'in' ? 'success' : 'danger'})">${r.dir === 'in' ? '+' : '−'}${money(r.amount)}</div></div></div>`).join('')}</div>`;
      }).join('')}
    </div>`;
  }

  // ---------- Purchases & supplier payables ----------
  function nextPurNumber() {
    let mx = 1000;
    purchases.forEach(p => { const m = String(p.number).match(/(\d+)\s*$/); if (m) mx = Math.max(mx, parseInt(m[1], 10)); });
    return `PUR-${mx + 1}`;
  }
  function supplierOf(p) {
    return suppliers.find(s => s.id === p.supplierId) || { id: p.supplierId, name: p.supplierName, phone: p.supplierPhone };
  }
  function supplierPurchases(sup) {
    return purchases.filter(p => (sup.id && p.supplierId === sup.id) || (!p.supplierId && p.supplierName && p.supplierName.toLowerCase() === (sup.name || '').toLowerCase()));
  }
  function supplierBalance(sup) {
    let total = 0, paid = 0;
    supplierPurchases(sup).forEach(p => { total += p.total || 0; paid += p.paidAmount || 0; });
    return { total, paid, due: Math.max(0, round2(total - paid)) };
  }
  function totalPayable() {
    return round2(purchases.reduce((s, p) => s + Math.max(0, (p.total || 0) - (p.paidAmount || 0)), 0));
  }

  function listPurchase(p) {
    const paid = p.paidAmount || 0, due = Math.max(0, (p.total || 0) - paid);
    const badge = due <= 0.001 ? '<span class="list-item-badge badge-ok">Paid</span>'
      : (paid > 0 ? `<span class="list-item-badge badge-low">Owe ${settings.currency} ${money(due)}</span>` : '<span class="list-item-badge badge-out">Unpaid</span>');
    return `<div class="list-item" data-action="view-purchase" data-id="${p.id}">
      <div class="list-item-icon">${initials(p.supplierName || 'S')}</div>
      <div class="list-item-body">
        <div class="list-item-title">${escapeHtml(p.supplierName || 'Unknown supplier')}</div>
        <div class="list-item-sub">${escapeHtml(p.number)} · ${formatDate(p.date)} · ${p.items.length} item${p.items.length !== 1 ? 's' : ''}</div>
        ${badge}${isOverdue(p) ? ' <span class="list-item-badge badge-out">Overdue</span>' : ''}
      </div>
      <div class="list-item-right"><div class="list-item-price">${settings.currency} ${money(p.total)}</div></div>
    </div>`;
  }
  function viewPurchases() {
    if (purchases.length === 0) {
      return emptyState('box', 'No purchases yet', 'Record stock you buy from suppliers. Stock goes up and you can track what you owe.', 'Add Purchase', null, 'new-purchase');
    }
    const owe = totalPayable();
    const list = [...purchases].sort((a, b) => ts(b.date) - ts(a.date));
    return `<div class="fade-in">
      <div class="stats-grid" style="grid-template-columns:repeat(2,1fr)">
        <div class="stat-card"><div class="stat-label">Total Bought</div><div class="stat-value primary" style="font-size:1.125rem">${settings.currency} ${money(purchases.reduce((s, p) => s + (p.total || 0), 0))}</div></div>
        <div class="stat-card"><div class="stat-label">To Pay</div><div class="stat-value ${owe > 0 ? 'danger' : 'success'}" style="font-size:1.125rem">${settings.currency} ${money(owe)}</div></div>
      </div>
      <div class="list">${list.map(listPurchase).join('')}</div></div>`;
  }

  function openPurchaseDetail(p) {
    const paid = p.paidAmount || 0, due = Math.max(0, round2((p.total || 0) - paid));
    const x = invExtraRows(p);
    const pays = (p.meta && p.meta.payments) || [];
    const first = round2(paid - pays.reduce((s, q) => s + q.amount, 0));
    $('#modalRoot').innerHTML = `
      <div class="modal-overlay"><div class="modal-sheet">
        <div class="modal-handle"></div>
        <div class="modal-header"><h3 class="modal-title">Purchase ${escapeHtml(p.number)}</h3>
          <button class="modal-close" data-action="close-modal"><svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg></button></div>
        <div class="mb-16"><div class="text-sm text-secondary">Supplier</div><div class="font-semibold">${escapeHtml(p.supplierName || 'Unknown')}</div>
          <div class="text-sm text-secondary mt-8">${formatDate(p.date)}${p.meta && p.meta.billNo ? ' · Bill ' + escapeHtml(p.meta.billNo) : ''}</div></div>
        <div class="invoice-summary">
          ${p.items.map(it => `<div class="summary-row"><span>${escapeHtml(it.name)} × ${it.qty} @ ${money(it.price)}</span><span>${settings.currency} ${money(it.price * it.qty)}</span></div>`).join('')}
          ${x.rows.length ? `<div class="summary-row"><span>Subtotal</span><span>${settings.currency} ${money(x.sub)}</span></div>` + x.rows.map(r => `<div class="summary-row"><span>${escapeHtml(r.label)}</span><span>${r.amt < 0 ? '−' : ''}${settings.currency} ${money(Math.abs(r.amt))}</span></div>`).join('') : ''}
          <div class="summary-row total"><span>Total</span><span>${settings.currency} ${money(p.total)}</span></div>
          <div class="summary-row"><span>Paid</span><span style="color:var(--success)">${settings.currency} ${money(paid)}</span></div>
          <div class="summary-row"><span>Balance to pay</span><span style="color:${due > 0 ? 'var(--danger)' : 'var(--success)'}">${settings.currency} ${money(due)}</span></div>
          ${p.meta && p.meta.dueDate ? `<div class="summary-row"><span>Due date</span><span${isOverdue(p) ? ' style="color:var(--danger);font-weight:600"' : ''}>${formatDate(p.meta.dueDate)}${isOverdue(p) ? ' · overdue' : ''}</span></div>` : ''}
        </div>
        ${(first > 0.001 || pays.length) ? `<div class="doc-label mt-16">Payments made</div>
          ${first > 0.001 ? `<div class="summary-row"><span>${formatDate(p.date)}${p.meta && p.meta.paymentMode ? ' · ' + escapeHtml(p.meta.paymentMode) : ''}</span><span>${settings.currency} ${money(first)}</span></div>` : ''}
          ${pays.map(q => `<div class="summary-row"><span>${formatDate(q.date)} · ${escapeHtml(q.mode || '')}${q.note ? ' · ' + escapeHtml(q.note) : ''}</span><span>${settings.currency} ${money(q.amount)}</span></div>`).join('')}` : ''}
        ${due > 0.001 ? `
        <div class="form-group mt-16"><label class="form-label">Record payment to supplier</label>
          <div class="input-with-btn"><input type="number" class="form-input" id="recordPayInput" min="0" step="any" placeholder="Amount" />
            <button type="button" class="btn btn-primary btn-sm" style="height:48px" data-action="purchase-pay" data-id="${p.id}">Add</button></div>${modeChips('rpMode')}</div>
        <button class="btn btn-secondary btn-block mt-8" data-action="purchase-pay-full" data-id="${p.id}">Mark as Fully Paid</button>` : ''}
      </div></div>`;
  }

  function openSupplierDetail(sup) {
    const bal = supplierBalance(sup);
    const list = supplierPurchases(sup).sort((a, b) => ts(b.date) - ts(a.date));
    $('#modalRoot').innerHTML = `
      <div class="modal-overlay"><div class="modal-sheet">
        <div class="modal-handle"></div>
        <div class="modal-header"><h3 class="modal-title">${escapeHtml(sup.name)}</h3>
          <button class="modal-close" data-action="close-modal"><svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg></button></div>
        <div class="text-sm text-secondary mb-8">${escapeHtml(sup.phone || 'No phone')}</div>
        <div class="stats-grid mb-16">
          <div class="stat-card"><div class="stat-label">Total Bought</div><div class="stat-value primary">${settings.currency} ${money(bal.total)}</div></div>
          <div class="stat-card"><div class="stat-label">You Owe</div><div class="stat-value ${bal.due > 0 ? 'danger' : 'success'}">${settings.currency} ${money(bal.due)}</div></div>
        </div>
        <div class="section-header"><h2 class="section-title">Purchase history</h2></div>
        ${list.length ? `<div class="list">${list.map(listPurchase).join('')}</div>` : '<div class="text-secondary text-sm">No purchases yet</div>'}
        <div class="flex gap-8 mt-16">
          ${bal.due > 0 ? `<button class="btn btn-primary" style="flex:1" data-action="pay-supplier" data-id="${sup.id}">Pay Supplier</button>` : ''}
          <button class="btn btn-secondary" style="flex:1" data-action="edit-supplier" data-id="${sup.id}">Edit</button>
        </div>
      </div></div>`;
  }

  function openPaySupplierModal(sup) {
    const bal = supplierBalance(sup);
    const today = new Date().toISOString().slice(0, 10);
    $('#modalRoot').innerHTML = `
      <div class="modal-overlay"><div class="modal-sheet">
        <div class="modal-handle"></div>
        <div class="modal-header"><h3 class="modal-title">Pay Supplier</h3>
          <button class="modal-close" data-action="close-modal"><svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg></button></div>
        <div class="text-secondary text-sm mb-8">${escapeHtml(sup.name)} · You owe ${settings.currency} ${money(bal.due)}</div>
        <form id="paySupForm" autocomplete="off">
          <div class="form-group"><label class="form-label">Amount (${settings.currency})</label><input type="number" inputmode="decimal" class="form-input" id="psAmt" min="0" step="any" value="${bal.due}" /></div>
          <div class="chip-row mb-8" id="psMode"><button type="button" class="cat-chip active" data-mode="Cash">Cash</button><button type="button" class="cat-chip" data-mode="Bank">Bank</button><button type="button" class="cat-chip" data-mode="Online">Online</button><button type="button" class="cat-chip" data-mode="Cheque">Cheque</button></div>
          <div class="form-row"><div class="form-group"><label class="form-label">Date</label><input type="date" class="form-input" id="psDate" value="${today}" max="${today}" /></div>
            <div class="form-group"><label class="form-label">Note</label><input type="text" class="form-input" id="psNote" maxlength="40" placeholder="Optional" /></div></div>
          <div class="text-sm text-secondary">Settles the oldest unpaid purchases first.</div>
          <button type="submit" class="btn btn-primary btn-block mt-16">Save Payment</button>
        </form></div></div>`;
    let mode = 'Cash';
    document.querySelectorAll('#psMode .cat-chip').forEach(b => b.addEventListener('click', () => { mode = b.dataset.mode; document.querySelectorAll('#psMode .cat-chip').forEach(x => x.classList.toggle('active', x === b)); }));
    document.getElementById('paySupForm').addEventListener('submit', e => {
      e.preventDefault();
      let amt = round2(parseFloat(document.getElementById('psAmt').value) || 0);
      if (amt <= 0) { toast('Enter an amount'); return; }
      if (amt > bal.due + 0.001) { toast(`You only owe ${settings.currency} ${money(bal.due)}`, 3500); return; }
      const d = document.getElementById('psDate').value;
      const dateIso = (d && d !== today) ? new Date(d + 'T12:00:00').toISOString() : new Date().toISOString();
      const note = document.getElementById('psNote').value.trim();
      let n = 0;
      supplierPurchases(sup).filter(p => (p.total || 0) - (p.paidAmount || 0) > 0.001).sort((a, b) => ts(a.date) - ts(b.date)).forEach(p => {
        if (amt <= 0.001) return;
        const used = addPayment(p, amt, mode, note, dateIso); if (used > 0) { amt = round2(amt - used); n++; }
      });
      persist(); toast(`Payment saved · ${n} purchase${n !== 1 ? 's' : ''} updated`); render(); openSupplierDetail(sup);
    });
  }

  // ---------- Create Invoice (Vyapar-style document form) ----------
  // Totals math shared by the form, detail view, PDF, receipt and WhatsApp text.
  function calcDoc(lines, o) {
    o = o || {};
    const sub = round2(lines.reduce((s, l) => s + (Number(l.price) || 0) * (Number(l.qty) || 0), 0));
    let discount = o.discType === 'pct' ? sub * (Number(o.discValue) || 0) / 100 : (Number(o.discValue) || 0);
    discount = round2(Math.min(Math.max(discount, 0), sub));
    const taxable = round2(sub - discount);
    const taxRate = Math.max(0, Number(o.taxRate) || 0);
    const tax = round2(taxable * taxRate / 100);
    const charges = round2(Math.max(0, Number(o.charges) || 0));
    const raw = taxable + tax + charges;
    const total = o.roundOff ? Math.round(raw) : round2(raw);
    const roundOff = round2(total - raw);
    return { sub, discount, taxable, taxRate, tax, charges, roundOff, total };
  }
  // Extra rows (discount/tax/charges/round-off) to show under the item list of a saved invoice
  function invExtraRows(inv) {
    const m = inv.meta || {};
    const rows = [];
    const itemsSub = round2((inv.items || []).reduce((s, i) => s + (i.price || 0) * (i.qty || 0), 0));
    if (!(m.discount || m.tax || m.charges || m.roundOff)) return { sub: itemsSub, rows };
    if (m.discount) rows.push({ label: 'Discount' + (m.discType === 'pct' && m.discValue ? ` (${m.discValue}%)` : ''), amt: -m.discount });
    if (m.tax) rows.push({ label: `${m.taxName || 'Tax'} (${m.taxRate}%)`, amt: m.tax });
    if (m.charges) rows.push({ label: m.chargeLabel || 'Additional charges', amt: m.charges });
    if (m.roundOff) rows.push({ label: 'Round off', amt: m.roundOff });
    return { sub: itemsSub, rows };
  }

  function viewCreateInvoice() {
    if (products.length === 0) {
      return emptyState('box', 'Add products first', 'You need at least one product before creating an invoice.', 'Go to Products', 'products');
    }
    const customerOptions = [
      { value: '', label: 'Walk-in Customer' },
      ...customers.map(c => {
        const bal = customerBalance(c.id, c.name, c.phone);
        const debt = bal.due > 0 ? ` · Due ${settings.currency} ${money(bal.due)}` : '';
        return { value: c.id, label: c.name + (c.phone ? ' · ' + c.phone : ' · no phone') + debt };
      })
    ];
    const today = new Date().toISOString().slice(0, 10);
    const cur = settings.currency;
    const isRet = docCtx.type === 'return';
    const isEst = docCtx.type === 'estimate';
    const isPur = docCtx.type === 'purchase';
    const ref = docCtx.ref;
    const numLabel = isPur ? 'Purchase No.' : isRet ? 'Credit Note No.' : (isEst ? 'Quotation No.' : 'Invoice No.');
    const numText = isPur ? nextPurNumber() : isRet ? nextDocNumber('CN') : (isEst ? nextDocNumber('QT') : `${settings.invoicePrefix || 'INV'}-${invoiceCounter}`);
    const supplierOptions = [{ value: '', label: 'Select supplier' }, ...suppliers.map(sp => {
      const sb = supplierBalance(sp);
      return { value: sp.id, label: sp.name + (sp.phone ? ' · ' + sp.phone : '') + (sb.due > 0 ? ` · You owe ${settings.currency} ${money(sb.due)}` : '') };
    })];
    const from = docCtx.from;
    return `<div class="fade-in doc-form">
      <form id="invoiceForm" autocomplete="off">
        <div class="doc-card doc-head">
          <div><div class="doc-label">${numLabel}</div><div class="doc-num">${escapeHtml(numText)}</div>${isRet && ref ? `<div class="text-sm text-secondary">Against ${escapeHtml(ref.number)}</div>` : ''}${from ? `<div class="text-sm text-secondary">From ${escapeHtml(from.number)}</div>` : ''}</div>
          <div class="doc-date"><div class="doc-label">Date</div><input type="date" class="doc-date-input" name="docDate" value="${today}" max="${today}" /></div>
        </div>

        ${isPur ? `<div class="doc-card doc-head"><div class="doc-label" style="margin:0">Supplier bill no. (optional)</div><input type="text" class="doc-date-input" name="billNo" maxlength="20" style="max-width:150px;border-bottom:1px solid var(--border)" /></div>` : ''}
        ${isEst ? `<div class="doc-card doc-head"><div class="doc-label" style="margin:0">Valid until (optional)</div><input type="date" class="doc-date-input" name="validUntil" /></div>` : ''}
        <div class="doc-card">
          <div class="doc-label">${isPur ? 'Supplier' : 'Bill to'}</div>
          ${isPur ? customSelect('customerId', supplierOptions, '', 'Select supplier', true) : customSelect('customerId', customerOptions, '', 'Walk-in Customer', true)}
          <div class="form-row mt-8">
            <input type="text" class="form-input" name="customerName" id="customerNameInput" placeholder="${isPur ? 'Or type supplier name' : 'Or type customer name'}" />
            <input type="tel" class="form-input" name="customerPhone" id="customerPhoneInput" placeholder="Phone (optional)" />
          </div>
        </div>

        <div class="doc-card">
          <div class="doc-card-head">
            <span class="doc-label" style="margin:0">Items</span>
            <span class="doc-actions">
              <button type="button" class="chip-btn" data-action="scan-invoice-barcode">Scan</button>
              <button type="button" class="chip-btn chip-btn-primary" id="addItemsBtn">+ Add Items</button>
            </span>
          </div>
          <div id="docLines"></div>
        </div>

        <div class="doc-card" id="docTotals" style="display:none">
          <div class="tot-row"><span>Subtotal</span><b id="tSub"></b></div>
          <div class="tot-row tot-input">
            <span>Discount</span>
            <span class="tot-ctl">
              <span class="seg" id="discSeg"><button type="button" data-dt="amt" class="on">${escapeHtml(cur)}</button><button type="button" data-dt="pct">%</button></span>
              <input type="number" inputmode="decimal" min="0" step="any" id="discIn" placeholder="0" />
            </span>
          </div>
          <div class="tot-row tot-input">
            <span>Tax %</span>
            <span class="tot-ctl"><input type="number" inputmode="decimal" min="0" step="any" id="taxIn" placeholder="0" value="${(isRet && ref && ref.meta && ref.meta.taxRate) ? ref.meta.taxRate : (from && from.meta && from.meta.taxRate != null ? (from.meta.taxRate || '') : (settings.taxRate ? settings.taxRate : ''))}" /></span>
          </div>
          <div class="tot-row tot-input">
            <span><input type="text" id="chLabel" class="tot-label-in" placeholder="Additional charges" maxlength="30" /></span>
            <span class="tot-ctl"><input type="number" inputmode="decimal" min="0" step="any" id="chIn" placeholder="0" /></span>
          </div>
          <label class="tot-row tot-check"><span>Round off</span><input type="checkbox" id="roundIn" /></label>
          <div class="tot-sep"></div>
          <div class="tot-row tot-grand"><span>Total</span><b id="tTotal"></b></div>
        </div>

        <div class="doc-card" id="docPay" style="display:none">
          <div class="doc-card-head">
            <span class="doc-label" style="margin:0">${isPur ? 'Paid to supplier' : isRet ? 'Refund paid to customer' : 'Payment received'}</span>
            <label class="paid-toggle"><input type="checkbox" id="paidFull" /> <span>${isPur ? 'Paid in full' : isRet ? 'Refunded in full' : 'Received in full'}</span></label>
          </div>
          <input type="number" inputmode="decimal" min="0" step="any" class="form-input" id="paidIn" placeholder="0" name="paidAmount" />
          <div class="chip-row mt-8" id="modeRow">
            <button type="button" class="cat-chip active" data-mode="Cash">Cash</button>
            <button type="button" class="cat-chip" data-mode="Bank">Bank</button>
            <button type="button" class="cat-chip" data-mode="Online">Online</button>
            <button type="button" class="cat-chip" data-mode="Cheque">Cheque</button>
          </div>
          <div class="tot-row mt-8"><span>${isPur ? 'Balance payable' : isRet ? 'Credit left with customer' : 'Balance due'}</span><b id="tDue"></b></div>
          ${isRet ? '' : `<div class="tot-row tot-input"><span>Due date</span><span class="tot-ctl"><input type="date" id="dueIn" name="dueDate" min="${today}" style="width:150px" /></span></div>
          <div class="chip-row"><button type="button" class="cat-chip" data-due="7">+7 days</button><button type="button" class="cat-chip" data-due="15">+15 days</button><button type="button" class="cat-chip" data-due="30">+30 days</button></div>`}
        </div>

        <div class="save-bar" id="saveBar">
          <div><div class="doc-label" style="margin:0">Total</div><div class="save-total" id="saveTotal">${escapeHtml(cur)} 0</div></div>
          <button type="submit" class="btn btn-primary" id="createInvoiceBtn" disabled>${isPur ? 'Save Purchase' : isRet ? 'Save Return' : (isEst ? 'Save Quotation' : 'Save Invoice')}</button>
        </div>
      </form>
    </div>`;
  }

  function bindCreateInvoice() {
    const cur = settings.currency;
    const isRet = docCtx.type === 'return';
    const isEst = docCtx.type === 'estimate';
    const isPur = docCtx.type === 'purchase';
    const ref = docCtx.ref || null;
    const from = docCtx.from || null;          // quotation being converted to an invoice
    docCtx = {};                              // consumed: next visit starts a normal invoice
    const lines = [];                         // { productId, name, price, cost, qty }
    const st = { discType: 'amt', mode: 'Cash' };
    // most units of a product this document may contain
    const refQty = {};
    if (isRet && ref) {
      const done = returnedQty(ref.id);
      (ref.items || []).forEach(it => { refQty[it.productId] = (refQty[it.productId] || 0) + it.qty; });
      Object.keys(refQty).forEach(k => { refQty[k] = Math.max(0, refQty[k] - (done[k] || 0)); });
    }
    const capOf = p => (isEst || isPur) ? Infinity : (!isRet ? p.stock : (ref ? (refQty[p.id] || 0) : Infinity));
    window._docIsReturn = isRet;
    window._docLines = lines;

    const val = id => { const el = document.getElementById(id); return el ? el.value : ''; };
    function opts() {
      return { discType: st.discType, discValue: val('discIn'), taxRate: val('taxIn'),
               charges: val('chIn'), roundOff: !!document.getElementById('roundIn')?.checked };
    }
    function recalc(fromPaid) {
      const c = calcDoc(lines, opts());
      const has = lines.length > 0;
      const q = id => document.getElementById(id);
      if (q('docTotals')) q('docTotals').style.display = has ? '' : 'none';
      if (q('docPay')) q('docPay').style.display = (has && !isEst) ? '' : 'none';
      if (q('tSub')) q('tSub').textContent = `${cur} ${money(c.sub)}`;
      if (q('tTotal')) q('tTotal').textContent = `${cur} ${money(c.total)}`;
      if (q('saveTotal')) q('saveTotal').textContent = `${cur} ${money(c.total)}`;
      if (q('createInvoiceBtn')) q('createInvoiceBtn').disabled = !has;
      if (q('paidFull') && q('paidFull').checked && q('paidIn')) q('paidIn').value = c.total || '';
      const paid = Math.min(parseFloat(val('paidIn')) || 0, c.total);
      if (q('tDue')) { q('tDue').textContent = `${cur} ${money(Math.max(0, round2(c.total - paid)))}`; }
      return c;
    }
    function renderLines() {
      const box = document.getElementById('docLines');
      if (!box) return;
      if (!lines.length) {
        box.innerHTML = `<div class="doc-empty">No items yet. Tap <b>+ Add Items</b> to pick products.</div>`;
      } else {
        box.innerHTML = lines.map((l, i) => `
          <div class="line-card" data-i="${i}">
            <div class="line-top"><span class="line-name">${escapeHtml(l.name)}</span>
              <button type="button" class="line-x" data-del="${i}" aria-label="Remove">✕</button></div>
            <div class="line-grid">
              <div class="qty-control"><button type="button" class="qty-btn" data-q="-1" data-i="${i}">−</button><span class="qty-value">${l.qty}</span><button type="button" class="qty-btn" data-q="1" data-i="${i}">+</button></div>
              <div class="line-rate"><span>×</span><input type="number" inputmode="decimal" min="0" step="any" data-rate="${i}" value="${l.price}"${isStaff() ? ' readonly' : ''} /></div>
              <div class="line-amt" id="la-${i}">${cur} ${money(l.price * l.qty)}</div>
            </div>
          </div>`).join('');
      }
      recalc();
    }
    function addProduct(id, n) {
      const p = products.find(x => x.id === id);
      if (!p) return false;
      let l = lines.find(x => x.productId === id);
      const next = (l ? l.qty : 0) + (n || 1);
      if (next > capOf(p)) { toast(isRet ? 'More than was sold on that invoice' : 'Not enough stock'); return false; }
      if (l) l.qty = next; else lines.push({ productId: p.id, name: p.name, price: isPur ? (p.cost || 0) : p.price, cost: p.cost || 0, qty: next });
      renderLines();
      return true;
    }
    window._docAdd = addProduct;

    const linesBox = document.getElementById('docLines');
    linesBox.addEventListener('click', e => {
      const q = e.target.closest('[data-q]'), d = e.target.closest('[data-del]');
      if (q) {
        const l = lines[+q.dataset.i]; if (!l) return;
        const p = products.find(x => x.id === l.productId);
        const n = l.qty + (+q.dataset.q);
        if (n < 1) { lines.splice(+q.dataset.i, 1); }
        else if (p && n > capOf(p)) { toast(isRet ? 'More than was sold on that invoice' : 'Not enough stock'); return; }
        else l.qty = n;
        renderLines();
      } else if (d) { lines.splice(+d.dataset.del, 1); renderLines(); }
    });
    linesBox.addEventListener('input', e => {
      const r = e.target.closest('[data-rate]'); if (!r) return;
      const l = lines[+r.dataset.rate]; if (!l) return;
      l.price = Math.max(0, parseFloat(r.value) || 0);
      const a = document.getElementById('la-' + r.dataset.rate);
      if (a) a.textContent = `${cur} ${money(l.price * l.qty)}`;
      recalc();
    });

    ['discIn', 'taxIn', 'chIn', 'roundIn', 'paidIn'].forEach(id => {
      const el = document.getElementById(id);
      if (!el) return;
      el.addEventListener(id === 'roundIn' ? 'change' : 'input', () => {
        if (id === 'paidIn') { const f = document.getElementById('paidFull'); if (f) f.checked = false; }
        recalc();
      });
    });
    document.getElementById('paidFull').addEventListener('change', () => {
      const f = document.getElementById('paidFull');
      if (!f.checked) document.getElementById('paidIn').value = '';
      recalc();
    });
    document.querySelectorAll('#discSeg button').forEach(b => b.addEventListener('click', () => {
      st.discType = b.dataset.dt;
      document.querySelectorAll('#discSeg button').forEach(x => x.classList.toggle('on', x === b));
      recalc();
    }));
    document.querySelectorAll('[data-due]').forEach(b => b.addEventListener('click', () => {
      const d = new Date(); d.setDate(d.getDate() + (+b.dataset.due));
      const el = document.getElementById('dueIn'); if (el) el.value = d.toISOString().slice(0, 10);
    }));
    document.querySelectorAll('#modeRow .cat-chip').forEach(b => b.addEventListener('click', () => {
      st.mode = b.dataset.mode;
      document.querySelectorAll('#modeRow .cat-chip').forEach(x => x.classList.toggle('active', x === b));
    }));

    if (isStaff()) ['discIn', 'taxIn', 'chIn', 'chLabel', 'roundIn'].forEach(id => { const el = document.getElementById(id); if (el) el.disabled = true; });
    document.getElementById('addItemsBtn').addEventListener('click', () => openItemPicker(lines, addProduct, (isEst || isPur) ? (() => true) : isRet ? (ref ? (p => (refQty[p.id] || 0) > 0) : (() => true)) : null));
    // prefill from the invoice being returned
    if (isRet && ref) {
      (ref.items || []).forEach(it => {
        const left = refQty[it.productId] || 0;
        if (left > 0 && products.some(p => p.id === it.productId)) lines.push({ productId: it.productId, name: it.name, price: it.price, cost: it.cost || 0, qty: left });
      });
      const sel = document.querySelector('[name="customerId"]'); if (sel && ref.customerId) { sel.value = ref.customerId; }
      const nm = document.getElementById('customerNameInput'); if (nm && ref.customerName && ref.customerName !== 'Walk-in Customer') nm.value = ref.customerName;
      const ph = document.getElementById('customerPhoneInput'); if (ph) ph.value = ref.customerPhone || '';
      if (!lines.length) toast('Everything on that invoice was already returned');
    }
    // prefill from the quotation being converted
    if (from) {
      const m = from.meta || {};
      (from.items || []).forEach(it => {
        const p = products.find(x => x.id === it.productId);
        if (!p) return;
        const q = Math.min(it.qty, p.stock);
        if (q > 0) lines.push({ productId: it.productId, name: it.name, price: it.price, cost: p.cost || it.cost || 0, qty: q });
        if (q < it.qty) toast(`${it.name}: only ${p.stock} in stock`, 3500);
      });
      const sel = document.querySelector('[name="customerId"]'); if (sel && from.customerId) sel.value = from.customerId;
      const nm = document.getElementById('customerNameInput'); if (nm && from.customerName && from.customerName !== 'Walk-in Customer') nm.value = from.customerName;
      const ph = document.getElementById('customerPhoneInput'); if (ph) ph.value = from.customerPhone || '';
      if (m.discValue) { document.getElementById('discIn').value = m.discValue; st.discType = m.discType || 'amt';
        document.querySelectorAll('#discSeg button').forEach(x => x.classList.toggle('on', x.dataset.dt === st.discType)); }
      if (m.charges) { document.getElementById('chIn').value = m.charges; document.getElementById('chLabel').value = m.chargeLabel || ''; }
      if (m.roundOff) document.getElementById('roundIn').checked = true;
    }
    renderLines();

    let submitting = false;
    $('#invoiceForm').addEventListener('submit', e => {
      e.preventDefault();
      if (submitting) return;
      if (!isPur && typeof enforceLimit === 'function' && !enforceLimit('invoices', invoices.length)) return;
      const fd = new FormData(e.target);

      // 1) Validate WITHOUT touching stock or counters
      if (!lines.length) { toast('Add at least one item'); return; }
      const short = [];
      if (!isRet && !isEst && !isPur) lines.forEach(l => {
        const p = products.find(x => x.id === l.productId);
        if (!p || p.stock < l.qty) short.push(`${l.name} (only ${p ? p.stock : 0} left)`);
      });
      if (short.length) { toast('Not enough stock: ' + short.join(', '), 4000); return; }
      const o = opts();
      const c = calcDoc(lines, o);
      if (c.total <= 0 && lines.some(l => l.price > 0)) { toast('Discount cannot be more than the bill'); return; }
      let paidAmount = isEst ? 0 : round2(Math.min(Math.max(parseFloat(fd.get('paidAmount')) || 0, 0), c.total));
      const paymentStatus = paidAmount >= c.total && c.total > 0 ? 'paid' : (paidAmount > 0 ? 'partial' : 'unpaid');

      if (isPur) {
        submitting = true;
        const nowP = new Date().toISOString();
        const pk = fd.get('docDate');
        const pDate = (pk && pk !== nowP.slice(0, 10)) ? new Date(pk + 'T12:00:00').toISOString() : nowP;
        const pnum = nextPurNumber();
        let sid = fd.get('customerId') || '', sname = (fd.get('customerName') || '').trim(), sphone = (fd.get('customerPhone') || '').trim();
        if (sid) { const sp = suppliers.find(x => x.id === sid); if (sp) { if (!sname) sname = sp.name; if (!sphone) sphone = sp.phone || ''; } }
        if (!sname) { submitting = false; toast('Choose or type the supplier'); return; }
        if (!sid) {
          let sp = suppliers.find(x => x.name.toLowerCase() === sname.toLowerCase());
          if (!sp) {
            if (typeof enforceLimit === 'function' && !enforceLimit('suppliers', suppliers.length)) { submitting = false; return; }
            sp = { id: uid(), name: sname, phone: sphone, notes: '' }; suppliers.push(sp);
          } else if (sphone && !sp.phone) sp.phone = sphone;
          sid = sp.id; sname = sp.name; sphone = sp.phone || sphone;
        }
        const pitems = lines.map(l => ({ productId: l.productId, name: l.name, price: l.price, qty: l.qty }));
        pitems.forEach(it => {
          const pr = products.find(x => x.id === it.productId);
          if (pr) { pr.stock += it.qty; if (it.price > 0) pr.cost = it.price; }
          stockMovements.unshift({ id: uid(), productId: it.productId, productName: it.name, type: 'in', qty: it.qty, date: nowP, note: `Purchase ${pnum}` });
        });
        const pmeta = { subtotal: c.sub, discount: c.discount, discType: o.discType, discValue: Number(o.discValue) || 0,
          taxName: 'Tax', taxRate: c.taxRate, tax: c.tax, chargeLabel: (document.getElementById('chLabel')?.value || '').trim(), charges: c.charges,
          roundOff: c.roundOff, paymentMode: paidAmount > 0 ? st.mode : '' };
        const bn = (fd.get('billNo') || '').trim(); if (bn) pmeta.billNo = bn;
        const dd = fd.get('dueDate'); if (dd && paymentStatus !== 'paid') pmeta.dueDate = dd;
        const pur = { id: uid(), number: pnum, supplierId: sid, supplierName: sname, supplierPhone: sphone, items: pitems, total: c.total, paymentStatus, paidAmount, meta: pmeta, date: pDate };
        purchases.unshift(pur);
        persist();
        toast('Purchase saved. Stock added.');
        setView('purchases');
        openPurchaseDetail(pur);
        return;
      }

      // 2) Commit
      submitting = true;
      const nowIso = new Date().toISOString();
      const pick = fd.get('docDate');
      const dateIso = (pick && pick !== nowIso.slice(0, 10)) ? new Date(pick + 'T12:00:00').toISOString() : nowIso;
      const invNumber = isRet ? nextDocNumber('CN') : isEst ? nextDocNumber('QT') : `${settings.invoicePrefix || 'INV'}-${invoiceCounter++}`;
      const items = lines.map(l => ({ productId: l.productId, name: l.name, price: l.price, cost: l.cost, qty: l.qty }));
      if (!isEst) items.forEach(it => {
        const p = products.find(x => x.id === it.productId);
        if (p) p.stock += (isRet ? it.qty : -it.qty);
        stockMovements.unshift({ id: uid(), productId: it.productId, productName: it.name, type: isRet ? 'in' : 'out', qty: it.qty, date: nowIso, note: `${isRet ? 'Return' : 'Invoice'} ${invNumber}` });
      });

      let customerId = fd.get('customerId') || '';
      let customerName = (fd.get('customerName') || '').trim();
      let customerPhone = (fd.get('customerPhone') || '').trim();
      if (customerId) {
        const cu = customers.find(x => x.id === customerId);
        if (cu) { if (!customerName) customerName = cu.name; if (!customerPhone) customerPhone = cu.phone || ''; }
      }
      if (!customerName) { customerName = 'Walk-in Customer'; customerId = ''; }
      if (customerName !== 'Walk-in Customer') {
        const cu = findOrCreateCustomer(customerName, customerPhone);
        if (cu) { customerId = cu.id; customerName = cu.name; if (!customerPhone) customerPhone = cu.phone || ''; }
      }

      const meta = {
        subtotal: c.sub, discount: c.discount, discType: o.discType, discValue: Number(o.discValue) || 0,
        taxName: 'Tax', taxRate: c.taxRate, tax: c.tax,
        chargeLabel: (document.getElementById('chLabel')?.value || '').trim(), charges: c.charges,
        roundOff: c.roundOff, paymentMode: paidAmount > 0 ? st.mode : ''
      };
      if (isRet && ref) { meta.refId = ref.id; meta.refNumber = ref.number; }
      if (isEst) { const vu = fd.get('validUntil'); if (vu) meta.validUntil = vu; }
      if (isStaff()) meta.by = 'Staff';
      { const dd = fd.get('dueDate'); if (dd && !isRet && !isEst && paymentStatus !== 'paid') meta.dueDate = dd; }
      if (from) { meta.fromId = from.id; meta.fromNumber = from.number; }
      const inv = {
        id: uid(), number: invNumber, docType: isRet ? 'return' : (isEst ? 'estimate' : 'sale'),
        customerId: customerId || null, customerName, customerPhone,
        items, total: c.total, paymentStatus, paidAmount, meta, date: dateIso
      };
      invoices.unshift(inv);
      persist();
      if (isRet) { toast('Return saved. Stock added back.'); setView('invoices'); openInvoiceDetail(inv); return; }
      if (isEst) { toast('Quotation saved'); invFilter = 'estimate'; setView('invoices'); openInvoiceDetail(inv); return; }
      if (from) { const q = invoices.find(x => x.id === from.id); if (q) { q.meta = Object.assign({}, q.meta, { convertedTo: inv.number, convertedId: inv.id }); q.updatedAt = new Date().toISOString(); persist(); } }
      toast(paymentStatus === 'paid' ? 'Invoice saved (Paid)' : paymentStatus === 'partial' ? 'Invoice saved (Advance recorded)' : 'Invoice saved (Unpaid)');
      setView('invoices');
      openInvoiceDetail(inv);
    });
  }

  // Product picker sheet: search + tap to add (count badge shows what is already on the bill)
  function openItemPicker(lines, addProduct, allow) {
    const cur = settings.currency;
    function rows(q) {
      q = (q || '').trim().toLowerCase();
      const list = products.filter(p => !q || p.name.toLowerCase().includes(q) || (p.barcode || '').toLowerCase().includes(q));
      if (!list.length) return '<div class="doc-empty">No products found</div>';
      return list.map(p => {
        const n = (lines.find(l => l.productId === p.id) || {}).qty || 0;
        const out = allow ? !allow(p) : p.stock <= 0;
        return `<div class="pick-row${out ? ' out' : ''}" data-pid="${p.id}">
          <div style="flex:1;min-width:0"><div class="font-semibold">${escapeHtml(p.name)}</div>
            <div class="text-sm text-secondary">${cur} ${money(p.price)} · ${out ? (allow ? 'Not on that invoice' : 'Out of stock') : 'Stock: ' + p.stock}</div></div>
          ${n ? `<span class="pick-badge">${n}</span>` : ''}
          <span class="pick-add">${out ? '' : '+'}</span></div>`;
      }).join('');
    }
    $('#modalRoot').innerHTML = `
      <div class="modal-overlay" id="pickOverlay">
        <div class="modal-sheet">
          <div class="modal-handle"></div>
          <div class="modal-header"><h3 class="modal-title">Add Items</h3>
            <button class="modal-close" data-action="close-modal"><svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg></button></div>
          <div class="search-wrap mb-8"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="11" cy="11" r="8"/><line x1="21" y1="21" x2="16.65" y2="16.65"/></svg>
            <input type="search" class="search-input" id="pickSearch" placeholder="Search name or barcode" /></div>
          <div id="pickList" class="pick-list">${rows('')}</div>
          <button type="button" class="btn btn-primary btn-block mt-12" data-action="close-modal">Done</button>
        </div>
      </div>`;
    const list = document.getElementById('pickList'), s = document.getElementById('pickSearch');
    s.addEventListener('input', () => { list.innerHTML = rows(s.value); });
    list.addEventListener('click', e => {
      const r = e.target.closest('[data-pid]'); if (!r || r.classList.contains('out')) return;
      if (addProduct(r.dataset.pid, 1)) list.innerHTML = rows(s.value);
    });
  }

  function addProductByBarcode(code) {
    if (!code) return;
    const p = products.find(x => (x.barcode || '').toLowerCase() === code.toLowerCase());
    if (!p) { toast('Product not found for barcode'); return; }
    if (p.stock <= 0) { toast('Out of stock'); return; }
    if (window._docAdd && document.getElementById('docLines')) { if (window._docAdd(p.id, 1)) toast('+1 ' + p.name); }
    else toast('Open New Invoice first');
  }

  function viewCustomers() {
    if (customers.length === 0) {
      return emptyState('user', 'No customers yet', 'Save customer details for faster invoicing.', 'Add Customer', null, 'add-customer');
    }
    const sorted = [...customers].sort((a,b) => a.name.localeCompare(b.name));
    return `<div class="fade-in">
      <div class="search-wrap">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="11" cy="11" r="8"/><line x1="21" y1="21" x2="16.65" y2="16.65"/></svg>
        <input type="search" class="search-input" id="customerSearch" placeholder="Search customers..." />
      </div>
      <div class="list" id="customerList">${sorted.map(c => {
        const bal = customerBalance(c.id, c.name, c.phone);
        const dueHtml = bal.due > 0
          ? `<span class="list-item-badge badge-out">Due ${settings.currency} ${money(bal.due)}</span>`
          : (bal.total > 0 ? `<span class="list-item-badge badge-ok">Clear</span>` : '');
        return `
        <div class="list-item" data-action="view-customer" data-id="${c.id}">
          <div class="list-item-icon">${initials(c.name)}</div>
          <div class="list-item-body">
            <div class="list-item-title">${escapeHtml(c.name)}</div>
            <div class="list-item-sub">${escapeHtml(c.phone || 'No phone')}</div>
            ${dueHtml}
          </div>
          <div class="list-item-right">
            <div class="list-item-price">${bal.total ? settings.currency + ' ' + money(bal.total) : '—'}</div>
          </div>
        </div>`;
      }).join('')}</div>
    </div>`;
  }

  function openCustomerDetail(cust) {
    const bal = customerBalance(cust.id, cust.name, cust.phone);
    const custInvoices = invoices.filter(inv =>
      invoiceBelongsToCustomer(inv, cust.id, cust.name, cust.phone)
    ).sort((a,b) => new Date(b.date) - new Date(a.date));

    $('#modalRoot').innerHTML = `
      <div class="modal-overlay">
        <div class="modal-sheet">
          <div class="modal-handle"></div>
          <div class="modal-header">
            <h3 class="modal-title">${escapeHtml(cust.name)}</h3>
            <button class="modal-close" data-action="close-modal"><svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg></button>
          </div>
          <div class="text-sm text-secondary mb-8">${escapeHtml(cust.phone || '')}${cust.address ? ' · ' + escapeHtml(cust.address) : ''}</div>
          <div class="stats-grid mb-16">
            <div class="stat-card"><div class="stat-label">Total Sales</div><div class="stat-value primary">${settings.currency} ${money(bal.total)}</div></div>
            <div class="stat-card"><div class="stat-label">${bal.credit > 0 ? 'Credit (we owe)' : 'Due'}</div><div class="stat-value ${bal.due > 0 ? 'danger' : 'success'}">${settings.currency} ${money(bal.credit > 0 ? bal.credit : bal.due)}</div></div>
          </div>
          <div class="section-header"><h2 class="section-title">Invoice history</h2></div>
          ${custInvoices.length === 0 ? '<div class="text-secondary text-sm">No invoices yet</div>' :
            `<div class="list">${custInvoices.map(inv => {
              const due = Math.max(0, (inv.total||0) - (inv.paidAmount||0));
              const st = due <= 0 ? 'Paid' : (inv.paidAmount > 0 ? 'Partial' : 'Unpaid');
              return `<div class="list-item" data-action="view-invoice" data-id="${inv.id}">
                <div class="list-item-body">
                  <div class="list-item-title">${inv.docType === 'return' ? 'Return ' : ''}${escapeHtml(inv.number)}</div>
                  <div class="list-item-sub">${formatDate(inv.date)} · ${st}</div>
                </div>
                <div class="list-item-right">
                  <div class="list-item-price"${inv.docType === 'return' ? ' style="color:var(--danger)"' : ''}>${inv.docType === 'return' ? '−' : ''}${settings.currency} ${money(inv.total)}</div>
                  ${due > 0 ? `<span class="list-item-badge badge-out">Due ${money(due)}</span>` : `<span class="list-item-badge badge-ok">Paid</span>`}
                </div>
              </div>`;
            }).join('')}</div>`}
          <div class="flex gap-8 mt-16" style="flex-wrap:wrap">
            ${bal.due > 0 ? `<button class="btn btn-primary" style="flex:1" data-action="receive-payment" data-id="${cust.id}">Receive</button>` : ''}
            <button class="btn btn-secondary" style="flex:1" data-action="open-statement" data-id="${cust.id}">Statement</button>
            ${bal.due > 0 ? `<button class="btn btn-secondary" style="flex:1" data-action="remind-customer" data-id="${cust.id}">Remind</button>` : ''}
          </div>
          <div class="flex gap-12 mt-12">
            <button class="btn btn-secondary btn-block" data-action="edit-customer" data-id="${cust.id}">Edit</button>
          </div>
        </div>
      </div>`;
  }


  // ---------- Suppliers ----------
  function viewSuppliers() {
    if (suppliers.length === 0) {
      return emptyState('truck', 'No suppliers yet', 'Track who you buy stock from.', 'Add Supplier', null, 'add-supplier');
    }
    const sorted = [...suppliers].sort((a,b) => a.name.localeCompare(b.name));
    return `<div class="fade-in"><div class="list">${sorted.map(s => `
      <div class="list-item" data-action="view-supplier" data-id="${s.id}">
        <div class="list-item-icon">${initials(s.name)}</div>
        <div class="list-item-body">
          <div class="list-item-title">${escapeHtml(s.name)}</div>
          <div class="list-item-sub">${escapeHtml(s.phone || 'No phone')}</div>
          ${(() => { const b = supplierBalance(s); return b.due > 0 ? `<span class="list-item-badge badge-out">You owe ${settings.currency} ${money(b.due)}</span>` : (b.total > 0 ? '<span class="list-item-badge badge-ok">Clear</span>' : ''); })()}
        </div>
      </div>`).join('')}</div></div>`;
  }

  // ---------- Reports ----------
  function viewReports() {
    const { revenue, cogs } = netTotals();
    const totalExpenses = expenses.reduce((s, e) => s + (e.amount || 0), 0);
    const profit = revenue - cogs - totalExpenses;
    const totalInvoices = invoices.filter(i => docSign(i) > 0).length;
    const avgTicket = totalInvoices ? revenue / totalInvoices : 0;

    const sold = {};
    invoices.forEach(inv => { const g = docSign(inv); if (g) inv.items.forEach(it => {
      sold[it.name] = (sold[it.name] || 0) + g * it.qty;
    }); });
    const top = Object.entries(sold).filter(e => e[1] > 0).sort((a,b) => b[1] - a[1]).slice(0, 5);

    // Expense by category
    const byCat = {};
    expenses.forEach(e => {
      const cat = e.category || 'Other';
      byCat[cat] = (byCat[cat] || 0) + (e.amount || 0);
    });
    const topExp = Object.entries(byCat).sort((a,b) => b[1] - a[1]).slice(0, 5);

    return `<div class="fade-in">
      <div class="stats-grid">
        <div class="stat-card"><div class="stat-label">Total Sales</div><div class="stat-value success">${settings.currency} ${money(revenue)}</div></div>
        <div class="stat-card"><div class="stat-label">Cost of Goods</div><div class="stat-value">${settings.currency} ${money(cogs)}</div></div>
        <div class="stat-card"><div class="stat-label">Expenses</div><div class="stat-value danger">${settings.currency} ${money(totalExpenses)}</div></div>
        <div class="stat-card"><div class="stat-label">Net Profit</div><div class="stat-value ${profit >= 0 ? 'success' : 'danger'}">${settings.currency} ${money(profit)}</div></div>
      </div>
      <div class="section-header"><h2 class="section-title">Top Selling Products</h2></div>
      ${top.length === 0 ? '<div class="card text-center text-secondary" style="padding:24px">No sales data yet</div>' :
        `<div class="list mb-16">${top.map(([name, qty], i) => `
          <div class="list-item" style="cursor:default">
            <div class="list-item-icon">${i + 1}</div>
            <div class="list-item-body"><div class="list-item-title">${escapeHtml(name)}</div></div>
            <div class="list-item-right"><div class="list-item-price">${qty} sold</div></div>
          </div>`).join('')}</div>`}
      <div class="section-header"><h2 class="section-title">Expenses by Category</h2></div>
      ${topExp.length === 0 ? '<div class="card text-center text-secondary" style="padding:24px">No expenses yet</div>' :
        `<div class="list">${topExp.map(([cat, amt]) => `
          <div class="list-item" style="cursor:default">
            <div class="list-item-icon">${escapeHtml(cat[0] || '?')}</div>
            <div class="list-item-body"><div class="list-item-title">${escapeHtml(cat)}</div></div>
            <div class="list-item-right"><div class="list-item-price">${settings.currency} ${money(amt)}</div></div>
          </div>`).join('')}</div>`}
      <p class="text-sm text-secondary text-center mt-20">Net Profit = Sales − Cost of Goods − Expenses. Set product cost prices for accurate COGS.</p>
    </div>`;
  }

  function viewExpenses() {
    if (expenses.length === 0) {
      return emptyState('invoice', 'No expenses yet', 'Track rent, fuel, packaging, salaries and other costs.', 'Add Expense', null, 'add-expense');
    }
    const sorted = [...expenses].sort((a,b) => new Date(b.date) - new Date(a.date));
    return `<div class="fade-in">
      <div class="list">${sorted.map(e => `
        <div class="list-item" data-action="edit-expense" data-id="${e.id}">
          <div class="list-item-icon">${escapeHtml((e.category || 'E')[0])}</div>
          <div class="list-item-body">
            <div class="list-item-title">${escapeHtml(e.title || e.category || 'Expense')}</div>
            <div class="list-item-sub">${escapeHtml(e.category || 'Other')} · ${formatDate(e.date)}</div>
          </div>
          <div class="list-item-right">
            <div class="list-item-price" style="color:var(--danger)">${settings.currency} ${money(e.amount)}</div>
          </div>
        </div>`).join('')}
      </div>
    </div>`;
  }

  // ---------- More ----------
  function viewStockHistory() {
    if (stockMovements.length === 0) {
      return emptyState('box', 'No stock movements yet', 'Stock in and sales will appear here.', 'Go to Products', 'products');
    }
    const sorted = [...stockMovements].sort((a,b) => new Date(b.date) - new Date(a.date)).slice(0, 100);
    return `<div class="fade-in">
      <div class="list">${sorted.map(m => `
        <div class="list-item" style="cursor:default">
          <div class="list-item-icon" style="background:${m.type === 'in' ? '#D1FAE5' : '#FEE2E2'};color:${m.type === 'in' ? '#065F46' : '#991B1B'}">${m.type === 'in' ? '+' : '−'}</div>
          <div class="list-item-body">
            <div class="list-item-title">${escapeHtml(m.productName)}</div>
            <div class="list-item-sub">${formatDate(m.date)}${m.note ? ' · ' + escapeHtml(m.note) : ''}</div>
          </div>
          <div class="list-item-right">
            <div class="list-item-price" style="color:${m.type === 'in' ? 'var(--success)' : 'var(--danger)'}">${m.type === 'in' ? '+' : '−'}${m.qty}</div>
          </div>
        </div>`).join('')}
      </div>
    </div>`;
  }

  function lastSyncLabel() {
    const t = localStorage.getItem('hisably_last_sync');
    return t ? ' · Last sync ' + new Date(t).toLocaleString('en-GB', { day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit' }) : '';
  }

  function viewMore() {
    if (isStaff()) return staffMoreHTML();
    return `<div class="fade-in">
      <div class="card mb-16">
        <div class="text-sm text-secondary">Business</div>
        <div class="font-semibold" style="font-size:1.0625rem">${escapeHtml(settings.businessName)}</div>
        ${settings.phone ? `<div class="text-sm text-secondary mt-8">${escapeHtml(settings.phone)}</div>` : ''}
      </div>
      <div class="menu-list mb-16">
        <button class="menu-item" data-view="customers">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/><path d="M23 21v-2a4 4 0 0 0-3-3.87"/><path d="M16 3.13a4 4 0 0 1 0 7.75"/></svg>
          Customers
          <svg class="menu-item-arrow" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="9 18 15 12 9 6"/></svg>
        </button>
        <button class="menu-item" data-view="daybook">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M4 19.5A2.5 2.5 0 0 1 6.5 17H20"/><path d="M6.5 2H20v20H6.5A2.5 2.5 0 0 1 4 19.5v-15A2.5 2.5 0 0 1 6.5 2z"/></svg>
          Day Book &amp; Cash Flow
          <svg class="menu-item-arrow" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="9 18 15 12 9 6"/></svg>
        </button>
        <button class="menu-item" data-view="purchases">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="9" cy="21" r="1"/><circle cx="20" cy="21" r="1"/><path d="M1 1h4l2.7 13.4a2 2 0 0 0 2 1.6h9.7a2 2 0 0 0 2-1.6L23 6H6"/></svg>
          Purchases
          <svg class="menu-item-arrow" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="9 18 15 12 9 6"/></svg>
        </button>
        <button class="menu-item" data-view="suppliers">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="1" y="3" width="15" height="13"/><polygon points="16 8 20 8 23 11 23 16 16 16 16 8"/><circle cx="5.5" cy="18.5" r="2.5"/><circle cx="18.5" cy="18.5" r="2.5"/></svg>
          Suppliers
          <svg class="menu-item-arrow" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="9 18 15 12 9 6"/></svg>
        </button>
        <button class="menu-item" data-view="expenses">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><line x1="12" y1="1" x2="12" y2="23"/><path d="M17 5H9.5a3.5 3.5 0 0 0 0 7h5a3.5 3.5 0 0 1 0 7H6"/></svg>
          Expenses
          <svg class="menu-item-arrow" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="9 18 15 12 9 6"/></svg>
        </button>
        <button class="menu-item" data-view="stock-history">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="22 12 18 12 15 21 9 3 6 12 2 12"/></svg>
          Stock History
          <svg class="menu-item-arrow" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="9 18 15 12 9 6"/></svg>
        </button>
        <button class="menu-item" data-view="reports">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><line x1="18" y1="20" x2="18" y2="10"/><line x1="12" y1="20" x2="12" y2="4"/><line x1="6" y1="20" x2="6" y2="14"/></svg>
          Profit & Reports
          <svg class="menu-item-arrow" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="9 18 15 12 9 6"/></svg>
        </button>
        <button class="menu-item" data-action="open-settings">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1 0 2.83 2 2 0 0 1-2.83 0l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-2 2 2 2 0 0 1-2-2v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83 0 2 2 0 0 1 0-2.83l.06-.06A1.65 1.65 0 0 0 4.68 15a1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1-2-2 2 2 0 0 1 2-2h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 0-2.83 2 2 0 0 1 2.83 0l.06.06A1.65 1.65 0 0 0 9 4.68a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 2-2 2 2 0 0 1 2 2v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 0 2 2 0 0 1 0 2.83l-.06.06A1.65 1.65 0 0 0 19.4 9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 2 2 2 2 0 0 1-2 2h-.09a1.65 1.65 0 0 0-1.51 1z"/></svg>
          Business Settings
          <svg class="menu-item-arrow" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="9 18 15 12 9 6"/></svg>
        </button>
        <button class="menu-item" data-action="open-plans">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="1" y="4" width="22" height="16" rx="2"/><line x1="1" y1="10" x2="23" y2="10"/></svg>
          Plans & upgrade
          <svg class="menu-item-arrow" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="9 18 15 12 9 6"/></svg>
        </button>
        <button class="menu-item" data-action="open-shopify">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M6 2 3 6v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2V6l-3-4z"/><line x1="3" y1="6" x2="21" y2="6"/><path d="M16 10a4 4 0 0 1-8 0"/></svg>
          Shopify store <span style="font-size:10px;background:var(--primary);color:#fff;border-radius:6px;padding:1px 6px;margin-left:6px">PRO</span>
          <svg class="menu-item-arrow" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="9 18 15 12 9 6"/></svg>
        </button>
        ${lockEnabled() ? `<button class="menu-item" data-action="lock-now"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="3" y="11" width="18" height="11" rx="2"/><path d="M7 11V7a5 5 0 0 1 10 0v4"/></svg>Lock app<svg class="menu-item-arrow" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="9 18 15 12 9 6"/></svg></button>` : ''}
        <button class="menu-item" data-action="sign-out-user">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4"/><polyline points="16 17 21 12 16 7"/><line x1="21" y1="12" x2="9" y2="12"/></svg>
          Sign out
          <svg class="menu-item-arrow" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="9 18 15 12 9 6"/></svg>
        </button>
        <button class="menu-item" data-action="cloud-auth">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M18 10h-1.26A8 8 0 1 0 9 20h9a5 5 0 0 0 0-10z"/></svg>
          Cloud account
          <svg class="menu-item-arrow" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="9 18 15 12 9 6"/></svg>
        </button>
        <button class="menu-item" data-action="cloud-sync">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="23 4 23 10 17 10"/><polyline points="1 20 1 14 7 14"/><path d="M3.51 9a9 9 0 0 1 14.85-3.36L23 10M1 14l4.64 4.36A9 9 0 0 0 20.49 15"/></svg>
          Sync now
          <svg class="menu-item-arrow" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="9 18 15 12 9 6"/></svg>
        </button>
        <button class="menu-item" data-action="export-data">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" y1="15" x2="12" y2="3"/></svg>
          Export / Backup
          <svg class="menu-item-arrow" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="9 18 15 12 9 6"/></svg>
        </button>
        <button class="menu-item" data-action="import-data">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="17 8 12 3 7 8"/><line x1="12" y1="3" x2="12" y2="15"/></svg>
          Import Backup
          <svg class="menu-item-arrow" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="9 18 15 12 9 6"/></svg>
        </button>
        <button class="menu-item" data-action="clear-data">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="3 6 5 6 21 6"/><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/></svg>
          Clear All Data
          <svg class="menu-item-arrow" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="9 18 15 12 9 6"/></svg>
        </button>
      </div>
      <div class="text-center text-secondary text-sm mt-20">Hisably · Works offline, syncs when online${lastSyncLabel()}</div>
    </div>`;
  }

  // ---------- Empty state helper ----------
  function emptyState(icon, title, text, btnText, view, action) {
    const icons = {
      box: '<path d="M21 16V8a2 2 0 0 0-1-1.73l-7-4a2 2 0 0 0-2 0l-7 4A2 2 0 0 0 3 8v8a2 2 0 0 0 1 1.73l7 4a2 2 0 0 0 2 0l7-4A2 2 0 0 0 21 16z"/><polyline points="3.27 6.96 12 12.01 20.73 6.96"/><line x1="12" y1="22.08" x2="12" y2="12"/>',
      invoice: '<path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/>',
      user: '<path d="M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2"/><circle cx="12" cy="7" r="4"/>',
      truck: '<rect x="1" y="3" width="15" height="13"/><polygon points="16 8 20 8 23 11 23 16 16 16 16 8"/><circle cx="5.5" cy="18.5" r="2.5"/><circle cx="18.5" cy="18.5" r="2.5"/>'
    };
    const attr = view ? `data-view="${view}"` : `data-action="${action}"`;
    return `<div class="empty-state fade-in">
      <div class="empty-icon"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8">${icons[icon] || icons.box}</svg></div>
      <div class="empty-title">${title}</div>
      <div class="empty-text">${text}</div>
      <button class="btn btn-primary" ${attr}>${btnText}</button>
    </div>`;
  }

  // ---------- Modals ----------
  function closeModal() { $('#modalRoot').innerHTML = ''; }

  function openProductModal(product = null) {
    editingId = product ? product.id : null;
    const isEdit = !!product;
    $('#modalRoot').innerHTML = `
      <div class="modal-overlay" id="productModal">
        <div class="modal-sheet">
          <div class="modal-handle"></div>
          <div class="modal-header">
            <h3 class="modal-title">${isEdit ? 'Edit Product' : 'Add Product'}</h3>
            <button class="modal-close" data-action="close-modal"><svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg></button>
          </div>
          <form id="productForm">
            <div class="form-group">
              <label class="form-label">Product Name *</label>
              <input type="text" class="form-input" name="name" required value="${product ? escapeHtml(product.name) : ''}" placeholder="e.g. Chocolate Cake" />
            </div>
            <div class="form-group">
              <label class="form-label">Category</label>
              <input type="text" class="form-input" name="category" list="categoryOptions" maxlength="60" autocomplete="off" value="${product ? escapeHtml(product.category || '') : (productCat && productCat !== '__none__' ? escapeHtml(productCat) : '')}" placeholder="e.g. Grocery, Mobiles, Clothes" />
              <datalist id="categoryOptions">${categoryList().map(c => `<option value="${escapeHtml(c)}"></option>`).join('')}</datalist>
            </div>
            <div class="form-row">
              <div class="form-group">
                <label class="form-label">Selling Price (${settings.currency}) *</label>
                <input type="number" class="form-input" name="price" required min="0" step="0.01" value="${product ? product.price : ''}" placeholder="0" />
              </div>
              <div class="form-group">
                <label class="form-label">Cost Price (${settings.currency})</label>
                <input type="number" class="form-input" name="cost" min="0" step="0.01" value="${product ? (product.cost || '') : ''}" placeholder="0" />
              </div>
            </div>
            <div class="form-row">
              <div class="form-group">
                <label class="form-label">Stock Qty *</label>
                <input type="number" class="form-input" name="stock" required min="0" step="1" value="${product ? product.stock : ''}" placeholder="0" />
              </div>
              <div class="form-group">
                <label class="form-label">Unit</label>
                <input type="text" class="form-input" name="unit" value="${product ? escapeHtml(product.unit || 'pcs') : 'pcs'}" placeholder="pcs, kg..." />
              </div>
            </div>
            <div class="form-row">
              <div class="form-group">
                <label class="form-label">Low Stock Alert</label>
                <input type="number" class="form-input" name="lowStock" min="0" value="${product ? lowLimit(product) : settings.lowStockDefault}" />
              </div>
              <div class="form-group">
                <label class="form-label">Barcode / QR</label>
                <div class="input-with-btn">
                  <input type="text" class="form-input" name="barcode" id="barcodeInput" value="${product ? escapeHtml(product.barcode || '') : ''}" placeholder="Scan or type" />
                  <button type="button" class="btn btn-secondary btn-sm" data-action="scan-barcode" style="height:48px;padding:0 12px">Scan</button>
                </div>
              </div>
            </div>
            <div class="form-group">
              <label class="form-label">Notes</label>
              <textarea class="form-textarea" name="notes" placeholder="Optional notes...">${product ? escapeHtml(product.notes || '') : ''}</textarea>
            </div>
            ${isEdit ? `
            <div class="form-group mt-8">
              <label class="form-label">Stock In (add quantity)</label>
              <div class="input-with-btn">
                <input type="number" class="form-input" id="stockInQty" min="1" step="1" placeholder="Qty to add" />
                <button type="button" class="btn btn-secondary btn-sm" style="height:48px" data-action="stock-in" data-id="${product.id}">Add</button>
              </div>
            </div>` : ''}
            <div class="flex gap-12 mt-20">
              ${isEdit ? `<button type="button" class="btn btn-danger" data-action="delete-product" style="flex:0 0 auto">Delete</button>` : ''}
              <button type="submit" class="btn btn-primary btn-block">${isEdit ? 'Save Changes' : 'Add Product'}</button>
            </div>
          </form>
        </div>
      </div>`;

    $('#productForm').addEventListener('submit', e => {
      e.preventDefault();
      const fd = new FormData(e.target);
      const data = {
        name: fd.get('name').trim(),
        price: parseFloat(fd.get('price')) || 0,
        cost: parseFloat(fd.get('cost')) || 0,
        stock: parseInt(fd.get('stock'), 10) || 0,
        unit: (fd.get('unit') || 'pcs').trim(),
        category: normalizeCategory(fd.get('category')),
        lowStock: Number.isNaN(parseInt(fd.get('lowStock'), 10)) ? settings.lowStockDefault : Math.max(0, parseInt(fd.get('lowStock'), 10)),
        barcode: (fd.get('barcode') || '').trim(),
        notes: (fd.get('notes') || '').trim()
      };
      if (!data.name) { toast('Name required'); return; }
      if (data.barcode && products.some(p => p.id !== editingId && (p.barcode || '').toLowerCase() === data.barcode.toLowerCase())) {
        toast('Another product already uses this barcode');
        return;
      }
      if (isEdit) {
        const idx = products.findIndex(p => p.id === editingId);
        if (idx > -1) {
          const diff = data.stock - (products[idx].stock || 0);
          products[idx] = { ...products[idx], ...data };
          // Keep Stock History honest when stock is corrected by hand
          if (diff !== 0) {
            stockMovements.unshift({
              id: uid(), productId: products[idx].id, productName: data.name,
              type: diff > 0 ? 'in' : 'out', qty: Math.abs(diff),
              date: new Date().toISOString(), note: 'Manual adjustment'
            });
          }
        }
        toast('Product updated');
      } else {
        if (typeof enforceLimit === 'function' && !enforceLimit('products', products.length)) return;
        const created = { id: uid(), ...data, createdAt: new Date().toISOString() };
        products.push(created);
        if (created.stock > 0) {
          stockMovements.unshift({
            id: uid(), productId: created.id, productName: created.name, type: 'in',
            qty: created.stock, date: created.createdAt, note: 'Opening stock'
          });
        }
        toast('Product added');
      }
      persist();
      closeModal();
      if (currentView === 'products') render();
      else setView('products');
    });
  }

  function openCustomerModal(cust = null) {
    editingId = cust ? cust.id : null;
    const isEdit = !!cust;
    $('#modalRoot').innerHTML = `
      <div class="modal-overlay">
        <div class="modal-sheet">
          <div class="modal-handle"></div>
          <div class="modal-header">
            <h3 class="modal-title">${isEdit ? 'Edit Customer' : 'Add Customer'}</h3>
            <button class="modal-close" data-action="close-modal"><svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg></button>
          </div>
          <form id="customerForm">
            <div class="form-group"><label class="form-label">Name *</label><input class="form-input" name="name" required value="${cust ? escapeHtml(cust.name) : ''}" /></div>
            <div class="form-group"><label class="form-label">Phone</label><input class="form-input" name="phone" type="tel" value="${cust ? escapeHtml(cust.phone || '') : ''}" /></div>
            <div class="form-group"><label class="form-label">Address</label><input class="form-input" name="address" value="${cust ? escapeHtml(cust.address || '') : ''}" /></div>
            <div class="form-group"><label class="form-label">Notes</label><textarea class="form-textarea" name="notes">${cust ? escapeHtml(cust.notes || '') : ''}</textarea></div>
            <div class="flex gap-12 mt-20">
              ${isEdit ? `<button type="button" class="btn btn-danger" data-action="delete-customer" style="flex:0 0 auto">Delete</button>` : ''}
              <button type="submit" class="btn btn-primary btn-block">${isEdit ? 'Save' : 'Add Customer'}</button>
            </div>
          </form>
        </div>
      </div>`;
    $('#customerForm').addEventListener('submit', e => {
      e.preventDefault();
      const fd = new FormData(e.target);
      const data = { name: fd.get('name').trim(), phone: fd.get('phone').trim(), address: fd.get('address').trim(), notes: fd.get('notes').trim() };
      if (!data.name) return;
      if (isEdit) {
        const i = customers.findIndex(c => c.id === editingId);
        if (i > -1) customers[i] = { ...customers[i], ...data };
        toast('Customer updated');
      } else {
        if (typeof enforceLimit === 'function' && !enforceLimit('customers', customers.length)) return;
        customers.push({ id: uid(), ...data });
        toast('Customer added');
      }
      persist();
      closeModal();
      setView('customers');
    });
  }

  function openSupplierModal(sup = null) {
    editingId = sup ? sup.id : null;
    const isEdit = !!sup;
    $('#modalRoot').innerHTML = `
      <div class="modal-overlay">
        <div class="modal-sheet">
          <div class="modal-handle"></div>
          <div class="modal-header">
            <h3 class="modal-title">${isEdit ? 'Edit Supplier' : 'Add Supplier'}</h3>
            <button class="modal-close" data-action="close-modal"><svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg></button>
          </div>
          <form id="supplierForm">
            <div class="form-group"><label class="form-label">Name *</label><input class="form-input" name="name" required value="${sup ? escapeHtml(sup.name) : ''}" /></div>
            <div class="form-group"><label class="form-label">Phone</label><input class="form-input" name="phone" type="tel" value="${sup ? escapeHtml(sup.phone || '') : ''}" /></div>
            <div class="form-group"><label class="form-label">Notes</label><textarea class="form-textarea" name="notes">${sup ? escapeHtml(sup.notes || '') : ''}</textarea></div>
            <div class="flex gap-12 mt-20">
              ${isEdit ? `<button type="button" class="btn btn-danger" data-action="delete-supplier" style="flex:0 0 auto">Delete</button>` : ''}
              <button type="submit" class="btn btn-primary btn-block">${isEdit ? 'Save' : 'Add Supplier'}</button>
            </div>
          </form>
        </div>
      </div>`;
    $('#supplierForm').addEventListener('submit', e => {
      e.preventDefault();
      const fd = new FormData(e.target);
      const data = { name: fd.get('name').trim(), phone: fd.get('phone').trim(), notes: fd.get('notes').trim() };
      if (!data.name) return;
      if (isEdit) {
        const i = suppliers.findIndex(s => s.id === editingId);
        if (i > -1) suppliers[i] = { ...suppliers[i], ...data };
        toast('Supplier updated');
      } else {
        if (typeof enforceLimit === 'function' && !enforceLimit('suppliers', suppliers.length)) return;
        suppliers.push({ id: uid(), ...data });
        toast('Supplier added');
      }
      persist();
      closeModal();
      setView('suppliers');
    });
  }

  function openExpenseModal(exp = null) {
    editingId = exp ? exp.id : null;
    const isEdit = !!exp;
    const cats = ['Rent', 'Fuel', 'Packaging', 'Salaries', 'Utilities', 'Marketing', 'Transport', 'Supplies', 'Other'];
    $('#modalRoot').innerHTML = `
      <div class="modal-overlay">
        <div class="modal-sheet">
          <div class="modal-handle"></div>
          <div class="modal-header">
            <h3 class="modal-title">${isEdit ? 'Edit Expense' : 'Add Expense'}</h3>
            <button class="modal-close" data-action="close-modal"><svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg></button>
          </div>
          <form id="expenseForm">
            <div class="form-group"><label class="form-label">Title *</label><input class="form-input" name="title" required value="${exp ? escapeHtml(exp.title || '') : ''}" placeholder="e.g. Shop rent" /></div>
            <div class="form-row">
              <div class="form-group"><label class="form-label">Amount (${settings.currency}) *</label><input class="form-input" name="amount" type="number" required min="0" step="0.01" value="${exp ? exp.amount : ''}" /></div>
              <div class="form-group"><label class="form-label">Date</label><input class="form-input" name="date" type="date" value="${exp ? (exp.date || '').slice(0,10) : new Date().toISOString().slice(0,10)}" /></div>
            </div>
            <div class="form-group">
              <label class="form-label">Category</label>
              ${customSelect('category', cats.map(c => ({value: c, label: c})), exp ? (exp.category || 'Other') : 'Other')}
            </div>
            <div class="form-group"><label class="form-label">Notes</label><textarea class="form-textarea" name="notes">${exp ? escapeHtml(exp.notes || '') : ''}</textarea></div>
            <div class="flex gap-12 mt-20">
              ${isEdit ? `<button type="button" class="btn btn-danger" data-action="delete-expense" style="flex:0 0 auto">Delete</button>` : ''}
              <button type="submit" class="btn btn-primary btn-block">${isEdit ? 'Save' : 'Add Expense'}</button>
            </div>
          </form>
        </div>
      </div>`;
    $('#expenseForm').addEventListener('submit', e => {
      e.preventDefault();
      const fd = new FormData(e.target);
      const data = {
        title: fd.get('title').trim(),
        amount: parseFloat(fd.get('amount')) || 0,
        date: fd.get('date') || new Date().toISOString().slice(0,10),
        category: fd.get('category') || 'Other',
        notes: (fd.get('notes') || '').trim()
      };
      if (!data.title) return;
      if (isEdit) {
        const i = expenses.findIndex(x => x.id === editingId);
        if (i > -1) expenses[i] = { ...expenses[i], ...data };
        toast('Expense updated');
      } else {
        if (typeof enforceLimit === 'function' && !enforceLimit('expenses', expenses.length)) return;
        expenses.push({ id: uid(), ...data });
        toast('Expense added');
      }
      persist();
      closeModal();
      setView('expenses');
    });
  }

  function openSettingsModal() {
    $('#modalRoot').innerHTML = `
      <div class="modal-overlay">
        <div class="modal-sheet">
          <div class="modal-handle"></div>
          <div class="modal-header">
            <h3 class="modal-title">Business Settings</h3>
            <button class="modal-close" data-action="close-modal"><svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg></button>
          </div>
          <form id="settingsForm">
            <div class="form-group"><label class="form-label">Business Name *</label><input class="form-input" name="businessName" required value="${escapeHtml(settings.businessName)}" /></div>
            <div class="form-group">
              <label class="form-label">Logo</label>
              <div class="logo-upload-row">
                <div class="logo-preview" id="logoPreview">${settings.logo ? `<img src="${settings.logo}" alt="Logo" />` : '<span>No logo</span>'}</div>
                <div style="flex:1">
                  <input type="file" id="logoFile" accept="image/*" style="display:none" />
                  <button type="button" class="btn btn-secondary btn-sm" data-action="pick-logo">Upload Logo</button>
                  ${settings.logo ? `<button type="button" class="btn btn-ghost btn-sm" data-action="remove-logo" style="margin-left:8px">Remove</button>` : ''}
                </div>
              </div>
              <input type="hidden" name="logo" id="logoValue" value="" />
            </div>
            <div class="form-group">
              <label class="form-label">Payment QR Code (JazzCash / EasyPaisa / Bank)</label>
              <div class="logo-upload-row">
                <div class="logo-preview" id="qrPreview">${(settings.paymentQr && (!window.HisablyFreemium || HisablyFreemium.effectivePlan().limits.paymentQrOnInvoice)) ? `<img src="${settings.paymentQr}" alt="QR" />` : '<span>No QR</span>'}</div>
                <div style="flex:1">
                  <input type="file" id="qrFile" accept="image/*" style="display:none" />
                  <button type="button" class="btn btn-secondary btn-sm" data-action="pick-qr">Upload QR</button>
                  ${(settings.paymentQr && (!window.HisablyFreemium || HisablyFreemium.effectivePlan().limits.paymentQrOnInvoice)) ? `<button type="button" class="btn btn-ghost btn-sm" data-action="remove-qr" style="margin-left:8px">Remove</button>` : ''}
                </div>
              </div>
              <input type="text" class="form-input mt-8" name="paymentNote" value="${escapeHtml(settings.paymentNote || 'Pay via JazzCash / EasyPaisa / Bank')}" placeholder="Payment note on invoice" />
            </div>
            <div class="form-group"><label class="form-label">Owner Name</label><input class="form-input" name="ownerName" value="${escapeHtml(settings.ownerName || '')}" /></div>
            <div class="form-row">
              <div class="form-group"><label class="form-label">Phone</label><input class="form-input" name="phone" type="tel" value="${escapeHtml(settings.phone || '')}" /></div>
              <div class="form-group"><label class="form-label">Email</label><input class="form-input" name="email" type="email" value="${escapeHtml(settings.email || '')}" /></div>
            </div>
            <div class="form-group"><label class="form-label">Address</label><input class="form-input" name="address" value="${escapeHtml(settings.address || '')}" /></div>
            <div class="form-row">
              <div class="form-group"><label class="form-label">City</label><input class="form-input" name="city" value="${escapeHtml(settings.city || '')}" /></div>
              <div class="form-group"><label class="form-label">Tax / NTN / GST</label><input class="form-input" name="taxId" value="${escapeHtml(settings.taxId || '')}" /></div>
            </div>
            <div class="form-group">
              <label class="form-label">Currency</label>
              ${customSelect('currency', [
                { value: 'PKR', label: 'PKR – Pakistani Rupee' },
                { value: 'INR', label: 'INR – Indian Rupee' },
                { value: 'BDT', label: 'BDT – Bangladeshi Taka' },
                { value: 'USD', label: 'USD – US Dollar' },
                { value: 'EUR', label: 'EUR – Euro' }
              ], settings.currency || 'PKR')}
            </div>
            <div class="form-group">
              <label class="form-label">Default Tax % (added to new invoices, 0 = none)</label>
              <input class="form-input" name="taxRate" type="number" inputmode="decimal" min="0" step="any" value="${settings.taxRate || ''}" placeholder="0" />
            </div>
            <div class="form-group">
              <label class="form-label">Invoice Prefix</label>
              <input class="form-input" name="invoicePrefix" value="${escapeHtml(settings.invoicePrefix || 'INV')}" />
            </div>
            ${themePickerHTML()}
            ${securityHTML()}
            <button type="submit" class="btn btn-primary btn-block mt-16">Save Settings</button>
          </form>
        </div>
      </div>`;
    $('#settingsForm').addEventListener('submit', e => {
      e.preventDefault();
      const fd = new FormData(e.target);
      settings.businessName = fd.get('businessName').trim() || 'My Business';
      settings.ownerName = fd.get('ownerName').trim();
      settings.phone = fd.get('phone').trim();
      settings.email = fd.get('email').trim();
      settings.address = fd.get('address').trim();
      settings.city = fd.get('city').trim();
      settings.taxId = fd.get('taxId').trim();
      settings.currency = fd.get('currency');
      settings.invoicePrefix = fd.get('invoicePrefix').trim() || 'INV';
      settings.taxRate = Math.max(0, parseFloat(fd.get('taxRate')) || 0);
      settings.paymentNote = (fd.get('paymentNote') || '').trim() || 'Pay via JazzCash / EasyPaisa / Bank';
      // logo / paymentQr updated live via pick/remove actions
      persist();
      toast('Settings saved');
      closeModal();
      render();
    });
  }

  // ---------- Invoice Detail + PDF + Image Share + Print ----------
  function openInvoiceDetail(inv) {
    const itemsHtml = inv.items.map(it => `
      <div class="summary-row"><span>${escapeHtml(it.name)} × ${it.qty}</span><span>${settings.currency} ${money(it.price * it.qty)}</span></div>`).join('');
    const paid = inv.paidAmount || 0;
    const due = Math.max(0, (inv.total || 0) - paid);
    let statusLabel = 'Unpaid';
    if (paid >= inv.total) statusLabel = 'Fully Paid';
    else if (paid > 0) statusLabel = 'Partial / Advance';
    const isEst = inv.docType === 'estimate';
    if (isEst) statusLabel = inv.meta && inv.meta.convertedTo ? 'Converted to ' + inv.meta.convertedTo : 'Open';
    if (inv.docType === 'return') statusLabel = paid >= inv.total ? 'Fully Refunded' : (paid > 0 ? 'Partly Refunded' : 'Credit pending');

    $('#modalRoot').innerHTML = `
      <div class="modal-overlay" id="invDetail">
        <div class="modal-sheet">
          <div class="modal-handle"></div>
          <div class="modal-header">
            <h3 class="modal-title">${docWord(inv)} ${escapeHtml(inv.number)}</h3>
            <button class="modal-close" data-action="close-modal"><svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg></button>
          </div>
          <div class="mb-16">
            <div class="text-sm text-secondary">Customer</div>
            <div class="font-semibold">${escapeHtml(inv.customerName || 'Walk-in')}</div>
            ${inv.customerPhone ? `<div class="text-sm text-secondary mt-8">${escapeHtml(inv.customerPhone)}</div>` : ''}
            <div class="text-sm text-secondary mt-8">${formatDate(inv.date)}${inv.meta && inv.meta.refNumber ? ' · against ' + escapeHtml(inv.meta.refNumber) : ''}${inv.meta && inv.meta.by ? ' · by ' + escapeHtml(inv.meta.by) : ''}</div>
          </div>
          <div class="invoice-summary">${itemsHtml}
            ${(() => { const x = invExtraRows(inv); return x.rows.length ? `<div class="summary-row"><span>Subtotal</span><span>${settings.currency} ${money(x.sub)}</span></div>` + x.rows.map(r => `<div class="summary-row"><span>${escapeHtml(r.label)}</span><span>${r.amt < 0 ? '−' : ''}${settings.currency} ${money(Math.abs(r.amt))}</span></div>`).join('') : ''; })()}
            <div class="summary-row total"><span>Total</span><span>${settings.currency} ${money(inv.total)}</span></div>
            ${inv.meta && inv.meta.paymentMode ? `<div class="summary-row"><span>Payment mode</span><span>${escapeHtml(inv.meta.paymentMode)}</span></div>` : ''}
            ${inv.meta && inv.meta.dueDate ? `<div class="summary-row"><span>Due date</span><span${isOverdue(inv) ? ' style="color:var(--danger);font-weight:600"' : ''}>${formatDate(inv.meta.dueDate)}${isOverdue(inv) ? ' · overdue' : ''}</span></div>` : ''}
            ${inv.meta && inv.meta.validUntil ? `<div class="summary-row"><span>Valid until</span><span>${formatDate(inv.meta.validUntil)}</span></div>` : ''}
            ${isEst ? '' : `<div class="summary-row"><span>${inv.docType === 'return' ? 'Refunded' : 'Paid'}</span><span style="color:var(--success)">${settings.currency} ${money(paid)}</span></div>
            <div class="summary-row"><span>${inv.docType === 'return' ? 'Credit left' : 'Due'}</span><span style="color:${due > 0 ? 'var(--danger)' : 'var(--success)'}">${settings.currency} ${money(due)}</span></div>
`}
            <div class="summary-row"><span>Status</span><span class="font-semibold">${statusLabel}</span></div>
          </div>
          ${isEst && !(inv.meta && inv.meta.convertedTo) ? `<button class="btn btn-primary btn-block mt-16" data-action="convert-estimate" data-id="${inv.id}">Convert to Invoice</button>` : ''}
          ${(!isEst && due > 0) ? `
          <div class="form-group mt-16">
            <label class="form-label">${inv.docType === 'return' ? 'Record refund paid' : 'Record payment'}</label>
            <div class="input-with-btn">
              <input type="number" class="form-input" id="recordPayInput" min="0" step="0.01" placeholder="Amount" />
              <button type="button" class="btn btn-primary btn-sm" style="height:48px" data-action="record-payment" data-id="${inv.id}">Add</button>
            </div>
            ${modeChips('rpMode')}
          </div>
          <button class="btn btn-secondary btn-block mt-8" data-action="mark-paid" data-id="${inv.id}">${inv.docType === 'return' ? 'Mark as Fully Refunded' : 'Mark as Fully Paid'}</button>
          ` : ''}
          <div class="flex gap-8 mt-20" style="flex-wrap:wrap">
            <button class="btn btn-secondary" style="flex:1" data-action="share-image" data-id="${inv.id}">
              <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="3" y="3" width="18" height="18" rx="2"/><circle cx="8.5" cy="8.5" r="1.5"/><polyline points="21 15 16 10 5 21"/></svg>
              Image
            </button>
            <button class="btn btn-secondary" style="flex:1" data-action="pdf-invoice" data-id="${inv.id}">
              <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/></svg>
              PDF
            </button>
            <button class="btn btn-primary" style="flex:1" data-action="print-invoice" data-id="${inv.id}">
              <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="6 9 6 2 18 2 18 9"/><path d="M6 18H4a2 2 0 0 1-2-2v-5a2 2 0 0 1 2-2h16a2 2 0 0 1 2 2v5a2 2 0 0 1-2 2h-2"/><rect x="6" y="14" width="12" height="8"/></svg>
              Print
            </button>
          </div>
          <button class="btn btn-ghost btn-block mt-12" data-action="share-whatsapp-text" data-id="${inv.id}">Share as WhatsApp text</button>
          ${((inv.docType || 'sale') === 'sale' && due > 0) ? `<button class="btn btn-ghost btn-block mt-8" data-action="remind-invoice" data-id="${inv.id}">Send payment reminder (WhatsApp)</button>` : ''}
          ${(inv.docType || 'sale') === 'sale' ? `<button class="btn btn-ghost btn-block mt-8" data-action="return-from-invoice" data-id="${inv.id}">Return items from this invoice</button>` : ''}
        </div>
      </div>`;
  }

  function generatePDF(inv) {
    const { jsPDF } = window.jspdf;
    const doc = new jsPDF({ unit: 'mm', format: 'a4' });
    const W = 210, m = 16;
    const paid = inv.paidAmount || 0;
    const due = Math.max(0, (inv.total || 0) - paid);
    const statusText = inv.docType === 'estimate' ? 'QUOTE' : (due <= 0 ? 'PAID' : (paid > 0 ? 'PARTIAL' : 'UNPAID'));
    let y = 0;

    // Header (theme: filled band or clean line)
    const TH = HisablyReceipt.themeOf(settings), A = HisablyReceipt.hexRgb(TH.accent), D = HisablyReceipt.hexRgb(TH.dark), S = HisablyReceipt.hexRgb(TH.soft);
    const band = TH.style === 'band';
    if (band) { doc.setFillColor(A[0], A[1], A[2]); doc.rect(0, 0, W, 36, 'F'); }
    else { doc.setFillColor(A[0], A[1], A[2]); doc.rect(0, 34, W, 1.4, 'F'); }

    let textX = m;
    if (settings.logo) {
      try {
        doc.setFillColor(255, 255, 255);
        doc.roundedRect(m, 7, 22, 22, 3, 3, 'F');
        doc.addImage(settings.logo, 'PNG', m + 2, 9, 18, 18);
        textX = m + 26;
      } catch (e) {}
    }
    if (band) doc.setTextColor(255, 255, 255); else doc.setTextColor(15, 23, 42);
    doc.setFont('helvetica', 'bold');
    doc.setFontSize(16);
    doc.text(settings.businessName || 'Business', textX, 16);
    doc.setFont('helvetica', 'normal');
    doc.setFontSize(8);
    const sub = [settings.phone, settings.city, settings.address].filter(Boolean).join('  ·  ');
    if (sub) doc.text(sub.substring(0, 70), textX, 23);
    if (settings.email) doc.text(settings.email, textX, 28);

    doc.setFont('helvetica', 'bold');
    doc.setFontSize(10);
    doc.text(docWord(inv).toUpperCase(), W - m, 14, { align: 'right' });
    doc.setFont('helvetica', 'normal');
    doc.setFontSize(9);
    doc.text(String(inv.number), W - m, 20, { align: 'right' });
    doc.text(formatDate(inv.date), W - m, 26, { align: 'right' });

    y = 46;
    // Bill to + status
    doc.setFont('helvetica', 'bold');
    doc.setFontSize(7);
    doc.setTextColor(148, 163, 184);
    doc.text('BILL TO', m, y);
    y += 5;
    doc.setTextColor(15, 23, 42);
    doc.setFont('helvetica', 'bold');
    doc.setFontSize(12);
    doc.text(inv.customerName || 'Walk-in Customer', m, y);
    // status badge
    if (statusText === 'PAID') doc.setFillColor(16, 185, 129);
    else if (statusText === 'PARTIAL') doc.setFillColor(245, 158, 11);
    else doc.setFillColor(239, 68, 68);
    const bw = statusText === 'PARTIAL' ? 22 : 18;
    doc.roundedRect(W - m - bw, y - 5, bw, 7, 1.5, 1.5, 'F');
    doc.setTextColor(255, 255, 255);
    doc.setFontSize(7);
    doc.setFont('helvetica', 'bold');
    doc.text(statusText, W - m - bw / 2, y - 0.5, { align: 'center' });
    y += 6;
    doc.setTextColor(100);
    doc.setFont('helvetica', 'normal');
    doc.setFontSize(9);
    if (inv.customerPhone) { doc.text(inv.customerPhone, m, y); y += 5; }
    y += 4;

    // Table header (repeated on every page)
    const tableHeader = () => {
      doc.setFillColor(241, 245, 249);
      doc.roundedRect(m, y, W - 2 * m, 8, 1.5, 1.5, 'F');
      doc.setFont('helvetica', 'bold');
      doc.setFontSize(8);
      doc.setTextColor(100);
      doc.text('#', m + 3, y + 5.5);
      doc.text('ITEM', m + 12, y + 5.5);
      doc.text('QTY', m + 108, y + 5.5, { align: 'right' });
      doc.text('PRICE', m + 138, y + 5.5, { align: 'right' });
      doc.text('AMOUNT', W - m - 3, y + 5.5, { align: 'right' });
      y += 12;
    };
    tableHeader();

    doc.setTextColor(15, 23, 42);
    inv.items.forEach((it, idx) => {
      doc.setFontSize(9);
      doc.setFont('helvetica', 'normal');
      const nameLines = doc.splitTextToSize(String(it.name), 88);
      const rowH = Math.max(8, nameLines.length * 4.4 + 3.6);
      if (y + rowH > 272) { doc.addPage(); y = 20; tableHeader(); }
      if (idx % 2 === 1) {
        doc.setFillColor(248, 250, 252);
        doc.rect(m, y - 4.5, W - 2 * m, rowH, 'F');
      }
      doc.setTextColor(148, 163, 184);
      doc.text(String(idx + 1), m + 3, y);
      doc.setTextColor(15, 23, 42);
      doc.text(nameLines, m + 12, y);
      doc.text(String(it.qty), m + 108, y, { align: 'right' });
      doc.text(money(it.price), m + 138, y, { align: 'right' });
      doc.setFont('helvetica', 'bold');
      doc.text(money(it.price * it.qty), W - m - 3, y, { align: 'right' });
      y += rowH;
    });
    if (y > 215) { doc.addPage(); y = 20; }

    y += 4;
    doc.setDrawColor(226, 232, 240);
    doc.line(m, y, W - m, y);
    y += 8;

    // Totals
    const tx = W - m - 55;
    doc.setFont('helvetica', 'normal');
    doc.setFontSize(9);
    doc.setTextColor(100);
    const ex = invExtraRows(inv);
    doc.text('Subtotal', tx, y);
    doc.setTextColor(15, 23, 42);
    doc.text(`${settings.currency} ${money(ex.rows.length ? ex.sub : inv.total)}`, W - m, y, { align: 'right' });
    y += 6;
    ex.rows.forEach(r => {
      doc.setTextColor(100);
      doc.text(r.label, tx, y);
      doc.setTextColor(15, 23, 42);
      doc.text(`${r.amt < 0 ? '-' : ''}${settings.currency} ${money(Math.abs(r.amt))}`, W - m, y, { align: 'right' });
      y += 6;
    });
    if (inv.docType !== 'estimate') {
    doc.setTextColor(100);
    doc.text('Paid', tx, y);
    doc.setTextColor(16, 185, 129);
    doc.setFont('helvetica', 'bold');
    doc.text(`${settings.currency} ${money(paid)}`, W - m, y, { align: 'right' });
    y += 6;
    if (due > 0) {
      doc.setFont('helvetica', 'normal');
      doc.setTextColor(100);
      doc.text('Due', tx, y);
      doc.setTextColor(239, 68, 68);
      doc.setFont('helvetica', 'bold');
      doc.text(`${settings.currency} ${money(due)}`, W - m, y, { align: 'right' });
      y += 6;
    }
    }
    y += 2;
    doc.setFillColor(S[0], S[1], S[2]);
    doc.roundedRect(tx - 4, y - 4, W - m - (tx - 4), 10, 2, 2, 'F');
    doc.setTextColor(D[0], D[1], D[2]);
    doc.setFont('helvetica', 'bold');
    doc.setFontSize(11);
    doc.text('Total', tx, y + 3);
    doc.text(`${settings.currency} ${money(inv.total)}`, W - m, y + 3, { align: 'right' });
    y += 16;

    // Payment QR section (paid plans only, same rule as the image invoice)
    if (settings.paymentQr && (!window.HisablyFreemium || HisablyFreemium.effectivePlan().limits.paymentQrOnInvoice)) {
      try {
        const qrSize = 32;
        doc.setDrawColor(226, 232, 240);
        doc.setFillColor(248, 250, 252);
        doc.roundedRect(m, y, W - 2 * m, qrSize + 14, 3, 3, 'FD');
        doc.addImage(settings.paymentQr, 'PNG', m + 6, y + 6, qrSize, qrSize);
        doc.setFont('helvetica', 'bold');
        doc.setFontSize(9);
        doc.setTextColor(15, 23, 42);
        doc.text('Scan to pay', m + qrSize + 12, y + 14);
        doc.setFont('helvetica', 'normal');
        doc.setFontSize(8);
        doc.setTextColor(100);
        doc.text(settings.paymentNote || 'Pay via JazzCash / EasyPaisa / Bank', m + qrSize + 12, y + 20);
        if (settings.phone) doc.text('Contact: ' + settings.phone, m + qrSize + 12, y + 26);
        y += qrSize + 18;
      } catch (e) { y += 4; }
    }

    if (settings.taxId) {
      doc.setFontSize(7);
      doc.setTextColor(120);
      doc.text('Tax / NTN / GST: ' + settings.taxId, m, y);
      y += 5;
    }
    doc.setFont('helvetica', 'bold');
    doc.setFontSize(9);
    doc.setTextColor(A[0], A[1], A[2]);
    doc.text('Thank you for your business!', m, y);
    y += 5;
    doc.setFont('helvetica', 'normal');
    doc.setFontSize(7);
    doc.setTextColor(160);
    doc.text('Generated by Hisably', m, y);

    // page numbers + signature lines
    const pages = doc.getNumberOfPages();
    for (let pg = 1; pg <= pages; pg++) {
      doc.setPage(pg);
      doc.setFontSize(7);
      doc.setTextColor(160);
      doc.setFont('helvetica', 'normal');
      doc.text(`${inv.number}  ·  Page ${pg} of ${pages}`, W - m, 290, { align: 'right' });
    }

    doc.save(`Invoice-${inv.number}.pdf`);
    toast('PDF downloaded');
  }

  async function shareInvoiceImage(inv) {
    const paid = inv.paidAmount || 0;
    const due = Math.max(0, (inv.total || 0) - paid);
    const statusText = inv.docType === 'estimate' ? 'QUOTE' : (due <= 0 ? 'PAID' : (paid > 0 ? 'PARTIAL' : 'UNPAID'));
    const statusColor = due <= 0 ? '#10B981' : (paid > 0 ? '#F59E0B' : '#EF4444');

    const TH = HisablyReceipt.themeOf(settings), bandT = TH.style === 'band';
    const card = document.createElement('div');
    card.style.cssText = 'position:fixed;left:-9999px;top:0;width:400px;background:#fff;font-family:Inter,system-ui,sans-serif;color:#0F172A;border-radius:16px;overflow:hidden;';
    card.innerHTML = `
      <div style="${bandT ? `background:linear-gradient(135deg,${TH.accent},${TH.dark});color:#fff;` : `background:#fff;color:#0F172A;border-bottom:3px solid ${TH.accent};`}padding:18px 20px;display:flex;align-items:center;gap:12px;">
        ${settings.logo ? `<div style="width:46px;height:46px;border-radius:12px;background:#fff;display:flex;align-items:center;justify-content:center;overflow:hidden;flex-shrink:0"><img src="${settings.logo}" style="width:42px;height:42px;object-fit:contain"/></div>` : `<div style="width:46px;height:46px;border-radius:12px;background:${bandT ? '#fff' : TH.soft};color:${TH.accent};font-weight:800;font-size:16px;display:flex;align-items:center;justify-content:center;flex-shrink:0">H</div>`}
        <div style="flex:1;min-width:0">
          <div style="font-size:17px;font-weight:700">${escapeHtml(settings.businessName)}</div>
          <div style="font-size:11px;opacity:0.9;margin-top:2px">${escapeHtml([settings.phone, settings.city].filter(Boolean).join(' · '))}</div>
        </div>
        <div style="text-align:right">
          <div style="font-size:10px;font-weight:700;opacity:0.85;letter-spacing:0.05em">${docWord(inv).toUpperCase()}</div>
          <div style="font-size:13px;font-weight:600">${escapeHtml(inv.number)}</div>
          <div style="font-size:10px;opacity:0.85">${formatDate(inv.date)}</div>
        </div>
      </div>
      <div style="padding:16px 20px 6px;display:flex;justify-content:space-between;align-items:flex-start">
        <div>
          <div style="font-size:10px;color:#94A3B8;font-weight:600;letter-spacing:0.04em">BILL TO</div>
          <div style="font-size:15px;font-weight:700;margin-top:2px">${escapeHtml(inv.customerName || 'Walk-in')}</div>
          ${inv.customerPhone ? `<div style="font-size:12px;color:#64748B;margin-top:2px">${escapeHtml(inv.customerPhone)}</div>` : ''}
        </div>
        <div style="background:${statusColor};color:#fff;font-size:11px;font-weight:700;padding:5px 10px;border-radius:8px">${statusText}</div>
      </div>
      <div style="padding:8px 20px">
        <div style="background:#F8FAFC;border-radius:10px;padding:10px 12px">
          <div style="display:flex;font-size:10px;color:#94A3B8;font-weight:600;margin-bottom:6px">
            <span style="flex:1">ITEM</span><span style="width:40px;text-align:center">QTY</span><span style="width:78px;text-align:right">AMOUNT</span>
          </div>
          ${inv.items.map(it => `
            <div style="display:flex;align-items:center;font-size:13px;padding:7px 0;border-top:1px solid #F1F5F9">
              <span style="flex:1;font-weight:500">${escapeHtml(it.name)}</span>
              <span style="width:40px;text-align:center;color:#64748B">${it.qty}</span>
              <span style="width:78px;text-align:right;font-weight:600">${settings.currency} ${money(it.price * it.qty)}</span>
            </div>`).join('')}
        </div>
      </div>
      <div style="padding:4px 20px 8px">
        ${(() => { const x = invExtraRows(inv); return x.rows.length ? [{ label: 'Subtotal', amt: x.sub }].concat(x.rows).map(r => `<div style="display:flex;justify-content:space-between;font-size:13px;margin-bottom:4px"><span style="color:#64748B">${escapeHtml(r.label)}</span><span style="font-weight:600">${r.amt < 0 ? '−' : ''}${settings.currency} ${money(Math.abs(r.amt))}</span></div>`).join('') : ''; })()}
        ${inv.docType === 'estimate' ? '' : `        <div style="display:flex;justify-content:space-between;font-size:13px;margin-bottom:4px">
          <span style="color:#64748B">Paid</span><span style="color:#10B981;font-weight:600">${settings.currency} ${money(paid)}</span>
        </div>
        ${due > 0 ? `<div style="display:flex;justify-content:space-between;font-size:13px;margin-bottom:6px">
          <span style="color:#64748B">Due</span><span style="color:#EF4444;font-weight:600">${settings.currency} ${money(due)}</span>
        </div>` : ''}`}
        <div style="display:flex;justify-content:space-between;align-items:center;background:linear-gradient(135deg,${TH.soft},${TH.softer});border-radius:12px;padding:12px 14px;margin-top:4px">
          <span style="font-weight:700;font-size:14px">Total</span>
          <span style="font-weight:800;font-size:18px;color:${TH.dark}">${settings.currency} ${money(inv.total)}</span>
        </div>
      </div>
      ${(settings.paymentQr && (!window.HisablyFreemium || HisablyFreemium.effectivePlan().limits.paymentQrOnInvoice)) ? `
      <div style="margin:8px 20px 16px;padding:12px;background:#F8FAFC;border-radius:12px;display:flex;align-items:center;gap:14px;border:1px solid #E2E8F0">
        <img src="${settings.paymentQr}" style="width:72px;height:72px;border-radius:8px;object-fit:contain;background:#fff" />
        <div>
          <div style="font-size:13px;font-weight:700;color:#0F172A">Scan to pay</div>
          <div style="font-size:11px;color:#64748B;margin-top:4px">${escapeHtml(settings.paymentNote || 'Pay via JazzCash / EasyPaisa / Bank')}</div>
          ${settings.phone ? `<div style="font-size:11px;color:#64748B;margin-top:2px">${escapeHtml(settings.phone)}</div>` : ''}
        </div>
      </div>` : `<div style="text-align:center;font-size:11px;color:#94A3B8;padding:0 20px 16px">Thank you for your business!</div>`}
    `;
    document.body.appendChild(card);

    try {
      const canvas = await html2canvas(card, { scale: 2, backgroundColor: '#ffffff', logging: false });
      document.body.removeChild(card);
      canvas.toBlob(async (blob) => {
        if (!blob) { toast('Could not create image'); return; }
        const file = new File([blob], `Invoice-${inv.number}.png`, { type: 'image/png' });
        if (navigator.share && navigator.canShare && navigator.canShare({ files: [file] })) {
          try {
            await navigator.share({ files: [file], title: `${docWord(inv)} ${inv.number}`, text: `${docWord(inv)} from ${settings.businessName}` });
            toast('Shared');
            return;
          } catch (err) {
            if (err.name === 'AbortError') return;
          }
        }
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = `Invoice-${inv.number}.png`;
        a.click();
        URL.revokeObjectURL(url);
        toast('Image saved – share on WhatsApp');
      }, 'image/png');
    } catch (err) {
      if (card.parentNode) document.body.removeChild(card);
      console.error(err);
      toast('Image generation failed');
    }
  }

  function shareWhatsAppText(inv) {
    let text = `*${settings.businessName}*\n${docWord(inv)} ${inv.number}\nDate: ${formatDate(inv.date)}\nCustomer: ${inv.customerName || 'Walk-in'}\n\n`;
    inv.items.forEach(it => {
      text += `• ${it.name} × ${it.qty} = ${settings.currency} ${money(it.price * it.qty)}\n`;
    });
    const wx = invExtraRows(inv);
    if (wx.rows.length) {
      text += `\nSubtotal: ${settings.currency} ${money(wx.sub)}`;
      wx.rows.forEach(r => { text += `\n${r.label}: ${r.amt < 0 ? '-' : ''}${settings.currency} ${money(Math.abs(r.amt))}`; });
    }
    text += `\n*Total: ${settings.currency} ${money(inv.total)}*`;
    if (settings.phone) text += `\n\nContact: ${settings.phone}`;
    sendWhatsApp(inv.customerPhone, text);
  }

  // ---------- Receipt printing: 58 / 80 / 88 mm thermal, A4, Bluetooth ----------
  let printTarget = null;

  function receiptCtx() {
    return {
      settings,
      money,
      formatDate,
      qrAllowed: !window.HisablyFreemium || HisablyFreemium.effectivePlan().limits.paymentQrOnInvoice
    };
  }

  function printInvoice(inv) {
    if (!window.HisablyReceipt) { toast('Print module not loaded. Refresh the page.'); return; }
    printTarget = inv;
    openPrintModal();
  }

  function openPrintModal() {
    const inv = printTarget;
    if (!inv) return;
    const R = HisablyReceipt, pr = R.getPrefs();
    const chip = (k) => `<button type="button" class="cat-chip ${pr.paper === k ? 'active' : ''}" data-action="rc-paper" data-paper="${k}">${R.PAPER[k].label}</button>`;
    const btOk = R.btSupported();
    $('#modalRoot').innerHTML = `
      <div class="modal-overlay" id="rcModal">
        <div class="modal-sheet">
          <div class="modal-handle"></div>
          <div class="modal-header">
            <h3 class="modal-title">Print ${escapeHtml(inv.number)}</h3>
            <button class="modal-close" data-action="close-modal"><svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg></button>
          </div>
          <div class="form-label">Paper size</div>
          <div class="cat-chips" style="margin-bottom:12px">${['58', '80', '88', 'a4'].map(chip).join('')}</div>
          <div class="form-group">
            <label class="form-label">Receipt footer message</label>
            <input class="form-input" id="rcFooter" maxlength="80" placeholder="Thank you for your business!" value="${escapeHtml(pr.footer || '')}" />
          </div>
          <button class="btn btn-primary btn-block" data-action="rc-print">Print (browser / printer app)</button>
          <button class="btn btn-secondary btn-block mt-8" data-action="rc-save-image">Save receipt as image</button>

          <div class="section-header" style="margin-top:20px"><h2 class="section-title">Bluetooth printer (direct)</h2></div>
          ${btOk ? '' : `<p class="text-sm" style="color:var(--danger)">This browser has no Bluetooth printing. Open Hisably in <strong>Chrome on Android</strong>.</p>`}
          <div class="form-row">
            <div class="form-group"><label class="form-label">Printer</label>
              <select class="form-input" id="rcPrinter">
                <option value="mxw01" ${pr.printer === 'mxw01' ? 'selected' : ''}>MXW01 / mini fun printer</option>
                <option value="escpos" ${pr.printer === 'escpos' ? 'selected' : ''}>ESC/POS thermal (58/80/88)</option>
              </select></div>
            <div class="form-group"><label class="form-label">Darkness</label>
              <select class="form-input" id="rcDensity">
                ${['light', 'medium', 'dark'].map(d => `<option value="${d}" ${pr.density === d ? 'selected' : ''}>${d[0].toUpperCase() + d.slice(1)}</option>`).join('')}
              </select></div>
          </div>
          <div class="form-group" id="rcBitWrap" style="${pr.printer === 'mxw01' ? '' : 'display:none'}"><label class="form-label">If the print is garbled / mirrored, switch this</label>
            <select class="form-input" id="rcBit">
              <option value="lsb" ${pr.bitOrder === 'lsb' ? 'selected' : ''}>Standard (recommended)</option>
              <option value="msb" ${pr.bitOrder === 'msb' ? 'selected' : ''}>Alternate</option>
            </select></div>
          <div class="flex gap-8">
            <button class="btn btn-primary" style="flex:1" data-action="rc-bt-print" ${btOk ? '' : 'disabled'}>Print via Bluetooth</button>
            <button class="btn btn-secondary" style="flex:1" data-action="rc-bt-test" ${btOk ? '' : 'disabled'}>Test print</button>
          </div>
          <div id="rcStatus" class="text-sm text-secondary mt-8"></div>
          <p class="text-sm text-secondary mt-8">Turn the printer on, keep it close, and choose it in the Bluetooth list that appears. Bluetooth printing is new: if it doesn’t work for your model, use <em>Save receipt as image</em> and print with the printer’s own app.</p>
        </div>
      </div>`;
    const R2 = HisablyReceipt;
    const bind = (id, key) => { const el = document.getElementById(id); if (el) el.addEventListener('change', () => { R2.setPrefs({ [key]: el.value }); if (id === 'rcPrinter') { const w = document.getElementById('rcBitWrap'); if (w) w.style.display = el.value === 'mxw01' ? '' : 'none'; R2.forgetDevice(); } }); };
    bind('rcPrinter', 'printer'); bind('rcDensity', 'density'); bind('rcBit', 'bitOrder');
    const f = document.getElementById('rcFooter');
    if (f) f.addEventListener('input', () => R2.setPrefs({ footer: f.value.trim() }));
  }

  function rcStatus(msg) { const el = document.getElementById('rcStatus'); if (el) el.textContent = msg; }

  function receiptDots() {
    const pr = HisablyReceipt.getPrefs();
    if (pr.printer === 'mxw01') return 384;           // MXW01 prints exactly 384 dots
    const P = HisablyReceipt.PAPER[pr.paper === 'a4' ? '80' : pr.paper] || HisablyReceipt.PAPER['80'];
    return P.dots;
  }

  async function rcBluetooth(test) {
    const inv = printTarget;
    if (!inv && !test) return;
    try {
      rcStatus('Rendering…');
      const dots = receiptDots();
      const cv = test ? HisablyReceipt.testCanvas(dots) : await HisablyReceipt.renderCanvas(inv, receiptCtx(), dots);
      await HisablyReceipt.bluetoothPrint(cv, {}, rcStatus);
      toast(test ? 'Test sent to printer' : 'Sent to printer');
    } catch (e) {
      if (e && e.name === 'NotFoundError') { rcStatus('No printer selected.'); return; }   // user closed the picker
      console.error(e);
      const raw = String((e && e.message) || e);
      rcStatus(/bluetooth|chrome|android/i.test(raw) && /needs|support/i.test(raw) ? raw : 'Could not talk to the printer. Make sure it is switched on, close to your phone and not connected to another app, then try again.');
    }
  }

  async function rcSaveImage() {
    const inv = printTarget;
    if (!inv) return;
    try {
      const pr = HisablyReceipt.getPrefs();
      const dots = pr.paper === 'a4' ? 576 : (HisablyReceipt.PAPER[pr.paper] || HisablyReceipt.PAPER['80']).dots;
      const cv = await HisablyReceipt.renderCanvas(inv, receiptCtx(), dots);
      cv.toBlob(async (blob) => {
        if (!blob) { toast('Could not create image'); return; }
        const file = new File([blob], `Receipt-${inv.number}.png`, { type: 'image/png' });
        if (navigator.share && navigator.canShare && navigator.canShare({ files: [file] })) {
          try { await navigator.share({ files: [file], title: `Receipt ${inv.number}` }); return; } catch (err) { if (err.name === 'AbortError') return; }
        }
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a'); a.href = url; a.download = file.name; a.click();
        setTimeout(() => URL.revokeObjectURL(url), 2000);
        toast('Receipt image saved');
      }, 'image/png');
    } catch (e) { console.error(e); toast('Could not create image'); }
  }

  async function rcBrowserPrint() {
    const inv = printTarget;
    if (!inv) return;
    try {
      const pr = HisablyReceipt.getPrefs();
      await HisablyReceipt.printHTML(HisablyReceipt.receiptHTML(inv, receiptCtx(), pr.paper));
    } catch (e) { console.error(e); toast('Could not open the print dialog'); }
  }

  // ---------- Categories ----------
  let productCat = '';            // '' = all, '__none__' = uncategorized, else category name

  function categoryList() {
    return [...new Set(products.map(p => (p.category || '').trim()).filter(Boolean))]
      .sort((a, b) => a.localeCompare(b));
  }
  // "soap" and "Soap" must be one category
  function normalizeCategory(name) {
    const c = String(name || '').replace(/\s+/g, ' ').trim();
    if (!c) return '';
    const hit = categoryList().find(x => x.toLowerCase() === c.toLowerCase());
    return hit || c;
  }
  function categoryChipsHTML() {
    const cats = categoryList();
    if (!cats.length) return '';
    const hasNone = products.some(p => !(p.category || '').trim());
    const chip = (val, label, n) =>
      `<button type="button" class="cat-chip ${productCat === val ? 'active' : ''}" data-action="filter-cat" data-cat="${escapeHtml(val)}">${escapeHtml(label)} <span>${n}</span></button>`;
    return `<div class="cat-chips">
      ${chip('', 'All', products.length)}
      ${cats.map(c => chip(c, c, products.filter(p => (p.category || '').trim() === c).length)).join('')}
      ${hasNone ? chip('__none__', 'Uncategorized', products.filter(p => !(p.category || '').trim()).length) : ''}
    </div>`;
  }
  function productListHTML(query) {
    const q = (query || '').trim().toLowerCase();
    let list = products.filter(p => {
      const cat = (p.category || '').trim();
      if (productCat === '__none__' && cat) return false;
      if (productCat && productCat !== '__none__' && cat !== productCat) return false;
      return !q || p.name.toLowerCase().includes(q) || (p.barcode || '').toLowerCase().includes(q) || cat.toLowerCase().includes(q);
    });
    if (!list.length) return '<div class="text-center text-secondary" style="padding:32px 0">No products found</div>';
    list.sort((a, b) => (a.category || '~').localeCompare(b.category || '~') || a.name.localeCompare(b.name));
    if (productCat) return list.map(listProduct).join('');
    // "All": group under category headings
    let html = '', last = null;
    list.forEach(p => {
      const cat = (p.category || '').trim() || 'Uncategorized';
      if (cat !== last) {
        const n = list.filter(x => ((x.category || '').trim() || 'Uncategorized') === cat).length;
        html += `<div class="cat-heading">${escapeHtml(cat)} <span>${n}</span></div>`;
        last = cat;
      }
      html += listProduct(p);
    });
    return html;
  }

  // ---------- Bulk tools: CSV export / import, bulk price change ----------
  const CSV_COLUMNS = ['Name', 'Category', 'Selling Price', 'Cost Price', 'Stock', 'Unit', 'Low Stock Alert', 'Barcode', 'Notes'];

  function csvCell(v, isText) {
    let t = v == null ? '' : String(v);
    // stop spreadsheet formula injection in text cells
    if (isText && /^[=+\-@\t\r]/.test(t)) t = "'" + t;
    return /[",\r\n]/.test(t) ? '"' + t.replace(/"/g, '""') + '"' : t;
  }
  function downloadText(filename, text, mime) {
    const blob = new Blob(['﻿' + text], { type: (mime || 'text/csv') + ';charset=utf-8' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 500);
  }
  function exportProductsCSV(templateOnly) {
    const rows = [CSV_COLUMNS.join(',')];
    if (templateOnly) {
      rows.push(['Sample Soap', 'Grocery', 120, 90, 50, 'pcs', 5, '8964000123456', ''].map((v, i) => csvCell(v, [0, 1, 5, 7, 8].includes(i))).join(','));
    } else {
      [...products].sort((a, b) => (a.category || '~').localeCompare(b.category || '~') || a.name.localeCompare(b.name)).forEach(p => {
        rows.push([
          csvCell(p.name, true), csvCell(p.category || '', true), p.price, p.cost || 0, p.stock,
          csvCell(p.unit || 'pcs', true), p.lowStock ?? settings.lowStockDefault, csvCell(p.barcode || '', true), csvCell(p.notes || '', true)
        ].join(','));
      });
    }
    downloadText(templateOnly ? 'hisably-products-template.csv' : `hisably-products-${new Date().toISOString().slice(0, 10)}.csv`, rows.join('\r\n'));
    toast(templateOnly ? 'Template downloaded' : `${products.length} products exported`);
  }

  // RFC-4180 style parser (quotes, embedded commas/newlines, ; or tab delimiters)
  function parseCSV(text) {
    text = String(text || '').replace(/^﻿/, '');
    const firstLine = text.split(/\r?\n/)[0] || '';
    const counts = { ',': 0, ';': 0, '\t': 0 };
    let inQ = false;
    for (const ch of firstLine) { if (ch === '"') inQ = !inQ; else if (!inQ && counts[ch] != null) counts[ch]++; }
    const delim = Object.keys(counts).sort((a, b) => counts[b] - counts[a])[0];
    const rows = []; let row = [], cell = '', q = false;
    for (let i = 0; i < text.length; i++) {
      const ch = text[i];
      if (q) {
        if (ch === '"') { if (text[i + 1] === '"') { cell += '"'; i++; } else q = false; }
        else cell += ch;
      } else if (ch === '"') q = true;
      else if (ch === delim) { row.push(cell); cell = ''; }
      else if (ch === '\n' || ch === '\r') {
        if (ch === '\r' && text[i + 1] === '\n') i++;
        row.push(cell); cell = '';
        if (row.some(c => c.trim() !== '')) rows.push(row);
        row = [];
      } else cell += ch;
    }
    row.push(cell);
    if (row.some(c => c.trim() !== '')) rows.push(row);
    return rows;
  }

  const HEADER_ALIASES = {
    name: ['name', 'product', 'product name', 'item', 'item name', 'title'],
    category: ['category', 'group', 'type', 'department'],
    price: ['selling price', 'price', 'sale price', 'sell price', 'rate', 'mrp', 'retail price'],
    cost: ['cost price', 'cost', 'purchase price', 'buying price', 'buy price'],
    stock: ['stock', 'qty', 'quantity', 'opening stock', 'in stock'],
    unit: ['unit', 'uom'],
    lowStock: ['low stock alert', 'low stock', 'reorder level', 'min stock', 'alert'],
    barcode: ['barcode', 'sku', 'code', 'barcode / qr'],
    notes: ['notes', 'note', 'description', 'details']
  };
  function parseNum(v) {
    const t = String(v == null ? '' : v).replace(/[,\s]/g, '').replace(/^(rs\.?|pkr|inr|usd|\$|€|₹)/i, '');
    if (t === '') return null;
    const n = Number(t);
    return isFinite(n) ? n : NaN;
  }

  // Turn CSV text into a plan: what will be added / updated / skipped (nothing is changed yet)
  function planImport(text, opts) {
    const rows = parseCSV(text);
    if (rows.length < 2) return { error: 'The file is empty or has no product rows.' };
    const header = rows[0].map(h => h.trim().toLowerCase().replace(/[_*]+/g, ' ').replace(/\s*\(.*?\)\s*/g, ' ').replace(/\s+/g, ' ').trim());
    const col = {};
    Object.entries(HEADER_ALIASES).forEach(([key, names]) => {
      const i = header.findIndex(h => names.includes(h));
      if (i >= 0) col[key] = i;
    });
    if (col.name == null) return { error: 'Could not find a "Name" column. Download the template to see the expected columns.' };

    const get = (r, k) => (col[k] == null ? undefined : String(r[col[k]] == null ? '' : r[col[k]]).trim());
    const text0 = v => (v || '').replace(/^'(?=[=+\-@])/, '');
    const byBarcode = new Map(), byName = new Map();
    products.forEach(p => {
      if (p.barcode) byBarcode.set(p.barcode.toLowerCase(), p);
      byName.set(p.name.toLowerCase(), p);
    });

    const plan = { adds: [], updates: [], skipped: [], newCategories: new Set(), colsFound: Object.keys(col) };
    const seen = new Map();   // key in file -> index in adds/updates (last row wins)
    rows.slice(1).forEach((r, idx) => {
      const line = idx + 2;
      const name = text0(get(r, 'name'));
      if (!name) { plan.skipped.push(`Row ${line}: no name`); return; }
      const rec = { name };
      let bad = null;
      const numField = (k, label, int) => {
        const raw = get(r, k);
        if (raw === undefined || raw === '') return;
        const n = parseNum(raw);
        if (Number.isNaN(n) || n < 0) { bad = `${label} "${raw}" is not a valid number`; return; }
        rec[k] = int ? Math.round(n) : round2(n);
      };
      numField('price', 'Selling price'); numField('cost', 'Cost price'); numField('stock', 'Stock', true); numField('lowStock', 'Low stock', true);
      if (bad) { plan.skipped.push(`Row ${line} (${name}): ${bad}`); return; }
      const cat = get(r, 'category'); if (cat !== undefined && cat !== '') rec.category = normalizeCategoryWith(text0(cat), plan);
      const unit = get(r, 'unit'); if (unit) rec.unit = text0(unit);
      const bc = get(r, 'barcode'); if (bc) rec.barcode = text0(bc);
      const nt = get(r, 'notes'); if (nt) rec.notes = text0(nt);

      const existing = (rec.barcode && byBarcode.get(rec.barcode.toLowerCase())) || byName.get(name.toLowerCase());
      const key = existing ? 'id:' + existing.id : 'new:' + (rec.barcode || name).toLowerCase();
      if (seen.has(key)) {          // same product twice in the file: last row wins
        const target = seen.get(key);
        Object.assign(target.rec, rec);
        plan.skipped.push(`Row ${line} (${name}): duplicate in file – merged into the earlier row`);
        return;
      }
      const entry = existing ? { existing, rec } : { rec };
      seen.set(key, entry);
      (existing ? plan.updates : plan.adds).push(entry);
    });

    // Free-plan product limit applies to NEW products only
    if (window.HisablyFreemium) {
      const { limits, key } = HisablyFreemium.effectivePlan();
      const room = key === 'blocked' ? 0 : Math.max(0, limits.products - products.length);
      if (plan.adds.length > room) {
        const cut = plan.adds.length - room;
        plan.adds.slice(room).forEach(e => plan.skipped.push(`${e.rec.name}: not added – plan limit of ${limits.products} products`));
        plan.adds = plan.adds.slice(0, room);
        plan.limited = cut;
      }
    }
    plan.updateStock = !!(opts && opts.updateStock);
    return plan;
  }
  function normalizeCategoryWith(name, plan) {
    const c = normalizeCategory(name);
    if (c && !categoryList().some(x => x.toLowerCase() === c.toLowerCase())) {
      // keep one spelling for categories new in this file
      const hit = [...plan.newCategories].find(x => x.toLowerCase() === c.toLowerCase());
      if (hit) return hit;
      plan.newCategories.add(c);
    }
    return c;
  }

  function applyImport(plan) {
    const now = new Date().toISOString();
    let added = 0, updated = 0;
    plan.adds.forEach(({ rec }) => {
      const p = {
        id: uid(), name: rec.name, category: rec.category || '', price: rec.price || 0, cost: rec.cost || 0,
        stock: rec.stock || 0, unit: rec.unit || 'pcs', lowStock: rec.lowStock ?? settings.lowStockDefault,
        barcode: rec.barcode || '', notes: rec.notes || '', createdAt: now
      };
      products.push(p); added++;
      if (p.stock > 0) stockMovements.unshift({ id: uid(), productId: p.id, productName: p.name, type: 'in', qty: p.stock, date: now, note: 'Opening stock (import)' });
    });
    plan.updates.forEach(({ existing, rec }) => {
      ['category', 'price', 'cost', 'unit', 'lowStock', 'barcode', 'notes'].forEach(k => { if (rec[k] !== undefined) existing[k] = rec[k]; });
      if (plan.updateStock && rec.stock !== undefined && rec.stock !== existing.stock) {
        const diff = rec.stock - existing.stock;
        existing.stock = rec.stock;
        stockMovements.unshift({ id: uid(), productId: existing.id, productName: existing.name, type: diff > 0 ? 'in' : 'out', qty: Math.abs(diff), date: now, note: 'Import adjustment' });
      }
      updated++;
    });
    persist();
    return { added, updated };
  }

  let pendingImportText = null;

  function openBulkModal() {
    const undo = load('sb_price_undo_v1', null);
    $('#modalRoot').innerHTML = `
      <div class="modal-overlay">
        <div class="modal-sheet">
          <div class="modal-handle"></div>
          <div class="modal-header">
            <h3 class="modal-title">Bulk tools</h3>
            <button class="modal-close" data-action="close-modal"><svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg></button>
          </div>
          <div class="menu-list">
            <button class="menu-item" data-action="bulk-price"><div>Change prices in bulk<span class="menu-sub">+/− by % or by ${escapeHtml(settings.currency)} amount</span></div></button>
            <button class="menu-item" data-action="bulk-export"><div>Export products (CSV)<span class="menu-sub">Opens in Excel / Google Sheets</span></div></button>
            <button class="menu-item" data-action="bulk-import-pick"><div>Import products (CSV)<span class="menu-sub">Add new or update existing</span></div></button>
            <button class="menu-item" data-action="bulk-template"><div>Download blank CSV template</div></button>
            ${undo ? `<button class="menu-item" data-action="bulk-undo"><div>Undo last price change<span class="menu-sub">${escapeHtml(undo.label)} · ${formatDate(undo.at)}</span></div></button>` : ''}
          </div>
          <input type="file" id="bulkImportFile" accept=".csv,text/csv,text/plain" style="display:none" />
        </div>
      </div>`;
  }

  function openImportPreview(text) {
    pendingImportText = text;
    renderImportPreview(true);
  }
  function renderImportPreview(updateStock) {
    const plan = planImport(pendingImportText, { updateStock });
    if (plan.error) {
      $('#modalRoot').innerHTML = modalShell('Import products', `<p class="text-sm" style="color:var(--danger)">${escapeHtml(plan.error)}</p>
        <button class="btn btn-secondary btn-block mt-16" data-action="bulk-template">Download template</button>`);
      return;
    }
    const cats = [...plan.newCategories];
    const sample = [...plan.adds.slice(0, 3), ...plan.updates.slice(0, 3)].map(e => `<div class="text-sm">${e.existing ? 'Update' : 'Add'}: <strong>${escapeHtml(e.rec.name)}</strong>${e.rec.price != null ? ' · ' + settings.currency + ' ' + money(e.rec.price) : ''}</div>`).join('');
    $('#modalRoot').innerHTML = modalShell('Import preview', `
      <div class="stats-grid mb-16" style="grid-template-columns:repeat(3,1fr)">
        <div class="stat-card"><div class="stat-label">New</div><div class="stat-value success">${plan.adds.length}</div></div>
        <div class="stat-card"><div class="stat-label">Updated</div><div class="stat-value primary">${plan.updates.length}</div></div>
        <div class="stat-card"><div class="stat-label">Skipped</div><div class="stat-value ${plan.skipped.length ? 'danger' : ''}">${plan.skipped.length}</div></div>
      </div>
      ${cats.length ? `<p class="text-sm text-secondary mb-8">New categories: ${cats.map(escapeHtml).join(', ')}</p>` : ''}
      ${sample}
      <label class="text-sm" style="display:flex;gap:8px;align-items:center;margin:14px 0">
        <input type="checkbox" id="importUpdateStock" ${updateStock ? 'checked' : ''} /> Also set stock quantity of existing products from the file
      </label>
      ${plan.skipped.length ? `<details class="mb-12"><summary class="text-sm" style="cursor:pointer">Why were ${plan.skipped.length} rows skipped?</summary>
        <div class="text-sm text-secondary" style="max-height:140px;overflow:auto;margin-top:6px">${plan.skipped.slice(0, 50).map(s => `<div>${escapeHtml(s)}</div>`).join('')}</div></details>` : ''}
      ${plan.limited ? `<div class="plan-banner">Free plan limit reached – ${plan.limited} new product(s) not added. <button type="button" class="linkish" data-action="open-plans">Upgrade</button></div>` : ''}
      <button class="btn btn-primary btn-block" data-action="bulk-import-confirm" ${plan.adds.length + plan.updates.length === 0 ? 'disabled' : ''}>Import ${plan.adds.length + plan.updates.length} product(s)</button>`);
  }
  function modalShell(title, inner) {
    return `<div class="modal-overlay"><div class="modal-sheet"><div class="modal-handle"></div>
      <div class="modal-header"><h3 class="modal-title">${title}</h3>
      <button class="modal-close" data-action="close-modal"><svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg></button></div>
      ${inner}</div></div>`;
  }

  // ---- bulk price change ----
  function computeNewPrice(v, o) {
    let n = o.type === 'percent' ? v * (1 + o.sign * o.value / 100) : v + o.sign * o.value;
    n = Math.max(0, n);
    if (o.round > 0) n = Math.round(n / o.round) * o.round;
    return round2(n);
  }
  function bulkPriceOptions() {
    const f = $('#bulkPriceForm');
    if (!f) return null;
    const fd = new FormData(f);
    return {
      scope: fd.get('scope') || '', field: fd.get('field') || 'price',
      sign: fd.get('dir') === 'dec' ? -1 : 1, type: fd.get('type') || 'percent',
      value: Math.max(0, parseFloat(fd.get('value')) || 0), round: parseFloat(fd.get('round')) || 0
    };
  }
  function bulkTargets(scope) {
    if (scope === '') return products;
    if (scope === '__none__') return products.filter(p => !(p.category || '').trim());
    return products.filter(p => (p.category || '').trim() === scope);
  }
  function openBulkPriceModal() {
    const cats = categoryList();
    const opt = (v, l) => `<option value="${escapeHtml(v)}">${escapeHtml(l)}</option>`;
    $('#modalRoot').innerHTML = modalShell('Change prices in bulk', `
      <form id="bulkPriceForm">
        <div class="form-group"><label class="form-label">Apply to</label>
          <select class="form-input" name="scope">
            ${opt('', `All products (${products.length})`)}
            ${cats.map(c => opt(c, `${c} (${bulkTargets(c).length})`)).join('')}
            ${products.some(p => !(p.category || '').trim()) ? opt('__none__', `Uncategorized (${bulkTargets('__none__').length})`) : ''}
          </select></div>
        <div class="form-group"><label class="form-label">Which price</label>
          <select class="form-input" name="field">${opt('price', 'Selling price')}${opt('cost', 'Cost price')}${opt('both', 'Both selling and cost')}</select></div>
        <div class="form-row">
          <div class="form-group"><label class="form-label">Action</label>
            <select class="form-input" name="dir">${opt('inc', 'Increase')}${opt('dec', 'Decrease')}</select></div>
          <div class="form-group"><label class="form-label">By</label>
            <select class="form-input" name="type">${opt('percent', 'Percentage (%)')}${opt('amount', `Amount (${settings.currency})`)}</select></div>
        </div>
        <div class="form-row">
          <div class="form-group"><label class="form-label" id="bulkValueLabel">Percentage</label>
            <input class="form-input" type="number" name="value" min="0" step="0.01" placeholder="e.g. 10" /></div>
          <div class="form-group"><label class="form-label">Round to</label>
            <select class="form-input" name="round"><option value="0">No rounding</option><option value="1" selected>Nearest 1</option><option value="5">Nearest 5</option><option value="10">Nearest 10</option></select></div>
        </div>
        <div id="bulkPreview" class="card text-sm" style="padding:12px"></div>
        <button type="submit" class="btn btn-primary btn-block mt-16" id="bulkApplyBtn" disabled>Apply</button>
      </form>`);
    const f = $('#bulkPriceForm');
    f.addEventListener('input', updateBulkPreview);
    f.addEventListener('change', updateBulkPreview);
    f.addEventListener('submit', e => { e.preventDefault(); applyBulkPrice(); });
    updateBulkPreview();
  }
  function updateBulkPreview() {
    const o = bulkPriceOptions();
    if (!o) return;
    const lbl = $('#bulkValueLabel');
    if (lbl) lbl.textContent = o.type === 'percent' ? 'Percentage (%)' : `Amount (${settings.currency})`;
    const list = bulkTargets(o.scope);
    const fields = o.field === 'both' ? ['price', 'cost'] : [o.field];
    const prev = $('#bulkPreview'), btn = $('#bulkApplyBtn');
    if (!prev) return;
    if (!list.length) { prev.textContent = 'No products in this selection.'; btn.disabled = true; return; }
    if (!o.value) { prev.textContent = `${list.length} product(s) selected. Enter a value to see the preview.`; btn.disabled = true; return; }
    let changed = 0, zeroed = 0;
    list.forEach(p => fields.forEach(k => {
      const nv = computeNewPrice(p[k] || 0, o);
      if (nv !== (p[k] || 0)) changed++;
      if (nv === 0 && (p[k] || 0) > 0) zeroed++;
    }));
    const rows = list.slice(0, 4).map(p => fields.map(k => `<div>${escapeHtml(p.name)} <span class="text-secondary">(${k === 'price' ? 'sell' : 'cost'})</span>: ${money(p[k] || 0)} → <strong>${money(computeNewPrice(p[k] || 0, o))}</strong></div>`).join('')).join('');
    prev.innerHTML = `<div class="mb-8"><strong>${list.length}</strong> product(s) will change.</div>${rows}${list.length > 4 ? `<div class="text-secondary">…and ${list.length - 4} more</div>` : ''}${zeroed ? `<div style="color:var(--danger);margin-top:6px">${zeroed} price(s) would drop to 0.</div>` : ''}`;
    btn.disabled = false;
    btn.textContent = `${o.sign > 0 ? 'Increase' : 'Decrease'} ${o.value}${o.type === 'percent' ? '%' : ' ' + settings.currency} on ${list.length} product(s)`;
  }
  function applyBulkPrice() {
    const o = bulkPriceOptions();
    if (!o || !o.value) return;
    const list = bulkTargets(o.scope);
    if (!list.length) return;
    if (!confirm(`${o.sign > 0 ? 'Increase' : 'Decrease'} prices of ${list.length} product(s)? You can undo this from Bulk tools.`)) return;
    const fields = o.field === 'both' ? ['price', 'cost'] : [o.field];
    const snapshot = list.map(p => ({ id: p.id, price: p.price, cost: p.cost || 0 }));
    list.forEach(p => fields.forEach(k => { p[k] = computeNewPrice(p[k] || 0, o); }));
    save('sb_price_undo_v1', { at: new Date().toISOString(), label: `${o.sign > 0 ? '+' : '−'}${o.value}${o.type === 'percent' ? '%' : ' ' + settings.currency} · ${list.length} items`, items: snapshot });
    persist();
    closeModal();
    toast(`Prices updated for ${list.length} product(s)`);
    render();
  }
  function undoBulkPrice() {
    const u = load('sb_price_undo_v1', null);
    if (!u) return;
    if (!confirm(`Restore the previous prices of ${u.items.length} product(s)?`)) return;
    let n = 0;
    u.items.forEach(s => { const p = products.find(x => x.id === s.id); if (p) { p.price = s.price; p.cost = s.cost; n++; } });
    localStorage.removeItem('sb_price_undo_v1');
    persist();
    closeModal();
    toast(`Restored ${n} product(s)`);
    render();
  }

  // ---------- Barcode Scanner ----------
  function startScanner(onResult) {
    const root = $('#scannerRoot');
    root.innerHTML = `
      <div class="scanner-header">
        <span style="font-weight:600">Scan Barcode / QR</span>
        <button class="scanner-close" data-action="stop-scanner">✕</button>
      </div>
      <div id="qr-reader" style="width:100%;height:100%;"></div>`;
    root.classList.add('active');

    scanner = new Html5Qrcode('qr-reader');
    scanner.start(
      { facingMode: 'environment' },
      { fps: 10, qrbox: { width: 250, height: 250 } },
      (decoded) => {
        stopScanner();
        onResult(decoded);
      },
      () => {}
    ).catch(err => {
      toast('Camera not available or permission denied');
      stopScanner();
    });
  }

  function stopScanner() {
    if (scanner) {
      scanner.stop().catch(() => {});
      scanner = null;
    }
    const root = $('#scannerRoot');
    root.classList.remove('active');
    root.innerHTML = '';
  }

  // ---------- Global Event Delegation ----------
  document.addEventListener('click', e => {
    // Close open custom dropdowns when clicking outside
    if (!e.target.closest('.custom-select')) {
      $$('.custom-select.open').forEach(el => el.classList.remove('open'));
    }

    const t = e.target.closest('[data-action], [data-view], .nav-item, .list-item, .modal-overlay');
    if (!t) return;

    // Close modal on overlay click
    if (t.classList.contains('modal-overlay') && t.id !== 'qr-reader') {
      if (e.target === t) closeModal();
      return;
    }

    const action = t.dataset.action;
    const view = t.dataset.view || (t.classList.contains('nav-item') ? t.dataset.view : null);
    const id = t.dataset.id;
    if (isStaff() && action && STAFF_BLOCK.test(action)) { toast('Only the owner can do that'); return; }

    if (view) {
      setView(view);
      return;
    }

    switch (action) {
      case 'pick-theme': {
        const k = t.dataset.theme;
        if (HisablyReceipt.THEMES[k] && HisablyReceipt.THEMES[k].pro && !HisablyFreemium.hasFeature('themes')) { toast('This style is a Pro feature.', 4000); openPlansModal && openPlansModal(); break; }
        settings.invoiceTheme = k; persist();
        const box = document.getElementById('themePicker'); if (box) box.outerHTML = themePickerHTML();
        break;
      }
      case 'lock-now': showLock(); break;
      case 'pin-set-owner': openPinModal('owner'); break;
      case 'pin-set-staff': openPinModal('staff'); break;
      case 'pin-remove':
        if (confirm('Remove the PIN lock and staff PIN?')) { settings.pinHash = ''; settings.staffHash = ''; persist(); setRole(''); toast('Lock removed'); openSettingsModal(); }
        break;
      case 'add-product': openProductModal(); break;
      case 'filter-cat': productCat = t.dataset.cat || ''; render(); break;
      case 'bulk-tools': openBulkModal(); break;
      case 'bulk-export': exportProductsCSV(false); break;
      case 'bulk-template': exportProductsCSV(true); break;
      case 'bulk-price': if (!needPro('Bulk price change')) break; openBulkPriceModal(); break;
      case 'bulk-undo': undoBulkPrice(); break;
      case 'bulk-import-pick': { if (!needPro('Bulk product import')) break; const fi = $('#bulkImportFile'); if (fi) fi.click(); break; }
      case 'bulk-import-confirm': {
        if (!pendingImportText) break;
        const plan = planImport(pendingImportText, { updateStock: !!($('#importUpdateStock') || {}).checked });
        if (plan.error) break;
        const r = applyImport(plan);
        pendingImportText = null;
        closeModal();
        toast(`Imported: ${r.added} new, ${r.updated} updated`, 3500);
        setView('products');
        break;
      }
      case 'edit-product': {
        const p = products.find(x => x.id === id);
        if (p) openProductModal(p);
        break;
      }
      case 'delete-product':
        if (confirm('Delete this product?')) {
          products = products.filter(p => p.id !== editingId);
          persist();
          toast('Deleted');
          closeModal();
          render();
        }
        break;
      case 'view-customer': {
        const c = customers.find(x => x.id === id);
        if (c) openCustomerDetail(c);
        break;
      }
      case 'add-customer': openCustomerModal(); break;
      case 'edit-customer': {
        const c = customers.find(x => x.id === id);
        if (c) { closeModal(); openCustomerModal(c); }
        break;
      }
      case 'scan-invoice-barcode':
        startScanner(code => {
          addProductByBarcode(code);
          const inp = $('#invoiceBarcodeInput');
          if (inp) inp.value = code;
        });
        break;
      case 'delete-customer':
        if (confirm('Delete this customer?')) {
          customers = customers.filter(c => c.id !== editingId);
          persist();
          toast('Deleted');
          closeModal();
          setView('customers');
        }
        break;
      case 'add-supplier': openSupplierModal(); break;
      case 'edit-supplier': {
        const s = suppliers.find(x => x.id === id);
        if (s) openSupplierModal(s);
        break;
      }
      case 'delete-supplier':
        if (confirm('Delete this supplier?')) {
          suppliers = suppliers.filter(s => s.id !== editingId);
          persist();
          toast('Deleted');
          closeModal();
          setView('suppliers');
        }
        break;
      case 'inv-filter': invFilter = t.dataset.kind || 'all'; render(); break;
      case 'receive-payment': { const c = customers.find(x => x.id === id); if (c) openReceiveModal(c); break; }
      case 'open-statement': { const c = customers.find(x => x.id === id); if (c) openStatement(c); break; }
      case 'statement-pdf': { const c = customers.find(x => x.id === id); if (c) statementPDF(c); break; }
      case 'statement-wa': { const c = customers.find(x => x.id === id); if (c) sendWhatsApp(c.phone, statementText(c)); break; }
      case 'remind-customer': { const c = customers.find(x => x.id === id); if (c) sendWhatsApp(c.phone, reminderText(c)); break; }
      case 'remind-invoice': { const inv = invoices.find(x => x.id === id); if (inv) { const c = custOfInvoice(inv); sendWhatsApp(c.phone, reminderText(c, inv)); } break; }
      case 'db-range': dbRange = t.dataset.v; render(); break;
      case 'db-mode': dbMode = t.dataset.v; render(); break;
      case 'rp-mode': { const row = t.parentElement; row.querySelectorAll('.cat-chip').forEach(x => x.classList.toggle('active', x === t)); break; }
      case 'new-purchase': docCtx = { type: 'purchase' }; closeModal(); setView('create-invoice'); break;
      case 'view-purchase': { const p = purchases.find(x => x.id === id); if (p) openPurchaseDetail(p); break; }
      case 'purchase-pay': {
        const p = purchases.find(x => x.id === id); if (!p) break;
        const amt = parseFloat($('#recordPayInput') && $('#recordPayInput').value) || 0;
        if (amt <= 0) { toast('Enter a valid amount'); break; }
        addPayment(p, amt, pickedMode('rpMode'), ''); persist(); toast('Payment recorded'); openPurchaseDetail(p); if (currentView === 'purchases') render(); break;
      }
      case 'purchase-pay-full': {
        const p = purchases.find(x => x.id === id); if (!p) break;
        addPayment(p, (p.total || 0) - (p.paidAmount || 0), pickedMode('rpMode'), ''); persist(); toast('Marked as paid'); openPurchaseDetail(p); if (currentView === 'purchases') render(); break;
      }
      case 'view-supplier': { const sp = suppliers.find(x => x.id === id); if (sp) openSupplierDetail(sp); break; }
      case 'pay-supplier': { const sp = suppliers.find(x => x.id === id); if (sp) openPaySupplierModal(sp); break; }
      case 'new-estimate': docCtx = { type: 'estimate' }; closeModal(); setView('create-invoice'); break;
      case 'convert-estimate': {
        const q = invoices.find(x => x.id === id);
        if (q) { docCtx = { type: 'sale', from: q }; closeModal(); setView('create-invoice'); }
        break;
      }
      case 'new-return': docCtx = { type: 'return' }; closeModal(); setView('create-invoice'); break;
      case 'return-from-invoice': {
        const inv = invoices.find(x => x.id === id);
        if (inv) { docCtx = { type: 'return', ref: inv }; closeModal(); setView('create-invoice'); }
        break;
      }
      case 'view-invoice': {
        const inv = invoices.find(x => x.id === id);
        if (inv) openInvoiceDetail(inv);
        break;
      }
      case 'pdf-invoice': {
        const inv = invoices.find(x => x.id === id);
        if (inv) generatePDF(inv);
        break;
      }
      case 'share-image': {
        const inv = invoices.find(x => x.id === id);
        if (inv) shareInvoiceImage(inv);
        break;
      }
      case 'share-whatsapp-text': {
        const inv = invoices.find(x => x.id === id);
        if (inv) shareWhatsAppText(inv);
        break;
      }
      case 'rc-paper': { HisablyReceipt.setPrefs({ paper: t.dataset.paper }); openPrintModal(); break; }
      case 'rc-print': rcBrowserPrint(); break;
      case 'rc-save-image': rcSaveImage(); break;
      case 'rc-bt-print': rcBluetooth(false); break;
      case 'rc-bt-test': rcBluetooth(true); break;
      case 'print-invoice': {
        const inv = invoices.find(x => x.id === id);
        if (inv) printInvoice(inv);
        break;
      }
      case 'open-settings': openSettingsModal(); break;
      case 'close-modal': closeModal(); break;
      case 'toggle-select': {
        const wrap = t.closest('.custom-select');
        if (!wrap) break;
        $$('.custom-select.open').forEach(el => {
          if (el !== wrap) el.classList.remove('open');
        });
        wrap.classList.toggle('open');
        if (wrap.classList.contains('open') && wrap.classList.contains('searchable')) {
          const searchInput = wrap.querySelector('.custom-select-search-input');
          if (searchInput) {
            searchInput.value = '';
            wrap.querySelectorAll('.custom-select-option').forEach(o => o.style.display = '');
            setTimeout(() => searchInput.focus(), 50);
          }
        }
        break;
      }
      case 'select-option': {
        const wrap = t.closest('.custom-select');
        if (!wrap) break;
        const value = t.dataset.value || '';
        const label = t.dataset.label || '';
        const hidden = wrap.querySelector('input[type="hidden"]');
        const trigger = wrap.querySelector('.custom-select-trigger');
        if (hidden) hidden.value = value;
        if (trigger) trigger.textContent = label;
        wrap.querySelectorAll('.custom-select-option').forEach(o => o.classList.remove('selected'));
        t.classList.add('selected');
        wrap.classList.remove('open');

        // Choosing "Walk-in Customer" clears the typed customer
        if (wrap.dataset.name === 'customerId' && !value) {
          const ni = $('#customerNameInput'), pi = $('#customerPhoneInput');
          if (ni) ni.value = '';
          if (pi) pi.value = '';
        }
        // Auto-fill customer name/phone when selecting a customer
        if (wrap.dataset.name === 'customerId' && value) {
          const c = customers.find(x => x.id === value);
          if (c) {
            const nameInput = $('#customerNameInput');
            const phoneInput = $('#customerPhoneInput');
            if (nameInput) nameInput.value = c.name;
            if (phoneInput) phoneInput.value = c.phone || '';
          }
        }
        // Show amount paid field for partial payments
        if (wrap.dataset.name === 'paymentStatus') {
          const grp = $('#paidAmountGroup');
          if (grp) grp.style.display = value === 'partial' ? 'block' : 'none';
        }
        break;
      }
      case 'record-payment': {
        const inv = invoices.find(x => x.id === id);
        if (!inv) break;
        const input = $('#recordPayInput');
        const amt = parseFloat(input && input.value) || 0;
        if (amt <= 0) { toast('Enter a valid amount'); break; }
        addPayment(inv, amt, pickedMode('rpMode'), '');
        persist();
        toast('Payment recorded');
        openInvoiceDetail(inv);
        break;
      }
      case 'mark-paid': {
        const inv = invoices.find(x => x.id === id);
        if (!inv) break;
        addPayment(inv, inv.total - (inv.paidAmount || 0), pickedMode('rpMode'), '');
        inv.paidAmount = inv.total;
        inv.paymentStatus = 'paid';
        persist();
        toast('Marked as paid');
        openInvoiceDetail(inv);
        if (currentView === 'invoices' || currentView === 'dashboard') render();
        break;
      }
      case 'stock-in': {
        const p = products.find(x => x.id === id);
        if (!p) break;
        const qtyInput = $('#stockInQty');
        const qty = parseInt(qtyInput && qtyInput.value, 10) || 0;
        if (qty <= 0) { toast('Enter quantity to add'); break; }
        p.stock = (p.stock || 0) + qty;
        stockMovements.unshift({
          id: uid(),
          productId: p.id,
          productName: p.name,
          type: 'in',
          qty,
          date: new Date().toISOString(),
          note: 'Stock in'
        });
        persist();
        toast(`+${qty} added to stock`);
        if (qtyInput) qtyInput.value = '';
        // refresh modal product stock field if present
        const stockField = document.querySelector('#productForm input[name="stock"]');
        if (stockField) stockField.value = p.stock;
        break;
      }
      case 'add-expense': openExpenseModal(); break;
      case 'edit-expense': {
        const exp = expenses.find(x => x.id === id);
        if (exp) openExpenseModal(exp);
        break;
      }
      case 'delete-expense':
        if (confirm('Delete this expense?')) {
          expenses = expenses.filter(x => x.id !== editingId);
          persist();
          toast('Deleted');
          closeModal();
          setView('expenses');
        }
        break;
      case 'pick-logo': {
        const fileInput = $('#logoFile');
        if (!fileInput) break;
        fileInput.onchange = () => {
          const file = fileInput.files && fileInput.files[0];
          if (!file) return;
          if (file.size > 500 * 1024) { toast('Logo must be under 500KB'); return; }
          const reader = new FileReader();
          reader.onload = () => {
            const dataUrl = reader.result;
            // Resize roughly via canvas if large
            const img = new Image();
            img.onload = () => {
              const max = 200;
              let w = img.width, h = img.height;
              if (w > max || h > max) {
                if (w > h) { h = Math.round(h * max / w); w = max; }
                else { w = Math.round(w * max / h); h = max; }
              }
              const canvas = document.createElement('canvas');
              canvas.width = w; canvas.height = h;
              canvas.getContext('2d').drawImage(img, 0, 0, w, h);
              const resized = canvas.toDataURL('image/png');
              settings.logo = resized;
              const prev = $('#logoPreview');
              if (prev) prev.innerHTML = `<img src="${resized}" alt="Logo" />`;
              toast('Logo ready – tap Save Settings');
            };
            img.src = dataUrl;
          };
          reader.readAsDataURL(file);
        };
        fileInput.click();
        break;
      }
      case 'remove-logo':
        settings.logo = '';
        const prev = $('#logoPreview');
        if (prev) prev.innerHTML = '<span>No logo</span>';
        toast('Logo removed – tap Save Settings');
        break;
      case 'pick-qr': {
        const fileInput = $('#qrFile');
        if (!fileInput) break;
        fileInput.onchange = () => {
          const file = fileInput.files && fileInput.files[0];
          if (!file) return;
          if (file.size > 800 * 1024) { toast('QR image must be under 800KB'); return; }
          const reader = new FileReader();
          reader.onload = () => {
            const img = new Image();
            img.onload = () => {
              const max = 400;
              let w = img.width, h = img.height;
              if (w > max || h > max) {
                if (w > h) { h = Math.round(h * max / w); w = max; }
                else { w = Math.round(w * max / h); h = max; }
              }
              const canvas = document.createElement('canvas');
              canvas.width = w; canvas.height = h;
              canvas.getContext('2d').drawImage(img, 0, 0, w, h);
              settings.paymentQr = canvas.toDataURL('image/png');
              const prev = $('#qrPreview');
              if (prev) prev.innerHTML = `<img src="${settings.paymentQr}" alt="QR" />`;
              toast('Payment QR ready – tap Save Settings');
            };
            img.src = reader.result;
          };
          reader.readAsDataURL(file);
        };
        fileInput.click();
        break;
      }
      case 'remove-qr':
        settings.paymentQr = '';
        const qprev = $('#qrPreview');
        if (qprev) qprev.innerHTML = '<span>No QR</span>';
        toast('QR removed – tap Save Settings');
        break;
      case 'filter-select':
        // handled by input listener
        break;
      case 'scan-barcode':
        startScanner(code => {
          const input = $('#barcodeInput');
          if (input) input.value = code;
          toast('Barcode scanned');
        });
        break;
      case 'stop-scanner': stopScanner(); break;
      case 'open-plans': openPlansModal(); break;
      case 'open-shopify': openShopifyModal(); break;
      case 'shopify-sync': shopifyManualSync(false); break;
      case 'shopify-full': shopifyManualSync(true); break;
      case 'shopify-disconnect':
        if (confirm('Disconnect Shopify? Your products and invoices in Hisably stay; syncing stops.')) {
          shopifyBusy('Disconnecting…');
          HisablyCloud.shopifyCall('disconnect', {}).then(() => { setShopifyOn(false); toast('Shopify disconnected'); }).catch(e => toast(e.message, 5000)).finally(openShopifyModal);
        }
        break;
      case 'submit-payment': submitPayment(); break;
      case 'sign-out-user': signOutUser(); break;
      case 'cloud-auth': openCloudAuthModal(); break;
      case 'cloud-sync': doCloudSync(); break;
      case 'cloud-signin': {
        const email = (($('#cloudEmail') || {}).value || '').trim();
        const password = ($('#cloudPassword') || {}).value;
        if (!email || !password) { toast('Enter email & password'); break; }
        HisablyCloud.signIn(email, password).then(async () => {
          claimDataFor(email);
          closeModal();
          toast('Signed in – syncing…');
          await refreshPlanFromCloud();
          await doCloudSync({ silent: false });
        }).catch(err => toast(err.message || 'Sign in failed'));
        break;
      }
      case 'export-data': {
        const data = { products, invoices, customers, suppliers, expenses, stockMovements, purchases, settings, invoiceCounter, exportedAt: new Date().toISOString() };
        const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
        const a = document.createElement('a');
        a.href = URL.createObjectURL(blob);
        a.download = `hisably-backup-${new Date().toISOString().slice(0,10)}.json`;
        a.click();
        toast('Backup downloaded');
        break;
      }
      case 'import-data': {
        const input = document.createElement('input');
        input.type = 'file';
        input.accept = 'application/json,.json';
        input.onchange = () => {
          const file = input.files && input.files[0];
          if (!file) return;
          const reader = new FileReader();
          reader.onload = () => {
            try {
              const data = JSON.parse(reader.result);
              if (!data || typeof data !== 'object') throw new Error('Invalid');
              if (confirm('Replace current data with this backup?')) {
                if (Array.isArray(data.products)) products = data.products;
                if (Array.isArray(data.invoices)) invoices = data.invoices;
                if (Array.isArray(data.customers)) customers = data.customers;
                if (Array.isArray(data.suppliers)) suppliers = data.suppliers;
                if (Array.isArray(data.expenses)) expenses = data.expenses;
                if (Array.isArray(data.stockMovements)) stockMovements = data.stockMovements;
                if (Array.isArray(data.purchases)) purchases = data.purchases;
                if (data.settings) settings = Object.assign({}, settings, data.settings);
                if (data.invoiceCounter) invoiceCounter = Math.max(invoiceCounter, Number(data.invoiceCounter) || 0);
                normalizeData();
                migrateIds();
                persist();
                migrateData();
                toast('Backup restored');
                setView('dashboard');
              }
            } catch (err) {
              toast('Invalid backup file');
            }
          };
          reader.readAsText(file);
        };
        input.click();
        break;
      }
      case 'clear-data':
        if (confirm('Delete ALL data? This also deletes it from your cloud account and cannot be undone.')) {
          products = []; invoices = []; customers = []; suppliers = []; expenses = []; stockMovements = []; purchases = [];
          invoiceCounter = 1001;
          persist();
          toast('All data cleared');
          setView('dashboard');
        }
        break;
    }
  });

  // Search handlers (delegated via input event)
  document.addEventListener('input', e => {
    if (e.target.classList.contains('custom-select-search-input')) {
      const q = e.target.value.trim().toLowerCase();
      const list = e.target.closest('.custom-select-options');
      if (!list) return;
      list.querySelectorAll('.custom-select-option').forEach(opt => {
        const text = opt.dataset.search || opt.textContent.toLowerCase();
        opt.style.display = text.includes(q) ? '' : 'none';
      });
      return;
    }
    if (e.target.id === 'productSearch') {
      const list = $('#productList');
      if (list) list.innerHTML = productListHTML(e.target.value);
    }
    if (e.target.id === 'customerSearch') {
      const q = e.target.value.trim().toLowerCase();
      const filtered = customers.filter(c =>
        c.name.toLowerCase().includes(q) || (c.phone || '').includes(q)
      ).sort((a,b) => a.name.localeCompare(b.name));
      const list = $('#customerList');
      if (list) list.innerHTML = filtered.map(c => {
        const bal = customerBalance(c.id, c.name, c.phone);
        const dueHtml = bal.due > 0
          ? `<span class="list-item-badge badge-out">Due ${settings.currency} ${money(bal.due)}</span>`
          : (bal.total > 0 ? `<span class="list-item-badge badge-ok">Clear</span>` : '');
        return `<div class="list-item" data-action="view-customer" data-id="${c.id}">
          <div class="list-item-icon">${initials(c.name)}</div>
          <div class="list-item-body">
            <div class="list-item-title">${escapeHtml(c.name)}</div>
            <div class="list-item-sub">${escapeHtml(c.phone || 'No phone')}</div>
            ${dueHtml}
          </div>
          <div class="list-item-right"><div class="list-item-price">${bal.total ? settings.currency + ' ' + money(bal.total) : '—'}</div></div>
        </div>`;
      }).join('') || '<div class="text-center text-secondary" style="padding:32px 0">No customers found</div>';
    }
  });

  document.addEventListener('change', e => {
    if (e.target.id === 'bulkImportFile') {
      const file = e.target.files && e.target.files[0];
      if (!file) return;
      if (file.size > 5 * 1024 * 1024) { toast('File too large (max 5 MB)'); return; }
      const reader = new FileReader();
      reader.onload = () => openImportPreview(String(reader.result || ''));
      reader.onerror = () => toast('Could not read the file');
      reader.readAsText(file, 'utf-8');
    } else if (e.target.id === 'importUpdateStock' && pendingImportText) {
      renderImportPreview(e.target.checked);
    }
  });

  $('#backBtn').addEventListener('click', () => {
    if (previousView && previousView !== currentView) setView(previousView);
    else setView('more');
  });


  // ---------- Cloud sync (record-level, last-write-wins) ----------
  let _syncAgain = false;

  function emptyRemote(shop) {
    const r = { shop: shop || null };
    SYNC_COLLECTIONS.forEach(n => { r[DB_TABLE[n] || n] = { live: [], tombs: {} }; });
    return r;
  }

  // Merge one collection with what the cloud has. Pure + synchronous, so nothing the
  // user does can slip in between "read local" and "write local".
  function mergeCollection(name, remote) {
    const local = getList(name);
    const myTombs = tombs[name] || {};
    const rMap = new Map(remote.live.map(r => [r.id, r]));
    const seen = new Set();
    const out = [];
    const push = [];
    local.forEach(l => {
      seen.add(l.id);
      const rt = remote.tombs[l.id];
      if (rt) {
        if (ts(rt) >= ts(l.updatedAt)) return;       // deleted on another device -> drop here too
        out.push(l); push.push(l);                    // edited after that delete -> keep + restore
        return;
      }
      const r = rMap.get(l.id);
      if (!r) { out.push(l); push.push(l); return; }  // not in cloud yet
      if (ts(l.updatedAt) > ts(r.updatedAt)) { out.push(l); push.push(l); }
      else out.push(Object.assign({}, l, r));         // cloud copy is newer (or same)
    });
    remote.live.forEach(r => {
      if (!seen.has(r.id) && !myTombs[r.id]) out.push(r);   // new from another device
    });
    return { list: out, push };
  }

  function mergeSettings(remoteSettings) {
    const r = (remoteSettings && typeof remoteSettings === 'object') ? remoteSettings : {};
    const rt = ts(r.updatedAt), lt = ts(settings.updatedAt);
    if (rt > lt) { settings = Object.assign({}, settings, r); return null; }
    if (lt > rt) return settings;
    return null;
  }

  function canRenderNow() {
    const modal = $('#modalRoot');
    return currentView !== 'create-invoice' && !(modal && modal.innerHTML.trim());
  }

  async function doCloudSync(opts = {}) {
    const silent = !!opts.silent;
    if (!window.HisablyCloud || !HisablyCloud.ready()) {
      if (!silent) toast('Online features are not available right now. Please try again later.');
      return false;
    }
    if (!HisablyCloud.getSession()) {
      if (!silent) toast('Sign in first (More → Cloud account)');
      return false;
    }
    if (!navigator.onLine) {
      if (!silent) toast('You are offline – changes are saved on this phone and will sync later');
      return false;
    }
    if (_cloudSyncing) { _syncAgain = true; return false; }
    _cloudSyncing = true;
    let ok = false;
    try {
      if (!silent) toast('Syncing…');
      let remote = await HisablyCloud.fetchRemote();      // throws if ANY read fails -> local data untouched
      if (localStorage.getItem(LEGACY_FLAG)) {
        await HisablyCloud.wipeRemoteData();               // one-time: v1 left random-id copies in the cloud
        remote = emptyRemote(remote.shop);
      }

      // ---- merge (synchronous) ----
      const changes = { tombs: JSON.parse(JSON.stringify(tombs)) };
      SYNC_COLLECTIONS.forEach(n => {
        const m = mergeCollection(n, remote[DB_TABLE[n] || n] || { live: [], tombs: {} });
        setList(n, m.list);
        changes[n] = m.push;
      });
      const sPush = mergeSettings(remote.shop && remote.shop.settings);
      if (sPush) changes.settings = sPush;
      normalizeData();
      invoices.sort((a, b) => ts(b.date) - ts(a.date));
      stockMovements.sort((a, b) => ts(b.date) - ts(a.date));
      resnap();                         // merged state is the new baseline (no re-stamping)
      saveAll();
      if (remote.shop) applyShopToPlan(remote.shop);
      if (canRenderNow()) render();

      // ---- push only what changed ----
      await HisablyCloud.push(changes);
      SYNC_COLLECTIONS.forEach(n => {
        Object.keys(changes.tombs[n] || {}).forEach(id => { if (tombs[n]) delete tombs[n][id]; });
      });
      save(STORAGE.tombs, tombs);
      localStorage.removeItem(LEGACY_FLAG);
      localStorage.setItem('hisably_last_sync', new Date().toISOString());
      ok = true;
      if (!silent) toast('Synced');
      if (typeof maybeShopifySync === 'function' && !opts.noShopify) setTimeout(() => { maybeShopifySync().catch(() => {}); }, 50);
    } catch (err) {
      console.error('sync', err);
      const msg = String((err && err.message) || 'Sync failed').replace(/^LIMIT:\s*/, '');
      if (!silent || /free plan|inactive/i.test(msg)) toast(msg, 4000);
    } finally {
      _cloudSyncing = false;
      if (_syncAgain) { _syncAgain = false; scheduleCloudPush(); }
    }
    return ok;
  }

  async function initCloudAutoSync() {
    if (!window.HisablyCloud || !HisablyCloud.ready()) return;
    try {
      await HisablyCloud.init();
      const sess = HisablyFreemium.getSession();
      if (!HisablyCloud.getSession()) {
        if (sess && sess.mode === 'cloud' && navigator.onLine) {
          toast('Cloud session expired – sign in again (More → Cloud account)', 5000);
        }
        return;
      }
      await refreshPlanFromCloud();
      await doCloudSync({ silent: true });
      // Quiet sync every 5 minutes, when the app returns to the foreground, and when back online
      let tick = 0;
      setInterval(() => { tick++; if (!document.hidden && (shopifyOn() || tick % 5 === 0)) doCloudSync({ silent: true }); }, 60 * 1000);
      document.addEventListener('visibilitychange', () => {
        if (!document.hidden) doCloudSync({ silent: true });
      });
      window.addEventListener('online', () => doCloudSync({ silent: true }));
    } catch (err) {
      console.error('Cloud init', err);
    }
  }

  // Local data belongs to ONE account. If someone else signs in on this phone,
  // start clean so one shop's data can never be uploaded into another shop.
  function wipeLocalData() {
    products = []; invoices = []; customers = []; suppliers = []; expenses = []; stockMovements = []; purchases = [];
    settings = defaultSettings();
    invoiceCounter = 1001;
    tombs = {};
    localStorage.removeItem(LEGACY_FLAG);
    localStorage.removeItem('hisably_last_sync');
    HisablyFreemium.clearPlanCache();
    resnap();
    saveAll();
  }
  function claimDataFor(email) {
    const id = (email || '').trim().toLowerCase();
    const owner = localStorage.getItem(OWNER_KEY);
    if (owner && owner !== id) wipeLocalData();
    localStorage.setItem(OWNER_KEY, id);
  }

  async function signOutUser() {
    toast('Signing out…');
    try {
      if (window.HisablyCloud && HisablyCloud.ready() && HisablyCloud.getSession()) {
        // last chance to upload unsynced work (max 4s so sign-out never hangs offline)
        await Promise.race([doCloudSync({ silent: true }), new Promise(r => setTimeout(r, 4000))]);
        await HisablyCloud.signOut();
      }
    } catch (e) { console.error(e); }
    HisablyFreemium.clearSession();
    location.reload();
  }

  async function submitPayment() {
    const plan = ($('#paidPlanSelect') || {}).value || 'basic';
    const note = (($('#paidNote') || {}).value || '').trim();
    const sess = HisablyFreemium.getSession() || {};
    const shopName = sess.shopName || settings.businessName;
    if (!note) { toast('Enter your transaction ID or the phone number you paid from'); return; }
    if (window.HisablyCloud && HisablyCloud.ready() && HisablyCloud.getSession()) {
      try {
        await HisablyCloud.submitPaymentRequest({ planId: plan, note, shopName });
      } catch (err) {
        toast(err.message || 'Could not send. Check your internet and try again.', 4000);
        return;
      }
    } else {
      // Not connected to the cloud: keep it on this device only (testing)
      const key = 'hisably_payment_requests_v1';
      const list = JSON.parse(localStorage.getItem(key) || '[]');
      list.unshift({ id: uid(), email: sess.email, shopName, plan, note, status: 'pending', createdAt: new Date().toISOString() });
      localStorage.setItem(key, JSON.stringify(list));
    }
    toast('Payment reported. Admin will activate your plan.', 3500);
    closeModal();
  }

  function openCloudAuthModal() {
    if (!window.HisablyCloud || !HisablyCloud.ready()) {
      toast('Cloud is not set up for this app');
      return;
    }
    const signed = HisablyCloud.getSession();
    $('#modalRoot').innerHTML = `
      <div class="modal-overlay">
        <div class="modal-sheet">
          <div class="modal-handle"></div>
          <div class="modal-header">
            <h3 class="modal-title">Cloud account</h3>
            <button class="modal-close" data-action="close-modal"><svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg></button>
          </div>
          ${signed ? `
            <p class="text-sm text-secondary mb-8">Signed in as <strong>${escapeHtml((signed.user && signed.user.email) || '')}</strong>. Auto-sync is <strong>on</strong>.</p>
            <p class="text-sm text-secondary mb-16">Changes upload a few seconds after you edit, and other devices' changes are merged in. It also works offline – everything syncs when you are back online.${lastSyncLabel()}</p>
            <button class="btn btn-primary btn-block" data-action="cloud-sync">Sync now</button>
          ` : `
            <p class="text-sm text-secondary mb-12">Your cloud session expired. Sign in again to keep syncing. Your data on this phone is safe.</p>
            <div class="form-group"><label class="form-label">Email</label><input type="email" class="form-input" id="cloudEmail" value="${escapeHtml((HisablyFreemium.getSession() || {}).email || '')}" /></div>
            <div class="form-group"><label class="form-label">Password</label><input type="password" class="form-input" id="cloudPassword" /></div>
            <button class="btn btn-primary btn-block" data-action="cloud-signin">Sign in</button>
          `}
        </div>
      </div>`;
  }

  // ---------- Auth gate + freemium ----------
  function showAuth() {
    const app = document.getElementById('app');
    const auth = document.getElementById('authScreen');
    if (app) app.hidden = true;
    if (auth) {
      auth.hidden = false;
      auth.innerHTML = renderAuthHTML('login');
    }
  }

  function showAppShell() {
    const app = document.getElementById('app');
    const auth = document.getElementById('authScreen');
    if (auth) auth.hidden = true;
    if (app) app.hidden = false;
  }

  function renderAuthHTML(mode) {
    const isLogin = mode !== 'register';
    return `<div class="auth-card">
      <div class="auth-brand">
        <div class="logo-circle">H</div>
        <h1>Hisably</h1>
        <p>Inventory & invoices for micro sellers</p>
      </div>
      <div class="auth-tabs">
        <button type="button" class="auth-tab ${isLogin ? 'active' : ''}" data-auth-tab="login">Sign in</button>
        <button type="button" class="auth-tab ${!isLogin ? 'active' : ''}" data-auth-tab="register">Sign up</button>
      </div>
      ${(window.HisablyCloud && HisablyCloud.ready()) ? '' : `<div class="auth-msg show error">Sign in and sign up are temporarily unavailable. Please try again later or contact support.</div>`}
      <div id="authMsg" class="auth-msg" role="alert"></div>
      <form id="authForm">
        ${!isLogin ? `<div class="form-group"><label class="form-label">Full name</label><input class="form-input" name="fullName" placeholder="Your name" /></div>
        <div class="form-group"><label class="form-label">Shop name</label><input class="form-input" name="shopName" placeholder="Business name" /></div>
        <div class="form-group"><label class="form-label">Phone</label><input class="form-input" name="phone" type="tel" placeholder="03XX..." /></div>` : ''}
        <div class="form-group"><label class="form-label">Email</label><input class="form-input" name="email" type="email" required placeholder="you@email.com" /></div>
        <div class="form-group"><label class="form-label">Password</label><input class="form-input" name="password" type="password" required minlength="6" placeholder="Min 6 characters" /></div>
        <button type="submit" class="btn btn-primary btn-block">${isLogin ? 'Sign in' : 'Create free account'}</button>
      </form>
      <p class="auth-hint">Sign up creates a cloud account (trial). After login the app works offline and syncs when online. Local-only signup is disabled.</p>
    </div>`;
  }

  function bindAuthScreen() {
    const auth = document.getElementById('authScreen');
    if (!auth) return;
    auth.onclick = (e) => {
      const tab = e.target.closest('[data-auth-tab]');
      if (tab) {
        auth.innerHTML = renderAuthHTML(tab.dataset.authTab);
        bindAuthForm();
      }
    };
    bindAuthForm();
  }

  // Show messages on the sign-in card itself (always visible) AND as a toast
  function authSay(msg, kind) {
    toast(msg, 5000);
    const el = document.getElementById('authMsg');
    if (el) { el.textContent = msg; el.className = 'auth-msg show ' + (kind || 'info'); }
  }

  function bindAuthForm() {
    const form = document.getElementById('authForm');
    if (!form) return;
    form.onsubmit = async (e) => {
      e.preventDefault();
      const fd = new FormData(form);
      const email = (fd.get('email') || '').trim().toLowerCase();
      const password = fd.get('password') || '';
      const fullName = (fd.get('fullName') || '').trim();
      const shopName = (fd.get('shopName') || '').trim();
      const phone = (fd.get('phone') || '').trim();
      const isRegister = !!form.querySelector('[name="fullName"]');
      const btn = form.querySelector('button[type="submit"]');
      if (btn) btn.disabled = true;
      try {
        const cloudReady = window.HisablyCloud && HisablyCloud.ready();
        // Local signup is disabled — accounts must be created via cloud (Supabase)
        if (isRegister && !cloudReady) {
          authSay('Sign up is temporarily unavailable. Please try again later or contact support.', 'error');
          return;
        }
        if (isRegister && (!fullName || !shopName)) {
          authSay('Please enter your name and shop name', 'error');
          return;
        }
        authSay(isRegister ? 'Creating account…' : 'Signing in…', 'info');
        let profShopName = shopName;
        if (cloudReady) {
          if (isRegister) {
            const res = await HisablyCloud.signUp({ email, password, fullName, shopName, phone });
            if (res.needsConfirm) {
              const auth = document.getElementById('authScreen');
              auth.innerHTML = renderAuthHTML('login');
              bindAuthForm();
              authSay('Account created! Open the confirmation email we sent, then sign in.', 'ok');
              return;
            }
          } else {
            await HisablyCloud.signIn(email, password);
          }
          claimDataFor(email);
          const prof = HisablyCloud.getProfile() || {};
          profShopName = (prof.shops && prof.shops.name) || shopName || 'My Shop';
          HisablyFreemium.setSession({
            email,
            fullName: prof.full_name || fullName || email,
            shopName: profShopName,
            phone: prof.phone || phone,
            mode: 'cloud'
          });
          await refreshPlanFromCloud();
        } else {
          // Sign-in only for existing local accounts (no new local signup)
          HisablyFreemium.localSignIn(email, password);
          claimDataFor(email);
        }
        if (settings.businessName === 'My Business' && profShopName && profShopName !== 'My Shop') {
          settings.businessName = profShopName;
          const s = HisablyFreemium.getSession() || {};
          settings.ownerName = settings.ownerName || s.fullName || '';
          settings.phone = settings.phone || s.phone || '';
          persist();
        }
        enterApp();
        toast(isRegister ? 'Welcome! 14-day trial started' : 'Welcome back');
      } catch (err) {
        console.error(err);
        const m = String((err && err.message) || 'Auth failed');
        authSay(/invalid login/i.test(m) ? 'Wrong email or password' : /confirm/i.test(m) ? 'Please confirm your email first, then sign in' : /failed to fetch|network/i.test(m) ? 'No internet connection or server unreachable. Check your connection and try again.' : friendlyMsg(m), 'error');
      } finally {
        if (btn) btn.disabled = false;
      }
    };
  }

  // Pull plan + payment details + server clock from the cloud into the offline cache
  function applyShopToPlan(shop, plat, offsetMs) {
    const patch = {};
    if (shop) {
      Object.assign(patch, {
        planId: shop.plan_id || 'free',
        status: shop.status || 'trial',
        trialEndsAt: shop.trial_ends_at || null,
        paidUntil: shop.paid_until || null,
        shopId: shop.id
      });
    }
    if (typeof offsetMs === 'number' && isFinite(offsetMs)) patch.serverOffsetMs = offsetMs;
    if (plat) {
      patch.freemiumEnabled = plat.freemium_enabled !== false;
      patch.payment = Object.assign({}, HisablyFreemium.DEFAULT_PAY, {
        jazzcash: plat.jazzcash || '',
        easypaisa: plat.easypaisa || '',
        bankName: plat.bank_name || '',
        bankAccount: plat.bank_account || '',
        bankTitle: plat.bank_title || '',
        note: plat.payment_note || HisablyFreemium.DEFAULT_PAY.note,
        basicPrice: Number(plat.basic_price) || HisablyFreemium.DEFAULT_PAY.basicPrice,
        proPrice: Number(plat.pro_price) || HisablyFreemium.DEFAULT_PAY.proPrice,
        lifetimePrice: Number(plat.lifetime_price) || HisablyFreemium.DEFAULT_PAY.lifetimePrice,
        currency: plat.currency || 'PKR'
      });
    }
    HisablyFreemium.setPlanCache(patch);
  }

  async function refreshPlanFromCloud() {
    try {
      if (window.HisablyCloud && HisablyCloud.ready() && HisablyCloud.getSession()) {
        const [shop, plat, offset] = await Promise.all([
          HisablyCloud.fetchShop(),
          HisablyCloud.fetchPlatformSettings().catch(() => null),
          HisablyCloud.serverOffsetMs().catch(() => undefined)
        ]);
        applyShopToPlan(shop, plat, offset);
        if (currentView === 'dashboard' && canRenderNow()) render();
      }
    } catch (e) {
      console.error('plan refresh', e);
      // Don't silently show "Free": tell the user their plan could not be loaded
      if (navigator.onLine) toast('Could not load your plan. Check your internet connection, then reopen the app.', 6000);
    }
  }

  function planBannerHTML() {
    const { key, limits, cache } = HisablyFreemium.effectivePlan();
    if (key === 'pro' || key === 'basic' || key === 'trial') {
      if (key === 'trial' && cache.trialEndsAt) {
        const days = Math.max(0, Math.ceil((new Date(cache.trialEndsAt) - new Date()) / 86400000));
        return `<div class="plan-banner"><strong>Trial:</strong> ${days} day(s) left · full access. <button type="button" class="linkish" data-action="open-plans">View plans</button></div>`;
      }
      return '';
    }
    if (key === 'blocked') {
      return `<div class="plan-banner" style="background:#FEE2E2;border-color:#EF4444;color:#991B1B"><strong>Account inactive.</strong> <button type="button" class="linkish" data-action="open-plans">Upgrade / pay</button></div>`;
    }
    return `<div class="plan-banner"><strong>Free plan:</strong> ${limits.products} products · ${limits.invoices} invoices · ${limits.customers} customers. <button type="button" class="linkish" data-action="open-plans">Upgrade</button></div>`;
  }


  // ---------- Shopify store connection (Pro) ----------
  const SHOPIFY_FLAG = 'hisably_shopify_on';
  let _shopifySyncing = false, _shopifyLast = 0;

  function shopifyOn() { try { return localStorage.getItem(SHOPIFY_FLAG) === '1'; } catch (e) { return false; } }
  function setShopifyOn(v) { try { v ? localStorage.setItem(SHOPIFY_FLAG, '1') : localStorage.removeItem(SHOPIFY_FLAG); } catch (e) {} }

  // After the normal cloud sync: let the server exchange price / stock / orders with Shopify,
  // then pull whatever it changed.
  async function maybeShopifySync(force) {
    if (!shopifyOn() || _shopifySyncing) return null;
    if (!window.HisablyCloud || !HisablyCloud.getSession() || !navigator.onLine) return null;
    if (!HisablyFreemium.hasFeature('shopify')) return null;
    if (!force && Date.now() - _shopifyLast < 60000) return null;
    _shopifySyncing = true;
    try {
      const r = await HisablyCloud.shopifyCall('sync', {});
      _shopifyLast = Date.now();
      if (r && r.changed) await doCloudSync({ silent: true });
      return r;
    } catch (e) {
      console.error('shopify sync', e);
      if (e && (e.status === 402 || e.status === 400)) toast(e.message, 5000);
      throw e;
    } finally { _shopifySyncing = false; }
  }

  function shopifyBusy(msg) {
    $('#modalRoot').innerHTML = `<div class="modal-overlay"><div class="modal-sheet"><div class="modal-handle"></div>
      <p class="text-secondary" style="text-align:center;padding:30px 0">${escapeHtml(msg)}</p></div></div>`;
  }

  async function openShopifyModal() {
    if (!window.HisablyCloud || !HisablyCloud.ready() || !HisablyCloud.getSession()) { toast('Sign in to your cloud account first'); return; }
    if (!HisablyFreemium.hasFeature('shopify')) {
      toast('Shopify connection is a Pro feature. Upgrade to Pro or Lifetime.', 4500);
      openPlansModal();
      return;
    }
    shopifyBusy('Loading…');
    let st;
    try { st = await HisablyCloud.shopifyCall('status', {}); }
    catch (e) { closeModal(); toast(e.message, 5500); return; }
    setShopifyOn(!!st.connected);
    renderShopifyModal(st);
  }

  function renderShopifyModal(st) {
    const head = `<div class="modal-header"><h3 class="modal-title">Shopify store</h3>
      <button class="modal-close" data-action="close-modal"><svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg></button></div>`;
    if (st.connected) {
      const when = (d) => d ? formatDate(d) + ' ' + new Date(d).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) : '—';
      $('#modalRoot').innerHTML = `<div class="modal-overlay"><div class="modal-sheet"><div class="modal-handle"></div>${head}
        <div class="card mb-12" style="padding:14px">
          <div class="font-semibold">${escapeHtml(st.domain)}</div>
          <div class="text-sm" style="color:var(--success);margin-top:4px">● Connected</div>
          <div class="text-sm text-secondary mt-8">Last sync: ${escapeHtml(when(st.last_push_at || st.last_pull_at))}</div>
          ${st.last_error ? `<div class="text-sm mt-8" style="color:var(--danger)">The last sync had a problem. Tap “Sync now” to retry. If it keeps happening, check that your Shopify app still has the permissions listed below, or contact support.</div>` : ''}
        </div>
        ${(st.locations || []).length > 1 ? `<div class="form-group"><label class="form-label">Stock location (stock is synced for this one)</label>
          <select class="form-input" id="shopifyLoc">${st.locations.map(l => `<option value="${escapeHtml(l.id)}" ${l.id === st.location_id ? 'selected' : ''}>${escapeHtml(l.name)}</option>`).join('')}</select></div>`
          : `<div class="text-sm text-secondary mb-12">Stock location: <strong>${escapeHtml(st.location_name || '—')}</strong></div>`}
        <ul class="text-sm text-secondary mb-12" style="padding-left:18px;line-height:1.6">
          <li>Shopify products, prices and stock appear in Hisably automatically.</li>
          <li>Price / stock changes you make in Hisably are sent to Shopify.</li>
          <li>Online orders become invoices (<strong>SHP-…</strong>); customers are added.</li>
        </ul>
        <button class="btn btn-primary btn-block" data-action="shopify-sync">Sync now</button>
        <button class="btn btn-secondary btn-block mt-8" data-action="shopify-full">Re-import everything from Shopify</button>
        <button class="btn btn-ghost btn-block mt-8" style="color:var(--danger)" data-action="shopify-disconnect">Disconnect store</button>
      </div></div>`;
      const loc = document.getElementById('shopifyLoc');
      if (loc) loc.addEventListener('change', async () => {
        shopifyBusy('Changing location and re-syncing stock…');
        try { await HisablyCloud.shopifyCall('set_location', { locationId: loc.value }); await doCloudSync({ silent: true }); toast('Location updated'); }
        catch (e) { toast(e.message, 5000); }
        openShopifyModal();
      });
      return;
    }
    $('#modalRoot').innerHTML = `<div class="modal-overlay"><div class="modal-sheet"><div class="modal-handle"></div>${head}
      <p class="text-sm text-secondary mb-12">Connect your Shopify store: products, prices, stock, customers and online orders flow into Hisably, and your price / stock changes flow back.</p>
      <details class="help-box"><summary>How do I get these details?</summary>
        <div class="text-sm">
          <p><strong>Your store address</strong> is the one that ends with <em>.myshopify.com</em> (Shopify admin → Settings → Domains).</p>
          <p><strong>Option 1 – new Shopify apps (Dev Dashboard)</strong></p>
          <ol>
            <li>Go to <strong>dev.shopify.com</strong> and sign in with the store owner account.</li>
            <li>Create an app named <em>Hisably</em>.</li>
            <li>Give it these permissions: read &amp; write <em>products</em> and <em>inventory</em>; read <em>orders</em>, <em>customers</em> and <em>locations</em>.</li>
            <li>Release it and <strong>install it on your store</strong>.</li>
            <li>Open the app’s Settings, copy the <strong>Client ID</strong> and <strong>Client secret</strong> and paste them below.</li>
          </ol>
          <p><strong>Option 2 – older custom app</strong></p>
          <ol>
            <li>Shopify admin → Settings → Apps and sales channels → <strong>Develop apps</strong> → create an app.</li>
            <li>Give it the same permissions as above and install it.</li>
            <li>Copy the <strong>Admin API access token</strong> (starts with <em>shpat_</em>, shown only once) and the <strong>API secret key</strong>, and paste them below.</li>
          </ol>
          <p>Tip: try it first with one test product. Your existing Hisably products are matched by barcode/SKU or name, so nothing is duplicated.</p>
        </div>
      </details>
      <form id="shopifyForm" autocomplete="off">
        <div class="form-group"><label class="form-label">Store address</label>
          <input class="form-input" name="domain" placeholder="mystore.myshopify.com" autocapitalize="none" required /></div>
        <div class="form-group"><label class="form-label">Admin API access token <span class="text-secondary">(starts with shpat_)</span></label>
          <input class="form-input" name="accessToken" placeholder="shpat_…" autocapitalize="none" /></div>
        <p class="text-sm text-secondary mb-8" style="text-align:center">— or, for apps made in the Dev Dashboard —</p>
        <div class="form-row">
          <div class="form-group"><label class="form-label">Client ID</label><input class="form-input" name="clientId" autocapitalize="none" /></div>
          <div class="form-group"><label class="form-label">Client secret</label><input class="form-input" name="clientSecret" type="password" autocapitalize="none" /></div>
        </div>
        <div class="form-group"><label class="form-label">API secret key <span class="text-secondary">(verifies Shopify messages; leave empty if you used Client secret)</span></label>
          <input class="form-input" name="apiSecret" type="password" autocapitalize="none" /></div>
        <button type="submit" class="btn btn-primary btn-block" id="shopifyConnectBtn">Connect &amp; import</button>
        <p class="text-sm text-secondary mt-8">The first import can take a minute for big stores. Existing Hisably products are matched by barcode/SKU or name instead of duplicated.</p>
      </form></div></div>`;
    document.getElementById('shopifyForm').addEventListener('submit', async (e) => {
      e.preventDefault();
      const fd = new FormData(e.target);
      const btn = document.getElementById('shopifyConnectBtn');
      btn.disabled = true; btn.textContent = 'Connecting… please wait';
      try {
        const payload = {};
        ['domain', 'accessToken', 'clientId', 'clientSecret', 'apiSecret'].forEach(k => { payload[k] = (fd.get(k) || '').trim(); });
        const r = await HisablyCloud.shopifyCall('connect', payload);
        setShopifyOn(true);
        const p = r.products || {};
        toast(`Connected to ${r.shopName || 'Shopify'} · ${p.added || 0} products added`, 5000);
        await doCloudSync({ silent: true });
        openShopifyModal();
      } catch (err) {
        btn.disabled = false; btn.textContent = 'Connect & import';
        toast(err.message, 6500);
      }
    });
  }

  async function shopifyManualSync(full) {
    shopifyBusy(full ? 'Re-importing from Shopify…' : 'Syncing with Shopify…');
    try {
      await doCloudSync({ silent: true });
      const r = await HisablyCloud.shopifyCall('sync', { full: !!full });
      _shopifyLast = Date.now();
      await doCloudSync({ silent: true });
      const p = r.products || {}, o = r.orders || {};
      toast(`Synced · ${p.added || 0} new, ${p.updated || 0} updated products · ${o.added || 0} new orders`, 4500);
    } catch (e) { toast(e.message, 6000); }
    openShopifyModal();
  }

  function needPro(what) {
    if (HisablyFreemium.hasFeature('bulkTools')) return true;
    toast(what + ' is a Pro feature. Upgrade to Pro to use it.', 4500);
    openPlansModal && openPlansModal();
    return false;
  }

  function enforceLimit(type, count) {
    const r = HisablyFreemium.canAdd(type, count);
    if (!r.ok) {
      toast(r.reason);
      openPlansModal();
      return false;
    }
    return true;
  }

  function openPlansModal() {
    const pay = HisablyFreemium.getPlanCache().payment || HisablyFreemium.DEFAULT_PAY;
    const { key, cache } = HisablyFreemium.effectivePlan();
    $('#modalRoot').innerHTML = `
      <div class="modal-overlay">
        <div class="modal-sheet">
          <div class="modal-handle"></div>
          <div class="modal-header">
            <h3 class="modal-title">Plans & payment</h3>
            <button class="modal-close" data-action="close-modal"><svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg></button>
          </div>
          <p class="text-sm text-secondary mb-12">Current: <strong>${escapeHtml(cache.planId === 'lifetime' && cache.status === 'active' ? 'lifetime' : key)}</strong>${cache.status ? ' · ' + escapeHtml(cache.status) : ''}${cache.paidUntil && key !== 'free' && cache.planId !== 'lifetime' ? ' · paid until ' + formatDate(cache.paidUntil) : ''}</p>
          <div class="card mb-12" style="padding:14px">
            <div class="font-semibold">Free</div>
            <div class="text-sm text-secondary">25 products · 40 invoices · 20 customers</div>
            <div class="text-sm" style="color:var(--primary);margin-top:4px">${pay.currency} 0 / month</div>
          </div>
          <div class="card mb-12" style="padding:14px;border-color:var(--primary)">
            <div class="font-semibold">Basic</div>
            <div class="text-sm text-secondary">300 products · 1,500 invoices · 200 customers · cloud sync · payment QR on invoices</div>
            <div class="text-sm" style="color:var(--primary);margin-top:4px;font-weight:700">${escapeHtml(pay.currency)} ${escapeHtml(pay.basicPrice)} / month</div>
          </div>
          <div class="card mb-16" style="padding:14px">
            <div class="font-semibold">Pro</div>
            <div class="text-sm text-secondary">Unlimited everything · bulk import &amp; bulk price change · Shopify store connection · priority support</div>
            <div class="text-sm" style="color:var(--primary);margin-top:4px;font-weight:700">${pay.currency} ${pay.proPrice} / month</div>
          </div>
          <div class="card mb-16" style="padding:14px;border-color:#F59E0B;background:#FFFBEB">
            <div class="font-semibold">Lifetime <span style="font-size:11px;background:#F59E0B;color:#fff;border-radius:6px;padding:2px 6px;margin-left:4px">BEST VALUE</span></div>
            <div class="text-sm text-secondary">All Pro features forever · pay once, no monthly renewal</div>
            <div class="text-sm" style="color:var(--primary);margin-top:4px;font-weight:700">${escapeHtml(pay.currency)} ${escapeHtml(pay.lifetimePrice || 14999)} one-time</div>
          </div>
          <div class="section-header"><h2 class="section-title">Pay to upgrade</h2></div>
          <div class="text-sm mb-8">JazzCash: <strong>${escapeHtml(pay.jazzcash || '—')}</strong></div>
          <div class="text-sm mb-8">EasyPaisa: <strong>${escapeHtml(pay.easypaisa || '—')}</strong></div>
          ${pay.bankAccount ? `<div class="text-sm mb-8">Bank: ${escapeHtml(pay.bankName || '')} · ${escapeHtml(pay.bankAccount)} · ${escapeHtml(pay.bankTitle || '')}</div>` : ''}
          <p class="text-sm text-secondary mb-12">${escapeHtml(pay.note || '')}</p>
          <div class="form-group">
            <label class="form-label">Plan you paid for</label>
            <select class="form-input" id="paidPlanSelect">
              <option value="basic">Basic (${pay.currency} ${pay.basicPrice})</option>
              <option value="pro">Pro (${pay.currency} ${pay.proPrice})</option>
              <option value="lifetime">Lifetime (${pay.currency} ${pay.lifetimePrice || 14999})</option>
            </select>
          </div>
          <div class="form-group">
            <label class="form-label">Your phone / txn note</label>
            <input class="form-input" id="paidNote" placeholder="Txn ID or phone used to pay" />
          </div>
          <div id="payReqStatus" class="text-sm text-secondary mb-8"></div>
          <button class="btn btn-primary btn-block" data-action="submit-payment">I paid – notify admin</button>
        </div>
      </div>`;
    if (window.HisablyCloud && HisablyCloud.ready() && HisablyCloud.getSession()) {
      HisablyCloud.latestPaymentRequest().then(r => {
        const el = document.getElementById('payReqStatus');
        if (!el || !r) return;
        const label = { pending: 'Pending – admin will review it soon', approved: 'Approved', rejected: 'Rejected – contact support' }[r.status] || r.status;
        el.innerHTML = `Last request (${escapeHtml(r.plan_id || '')}): <strong>${escapeHtml(label)}</strong>`;
      }).catch(() => {});
    }
  }

  function enterApp() {
    showAppShell();
    if (lockEnabled() && !getRole()) showLock();
    migrateData();
    // Cloud mode gets payment details from the database; this same-browser shortcut is for local testing only
    try {
      const pay = (window.HisablyCloud && HisablyCloud.ready()) ? null : JSON.parse(localStorage.getItem('hisably_platform_pay_v1') || 'null');
      if (pay) {
        HisablyFreemium.setPlanCache({
          payment: Object.assign({}, HisablyFreemium.DEFAULT_PAY, pay),
          freemiumEnabled: pay.freemiumEnabled !== false
        });
      }
    } catch (e) {}
    setView('dashboard');
    initCloudAutoSync();
    startPlanHeartbeat();
  }

  let _planHeartbeat = null;
  function startPlanHeartbeat() {
    if (_planHeartbeat) clearInterval(_planHeartbeat);
    // When online, refresh plan every 10 minutes
    _planHeartbeat = setInterval(() => {
      if (navigator.onLine) refreshPlanFromCloud();
    }, 10 * 60 * 1000);
    if (!startPlanHeartbeat._bound) {
      startPlanHeartbeat._bound = true;
      window.addEventListener('online', () => refreshPlanFromCloud());
    }
  }

  // Init
  migrateData();
  if (!window.HisablyFreemium || !HisablyFreemium.isLoggedIn()) {
    showAuth();
    bindAuthScreen();
  } else {
    enterApp();
  }

  // PWA install prompt (hidden once installed; "✕" is remembered for 7 days)
  let deferredInstall = null;
  const INSTALL_DISMISS_KEY = 'hisably_install_dismissed';
  function hideInstallBanner(remember) {
    const ban = document.getElementById('installBanner');
    if (ban) { ban.hidden = true; ban.style.display = 'none'; }
    if (remember) { try { localStorage.setItem(INSTALL_DISMISS_KEY, String(Date.now())); } catch (e) {} }
  }
  function installDismissedRecently() {
    try { return Date.now() - Number(localStorage.getItem(INSTALL_DISMISS_KEY) || 0) < 7 * 864e5; } catch (e) { return false; }
  }
  const isStandalone = (window.matchMedia && window.matchMedia('(display-mode: standalone)').matches) || window.navigator.standalone === true;
  if (isStandalone) hideInstallBanner(false);
  window.addEventListener('beforeinstallprompt', (e) => {
    e.preventDefault();
    deferredInstall = e;
    if (isStandalone || installDismissedRecently()) return;
    const ban = document.getElementById('installBanner');
    if (ban) { ban.style.display = ''; ban.hidden = false; }
  });
  window.addEventListener('appinstalled', () => { deferredInstall = null; hideInstallBanner(false); });
  document.getElementById('installBtn')?.addEventListener('click', async () => {
    if (!deferredInstall) { hideInstallBanner(false); return; }
    deferredInstall.prompt();
    try { await deferredInstall.userChoice; } catch (e) {}
    deferredInstall = null;
    hideInstallBanner(false);
  });
  document.getElementById('installDismiss')?.addEventListener('click', () => hideInstallBanner(true));
})();
