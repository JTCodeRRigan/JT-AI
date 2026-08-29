// Isolated-world content script: page reading, virtual cursor, actions, relay of net/console from inject.js
(() => {
  if (window.__oa_content) return;
  window.__oa_content = true;
  const TAG = '__OA__';

  // ---- relay from MAIN world ----
  window.addEventListener('message', (e) => {
    if (e.source !== window || !e.data || !e.data[TAG]) return;
    try { chrome.runtime.sendMessage({ type: 'relay', kind: e.data.kind, payload: e.data.payload }); } catch {}
  });

  // ---- refs ----
  let refMap = new Map(); // ref -> element
  let refCounter = 0;
  const elRef = new WeakMap();
  const getRef = (el) => { let r = elRef.get(el); if (!r) { r = 'ref_' + (++refCounter); elRef.set(el, r); } refMap.set(r, el); return r; };

  const INTERACTIVE = 'a,button,input,select,textarea,summary,[role=button],[role=link],[role=tab],[role=menuitem],[role=checkbox],[role=radio],[role=switch],[role=option],[role=combobox],[role=textbox],[contenteditable=true],[onclick],[tabindex]';
  const isVisible = (el) => {
    const r = el.getBoundingClientRect(); if (r.width === 0 && r.height === 0) return false;
    const s = getComputedStyle(el); if (s.visibility === 'hidden' || s.display === 'none' || s.opacity === '0') return false;
    return true;
  };
  const inViewport = (el) => { const r = el.getBoundingClientRect(); return r.bottom > 0 && r.right > 0 && r.top < innerHeight && r.left < innerWidth; };
  const clean = (s) => (s || '').replace(/\s+/g, ' ').trim();
  const labelOf = (el) => {
    const aria = el.getAttribute('aria-label'); if (aria) return clean(aria);
    const lb = el.getAttribute('aria-labelledby'); if (lb) { const t = lb.split(' ').map((id) => document.getElementById(id)?.textContent).join(' '); if (clean(t)) return clean(t); }
    if (el.labels && el.labels.length) return clean([...el.labels].map((l) => l.textContent).join(' '));
    if (el.placeholder) return clean(el.placeholder);
    if (el.title) return clean(el.title);
    if (el.alt) return clean(el.alt);
    const t = clean(el.innerText || el.textContent); if (t) return t.slice(0, 120);
    if (el.value && el.type !== 'password') return clean(el.value).slice(0, 60);
    if (el.name) return el.name; if (el.id) return '#' + el.id;
    return '';
  };
  const roleOf = (el) => {
    const r = el.getAttribute('role'); if (r) return r;
    const t = el.tagName.toLowerCase();
    if (t === 'input') return el.type === 'submit' || el.type === 'button' ? 'button' : (el.type || 'text') + '-input';
    if (t === 'a') return 'link'; if (t === 'h1' || t === 'h2' || t === 'h3' || t === 'h4') return 'heading'; if (el.isContentEditable) return 'textbox';
    return t;
  };

  function readPage({ filter = 'interactive', maxChars = 40000, viewportOnly = false } = {}) {
    refMap = new Map();
    const lines = [];
    const seenText = new Set();
    const walk = (node, depth) => {
      if (lines.join('\n').length > maxChars) return;
      if (node.nodeType === Node.TEXT_NODE) {
        if (filter === 'all') { const t = clean(node.textContent); if (t && t.length > 1 && !seenText.has(t)) { const p = node.parentElement; if (p && isVisible(p) && !p.closest(INTERACTIVE)) { seenText.add(t); lines.push('  '.repeat(Math.min(depth, 8)) + t.slice(0, 300)); } } }
        return;
      }
      if (node.nodeType !== Node.ELEMENT_NODE) return;
      const el = node; const tag = el.tagName.toLowerCase();
      if (['script', 'style', 'noscript', 'svg', 'path', 'template', 'meta', 'link', 'head'].includes(tag)) return;
      if (el.id === '__oa_cursor') return;
      if (!isVisible(el)) return;
      if (viewportOnly && !inViewport(el)) { /* children may still be */ }
      const interactive = el.matches(INTERACTIVE) || ['h1','h2','h3','img'].includes(tag);
      if (interactive && (!viewportOnly || inViewport(el))) {
        const ref = getRef(el); const role = roleOf(el); const label = labelOf(el);
        let extra = '';
        if (tag === 'input' || tag === 'textarea' || tag === 'select') { if (el.type !== 'password' && el.value) extra += ` value="${clean(el.value).slice(0, 80)}"`; if (el.checked) extra += ' checked'; if (el.disabled) extra += ' disabled'; }
        if (tag === 'a' && el.href) extra += ` href="${el.href.slice(0, 120)}"`;
        if (tag === 'select') extra += ` options=[${[...el.options].slice(0, 20).map((o) => o.text).join('|')}]`;
        if (el.getAttribute('aria-expanded')) extra += ` expanded=${el.getAttribute('aria-expanded')}`;
        lines.push('  '.repeat(Math.min(depth, 8)) + `[${ref}] ${role} "${label}"${extra}`);
      }
      const sr = el.shadowRoot; if (sr) for (const c of sr.childNodes) walk(c, depth + 1);
      for (const c of el.childNodes) walk(c, depth + (interactive ? 1 : 0));
    };
    walk(document.body, 0);
    let out = lines.join('\n');
    if (out.length > maxChars) out = out.slice(0, maxChars) + `\n…[truncated, ${out.length - maxChars} chars more — use find or scroll]`;
    return { url: location.href, title: document.title, scroll: { y: Math.round(scrollY), maxY: Math.round(document.documentElement.scrollHeight - innerHeight) }, tree: out };
  }

  function findElements(query, limit = 15) {
    const q = query.toLowerCase();
    const res = [];
    for (const el of document.querySelectorAll(INTERACTIVE + ',h1,h2,h3,img,p,li,td,th,span,div')) {
      if (!isVisible(el)) continue;
      const label = labelOf(el); if (!label) continue;
      if (/^(DIV|SPAN|LI|TD|TH|P)$/.test(el.tagName) && !el.matches(INTERACTIVE) && (label.length > 80 || el.querySelector(INTERACTIVE))) continue; // skip noisy containers
      const hay = (label + ' ' + roleOf(el) + ' ' + (el.id || '') + ' ' + (el.className?.toString?.() || '')).toLowerCase();
      if (hay.includes(q)) { const ref = getRef(el); const r = el.getBoundingClientRect(); res.push(`[${ref}] ${roleOf(el)} "${label.slice(0, 100)}" at (${Math.round(r.x + r.width / 2)},${Math.round(r.y + r.height / 2)})`); if (res.length >= limit) break; }
    }
    return res.length ? res.join('\n') : 'No matches.';
  }

  // ---- virtual cursor ----
  let cursor;
  function ensureCursor() {
    if (cursor && document.contains(cursor)) return cursor;
    cursor = document.createElement('div'); cursor.id = '__oa_cursor';
    cursor.innerHTML = `<svg width="28" height="28" viewBox="0 0 24 24"><path d="M5 3l14 8-6 1.5L16 20l-2.5 1-3-7.5L5 18z" fill="#7c5cff" stroke="#fff" stroke-width="1.5" stroke-linejoin="round"/></svg>`;
    Object.assign(cursor.style, { position: 'fixed', left: '0px', top: '0px', zIndex: '2147483647', pointerEvents: 'none', transition: 'transform .35s cubic-bezier(.2,.8,.2,1), opacity .3s', opacity: '0', filter: 'drop-shadow(0 2px 4px rgba(0,0,0,.4))' });
    (document.body || document.documentElement).appendChild(cursor);
    return cursor;
  }
  let hideTimer;
  function moveCursor(x, y) {
    const c = ensureCursor(); c.style.opacity = '1'; c.style.transform = `translate(${x - 4}px, ${y - 3}px)`;
    clearTimeout(hideTimer); hideTimer = setTimeout(() => (c.style.opacity = '0'), 4000);
    return new Promise((r) => setTimeout(r, 380));
  }
  function pulse(x, y) {
    const p = document.createElement('div');
    Object.assign(p.style, { position: 'fixed', left: x - 12 + 'px', top: y - 12 + 'px', width: '24px', height: '24px', borderRadius: '50%', border: '2px solid #7c5cff', zIndex: '2147483646', pointerEvents: 'none', animation: '__oa_pulse .5s ease-out forwards' });
    if (!document.getElementById('__oa_style')) { const s = document.createElement('style'); s.id = '__oa_style'; s.textContent = '@keyframes __oa_pulse{from{transform:scale(.4);opacity:1}to{transform:scale(1.8);opacity:0}}'; document.head.appendChild(s); }
    document.body.appendChild(p); setTimeout(() => p.remove(), 600);
  }

  function resolveTarget({ ref, x, y }) {
    if (ref) { const el = refMap.get(ref); if (!el || !document.contains(el)) throw new Error(`Unknown or stale ${ref}. Call read_page/find again.`); el.scrollIntoView({ block: 'center', inline: 'center', behavior: 'instant' }); const r = el.getBoundingClientRect(); return { el, x: r.x + r.width / 2, y: r.y + r.height / 2 }; }
    if (typeof x === 'number' && typeof y === 'number') return { el: document.elementFromPoint(x, y), x, y };
    throw new Error('Provide ref or x,y');
  }

  const nativeSet = (el, v) => { const proto = el instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype; const d = Object.getOwnPropertyDescriptor(proto, 'value'); if (d?.set) d.set.call(el, v); else el.value = v; };

  async function syntheticClick(el, x, y, opts = {}) {
    const init = { bubbles: true, cancelable: true, clientX: x, clientY: y, button: opts.button === 'right' ? 2 : 0, composed: true };
    for (const t of ['pointerover', 'mouseover', 'pointerdown', 'mousedown', 'pointerup', 'mouseup']) el.dispatchEvent(new (t.startsWith('pointer') ? PointerEvent : MouseEvent)(t, init));
    if (opts.button === 'right') el.dispatchEvent(new MouseEvent('contextmenu', init)); else { el.click?.(); if (opts.dbl) el.dispatchEvent(new MouseEvent('dblclick', init)); }
    if (el.focus) try { el.focus(); } catch {}
  }

  const handlers = {
    ping: () => 'pong',
    read_page: (a) => readPage(a),
    find: (a) => findElements(a.query, a.limit),
    get_text: (a) => { const max = a.maxChars || 50000; const t = clean(document.body.innerText); return { url: location.href, title: document.title, text: t.length > max ? t.slice(0, max) + `…[truncated ${t.length - max}]` : t }; },
    prepare_click: async (a) => { const t = resolveTarget(a); await moveCursor(t.x, t.y); pulse(t.x, t.y); return { x: t.x, y: t.y, tag: t.el?.tagName, label: t.el ? labelOf(t.el) : '' }; },
    synthetic_click: async (a) => { const t = resolveTarget(a); await moveCursor(t.x, t.y); pulse(t.x, t.y); await syntheticClick(t.el, t.x, t.y, a); return `Clicked ${t.el?.tagName?.toLowerCase() || 'point'} "${t.el ? labelOf(t.el).slice(0, 60) : ''}" at (${Math.round(t.x)},${Math.round(t.y)})`; },
    hover: async (a) => { const t = resolveTarget(a); await moveCursor(t.x, t.y); const init = { bubbles: true, clientX: t.x, clientY: t.y }; t.el?.dispatchEvent(new PointerEvent('pointerover', init)); t.el?.dispatchEvent(new MouseEvent('mouseover', init)); t.el?.dispatchEvent(new MouseEvent('mouseenter', init)); t.el?.dispatchEvent(new MouseEvent('mousemove', init)); return 'Hovered'; },
    focus: async (a) => { const t = resolveTarget(a); await moveCursor(t.x, t.y); t.el?.focus?.(); return { x: t.x, y: t.y, editable: !!(t.el && (t.el.isContentEditable || /INPUT|TEXTAREA|SELECT/.test(t.el.tagName))) }; },
    type_text: async (a) => {
      let el = a.ref ? resolveTarget(a).el : document.activeElement;
      if (el && /INPUT|TEXTAREA/.test(el.tagName)) { el.focus(); const v = a.append ? el.value + a.text : a.text; nativeSet(el, v); el.dispatchEvent(new InputEvent('input', { bubbles: true, data: a.text, inputType: 'insertText' })); el.dispatchEvent(new Event('change', { bubbles: true })); return `Typed into ${labelOf(el).slice(0, 50)}`; }
      if (el && el.isContentEditable) { el.focus(); if (!a.append) { document.execCommand('selectAll', false); } document.execCommand('insertText', false, a.text); return 'Typed into contenteditable'; }
      throw new Error('No editable element focused; pass ref of an input');
    },
    select_option: (a) => { const { el } = resolveTarget(a); if (!el || el.tagName !== 'SELECT') throw new Error('Not a <select>'); const opt = [...el.options].find((o) => o.value === a.value || o.text.trim() === a.value) ; if (!opt) throw new Error('Option not found: ' + [...el.options].map((o) => o.text).join('|')); el.value = opt.value; el.dispatchEvent(new Event('input', { bubbles: true })); el.dispatchEvent(new Event('change', { bubbles: true })); return 'Selected ' + opt.text; },
    scroll: async (a) => { const dy = a.direction === 'up' ? -(a.amount || 600) : a.direction === 'down' ? (a.amount || 600) : 0; const dx = a.direction === 'left' ? -(a.amount || 600) : a.direction === 'right' ? (a.amount || 600) : 0; let target = window; if (a.ref) { const { el } = resolveTarget(a); const sc = el.closest?.('[style*="overflow"],[class*="scroll"]') ; target = (el.scrollHeight > el.clientHeight ? el : sc) || window; } if (a.to === 'top') window.scrollTo({ top: 0 }); else if (a.to === 'bottom') window.scrollTo({ top: document.documentElement.scrollHeight }); else target.scrollBy({ top: dy, left: dx, behavior: 'instant' }); await new Promise((r) => setTimeout(r, 300)); return `scrollY=${Math.round(scrollY)} / ${Math.round(document.documentElement.scrollHeight - innerHeight)}`; },
    scroll_to: async (a) => { const { el, x, y } = resolveTarget(a); await moveCursor(x, y); return 'Scrolled into view: ' + labelOf(el).slice(0, 60); },
    key_synthetic: (a) => { const el = document.activeElement || document.body; const key = a.key; const init = { key, code: key, bubbles: true, cancelable: true, ctrlKey: /ctrl/i.test(a.modifiers || ''), metaKey: /cmd|meta/i.test(a.modifiers || ''), shiftKey: /shift/i.test(a.modifiers || ''), altKey: /alt/i.test(a.modifiers || '') }; el.dispatchEvent(new KeyboardEvent('keydown', init)); el.dispatchEvent(new KeyboardEvent('keypress', init)); el.dispatchEvent(new KeyboardEvent('keyup', init)); if (key === 'Enter' && el.form && !el.form.querySelector('button[type=submit],input[type=submit]')) el.form.requestSubmit?.(); else if (key === 'Enter' && el.form) el.form.querySelector('button[type=submit],input[type=submit]')?.click(); return 'Key dispatched (synthetic): ' + key; },
    viewport: () => ({ width: innerWidth, height: innerHeight, dpr: devicePixelRatio, scrollY, url: location.href }),
    show_cursor: (a) => moveCursor(a.x, a.y).then(() => 'ok'),
    detect_captcha: () => {
      const bigEnough = (el) => { const r = el.getBoundingClientRect(); return r.width > 90 && r.height > 24 && isVisible(el); };
      const groups = [
        ['reCAPTCHA', 'iframe[src*="recaptcha/api2/anchor"],iframe[title*="recaptcha" i],.g-recaptcha'],
        ['reCAPTCHA (challenge)', 'iframe[src*="recaptcha/api2/bframe"]'],
        ['hCaptcha', 'iframe[src*="hcaptcha.com"],.h-captcha'],
        ['Cloudflare Turnstile', 'iframe[src*="challenges.cloudflare.com"],.cf-turnstile'],
        ['FunCaptcha/Arkose', 'iframe[src*="arkoselabs"],iframe[src*="funcaptcha"]'],
      ];
      for (const [type, sel] of groups) { 
        for (const el of document.querySelectorAll(sel)) { 
          if (bigEnough(el)) {
            let sitekey = el.dataset.sitekey || '';
            if (!sitekey && el.src) {
              const m = el.src.match(/([?&](k|sitekey)=)([^&]+)/i);
              if (m) sitekey = m[3];
            }
            return { found: true, type, sitekey, url: location.href };
          }
        } 
      }
      return { found: false };
    },
  };

  chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
    if (!msg || msg.type !== 'cs' || !handlers[msg.action]) return;
    Promise.resolve().then(() => handlers[msg.action](msg.args || {})).then((result) => sendResponse({ ok: true, result })).catch((e) => sendResponse({ ok: false, error: e.message || String(e) }));
    return true;
  });
})();
