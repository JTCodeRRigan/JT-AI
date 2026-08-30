// Service worker: provider calls (OpenAI-compatible / Ollama native), agent loop, tools, network/console logs.
import { TOOLS, SYSTEM_PROMPT, jsonToolPrompt } from './tools.js';
import { t, initI18n, useLang } from './i18n.js';
initI18n();

// Chrome opens the panel on icon click (reliable, no user-gesture/SW-wake race). We bind to the launch tab's group
// when the panel connects, and the panel closes itself (window.close) when the active tab leaves that group —
// so the chat is present only where it was summoned, and simply gone elsewhere (no overlay).
chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true }).catch(() => {});
chrome.sidePanel.setOptions({ path: 'sidepanel.html', enabled: true }).catch(() => {});

// ---------------- logs (per tab) ----------------
const MAX_LOG = 600;
const netLogs = new Map();   // tabId -> array
const consoleLogs = new Map();
const push = (map, tabId, item) => { let a = map.get(tabId); if (!a) { a = []; map.set(tabId, a); } a.push(item); if (a.length > MAX_LOG) a.splice(0, a.length - MAX_LOG); };

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg?.type === 'relay' && sender.tab) {
    const tabId = sender.tab.id;
    if (msg.kind === 'net') {
      const p = msg.payload; const log = netLogs.get(tabId) || [];
      const existing = log.find((e) => e.id === p.id);
      if (existing) Object.assign(existing, p); else push(netLogs, tabId, p);
    } else if (msg.kind === 'console') push(consoleLogs, tabId, msg.payload);
    return;
  }
  if (msg?.type === 'panel') { handlePanel(msg, sendResponse); return true; }
});
// Non-fetch/XHR resources (documents, images, scripts, websockets…) via webRequest
chrome.webRequest.onCompleted.addListener((d) => {
  if (d.tabId < 0) return;
  if (d.type === 'xmlhttprequest') return; // already captured with bodies by inject.js
  push(netLogs, d.tabId, { id: 'w' + d.requestId, source: 'webRequest', type: d.type, url: d.url, method: d.method, status: d.statusCode, ts: d.timeStamp, phase: 'done', fromCache: d.fromCache });
}, { urls: ['<all_urls>'] });
chrome.webRequest.onErrorOccurred.addListener((d) => { if (d.tabId >= 0) push(netLogs, d.tabId, { id: 'w' + d.requestId, source: 'webRequest', type: d.type, url: d.url, method: d.method, error: d.error, ts: d.timeStamp, phase: 'error' }); }, { urls: ['<all_urls>'] });
chrome.webNavigation.onCommitted.addListener((d) => { if (d.frameId === 0) { push(netLogs, d.tabId, { id: 'nav' + d.timeStamp, source: 'navigation', type: 'navigation', url: d.url, ts: d.timeStamp, phase: 'done', transition: d.transitionType }); } });
chrome.tabs.onRemoved.addListener((id) => { netLogs.delete(id); consoleLogs.delete(id); });

// ---------------- settings ----------------
async function getSettings() {
  const s = await chrome.storage.local.get(['providers', 'activeProvider', 'useDebugger', 'maxSteps', 'scope', 'multiAgent', 'supervisorProviderId', 'supervisorEvery', 'autoCaptcha', 'use2captcha', 'captchaKey', 'historyLimit', 'lang']);
  if (s.lang) useLang(s.lang);
  return { providers: s.providers || [], activeProvider: s.activeProvider || null, useDebugger: s.useDebugger !== false, maxSteps: s.maxSteps || 40, scope: s.scope || 'group', multiAgent: !!s.multiAgent, supervisorProviderId: s.supervisorProviderId || null, supervisorEvery: s.supervisorEvery || 4, autoCaptcha: s.autoCaptcha !== false, use2captcha: !!s.use2captcha, captchaKey: s.captchaKey || '', historyLimit: s.historyLimit == null ? 20 : s.historyLimit, lang: s.lang || null };
}

// ---------------- tabs / scope ----------------
let agentTabId = null; // tab the agent currently works with
async function getAnchorTab() { const [t] = await chrome.tabs.query({ active: true, lastFocusedWindow: true }); return t; }
async function scopeTabs(settings) {
  const anchor = (agentTabId && (await chrome.tabs.get(agentTabId).catch(() => null))) || (await getAnchorTab());
  if (!anchor) return [];
  if (settings.scope === 'tab') return [anchor];
  if (settings.scope === 'window') return chrome.tabs.query({ windowId: anchor.windowId });
  if (anchor.groupId && anchor.groupId !== -1) return chrome.tabs.query({ groupId: anchor.groupId });
  return [anchor];
}
async function currentTab(settings) {
  const tabs = await scopeTabs(settings);
  if (agentTabId) { const t = tabs.find((x) => x.id === agentTabId); if (t) return t; }
  const t = tabs.find((x) => x.active) || tabs[0];
  if (!t) throw new Error('No tab in scope');
  agentTabId = t.id; return t;
}
async function assertInScope(tabId, settings) { const tabs = await scopeTabs(settings); if (!tabs.some((t) => t.id === tabId)) throw new Error(`Tab ${tabId} is outside the allowed scope (${settings.scope}). Use list_tabs.`); }

// ---------------- side panel scoping (panel present ONLY where it was summoned) ----------------
let boundGroupId = null, boundWindowId = null, boundTabId = null;
(async () => { try { const s = await chrome.storage.session.get(['boundGroupId', 'boundWindowId', 'boundTabId']); boundGroupId = s.boundGroupId ?? null; boundWindowId = s.boundWindowId ?? null; boundTabId = s.boundTabId ?? null; } catch {} })();

async function bindPanelToTab(tab) {
  if (!tab) return;
  boundTabId = tab.id; boundWindowId = tab.windowId;
  boundGroupId = (tab.groupId != null && tab.groupId !== -1) ? tab.groupId : null;
  try { await chrome.storage.session.set({ boundGroupId, boundWindowId, boundTabId }); } catch {}
}
function panelTabInScope(tab, scope) {
  if (boundTabId == null && boundGroupId == null) return true; // not bound yet → in scope
  if (scope === 'tab') return tab.id === (agentTabId || boundTabId);
  if (scope === 'window') return boundWindowId == null || tab.windowId === boundWindowId;
  // group (default): restrict to the bound group, or to the single launch tab if it had no group
  if (boundGroupId != null) return tab.groupId === boundGroupId;
  return tab.id === boundTabId;
}
async function boundGroupTitle() { if (boundGroupId == null || !chrome.tabGroups) return ''; try { const g = await chrome.tabGroups.get(boundGroupId); return g.title || t('bg.group'); } catch { return t('bg.group'); } }
if (chrome.tabGroups?.onRemoved) chrome.tabGroups.onRemoved.addListener((g) => { if (g.id === boundGroupId) { boundGroupId = null; try { chrome.storage.session.set({ boundGroupId: null }); } catch {} } });

async function cs(tabId, action, args = {}) {
  const send = () => chrome.tabs.sendMessage(tabId, { type: 'cs', action, args });
  let r;
  try { r = await send(); } catch (e) {
    // content script might not be injected yet (e.g. tab opened before install) -> inject and retry
    try { await chrome.scripting.executeScript({ target: { tabId }, files: ['inject.js'], world: 'MAIN' }); await chrome.scripting.executeScript({ target: { tabId }, files: ['content.js'] }); r = await send(); }
    catch (e2) { throw new Error(`Cannot access page in tab ${tabId} (${e2.message}). Chrome internal pages / Web Store are not scriptable.`); }
  }
  if (!r) throw new Error('No response from content script');
  if (!r.ok) throw new Error(r.error);
  return r.result;
}
const waitLoad = (tabId, timeout = 15000) => new Promise((res) => { const t0 = Date.now(); const iv = setInterval(async () => { const t = await chrome.tabs.get(tabId).catch(() => null); if (!t || t.status === 'complete' || Date.now() - t0 > timeout) { clearInterval(iv); setTimeout(res, 300); } }, 200); });

