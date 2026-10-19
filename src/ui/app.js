/**
 * src/ui/app.js —— 页面状态机与表单。
 *
 * 契约 2.6：本文件只通过 `detect()` 与 `renderReport()` 连接引擎，
 * 不 import core 的规则目录或任何 provider 实现，也不直接依赖引擎内部模块。
 *
 * 关于引擎 import 的防御性设计：
 *   engine.js 由 engine 队友并行实现。这里使用 **动态 import + try/catch**，
 *   因此即使 engine.js 尚不存在或语法有误，本文件也能正常执行、页面不会白屏，
 *   只在用户点击检测时给出「引擎未就绪」的友好错误态。
 */

import { VERSION, PROVIDER_LABELS, PROVIDER_DEFAULT_BASE_URL } from '../core/constants.js';
import { renderEmpty, renderLoading, renderError, renderReport } from './render.js';
import { verdictBadge } from './components.js';

const HISTORY_KEY = 'relay-detector/history/v1';
const HISTORY_LIMIT = 20;
const API_KEY_STORE = 'relay-detector/api-key/v1';
const SAVE_KEY_FLAG = 'relay-detector/save-key/v1';
const THEME_KEY = 'relay-detector/theme/v1';
const DEFAULT_TIMEOUT_MS = 12000;
const DEFAULT_PROXY_URL = 'http://127.0.0.1:8787';

/** 页面状态：empty | loading | result | error */
let state = 'empty';
/** 当前加载中的引擎模块（成功后缓存）。 */
let engine = null;
let engineError = null;
let abortController = null;

/* ------------------------------------------------------------------ *
 * 安全存储（file:// 或隐私模式下 localStorage 可能抛异常）
 * ------------------------------------------------------------------ */

function storageGet(key) {
  try {
    return window.localStorage.getItem(key);
  } catch {
    return null;
  }
}

function storageSet(key, value) {
  try {
    window.localStorage.setItem(key, value);
    return true;
  } catch {
    return false;
  }
}

function storageRemove(key) {
  try {
    window.localStorage.removeItem(key);
  } catch {
    // 忽略
  }
}

/* ------------------------------------------------------------------ *
 * DOM 引用
 * ------------------------------------------------------------------ */

const el = (id) => document.getElementById(id);

const baseUrlInput = el('base-url');
const apiKeyInput = el('api-key');
const providerSelect = el('provider');
const proxyUrlInput = el('proxy-url');
const timeoutInput = el('timeout-ms');
const allowPaidCheckbox = el('allow-paid');
const saveKeyCheckbox = el('save-key');
const paidWarning = el('paid-warning');
const proxyField = el('proxy-field');
const browserField = el('browser-field');
const startButton = el('start-btn');
const cancelButton = el('cancel-btn');
const resultEl = el('result');
const historyEl = el('history');
const engineStatusEl = el('engine-status');
const themeToggle = el('theme-toggle');
const versionEl = el('app-version');

/* ------------------------------------------------------------------ *
 * 引擎加载（防御性）
 * ------------------------------------------------------------------ */

async function loadEngine(force = false) {
  if (engine && !force) return engine;
  try {
    const mod = await import('../core/engine.js');
    if (!mod || typeof mod.detect !== 'function') {
      engine = null;
      engineError = new Error('engine.js 已加载，但未按契约 2.1 导出 detect()。');
      return null;
    }
    engine = mod;
    engineError = null;
    return engine;
  } catch (error) {
    engine = null;
    engineError = error;
    return null;
  }
}

function updateEngineStatus(text, tone = 'plain') {
  if (!engineStatusEl) return;
  engineStatusEl.textContent = text;
  engineStatusEl.className = `chip chip-${tone}`;
  engineStatusEl.title = engineError ? String(engineError && engineError.message) : '';
}

/* ------------------------------------------------------------------ *
 * 状态机
 * ------------------------------------------------------------------ */

