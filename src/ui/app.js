/**
 * src/ui/app.js —— 页面状态机与表单（契约 v2）。
 *
 * 契约 2.6 / 7：本文件只通过
 *   - detect()（src/core/engine.js，动态 import）
 *   - runAuthenticity() / estimateCost() / suggestModels()（src/core/auth/**，动态 import）
 *   - renderReport() / renderError()（src/ui/render.js）
 * 连接引擎与界面，不 import 任何 rules/** 或 providers/**。
 *
 * 防御性设计：
 *   engine.js / src/core/auth/** 由其他队友并行实现，这里全部使用动态 import + try/catch；
 *   模块缺失时页面完整可用，只在用户选择需要 Key 的档位时提示「真伪引擎未就绪」，绝不白屏。
 *
 * 两根正交的轴（docs/LEARNINGS-FROM-VERIDROP.md 第 1 节）：
 *   轴 1 连接方式（v1 score/verdict）  ×  轴 2 上游真伪（v2 authenticity）
 * 界面并列展示，禁止合并成一个分数。
 */

import { VERSION, PROVIDER_LABELS, PROVIDER_DEFAULT_BASE_URL } from '../core/constants.js';
import { renderEmpty, renderLoading, renderError, renderReport } from './render.js';
import { verdictBadge } from './components.js';
import {
  DEPTH_FINGERPRINT,
  depthOption,
  depthRequiresKey,
  normalizeDepth,
  computeStartState
} from './form-state.js';
import {
  loadAuthModule,
  loadAuthModels,
  getAuthStatus,
  estimateAuthCost,
  runAuthDetection,
  suggestModels,
  suggestAllModels,
  getAuthModes,
  describeAuthError
} from './auth-api.js';
import {
  normalizeAuthenticity,
  AUTH_VERDICT_LABELS,
  AUTH_VERDICT_TONES
} from './authenticity.js';

const HISTORY_KEY = 'relay-detector/history/v1';
const HISTORY_LIMIT = 20;
const API_KEY_STORE = 'relay-detector/api-key/v1';
const SAVE_KEY_FLAG = 'relay-detector/save-key/v1';
const THEME_KEY = 'relay-detector/theme/v1';
const DEFAULT_TIMEOUT_MS = 12000;
const DEFAULT_PROXY_URL = 'http://127.0.0.1:8787';
/** 真伪检测的单请求超时下限：Claude thinking 探针可能比较慢。 */
const AUTH_MIN_TIMEOUT_MS = 60000;

/** 页面状态：empty | loading | result | error */
let state = 'empty';
/** 当前加载中的引擎模块（成功后缓存）。 */
let engine = null;
let engineError = null;
/** 真伪引擎状态快照（auth-api 内部另有缓存）。 */
let authStatusSnapshot = getAuthStatus();
/** 最近一次费用预估：{ok, cost?, error?, code?} | null */
let latestEstimate = null;
/** 费用预估签名（provider|model|mode），变化时强制重新勾选确认。 */
let costSignature = '';
/** 最近一次模型建议对应的协议族（避免无谓重置用户手填的模型）。 */
let lastSuggestedProvider = null;
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
const authStatusEl = el('auth-status');
const themeToggle = el('theme-toggle');
const versionEl = el('app-version');
const modelInput = el('model');
const modelOptions = el('model-options');
const modelField = el('model-field');
const costField = el('cost-field');
const costSummary = el('cost-summary');
const costConfirm = el('cost-confirm');
const costConfirmText = el('cost-confirm-text');
const startReason = el('start-reason');
const clearKeyButton = el('clear-key-btn');
const apiKeyRequired = el('api-key-required');

/* ------------------------------------------------------------------ *
 * 小工具
 * ------------------------------------------------------------------ */

function textSpan(className, text) {
  const span = document.createElement('span');
  span.className = className;
  span.textContent = text;
  return span;
}

function emptyNote(text) {
  const node = document.createElement('p');
  node.className = 'empty-note';
  node.textContent = text;
  return node;
}

function textNode(tag, className, text) {
  const node = document.createElement(tag);
  node.className = className;
  node.textContent = text;
  return node;
}

function formatInt(value) {
  const n = typeof value === 'number' && Number.isFinite(value) ? Math.round(value) : 0;
  try {
    return n.toLocaleString('zh-CN');
  } catch {
    return String(n);
  }
}