// ---------------- debugger (trusted input) ----------------
const attached = new Set();
async function dbg(tabId, method, params = {}) {
  if (!attached.has(tabId)) { await chrome.debugger.attach({ tabId }, '1.3'); attached.add(tabId); }
  return chrome.debugger.sendCommand({ tabId }, method, params);
}
chrome.debugger.onDetach.addListener((src) => attached.delete(src.tabId));
async function detachAll() { for (const id of [...attached]) { try { await chrome.debugger.detach({ tabId: id }); } catch {} attached.delete(id); } }

async function trustedClick(tabId, x, y, opts = {}) {
  const button = opts.button === 'right' ? 'right' : 'left'; const clickCount = opts.dbl ? 2 : 1;
  await dbg(tabId, 'Input.dispatchMouseEvent', { type: 'mouseMoved', x, y });
  for (let i = 1; i <= clickCount; i++) {
    await dbg(tabId, 'Input.dispatchMouseEvent', { type: 'mousePressed', x, y, button, clickCount: i });
    await dbg(tabId, 'Input.dispatchMouseEvent', { type: 'mouseReleased', x, y, button, clickCount: i });
  }
}
const KEYS = { Enter: { code: 'Enter', key: 'Enter', keyCode: 13, text: '\r' }, Tab: { code: 'Tab', key: 'Tab', keyCode: 9 }, Escape: { code: 'Escape', key: 'Escape', keyCode: 27 }, Backspace: { code: 'Backspace', key: 'Backspace', keyCode: 8 }, Delete: { code: 'Delete', key: 'Delete', keyCode: 46 }, ArrowUp: { code: 'ArrowUp', key: 'ArrowUp', keyCode: 38 }, ArrowDown: { code: 'ArrowDown', key: 'ArrowDown', keyCode: 40 }, ArrowLeft: { code: 'ArrowLeft', key: 'ArrowLeft', keyCode: 37 }, ArrowRight: { code: 'ArrowRight', key: 'ArrowRight', keyCode: 39 }, Home: { code: 'Home', key: 'Home', keyCode: 36 }, End: { code: 'End', key: 'End', keyCode: 35 }, PageUp: { code: 'PageUp', key: 'PageUp', keyCode: 33 }, PageDown: { code: 'PageDown', key: 'PageDown', keyCode: 34 }, Space: { code: 'Space', key: ' ', keyCode: 32, text: ' ' } };
async function trustedKey(tabId, key, modifiers = '') {
  let mods = 0; if (/alt/i.test(modifiers)) mods |= 1; if (/ctrl/i.test(modifiers)) mods |= 2; if (/meta|cmd/i.test(modifiers)) mods |= 4; if (/shift/i.test(modifiers)) mods |= 8;
  const k = KEYS[key] || (key.length === 1 ? { code: 'Key' + key.toUpperCase(), key, keyCode: key.toUpperCase().charCodeAt(0), text: key } : { code: key, key, keyCode: 0 });
  await dbg(tabId, 'Input.dispatchKeyEvent', { type: k.text && !mods ? 'keyDown' : 'rawKeyDown', modifiers: mods, ...k, windowsVirtualKeyCode: k.keyCode, nativeVirtualKeyCode: k.keyCode });
  await dbg(tabId, 'Input.dispatchKeyEvent', { type: 'keyUp', modifiers: mods, ...k, windowsVirtualKeyCode: k.keyCode, nativeVirtualKeyCode: k.keyCode });
}