function setState(next) {
  state = next;
  const loading = next === 'loading';
  if (startButton) {
    startButton.disabled = loading;
    startButton.textContent = loading ? '检测中…' : '开始检测';
  }
  if (cancelButton) cancelButton.classList.toggle('hidden', !loading);
  if (resultEl) resultEl.setAttribute('aria-busy', loading ? 'true' : 'false');
}

function readForm() {
  const modeInput = document.querySelector('input[name="mode"]:checked');
  const timeout = Number.parseInt(timeoutInput ? timeoutInput.value : '', 10);
  return {
    baseUrl: (baseUrlInput && baseUrlInput.value ? baseUrlInput.value : '').trim(),
    apiKey: (apiKeyInput && apiKeyInput.value ? apiKeyInput.value : '').trim(),
    provider: providerSelect ? providerSelect.value : 'auto',
    mode: modeInput ? modeInput.value : 'browser',
    proxyUrl: (proxyUrlInput && proxyUrlInput.value ? proxyUrlInput.value : '').trim() || DEFAULT_PROXY_URL,
    timeoutMs: Number.isFinite(timeout) ? Math.min(120000, Math.max(1000, timeout)) : DEFAULT_TIMEOUT_MS,
    allowPaidProbes: Boolean(allowPaidCheckbox && allowPaidCheckbox.checked),
    saveKey: Boolean(saveKeyCheckbox && saveKeyCheckbox.checked)
  };
}

function friendlyError(error) {
  if (error && error.name === 'AbortError') return '检测已取消。';
  if (typeof navigator !== 'undefined' && navigator.onLine === false) {
    return '当前设备似乎处于断网状态，无法发起探测。请检查网络后重试。';
  }
  const message = error && error.message ? String(error.message) : String(error || '未知错误');
  return `检测过程中出现异常：${message}`;
}

/* ------------------------------------------------------------------ *
 * 执行检测
 * ------------------------------------------------------------------ */

async function runDetection() {
  if (state === 'loading') return;

  const form = readForm();
  if (!form.baseUrl) {
    renderError(resultEl, '请先填写 API 基址，例如 https://api.example.com/v1。', {
      title: '缺少必要输入',
      hints: ['基址可以带或不带 /v1 后缀，引擎会自行规范化。']
    });
    setState('error');
    if (baseUrlInput) baseUrlInput.focus();
    return;
  }

  const mod = await loadEngine();
  if (!mod) {
    updateEngineStatus('引擎未就绪', 'warn');
    renderError(resultEl, '检测引擎模块（src/core/engine.js）尚未就绪，暂时无法发起检测。页面其余功能不受影响。', {
      title: '引擎未就绪',
      detail: engineError ? String(engineError.stack || engineError.message || engineError) : 'import("../core/engine.js") 失败',
      retry: runDetection,
      hints: [
        '若你正在本地开发：请确认 engine 队友已完成 src/core/engine.js，然后点击「重试」。',
        '若这是线上部署：该文件缺失或路径错误会导致此提示，请联系维护者。'
      ]
    });
    setState('error');
    return;
  }
  updateEngineStatus(`引擎已就绪 · v${VERSION}`, 'success');

  if (form.saveKey) persistApiKey(form.apiKey);
  else clearStoredApiKey();

  abortController = new AbortController();
  const controller = abortController;
  renderLoading(resultEl, { baseUrl: form.baseUrl });
  setState('loading');

  try {
    const args = {
      baseUrl: form.baseUrl,
      apiKey: form.apiKey || undefined,
      provider: form.provider,
      mode: form.mode,
      options: {
        timeoutMs: form.timeoutMs,
        allowPaidProbes: form.allowPaidProbes,
        proxyUrl: form.proxyUrl,
        signal: controller.signal
      }
    };

    if (form.mode === 'browser') {
      args.transport = typeof globalThis.fetch === 'function' ? globalThis.fetch.bind(globalThis) : undefined;
    } else if (typeof mod.createProxyTransport === 'function') {
      args.transport = mod.createProxyTransport(form.proxyUrl);
    }
    // proxy 模式下若引擎未导出 createProxyTransport，则不传 transport，
    // 由引擎按 2.2 用 options.proxyUrl 自行包装。

    const report = await mod.detect(args);

    if (controller.signal.aborted) {
      renderError(resultEl, '检测已取消，未生成完整报告。', { title: '已取消' });
      setState('error');
      return;
    }

    renderReport(resultEl, report);
    rememberHistory(report);
    renderHistory();
    setState('result');

    if (typeof resultEl.scrollIntoView === 'function') {
      resultEl.scrollIntoView({ behavior: 'smooth', block: 'start' });
    }
  } catch (error) {
    renderError(resultEl, friendlyError(error), {
      title: '检测失败',
      detail: error && error.stack ? String(error.stack) : String(error),
      retry: runDetection
    });
    setState('error');
  } finally {
    if (abortController === controller) abortController = null;
  }
}