function formatTime(ts) {
  const value = typeof ts === 'number' && Number.isFinite(ts) ? ts : 0;
  if (!value) return '—';
  try {
    return new Date(value).toLocaleString('zh-CN', { hour12: false });
  } catch {
    return '—';
  }
}

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
 * 真伪引擎加载（防御性）
 * ------------------------------------------------------------------ */

function updateAuthStatusChip() {
  const status = authStatusSnapshot || getAuthStatus();
  if (!authStatusEl) return;
  if (status.ready) {
    authStatusEl.textContent = `真伪引擎已就绪 · 档位 ${getAuthModes().join(' / ')}`;
    authStatusEl.className = 'chip chip-success';
    authStatusEl.title = status.modelsReady ? '' : '模型能力表尚未就绪：模型下拉暂时为空，可手动填写模型 ID。';
  } else if (status.loading) {
    authStatusEl.textContent = '正在加载真伪引擎…';
    authStatusEl.className = 'chip chip-plain';
    authStatusEl.title = '';
  } else {
    authStatusEl.textContent = '真伪引擎未就绪（仅指纹档位可用）';
    authStatusEl.className = 'chip chip-warn';
    authStatusEl.title = status.error ? describeAuthError(status.error) : '';
  }
}

/**
 * 加载 / 重载真伪引擎与模型表，并刷新依赖它们的 UI。
 * @returns {Promise<boolean>} 真伪引擎是否可用
 */
function initAuthEngine(force = false) {
  const loadPromise = loadAuthModule(force);
  authStatusSnapshot = getAuthStatus();
  updateAuthStatusChip();

  return loadPromise.then(async (moduleRes) => {
    if (moduleRes.ok) await loadAuthModels(force);
    authStatusSnapshot = getAuthStatus();
    updateAuthStatusChip();
    refreshModelOptions();
    refreshCostEstimate();
    updateStartState();
    return moduleRes.ok;
  });
}

/* ------------------------------------------------------------------ *
 * 状态机
 * ------------------------------------------------------------------ */

function setState(next) {
  state = next;
  const loading = next === 'loading';
  if (startButton) startButton.textContent = loading ? '检测中…' : '开始检测';
  if (cancelButton) cancelButton.classList.toggle('hidden', !loading);
  if (resultEl) resultEl.setAttribute('aria-busy', loading ? 'true' : 'false');
  updateStartState();
}

function currentDepth() {
  const checked = document.querySelector('input[name="depth"]:checked');
  return normalizeDepth(checked ? checked.value : DEPTH_FINGERPRINT);
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
    saveKey: Boolean(saveKeyCheckbox && saveKeyCheckbox.checked),
    depth: currentDepth(),
    model: (modelInput && modelInput.value ? modelInput.value : '').trim()
  };
}

/** 真伪检测要使用的协议族：显式选择优先，否则按基址自动识别。 */
function resolveProviderForAuth() {
  const hint = providerSelect ? providerSelect.value : 'auto';
  if (hint && hint !== 'auto') return hint;
  const baseUrl = (baseUrlInput && baseUrlInput.value ? baseUrlInput.value : '').trim();
  if (engine && typeof engine.pickProvider === 'function') {
    try {
      const resolved = engine.pickProvider(baseUrl, 'auto');
      if (resolved) return resolved;
    } catch {
      // 忽略：回退到域名启发式
    }
  }
  // engine 尚未就绪时的域名启发式兜底（真伪档位不依赖 v1 引擎也能工作）。
  const lower = String(baseUrl || '').toLowerCase();
  if (lower.includes('anthropic')) return 'anthropic';
  if (lower.includes('generativelanguage') || lower.includes('googleapis')) return 'gemini';
  return 'openai';
}

/** 目标信息归一（优先使用 engine.normalizeBaseUrl；engine 不在时用 URL 兜底）。 */
function normalizeTarget(baseUrl, provider) {
  if (engine && typeof engine.normalizeBaseUrl === 'function') {
    try {
      const info = engine.normalizeBaseUrl(baseUrl, provider);
      if (info && typeof info === 'object') return info;
    } catch {
      // 继续用兜底实现
    }
  }
  try {
    const withProtocol = /^[a-z][a-z0-9+.-]*:\/\//i.test(baseUrl) ? baseUrl : `https://${baseUrl}`;
    const url = new URL(withProtocol);
    const path = url.pathname.replace(/\/+$/, '');
    return { baseUrl: `${url.origin}${path === '/' ? '' : path}`, host: url.host };
  } catch {
    return { baseUrl, host: '' };
  }
}

