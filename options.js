import { t, initI18n, applyI18n, setLang, getLang } from './i18n.js';
const $ = (s) => document.querySelector(s);
const PRESETS = [
  { name: 'Runpod Serverless (vLLM)', protocol: 'openai', baseUrl: 'https://api.runpod.ai/v2/<ENDPOINT_ID>/openai/v1', model: '', toolMode: 'native' },
  { name: 'Runpod Pod (vLLM/TGI)', protocol: 'openai', baseUrl: 'https://<POD_ID>-8000.proxy.runpod.net/v1', model: '', toolMode: 'native' },
  { name: 'Venice', protocol: 'openai', baseUrl: 'https://api.venice.ai/api/v1', model: 'llama-3.3-70b', toolMode: 'native' },
  { name: 'DeepInfra', protocol: 'openai', baseUrl: 'https://api.deepinfra.com/v1/openai', model: 'Qwen/Qwen2.5-72B-Instruct', toolMode: 'native' },
  { name: 'OpenRouter', protocol: 'openai', baseUrl: 'https://openrouter.ai/api/v1', model: 'qwen/qwen-2.5-72b-instruct', toolMode: 'native' },
  { name: 'OpenAI', protocol: 'openai', baseUrl: 'https://api.openai.com/v1', model: 'gpt-4o-mini', toolMode: 'native', vision: true },
  { name: 'Anthropic (Claude)', protocol: 'anthropic', baseUrl: 'https://api.anthropic.com', model: 'claude-opus-5', toolMode: 'native', vision: true },
  { name: 'Ollama (local)', protocol: 'ollama', baseUrl: 'http://localhost:11434', model: 'qwen2.5:14b', toolMode: 'native' },
  { name: 'Ollama via OpenAI API', protocol: 'openai', baseUrl: 'http://localhost:11434/v1', model: 'qwen2.5:14b', toolMode: 'native' },
  { name: 'LM Studio (local)', protocol: 'openai', baseUrl: 'http://localhost:1234/v1', model: '', toolMode: 'native' },
  { name: 'llama.cpp server', protocol: 'openai', baseUrl: 'http://localhost:8080/v1', model: 'default', toolMode: 'native' },
  { name: 'vLLM (local)', protocol: 'openai', baseUrl: 'http://localhost:8000/v1', model: '', toolMode: 'native' },
  { name: 'text-generation-webui', protocol: 'openai', baseUrl: 'http://localhost:5000/v1', model: 'default', toolMode: 'json' },
  { name: 'KoboldCpp', protocol: 'openai', baseUrl: 'http://localhost:5001/v1', model: 'koboldcpp', toolMode: 'json' },
];
const FIELDS = ['name', 'protocol', 'baseUrl', 'apiKey', 'model', 'toolMode', 'vision', 'temperature', 'maxTokens', 'numCtx', 'frequencyPenalty', 'presencePenalty', 'repeatPenalty', 'extraHeaders', 'extraBody'];
let providers = [], active = null, editing = null;

