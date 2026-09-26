// Chrome DevTools Protocol layer: attach lifecycle (dedup, timeouts, auto-reattach, idle-detach, dialogs),
// trusted input (clicks, keys, per-char typing with mac editing commands), and screenshot token-budget math.
// SW is type:module, so this is a plain ES module imported by background.js.

const ATTACH_TIMEOUT = 8000, SEND_TIMEOUT = 30000, IDLE_DETACH = 20000;
const attached = new Set();
const attachInFlight = new Map();   // tabId -> Promise (dedup parallel attach)
const idleTimers = new Map();       // tabId -> timeout id
let handlersRegistered = false;
let dialogLogger = null;            // (tabId, text) => void  — set by background to surface dialog text via get_console

export function setDialogLogger(fn) { dialogLogger = fn; }

let isMac = false;
try { chrome.runtime.getPlatformInfo().then((i) => { isMac = i.os === 'mac'; }).catch(() => {}); } catch {}

const blockedScheme = (url) => { const m = /^(chrome|chrome-extension|devtools|edge|about|view-source):/i.exec(url || ''); return m ? m[1] : null; };

// ---- raw promisified CDP calls with explicit lastError + timeout ----
function rawAttach(tabId) {
  let timer;
  return Promise.race([
    new Promise((res, rej) => { chrome.debugger.attach({ tabId }, '1.3', () => chrome.runtime.lastError ? rej(new Error(chrome.runtime.lastError.message)) : res()); }),
    new Promise((_, rej) => { timer = setTimeout(() => rej(new Error(`debugger_attach_error: chrome.debugger.attach timed out after ${ATTACH_TIMEOUT}ms on tab ${tabId}. DevTools may be open on this tab, or the renderer may have crashed.`)), ATTACH_TIMEOUT); }),
  ]).finally(() => clearTimeout(timer));
}
function sendOnce(tabId, method, params, timeout) {
  let timer;
  return Promise.race([
    new Promise((res, rej) => { chrome.debugger.sendCommand({ tabId }, method, params, (r) => chrome.runtime.lastError ? rej(new Error(chrome.runtime.lastError.message)) : res(r)); }),
    new Promise((_, rej) => { timer = setTimeout(() => rej(new Error(`CDP sendCommand "${method}" timed out after ${timeout}ms on tab ${tabId}. The renderer may be frozen or unresponsive.`)), timeout); }),
  ]).finally(() => clearTimeout(timer));
}

async function attachImpl(tabId) {
  let url = ''; try { url = (await chrome.tabs.get(tabId)).url || ''; } catch {}
  const scheme = blockedScheme(url);
  if (scheme) throw new Error(`Cannot attach debugger to ${scheme}: pages. Navigate to a regular web page (http:// or https://) first, then retry.`);
  try { await detach(tabId); } catch {}            // always detach before attach (clears stale/foreign sessions)
  await rawAttach(tabId);
  attached.add(tabId);
  registerHandlers();
  try { await sendOnce(tabId, 'Page.enable', {}, SEND_TIMEOUT); } catch {}
}
export function attach(tabId) {
  const inflight = attachInFlight.get(tabId);
  if (inflight) return inflight;
  const p = attachImpl(tabId).finally(() => attachInFlight.delete(tabId));
  attachInFlight.set(tabId, p);
  return p;
}
export async function detach(tabId) {
  const tm = idleTimers.get(tabId); if (tm) { clearTimeout(tm); idleTimers.delete(tabId); }
  if (!attached.has(tabId)) { try { await new Promise((r) => chrome.debugger.detach({ tabId }, () => { void chrome.runtime.lastError; r(); })); } catch {} return; }
  attached.delete(tabId);
  try { await new Promise((r) => chrome.debugger.detach({ tabId }, () => { void chrome.runtime.lastError; r(); })); } catch {}
}
export async function detachAll() { for (const id of [...attached]) { try { await detach(id); } catch {} } }

// Restart the idle-detach timer: 20 s after the last CDP command on a tab, drop the debugger so the
// "extension is debugging this browser" banner disappears while the agent is not working.
export function touch(tabId) {
  const prev = idleTimers.get(tabId); if (prev) clearTimeout(prev);
  idleTimers.set(tabId, setTimeout(() => { idleTimers.delete(tabId); detach(tabId).catch(() => {}); }, IDLE_DETACH));
}

export async function send(tabId, method, params = {}, timeout = SEND_TIMEOUT) {
  if (!attached.has(tabId)) await attach(tabId);
  try { const r = await sendOnce(tabId, method, params, timeout); touch(tabId); return r; }
  catch (e) {
    const m = (e && e.message ? e.message : String(e)).toLowerCase();
    if (m.includes('debugger is not attached') || m.includes('detached while handling command')) {
      await attach(tabId); const r = await sendOnce(tabId, method, params, timeout); touch(tabId); return r;
    }
    throw e;
  }
}

