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
    settings: 'sb_settings_v2',
    counter: 'sb_counter_v2',
    tombs: 'sb_tombstones_v3'      // ids deleted locally, waiting to be deleted in the cloud
  };
  const OWNER_KEY = 'hisably_data_owner_v1';        // which account the local data belongs to
  const LEGACY_FLAG = 'sb_legacy_reset_pending';    // v1 -> v2 id migration needs a clean cloud
  const SYNC_COLLECTIONS = ['products', 'customers', 'suppliers', 'invoices', 'expenses', 'stockMovements'];
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
      lowStockDefault: 5,
      logo: '',
      paymentQr: '',
      paymentNote: 'Pay via JazzCash / EasyPaisa / Bank'
    };
  }
  let settings = Object.assign(defaultSettings(), load(STORAGE.settings, {}));
  let invoiceCounter = load(STORAGE.counter, 1001);
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

  function customerBalance(customerId, customerName, customerPhone) {
    let due = 0, paid = 0, total = 0, count = 0;
    invoices.forEach(inv => {
      if (!invoiceBelongsToCustomer(inv, customerId, customerName, customerPhone)) return;
      total += inv.total || 0;
      paid += inv.paidAmount || 0;
      due += Math.max(0, (inv.total || 0) - (inv.paidAmount || 0));
      count++;
    });
    return { due, paid, total, count };
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
    return { products, customers, suppliers, invoices, expenses, stockMovements }[n];
  }
  function setList(n, list) {
    if (n === 'products') products = list;
    else if (n === 'customers') customers = list;
    else if (n === 'suppliers') suppliers = list;
    else if (n === 'invoices') invoices = list;
    else if (n === 'expenses') expenses = list;
    else if (n === 'stockMovements') stockMovements = list;
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
      i.date = i.date || nowIso;
      i.updatedAt = i.updatedAt || i.date;
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
  function toast(msg, ms = 2500) {
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
    if (!options.keepHistory) previousView = currentView;
    currentView = view;
    $$('.nav-item').forEach(b => b.classList.toggle('active', b.dataset.view === view));
    const showBack = ['customers','suppliers','reports','expenses','stock-history'].includes(view);
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
        right.innerHTML = `<button class="btn btn-secondary btn-sm" data-action="bulk-tools" style="margin-right:8px">Bulk</button><button class="icon-btn" data-action="add-product" aria-label="Add"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2"><line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/></svg></button>`;
        content.innerHTML = viewProducts();
      },
      invoices: () => { title.textContent = 'Invoices'; content.innerHTML = viewInvoices(); },
      'create-invoice': () => { title.textContent = 'New Invoice'; content.innerHTML = viewCreateInvoice(); bindCreateInvoice(); },
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
    const revenue = invoices.reduce((s, i) => s + (i.total || 0), 0);
    const cogs = invoices.reduce((s, inv) => s + inv.items.reduce((a, it) => a + ((it.cost || 0) * it.qty), 0), 0);
    const totalExpenses = expenses.reduce((s, e) => s + (e.amount || 0), 0);
    const profit = revenue - cogs - totalExpenses;
    const receivable = invoices.reduce((s, i) => s + Math.max(0, (i.total || 0) - (i.paidAmount || 0)), 0);
    const recent = [...invoices].sort((a,b) => new Date(b.date) - new Date(a.date)).slice(0, 5);

    return `<div class="fade-in">
      ${typeof planBannerHTML === 'function' ? planBannerHTML() : ''}
      <div class="stats-grid">
        <div class="stat-card"><div class="stat-label">Products</div><div class="stat-value primary">${totalProducts}</div></div>
        <div class="stat-card"><div class="stat-label">Revenue</div><div class="stat-value success">${settings.currency} ${money(revenue)}</div></div>
        <div class="stat-card"><div class="stat-label">Expenses</div><div class="stat-value danger">${settings.currency} ${money(totalExpenses)}</div></div>
        <div class="stat-card"><div class="stat-label">Net Profit</div><div class="stat-value ${profit >= 0 ? 'success' : 'danger'}">${settings.currency} ${money(profit)}</div></div>
      </div>
      <div class="stats-grid" style="margin-top:-8px;margin-bottom:20px;grid-template-columns:repeat(3,1fr)">
        <div class="stat-card"><div class="stat-label">Low Stock</div><div class="stat-value warning">${low}</div></div>
        <div class="stat-card"><div class="stat-label">Out of Stock</div><div class="stat-value danger">${out}</div></div>
        <div class="stat-card"><div class="stat-label">To Receive</div><div class="stat-value ${receivable > 0 ? 'danger' : 'success'}" style="font-size:1rem">${money(receivable)}</div></div>
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
  function viewInvoices() {
    if (invoices.length === 0) {
      return emptyState('invoice', 'No invoices yet', 'Create invoices for customers and track sales.', 'Create Invoice', 'create-invoice');
    }
    const sorted = [...invoices].sort((a,b) => new Date(b.date) - new Date(a.date));
    return `<div class="fade-in"><div class="list">${sorted.map(inv => listInvoice(inv)).join('')}</div></div>`;
  }

  function listInvoice(inv) {
    const status = inv.paymentStatus || 'unpaid';
    const paid = inv.paidAmount || 0;
    let badge = '';
    if (status === 'paid' || paid >= inv.total) {
      badge = '<span class="list-item-badge badge-ok">Paid</span>';
    } else if (status === 'partial' || paid > 0) {
      badge = `<span class="list-item-badge badge-low">Partial · ${settings.currency} ${money(paid)}</span>`;
    } else {
      badge = '<span class="list-item-badge badge-out">Unpaid</span>';
    }
    return `<div class="list-item" data-action="view-invoice" data-id="${inv.id}">
      <div class="list-item-icon">${initials(inv.customerName || 'C')}</div>
      <div class="list-item-body">
        <div class="list-item-title">${escapeHtml(inv.customerName || 'Walk-in Customer')}</div>
        <div class="list-item-sub">#${escapeHtml(inv.number)} · ${formatDate(inv.date)} · ${inv.items.length} item${inv.items.length !== 1 ? 's' : ''}</div>
        ${badge}
      </div>
      <div class="list-item-right"><div class="list-item-price">${settings.currency} ${money(inv.total)}</div></div>
    </div>`;
  }

  // ---------- Create Invoice ----------
  function viewCreateInvoice() {
    if (products.length === 0) {
      return emptyState('box', 'Add products first', 'You need at least one product before creating an invoice.', 'Go to Products', 'products');
    }
    const available = products.filter(p => p.stock > 0);
    const customerOptions = [
      { value: '', label: 'Walk-in Customer' },
      ...customers.map(c => {
        const bal = customerBalance(c.id, c.name, c.phone);
        const debt = bal.due > 0 ? ` · Due ${settings.currency} ${money(bal.due)}` : '';
        return { value: c.id, label: c.name + (c.phone ? ' · ' + c.phone : ' · no phone') + debt };
      })
    ];
    return `<div class="fade-in">
      <form id="invoiceForm">
        <div class="form-group">
          <label class="form-label">Customer (searchable)</label>
          ${customSelect('customerId', customerOptions, '', 'Walk-in Customer', true)}
        </div>
        <div class="form-group">
          <label class="form-label">Or type name</label>
          <input type="text" class="form-input" name="customerName" id="customerNameInput" placeholder="Customer name" />
        </div>
        <div class="form-group">
          <input type="tel" class="form-input" name="customerPhone" id="customerPhoneInput" placeholder="Phone (optional)" />
        </div>

        <div class="section-header mt-16">
          <h2 class="section-title">Products</h2>
        </div>
        <div class="search-wrap mb-8">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="11" cy="11" r="8"/><line x1="21" y1="21" x2="16.65" y2="16.65"/></svg>
          <input type="search" class="search-input" id="invoiceProductSearch" placeholder="Search products..." />
        </div>
        <div class="form-group">
          <div class="input-with-btn">
            <input type="text" class="form-input" id="invoiceBarcodeInput" placeholder="Scan or type barcode" />
            <button type="button" class="btn btn-secondary btn-sm" style="height:48px;padding:0 12px" data-action="scan-invoice-barcode">Scan</button>
          </div>
        </div>
        <div id="invoiceProducts">
          ${available.length === 0 ? '<div class="card text-center text-secondary" style="padding:24px">All products are out of stock</div>' :
            available.map(p => `
              <div class="invoice-product-row" data-id="${p.id}" data-name="${escapeHtml(p.name.toLowerCase())}" data-barcode="${escapeHtml((p.barcode || '').toLowerCase())}">
                <div style="flex:1;min-width:0">
                  <div class="font-semibold">${escapeHtml(p.name)}</div>
                  <div class="text-sm text-secondary">${settings.currency} ${money(p.price)} · Stock: ${p.stock}${p.barcode ? ' · ' + escapeHtml(p.barcode) : ''}</div>
                </div>
                <div class="qty-control">
                  <button type="button" class="qty-btn" data-qty="-1" data-id="${p.id}">−</button>
                  <span class="qty-value" id="qty-${p.id}">0</span>
                  <button type="button" class="qty-btn" data-qty="1" data-id="${p.id}">+</button>
                </div>
              </div>`).join('')}
        </div>
        <div class="invoice-summary" id="invoiceSummary" style="display:none">
          <div class="summary-row total"><span>Total</span><span id="invoiceTotal">${settings.currency} 0</span></div>
        </div>

        <div class="section-header mt-20"><h2 class="section-title">Payment</h2></div>
        <div class="payment-status-row" id="paymentStatusRow">
          <button type="button" class="pay-chip active" data-pay="unpaid">Unpaid</button>
          <button type="button" class="pay-chip" data-pay="partial">Advance</button>
          <button type="button" class="pay-chip" data-pay="paid">Fully Paid</button>
        </div>
        <input type="hidden" name="paymentStatus" id="paymentStatusInput" value="unpaid" />
        <div class="form-group mt-12" id="paidAmountGroup" style="display:none">
          <label class="form-label">Advance / Amount Paid (${settings.currency})</label>
          <input type="number" class="form-input" name="paidAmount" id="paidAmountInput" min="0" step="0.01" placeholder="0" />
        </div>

        <button type="submit" class="btn btn-primary btn-block mt-20" id="createInvoiceBtn" disabled>Create Invoice</button>
      </form>
    </div>`;
  }

  function bindCreateInvoice() {
    const qtyMap = {};
    window._invoiceQtyMap = qtyMap;

    function update() {
      let total = 0, has = false;
      Object.entries(qtyMap).forEach(([id, qty]) => {
        if (qty > 0) {
          has = true;
          const p = products.find(x => x.id === id);
          if (p) total += p.price * qty;
        }
      });
      const sum = $('#invoiceSummary'), tot = $('#invoiceTotal'), btn = $('#createInvoiceBtn');
      if (sum) sum.style.display = has ? 'block' : 'none';
      if (tot) tot.textContent = `${settings.currency} ${money(total)}`;
      if (btn) btn.disabled = !has;
    }
    window._invoiceUpdate = update;

    function setQty(id, q) {
      const p = products.find(x => x.id === id);
      if (!p) return;
      if (q < 0) q = 0;
      if (q > p.stock) { toast('Not enough stock'); q = p.stock; }
      qtyMap[id] = q;
      const el = document.getElementById('qty-' + id);
      if (el) el.textContent = q;
      update();
    }
    window._invoiceSetQty = setQty;

    document.querySelectorAll('#invoiceProducts .qty-btn').forEach(btn => {
      btn.addEventListener('click', (e) => {
        e.preventDefault();
        e.stopPropagation();
        const id = btn.dataset.id;
        const delta = parseInt(btn.dataset.qty, 10);
        setQty(id, (qtyMap[id] || 0) + delta);
      });
    });

    // Payment chips
    document.querySelectorAll('.pay-chip').forEach(chip => {
      chip.addEventListener('click', (e) => {
        e.preventDefault();
        document.querySelectorAll('.pay-chip').forEach(c => c.classList.remove('active'));
        chip.classList.add('active');
        const val = chip.dataset.pay;
        const hidden = $('#paymentStatusInput');
        if (hidden) hidden.value = val;
        const grp = $('#paidAmountGroup');
        if (grp) grp.style.display = val === 'partial' ? 'block' : 'none';
        if (val === 'paid') {
          // will set full amount on submit
        }
      });
    });

    // Product search on invoice
    const pSearch = $('#invoiceProductSearch');
    if (pSearch) {
      pSearch.addEventListener('input', () => {
        const q = pSearch.value.trim().toLowerCase();
        document.querySelectorAll('.invoice-product-row').forEach(row => {
          const name = row.dataset.name || '';
          const barcode = row.dataset.barcode || '';
          row.style.display = (!q || name.includes(q) || barcode.includes(q)) ? '' : 'none';
        });
      });
    }

    // Barcode enter key
    const bcInput = $('#invoiceBarcodeInput');
    if (bcInput) {
      bcInput.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') {
          e.preventDefault();
          addProductByBarcode(bcInput.value.trim());
          bcInput.value = '';
        }
      });
    }

    let submitting = false;
    $('#invoiceForm').addEventListener('submit', e => {
      e.preventDefault();
      if (submitting) return;                       // double-tap guard
      if (typeof enforceLimit === 'function' && !enforceLimit('invoices', invoices.length)) return;
      const fd = new FormData(e.target);

      // 1) Validate everything WITHOUT touching stock or counters
      const items = [];
      const short = [];
      let total = 0;
      Object.entries(qtyMap).forEach(([id, qty]) => {
        if (!(qty > 0)) return;
        const p = products.find(x => x.id === id);
        if (!p) return;
        if (p.stock < qty) { short.push(`${p.name} (only ${p.stock} left)`); return; }
        items.push({ productId: p.id, name: p.name, price: p.price, cost: p.cost || 0, qty });
        total += p.price * qty;
      });
      if (short.length) { toast('Not enough stock: ' + short.join(', '), 4000); return; }
      if (!items.length) { toast('Select at least one product'); return; }
      total = round2(total);

      let paymentStatus = (fd.get('paymentStatus') || $('#paymentStatusInput')?.value || 'unpaid');
      let paidAmount = round2(parseFloat(fd.get('paidAmount')) || 0);
      if (paymentStatus === 'paid') paidAmount = total;
      if (paymentStatus === 'unpaid') paidAmount = 0;
      if (paidAmount > total) paidAmount = total;
      if (paymentStatus === 'partial' && paidAmount <= 0) {
        toast('Enter advance amount');
        return;
      }
      if (paymentStatus === 'partial' && paidAmount >= total) {
        paymentStatus = 'paid';
        paidAmount = total;
      }

      // 2) Commit
      submitting = true;
      const nowIso = new Date().toISOString();
      const invNumber = `${settings.invoicePrefix || 'INV'}-${invoiceCounter++}`;
      items.forEach(it => {
        const p = products.find(x => x.id === it.productId);
        if (p) p.stock -= it.qty;
        stockMovements.unshift({
          id: uid(),
          productId: it.productId,
          productName: it.name,
          type: 'out',
          qty: it.qty,
          date: nowIso,
          note: `Invoice ${invNumber}`
        });
      });

      let customerId = fd.get('customerId') || '';
      let customerName = (fd.get('customerName') || '').trim();
      let customerPhone = (fd.get('customerPhone') || '').trim();
      if (customerId) {
        const c = customers.find(x => x.id === customerId);
        if (c) {
          if (!customerName) customerName = c.name;
          if (!customerPhone) customerPhone = c.phone || '';
        }
      }
      if (!customerName) { customerName = 'Walk-in Customer'; customerId = ''; }

      // Always attach to one customer account when not walk-in
      if (customerName !== 'Walk-in Customer') {
        const c = findOrCreateCustomer(customerName, customerPhone);
        if (c) {
          customerId = c.id;
          customerName = c.name;
          if (!customerPhone) customerPhone = c.phone || '';
        }
      }

      const inv = {
        id: uid(),
        number: invNumber,
        customerId: customerId || null,
        customerName,
        customerPhone,
        items, total,
        paymentStatus,
        paidAmount,
        date: nowIso
      };
      invoices.unshift(inv);
      persist();
      toast(paymentStatus === 'paid' ? 'Invoice created (Paid)' : paymentStatus === 'partial' ? 'Invoice created (Advance recorded)' : 'Invoice created (Unpaid)');
      setView('invoices');          // leaves the filled form behind so it can't be re-submitted
      openInvoiceDetail(inv);
    });
  }

  function addProductByBarcode(code) {
    if (!code) return;
    const p = products.find(x => (x.barcode || '').toLowerCase() === code.toLowerCase());
    if (!p) { toast('Product not found for barcode'); return; }
    if (p.stock <= 0) { toast('Out of stock'); return; }
    const qtyMap = window._invoiceQtyMap || {};
    const cur = qtyMap[p.id] || 0;
    if (cur >= p.stock) { toast('Not enough stock'); return; }
    if (window._invoiceSetQty) window._invoiceSetQty(p.id, cur + 1);
    else toast('Open New Invoice first');
    toast('+1 ' + p.name);
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
            <div class="stat-card"><div class="stat-label">Due / Credit</div><div class="stat-value ${bal.due > 0 ? 'danger' : 'success'}">${settings.currency} ${money(bal.due)}</div></div>
          </div>
          <div class="section-header"><h2 class="section-title">Invoice history</h2></div>
          ${custInvoices.length === 0 ? '<div class="text-secondary text-sm">No invoices yet</div>' :
            `<div class="list">${custInvoices.map(inv => {
              const due = Math.max(0, (inv.total||0) - (inv.paidAmount||0));
              const st = due <= 0 ? 'Paid' : (inv.paidAmount > 0 ? 'Partial' : 'Unpaid');
              return `<div class="list-item" data-action="view-invoice" data-id="${inv.id}">
                <div class="list-item-body">
                  <div class="list-item-title">${escapeHtml(inv.number)}</div>
                  <div class="list-item-sub">${formatDate(inv.date)} · ${st}</div>
                </div>
                <div class="list-item-right">
                  <div class="list-item-price">${settings.currency} ${money(inv.total)}</div>
                  ${due > 0 ? `<span class="list-item-badge badge-out">Due ${money(due)}</span>` : `<span class="list-item-badge badge-ok">Paid</span>`}
                </div>
              </div>`;
            }).join('')}</div>`}
          <div class="flex gap-12 mt-20">
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
      <div class="list-item" data-action="edit-supplier" data-id="${s.id}">
        <div class="list-item-icon">${initials(s.name)}</div>
        <div class="list-item-body">
          <div class="list-item-title">${escapeHtml(s.name)}</div>
          <div class="list-item-sub">${escapeHtml(s.phone || 'No phone')}</div>
        </div>
      </div>`).join('')}</div></div>`;
  }

  // ---------- Reports ----------
  function viewReports() {
    const revenue = invoices.reduce((s, i) => s + (i.total || 0), 0);
    const cogs = invoices.reduce((s, inv) => s + inv.items.reduce((a, it) => a + ((it.cost || 0) * it.qty), 0), 0);
    const totalExpenses = expenses.reduce((s, e) => s + (e.amount || 0), 0);
    const profit = revenue - cogs - totalExpenses;
    const totalInvoices = invoices.length;
    const avgTicket = totalInvoices ? revenue / totalInvoices : 0;

    const sold = {};
    invoices.forEach(inv => inv.items.forEach(it => {
      sold[it.name] = (sold[it.name] || 0) + it.qty;
    }));
    const top = Object.entries(sold).sort((a,b) => b[1] - a[1]).slice(0, 5);

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
              <label class="form-label">Invoice Prefix</label>
              <input class="form-input" name="invoicePrefix" value="${escapeHtml(settings.invoicePrefix || 'INV')}" />
            </div>
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

    $('#modalRoot').innerHTML = `
      <div class="modal-overlay" id="invDetail">
        <div class="modal-sheet">
          <div class="modal-handle"></div>
          <div class="modal-header">
            <h3 class="modal-title">Invoice ${escapeHtml(inv.number)}</h3>
            <button class="modal-close" data-action="close-modal"><svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg></button>
          </div>
          <div class="mb-16">
            <div class="text-sm text-secondary">Customer</div>
            <div class="font-semibold">${escapeHtml(inv.customerName || 'Walk-in')}</div>
            ${inv.customerPhone ? `<div class="text-sm text-secondary mt-8">${escapeHtml(inv.customerPhone)}</div>` : ''}
            <div class="text-sm text-secondary mt-8">${formatDate(inv.date)}</div>
          </div>
          <div class="invoice-summary">${itemsHtml}
            <div class="summary-row total"><span>Total</span><span>${settings.currency} ${money(inv.total)}</span></div>
            <div class="summary-row"><span>Paid</span><span style="color:var(--success)">${settings.currency} ${money(paid)}</span></div>
            <div class="summary-row"><span>Due</span><span style="color:${due > 0 ? 'var(--danger)' : 'var(--success)'}">${settings.currency} ${money(due)}</span></div>
            <div class="summary-row"><span>Status</span><span class="font-semibold">${statusLabel}</span></div>
          </div>
          ${due > 0 ? `
          <div class="form-group mt-16">
            <label class="form-label">Record payment</label>
            <div class="input-with-btn">
              <input type="number" class="form-input" id="recordPayInput" min="0" step="0.01" placeholder="Amount" />
              <button type="button" class="btn btn-primary btn-sm" style="height:48px" data-action="record-payment" data-id="${inv.id}">Add</button>
            </div>
          </div>
          <button class="btn btn-secondary btn-block mt-8" data-action="mark-paid" data-id="${inv.id}">Mark as Fully Paid</button>
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
        </div>
      </div>`;
  }

  function generatePDF(inv) {
    const { jsPDF } = window.jspdf;
    const doc = new jsPDF({ unit: 'mm', format: 'a4' });
    const W = 210, m = 16;
    const paid = inv.paidAmount || 0;
    const due = Math.max(0, (inv.total || 0) - paid);
    const statusText = due <= 0 ? 'PAID' : (paid > 0 ? 'PARTIAL' : 'UNPAID');
    let y = 0;

    // Header band
    doc.setFillColor(13, 148, 136);
    doc.rect(0, 0, W, 36, 'F');

    let textX = m;
    if (settings.logo) {
      try {
        doc.setFillColor(255, 255, 255);
        doc.roundedRect(m, 7, 22, 22, 3, 3, 'F');
        doc.addImage(settings.logo, 'PNG', m + 2, 9, 18, 18);
        textX = m + 26;
      } catch (e) {}
    }
    doc.setTextColor(255, 255, 255);
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
    doc.text('INVOICE', W - m, 14, { align: 'right' });
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

    // Table header
    doc.setFillColor(241, 245, 249);
    doc.roundedRect(m, y, W - 2 * m, 8, 1.5, 1.5, 'F');
    doc.setFont('helvetica', 'bold');
    doc.setFontSize(8);
    doc.setTextColor(100);
    doc.text('ITEM', m + 3, y + 5.5);
    doc.text('QTY', m + 100, y + 5.5);
    doc.text('PRICE', m + 125, y + 5.5);
    doc.text('AMOUNT', W - m - 3, y + 5.5, { align: 'right' });
    y += 12;

    doc.setFont('helvetica', 'normal');
    doc.setTextColor(15, 23, 42);
    inv.items.forEach((it, idx) => {
      if (y > 230) { doc.addPage(); y = 20; }
      if (idx % 2 === 1) {
        doc.setFillColor(248, 250, 252);
        doc.rect(m, y - 4, W - 2 * m, 8, 'F');
      }
      doc.setFontSize(9);
      doc.setFont('helvetica', 'normal');
      doc.text(String(it.name).substring(0, 38), m + 3, y);
      doc.text(String(it.qty), m + 100, y);
      doc.text(money(it.price), m + 125, y);
      doc.setFont('helvetica', 'bold');
      doc.text(money(it.price * it.qty), W - m - 3, y, { align: 'right' });
      y += 8;
    });

    y += 4;
    doc.setDrawColor(226, 232, 240);
    doc.line(m, y, W - m, y);
    y += 8;

    // Totals
    const tx = W - m - 55;
    doc.setFont('helvetica', 'normal');
    doc.setFontSize(9);
    doc.setTextColor(100);
    doc.text('Subtotal', tx, y);
    doc.setTextColor(15, 23, 42);
    doc.text(`${settings.currency} ${money(inv.total)}`, W - m, y, { align: 'right' });
    y += 6;
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
    y += 2;
    doc.setFillColor(204, 251, 241);
    doc.roundedRect(tx - 4, y - 4, W - m - (tx - 4), 10, 2, 2, 'F');
    doc.setTextColor(15, 118, 110);
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
    doc.setTextColor(13, 148, 136);
    doc.text('Thank you for your business!', m, y);
    y += 5;
    doc.setFont('helvetica', 'normal');
    doc.setFontSize(7);
    doc.setTextColor(160);
    doc.text('Generated by Hisably', m, y);

    doc.save(`Invoice-${inv.number}.pdf`);
    toast('PDF downloaded');
  }

  async function shareInvoiceImage(inv) {
    const paid = inv.paidAmount || 0;
    const due = Math.max(0, (inv.total || 0) - paid);
    const statusText = due <= 0 ? 'PAID' : (paid > 0 ? 'PARTIAL' : 'UNPAID');
    const statusColor = due <= 0 ? '#10B981' : (paid > 0 ? '#F59E0B' : '#EF4444');

    const card = document.createElement('div');
    card.style.cssText = 'position:fixed;left:-9999px;top:0;width:400px;background:#fff;font-family:Inter,system-ui,sans-serif;color:#0F172A;border-radius:16px;overflow:hidden;';
    card.innerHTML = `
      <div style="background:linear-gradient(135deg,#0D9488,#0F766E);color:#fff;padding:18px 20px;display:flex;align-items:center;gap:12px;">
        ${settings.logo ? `<div style="width:46px;height:46px;border-radius:12px;background:#fff;display:flex;align-items:center;justify-content:center;overflow:hidden;flex-shrink:0"><img src="${settings.logo}" style="width:42px;height:42px;object-fit:contain"/></div>` : `<div style="width:46px;height:46px;border-radius:12px;background:#fff;color:#0D9488;font-weight:800;font-size:16px;display:flex;align-items:center;justify-content:center;flex-shrink:0">H</div>`}
        <div style="flex:1;min-width:0">
          <div style="font-size:17px;font-weight:700">${escapeHtml(settings.businessName)}</div>
          <div style="font-size:11px;opacity:0.9;margin-top:2px">${escapeHtml([settings.phone, settings.city].filter(Boolean).join(' · '))}</div>
        </div>
        <div style="text-align:right">
          <div style="font-size:10px;font-weight:700;opacity:0.85;letter-spacing:0.05em">INVOICE</div>
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
        <div style="display:flex;justify-content:space-between;font-size:13px;margin-bottom:4px">
          <span style="color:#64748B">Paid</span><span style="color:#10B981;font-weight:600">${settings.currency} ${money(paid)}</span>
        </div>
        ${due > 0 ? `<div style="display:flex;justify-content:space-between;font-size:13px;margin-bottom:6px">
          <span style="color:#64748B">Due</span><span style="color:#EF4444;font-weight:600">${settings.currency} ${money(due)}</span>
        </div>` : ''}
        <div style="display:flex;justify-content:space-between;align-items:center;background:linear-gradient(135deg,#CCFBF1,#F0FDFA);border-radius:12px;padding:12px 14px;margin-top:4px">
          <span style="font-weight:700;font-size:14px">Total</span>
          <span style="font-weight:800;font-size:18px;color:#0F766E">${settings.currency} ${money(inv.total)}</span>
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
            await navigator.share({ files: [file], title: `Invoice ${inv.number}`, text: `Invoice from ${settings.businessName}` });
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
    let text = `*${settings.businessName}*\nInvoice ${inv.number}\nDate: ${formatDate(inv.date)}\nCustomer: ${inv.customerName || 'Walk-in'}\n\n`;
    inv.items.forEach(it => {
      text += `• ${it.name} × ${it.qty} = ${settings.currency} ${money(it.price * it.qty)}\n`;
    });
    text += `\n*Total: ${settings.currency} ${money(inv.total)}*`;
    if (settings.phone) text += `\n\nContact: ${settings.phone}`;
    const phone = (inv.customerPhone || '').replace(/\D/g, '');
    window.open(`https://wa.me/${phone}?text=${encodeURIComponent(text)}`, '_blank');
  }

  function printInvoice(inv) {
    const w = window.open('', '_blank', 'width=400,height=600');
    w.document.write(`<!DOCTYPE html><html><head><title>Invoice ${inv.number}</title>
      <style>
        body{font-family:system-ui,sans-serif;padding:16px;max-width:320px;margin:0 auto;color:#111;font-size:13px;}
        .head{text-align:center;border-bottom:2px solid #0D9488;padding-bottom:10px;margin-bottom:12px;}
        .head h1{font-size:16px;margin:0 0 4px;}
        .meta{margin-bottom:12px;font-size:12px;color:#444;}
        table{width:100%;border-collapse:collapse;margin:10px 0;}
        th,td{text-align:left;padding:4px 0;border-bottom:1px solid #eee;}
        th{font-size:11px;color:#666;}
        .total{font-weight:700;font-size:15px;margin-top:10px;text-align:right;}
        .foot{text-align:center;margin-top:20px;font-size:11px;color:#888;}
        @media print{body{padding:0;}}
      </style></head><body>
      <div class="head"><h1>${escapeHtml(settings.businessName)}</h1>
        <div>${escapeHtml([settings.phone, settings.address, settings.city].filter(Boolean).join(' · '))}</div>
      </div>
      <div class="meta">
        <div><strong>Invoice:</strong> ${escapeHtml(inv.number)}</div>
        <div><strong>Date:</strong> ${formatDate(inv.date)}</div>
        <div><strong>Customer:</strong> ${escapeHtml(inv.customerName || 'Walk-in')}</div>
        ${inv.customerPhone ? `<div>${escapeHtml(inv.customerPhone)}</div>` : ''}
      </div>
      <table><thead><tr><th>Item</th><th>Qty</th><th>Amount</th></tr></thead>
      <tbody>${inv.items.map(it => `<tr><td>${escapeHtml(it.name)}</td><td>${it.qty}</td><td>${settings.currency} ${money(it.price*it.qty)}</td></tr>`).join('')}</tbody></table>
      <div class="total">Total: ${settings.currency} ${money(inv.total)}</div>
      ${settings.taxId ? `<div class="foot">Tax/NTN: ${escapeHtml(settings.taxId)}</div>` : ''}
      <div class="foot">Thank you for your business!</div>
      <script>window.onload=function(){window.print();}</script>
      </body></html>`);
    w.document.close();
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

    if (view) {
      setView(view);
      return;
    }

    switch (action) {
      case 'add-product': openProductModal(); break;
      case 'filter-cat': productCat = t.dataset.cat || ''; render(); break;
      case 'bulk-tools': openBulkModal(); break;
      case 'bulk-export': exportProductsCSV(false); break;
      case 'bulk-template': exportProductsCSV(true); break;
      case 'bulk-price': openBulkPriceModal(); break;
      case 'bulk-undo': undoBulkPrice(); break;
      case 'bulk-import-pick': { const fi = $('#bulkImportFile'); if (fi) fi.click(); break; }
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
        inv.paidAmount = round2((inv.paidAmount || 0) + amt);
        if (inv.paidAmount >= inv.total) {
          inv.paidAmount = inv.total;
          inv.paymentStatus = 'paid';
        } else {
          inv.paymentStatus = 'partial';
        }
        persist();
        toast('Payment recorded');
        openInvoiceDetail(inv);
        break;
      }
      case 'mark-paid': {
        const inv = invoices.find(x => x.id === id);
        if (!inv) break;
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
        const data = { products, invoices, customers, suppliers, expenses, stockMovements, settings, invoiceCounter, exportedAt: new Date().toISOString() };
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
          products = []; invoices = []; customers = []; suppliers = []; expenses = []; stockMovements = [];
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
      if (!silent) toast('Cloud not configured');
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
        const m = mergeCollection(n, remote[DB_TABLE[n] || n]);
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
      setInterval(() => { if (!document.hidden) doCloudSync({ silent: true }); }, 5 * 60 * 1000);
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
    products = []; invoices = []; customers = []; suppliers = []; expenses = []; stockMovements = [];
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
      ${(window.HisablyCloud && HisablyCloud.ready()) ? '' : `<div class="auth-msg show error">This app is not connected to its server yet (Supabase keys missing or disabled in <b>js/supabase-config.js</b>), so signing in or signing up cannot work. The app owner must finish the setup.</div>`}
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
          authSay('Sign up is not available yet: the app is not connected to its server. Contact the app owner.', 'error');
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
        authSay(/invalid login/i.test(m) ? 'Wrong email or password' : /confirm/i.test(m) ? 'Please confirm your email first, then sign in' : /failed to fetch|network/i.test(m) ? 'No internet connection or server unreachable. Check your connection and try again.' : m, 'error');
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
          <p class="text-sm text-secondary mb-12">Current: <strong>${escapeHtml(key)}</strong>${cache.status ? ' · ' + escapeHtml(cache.status) : ''}${cache.paidUntil && key !== 'free' ? ' · paid until ' + formatDate(cache.paidUntil) : ''}</p>
          <div class="card mb-12" style="padding:14px">
            <div class="font-semibold">Free</div>
            <div class="text-sm text-secondary">25 products · 40 invoices · 20 customers</div>
            <div class="text-sm" style="color:var(--primary);margin-top:4px">${pay.currency} 0 / month</div>
          </div>
          <div class="card mb-12" style="padding:14px;border-color:var(--primary)">
            <div class="font-semibold">Basic</div>
            <div class="text-sm text-secondary">Unlimited · cloud sync · payment QR on invoices</div>
            <div class="text-sm" style="color:var(--primary);margin-top:4px;font-weight:700">${escapeHtml(pay.currency)} ${escapeHtml(pay.basicPrice)} / month</div>
          </div>
          <div class="card mb-16" style="padding:14px">
            <div class="font-semibold">Pro</div>
            <div class="text-sm text-secondary">Everything in Basic · priority support</div>
            <div class="text-sm" style="color:var(--primary);margin-top:4px;font-weight:700">${pay.currency} ${pay.proPrice} / month</div>
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
