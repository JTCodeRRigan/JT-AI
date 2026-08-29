import { t, initI18n, applyI18n } from './i18n.js';
const $ = (s) => document.querySelector(s);
const chat = $('#chat'), input = $('#input'), sendBtn = $('#send'), stopBtn = $('#stop');
let sessionId = 's' + Date.now();
let port, curAssistant, curOuter, curReasoning, pendingImages = [];
const toolEls = new Map();
let providers = [], activeProviderId = null;
const emptyHtml = () => `<div class="empty"><div class="tile"><svg viewBox="0 0 24 24"><path d="M5 3l14 8-6 1.5L16 20l-2.5 1-3-7.5L5 18z"/></svg></div><b>${esc(t('panel.emptyTitle'))}</b><div>${esc(t('panel.emptyBody'))}</div></div>`;

function connect() {
  port = chrome.runtime.connect({ name: 'panel' });
  port.onMessage.addListener(onMsg);
  port.onDisconnect.addListener(() => setTimeout(connect, 300));
  try { port.postMessage({ type: 'hello' }); } catch {}
}
connect();

// close itself when the active tab leaves the group it was summoned in
async function checkScope() {
  const r = await chrome.runtime.sendMessage({ type: 'panel', action: 'active_scope' }).catch(() => null);
  if (r?.ok && r.bound && !r.inScope) window.close();
}
chrome.tabs.onActivated.addListener(() => setTimeout(checkScope, 30));
chrome.tabs.onUpdated.addListener((id, ch) => { if (ch.groupId !== undefined) checkScope(); });
if (chrome.windows?.onFocusChanged) chrome.windows.onFocusChanged.addListener(() => setTimeout(checkScope, 30));

