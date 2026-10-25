/**
 * Hisably Cloud client (seller app)
 * Requires: supabase-js CDN + supabase-config.js
 * Exposes window.HisablyCloud
 *
 * Sync model (v2): record-level, never "delete everything then re-insert".
 *   fetchRemote()  -> everything the cloud has (paginated, throws on ANY error)
 *   push(changes)  -> upsert changed rows + soft-delete tombstones
 * The merge itself (last-write-wins by updatedAt) lives in app.js so it can run
 * synchronously against the live in-memory data.
 */
(function () {
  'use strict';

  const cfg = window.HISABLY_SUPABASE || {};
  let client = null;
  let session = null;
  let profile = null;

  const TABLES = ['products', 'customers', 'suppliers', 'invoices', 'expenses', 'stock_movements'];
  const PAGE = 1000;
  const CHUNK = 200;

  function ready() {
    return !!(cfg.enabled && cfg.url && cfg.anonKey && window.supabase);
  }

  function getClient() {
    if (!ready()) return null;
    if (!client) {
      client = window.supabase.createClient(cfg.url, cfg.anonKey, {
        auth: { persistSession: true, autoRefreshToken: true }
      });
    }
    return client;
  }

  function need() {
    const sb = getClient();
    if (!sb) throw new Error('Cloud not configured');
    return sb;
  }

  async function init() {
    const sb = getClient();
    if (!sb) return { cloud: false };
    const { data } = await sb.auth.getSession();
    session = data.session;
    if (session) await loadProfile();
    sb.auth.onAuthStateChange((_event, s) => {
      session = s;
      // Never await supabase calls directly inside this callback (can deadlock)
      setTimeout(() => {
        if (s) loadProfile().catch(() => {});
        else profile = null;
      }, 0);
    });
    return { cloud: true, signedIn: !!session, profile };
  }

  async function loadProfile() {
    const sb = getClient();
    if (!sb || !session) return null;
    const { data, error } = await sb
      .from('profiles')
      .select('*, shops(id,name,plan_id,status,trial_ends_at,paid_until)')
      .eq('id', session.user.id)
      .single();
    if (!error) profile = data;
    return profile;
  }

  /**
   * The database trigger creates the shop (14-day trial) + profile from this
   * metadata, so signup also works when "Confirm email" is turned on.
   */
  async function signUp({ email, password, fullName, shopName, phone }) {
    const sb = need();
    const { data, error } = await sb.auth.signUp({
      email,
      password,
      options: {
        data: {
          full_name: fullName || '',
          shop_name: shopName || ((fullName || 'My') + "'s Shop"),
          phone: phone || ''
        }
      }
    });
    if (error) throw error;
    // Supabase returns a user with no identities (and no error) for an existing email
    if (data.user && Array.isArray(data.user.identities) && data.user.identities.length === 0) {
      throw new Error('This email is already registered. Please sign in.');
    }
    if (!data.session) {
      return { needsConfirm: true, user: data.user };
    }
    session = data.session;
    await loadProfile();
    if (!profile || !profile.shop_id) {
      throw new Error('Your account was created but your shop was not set up. The database setup is incomplete (run all 5 setup files), then sign in again.');
    }
    return { needsConfirm: false, user: data.user };
  }

  async function signIn(email, password) {
    const sb = need();
    const { data, error } = await sb.auth.signInWithPassword({ email, password });
    if (error) throw error;
    session = data.session;
    await loadProfile();
    if (!profile) throw new Error('Account profile not found. Contact support.');
    if (profile.role === 'platform_admin' && !profile.shop_id) {
      await signOut();
      throw new Error('This is an admin account. Please use the Admin panel.');
    }
    if (!profile.shop_id) {
      await signOut();
      throw new Error('No shop is linked to this account. Contact support.');
    }
    return data;
  }

  async function signOut() {
    const sb = getClient();
    if (sb) { try { await sb.auth.signOut(); } catch (e) {} }
    session = null;
    profile = null;
  }

  function shopId() {
    return profile && profile.shop_id;
  }

  // ---------- Shop / platform info ----------
  async function fetchShop() {
    const sb = getClient();
    const sid = shopId();
    if (!sb || !sid) return null;
    const { data, error } = await sb
      .from('shops')
      .select('id,name,plan_id,status,trial_ends_at,paid_until,settings')
      .eq('id', sid)
      .single();
    if (error) throw error;
    return data;
  }

  async function fetchPlatformSettings() {
    const sb = getClient();
    if (!sb) return null;
    const { data, error } = await sb.from('platform_settings').select('*').eq('id', 1).maybeSingle();
    if (error) throw error;
    return data;
  }

  /** Milliseconds to ADD to Date.now() to get server time (defeats clock tampering). */
  async function serverOffsetMs() {
    const sb = getClient();
    if (!sb) return 0;
    const t0 = Date.now();
    const { data, error } = await sb.rpc('server_now');
    if (error || !data) return 0;
    const t1 = Date.now();
    return new Date(data).getTime() - (t0 + t1) / 2;
  }

  // ---------- Pull ----------
  async function fetchAll(table, sid) {
    const sb = need();
    const out = [];
    for (let from = 0; ; from += PAGE) {
      const { data, error } = await sb
        .from(table)
        .select('*')
        .eq('shop_id', sid)
        .order('id')
        .range(from, from + PAGE - 1);
      if (error) throw error;           // IMPORTANT: a failed read must never look like "no data"
      out.push(...(data || []));
      if (!data || data.length < PAGE) break;
    }
    return out;
  }

  /**
   * Returns { products:{live:[],tombs:{id:iso}}, ..., shop }
   * Throws if any single request fails.
   */
  async function fetchRemote() {
    const sid = shopId();
    if (!sid) throw new Error('No shop linked');
    const [rows, shop] = await Promise.all([
      Promise.all(TABLES.map(t => fetchAll(t, sid))),
      fetchShop()
    ]);
    const out = { shop };
    TABLES.forEach((t, i) => {
      const live = [], tombs = {};
      rows[i].forEach(r => {
        if (r.deleted_at) tombs[r.id] = r.deleted_at;
        else live.push(FROM_DB[t](r));
      });
      out[t] = { live, tombs };
    });
    return out;
  }

  // ---------- Push ----------
  async function upsertChunks(table, rows) {
    const sb = need();
    for (let i = 0; i < rows.length; i += CHUNK) {
      const { error } = await sb.from(table).upsert(rows.slice(i, i + CHUNK), { onConflict: 'id' });
      if (error) throw error;
    }
  }

  async function tombstone(table, tombs) {
    const sb = need();
    const sid = shopId();
    const ids = Object.keys(tombs || {});
    for (let i = 0; i < ids.length; i += CHUNK) {
      const slice = ids.slice(i, i + CHUNK);
      const now = new Date().toISOString();
      const { error } = await sb
        .from(table)
        .update({ deleted_at: now, updated_at: now })
        .in('id', slice)
        .eq('shop_id', sid);
      if (error) throw error;
    }
  }

  /**
   * changes = { products:[...], customers:[...], ..., tombs:{products:{id:iso}}, settings:{...}|null }
   * Parents (customers/products) go first.
   */
  async function push(changes) {
    const sid = shopId();
    if (!need() || !sid) throw new Error('No shop linked');
    const order = ['customers', 'products', 'suppliers', 'invoices', 'expenses', 'stock_movements'];
    for (const t of order) {
      const key = t === 'stock_movements' ? 'stockMovements' : t;
      const list = changes[key] || [];
      if (list.length) await upsertChunks(t, list.map(r => TO_DB[t](r, sid)));
      const tb = (changes.tombs || {})[key];
      if (tb && Object.keys(tb).length) await tombstone(t, tb);
    }
    if (changes.settings) await saveShopSettings(changes.settings);
  }

  async function saveShopSettings(settingsObj) {
    const sb = need();
    const { error } = await sb.rpc('save_shop_settings', { s: settingsObj });
    if (error) throw error;
  }

  /** One-time: legacy v1 pushes used random cloud ids; start clean before the first v2 push. */
  async function wipeRemoteData() {
    const sb = need();
    const sid = shopId();
    for (const t of TABLES) {
      const { error } = await sb.from(t).delete().eq('shop_id', sid);
      if (error) throw error;
    }
  }

  // ---------- Payments ----------
  async function submitPaymentRequest({ planId, note, shopName }) {
    const sb = need();
    const sid = shopId();
    const email = session && session.user && session.user.email;
    if (!sid || !email) throw new Error('Sign in first');
    const { error } = await sb.from('payment_requests').insert({
      shop_id: sid,
      email,
      shop_name: shopName || null,
      plan_id: planId,
      note: note || null,
      status: 'pending'
    });
    if (error) {
      if (error.code === '23505') throw new Error('You already have a pending request. Admin will review it soon.');
      throw error;
    }
  }

  async function latestPaymentRequest() {
    const sb = getClient();
    const sid = shopId();
    if (!sb || !sid) return null;
    const { data, error } = await sb
      .from('payment_requests')
      .select('id,plan_id,status,created_at')
      .eq('shop_id', sid)
      .order('created_at', { ascending: false })
      .limit(1);
    if (error) return null;
    return (data && data[0]) || null;
  }

  // ---------- Mappers ----------
  const num = v => Number(v) || 0;
  const iso = v => (v ? new Date(v).toISOString() : new Date().toISOString());

  const FROM_DB = {
    products: r => ({
      id: r.id, name: r.name, price: num(r.price), cost: num(r.cost), stock: num(r.stock),
      barcode: r.barcode || '', unit: r.unit || 'pcs', lowStock: r.low_stock ?? 5, category: r.category || '',
      notes: r.notes || '', createdAt: r.created_at, updatedAt: r.updated_at
    }),
    customers: r => ({
      id: r.id, name: r.name, phone: r.phone || '', address: r.address || '',
      notes: r.notes || '', updatedAt: r.updated_at
    }),
    suppliers: r => ({
      id: r.id, name: r.name, phone: r.phone || '', notes: r.notes || '', updatedAt: r.updated_at
    }),
    invoices: r => ({
      id: r.id, number: r.number, customerId: r.customer_id || null,
      customerName: r.customer_name || '', customerPhone: r.customer_phone || '',
      items: Array.isArray(r.items) ? r.items : [],
      total: num(r.total), paidAmount: num(r.paid_amount),
      paymentStatus: r.payment_status || 'unpaid', date: r.invoice_date, updatedAt: r.updated_at
    }),
    expenses: r => ({
      id: r.id, title: r.title, amount: num(r.amount), category: r.category || 'Other',
      date: r.expense_date, notes: r.notes || '', updatedAt: r.updated_at
    }),
    stock_movements: r => ({
      id: r.id, productId: r.product_id, productName: r.product_name, type: r.type,
      qty: num(r.qty), note: r.note || '', date: r.created_at, updatedAt: r.updated_at
    })
  };

  const TO_DB = {
    products: (p, sid) => ({
      id: p.id, shop_id: sid, name: p.name, price: num(p.price), cost: num(p.cost),
      stock: Math.round(num(p.stock)), barcode: p.barcode || null, unit: p.unit || 'pcs',
      low_stock: p.lowStock ?? 5, notes: p.notes || null, category: p.category || null,
      created_at: iso(p.createdAt), updated_at: iso(p.updatedAt), deleted_at: null
    }),
    customers: (c, sid) => ({
      id: c.id, shop_id: sid, name: c.name, phone: c.phone || null, address: c.address || null,
      notes: c.notes || null, updated_at: iso(c.updatedAt), deleted_at: null
    }),
    suppliers: (s, sid) => ({
      id: s.id, shop_id: sid, name: s.name, phone: s.phone || null, notes: s.notes || null,
      updated_at: iso(s.updatedAt), deleted_at: null
    }),
    invoices: (inv, sid) => ({
      id: inv.id, shop_id: sid, number: String(inv.number), customer_id: inv.customerId || null,
      customer_name: inv.customerName || null, customer_phone: inv.customerPhone || null,
      items: inv.items || [], total: num(inv.total), paid_amount: num(inv.paidAmount),
      payment_status: inv.paymentStatus || 'unpaid', invoice_date: iso(inv.date),
      updated_at: iso(inv.updatedAt), deleted_at: null
    }),
    expenses: (e, sid) => ({
      id: e.id, shop_id: sid, title: e.title || 'Expense', amount: num(e.amount),
      category: e.category || null, notes: e.notes || null,
      expense_date: e.date ? String(e.date).slice(0, 10) : null,
      updated_at: iso(e.updatedAt), deleted_at: null
    }),
    stock_movements: (m, sid) => ({
      id: m.id, shop_id: sid, product_id: m.productId || null, product_name: m.productName || null,
      type: m.type === 'in' ? 'in' : 'out', qty: Math.round(num(m.qty)), note: m.note || null,
      created_at: iso(m.date), updated_at: iso(m.updatedAt), deleted_at: null
    })
  };

  // Talks to the 'shopify' Supabase Edge Function (see SHOPIFY-SETUP.md)
  async function shopifyCall(action, payload) {
    const sb = need();
    const { data } = await sb.auth.getSession();
    const tok = data.session && data.session.access_token;
    if (!tok) throw new Error('Sign in first');
    let res;
    try {
      res = await fetch(`${cfg.url}/functions/v1/shopify`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', apikey: cfg.anonKey, Authorization: 'Bearer ' + tok },
        body: JSON.stringify(Object.assign({ action }, payload || {}))
      });
    } catch (e) {
      throw new Error('Could not reach the server. Check your internet.');
    }
    let j = {};
    try { j = await res.json(); } catch (e) {}
    if (!res.ok) {
      const err = new Error(res.status === 404
        ? 'The Shopify function is not deployed in your Supabase project yet. Follow SHOPIFY-SETUP.md.'
        : (j.error || ('Shopify request failed (' + res.status + ')')));
      err.status = res.status;
      throw err;
    }
    return j;
  }

  window.HisablyCloud = {
    shopifyCall,
    ready,
    init,
    signUp,
    signIn,
    signOut,
    getSession: () => session,
    getProfile: () => profile,
    shopId,
    fetchShop,
    fetchPlatformSettings,
    serverOffsetMs,
    fetchRemote,
    push,
    saveShopSettings,
    wipeRemoteData,
    submitPaymentRequest,
    latestPaymentRequest
  };
})();
