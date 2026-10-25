/* Hisably receipts: thermal 58/80/88 mm + A4 print layouts, canvas receipt renderer
 * and direct Bluetooth printing (MXW01 "cat"-family printers and generic ESC/POS BLE printers).
 *
 *   HisablyReceipt.receiptHTML(inv, ctx, paperKey)   -> full HTML document (browser print)
 *   HisablyReceipt.printHTML(html)                   -> prints through a hidden iframe
 *   HisablyReceipt.renderCanvas(inv, ctx, dots)      -> Promise<canvas>
 *   HisablyReceipt.bluetoothPrint(canvas, opts)      -> Promise (Web Bluetooth, Chrome/Android)
 *
 * ctx = { settings, money(n), formatDate(d), qrAllowed:boolean }
 */
(function () {
  'use strict';

  const PREF_KEY = 'hisably_print_v1';
  // dots = printable dots at 8 dots/mm; cssMm = printable width used for browser printing
  const PAPER = {
    '58': { label: '58 mm', mm: 58, cssMm: 48, dots: 384 },
    '80': { label: '80 mm', mm: 80, cssMm: 72, dots: 576 },
    '88': { label: '88 mm', mm: 88, cssMm: 80, dots: 640 },
    'a4': { label: 'A4', mm: 210, cssMm: 190, dots: 0 }
  };
  const FONT = '"Inter","Noto Nastaliq Urdu","Noto Naskh Arabic",system-ui,-apple-system,"Segoe UI",Roboto,Arial,sans-serif';

  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  }

  // ---------- device-level print preferences (printer belongs to the device, not the shop) ----------
  function getPrefs() {
    let p = {};
    try { p = JSON.parse(localStorage.getItem(PREF_KEY) || '{}') || {}; } catch (e) {}
    return Object.assign({ paper: '80', printer: 'mxw01', density: 'medium', bitOrder: 'lsb', footer: '' }, p);
  }
  function setPrefs(patch) {
    const p = Object.assign(getPrefs(), patch || {});
    try { localStorage.setItem(PREF_KEY, JSON.stringify(p)); } catch (e) {}
    return p;
  }

  function statusOf(inv) {
    const paid = Number(inv.paidAmount) || 0;
    const total = Number(inv.total) || 0;
    const due = Math.max(0, total - paid);
    return { paid, total, due, label: due <= 0 ? 'PAID' : (paid > 0 ? 'PARTIAL' : 'UNPAID') };
  }
  function lineAmount(it) { return (Number(it.price) || 0) * (Number(it.qty) || 0); }

  // =====================================================================
  //  Browser print (HTML)
  // =====================================================================
  function receiptHTML(inv, ctx, paperKey) {
    const key = PAPER[paperKey] ? paperKey : '80';
    if (key === 'a4') return a4HTML(inv, ctx);
    const P = PAPER[key];
    const s = ctx.settings, cur = esc(s.currency || '');
    const st = statusOf(inv);
    const small = key === '58';
    const fs = small ? 11 : 13;
    const footer = getPrefs().footer;
    const rows = (inv.items || []).map(it => `
      <div class="it"><div class="nm">${esc(it.name)}</div>
        <div class="ln"><span>${esc(it.qty)} × ${esc(ctx.money(it.price))}</span><b>${esc(ctx.money(lineAmount(it)))}</b></div></div>`).join('');
    return `<!DOCTYPE html><html><head><meta charset="utf-8"><title>${esc(inv.number)}</title>
<meta name="viewport" content="width=device-width,initial-scale=1">
<style>
@page{size:${P.mm}mm auto;margin:0}
*{box-sizing:border-box}
html,body{margin:0;padding:0;background:#fff}
body{width:${P.cssMm}mm;margin:0 auto;padding:3mm 0 6mm;font:${fs}px/1.35 ${FONT};color:#000;-webkit-print-color-adjust:exact;print-color-adjust:exact}
.c{text-align:center}
h1{font-size:${fs + 4}px;margin:2px 0 2px;line-height:1.2}
.sub{font-size:${fs - 1}px}
.hr{border:0;border-top:1px dashed #000;margin:6px 0}
.meta div{display:flex;justify-content:space-between;gap:6px}
.it{margin:4px 0}
.nm{font-weight:600;word-break:break-word}
.ln{display:flex;justify-content:space-between}
.row{display:flex;justify-content:space-between;margin:2px 0}
.tot{font-size:${fs + 3}px;font-weight:800;margin:4px 0}
.badge{display:inline-block;border:1.5px solid #000;padding:1px 8px;font-weight:800;letter-spacing:.06em;margin:4px 0}
img.logo{max-width:60%;max-height:18mm;filter:grayscale(1) contrast(1.4);margin-bottom:3px}
img.qr{width:${small ? 30 : 36}mm;height:${small ? 30 : 36}mm;image-rendering:pixelated}
.foot{font-size:${fs - 1}px;margin-top:6px}
@media screen{body{box-shadow:0 0 0 1px #ddd;margin:12px auto}}
</style></head><body>
<div class="c">
  ${s.logo ? `<img class="logo" src="${esc(s.logo)}" alt="">` : ''}
  <h1>${esc(s.businessName || 'Business')}</h1>
  <div class="sub">${esc([s.address, s.city].filter(Boolean).join(', '))}</div>
  ${s.phone ? `<div class="sub">${esc(s.phone)}</div>` : ''}
  ${s.taxId ? `<div class="sub">NTN/Tax: ${esc(s.taxId)}</div>` : ''}
</div>
<div class="hr"></div>
<div class="meta">
  <div><span>Invoice</span><b>${esc(inv.number)}</b></div>
  <div><span>Date</span><span>${esc(ctx.formatDate(inv.date))}</span></div>
  <div><span>Customer</span><span>${esc(inv.customerName || 'Walk-in')}</span></div>
  ${inv.customerPhone ? `<div><span>Phone</span><span>${esc(inv.customerPhone)}</span></div>` : ''}
</div>
<div class="hr"></div>
${rows}
<div class="hr"></div>
<div class="row tot"><span>TOTAL</span><span>${cur} ${esc(ctx.money(st.total))}</span></div>
<div class="row"><span>Paid</span><span>${cur} ${esc(ctx.money(st.paid))}</span></div>
${st.due > 0 ? `<div class="row"><b>Balance due</b><b>${cur} ${esc(ctx.money(st.due))}</b></div>` : ''}
<div class="c"><span class="badge">${st.label}</span></div>
${(ctx.qrAllowed && s.paymentQr) ? `<div class="c" style="margin-top:6px"><img class="qr" src="${esc(s.paymentQr)}" alt=""><div class="sub">Scan to pay</div><div class="sub">${esc(s.paymentNote || '')}</div></div>` : ''}
<div class="c foot">${esc(footer || 'Thank you for your business!')}</div>
</body></html>`;
  }

  function a4HTML(inv, ctx) {
    const s = ctx.settings, cur = esc(s.currency || '');
    const st = statusOf(inv);
    const color = st.label === 'PAID' ? '#059669' : (st.label === 'PARTIAL' ? '#d97706' : '#dc2626');
    const rows = (inv.items || []).map((it, i) => `
      <tr><td class="n">${i + 1}</td><td>${esc(it.name)}</td><td class="r">${esc(it.qty)}</td>
      <td class="r">${esc(ctx.money(it.price))}</td><td class="r"><b>${esc(ctx.money(lineAmount(it)))}</b></td></tr>`).join('');
    return `<!DOCTYPE html><html><head><meta charset="utf-8"><title>Invoice ${esc(inv.number)}</title>
<style>
@page{size:A4;margin:12mm}
*{box-sizing:border-box}
body{margin:0;font:13px/1.45 ${FONT};color:#0f172a;-webkit-print-color-adjust:exact;print-color-adjust:exact}
.top{display:flex;justify-content:space-between;align-items:flex-start;border-bottom:3px solid #0d9488;padding-bottom:14px}
.brand{display:flex;gap:14px;align-items:center}
.brand img{width:64px;height:64px;object-fit:contain}
.brand h1{margin:0;font-size:24px}
.brand .sub{color:#475569;font-size:12px}
.inv{text-align:right}
.inv .t{font-size:26px;font-weight:800;color:#0d9488;letter-spacing:.04em}
.inv .no{font-size:15px;font-weight:700}
.cols{display:flex;justify-content:space-between;margin:18px 0}
.lbl{font-size:10px;letter-spacing:.08em;color:#94a3b8;font-weight:700;text-transform:uppercase}
.badge{display:inline-block;color:#fff;background:${color};padding:3px 12px;border-radius:6px;font-weight:700;font-size:12px}
table{width:100%;border-collapse:collapse;margin-top:6px}
th{background:#f1f5f9;text-align:left;font-size:11px;color:#475569;padding:8px 10px;letter-spacing:.05em}
td{padding:8px 10px;border-bottom:1px solid #e2e8f0;vertical-align:top}
tr:nth-child(even) td{background:#fafcfd}
.r{text-align:right}.n{width:34px;color:#94a3b8}
thead{display:table-header-group}tr{break-inside:avoid}
.bottom{display:flex;justify-content:space-between;gap:24px;margin-top:18px;break-inside:avoid}
.qr{display:flex;gap:12px;align-items:center;border:1px solid #e2e8f0;border-radius:10px;padding:10px;max-width:330px}
.qr img{width:96px;height:96px;object-fit:contain}
.sum{min-width:260px}
.sum .row{display:flex;justify-content:space-between;padding:4px 0}
.sum .grand{background:#ccfbf1;color:#0f766e;font-size:17px;font-weight:800;padding:9px 12px;border-radius:8px;margin-top:6px}
.sign{display:flex;justify-content:space-between;margin-top:46px;color:#64748b;font-size:11px}
.sign div{border-top:1px solid #94a3b8;padding-top:4px;width:180px;text-align:center}
.foot{text-align:center;margin-top:22px;color:#64748b;font-size:12px}
@media screen{body{padding:12mm}}
</style></head><body>
<div class="top">
  <div class="brand">${s.logo ? `<img src="${esc(s.logo)}" alt="">` : ''}
    <div><h1>${esc(s.businessName || 'Business')}</h1>
    <div class="sub">${esc([s.address, s.city].filter(Boolean).join(', '))}</div>
    <div class="sub">${esc([s.phone, s.email].filter(Boolean).join('  ·  '))}</div>
    ${s.taxId ? `<div class="sub">NTN / Tax: ${esc(s.taxId)}</div>` : ''}</div></div>
  <div class="inv"><div class="t">INVOICE</div><div class="no">${esc(inv.number)}</div><div class="sub">${esc(ctx.formatDate(inv.date))}</div></div>
</div>
<div class="cols">
  <div><div class="lbl">Bill to</div><div style="font-size:16px;font-weight:700">${esc(inv.customerName || 'Walk-in Customer')}</div>
    ${inv.customerPhone ? `<div>${esc(inv.customerPhone)}</div>` : ''}</div>
  <div class="r"><div class="lbl">Status</div><span class="badge">${st.label}</span></div>
</div>
<table><thead><tr><th>#</th><th>ITEM</th><th class="r">QTY</th><th class="r">PRICE</th><th class="r">AMOUNT</th></tr></thead><tbody>${rows}</tbody></table>
<div class="bottom">
  <div>${(ctx.qrAllowed && s.paymentQr) ? `<div class="qr"><img src="${esc(s.paymentQr)}" alt=""><div><b>Scan to pay</b><div style="color:#64748b;font-size:12px">${esc(s.paymentNote || '')}</div></div></div>` : ''}</div>
  <div class="sum">
    <div class="row"><span>Subtotal</span><span>${cur} ${esc(ctx.money(st.total))}</span></div>
    <div class="row"><span>Paid</span><span style="color:#059669">${cur} ${esc(ctx.money(st.paid))}</span></div>
    ${st.due > 0 ? `<div class="row"><span>Balance due</span><b style="color:#dc2626">${cur} ${esc(ctx.money(st.due))}</b></div>` : ''}
    <div class="row grand"><span>Total</span><span>${cur} ${esc(ctx.money(st.total))}</span></div>
  </div>
</div>
<div class="sign"><div>Customer signature</div><div>Authorised signature</div></div>
<div class="foot">${esc(getPrefs().footer || 'Thank you for your business!')}</div>
</body></html>`;
  }

  // Print through a hidden iframe (no pop-up blockers on phones)
  function printHTML(html) {
    return new Promise((resolve, reject) => {
      const f = document.createElement('iframe');
      f.setAttribute('aria-hidden', 'true');
      f.style.cssText = 'position:fixed;right:0;bottom:0;width:0;height:0;border:0;opacity:0';
      let done = false;
      const cleanup = () => { if (!done) { done = true; setTimeout(() => { try { f.remove(); } catch (e) {} }, 1500); } };
      f.onload = () => {
        setTimeout(() => {
          try {
            const w = f.contentWindow;
            w.focus();
            w.addEventListener('afterprint', cleanup);
            w.print();
            setTimeout(cleanup, 60000);
            resolve();
          } catch (e) { cleanup(); reject(e); }
        }, 350);                        // let logo / QR images decode first
      };
      document.body.appendChild(f);
      f.srcdoc = html;
    });
  }

  // =====================================================================
  //  Canvas receipt (used for Bluetooth printing and "save as image")
  // =====================================================================
  function loadImage(src) {
    return new Promise(res => {
      if (!src) return res(null);
      const im = new Image();
      im.onload = () => res(im);
      im.onerror = () => res(null);
      im.src = src;
    });
  }

  // Floyd–Steinberg so logos survive 1-bit printing
  function ditherInto(ctx2d, img, x, y, w, h) {
    const tmp = document.createElement('canvas');
    tmp.width = Math.max(1, Math.round(w)); tmp.height = Math.max(1, Math.round(h));
    const t = tmp.getContext('2d');
    t.fillStyle = '#fff'; t.fillRect(0, 0, tmp.width, tmp.height);
    t.drawImage(img, 0, 0, tmp.width, tmp.height);
    const d = t.getImageData(0, 0, tmp.width, tmp.height);
    const g = new Float32Array(tmp.width * tmp.height);
    for (let i = 0; i < g.length; i++) g[i] = 0.299 * d.data[i * 4] + 0.587 * d.data[i * 4 + 1] + 0.114 * d.data[i * 4 + 2];
    for (let yy = 0; yy < tmp.height; yy++) {
      for (let xx = 0; xx < tmp.width; xx++) {
        const i = yy * tmp.width + xx, old = g[i], nv = old < 128 ? 0 : 255, err = old - nv;
        g[i] = nv;
        if (xx + 1 < tmp.width) g[i + 1] += err * 7 / 16;
        if (yy + 1 < tmp.height) {
          if (xx > 0) g[i + tmp.width - 1] += err * 3 / 16;
          g[i + tmp.width] += err * 5 / 16;
          if (xx + 1 < tmp.width) g[i + tmp.width + 1] += err / 16;
        }
      }
    }
    for (let i = 0; i < g.length; i++) { d.data[i * 4] = d.data[i * 4 + 1] = d.data[i * 4 + 2] = g[i]; d.data[i * 4 + 3] = 255; }
    t.putImageData(d, 0, 0);
    ctx2d.drawImage(tmp, x, y);
  }

  async function renderCanvas(inv, c, dots) {
    dots = dots || 384;
    const S = dots / 384;
    const s = c.settings;
    const st = statusOf(inv);
    const logo = await loadImage(s.logo);
    const qr = (c.qrAllowed && s.paymentQr) ? await loadImage(s.paymentQr) : null;
    const pad = Math.round(8 * S);
    const inner = dots - pad * 2;
    const footer = getPrefs().footer || 'Thank you for your business!';
    const cur = s.currency || '';
    const F = (px, bold) => `${bold ? '700' : '400'} ${Math.round(px * S)}px ${FONT}`;

    function layout(g, draw) {
      let y = Math.round(10 * S);
      const wrap = (txt, font, maxW) => {
        g.font = font;
        const out = [];
        String(txt == null ? '' : txt).split('\n').forEach(par => {
          const words = par.split(/\s+/).filter(Boolean);
          let line = '';
          words.forEach(w => {
            const test = line ? line + ' ' + w : w;
            if (g.measureText(test).width <= maxW || !line) {
              if (g.measureText(test).width > maxW) {            // very long single word: hard split
                let chunk = '';
                for (const ch of test) {
                  if (g.measureText(chunk + ch).width > maxW && chunk) { out.push(chunk); chunk = ch; } else chunk += ch;
                }
                line = chunk;
              } else line = test;
            } else { out.push(line); line = w; }
          });
          out.push(line);
        });
        return out;
      };
      const center = (txt, px, bold) => {
        const lines = wrap(txt, F(px, bold), inner);
        lines.forEach(l => {
          if (draw) { g.font = F(px, bold); g.textAlign = 'center'; g.fillText(l, dots / 2, y + px * S * 0.82); }
          y += Math.round(px * S * 1.28);
        });
      };
      const lr = (left, right, px, bold) => {
        g.font = F(px, bold);
        const rw = g.measureText(right).width;
        const lines = wrap(left, F(px, bold), Math.max(40, inner - rw - 8 * S));
        lines.forEach((l, i) => {
          if (draw) {
            g.font = F(px, bold); g.textAlign = 'left'; g.fillText(l, pad, y + px * S * 0.82);
            if (i === lines.length - 1) { g.textAlign = 'right'; g.fillText(right, dots - pad, y + px * S * 0.82); }
          }
          y += Math.round(px * S * 1.28);
        });
      };
      const dash = () => {
        y += Math.round(4 * S);
        if (draw) { g.save(); g.setLineDash([Math.round(6 * S), Math.round(4 * S)]); g.lineWidth = Math.max(1, Math.round(1.5 * S)); g.beginPath(); g.moveTo(pad, y); g.lineTo(dots - pad, y); g.stroke(); g.restore(); }
        y += Math.round(8 * S);
      };

      if (logo) {
        const maxH = 70 * S, maxW = inner * 0.55;
        const k = Math.min(maxW / logo.width, maxH / logo.height, 1 * 3);
        const w = logo.width * k, h = logo.height * k;
        if (draw) ditherInto(g, logo, (dots - w) / 2, y, w, h);
        y += Math.round(h + 8 * S);
      }
      center(s.businessName || 'Business', 26, true);
      const addr = [s.address, s.city].filter(Boolean).join(', ');
      if (addr) center(addr, 17, false);
      if (s.phone) center(s.phone, 17, false);
      if (s.taxId) center('NTN/Tax: ' + s.taxId, 16, false);
      dash();
      lr('Invoice', String(inv.number), 18, true);
      lr('Date', String(c.formatDate(inv.date)), 18, false);
      lr('Customer', String(inv.customerName || 'Walk-in'), 18, false);
      if (inv.customerPhone) lr('Phone', String(inv.customerPhone), 18, false);
      dash();
      (inv.items || []).forEach(it => {
        const lines = wrap(it.name, F(19, true), inner);
        lines.forEach(l => {
          if (draw) { g.font = F(19, true); g.textAlign = 'left'; g.fillText(l, pad, y + 19 * S * 0.82); }
          y += Math.round(19 * S * 1.25);
        });
        lr(`${it.qty} x ${c.money(it.price)}`, c.money(lineAmount(it)), 18, false);
        y += Math.round(3 * S);
      });
      dash();
      lr('TOTAL', `${cur} ${c.money(st.total)}`, 25, true);
      lr('Paid', `${cur} ${c.money(st.paid)}`, 19, false);
      if (st.due > 0) lr('Balance due', `${cur} ${c.money(st.due)}`, 21, true);
      y += Math.round(6 * S);
      center('[ ' + st.label + ' ]', 22, true);
      if (qr) {
        y += Math.round(6 * S);
        const q = Math.min(inner * 0.62, 190 * S);
        if (draw) { g.fillStyle = '#fff'; g.fillRect((dots - q) / 2 - 4, y - 4, q + 8, q + 8); g.imageSmoothingEnabled = false; g.drawImage(qr, (dots - q) / 2, y, q, q); g.fillStyle = '#000'; }
        y += Math.round(q + 8 * S);
        center('Scan to pay', 17, true);
        if (s.paymentNote) center(s.paymentNote, 15, false);
      }
      y += Math.round(6 * S);
      center(footer, 17, false);
      center('Powered by Hisably', 13, false);
      y += Math.round(28 * S);                  // feed so the tear-off bar clears the text
      return y;
    }

    const probe = document.createElement('canvas').getContext('2d');
    const height = Math.max(60, layout(probe, false));
    const cv = document.createElement('canvas');
    cv.width = dots; cv.height = height;
    const g = cv.getContext('2d');
    g.fillStyle = '#fff'; g.fillRect(0, 0, dots, height);
    g.fillStyle = '#000'; g.strokeStyle = '#000'; g.textBaseline = 'alphabetic';
    layout(g, true);
    return cv;
  }

  // 1-bit bitmap, MSB first, 1 = black
  function toBitmap(canvas, threshold) {
    const w = canvas.width - (canvas.width % 8), h = canvas.height;
    const bpr = w / 8;
    const data = canvas.getContext('2d').getImageData(0, 0, canvas.width, h).data;
    const out = new Uint8Array(bpr * h);
    const th = threshold || 150;
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        const i = (y * canvas.width + x) * 4;
        const lum = 0.299 * data[i] + 0.587 * data[i + 1] + 0.114 * data[i + 2];
        if (data[i + 3] > 40 && lum < th) out[y * bpr + (x >> 3)] |= (0x80 >> (x & 7));
      }
    }
    return { width: w, height: h, bytesPerRow: bpr, data: out };
  }
  function reverseBits(b) {
    b = ((b & 0xF0) >> 4) | ((b & 0x0F) << 4);
    b = ((b & 0xCC) >> 2) | ((b & 0x33) << 2);
    b = ((b & 0xAA) >> 1) | ((b & 0x55) << 1);
    return b;
  }

  // Test strip: border, an "L" on the left edge and an arrow so orientation / mirroring is obvious
  function testCanvas(dots) {
    const cv = document.createElement('canvas');
    cv.width = dots; cv.height = 150;
    const g = cv.getContext('2d');
    g.fillStyle = '#fff'; g.fillRect(0, 0, cv.width, cv.height);
    g.fillStyle = '#000'; g.strokeStyle = '#000'; g.lineWidth = 3;
    g.strokeRect(2, 2, dots - 4, 100);
    g.font = `700 34px ${FONT}`; g.textAlign = 'left'; g.fillText('L  Hisably', 12, 62);
    g.textAlign = 'right'; g.fillText('R', dots - 12, 62);
    g.font = `400 18px ${FONT}`; g.textAlign = 'center';
    g.fillText('If text reads normally the printer works', dots / 2, 130);
    return cv;
  }

  // =====================================================================
  //  Bluetooth
  // =====================================================================
  const SV_CAT = '0000ae30-0000-1000-8000-00805f9b34fb';
  const ESC_SERVICES = [
    '000018f0-0000-1000-8000-00805f9b34fb',
    '49535343-fe7d-4ae5-8fa9-9fafd205e455',
    'e7810a71-73ae-499d-8c15-faa9aef0c3f2',
    '0000ffe0-0000-1000-8000-00805f9b34fb',
    '0000ff00-0000-1000-8000-00805f9b34fb',
    '0000fee7-0000-1000-8000-00805f9b34fb'
  ];
  const sleep = ms => new Promise(r => setTimeout(r, ms));
  let btDevice = null;

  function btSupported() { return typeof navigator !== 'undefined' && !!navigator.bluetooth; }

  async function pickDevice(kind) {
    if (!btSupported()) throw new Error('Bluetooth printing needs Chrome on Android (or desktop Chrome/Edge). iPhone/Safari and Firefox do not support it.');
    if (btDevice && btDevice.gatt) return btDevice;
    btDevice = await navigator.bluetooth.requestDevice({
      acceptAllDevices: true,
      optionalServices: kind === 'mxw01' ? [SV_CAT] : ESC_SERVICES
    });
    btDevice.addEventListener('gattserverdisconnected', () => { /* reconnect on next print */ });
    return btDevice;
  }
  function forgetDevice() { try { if (btDevice && btDevice.gatt.connected) btDevice.gatt.disconnect(); } catch (e) {} btDevice = null; }

  async function connectGatt(kind) {
    const dev = await pickDevice(kind);
    let server = dev.gatt;
    if (!server.connected) server = await dev.gatt.connect();
    return server;
  }

  function crc8(bytes) {
    let crc = 0;
    for (const b of bytes) {
      crc ^= b;
      for (let i = 0; i < 8; i++) crc = (crc & 0x80) ? ((crc << 1) ^ 0x07) & 0xFF : (crc << 1) & 0xFF;
    }
    return crc;
  }
  function catPacket(cmd, payload) {
    const p = payload || [];
    return Uint8Array.from([0x22, 0x21, cmd, 0x00, p.length & 255, (p.length >> 8) & 255, ...p, crc8(p), 0xFF]);
  }
  async function writeChunks(ch, bytes, size, delay) {
    for (let i = 0; i < bytes.length; i += size) {
      const part = bytes.slice(i, i + size);
      if (ch.writeValueWithoutResponse) await ch.writeValueWithoutResponse(part);
      else await ch.writeValue(part);
      if (delay) await sleep(delay);
    }
  }

  // MXW01 and the other 0xAE30 "cat" printers: 384 dots/row, 1 bit per dot.
  async function printCat(canvas, opts, onStatus) {
    const say = onStatus || (() => {});
    say('Connecting…');
    const server = await connectGatt('mxw01');
    const svc = await server.getPrimaryService(SV_CAT);
    const ctl = await svc.getCharacteristic('0000ae01-0000-1000-8000-00805f9b34fb');
    const data = await svc.getCharacteristic('0000ae03-0000-1000-8000-00805f9b34fb');
    let notify = null;
    try { notify = await svc.getCharacteristic('0000ae02-0000-1000-8000-00805f9b34fb'); } catch (e) {}
    const seen = [];
    const waiters = [];
    if (notify) {
      await notify.startNotifications();
      notify.addEventListener('characteristicvaluechanged', ev => {
        const v = new Uint8Array(ev.target.value.buffer);
        if (v.length > 2 && v[0] === 0x22 && v[1] === 0x21) {
          seen.push(v[2]);
          waiters.slice().forEach(w => { if (w.cmd === v[2]) { w.res(); waiters.splice(waiters.indexOf(w), 1); } });
        }
      });
    }
    const waitFor = (cmd, ms) => new Promise(res => {
      if (seen.includes(cmd)) return res(true);
      const w = { cmd, res: () => res(true) };
      waiters.push(w);
      setTimeout(() => { const i = waiters.indexOf(w); if (i >= 0) { waiters.splice(i, 1); res(false); } }, ms);
    });

    // The printer is 384 dots wide: scale/crop whatever we got to exactly 384
    let cv = canvas;
    if (cv.width !== 384) {
      const t = document.createElement('canvas'); t.width = 384;
      t.height = Math.round(cv.height * 384 / cv.width);
      const tg = t.getContext('2d'); tg.fillStyle = '#fff'; tg.fillRect(0, 0, t.width, t.height);
      tg.drawImage(cv, 0, 0, t.width, t.height); cv = t;
    }
    const bmp = toBitmap(cv, opts.threshold);
    const lsb = (opts.bitOrder || 'lsb') === 'lsb';
    const rows = bmp.height;
    const level = { light: 50, medium: 75, dark: 93 }[opts.density] || 75;

    say('Preparing…');
    await ctl.writeValueWithoutResponse(catPacket(0xA2, [level]));
    await sleep(60);
    await ctl.writeValueWithoutResponse(catPacket(0xA9, [rows & 255, (rows >> 8) & 255, 0x30, 0x00]));
    await waitFor(0xA9, 2500);

    say('Printing…');
    const bytes = lsb ? bmp.data.map(reverseBits) : bmp.data;
    await writeChunks(data, bytes, 96, 8);
    await sleep(120);
    await ctl.writeValueWithoutResponse(catPacket(0xAD, [0x00]));
    await waitFor(0xAA, 20000);
    try { if (notify) await notify.stopNotifications(); } catch (e) {}
    say('Done');
  }

  // Generic ESC/POS BLE printers (58/80/88 mm): GS v 0 raster
  async function printEscPos(canvas, opts, onStatus) {
    const say = onStatus || (() => {});
    say('Connecting…');
    const server = await connectGatt('escpos');
    let ch = null;
    for (const uuid of ESC_SERVICES) {
      try {
        const svc = await server.getPrimaryService(uuid);
        const chars = await svc.getCharacteristics();
        ch = chars.find(c => c.properties.writeWithoutResponse) || chars.find(c => c.properties.write);
        if (ch) break;
      } catch (e) { /* try next */ }
    }
    if (!ch) throw new Error('No writable printer service found. Try the MXW01 option or browser print.');
    const bmp = toBitmap(canvas, opts.threshold);
    say('Printing…');
    await writeChunks(ch, Uint8Array.from([0x1B, 0x40]), 20, 10);
    const band = 96;
    for (let y = 0; y < bmp.height; y += band) {
      const h = Math.min(band, bmp.height - y);
      const head = Uint8Array.from([0x1D, 0x76, 0x30, 0x00, bmp.bytesPerRow & 255, bmp.bytesPerRow >> 8, h & 255, h >> 8]);
      await writeChunks(ch, head, 20, 5);
      await writeChunks(ch, bmp.data.slice(y * bmp.bytesPerRow, (y + h) * bmp.bytesPerRow), 100, 14);
    }
    await writeChunks(ch, Uint8Array.from([0x0A, 0x0A, 0x0A, 0x0A]), 20, 10);
    say('Done');
  }

  async function bluetoothPrint(canvas, opts, onStatus) {
    const o = Object.assign({}, getPrefs(), opts || {});
    try {
      if (o.printer === 'escpos') await printEscPos(canvas, o, onStatus);
      else await printCat(canvas, o, onStatus);
    } catch (e) {
      // a dead connection must not be reused next time
      if (btDevice && btDevice.gatt && !btDevice.gatt.connected) btDevice = null;
      throw e;
    }
  }

  window.HisablyReceipt = {
    PAPER, getPrefs, setPrefs, receiptHTML, printHTML, renderCanvas, testCanvas, toBitmap,
    bluetoothPrint, btSupported, forgetDevice,
    _t: { crc8, catPacket, reverseBits }
  };
})();