function registerHandlers() {
  if (handlersRegistered) return; handlersRegistered = true;
  chrome.debugger.onDetach.addListener((src) => { attached.delete(src.tabId); const tm = idleTimers.get(src.tabId); if (tm) { clearTimeout(tm); idleTimers.delete(src.tabId); } });
  chrome.debugger.onEvent.addListener((src, method, ev) => {
    if (method !== 'Page.javascriptDialogOpening') return;
    const tabId = src.tabId, type = ev?.type;
    // An open JS dialog freezes ALL further CDP commands on the tab — always resolve it.
    // beforeunload: accept so programmatic navigation proceeds; alert/confirm/prompt: accept + log the text for get_console.
    const accept = true;
    if (type !== 'beforeunload' && dialogLogger) { try { dialogLogger(tabId, `[dialog:${type}] ${ev?.message || ''}`); } catch {} }
    chrome.debugger.sendCommand({ tabId }, 'Page.handleJavaScriptDialog', { accept }, () => { void chrome.runtime.lastError; });
  });
}

// ---- trusted input ----
const KEYS = {
  Enter: { code: 'Enter', key: 'Enter', keyCode: 13, text: '\r' }, Return: { code: 'Enter', key: 'Enter', keyCode: 13, text: '\r' },
  Tab: { code: 'Tab', key: 'Tab', keyCode: 9 }, Escape: { code: 'Escape', key: 'Escape', keyCode: 27 }, Esc: { code: 'Escape', key: 'Escape', keyCode: 27 },
  Backspace: { code: 'Backspace', key: 'Backspace', keyCode: 8 }, Delete: { code: 'Delete', key: 'Delete', keyCode: 46 },
  ArrowUp: { code: 'ArrowUp', key: 'ArrowUp', keyCode: 38 }, ArrowDown: { code: 'ArrowDown', key: 'ArrowDown', keyCode: 40 },
  ArrowLeft: { code: 'ArrowLeft', key: 'ArrowLeft', keyCode: 37 }, ArrowRight: { code: 'ArrowRight', key: 'ArrowRight', keyCode: 39 },
  Up: { code: 'ArrowUp', key: 'ArrowUp', keyCode: 38 }, Down: { code: 'ArrowDown', key: 'ArrowDown', keyCode: 40 },
  Left: { code: 'ArrowLeft', key: 'ArrowLeft', keyCode: 37 }, Right: { code: 'ArrowRight', key: 'ArrowRight', keyCode: 39 },
  Home: { code: 'Home', key: 'Home', keyCode: 36 }, End: { code: 'End', key: 'End', keyCode: 35 },
  PageUp: { code: 'PageUp', key: 'PageUp', keyCode: 33 }, PageDown: { code: 'PageDown', key: 'PageDown', keyCode: 34 },
  Space: { code: 'Space', key: ' ', keyCode: 32, text: ' ' },
};
// macOS editing chords only work through the CDP `commands` field.
const MAC_COMMANDS = {
  'cmd+a': 'selectAll', 'cmd+c': 'copy', 'cmd+x': 'cut', 'cmd+v': 'paste', 'cmd+z': 'undo', 'shift+cmd+z': 'redo',
  'cmd+left': 'moveToLeftEndOfLine', 'cmd+right': 'moveToRightEndOfLine',
  'cmd+up': 'moveToBeginningOfDocument', 'cmd+down': 'moveToEndOfDocument',
  'shift+cmd+backspace': 'deleteToBeginningOfLine',
};
const modsBitmask = (modifiers) => { let m = 0; if (/alt/i.test(modifiers)) m |= 1; if (/ctrl/i.test(modifiers)) m |= 2; if (/meta|cmd/i.test(modifiers)) m |= 4; if (/shift/i.test(modifiers)) m |= 8; return m; };

export function getKeyCode(ch) {
  const named = KEYS[ch] || KEYS[ch?.[0]?.toUpperCase() + ch?.slice(1)];
  if (named && ch.length > 1) return named;
  if (ch.length === 1) {
    const up = ch.toUpperCase();
    if (up >= 'A' && up <= 'Z') return { key: ch, code: 'Key' + up, keyCode: up.charCodeAt(0), text: ch };
    if (ch >= '0' && ch <= '9') return { key: ch, code: 'Digit' + ch, keyCode: ch.charCodeAt(0), text: ch };
    return { key: ch, code: '', keyCode: ch.charCodeAt(0), text: ch };  // punctuation etc.
  }
  return null;
}
const requiresShift = (ch) => '~!@#$%^&*()_+{}|:"<>?'.includes(ch) || (ch >= 'A' && ch <= 'Z');