async function load() {
  const s = await chrome.storage.local.get(['providers', 'activeProvider', 'scope', 'useDebugger', 'maxSteps', 'multiAgent', 'supervisorProviderId', 'supervisorEvery', 'autoCaptcha', 'use2captcha', 'captchaKey', 'historyLimit']);
  providers = s.providers || []; active = s.activeProvider || null;
  $('#g_scope').value = s.scope || 'group'; $('#g_useDebugger').checked = s.useDebugger !== false; $('#g_maxSteps').value = s.maxSteps || 40;
  $('#g_multiAgent').checked = !!s.multiAgent; $('#g_supervisorEvery').value = s.supervisorEvery || 4;
  $('#g_historyLimit').value = s.historyLimit == null ? 20 : s.historyLimit; historyLabel();
  $('#g_autoCaptcha').checked = s.autoCaptcha !== false;
  $('#g_use2captcha').checked = !!s.use2captcha; $('#g_2captchaKey').value = s.captchaKey || '';
  const sel = $('#g_supervisorProviderId'); sel.innerHTML = `<option value="">${esc(t('opt.sameAsExecutor'))}</option>` + providers.map((p) => `<option value="${esc(p.id)}">${esc(p.name || p.model)} · ${esc(p.model)}</option>`).join('');
  sel.value = s.supervisorProviderId || '';
  renderList();
}
function renderList() {
  const l = $('#list'); l.innerHTML = providers.length ? '' : `<div class="muted">${esc(t('opt.noModelsList'))}</div>`;
  for (const p of providers) {
    const d = document.createElement('div'); d.className = 'item' + (p.id === active ? ' active' : '');
    d.innerHTML = `<div><b>${esc(p.name || p.model)}</b> <span class="muted">${esc(p.model)} · ${esc(p.baseUrl)} · ${p.protocol}${p.toolMode === 'json' ? ' · json-tools' : ''}${p.vision ? ' · vision' : ''}</span></div><div><button data-act="use">${p.id === active ? esc(t('opt.active')) : esc(t('opt.use'))}</button><button data-act="edit">${esc(t('opt.edit'))}</button></div>`;
    d.querySelector('[data-act=use]').onclick = async (e) => { e.stopPropagation(); active = p.id; await chrome.storage.local.set({ activeProvider: active }); renderList(); };
    d.querySelector('[data-act=edit]').onclick = (e) => { e.stopPropagation(); edit(p); };
    d.onclick = () => edit(p);
    l.appendChild(d);
  }
}
const esc = (s) => String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
function edit(p) {
  editing = p; $('#editor').hidden = false;
  for (const f of FIELDS) { const el = $('#f_' + f); if (el.type === 'checkbox') el.checked = !!p[f]; else el.value = p[f] ?? (f === 'temperature' ? 0.2 : f === 'maxTokens' ? 2048 : f === 'numCtx' ? 16384 : ''); }
  $('#status').textContent = ''; $('#editor').scrollIntoView({ behavior: 'smooth' });
}
function readForm() { const p = { ...editing }; for (const f of FIELDS) { const el = $('#f_' + f); if (el.type === 'checkbox') p[f] = el.checked; else if (el.type === 'number') { p[f] = el.value === '' ? undefined : +el.value; } else p[f] = el.value.trim(); } return p; }
$('#add').onclick = () => edit({ id: 'p' + Date.now(), protocol: 'openai', toolMode: 'native' });
$('#save').onclick = async () => { const p = readForm(); if (!p.baseUrl || !p.model) { $('#status').innerHTML = `<span class="bad">${esc(t('opt.needUrlModel'))}</span>`; return; } const i = providers.findIndex((x) => x.id === p.id); if (i >= 0) providers[i] = p; else providers.push(p); if (!active) active = p.id; await chrome.storage.local.set({ providers, activeProvider: active }); editing = p; renderList(); $('#status').innerHTML = `<span class="ok">${esc(t('opt.saved'))}</span>`; };
$('#delete').onclick = async () => { providers = providers.filter((x) => x.id !== editing.id); if (active === editing.id) active = providers[0]?.id || null; await chrome.storage.local.set({ providers, activeProvider: active }); $('#editor').hidden = true; renderList(); };
$('#test').onclick = async () => { $('#status').textContent = t('opt.testing'); const r = await chrome.runtime.sendMessage({ type: 'panel', action: 'test_provider', provider: readForm() }); $('#status').innerHTML = r.ok ? `<span class="ok">OK: ${esc(r.text).slice(0, 80)}</span>` : `<span class="bad">${esc(r.error)}</span>`; };
$('#listModels').onclick = async () => { $('#status').textContent = t('opt.loadingModels'); const r = await chrome.runtime.sendMessage({ type: 'panel', action: 'list_models', provider: readForm() }); if (!r.ok) { $('#status').innerHTML = `<span class="bad">${esc(r.error)}</span>`; return; } $('#models').innerHTML = r.models.map((m) => `<option value="${esc(m)}">`).join(''); $('#status').innerHTML = `<span class="ok">${esc(t('opt.modelsFound', r.models.length))}</span>`; if (!$('#f_model').value && r.models[0]) $('#f_model').value = r.models[0]; };
$('#presets').innerHTML = PRESETS.map((p, i) => `<button data-i="${i}">${esc(p.name)}</button>`).join('');
$('#presets').onclick = (e) => { const i = e.target.dataset.i; if (i == null) return; const p = PRESETS[i]; for (const k of Object.keys(p)) { const el = $('#f_' + k); if (el) { if (el.type === 'checkbox') el.checked = !!p[k]; else el.value = p[k]; } } if (!$('#f_vision').checked && !('vision' in p)) $('#f_vision').checked = false; };
function historyLabel() { const v = +$('#g_historyLimit').value; $('#g_historyLimitVal').textContent = v <= 0 ? t('opt.hLimitNone') : v >= 100 ? t('opt.hLimitInf') : t('opt.hLimitN', v); }
$('#g_historyLimit').oninput = historyLabel;
$('#saveGlobal').onclick = async () => { await chrome.storage.local.set({ scope: $('#g_scope').value, useDebugger: $('#g_useDebugger').checked, maxSteps: +$('#g_maxSteps').value || 40, multiAgent: $('#g_multiAgent').checked, supervisorProviderId: $('#g_supervisorProviderId').value || null, supervisorEvery: +$('#g_supervisorEvery').value || 4, autoCaptcha: $('#g_autoCaptcha').checked, use2captcha: $('#g_use2captcha').checked, captchaKey: $('#g_2captchaKey').value, historyLimit: +$('#g_historyLimit').value }); $('#gstatus').innerHTML = `<span class="ok"> ${esc(t('opt.saved'))}</span>`; };

// ---- language ----
$('#g_lang').onchange = async () => { await setLang($('#g_lang').value); applyI18n(document); renderList(); load(); historyLabel(); };

(async () => {
  await initI18n();
  $('#g_lang').value = getLang();
  applyI18n(document);
  load();
})();