// ---------------- tool implementations ----------------
const fmtTab = (t) => `tab ${t.id}${t.active ? ' (active)' : ''}${t.id === agentTabId ? ' [agent]' : ''}: "${t.title}" — ${t.url}`;
// After navigate/click the DOM changes; auto-attach a compact snapshot so weak models don't have to "remember" to call read_page.
async function withSnapshot(tabId, text, wait = 600) {
  await new Promise((r) => setTimeout(r, wait));
  try { const r = await cs(tabId, 'read_page', { maxChars: 3000 }); return `${text}\n\n--- ${t('bg.snapshot')} ---\n${r.tree || t('bg.snapshotEmpty')}`; }
  catch { return text; }
}
const toolImpl = {
  async list_tabs(_, ctx) { const tabs = await scopeTabs(ctx.settings); return tabs.map(fmtTab).join('\n') || 'No tabs'; },
  async switch_tab({ tab_id }, ctx) { await assertInScope(tab_id, ctx.settings); agentTabId = tab_id; await chrome.tabs.update(tab_id, { active: true }); const t = await chrome.tabs.get(tab_id); return 'Now working with ' + fmtTab(t); },
  async new_tab({ url }, ctx) { const anchor = await currentTab(ctx.settings); const t = await chrome.tabs.create({ url: url || 'about:blank', windowId: anchor.windowId, index: anchor.index + 1 }); if (anchor.groupId && anchor.groupId !== -1) await chrome.tabs.group({ tabIds: t.id, groupId: anchor.groupId }); agentTabId = t.id; await waitLoad(t.id); const t2 = await chrome.tabs.get(t.id); return withSnapshot(t.id, 'Opened ' + fmtTab(t2)); },
  async close_tab({ tab_id }, ctx) { await assertInScope(tab_id, ctx.settings); await chrome.tabs.remove(tab_id); if (agentTabId === tab_id) agentTabId = null; return 'Closed tab ' + tab_id; },
  async navigate({ url }, ctx) { const t = await currentTab(ctx.settings); if (url === 'back') await chrome.tabs.goBack(t.id); else if (url === 'forward') await chrome.tabs.goForward(t.id); else if (url === 'reload') await chrome.tabs.reload(t.id); else await chrome.tabs.update(t.id, { url: /^[a-z]+:\/\//i.test(url) ? url : 'https://' + url }); await waitLoad(t.id); const t2 = await chrome.tabs.get(t.id); return withSnapshot(t.id, 'Now at ' + fmtTab(t2)); },
  async read_page(a, ctx) { const t = await currentTab(ctx.settings); a.maxChars = Math.min(Math.max(a.maxChars || 12000, 4000), 14000); const r = await cs(t.id, 'read_page', a); return `URL: ${r.url}\nTitle: ${r.title}\nScroll: ${r.scroll.y}/${r.scroll.maxY}\n\n${r.tree || '(nothing visible)'}`; },
  async get_page_text(a, ctx) { const t = await currentTab(ctx.settings); const r = await cs(t.id, 'get_text', a); return `URL: ${r.url}\nTitle: ${r.title}\n\n${r.text}`; },
  async find(a, ctx) { const t = await currentTab(ctx.settings); return cs(t.id, 'find', a); },
  async click(a, ctx) {
    const t = await currentTab(ctx.settings);
    let result;
    if (ctx.settings.useDebugger) { try { const p = await cs(t.id, 'prepare_click', a); await trustedClick(t.id, p.x, p.y, a); result = `Clicked ${p.tag?.toLowerCase() || 'point'} "${(p.label || '').slice(0, 60)}" at (${Math.round(p.x)},${Math.round(p.y)})`; } catch (e) { if (/Cannot access|Unknown or stale|Provide ref/.test(e.message)) throw e; } }
    if (result == null) result = await cs(t.id, 'synthetic_click', a);
    await waitLoad(t.id, 4000);
    return withSnapshot(t.id, result);
  },
  async hover(a, ctx) { const t = await currentTab(ctx.settings); const r = await cs(t.id, 'hover', a); if (ctx.settings.useDebugger) { try { const p = await cs(t.id, 'prepare_click', a); await dbg(t.id, 'Input.dispatchMouseEvent', { type: 'mouseMoved', x: p.x, y: p.y }); } catch {} } return r; },
  async type({ text, ref, append, press_enter }, ctx) {
    const t = await currentTab(ctx.settings);
    let out;
    if (ctx.settings.useDebugger) {
      try { const f = await cs(t.id, 'focus', { ref }); if (ref) { await trustedClick(t.id, f.x, f.y); await new Promise((r) => setTimeout(r, 150)); }
        if (!append) { await trustedKey(t.id, 'a', 'ctrl'); await trustedKey(t.id, 'a', 'meta'); await trustedKey(t.id, 'Backspace'); }
        await dbg(t.id, 'Input.insertText', { text }); out = 'Typed (trusted)'; }
      catch (e) { out = await cs(t.id, 'type_text', { text, ref, append }); }
    } else out = await cs(t.id, 'type_text', { text, ref, append });
    if (press_enter) { await toolImpl.press_key({ key: 'Enter' }, ctx); out += ' + Enter'; await waitLoad(t.id, 5000); }
    return out;
  },
  async press_key({ key, modifiers }, ctx) { const t = await currentTab(ctx.settings); if (ctx.settings.useDebugger) { try { await trustedKey(t.id, key, modifiers); await new Promise((r) => setTimeout(r, 300)); return 'Pressed ' + (modifiers ? modifiers + '+' : '') + key; } catch {} } return cs(t.id, 'key_synthetic', { key, modifiers }); },
  async select_option(a, ctx) { const t = await currentTab(ctx.settings); return cs(t.id, 'select_option', a); },
  async scroll(a, ctx) { const t = await currentTab(ctx.settings); return cs(t.id, 'scroll', a); },
  async scroll_to(a, ctx) { const t = await currentTab(ctx.settings); return cs(t.id, 'scroll_to', a); },
  async wait({ seconds }) { await new Promise((r) => setTimeout(r, Math.min(30, seconds || 1) * 1000)); return 'Waited ' + seconds + 's'; },
  async pause_for_human({ reason }, ctx) {
    const note = await pauseAndWait(ctx, reason || t('bg.pauseHuman'));
    return t('bg.humanDone', note);
  },
  async screenshot(_, ctx) {
    const t = await currentTab(ctx.settings); await chrome.tabs.update(t.id, { active: true }); await new Promise((r) => setTimeout(r, 250));
    const dataUrl = await chrome.tabs.captureVisibleTab(t.windowId, { format: 'jpeg', quality: 70 });
    const vp = await cs(t.id, 'viewport').catch(() => null);
    ctx.pendingImage = dataUrl; ctx.emit({ type: 'image', dataUrl });
    return `Screenshot captured${vp ? ` (viewport ${vp.width}x${vp.height}, CSS px; use these coords for click x,y)` : ''}. ${ctx.provider.vision ? 'The image is attached in the next message.' : 'NOTE: current model is not marked as vision-capable, so the image is only shown to the user. Use read_page instead.'}`;
  },
  async get_network_requests({ filter, limit = 40, include_bodies = false, tab_id }, ctx) {
    const t = tab_id ? await chrome.tabs.get(tab_id) : await currentTab(ctx.settings); if (tab_id) await assertInScope(tab_id, ctx.settings);
    let log = netLogs.get(t.id) || [];
    if (filter) { const re = new RegExp(filter, 'i'); log = log.filter((e) => re.test(e.url) || re.test(e.method || '') || re.test(String(e.status || '')) || re.test(e.type || '')); }
    log = log.slice(-limit);
    if (!log.length) return 'No requests captured yet for this tab (log fills from the moment the page loaded with the extension active; try navigate/reload).';
    return log.map((e) => { let s = `#${e.id} ${e.method || 'GET'} ${e.url}${e.status ? ' → ' + e.status : ''}${e.error ? ' ✖ ' + e.error : ''} [${e.source}${e.type ? '/' + e.type : ''}${e.duration ? ' ' + e.duration + 'ms' : ''}]`; if (include_bodies) { if (e.reqBody) s += `\n  request body: ${String(e.reqBody).slice(0, 2000)}`; if (e.resBody) s += `\n  response body: ${String(e.resBody).slice(0, 3000)}`; } return s; }).join('\n');
  },
  async get_request_details({ request_id }, ctx) { const t = await currentTab(ctx.settings); for (const [, log] of netLogs) { const e = log.find((x) => x.id === request_id); if (e) return JSON.stringify(e, null, 1); } throw new Error('Request not found: ' + request_id); },
  async get_console({ level, limit = 50, tab_id }, ctx) { const t = tab_id ? await chrome.tabs.get(tab_id) : await currentTab(ctx.settings); let log = consoleLogs.get(t.id) || []; if (level) log = log.filter((e) => e.level === level); log = log.slice(-limit); return log.length ? log.map((e) => `[${e.level}] ${e.text}`).join('\n') : 'No console messages captured.'; },
  async execute_js({ code }, ctx) {
    const t = await currentTab(ctx.settings);
    const r = await dbg(t.id, 'Runtime.evaluate', { expression: code, awaitPromise: true, returnByValue: true, userGesture: true });
    if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description || r.exceptionDetails.text);
    const v = r.result?.value; const s = typeof v === 'string' ? v : JSON.stringify(v); return s == null ? 'undefined' : s.length > 20000 ? s.slice(0, 20000) + '…[truncated]' : s;
  },
  async clear_logs(_, ctx) { const t = await currentTab(ctx.settings); netLogs.delete(t.id); consoleLogs.delete(t.id); return 'Cleared'; },
  async done({ summary }) { return summary; },
};

// ---------------- provider calls ----------------
function sseParse(buffer, onJson) { const lines = buffer.split('\n'); const rest = lines.pop(); for (const l of lines) { const s = l.trim(); if (!s) continue; if (s.startsWith('data:')) { const d = s.slice(5).trim(); if (d === '[DONE]') continue; try { onJson(JSON.parse(d)); } catch {} } else if (s.startsWith('{')) { try { onJson(JSON.parse(s)); } catch {} } } return rest; }

// Per-provider learned context window (max_model_len), so we don't repeatedly send an over-limit max_tokens.
const modelCtx = new Map();
const noStopParam = new Set(); // providers/models that reject the `stop` parameter (e.g. xAI Grok)
const ctxKey = (p) => (p.baseUrl || '') + '|' + (p.model || '');
const OUTPUT_CAP = 4096; // a browser agent step outputs a tool call + short reasoning; small cap leaves room for input
// Overestimate prompt tokens (chars/2.6 + tool schemas + overhead) so total never exceeds the context.
const estPromptTokens = (messages, tools) => Math.ceil((JSON.stringify(messages).length + (tools ? JSON.stringify(tools).length : 0)) / 2.6) + 400;
function parseContextLimit(txt) {
  const m = String(txt).match(/max_model_len\s*=?\s*(?:max_total_tokens\s*=?\s*)?(\d{3,7})|max_total_tokens\D{0,20}(\d{3,7})|maximum context length is (\d{3,7})|context length of (\d{3,7})|maximum.*?(\d{3,7})\s*tokens/i);
  if (!m) return null; const n = +(m[1] || m[2] || m[3] || m[4] || m[5]); return n >= 256 ? n : null;
}
const wantTokens = (provider) => Math.max(256, Math.min(provider.maxTokens || 2048, OUTPUT_CAP));
function safeMaxTokens(limit, messages, provider, tools) {
  const margin = Math.max(1024, Math.ceil(limit * 0.05)); // generous headroom for template/tokenizer differences
  const room = limit - estPromptTokens(messages, tools) - margin;
  return Math.max(256, Math.min(wantTokens(provider), room));
}
function clampMaxTokens(provider, messages, tools) {
  const limit = modelCtx.get(ctxKey(provider));
  return limit ? safeMaxTokens(limit, messages, provider, tools) : wantTokens(provider);
}
// Cap conversation history so input never eats the whole context (leaves room for tools + output).
function historyCharBudget(provider) {
  const limit = modelCtx.get(ctxKey(provider));
  if (!limit) return 60000;
  return Math.max(16000, Math.floor((limit - OUTPUT_CAP - 3000) * 2.0));
}

// Convert our OpenAI-style history to Anthropic Messages format: system is top-level, tool calls/results
// become tool_use / tool_result blocks, and consecutive same-role messages are merged (Anthropic strictly alternates).
function anthImg(u) { const m = /^data:([^;]+);base64,(.*)$/s.exec(u || ''); return m ? { type: 'image', source: { type: 'base64', media_type: m[1], data: m[2] } } : { type: 'image', source: { type: 'url', url: u } }; }
function toAnthropic(messages) {
  let system = ''; const turns = [];
  const add = (role, blocks) => { const arr = Array.isArray(blocks) ? blocks : [blocks]; const last = turns[turns.length - 1]; if (last && last.role === role) last.content.push(...arr); else turns.push({ role, content: arr.slice() }); };
  for (const m of messages) {
    if (m.role === 'system') { if (typeof m.content === 'string') system += (system ? '\n\n' : '') + m.content; continue; }
    if (m.role === 'assistant') {
      const blocks = [];
      if (m.content) blocks.push({ type: 'text', text: String(m.content) });
      for (const tc of (m.tool_calls || [])) { let input = safeJson(tc.function.arguments); if (!input || input._raw !== undefined) input = {}; blocks.push({ type: 'tool_use', id: tc.id, name: tc.function.name, input }); }
      if (!blocks.length) blocks.push({ type: 'text', text: '(no content)' });
      add('assistant', blocks);
    } else if (m.role === 'tool') {
      add('user', { type: 'tool_result', tool_use_id: m.tool_call_id, content: String(m.content ?? '') });
    } else if (Array.isArray(m.content)) {
      add('user', m.content.map((p) => (p.type === 'image_url' ? anthImg(p.image_url?.url) : { type: 'text', text: String(p.text || '') })));
    } else add('user', { type: 'text', text: String(m.content ?? '') });
  }
  while (turns.length && turns[0].role !== 'user') turns.shift(); // Anthropic requires the first turn to be user
  return { system, turns };
}

async function callModel(provider, messages, tools, signal, onDelta) {
  const isOllama = provider.protocol === 'ollama';
  const isAnthropic = provider.protocol === 'anthropic';
  const base = provider.baseUrl.replace(/\/+$/, '');
  const headers = { 'Content-Type': 'application/json' };
  if (isAnthropic) { if (provider.apiKey) headers['x-api-key'] = provider.apiKey; headers['anthropic-version'] = '2023-06-01'; headers['anthropic-dangerous-direct-browser-access'] = 'true'; }
  else if (provider.apiKey) headers['Authorization'] = 'Bearer ' + provider.apiKey;
  try { for (const l of (provider.extraHeaders || '').split('\n')) { const i = l.indexOf(':'); if (i > 0) headers[l.slice(0, i).trim()] = l.slice(i + 1).trim(); } } catch {}
  let url, body;
  if (isAnthropic) {
    url = base + (base.endsWith('/v1') ? '/messages' : '/v1/messages');
    const { system, turns } = toAnthropic(messages);
    body = { model: provider.model, max_tokens: clampMaxTokens(provider, messages, tools), messages: turns, stream: true, thinking: { type: 'disabled' } };
    if (system) body.system = system;
    if (tools) body.tools = tools.map((t) => ({ name: t.function.name, description: t.function.description, input_schema: t.function.parameters }));
  } else if (isOllama) {
    url = base + '/api/chat';
    const msgs = messages.map((m) => { if (m.role === 'tool') return { role: 'tool', content: m.content }; if (m.role === 'assistant' && m.tool_calls) return { role: 'assistant', content: m.content || '', tool_calls: m.tool_calls.map((tc) => ({ function: { name: tc.function.name, arguments: safeJson(tc.function.arguments) } })) }; if (Array.isArray(m.content)) { const text = m.content.filter((p) => p.type === 'text').map((p) => p.text).join('\n'); const images = m.content.filter((p) => p.type === 'image_url').map((p) => p.image_url.url.split(',')[1]); return { role: m.role, content: text, images }; } return { role: m.role, content: m.content }; });
    body = { model: provider.model, messages: msgs, stream: true, options: { temperature: provider.temperature ?? 0.2, num_ctx: provider.numCtx || 16384 } };
    if (tools) body.tools = tools;
  } else {
    url = base + '/chat/completions';
    body = { model: provider.model, messages, stream: true, temperature: provider.temperature ?? 0.2, max_tokens: clampMaxTokens(provider, messages, tools) };
    // anti-repetition is OFF by default — penalties hurt structured tool-call generation. Only apply if the user set them.
    if (Number.isFinite(provider.frequencyPenalty)) body.frequency_penalty = provider.frequencyPenalty;
    if (Number.isFinite(provider.presencePenalty)) body.presence_penalty = provider.presencePenalty;
    if (!noStopParam.has(ctxKey(provider))) body.stop = ['<|im_start|>', '<|im_end|>']; // some endpoints don't set chat-template stops → these leak into output (but xAI Grok rejects `stop`)
    if (tools) { body.tools = tools; body.tool_choice = 'auto'; }
  }
  if (isOllama && Number.isFinite(provider.repeatPenalty)) { body.options.repeat_penalty = provider.repeatPenalty; }
  if (provider.extraBody) { try { Object.assign(body, JSON.parse(provider.extraBody)); } catch {} }
  let res = await fetch(url, { method: 'POST', headers, body: JSON.stringify(body), signal });
  if (!res.ok) {
    const txt = await res.text().catch(() => '');
    // Anthropic: thinking:{disabled} is rejected on Fable/older models — drop it and retry once.
    if (isAnthropic && res.status === 400 && body.thinking && /thinking|budget/i.test(txt)) {
      delete body.thinking; res = await fetch(url, { method: 'POST', headers, body: JSON.stringify(body), signal });
    }
    // xAI Grok (and some others) reject the `stop` parameter — learn it, drop it, retry once.
    if (res.status === 400 && body.stop && /stop/i.test(txt) && /support|invalid|unknown|unrecogniz|unexpected|argument/i.test(txt)) {
      noStopParam.add(ctxKey(provider)); delete body.stop; res = await fetch(url, { method: 'POST', headers, body: JSON.stringify(body), signal });
    }
    // vLLM/TGI reject when max_tokens exceeds the model context; learn the real limit and retry once with a safe value.
    const limit = res.status === 400 && !isOllama && !isAnthropic ? parseContextLimit(txt) : null;
    if (limit) {
      modelCtx.set(ctxKey(provider), limit);
      const safe = safeMaxTokens(limit, messages, provider, tools);
      if (safe && safe < body.max_tokens) { body.max_tokens = safe; res = await fetch(url, { method: 'POST', headers, body: JSON.stringify(body), signal }); }
    }
    if (!res.ok) { const t2 = res.bodyUsed ? txt : (await res.text().catch(() => txt)); throw new Error(`Provider HTTP ${res.status}: ${(t2 || txt).slice(0, 600)}`); }
  }
  const ct = res.headers.get('content-type') || '';
  let content = '', toolCalls = [], finish = null;
  const addTool = (idx, tc) => { if (!toolCalls[idx]) toolCalls[idx] = { id: tc.id || 'call_' + idx + '_' + Math.random().toString(36).slice(2, 8), type: 'function', function: { name: '', arguments: '' } }; if (tc.id) toolCalls[idx].id = tc.id; if (tc.function?.name) toolCalls[idx].function.name += tc.function.name; if (tc.function?.arguments) toolCalls[idx].function.arguments += typeof tc.function.arguments === 'string' ? tc.function.arguments : JSON.stringify(tc.function.arguments); };
  const handle = (j) => {
    if (j.error) throw new Error(typeof j.error === 'string' ? j.error : j.error.message || JSON.stringify(j.error));
    if (isOllama) { if (j.message?.content) { content += j.message.content; onDelta(j.message.content); } (j.message?.tool_calls || []).forEach((tc, i) => addTool(toolCalls.length + i, { function: tc.function })); if (j.done) finish = 'stop'; return; }
    if (isAnthropic) {
      const ty = j.type;
      if (ty === 'content_block_start') { const cb = j.content_block || {}; if (cb.type === 'tool_use') addTool(j.index, { id: cb.id, function: { name: cb.name || '' } }); else if (cb.type === 'text' && cb.text) { content += cb.text; onDelta(cb.text); } }
      else if (ty === 'content_block_delta') { const d = j.delta || {}; if (d.type === 'text_delta' && d.text) { content += d.text; onDelta(d.text); } else if (d.type === 'input_json_delta') addTool(j.index, { function: { arguments: d.partial_json || '' } }); else if (d.type === 'thinking_delta' && d.thinking) onDelta('', d.thinking); }
      else if (ty === 'message_delta' && j.delta?.stop_reason) finish = j.delta.stop_reason;
      return;
    }
    const ch = j.choices?.[0]; if (!ch) return;
    const d = ch.delta || ch.message || {};
    if (d.content) { content += d.content; onDelta(d.content); }
    if (d.reasoning_content || d.reasoning) onDelta('', d.reasoning_content || d.reasoning);
    if (d.tool_calls) d.tool_calls.forEach((tc, i) => addTool(tc.index ?? i, tc));
    if (ch.finish_reason) finish = ch.finish_reason;
  };
  if (!res.body || (!/stream|ndjson/.test(ct) && /json/.test(ct) && !body.stream)) { handle(await res.json()); if (looksLooping(content)) throw new Error('LOOP_DETECTED'); }
  else {
    const reader = res.body.getReader(); const dec = new TextDecoder(); let buf = '', looped = false;
    while (true) { const { value, done } = await reader.read(); if (done) break; buf += dec.decode(value, { stream: true }); buf = sseParse(buf, handle);
      if (!toolCalls.length && looksLooping(content)) { looped = true; try { await reader.cancel(); } catch {} break; }
    }
    if (!looped && buf.trim()) sseParse(buf + '\n', handle);
    if (looped) throw new Error('LOOP_DETECTED');
  }
  toolCalls = toolCalls.filter(Boolean);
  return { content, toolCalls, finish };
}
// A focused, tool-less LLM call for a supporting role (planner / supervisor). Returns plain text.
async function callRole(provider, system, user, signal) {
  const r = await callModel(provider, [{ role: 'system', content: system }, { role: 'user', content: user }], null, signal, () => {});
  return (r.content || '').replace(/<\/?tool_call>/gi, '').replace(/<\|im_(start|end)\|>/gi, '').trim();
}
const PLANNER_SYS = () => t('bg.plannerSys');
const SUPERVISOR_SYS = () => t('bg.supervisorSys');
function progressSummary(transcript, n = 16) {
  return transcript.slice(-n).map((e) => {
    if (e.t === 'user') return t('bg.sumUser') + String(e.text || '').slice(0, 140);
    if (e.t === 'assistant') return t('bg.sumExecutor') + String(e.text || '').slice(0, 160);
    if (e.t === 'tool') return `${t('bg.sumTool')}${e.name}(${JSON.stringify(e.args || {}).slice(0, 90)}) → ${String(e.result || '').replace(/\s+/g, ' ').slice(0, 160)}`;
    if (e.t === 'error') return t('bg.sumError') + String(e.text || '').slice(0, 140);
    if (e.t === 'role') return `[${e.role}] ${String(e.text || '').slice(0, 140)}`;
    return '';
  }).filter(Boolean).join('\n');
}
const jsonHint = () => t('bg.jsonHint');
// Detect degenerate repetition: the same ~100-char tail appearing 4+ times means the model is stuck in a loop.
function looksLooping(s) {
  if (!s || s.length < 1500) return false;
  const tail = s.slice(-100); if (tail.replace(/\s/g, '').length < 20) return false;
  let c = 0, i = 0; while ((i = s.indexOf(tail, i)) >= 0) { c++; i += tail.length; if (c >= 4) return true; }
  return false;
}
// Robustly parse tool-call arguments: models often emit trailing junk (extra "}", "<tool_call>", "<|im_end|>").
const safeJson = (s) => {
  if (typeof s !== 'string') return s && typeof s === 'object' ? s : {};
  const t = s.replace(/<\/?tool_call>/gi, '').replace(/<\|im_(start|end)\|>/gi, '').trim();
  if (!t) return {};
  const direct = looseParse(t); if (direct && typeof direct === 'object') return direct;
  const i = t.indexOf('{'); if (i >= 0) { const obj = extractObject(t, i); if (obj) { const p = looseParse(obj.json); if (p && typeof p === 'object') return p; } }
  return { _raw: s };
};

// Extract the balanced {...} object starting at index i (brace counting, string-aware). Returns {json, end} or null.
function extractObject(text, i) {
  let depth = 0, inStr = false, esc = false;
  for (let j = i; j < text.length; j++) {
    const c = text[j];
    if (inStr) { if (esc) esc = false; else if (c === '\\') esc = true; else if (c === '"') inStr = false; continue; }
    if (c === '"') inStr = true; else if (c === '{') depth++; else if (c === '}') { depth--; if (depth === 0) return { json: text.slice(i, j + 1), end: j + 1 }; }
  }
  return null;
}
// Tolerant JSON parse: handles trailing commas, extra closing braces, single quotes.
function looseParse(s) {
  const tries = [s, s.replace(/,\s*([}\]])/g, '$1'), s.replace(/\}+\s*$/, '}'), s.replace(/,\s*([}\]])/g, '$1').replace(/\}+\s*$/, '}')];
  for (const t of tries) { try { return JSON.parse(t); } catch {} }
  try { return JSON.parse(s.replace(/'/g, '"')); } catch {}
  return null;
}
const KNOWN_TOOLS = new Set(TOOLS.map((t) => t.function.name));
function toCall(o) {
  const name = o.tool || o.name || o.function || o.action;
  if (!name || !KNOWN_TOOLS.has(name)) return null;
  let args = o.args || o.arguments || o.parameters || o.params || o.input;
  if (args == null) { args = {}; for (const k of Object.keys(o)) if (!['tool', 'name', 'function', 'action', 'args', 'arguments', 'parameters', 'params', 'input'].includes(k)) args[k] = o[k]; }
  if (typeof args === 'string') args = looseParse(args) || {};
  return { id: 'call_' + Math.random().toString(36).slice(2, 10), type: 'function', function: { name, arguments: JSON.stringify(args) } };
}
// JSON-in-text tool mode: parse ```tool ... ``` fences OR bare {"tool":..}/{"name":..} objects, tolerating malformed JSON.
function parseJsonTools(text) {
  const calls = []; const spans = [];
  // 1) find candidate object starts: after ``` fences and at every {"tool"/"name"/"action"/"function": occurrence
  const re = /(?:```[a-z]*\s*)?(\{)\s*("?)(tool|name|action|function)\2\s*:/gi; let m;
  while ((m = re.exec(text))) {
    const start = text.indexOf('{', m.index);
    const obj = extractObject(text, start);
    if (!obj) continue;
    const o = looseParse(obj.json);
    if (o) { const c = toCall(o); if (c) { calls.push(c); spans.push([start, obj.end]); } }
    re.lastIndex = obj.end;
  }
  let rest = text;
  for (const [s, e] of spans.sort((a, b) => b[0] - a[0])) rest = rest.slice(0, s) + rest.slice(e);
  return { calls, rest: rest.replace(/```[a-z]*[\s{}]*```/g, '').replace(/^\s*[{}]\s*$/gm, '').trim() };
}

// ---------------- agent loop ----------------
const sessions = new Map(); // sessionId -> {messages, transcript, running, abort}
let panelPort = null;       // the currently-connected side panel (may change when the panel reopens)
let activeSessionId = null; // the session the panel should show
const msgSize = (m) => (typeof m.content === 'string' ? m.content.length : 2000) + (m.tool_calls ? JSON.stringify(m.tool_calls).length : 0);
function trimHistory(messages, maxChars = 120000) {
  let total = messages.reduce((n, m) => n + msgSize(m), 0);
  while (total > maxChars && messages.length > 3) {
    // Remove the oldest unit at index 1 (keep the original task at 0). An assistant with tool_calls is removed
    // together with its following tool responses, so we never orphan a 'tool' message.
    let count = 1; const m = messages[1];
    if (m && m.role === 'assistant' && m.tool_calls) { let j = 2; while (j < messages.length && messages[j].role === 'tool') { j++; count++; } }
    for (const x of messages.splice(1, count)) total -= msgSize(x);
    while (messages[1] && messages[1].role === 'tool') { total -= msgSize(messages[1]); messages.splice(1, 1); } // drop any leftover leading tool
  }
}
// Guarantee the API invariant: every 'tool' message follows an assistant whose tool_calls are ALL answered,
// and no assistant carries tool_calls without full responses. Prevents DeepSeek/OpenAI 400s after trimming.
function sanitizeForSend(msgs) {
  const keep = new Array(msgs.length).fill(false);
  for (let i = 0; i < msgs.length; i++) {
    const m = msgs[i];
    if (m.role === 'assistant' && m.tool_calls && m.tool_calls.length) {
      const answered = new Set();
      for (let j = i + 1; j < msgs.length && msgs[j].role === 'tool'; j++) answered.add(msgs[j].tool_call_id);
      keep[i] = m.tool_calls.every((tc) => answered.has(tc.id));
    }
  }
  const out = [];
  for (let i = 0; i < msgs.length; i++) {
    const m = msgs[i];
    if (m.role === 'assistant' && m.tool_calls && m.tool_calls.length) out.push(keep[i] ? m : { role: 'assistant', content: m.content || t('bg.interruptedCall') });
    else if (m.role === 'tool') { let k = i - 1; while (k >= 0 && msgs[k].role === 'tool') k--; if (k >= 0 && msgs[k].role === 'assistant' && keep[k]) out.push(m); }
    else out.push(m);
  }
  return out;
}
function postPanel(m) { if (panelPort) { try { panelPort.postMessage(m); return true; } catch {} } return false; }
// Record renderable events into a session transcript so a reopened/reconnected panel can rebuild the chat.
function recordTranscript(sess, m) {
  const tr = sess.transcript;
  if (m.type === 'user') tr.push({ t: 'user', text: m.text, images: m.images });
  else if (m.type === 'assistant_end') { if (m.text) tr.push({ t: 'assistant', text: m.text }); }
  else if (m.type === 'tool_start') tr.push({ t: 'tool', id: m.id, name: m.name, args: m.args, result: null, running: true });
  else if (m.type === 'tool_end') { const e = [...tr].reverse().find((x) => x.t === 'tool' && x.id === m.id); if (e) { e.result = m.result; e.running = false; } else tr.push({ t: 'tool', id: m.id, name: m.name, result: m.result, running: false }); }
  else if (m.type === 'image') tr.push({ t: 'image', dataUrl: m.dataUrl });
  else if (m.type === 'error') tr.push({ t: 'error', text: m.text });
  else if (m.type === 'role') tr.push({ t: 'role', role: m.role, text: m.text });
  if (tr.length > 400) tr.splice(0, tr.length - 400);
}
// Block the agent until the user clicks "Continue" (used by pause_for_human tool and by captcha auto-detect).
async function pauseAndWait(ctx, reason) {
  ctx.sess.pauseReason = reason;
  ctx.emit({ type: 'paused', reason });
  try { return (await new Promise((resolve, reject) => { ctx.sess.pendingHuman = { resolve, reject }; })) || ''; }
  finally { ctx.sess.pendingHuman = null; ctx.sess.pauseReason = null; ctx.emit({ type: 'resumed' }); }
}
function restorePayload(sessionId) {
  const sess = sessions.get(sessionId);
  return { type: 'restore', sessionId, transcript: sess ? sess.transcript : [], running: !!(sess && sess.abort), paused: (sess && sess.pendingHuman) ? (sess.pauseReason || '') : null };
}

// ---------------- session history (persisted so it survives SW restarts & lists in the panel) ----------------
async function loadStore() { try { const s = await chrome.storage.local.get('oa_sessions'); return s.oa_sessions || {}; } catch { return {}; } }
async function saveStore(obj) { try { await chrome.storage.local.set({ oa_sessions: obj }); } catch {} }
function sessTitle(sess) { const u = (sess.transcript || []).find((e) => e.t === 'user'); return sess.title || (u && u.text ? String(u.text).replace(/\s+/g, ' ').trim().slice(0, 64) : t('bg.newChat')); }
async function persistSession(sess) {
  if (!sess || !sess.id) return;
  if (!(sess.transcript || []).length) return; // don't store empty sessions
  const store = await loadStore();
  const prev = store[sess.id] || {};
  sess.title = sessTitle(sess);
  store[sess.id] = { id: sess.id, title: sess.title, pinned: sess.pinned ?? prev.pinned ?? false, updatedAt: Date.now(), transcript: sess.transcript || [], messages: sess.messages || [] };
  await prune(store, sess.id);
  await saveStore(store);
}
async function prune(store, keepId) {
  const s = await getSettings(); const limit = s.historyLimit;
  if (limit == null || limit >= 100) return; // ∞
  const nonPinned = Object.values(store).filter((x) => !x.pinned).sort((a, b) => b.updatedAt - a.updatedAt);
  const keep = new Set(nonPinned.slice(0, Math.max(0, limit)).map((x) => x.id)); // newest `limit` non-pinned
  for (const id of [keepId, activeSessionId]) if (id) keep.add(id); // never drop the current/active session
  for (const x of nonPinned) if (!keep.has(x.id)) delete store[x.id];
}
async function sessionsList() {
  const store = await loadStore();
  return Object.values(store)
    .map((s) => ({ id: s.id, title: s.title, pinned: !!s.pinned, updatedAt: s.updatedAt, active: s.id === activeSessionId }))
    .sort((a, b) => (b.pinned - a.pinned) || (b.updatedAt - a.updatedAt))
    .slice(0, 40);
}
async function loadSessionInto(id) {
  let sess = sessions.get(id);
  if (!sess) { const store = await loadStore(); const s = store[id]; if (!s) return null; sess = { id, title: s.title, pinned: s.pinned, transcript: s.transcript || [], messages: s.messages || [] }; sessions.set(id, sess); }
  return sess;
}

async function runAgent(port, sessionId, userText, images) {
  const settings = await getSettings();
  const provider = settings.providers.find((p) => p.id === settings.activeProvider) || settings.providers[0];
  if (!provider) { postPanel({ type: 'error', text: t('bg.noProvider') }); return; }
  let sess = sessions.get(sessionId); if (!sess) { sess = { messages: [], transcript: [], id: sessionId }; sessions.set(sessionId, sess); }
  if (!sess.transcript) sess.transcript = []; sess.id = sessionId;
  activeSessionId = sessionId; try { chrome.storage.session.set({ activeSessionId }); } catch {}
  const native = provider.toolMode !== 'json';
  const emit = (m) => { recordTranscript(sess, m); postPanel(m); }; // record for replay + send to whatever panel is live now
  recordTranscript(sess, { type: 'user', text: userText, images }); // record user turn (panel already showed it live; don't re-post)
  const ctx = { settings, provider, emit, pendingImage: null, sess };
  const anchor = await getAnchorTab(); if (anchor && !agentTabId) agentTabId = anchor.id;
  if (anchor && boundTabId == null && boundGroupId == null) await bindPanelToTab(anchor); // bind panel to the group it was launched in
  const tabsDesc = (await scopeTabs(settings)).map(fmtTab).join('\n');
  const activeTools = settings.humanPause ? TOOLS : TOOLS.filter((t) => t.function.name !== 'pause_for_human');
  const sys = SYSTEM_PROMPT(settings.scope, tabsDesc, provider.vision) + (native ? '' : '\n\n' + jsonToolPrompt(activeTools));
  const userContent = images?.length && provider.vision ? [{ type: 'text', text: userText }, ...images.map((u) => ({ type: 'image_url', image_url: { url: u } }))] : userText;
  sess.messages.push({ role: 'user', content: userContent });
  const abort = new AbortController(); sess.abort = abort;
  const supProvider = settings.providers.find((p) => p.id === settings.supervisorProviderId) || provider;
  let plan = '';
  if (settings.multiAgent) {
    try { plan = await callRole(supProvider, PLANNER_SYS(), t('bg.plannerUser', userText, tabsDesc), abort.signal); } catch {}
    if (abort.signal.aborted) { emit({ type: 'stopped' }); return; }
    if (plan) { emit({ type: 'role', role: 'planner', text: plan }); sess.messages.push({ role: 'user', content: t('bg.planInject', plan) }); }
  }
  let steps = 0, nudges = 0, lastSig = '', repeatCount = 0;
  try {
    while (steps++ < settings.maxSteps) {
      trimHistory(sess.messages, historyCharBudget(provider));
      const msgs = sanitizeForSend([{ role: 'system', content: sys }, ...sess.messages]);
      emit({ type: 'assistant_start' });
      let r;
      try { r = await callModel(provider, msgs, native ? activeTools : null, abort.signal, (d, reasoning) => emit({ type: 'delta', text: d, reasoning })); }
      catch (e) {
        if (abort.signal.aborted) { emit({ type: 'stopped' }); return; }
        if (String(e.message).includes('LOOP_DETECTED')) { emit({ type: 'assistant_end', text: '' }); emit({ type: 'error', text: t('bg.loopText') }); return; }
        throw e;
      }
      let { content, toolCalls } = r;
      // Fallback: even in native mode some models emit tool calls as ```tool {..}``` text instead of proper tool_calls.
      if (!toolCalls || !toolCalls.length) { const p = parseJsonTools(content); if (p.calls.length) { toolCalls = p.calls; content = p.rest; } }
      // Normalize arguments to strictly-valid JSON so one malformed tool call never poisons the history (→ endless 400s).
      for (const tc of toolCalls) tc.function.arguments = JSON.stringify(safeJson(tc.function.arguments));
      emit({ type: 'assistant_end', text: content });
      const assistantMsg = { role: 'assistant', content: content || '' }; if (native && toolCalls.length) assistantMsg.tool_calls = toolCalls; sess.messages.push(assistantMsg);
      if (!toolCalls.length) {
        // Model narrated an intent ("I'll open the page…") but didn't call any tool → nudge it once instead of silently stopping.
        const intent = !content || content.length < 400 || /(открo?ю|открыть|перейд|перейти|найд|нажм|нажать|кликн|клик|сделаю|сделаем|сделать|давай|нужно|надо|let me|i['’]?ll|i will|i'?m going|open|navigate|go to|click|search|next|далее|шаг)/i.test(content);
        if (intent && nudges < 2) {
          nudges++;
          emit({ type: 'tool_start', id: 'nudge' + steps, name: 'system', args: { note: t('bg.nudgeNote') } });
          emit({ type: 'tool_end', id: 'nudge' + steps, name: 'system', result: t('bg.nudgeResult', native ? ' (' + jsonHint() + ')' : '') });
          sess.messages.push({ role: 'user', content: t('bg.nudgeMsg', native ? '\n' + jsonHint() : '') });
          continue;
        }
        break;
      }
      let finished = false, roundErr = false; const roundResults = [];
      for (const tc of toolCalls) {
        if (abort.signal.aborted) { emit({ type: 'stopped' }); return; }
        const name = tc.function.name; const args = safeJson(tc.function.arguments);
        emit({ type: 'tool_start', id: tc.id, name, args });
        let result;
        try {
          if (args && args._raw !== undefined) throw new Error(t('bg.badArgs'));
          if (!toolImpl[name]) throw new Error(t('bg.unknownTool', name, Object.keys(toolImpl).join(', ')));
          result = await toolImpl[name](args, ctx); if (typeof result !== 'string') result = JSON.stringify(result);
        }
        catch (e) { result = 'ERROR: ' + (e.message || String(e)); }
        if (result.startsWith('ERROR')) roundErr = true;
        roundResults.push(name + ':' + result.slice(0, 120));
        emit({ type: 'tool_end', id: tc.id, name, result: result.slice(0, 4000) });
        // Cap what goes into history — a big read_page/get_text would otherwise blow the context on small models.
        const stored = result.length > 8000 ? result.slice(0, 8000) + t('bg.truncated', result.length - 8000) : result;
        if (native) sess.messages.push({ role: 'tool', tool_call_id: tc.id, name, content: stored });
        else sess.messages.push({ role: 'user', content: `[tool result for ${name}]\n${stored}` });
        if (name === 'done') finished = true;
        if (name === 'navigate' || name === 'new_tab' || name === 'switch_tab') sess.skipCaptchaUntilNav = false; // fresh page → captcha check re-armed
      }
      // Captcha auto-detect and 2Captcha auto-solve
      if (settings.autoCaptcha && !finished && !abort.signal.aborted && !sess.skipCaptchaUntilNav) {
        try {
          const t = await currentTab(settings);
          const cap = await cs(t.id, 'detect_captcha').catch(() => ({ found: false }));
          if (cap && cap.found) {
            if (settings.use2captcha && settings.captchaKey) {
              ctx.emit({ type: 'paused', reason: t('bg.captchaSolving', cap.type) });
              let solved = false;
              try {
                // Create task
                let method = 'userrecaptcha';
                if (cap.type.includes('hCaptcha')) method = 'hcaptcha';
                else if (cap.type.includes('Turnstile')) method = 'turnstile';
                
                const sitekeyParam = method === 'userrecaptcha' ? 'googlekey' : 'sitekey';
                if (!cap.sitekey) throw new Error(t('bg.captchaNoSitekey'));
                
                let res = await fetch(`https://2captcha.com/in.php?key=${settings.captchaKey}&method=${method}&${sitekeyParam}=${cap.sitekey}&pageurl=${encodeURIComponent(cap.url)}&json=1`).then(r => r.json());
                if (res.status === 1) {
                  const reqId = res.request;
                  let token = null;
                  for (let i = 0; i < 24; i++) {
                    await new Promise(r => setTimeout(r, 5000));
                    if (abort.signal.aborted) break;
                    let check = await fetch(`https://2captcha.com/res.php?key=${settings.captchaKey}&action=get&id=${reqId}&json=1`).then(r => r.json());
                    if (check.status === 1) { token = check.request; break; }
                  }
                  if (abort.signal.aborted) { emit({ type: 'stopped' }); return; }
                  
                  if (token) {
                    if (method === 'hcaptcha') {
                      await chrome.scripting.executeScript({ target: { tabId: t.id }, func: (tok) => { document.getElementsByName('h-captcha-response').forEach(e => e.innerHTML=tok); document.getElementsByName('g-recaptcha-response').forEach(e => e.innerHTML=tok); }, args: [token] });
                    } else if (method === 'turnstile') {
                      await chrome.scripting.executeScript({ target: { tabId: t.id }, func: (tok) => { document.getElementsByName('cf-turnstile-response').forEach(e => e.value=tok); }, args: [token] });
                    } else {
                      await chrome.scripting.executeScript({ target: { tabId: t.id }, func: (tok) => { const el = document.getElementById('g-recaptcha-response'); if(el) el.innerHTML=tok; }, args: [token] });
                    }
                    sess.messages.push({ role: 'user', content: t('bg.captchaSolvedMsg', cap.type) });
                    sess.skipCaptchaUntilNav = true;
                    solved = true;
                  } else {
                    throw new Error(t('bg.captchaTimeout'));
                  }
                } else {
                  throw new Error(t('bg.captchaInErr', res.request));
                }
              } catch(e) {
                emit({ type: 'role', role: 'supervisor', text: `{"status":"continue","note":${JSON.stringify(t('bg.captchaAutoErr', e.message))}}` });
              } finally {
                ctx.emit({ type: 'resumed' });
              }
              if (solved) continue; // Skip manual fallback if solved
            }
            
            // Fallback to manual solving (if 2captcha disabled, or if it failed)
            await pauseAndWait(ctx, t('bg.captchaManual', cap.type));
            if (abort.signal.aborted) { emit({ type: 'stopped' }); return; }
            sess.messages.push({ role: 'user', content: t('bg.captchaManualMsg', cap.type) });
            sess.skipCaptchaUntilNav = true;
          }
        } catch (e) {
          emit({ type: 'role', role: 'supervisor', text: `{"status":"continue","note":${JSON.stringify(t('bg.captchaAutoErr2', e.message))}}` });
        }
      }
      if (ctx.pendingImage && provider.vision) { sess.messages.push({ role: 'user', content: [{ type: 'text', text: '[screenshot of the current viewport]' }, { type: 'image_url', image_url: { url: ctx.pendingImage } }] }); ctx.pendingImage = null; }
      // ---- anti-loop: same action(s) AND same result repeated with no progress (model-agnostic) ----
      const sig = toolCalls.map((t) => t.function.name + t.function.arguments).join('|') + '||' + roundResults.join('~');
      const repeated = sig && sig === lastSig; lastSig = sig;
      repeatCount = repeated ? repeatCount + 1 : 0;
      if (!finished && repeatCount === 2) {
        emit({ type: 'tool_start', id: 'loop' + steps, name: 'system', args: { note: t('bg.loopNote') } });
        emit({ type: 'tool_end', id: 'loop' + steps, name: 'system', result: t('bg.loopResult') });
        sess.messages.push({ role: 'user', content: t('bg.loopMsg') });
      }
      if (!finished && repeatCount >= 4) { emit({ type: 'error', text: t('bg.loopStop') }); break; }
      // Supervisor: an OBSERVER. It only injects a course-correction when there is a concrete stuck signal
      // (repeated identical action or errors). On routine checks it may only note an observation — never a directive,
      // and never "start over" (it sees only a recent window, so it must not police order or redo completed work).
      if (settings.multiAgent && !finished) {
        const stuck = roundErr || repeated;
        if (stuck || steps % settings.supervisorEvery === 0) {
          let sup = '';
          try { sup = await callRole(supProvider, SUPERVISOR_SYS(), t('bg.supervisorUser', userText, plan, stuck, progressSummary(sess.transcript)), abort.signal); } catch {}
          if (abort.signal.aborted) { emit({ type: 'stopped' }); return; }
          const v = safeJson(sup);
          if (v && v._raw === undefined && v.note) emit({ type: 'role', role: 'supervisor', text: v.note });
          // Only act on a redirect when there was a real stuck signal — and phrase it as a suggestion, not an order.
          if (stuck && v && v.status === 'redirect' && v.instruction) {
            sess.messages.push({ role: 'user', content: t('bg.supervisorHint', v.note, v.instruction) });
            nudges = 0;
          }
        }
      }
      if (finished) break;
    }
    if (steps >= settings.maxSteps) emit({ type: 'error', text: t('bg.maxSteps', settings.maxSteps) });
  } catch (e) { emit({ type: 'error', text: e.message || String(e) }); }
  finally { sess.abort = null; await persistSession(sess); emit({ type: 'turn_end' }); }
}