export async function trustedClick(tabId, x, y, opts = {}) {
  const button = opts.button === 'right' ? 'right' : 'left'; const clickCount = opts.dbl ? 2 : 1;
  await send(tabId, 'Input.dispatchMouseEvent', { type: 'mouseMoved', x, y });
  for (let i = 1; i <= clickCount; i++) {
    await send(tabId, 'Input.dispatchMouseEvent', { type: 'mousePressed', x, y, button, clickCount: i });
    await send(tabId, 'Input.dispatchMouseEvent', { type: 'mouseReleased', x, y, button, clickCount: i });
  }
}

export async function trustedKey(tabId, key, modifiers = '') {
  const mods = modsBitmask(modifiers);
  const k = KEYS[key] || (key.length === 1 ? { code: 'Key' + key.toUpperCase(), key, keyCode: key.toUpperCase().charCodeAt(0), text: key } : { code: key, key, keyCode: 0 });
  const commands = [];
  if (isMac && modifiers) { const cmd = MAC_COMMANDS[(modifiers.replace(/meta/i, 'cmd').toLowerCase()) + '+' + String(key).toLowerCase()]; if (cmd) commands.push(cmd); }
  await send(tabId, 'Input.dispatchKeyEvent', { type: k.text && !mods ? 'keyDown' : 'rawKeyDown', modifiers: mods, ...k, windowsVirtualKeyCode: k.keyCode, nativeVirtualKeyCode: k.keyCode, commands });
  await send(tabId, 'Input.dispatchKeyEvent', { type: 'keyUp', modifiers: mods, ...k, windowsVirtualKeyCode: k.keyCode, nativeVirtualKeyCode: k.keyCode });
}

// Per-character keystrokes so autocompletes / input masks / hotkey listeners fire.
// insertText only for chars without a keycode (cyrillic, emoji).
export async function typeText(tabId, text) {
  for (const ch of text) {
    const key = (ch === '\n' || ch === '\r') ? 'Enter' : ch;
    const k = getKeyCode(key);
    if (k && (k.code || key === 'Enter')) {
      const mods = requiresShift(ch) ? 8 : 0;
      await send(tabId, 'Input.dispatchKeyEvent', { type: 'keyDown', modifiers: mods, key: k.key, code: k.code, windowsVirtualKeyCode: k.keyCode, nativeVirtualKeyCode: k.keyCode, text: k.text ?? '', unmodifiedText: k.text ?? '' });
      await send(tabId, 'Input.dispatchKeyEvent', { type: 'keyUp', modifiers: mods, key: k.key, code: k.code, windowsVirtualKeyCode: k.keyCode, nativeVirtualKeyCode: k.keyCode });
    } else {
      await send(tabId, 'Input.insertText', { text: ch });
    }
  }
}

// Select-all + delete using the native editor command on mac, plain ctrl+a elsewhere.
export async function clearField(tabId) {
  if (isMac) await trustedKey(tabId, 'a', 'meta'); else await trustedKey(tabId, 'a', 'ctrl');
  await trustedKey(tabId, 'Backspace');
}

// ---- screenshot token budget (image px kept under a vision model's token limit) ----
export const IMG_BUDGET = { pxPerToken: 28, maxTargetPx: 1568, maxTargetTokens: 1568 };
const ceilDiv = (px, per) => Math.floor((px - 1) / per) + 1;
export const tokensFor = (w, h, per = IMG_BUDGET.pxPerToken) => ceilDiv(w, per) * ceilDiv(h, per);
// Largest width at the same aspect ratio with both sides <= maxTargetPx and token count <= maxTargetTokens.
export function fitToBudget(w, h, cfg = IMG_BUDGET) {
  const { pxPerToken: per, maxTargetPx: maxPx, maxTargetTokens: maxTok } = cfg;
  if (w <= maxPx && h <= maxPx && tokensFor(w, h, per) <= maxTok) return [w, h];
  if (h > w) { const [nh, nw] = fitToBudget(h, w, cfg); return [nw, nh]; }
  const aspect = w / h; let lo = 1, hi = w;
  for (;;) {
    if (lo + 1 === hi) return [lo, Math.max(Math.round(lo / aspect), 1)];
    const mid = Math.floor((lo + hi) / 2), mh = Math.max(Math.round(mid / aspect), 1);
    (mid <= maxPx && tokensFor(mid, mh, per) <= maxTok) ? (lo = mid) : (hi = mid);
  }
}