/* ------------------------------------------------------------------ *
 * 检测深度 / 模型 / 费用确认
 * ------------------------------------------------------------------ */

/** 刷新模型下拉候选（datalist，允许手填）。 */
function refreshModelOptions() {
  const requiresKey = depthRequiresKey(currentDepth());
  if (modelField) modelField.classList.toggle('hidden', !requiresKey);
  if (!modelOptions || !modelInput) return;

  const providerHint = providerSelect ? providerSelect.value : 'auto';
  const provider = resolveProviderForAuth();
  let list = suggestModels(provider).map((model) => ({ id: model.id, label: model.id }));
  if (!list.length && providerHint === 'auto') {
    // 模型表较旧或自动识别失败时，回退到全协议聚合列表，至少让用户能选一个。
    list = suggestAllModels().map((model) => ({
      id: model.id,
      label: `${model.id}（${PROVIDER_LABELS[model.provider] || model.provider}）`
    }));
  }

  const options = list.map((model) => {
    const option = document.createElement('option');
    option.value = model.id;
    option.textContent = model.label;
    return option;
  });
  modelOptions.replaceChildren(...options);

  const ids = new Set(list.map((model) => model.id));
  const current = modelInput.value.trim();
  const providerChanged = lastSuggestedProvider !== null && lastSuggestedProvider !== provider;
  if (!current || (providerChanged && !ids.has(current))) {
    if (list.length) modelInput.value = list[0].id;
  }
  lastSuggestedProvider = provider;
}

function costItem(label, value, hint) {
  const node = document.createElement('div');
  node.className = 'cost-item';
  node.append(
    textSpan('cost-item-label', label),
    textSpan('cost-item-value', value),
    textSpan('cost-item-hint', hint)
  );
  return node;
}

/** 渲染费用预估区（发请求前必须让用户看到）。 */
function renderCostSummary(result) {
  if (!costSummary) return;
  if (!result) {
    costSummary.replaceChildren(textNode('p', 'cost-idle', '当前档位无需费用确认（只发送只读探测）。'));
    return;
  }
  if (result.ok !== true) {
    costSummary.replaceChildren(
      textNode('p', 'cost-error', `费用预估不可用：${result.error || '未知原因'}`),
      textNode('p', 'cost-note', '在费用预估可用之前，「开始检测」会保持置灰，避免在不知情的情况下产生费用。')
    );
    return;
  }

  const cost = result.cost;
  const grid = document.createElement('div');
  grid.className = 'cost-grid';
  grid.append(
    costItem('请求数', `${formatInt(cost.requests)} 次`, '真伪检测串行发送，避免触发风控'),
    costItem('输入 token（预估）', formatInt(cost.promptTokens), '按档位与模型估算，实际以目标返回为准'),
    costItem('输出 token（预估）', formatInt(cost.completionTokens), '结构/工具类探针会限制输出长度')
  );

  const nodes = [grid];
  if (cost.note) nodes.push(textNode('p', 'cost-note', cost.note));
  nodes.push(textNode('p', 'cost-note', '费用仅为预估：实际计费以目标服务商的账单为准；不同站点可能存在倍率或额外收费。'));
  if (!cost.requests) {
    nodes.push(textNode('p', 'cost-error', '预估请求数为 0：请先选择模型，或稍后重试（模型能力表可能尚未就绪）。'));
  }
  costSummary.replaceChildren(...nodes);
}

/** 同步「费用确认」勾选状态与说明文本。 */
function syncCostConfirmUI() {
  const checked = Boolean(costConfirm && costConfirm.checked);
  if (costField) costField.classList.toggle('cost-confirmed', checked);
  if (costConfirmText) {
    const requests = latestEstimate && latestEstimate.ok ? latestEstimate.cost.requests : null;
    const requestText = requests && requests > 0 ? `（约 ${requests} 次真实请求）` : '';
    costConfirmText.textContent = `我已了解：本次检测会向目标${requestText}发送真实对话请求，可能消耗账户额度，并愿意继续。`;
  }
}