chrome.runtime.onConnect.addListener((port) => {
  if (port.name !== 'panel') return;
  panelPort = port; // this is now the live panel; agent output is routed here
  port.onDisconnect.addListener(() => { if (panelPort === port) panelPort = null; });
  port.onMessage.addListener(async (msg) => {
    if (msg.type === 'hello') {
      const a = await getAnchorTab(); if (a) await bindPanelToTab(a); // panel opened → bind to the tab it was summoned on
      port.postMessage({ type: 'bound' });
      if (!activeSessionId) { try { const s = await chrome.storage.session.get('activeSessionId'); activeSessionId = s.activeSessionId || null; } catch {} }
      if (activeSessionId) { await loadSessionInto(activeSessionId); port.postMessage(restorePayload(activeSessionId)); } // rebuild ongoing/last task
    }
    else if (msg.type === 'send') { panelPort = port; runAgent(port, msg.sessionId, msg.text, msg.images); }
    else if (msg.type === 'stop') { const s = sessions.get(msg.sessionId) || sessions.get(activeSessionId); s?.abort?.abort(); }
    else if (msg.type === 'reset') { const s = sessions.get(msg.sessionId); if (s) await persistSession(s); sessions.delete(msg.sessionId); if (activeSessionId === msg.sessionId) { activeSessionId = null; try { chrome.storage.session.remove('activeSessionId'); } catch {} } agentTabId = null; await detachAll(); const a = await getAnchorTab(); if (a) await bindPanelToTab(a); port.postMessage({ type: 'reset_ok' }); }
    else if (msg.type === 'set_agent_tab') { agentTabId = msg.tabId; }
    else if (msg.type === 'resume') { if (activeSessionId) { await loadSessionInto(activeSessionId); port.postMessage(restorePayload(activeSessionId)); } }
    else if (msg.type === 'sessions_list') { port.postMessage({ type: 'sessions', items: await sessionsList() }); }
    else if (msg.type === 'session_load') { const sess = await loadSessionInto(msg.id); if (sess) { activeSessionId = msg.id; try { chrome.storage.session.set({ activeSessionId }); } catch {} port.postMessage(restorePayload(msg.id)); } }
    else if (msg.type === 'session_pin') { const store = await loadStore(); if (store[msg.id]) { store[msg.id].pinned = !store[msg.id].pinned; const live = sessions.get(msg.id); if (live) live.pinned = store[msg.id].pinned; await saveStore(store); } port.postMessage({ type: 'sessions', items: await sessionsList() }); }
    else if (msg.type === 'session_delete') { const store = await loadStore(); delete store[msg.id]; await saveStore(store); sessions.delete(msg.id); port.postMessage({ type: 'sessions', items: await sessionsList() }); }
    else if (msg.type === 'session_delete_current') { const id = msg.sessionId || activeSessionId; if (id) { const s = sessions.get(id); s?.abort?.abort(); const store = await loadStore(); delete store[id]; await saveStore(store); sessions.delete(id); if (activeSessionId === id) { activeSessionId = null; try { chrome.storage.session.remove('activeSessionId'); } catch {} } } port.postMessage({ type: 'reset_ok' }); }
    else if (msg.type === 'human_continue') { const s = sessions.get(msg.sessionId) || sessions.get(activeSessionId); if (s && s.pendingHuman) { s.pendingHuman.resolve(msg.note || ''); s.pendingHuman = null; } }
    else if (msg.type === 'human_cancel') { const s = sessions.get(msg.sessionId) || sessions.get(activeSessionId); if (s && s.pendingHuman) { s.pendingHuman.reject(new Error(t('bg.humanCancel'))); s.pendingHuman = null; } s?.abort?.abort(); }
    else if (msg.type === 'ping') { /* keepalive: receiving a port message resets the service-worker idle timer while paused */ }
  });
});
async function handlePanel(msg, sendResponse) {
  try {
    if (msg.action === 'scope') { const s = await getSettings(); const tabs = await scopeTabs(s); sendResponse({ ok: true, tabs: tabs.map((t) => ({ id: t.id, title: t.title, url: t.url, active: t.active, agent: t.id === agentTabId })), scope: s.scope, bound: (boundGroupId != null || boundTabId != null), boundToGroup: boundGroupId != null }); }
    else if (msg.action === 'active_scope') {
      const s = await getSettings();
      const [t] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
      const bound = boundGroupId != null || boundTabId != null;
      const url = t?.url || '';
      const neutral = !t || url === '' || /^(chrome|edge|about|chrome-extension|devtools|view-source):/i.test(url); // extension/settings pages don't count
      const inScope = neutral ? true : panelTabInScope(t, s.scope);
      sendResponse({ ok: true, bound, inScope, boundToGroup: boundGroupId != null, groupTitle: await boundGroupTitle(), scope: s.scope });
    }
    else if (msg.action === 'rebind') { const a = await getAnchorTab(); if (a) await bindPanelToTab(a); sendResponse({ ok: true }); }
    else if (msg.action === 'unbind') { boundGroupId = boundWindowId = boundTabId = null; try { await chrome.storage.session.remove(['boundGroupId', 'boundWindowId', 'boundTabId']); } catch {} sendResponse({ ok: true }); }
    else if (msg.action === 'test_provider') { const p = msg.provider; const r = await callModel(p, [{ role: 'user', content: 'Reply with the single word OK.' }], null, undefined, () => {}); sendResponse({ ok: true, text: r.content }); }
    else if (msg.action === 'list_models') { const p = msg.provider; const base = p.baseUrl.replace(/\/+$/, ''); let url, headers; if (p.protocol === 'anthropic') { url = base + (base.endsWith('/v1') ? '/models' : '/v1/models'); headers = { 'anthropic-version': '2023-06-01', 'anthropic-dangerous-direct-browser-access': 'true' }; if (p.apiKey) headers['x-api-key'] = p.apiKey; } else { headers = p.apiKey ? { Authorization: 'Bearer ' + p.apiKey } : {}; url = p.protocol === 'ollama' ? base + '/api/tags' : base + '/models'; } const res = await fetch(url, { headers }); if (!res.ok) throw new Error('HTTP ' + res.status + ' ' + (await res.text()).slice(0, 200)); const j = await res.json(); const models = p.protocol === 'ollama' ? (j.models || []).map((m) => m.name) : (j.data || j.models || []).map((m) => m.id || m.name || m); sendResponse({ ok: true, models }); }
    else sendResponse({ ok: false, error: 'unknown action' });
  } catch (e) { sendResponse({ ok: false, error: e.message || String(e) }); }
}


