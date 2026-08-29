// Runs in the page's MAIN world. Hooks fetch/XHR + console and relays to content.js via postMessage.
(() => {
  if (window.__oa_injected) return;
  window.__oa_injected = true;
  const TAG = '__OA__';
  const MAX_BODY = 30000;
  const send = (kind, payload) => {
    try { window.postMessage({ [TAG]: true, kind, payload }, '*'); } catch {}
  };
  const trunc = (s) => (typeof s === 'string' && s.length > MAX_BODY ? s.slice(0, MAX_BODY) + `…[truncated ${s.length - MAX_BODY}]` : s);
  const bodyToString = async (b) => {
    try {
      if (b == null) return null;
      if (typeof b === 'string') return trunc(b);
      if (b instanceof URLSearchParams) return trunc(b.toString());
      if (b instanceof FormData) { const o = {}; for (const [k, v] of b.entries()) o[k] = typeof v === 'string' ? v : `[file ${v.name}]`; return trunc(JSON.stringify(o)); }
      if (b instanceof Blob) return `[blob ${b.type} ${b.size}b]`;
      if (b instanceof ArrayBuffer || ArrayBuffer.isView(b)) return `[binary ${b.byteLength}b]`;
      return trunc(String(b));
    } catch { return null; }
  };
  const headersToObj = (h) => { const o = {}; try { if (h && h.forEach) h.forEach((v, k) => (o[k] = v)); else if (h && typeof h === 'object') Object.assign(o, h); } catch {} return o; };
  let seq = 0;

  // ---- fetch ----
  const origFetch = window.fetch;
  window.fetch = async function (input, init) {
    const id = 'f' + (++seq);
    const url = typeof input === 'string' ? input : input?.url;
    const method = (init?.method || (typeof input !== 'string' && input?.method) || 'GET').toUpperCase();
    const reqHeaders = headersToObj(init?.headers || (typeof input !== 'string' && input?.headers));
    const reqBody = await bodyToString(init?.body);
    const start = Date.now();
    send('net', { id, phase: 'start', source: 'fetch', url, method, reqHeaders, reqBody, ts: start });
    let res;
    try { res = await origFetch.apply(this, arguments); }
    catch (e) { send('net', { id, phase: 'error', error: String(e), ts: Date.now() }); throw e; }
    try {
      const clone = res.clone();
      const resHeaders = headersToObj(clone.headers);
      const ct = clone.headers.get('content-type') || '';
      const textLike = /json|text|xml|javascript|x-www-form|html|csv|event-stream/i.test(ct) || ct === '';
      (async () => {
        let resBody = null;
        try { if (textLike && !/event-stream/i.test(ct)) resBody = trunc(await clone.text()); else resBody = `[${ct || 'unknown'} body not captured]`; } catch {}
        send('net', { id, phase: 'done', status: res.status, statusText: res.statusText, resHeaders, resBody, url: res.url || url, duration: Date.now() - start, ts: Date.now() });
      })();
    } catch {}
    return res;
  };

  // ---- XHR ----
  const XO = XMLHttpRequest.prototype.open, XS = XMLHttpRequest.prototype.send, XH = XMLHttpRequest.prototype.setRequestHeader;
  XMLHttpRequest.prototype.open = function (method, url) { this.__oa = { id: 'x' + (++seq), method: String(method).toUpperCase(), url: String(url), reqHeaders: {} }; return XO.apply(this, arguments); };
  XMLHttpRequest.prototype.setRequestHeader = function (k, v) { if (this.__oa) this.__oa.reqHeaders[k] = v; return XH.apply(this, arguments); };
  XMLHttpRequest.prototype.send = function (body) {
    const m = this.__oa; if (m) {
      const start = Date.now();
      bodyToString(body).then((reqBody) => send('net', { id: m.id, phase: 'start', source: 'xhr', url: m.url, method: m.method, reqHeaders: m.reqHeaders, reqBody, ts: start }));
      this.addEventListener('loadend', () => {
        let resBody = null; try { if (this.responseType === '' || this.responseType === 'text') resBody = trunc(this.responseText); else resBody = `[responseType ${this.responseType}]`; } catch {}
        const resHeaders = {}; try { (this.getAllResponseHeaders() || '').trim().split(/\r?\n/).forEach((l) => { const i = l.indexOf(':'); if (i > 0) resHeaders[l.slice(0, i).trim().toLowerCase()] = l.slice(i + 1).trim(); }); } catch {}
        send('net', { id: m.id, phase: 'done', status: this.status, statusText: this.statusText, resHeaders, resBody, url: this.responseURL || m.url, duration: Date.now() - start, ts: Date.now() });
      });
    }
    return XS.apply(this, arguments);
  };

  // ---- console ----
  const fmt = (a) => { try { if (typeof a === 'string') return a; if (a instanceof Error) return a.stack || a.message; return JSON.stringify(a, (k, v) => (typeof v === 'bigint' ? String(v) : v)); } catch { return String(a); } };
  for (const level of ['log', 'info', 'warn', 'error', 'debug']) {
    const orig = console[level];
    console[level] = function (...args) { try { send('console', { level, text: trunc(args.map(fmt).join(' ')), ts: Date.now() }); } catch {} return orig.apply(this, args); };
  }
  window.addEventListener('error', (e) => send('console', { level: 'error', text: `Uncaught: ${e.message} (${e.filename}:${e.lineno})`, ts: Date.now() }));
  window.addEventListener('unhandledrejection', (e) => send('console', { level: 'error', text: `Unhandled rejection: ${fmt(e.reason)}`, ts: Date.now() }));
})();