/** 重新计算费用预估；预估签名变化时强制取消勾选（必须重新确认）。 */
function refreshCostEstimate() {
  const requiresKey = depthRequiresKey(currentDepth());
  if (costField) costField.classList.toggle('hidden', !requiresKey);
  if (modelField) modelField.classList.toggle('hidden', !requiresKey);
  if (apiKeyRequired) apiKeyRequired.classList.toggle('hidden', !requiresKey);

  if (!requiresKey) {
    latestEstimate = null;
    costSignature = '';
    if (costConfirm) costConfirm.checked = false;
    renderCostSummary(null);
    syncCostConfirmUI();
    updateStartState();
    return;
  }

  const flags = depthOption(currentDepth());
  const provider = resolveProviderForAuth();
  const model = (modelInput && modelInput.value ? modelInput.value : '').trim();
  const signature = `${provider}|${model}|${flags.authMode}`;
  const result = estimateAuthCost({ provider, model, mode: flags.authMode });
  latestEstimate = result;

  if (signature !== costSignature) {
    costSignature = signature;
    if (costConfirm) costConfirm.checked = false;
  }

  renderCostSummary(result);
  syncCostConfirmUI();
  updateStartState();
}

/** 重新评估「开始检测」按钮与原因提示（契约 7.2 的显式勾选门控）。 */
function updateStartState() {
  const status = authStatusSnapshot || getAuthStatus();
  const form = readForm();
  const gates = computeStartState({
    depth: form.depth,
    baseUrl: form.baseUrl,
    apiKey: form.apiKey,
    model: form.model,
    loading: state === 'loading',
    authReady: status.ready,
    authLoading: status.loading,
    authError: status.error,
    estimate: latestEstimate,
    costConfirmed: Boolean(costConfirm && costConfirm.checked)
  });

  if (startButton) {
    startButton.disabled = gates.disabled;
    if (gates.reason) startButton.title = gates.reason;
    else startButton.removeAttribute('title');
  }
  if (startReason) {
    startReason.textContent = gates.reason || '';
    startReason.className = `start-reason tone-${gates.tone}`;
    startReason.classList.toggle('hidden', !gates.reason);
  }

  if (clearKeyButton) {
    const hasKey = Boolean(apiKeyInput && apiKeyInput.value.trim());
    clearKeyButton.classList.toggle('hidden', !hasKey);
  }
}

/* ------------------------------------------------------------------ *
 * 执行检测
 * ------------------------------------------------------------------ */

function friendlyError(error) {
  if (error && error.name === 'AbortError') return '检测已取消。';
  if (typeof navigator !== 'undefined' && navigator.onLine === false) {
    return '当前设备似乎处于断网状态，无法发起探测。请检查网络后重试。';
  }
  const message = error && error.message ? String(error.message) : String(error || '未知错误');
  return `检测过程中出现异常：${message}`;
}

/** 构造 transport（契约 2.2）。 */
function makeTransport(mod, form) {
  if (form.mode === 'browser') {
    return typeof globalThis.fetch === 'function' ? globalThis.fetch.bind(globalThis) : undefined;
  }
  if (mod && typeof mod.createProxyTransport === 'function') {
    try {
      return mod.createProxyTransport(form.proxyUrl);
    } catch {
      // 继续用兜底实现
    }
  }
  const proxyBase = String(form.proxyUrl || DEFAULT_PROXY_URL).replace(/\/+$/, '');
  if (typeof globalThis.fetch === 'function') {
    return (url, init) => globalThis.fetch(`${proxyBase}/proxy?url=${encodeURIComponent(url)}`, init);
  }
  return undefined;
}

/** 「真伪」档位只跑 v2 时，构造一个最小报告外壳（显式 connection: null）。 */
function buildAuthOnlyReport(form, authResult, provider, startedAt) {
  const target = normalizeTarget(form.baseUrl, provider);
  const finishedAt = Date.now();
  return {
    schema: 1,
    target: {
      input: form.baseUrl,
      baseUrl: target.baseUrl || form.baseUrl,
      host: target.host || '',
      provider,
      providerSource: form.provider === 'auto' ? 'auto' : 'explicit',
      matchedOfficialHost: null
    },
    mode: form.mode,
    connection: null,
    authenticity: authResult,
    startedAt,
    finishedAt,
    durationMs: Math.max(0, finishedAt - startedAt)
  };
}