const esc = (s) => String(s ?? '').replace(/[&<>]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c]));
function md(s) {
  let h = esc(s);
  h = h.replace(/```(\w*)\n([\s\S]*?)```/g, (m, l, c) => `<pre><code>${c}</code></pre>`).replace(/`([^`\n]+)`/g, '<code>$1</code>').replace(/\*\*([^*]+)\*\*/g, '<b>$1</b>').replace(/(https?:\/\/[^\s<)]+)/g, '<a href="$1" target="_blank">$1</a>');
  return h;
}
function add(cls, html) { $('.empty')?.remove(); const d = document.createElement('div'); d.className = 'msg ' + cls; d.innerHTML = html; chat.appendChild(d); chat.scrollTop = chat.scrollHeight; return d; }
function clampToggle(el) { el.addEventListener('click', (e) => { if (e.target.closest('a')) return; if (el.classList.contains('clampable')) el.classList.toggle('expanded'); }); }
// Drop the clamp when the content fits anyway (so short messages show no "…" and aren't clickable).
function maybeClamp(outer) { const b = outer && outer.querySelector('.body'); if (!b) return; requestAnimationFrame(() => { if (b.scrollHeight <= b.clientHeight + 2) outer.classList.remove('clampable'); }); }

// ---- assistant bubble (clampable to 2 lines) ----
function newAssistant() {
  const outer = add('assistant clampable', '<div class="body"></div>');
  curOuter = outer; curAssistant = outer.querySelector('.body'); curAssistant._raw = ''; curReasoning = null;
  clampToggle(outer);
  return curAssistant;
}
function ensureAssistant() { if (!curAssistant || !curAssistant.isConnected) newAssistant(); return curAssistant; }

// ---- tool call (single line, expands on click via <details>) ----
function addTool(id, name, args, running, result) {
  const d = document.createElement('details'); d.className = 'tool' + (running ? ' running' : '');
  d.innerHTML = `<summary><b>${esc(name)}</b> <span>${esc(JSON.stringify(args || {})).slice(0, 200)}</span></summary><pre></pre>`;
  chat.appendChild(d); if (id) toolEls.set(id, d);
  if (result != null) { if (String(result).startsWith('ERROR')) d.classList.add('err'); d.querySelector('pre').textContent = result; }
  chat.scrollTop = chat.scrollHeight; return d;
}

// ---- role cards ----
const ROLE_ICON = { planner: '<circle cx="12" cy="12" r="9"/><path d="M16 8l-2.5 5.5L8 16l2.5-5.5z"/>', supervisor: '<path d="M2 12s4-7 10-7 10 7 10 7-4 7-10 7-10-7-10-7z"/><circle cx="12" cy="12" r="3"/>' };
const roleName = (r) => (r === 'planner' ? t('role.planner') : r === 'supervisor' ? t('role.supervisor') : r);
function addRole(role, text) {
  const clamp = role !== 'supervisor'; // supervisor is always fully visible
  const d = add('role role-' + esc(role) + (clamp ? ' clampable' : ''), `<b><svg viewBox="0 0 24 24">${ROLE_ICON[role] || ''}</svg>${roleName(role)}</b><div class="body">${md(text || '')}</div>`);
  if (clamp) { clampToggle(d); maybeClamp(d); }
  return d;
}

// ---- final report (done) ----
const DOC_ICON = '<path d="M14 3H6a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V9z"/><path d="M14 3v6h6"/><path d="M9 13h6M9 17h6"/>';
const isReport = (s) => { s = s || ''; return s.length > 140 || /(^|\n)#{1,6}\s|\n\s*[-*]\s|\n\s*\d+\.\s/.test(s); };
function mdInline(t) { return esc(t).replace(/`([^`]+)`/g, '<code>$1</code>').replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>').replace(/(https?:\/\/[^\s<)]+)/g, '<a href="$1" target="_blank">$1</a>'); }
function mdFull(s) {
  const lines = String(s || '').split('\n'); let html = '', list = null, inCode = false, code = '';
  const closeList = () => { if (list) { html += `</${list}>`; list = null; } };
  for (const raw of lines) {
    if (/^```/.test(raw)) { if (inCode) { html += `<pre><code>${esc(code)}</code></pre>`; inCode = false; code = ''; } else { closeList(); inCode = true; code = ''; } continue; }
    if (inCode) { code += raw + '\n'; continue; }
    const h = raw.match(/^(#{1,6})\s+(.*)/); if (h) { closeList(); html += `<h${h[1].length}>${mdInline(h[2])}</h${h[1].length}>`; continue; }
    const ul = raw.match(/^\s*[-*]\s+(.*)/); if (ul) { if (list !== 'ul') { closeList(); html += '<ul>'; list = 'ul'; } html += `<li>${mdInline(ul[1])}</li>`; continue; }
    const ol = raw.match(/^\s*\d+\.\s+(.*)/); if (ol) { if (list !== 'ol') { closeList(); html += '<ol>'; list = 'ol'; } html += `<li>${mdInline(ol[1])}</li>`; continue; }
    if (raw.trim() === '') { closeList(); continue; }
    closeList(); html += `<p>${mdInline(raw)}</p>`;
  }
  if (inCode) html += `<pre><code>${esc(code)}</code></pre>`; closeList();
  return html;
}
function addDone(summary) {
  summary = summary || '';
  if (!isReport(summary)) { const o = add('assistant clampable', `<div class="body">${md(summary)}</div>`); clampToggle(o); maybeClamp(o); return o; }
  const d = add('report', `<div class="rhead"><svg viewBox="0 0 24 24">${DOC_ICON}</svg>${esc(t('panel.reportReady'))}</div><button class="viewreport">${esc(t('panel.viewReport'))}</button>`);
  d._report = summary;
  d.querySelector('.viewreport').onclick = () => openReport(summary);
  return d;
}
function openReport(text) { $('#reportBody').innerHTML = mdFull(text); const m = $('#reportModal'); m._text = text; m.hidden = false; $('#reportBody').scrollTop = 0; }
$('#reportClose').onclick = () => { $('#reportModal').hidden = true; };
$('#reportCopy').onclick = async () => { try { await navigator.clipboard.writeText($('#reportModal')._text || ''); const b = $('#reportCopy'), prev = b.textContent; b.textContent = t('panel.copied'); setTimeout(() => (b.textContent = prev), 900); } catch {} };

function renderTranscript(tr) {
  chat.innerHTML = ''; toolEls.clear(); curAssistant = null; curReasoning = null;
  if (!tr || !tr.length) { chat.innerHTML = emptyHtml(); return; }
  for (const e of tr) {
    if (e.t === 'user') add('user', esc(e.text || '') + (e.images || []).map((u) => `<img src="${u}">`).join(''));
    else if (e.t === 'assistant') { const o = add('assistant clampable', `<div class="body">${md(e.text || '')}</div>`); clampToggle(o); maybeClamp(o); }
    else if (e.t === 'tool') { if (e.name === 'done') addDone((e.args && e.args.summary) || e.result); else addTool(e.id, e.name, e.args, e.running, e.result); }
    else if (e.t === 'image') add('assistant', `<img src="${e.dataUrl}">`);
    else if (e.t === 'error') add('error', esc(e.text || ''));
    else if (e.t === 'role') addRole(e.role, e.text);
  }
  chat.scrollTop = chat.scrollHeight;
}

function onMsg(m) {
  if (m.type === 'restore') { sessionId = m.sessionId || sessionId; renderTranscript(m.transcript); busy(!!m.running); if (m.paused != null) showCaptcha(m.paused); else hideCaptcha(); }
  else if (m.type === 'assistant_start') { newAssistant(); }
  else if (m.type === 'delta') { ensureAssistant(); if (m.reasoning) { if (!curReasoning) { curReasoning = document.createElement('div'); curReasoning.className = 'reasoning'; curOuter.before(curReasoning); } curReasoning.textContent += m.reasoning; } if (m.text) { curAssistant._raw = (curAssistant._raw || '') + m.text; curAssistant.textContent = curAssistant._raw; } chat.scrollTop = chat.scrollHeight; }
  else if (m.type === 'assistant_end') { const a = ensureAssistant(); if (m.text) { a.innerHTML = md(m.text); maybeClamp(curOuter); } else if (!a._raw) curOuter.remove(); curAssistant = null; }
  else if (m.type === 'tool_start') { if (m.name === 'done') { addDone(m.args && m.args.summary); } else { addTool(m.id, m.name, m.args, true); busy(true); } }
  else if (m.type === 'tool_end') { if (m.name === 'done') return; const d = toolEls.get(m.id); if (d) { d.classList.remove('running'); if (String(m.result).startsWith('ERROR')) d.classList.add('err'); d.querySelector('pre').textContent = m.result; } else addTool(m.id, m.name, {}, false, m.result); }
  else if (m.type === 'image') { add('assistant', `<img src="${m.dataUrl}">`); }
  else if (m.type === 'role') { addRole(m.role, m.text); }
  else if (m.type === 'error') { add('error', esc(m.text)); }
  else if (m.type === 'stopped') { add('error', t('panel.stopped')); busy(false); hideCaptcha(); }
  else if (m.type === 'turn_end') { busy(false); hideCaptcha(); }
  else if (m.type === 'reset_ok') { chat.innerHTML = emptyHtml(); toolEls.clear(); curAssistant = null; hideCaptcha(); }
  else if (m.type === 'paused') { showCaptcha(m.reason); busy(true); }
  else if (m.type === 'resumed') { hideCaptcha(); }
  else if (m.type === 'sessions') { renderSessions(m.items); }
}
let heartTimer = null;
function buildHearts() { const t = $('#statusTrack'); const w = t.clientWidth || 300; const n = Math.max(8, Math.floor(w / 9)); t.innerHTML = ''; for (let i = 0; i < n; i++) { const h = document.createElement('i'); h.textContent = '❥'; t.appendChild(h); } return [...t.children]; }
function startHearts() { stopHearts(); const hs = buildHearts(); let lit = 0; heartTimer = setInterval(() => { lit = (lit + 1) % (hs.length + 4); hs.forEach((h, i) => h.classList.toggle('on', i < lit)); }, 70); }
function stopHearts() { if (heartTimer) { clearInterval(heartTimer); heartTimer = null; } [...$('#statusTrack').children].forEach((h) => h.classList.remove('on')); }
function busy(b) { sendBtn.hidden = b; stopBtn.hidden = !b; input.disabled = b; $('#statusBar').hidden = !b; if (b) startHearts(); else stopHearts(); }
function autoGrow() { if (input.closest('.field').classList.contains('big')) return; input.style.height = 'auto'; input.style.height = Math.min(input.scrollHeight + 2, 200) + 'px'; } // +2 for the border (border-box)
input.addEventListener('input', autoGrow);
$('#expand').onclick = () => { const big = input.closest('.field').classList.toggle('big'); if (!big) autoGrow(); input.focus(); };

function send() {
  const text = input.value.trim(); if (!text) return;
  add('user', esc(text) + pendingImages.map((u) => `<img src="${u}">`).join(''));
  port.postMessage({ type: 'send', sessionId, text, images: pendingImages });
  pendingImages = []; $('#attachments').innerHTML = ''; input.value = ''; input.closest('.field').classList.remove('big'); input.style.height = ''; busy(true);
}
sendBtn.onclick = send;
input.addEventListener('keydown', (e) => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); send(); } });
stopBtn.onclick = () => port.postMessage({ type: 'stop', sessionId });
$('#newChat').onclick = () => { port.postMessage({ type: 'reset', sessionId }); sessionId = 's' + Date.now(); toolEls.clear(); };
$('#settings').onclick = () => chrome.runtime.openOptionsPage();
$('#attach').onclick = () => $('#file').click();
$('#file').onchange = async (e) => { for (const f of e.target.files) { const u = await new Promise((r) => { const fr = new FileReader(); fr.onload = () => r(fr.result); fr.readAsDataURL(f); }); pendingImages.push(u); const img = document.createElement('img'); img.src = u; $('#attachments').appendChild(img); } e.target.value = ''; };
input.addEventListener('paste', (e) => { for (const it of e.clipboardData.items) if (it.type.startsWith('image/')) { const f = it.getAsFile(); const fr = new FileReader(); fr.onload = () => { pendingImages.push(fr.result); const img = document.createElement('img'); img.src = fr.result; $('#attachments').appendChild(img); }; fr.readAsDataURL(f); } });

// ---- captcha / pause bar ----
let pingTimer = null;
function showCaptcha(reason) { $('#captchaText').textContent = reason || t('panel.captchaDefault'); $('#captchaBar').hidden = false; $('#statusBar').hidden = true; if (!pingTimer) pingTimer = setInterval(() => { try { port.postMessage({ type: 'ping' }); } catch {} }, 20000); }
function hideCaptcha() { $('#captchaBar').hidden = true; if (pingTimer) { clearInterval(pingTimer); pingTimer = null; } }
$('#capContinue').onclick = () => { hideCaptcha(); try { port.postMessage({ type: 'human_continue', sessionId }); } catch {} };
$('#capCancel').onclick = () => { hideCaptcha(); try { port.postMessage({ type: 'human_cancel', sessionId }); } catch {} };

// ---- confirm dialog ----
function confirmBox(text) {
  return new Promise((res) => {
    $('#confirmText').textContent = text; $('#confirm').hidden = false;
    const yes = $('#confirmYes'), no = $('#confirmNo');
    const done = (v) => { $('#confirm').hidden = true; yes.onclick = no.onclick = null; res(v); };
    yes.onclick = () => done(true); no.onclick = () => done(false);
  });
}

// ---- trash: delete current session ----
$('#trashBtn').onclick = async () => {
  if (!(await confirmBox(t('panel.confirmDeleteSession')))) return;
  port.postMessage({ type: 'session_delete_current', sessionId });
  sessionId = 's' + Date.now(); toolEls.clear();
};

// ---- copy whole chat ----
$('#copyBtn').onclick = async () => {
  const lines = [];
  for (const el of chat.children) {
    if (el.classList.contains('user')) lines.push(t('panel.you') + el.textContent.trim());
    else if (el.classList.contains('role')) { const label = el.querySelector('b')?.textContent.trim(); lines.push(`[${label}] ` + (el.querySelector('.body')?.textContent.trim() || '')); }
    else if (el.classList.contains('assistant')) { const txt = (el.querySelector('.body') || el).textContent.trim(); if (txt) lines.push(t('panel.agent') + txt); }
    else if (el.tagName === 'DETAILS') { const name = el.querySelector('b')?.textContent.trim(); const args = el.querySelector('summary span')?.textContent.trim() || ''; const out = el.querySelector('pre')?.textContent.trim(); lines.push(`[${name}] ${args}${out ? '\n' + out : ''}`); }
    else if (el.classList.contains('report')) lines.push(t('panel.reportHeader') + '\n' + (el._report || ''));
    else if (el.classList.contains('error')) lines.push('⚠ ' + el.textContent.trim());
  }
  const text = lines.join('\n\n');
  try { await navigator.clipboard.writeText(text); const b = $('#copyBtn'); b.classList.add('active'); setTimeout(() => b.classList.remove('active'), 700); } catch {}
};

// ---- model menu ----
const menus = { model: $('#modelMenu'), sessions: $('#sessionsMenu') };
function closeMenus(except) { for (const [k, el] of Object.entries(menus)) if (k !== except) el.hidden = true; }
document.addEventListener('click', (e) => { if (!e.target.closest('#modelMenu,#modelBtn,#sessionsMenu,#sessionsBtn')) closeMenus(); });

async function loadProviders() {
  const s = await chrome.storage.local.get(['providers', 'activeProvider']);
  providers = s.providers || []; activeProviderId = s.activeProvider || (providers[0] && providers[0].id) || null;
}
function renderModelMenu() {
  const el = menus.model;
  el.innerHTML = providers.length
    ? providers.map((p) => `<div class="mi${p.id === activeProviderId ? ' active' : ''}" data-id="${esc(p.id)}"><span class="name">${esc(p.name || p.model)}</span><span class="sub">${esc(p.model)}</span></div>`).join('')
    : `<div class="empty-menu">${esc(t('panel.noModels'))}</div>`;
  el.querySelectorAll('[data-id]').forEach((d) => (d.onclick = async () => { activeProviderId = d.dataset.id; await chrome.storage.local.set({ activeProvider: activeProviderId }); renderModelMenu(); closeMenus(); }));
}
$('#modelBtn').onclick = async (e) => { e.stopPropagation(); const el = menus.model; const willOpen = el.hidden; closeMenus(); if (willOpen) { await loadProviders(); renderModelMenu(); el.hidden = false; } };
chrome.storage.onChanged.addListener((c) => { if (c.providers || c.activeProvider) loadProviders(); });

// ---- sessions menu ----
const timeAgo = (ts) => { const s = (Date.now() - ts) / 1000; if (s < 60) return t('time.now'); if (s < 3600) return t('time.min', Math.floor(s / 60)); if (s < 86400) return t('time.hour', Math.floor(s / 3600)); return t('time.day', Math.floor(s / 86400)); };
function renderSessions(items) {
  const el = menus.sessions;
  el.innerHTML = items && items.length
    ? items.map((s) => `<div class="mi${s.active ? ' active' : ''}" data-id="${esc(s.id)}">
        <button class="iconbtn star${s.pinned ? ' on' : ''}" data-act="pin" title="${esc(t('panel.pin'))}"><svg viewBox="0 0 24 24"><path d="M12 2l3 6.5 7 .9-5 4.8 1.3 7-6.3-3.4L5.7 21l1.3-7-5-4.8 7-.9z"/></svg></button>
        <span class="name" data-act="load">${esc(s.title || t('session.untitled'))}</span>
        <span class="sub">${timeAgo(s.updatedAt)}</span>
        <button class="iconbtn" data-act="del" title="${esc(t('panel.delete'))}"><svg viewBox="0 0 24 24"><path d="M6 6l12 12M18 6L6 18"/></svg></button>
      </div>`).join('')
    : `<div class="empty-menu">${esc(t('panel.historyEmpty'))}</div>`;
  el.querySelectorAll('.mi').forEach((d) => {
    const id = d.dataset.id;
    d.onclick = () => { sessionId = id; port.postMessage({ type: 'session_load', id }); closeMenus(); }; // click anywhere on the row loads it
    d.querySelector('[data-act=pin]').onclick = (e) => { e.stopPropagation(); port.postMessage({ type: 'session_pin', id }); };
    d.querySelector('[data-act=del]').onclick = (e) => { e.stopPropagation(); port.postMessage({ type: 'session_delete', id }); };
  });
}
$('#sessionsBtn').onclick = (e) => { e.stopPropagation(); const el = menus.sessions; const willOpen = el.hidden; closeMenus(); if (willOpen) { el.innerHTML = `<div class="empty-menu">${esc(t('panel.loading'))}</div>`; el.hidden = false; port.postMessage({ type: 'sessions_list' }); } };

loadProviders();
await initI18n();
applyI18n(document);
chat.innerHTML = emptyHtml();
// re-localize static chrome + empty state if the language changes while the panel is open
chrome.storage.onChanged.addListener((c, area) => { if (area === 'local' && c.lang) { applyI18n(document); if ($('.empty')) chat.innerHTML = emptyHtml(); } });