function cancelDetection() {
  if (abortController) {
    abortController.abort();
  }
  renderError(resultEl, '检测已取消，未生成完整报告。', { title: '已取消', retry: runDetection });
  setState('error');
}

/* ------------------------------------------------------------------ *
 * 历史记录（localStorage，最多 20 条，仅存 host 与结论，绝不存密钥）
 * ------------------------------------------------------------------ */

function loadHistory() {
  const raw = storageGet(HISTORY_KEY);
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed
      .filter((item) => item && typeof item === 'object' && typeof item.host === 'string')
      .slice(0, HISTORY_LIMIT);
  } catch {
    return [];
  }
}

function saveHistory(list) {
  storageSet(HISTORY_KEY, JSON.stringify(list.slice(0, HISTORY_LIMIT)));
}

function rememberHistory(report) {
  const target = report && report.target && typeof report.target === 'object' ? report.target : {};
  const host = typeof target.host === 'string' && target.host ? target.host : typeof target.baseUrl === 'string' ? target.baseUrl : '';
  if (!host) return;

  const entry = {
    host,
    provider: typeof target.provider === 'string' ? target.provider : '',
    mode: report && report.mode === 'proxy' ? 'proxy' : 'browser',
    verdict: typeof report?.verdict === 'string' ? report.verdict : 'inconclusive',
    score: typeof report?.score === 'number' && Number.isFinite(report.score) ? report.score : 0,
    evidenceStrength: typeof report?.evidenceStrength === 'number' && Number.isFinite(report.evidenceStrength) ? report.evidenceStrength : 0,
    at: Date.now()
  };

  const list = loadHistory().filter((item) => item.host !== host);
  list.unshift(entry);
  saveHistory(list);
}

function formatPercentText(value01) {
  const value = typeof value01 === 'number' && Number.isFinite(value01) ? value01 : 0;
  return `${Math.min(99, Math.round(Math.max(0, Math.min(1, value)) * 100))}%`;
}

function renderHistory() {
  if (!historyEl) return;
  const list = loadHistory();

  if (!list.length) {
    historyEl.replaceChildren(
      emptyNote('暂无检测历史。历史只记录主机名与结论，不保存 API Key。')
    );
    return;
  }

  const rows = list.map((item) => {
    const badge = verdictBadge(item.verdict, { size: 'sm' });
    const time = new Date(item.at).toLocaleString('zh-CN', { hour12: false });
    const fillButton = document.createElement('button');
    fillButton.type = 'button';
    fillButton.className = 'btn btn-ghost btn-sm no-print';
    fillButton.textContent = '填入主机';
    fillButton.addEventListener('click', () => {
      if (baseUrlInput) {
        baseUrlInput.value = `https://${item.host}`;
        baseUrlInput.focus();
      }
    });

    const row = document.createElement('li');
    row.className = 'history-item';
    row.append(
      badge,
      textSpan('history-host mono', item.host),
      textSpan('history-meta', `${PROVIDER_LABELS[item.provider] || item.provider || '未知协议'} · ${item.mode === 'proxy' ? '代理模式' : '浏览器模式'}`),
      textSpan('history-meta', `score ${item.score} · 证据强度 ${formatPercentText(item.evidenceStrength)} · ${time}`),
      fillButton
    );
    return row;
  });

  const head = document.createElement('div');
  head.className = 'history-head no-print';
  const clearButton = document.createElement('button');
  clearButton.type = 'button';
  clearButton.className = 'btn btn-ghost btn-sm';
  clearButton.textContent = '清空历史';
  clearButton.addEventListener('click', () => {
    if (window.confirm('确定要清空所有检测历史吗？（不会影响已保存的报告）')) {
      storageRemove(HISTORY_KEY);
      renderHistory();
    }
  });
  head.append(textSpan('history-count', `共 ${list.length} 条（最多保留 ${HISTORY_LIMIT} 条）`), clearButton);

  historyEl.replaceChildren(head, listEl(rows));
}