/** 真伪引擎调用失败时，构造「检测无效」报告（不是低分）。 */
function buildInvalidAuth(form, provider, authMode, failure) {
  const now = Date.now();
  return {
    schema: 1,
    provider,
    model: form.model,
    mode: authMode,
    score: 0,
    verdict: 'invalid',
    summaryText: '检测无效',
    detectors: [],
    criticalIssues: [],
    runError: {
      code: failure && failure.code ? failure.code : 'auth_run_failed',
      message: failure && failure.error ? String(failure.error) : '真伪检测未能完成。'
    },
    cost: { requests: 0, promptTokens: 0, completionTokens: 0, note: '未产生有效的真伪检测请求。' },
    warnings: ['真伪检测过程异常，因此整份真伪报告标记为「检测无效」；这不代表上游是假模型。'],
    startedAt: now,
    finishedAt: now,
    durationMs: 0
  };
}

async function runDetection() {
  if (state === 'loading') return;

  const form = readForm();
  const flags = depthOption(form.depth);
  const status = authStatusSnapshot || getAuthStatus();

  if (!form.baseUrl) {
    renderError(resultEl, '请先填写 API 基址，例如 https://api.example.com/v1。', {
      title: '缺少必要输入',
      hints: ['基址可以带或不带 /v1 后缀，引擎会自行规范化。']
    });
    setState('error');
    if (baseUrlInput) baseUrlInput.focus();
    return;
  }

  // 付费档位的前端门控（防御性二次校验：按钮状态异常时也绝不悄悄发付费请求）。
  if (flags.requiresKey) {
    const gates = computeStartState({
      depth: form.depth,
      baseUrl: form.baseUrl,
      apiKey: form.apiKey,
      model: form.model,
      loading: false,
      authReady: status.ready,
      authLoading: status.loading,
      authError: status.error,
      estimate: latestEstimate,
      costConfirmed: Boolean(costConfirm && costConfirm.checked)
    });
    if (gates.disabled) {
      renderError(resultEl, gates.reason, {
        title: '无法开始检测',
        hints: [
          '需要 Key 的档位必须先完成费用预估，并显式勾选「费用确认」。',
          '若真伪引擎未就绪，可先使用「指纹（免费）」档位；页面其余功能不受影响。',
          '费用确认默认不勾选，每次改动模型 / 档位后都需要重新确认。'
        ]
      });
      setState('error');
      return;
    }
  }

  // 需要 v1 的档位先确保 engine 就绪。
  let mod = null;
  if (flags.runsV1) {
    mod = await loadEngine();
    if (!mod) {
      updateEngineStatus('引擎未就绪', 'warn');
      renderError(resultEl, '检测引擎模块（src/core/engine.js）尚未就绪，暂时无法发起连接方式检测。页面其余功能不受影响。', {
        title: '引擎未就绪',
        detail: engineError ? String(engineError.stack || engineError.message || engineError) : 'import("../core/engine.js") 失败',
        retry: runDetection,
        hints: [
          '若你正在本地开发：请确认 engine 队友已完成 src/core/engine.js，然后点击「重试」。',
          '也可以先切换到「真伪」档位（只跑 v2）；或使用「指纹」档位。'
        ]
      });
      setState('error');
      return;
    }
    updateEngineStatus(`引擎已就绪 · v${VERSION}`, 'success');
  }

  // Key 持久化：只有显式勾选「保存密钥到本机」才落盘。
  if (form.saveKey) persistApiKey(form.apiKey);
  else clearStoredApiKey();

  abortController = new AbortController();
  const controller = abortController;
  const startedAt = Date.now();
  renderLoading(resultEl, {
    baseUrl: form.baseUrl,
    depth: form.depth,
    authRequests: latestEstimate && latestEstimate.ok ? latestEstimate.cost.requests : 0
  });
  setState('loading');

  try {
    const transport = makeTransport(mod, form);
    let report = null;

    if (flags.runsV1) {
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
      if (transport) args.transport = transport;
      report = await mod.detect(args);
      if (controller.signal.aborted) {
        renderError(resultEl, '检测已取消，未生成完整报告。', { title: '已取消' });
        setState('error');
        return;
      }
    }

    if (flags.authMode) {
      const provider = resolveProviderForAuth();
      const authCall = await runAuthDetection({
        provider,
        baseUrl: form.baseUrl,
        apiKey: form.apiKey,
        model: form.model,
        mode: flags.authMode,
        transport,
        options: {
          timeoutMs: Math.min(120000, Math.max(AUTH_MIN_TIMEOUT_MS, form.timeoutMs)),
          signal: controller.signal,
          maxRequests: 24,
          concurrency: 1
        }
      });
      if (controller.signal.aborted) {
        renderError(resultEl, '检测已取消，未生成完整报告。', { title: '已取消' });
        setState('error');
        return;
      }

      if (authCall.ok) {
        if (!report) report = buildAuthOnlyReport(form, authCall.result, provider, startedAt);
        else report.authenticity = authCall.result;
      } else {
        const invalid = buildInvalidAuth(form, provider, flags.authMode, authCall);
        if (!report) report = buildAuthOnlyReport(form, invalid, provider, startedAt);
        else report.authenticity = invalid;
      }
    }

    if (!report || typeof report !== 'object') {
      renderError(resultEl, '检测没有返回可用报告，请重试。', { title: '报告为空', retry: runDetection });
      setState('error');
      return;
    }

    renderReport(resultEl, report);
    rememberHistory(report, form);
    renderHistory();

    // 每次真伪检测结束后重置费用确认：下一次必须重新显式勾选（防止重复扣费被误触发）。
    if (flags.requiresKey && costConfirm) {
      costConfirm.checked = false;
      syncCostConfirmUI();
    }
    setState('result');
    if (typeof resultEl.scrollIntoView === 'function') {
      resultEl.scrollIntoView({ behavior: 'smooth', block: 'start' });
    }
  } catch (error) {
    if (controller.signal.aborted) {
      renderError(resultEl, '检测已取消，未生成完整报告。', { title: '已取消', retry: runDetection });
      setState('error');
      return;
    }
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
  if (abortController) abortController.abort();
  renderError(resultEl, '检测已取消，未生成完整报告。', { title: '已取消', retry: runDetection });
  setState('error');
}

/* ------------------------------------------------------------------ *
 * 历史记录
 * 契约 v2：只存 host / 模型 / 两轴结论 / 时间；绝不存 Key，也绝不存报告正文。
 * ------------------------------------------------------------------ */

const CONNECTION_VERDICTS = ['relay', 'likely-relay', 'inconclusive', 'likely-official', 'official'];

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

function rememberHistory(report, form) {
  const target = report && report.target && typeof report.target === 'object' ? report.target : {};
  const host = typeof target.host === 'string' && target.host
    ? target.host
    : typeof target.baseUrl === 'string' ? target.baseUrl : '';
  if (!host) return;

  const auth = normalizeAuthenticity(report.authenticity);
  const isAuthOnly = report.connection === null;
  const connectionVerdict = isAuthOnly
    ? null
    : CONNECTION_VERDICTS.includes(report.verdict) ? report.verdict : null;

  const entry = {
    host,
    model: auth ? auth.model || form.model || '' : form.model || '',
    provider: typeof target.provider === 'string' ? target.provider : '',
    mode: report.mode === 'proxy' ? 'proxy' : 'browser',
    connectionVerdict,
    authVerdict: auth ? auth.verdict : null,
    at: Date.now()
  };

  const list = loadHistory().filter((item) => item.host !== host);
  list.unshift(entry);
  saveHistory(list);
}

function authMiniBadge(verdict) {
  const span = document.createElement('span');
  const tone = AUTH_VERDICT_TONES[verdict] || 'neutral';
  const label = AUTH_VERDICT_LABELS[verdict] || String(verdict);
  span.className = `auth-mini-badge tone-${tone}`;
  span.textContent = `真伪：${label}`;
  return span;
}

function renderHistory() {
  if (!historyEl) return;
  const list = loadHistory();

  if (!list.length) {
    historyEl.replaceChildren(
      emptyNote('暂无检测历史。历史只记录主机名、模型、两轴结论与时间，不保存 API Key，也不保存报告正文。')
    );
    return;
  }

  const rows = list.map((item) => {
    const connectionVerdict = CONNECTION_VERDICTS.includes(item.connectionVerdict)
      ? item.connectionVerdict
      : CONNECTION_VERDICTS.includes(item.verdict) ? item.verdict : null;
    const authVerdict = AUTH_VERDICT_LABELS[item.authVerdict] ? item.authVerdict : null;
    const time = formatTime(item.at);

    const fillButton = document.createElement('button');
    fillButton.type = 'button';
    fillButton.className = 'btn btn-ghost btn-sm no-print';
    fillButton.textContent = '填入主机';
    fillButton.addEventListener('click', () => {
      if (baseUrlInput) {
        baseUrlInput.value = `https://${item.host}`;
        baseUrlInput.focus();
        refreshModelOptions();
        refreshCostEstimate();
      }
    });

    const badges = [];
    if (connectionVerdict) badges.push(verdictBadge(connectionVerdict, { size: 'sm' }));
    else badges.push(textSpan('chip chip-neutral', '连接：未检测'));
    if (authVerdict) badges.push(authMiniBadge(authVerdict));
    else badges.push(textSpan('chip chip-plain', '真伪：未检测'));

    const meta = [];
    meta.push(`${PROVIDER_LABELS[item.provider] || item.provider || '未知协议'} · ${item.mode === 'proxy' ? '代理模式' : '浏览器模式'}`);
    if (item.model) meta.push(`模型：${item.model}`);
    meta.push(time);

    const row = document.createElement('li');
    row.className = 'history-item';
    row.append(...badges, textSpan('history-host mono', item.host), textSpan('history-meta', meta.join(' · ')), fillButton);
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

  const listNode = document.createElement('ul');
  listNode.className = 'history-list';
  listNode.append(...rows);
  historyEl.replaceChildren(head, listNode);
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

function clearKeyNow() {
  if (apiKeyInput) apiKeyInput.value = '';
  if (saveKeyCheckbox) saveKeyCheckbox.checked = false;
  clearStoredApiKey();
  if (apiKeyInput) apiKeyInput.focus();
  updateStartState();
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
    refreshModelOptions();
    refreshCostEstimate();
    updateStartState();
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

/** 检测深度三选一（契约 7.1）。 */
function initDepth() {
  const inputs = document.querySelectorAll('input[name="depth"]');
  inputs.forEach((input) => {
    input.addEventListener('change', () => {
      syncDepthUI();
    });
  });
  syncDepthUI();
}

function syncDepthUI() {
  const flags = depthOption(currentDepth());
  if (costField) costField.classList.toggle('hidden', !flags.requiresKey);
  if (modelField) modelField.classList.toggle('hidden', !flags.requiresKey);
  if (apiKeyRequired) apiKeyRequired.classList.toggle('hidden', !flags.requiresKey);
  refreshModelOptions();
  refreshCostEstimate();
  updateStartState();
}

/** 费用确认勾选 / API Key / 模型输入。 */
function initCostAndModels() {
  if (costConfirm) {
    costConfirm.addEventListener('change', () => {
      syncCostConfirmUI();
      updateStartState();
    });
  }
  if (modelInput) {
    modelInput.addEventListener('input', () => {
      refreshCostEstimate();
      updateStartState();
    });
  }
  if (apiKeyInput) {
    apiKeyInput.addEventListener('input', () => {
      if (saveKeyCheckbox && saveKeyCheckbox.checked) persistApiKey(apiKeyInput.value.trim());
      updateStartState();
    });
  }
  if (baseUrlInput) {
    baseUrlInput.addEventListener('input', () => {
      if (depthRequiresKey(currentDepth())) {
        refreshModelOptions();
        refreshCostEstimate();
      }
      updateStartState();
    });
  }
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
  if (clearKeyButton) clearKeyButton.addEventListener('click', clearKeyNow);

  const form = el('detect-form');
  if (form) {
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
        refreshModelOptions();
        refreshCostEstimate();
        updateStartState();
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
  initDepth();
  initCostAndModels();
  initButtons();
  initPrint();

  // 初始示例基址
  if (baseUrlInput && !baseUrlInput.value) baseUrlInput.value = PROVIDER_DEFAULT_BASE_URL.openai;

  renderEmpty(resultEl, '填写 API 基址并选择检测深度：默认「指纹（免费）」只做连接方式检测；「真伪 / 完整」档位需要 API Key，并会在发请求前展示费用预估。');
  renderHistory();

  // 引擎与真伪引擎并行加载，互不阻塞页面。
  updateEngineStatus('正在加载引擎…', 'plain');
  loadEngine().then((mod) => {
    if (mod) updateEngineStatus(`引擎已就绪 · v${VERSION}`, 'success');
    else updateEngineStatus('引擎未就绪（仍可查看页面）', 'warn');
    refreshModelOptions();
    refreshCostEstimate();
    updateStartState();
  });

  initAuthEngine(false);
  updateStartState();
}

init();
