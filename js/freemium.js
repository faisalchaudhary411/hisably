/**
 * Hisably Freemium – plan limits, session, payment helpers
 */
(function () {
  'use strict';

  const SESSION_KEY = 'hisably_user_session_v1';
  const LOCAL_USERS_KEY = 'hisably_local_users_v1';
  const PLAN_CACHE_KEY = 'hisably_plan_cache_v1';

  const LIMITS = {
    free: {
      products: 25,
      invoices: 40,
      customers: 20,
      expenses: 30,
      suppliers: 10,
      paymentQrOnInvoice: false,
      cloudSync: true,
      label: 'Free'
    },
    trial: {
      products: 9999,
      invoices: 9999,
      customers: 9999,
      expenses: 9999,
      suppliers: 9999,
      paymentQrOnInvoice: true,
      cloudSync: true,
      label: 'Trial'
    },
    basic: {
      products: 9999,
      invoices: 9999,
      customers: 9999,
      expenses: 9999,
      suppliers: 9999,
      paymentQrOnInvoice: true,
      cloudSync: true,
      label: 'Basic'
    },
    pro: {
      products: 9999,
      invoices: 9999,
      customers: 9999,
      expenses: 9999,
      suppliers: 9999,
      paymentQrOnInvoice: true,
      cloudSync: true,
      label: 'Pro'
    },
    blocked: {
      products: 0,
      invoices: 0,
      customers: 0,
      expenses: 0,
      suppliers: 0,
      paymentQrOnInvoice: false,
      cloudSync: false,
      label: 'Inactive'
    }
  };

  // Platform payment details (overridden from admin / remote)
  const DEFAULT_PAY = {
    jazzcash: '03XX-XXXXXXX',
    easypaisa: '03XX-XXXXXXX',
    bankName: 'HBL',
    bankAccount: '',
    bankTitle: 'Hisably',
    note: 'Send payment and tap “I paid” with your shop name.',
    basicPrice: 499,
    proPrice: 999,
    currency: 'PKR',
    freemiumEnabled: true
  };

  function load(key, fb) {
    try {
      const r = localStorage.getItem(key);
      return r ? JSON.parse(r) : fb;
    } catch { return fb; }
  }
  function save(key, v) {
    localStorage.setItem(key, JSON.stringify(v));
  }

  function getSession() {
    return load(SESSION_KEY, null);
  }
  function setSession(s) {
    save(SESSION_KEY, s);
  }
  function clearSession() {
    localStorage.removeItem(SESSION_KEY);
  }

  function getPlanCache() {
    return load(PLAN_CACHE_KEY, {
      planId: 'free',
      status: 'trial',
      trialEndsAt: null,      // no known trial end => treated as Free until the cloud confirms
      paidUntil: null,
      freemiumEnabled: true,
      serverOffsetMs: 0,
      payment: DEFAULT_PAY,
      checkedAt: null
    });
  }
  function setPlanCache(p) {
    save(PLAN_CACHE_KEY, Object.assign(getPlanCache(), p, { checkedAt: new Date().toISOString() }));
  }
  function clearPlanCache() {
    localStorage.removeItem(PLAN_CACHE_KEY);
  }

  // "Now" according to the server (offset measured at last sync), so setting the
  // phone clock back does not extend a trial or a paid month.
  function nowMs(cache) {
    return Date.now() + (Number((cache || getPlanCache()).serverOffsetMs) || 0);
  }

  function effectivePlan() {
    const cache = getPlanCache();
    const status = cache.status || 'trial';
    // A shop the admin paused/expired stays blocked even if freemium is switched off
    if (status === 'paused' || status === 'expired') {
      return { key: 'blocked', limits: LIMITS.blocked, cache };
    }
    if (cache.freemiumEnabled === false) {
      // Platform turned freemium off -> everyone gets full access
      return { key: 'pro', limits: LIMITS.pro, cache };
    }
    const now = nowMs(cache);
    if (status === 'trial') {
      if (cache.trialEndsAt && new Date(cache.trialEndsAt).getTime() > now) {
        return { key: 'trial', limits: LIMITS.trial, cache };
      }
      return { key: 'free', limits: LIMITS.free, cache: Object.assign({}, cache, { status: 'expired_trial' }) };
    }
    if (status === 'active') {
      // Paid plans are monthly: once paid_until passes the shop falls back to Free
      if (cache.paidUntil && new Date(cache.paidUntil).getTime() <= now) {
        return { key: 'free', limits: LIMITS.free, cache: Object.assign({}, cache, { status: 'expired_paid' }) };
      }
      const id = cache.planId || 'basic';
      if (id === 'pro') return { key: 'pro', limits: LIMITS.pro, cache };
      if (id === 'free') return { key: 'free', limits: LIMITS.free, cache };
      return { key: 'basic', limits: LIMITS.basic, cache };
    }
    return { key: 'free', limits: LIMITS.free, cache };
  }

  function canAdd(type, currentCount) {
    const { limits, key } = effectivePlan();
    if (key === 'blocked') return { ok: false, reason: 'Your account is inactive. Upgrade or contact support.' };
    const max = limits[type];
    if (max == null) return { ok: true };
    if (currentCount >= max) {
      return {
        ok: false,
        reason: `Free plan limit reached: max ${max} ${type}. Upgrade to Basic/Pro for unlimited.`
      };
    }
    return { ok: true, remaining: max - currentCount };
  }

  function isLoggedIn() {
    const s = getSession();
    return !!(s && s.email);
  }

  // ---- Local auth (works without Supabase for testing) ----
  function localUsers() {
    return load(LOCAL_USERS_KEY, []);
  }
  function saveLocalUsers(u) {
    save(LOCAL_USERS_KEY, u);
  }
  function hash(pw) {
    // Lightweight obfuscation only (not crypto) – cloud uses Supabase Auth
    try {
      return btoa(unescape(encodeURIComponent('hb:' + pw + ':v1')));
    } catch {
      return 'hb:' + pw;
    }
  }

  function localRegister({ email, password, fullName, shopName, phone }) {
    // Restricted: public local signup is off. Use Supabase cloud signup.
    const allow = localStorage.getItem('hisably_allow_local_signup') === '1';
    if (!allow) throw new Error('Local signup is disabled. Use cloud sign up or contact support.');
    /* LOCAL_SIGNUP_DISABLED */
    email = (email || '').trim().toLowerCase();
    if (!email || !password || password.length < 6) throw new Error('Email and password (6+) required');
    const users = localUsers();
    if (users.find(u => u.email === email)) throw new Error('Email already registered');
    const trialEnds = new Date(Date.now() + 14 * 24 * 3600 * 1000).toISOString();
    const user = {
      id: 'local_' + Date.now().toString(36),
      email,
      passwordHash: hash(password),
      fullName: fullName || 'Owner',
      shopName: shopName || 'My Shop',
      phone: phone || '',
      planId: 'trial',
      status: 'trial',
      trialEndsAt: trialEnds,
      createdAt: new Date().toISOString()
    };
    users.push(user);
    saveLocalUsers(users);
    setSession({
      email: user.email,
      fullName: user.fullName,
      shopName: user.shopName,
      phone: user.phone,
      userId: user.id,
      mode: 'local'
    });
    setPlanCache({
      planId: 'trial',
      status: 'trial',
      trialEndsAt: trialEnds,
      freemiumEnabled: true,
      payment: DEFAULT_PAY
    });
    return user;
  }

  function localSignIn(email, password) {
    email = (email || '').trim().toLowerCase();
    const user = localUsers().find(u => u.email === email);
    if (!user || user.passwordHash !== hash(password)) throw new Error('Invalid email or password');
    setSession({
      email: user.email,
      fullName: user.fullName,
      shopName: user.shopName,
      phone: user.phone,
      userId: user.id,
      mode: 'local'
    });
    setPlanCache({
      planId: user.planId || 'trial',
      status: user.status || 'trial',
      trialEndsAt: user.trialEndsAt,
      freemiumEnabled: true,
      payment: getPlanCache().payment || DEFAULT_PAY
    });
    return user;
  }

  // Admin local: update a local user's plan (when admin runs same browser – rare)
  function localSetUserPlan(email, { planId, status }) {
    const users = localUsers();
    const i = users.findIndex(u => u.email === (email || '').toLowerCase());
    if (i < 0) return false;
    if (planId) users[i].planId = planId;
    if (status) users[i].status = status;
    saveLocalUsers(users);
    return true;
  }

  window.HisablyFreemium = {
    LIMITS,
    DEFAULT_PAY,
    getSession,
    setSession,
    clearSession,
    isLoggedIn,
    getPlanCache,
    setPlanCache,
    clearPlanCache,
    nowMs,
    effectivePlan,
    canAdd,
    localRegister,
    localSignIn,
    localSetUserPlan,
    localUsers
  };
})();