function textSpan(className, text) {
  const span = document.createElement('span');
  span.className = className;
  span.textContent = text;
  return span;
}

function emptyNote(text) {
  const p = document.createElement('p');
  p.className = 'empty-note';
  p.textContent = text;
  return p;
}

function listEl(children) {
  const list = document.createElement('ul');
  list.className = 'history-list';
  list.append(...children);
  return list;
}

/* ------------------------------------------------------------------ *
 * API Key 持久化（默认关闭，用户显式勾选才落盘）
 * ------------------------------------------------------------------ */

function persistApiKey(key) {
  if (!key) {
    clearStoredApiKey();
    return;
  }
  storageSet(API_KEY_STORE, key);
  storageSet(SAVE_KEY_FLAG, '1');
}

function clearStoredApiKey() {
  storageRemove(API_KEY_STORE);
  storageRemove(SAVE_KEY_FLAG);
}

function syncKeyStorage() {
  if (!saveKeyCheckbox || !apiKeyInput) return;
  if (saveKeyCheckbox.checked) persistApiKey(apiKeyInput.value.trim());
  else clearStoredApiKey();
}

/* ------------------------------------------------------------------ *
 * 主题（深浅色）
 * ------------------------------------------------------------------ */

function applyTheme(theme) {
  if (theme === 'light' || theme === 'dark') document.documentElement.dataset.theme = theme;
  else delete document.documentElement.dataset.theme;
  if (themeToggle) {
    const current = theme || (window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light');
    themeToggle.textContent = current === 'dark' ? '☀️ 浅色' : '🌙 深色';
    themeToggle.setAttribute('aria-label', current === 'dark' ? '切换到浅色主题' : '切换到深色主题');
  }
}

function initTheme() {
  const stored = storageGet(THEME_KEY);
  applyTheme(stored === 'light' || stored === 'dark' ? stored : null);
  if (themeToggle) {
    themeToggle.addEventListener('click', () => {
      const isDark = document.documentElement.dataset.theme
        ? document.documentElement.dataset.theme === 'dark'
        : Boolean(window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches);
      const next = isDark ? 'light' : 'dark';
      storageSet(THEME_KEY, next);
      applyTheme(next);
    });
  }
}

/* ------------------------------------------------------------------ *
 * 打印：展开所有折叠面板，打印后恢复
 * ------------------------------------------------------------------ */

function initPrint() {
  window.addEventListener('beforeprint', () => {
    document.querySelectorAll('details').forEach((node) => {
      node.dataset.printWasOpen = node.open ? '1' : '0';
      node.open = true;
    });
  });
  window.addEventListener('afterprint', () => {
    document.querySelectorAll('details').forEach((node) => {
      if (node.dataset.printWasOpen === '0') node.open = false;
      delete node.dataset.printWasOpen;
    });
  });
}

/* ------------------------------------------------------------------ *
 * 表单初始化
 * ------------------------------------------------------------------ */

function initProviderSelect() {
  if (!providerSelect) return;
  const auto = document.createElement('option');
  auto.value = 'auto';
  auto.textContent = '自动识别（推荐）';
  providerSelect.append(auto);

  for (const [id, label] of Object.entries(PROVIDER_LABELS)) {
    const option = document.createElement('option');
    option.value = id;
    option.textContent = label;
    providerSelect.append(option);
  }
  providerSelect.value = 'auto';

  providerSelect.addEventListener('change', () => {
    const current = (baseUrlInput.value || '').trim();
    const isDefaultOrEmpty = !current || Object.values(PROVIDER_DEFAULT_BASE_URL).includes(current);
    const fallback = PROVIDER_DEFAULT_BASE_URL[providerSelect.value];
    if (isDefaultOrEmpty && fallback) baseUrlInput.value = fallback;
  });
}

function initModeToggle() {
  const sync = () => {
    const mode = readForm().mode;
    if (proxyField) proxyField.classList.toggle('hidden', mode !== 'proxy');
    if (proxyUrlInput) proxyUrlInput.disabled = mode !== 'proxy';
    if (browserField) browserField.classList.toggle('hidden', mode !== 'browser');
  };
  document.querySelectorAll('input[name="mode"]').forEach((input) => input.addEventListener('change', sync));
  sync();
}

function initPaidWarning() {
  if (!allowPaidCheckbox || !paidWarning) return;
  const sync = () => paidWarning.classList.toggle('hidden', !allowPaidCheckbox.checked);
  allowPaidCheckbox.addEventListener('change', sync);
  sync();
}

function initKeyPersistence() {
  if (!saveKeyCheckbox || !apiKeyInput) return;

  const savedFlag = storageGet(SAVE_KEY_FLAG) === '1';
  const savedKey = storageGet(API_KEY_STORE);
  if (savedFlag) {
    saveKeyCheckbox.checked = true;
    if (savedKey) apiKeyInput.value = savedKey;
    else saveKeyCheckbox.checked = false;
  }

  saveKeyCheckbox.addEventListener('change', syncKeyStorage);
  apiKeyInput.addEventListener('input', () => {
    if (saveKeyCheckbox.checked) persistApiKey(apiKeyInput.value.trim());
  });
  syncKeyStorage();
}

function initButtons() {
  if (cancelButton) cancelButton.addEventListener('click', cancelDetection);

  const form = el('detect-form');
  if (form) {
    // 只绑定 submit：避免 click 与 submit 双重触发 runDetection。
    form.addEventListener('submit', (event) => {
      event.preventDefault();
      runDetection();
    });
  } else if (startButton) {
    startButton.addEventListener('click', () => { runDetection(); });
  }

  document.querySelectorAll('[data-fill-url]').forEach((node) => {
    node.addEventListener('click', () => {
      const value = node.getAttribute('data-fill-url');
      if (baseUrlInput && value) {
        baseUrlInput.value = value;
        baseUrlInput.focus();
      }
    });
  });
}

/* ------------------------------------------------------------------ *
 * 启动
 * ------------------------------------------------------------------ */

function init() {
  if (versionEl) versionEl.textContent = VERSION;

  initTheme();
  initProviderSelect();
  initModeToggle();
  initPaidWarning();
  initKeyPersistence();
  initButtons();
  initPrint();

  // 初始示例基址
  if (baseUrlInput && !baseUrlInput.value) baseUrlInput.value = PROVIDER_DEFAULT_BASE_URL.openai;

  renderEmpty(resultEl, '填写 API 基址（可选 API Key）后点击「开始检测」。所有探测默认只读且不计费。');
  renderHistory();

  updateEngineStatus('正在加载引擎…', 'plain');
  loadEngine().then((mod) => {
    if (mod) updateEngineStatus(`引擎已就绪 · v${VERSION}`, 'success');
    else updateEngineStatus('引擎未就绪（仍可查看页面）', 'warn');
  });
}

init();
