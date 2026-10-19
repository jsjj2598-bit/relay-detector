/**
 * 检测引擎（engine 所有）：探测编排 + 多层指纹规则 + 评分。
 *
 * 公开 API（docs/CONTRACT.md 2.1）：
 *   normalizeBaseUrl(input, provider) -> { baseUrl, host, hadV1 }
 *   pickProvider(baseUrl, hint)       -> 'openai' | 'anthropic' | 'gemini'
 *   detect({ baseUrl, apiKey, provider, mode, transport, options }) -> DetectionReport
 *   runRules(ctx, provider)           -> Signal[]（去重后）
 *   createProxyTransport(proxyUrl)    -> transport（与 fetch 同签名）
 *
 * 两条不可违反的约束：
 *  1. detect() **绝不抛异常**：任何失败都体现为 probes[].error + notes。
 *  2. allowPaidProbes === false 时绝不发送可能正常计费的 chat 请求。
 */
import {
  OFFICIAL_HOSTS,
  OFFICIAL_HOST_PATTERNS,
  PROVIDER_DEFAULT_BASE_URL,
  VERSION,
} from './constants.js';
import { scoreSignals, sortSignalsByContribution } from './score.js';
import {
  runProbes,
  buildTlsProbeSpec,
  buildUnknownPathProbeSpec,
  hostOf,
  portOf,
  joinPath,
  redactUrl,
} from './probes.js';
import { COMMON_RULES } from './rules/index.js';
import { mkSignal } from './rules/util.js';
import { detectEdgeProtection } from './rules/error.js';
import { openaiProvider } from '../providers/openai.js';
import { anthropicProvider } from '../providers/anthropic.js';
import { geminiProvider } from '../providers/gemini.js';

export const PROVIDERS = {
  openai: openaiProvider,
  anthropic: anthropicProvider,
  gemini: geminiProvider,
};

export const DEFAULT_PROXY_URL = 'http://127.0.0.1:8787';
export const DETECTOR_VERSION = VERSION;

export const DEFAULT_OPTIONS = {
  timeoutMs: 12000,
  allowPaidProbes: false,
  maxModelsListed: 5000,
  proxyUrl: DEFAULT_PROXY_URL,
  signal: null,
};

const REPORT_CATEGORIES = ['url', 'tls', 'headers', 'error', 'models', 'payload', 'behavior', 'signature'];

const clamp = (n, lo, hi) => Math.min(hi, Math.max(lo, n));
const num = (v, fallback) => (typeof v === 'number' && Number.isFinite(v) ? v : fallback);
const safeString = (v) => (typeof v === 'string' ? v : '');

/** 归一化 options（未知字段忽略、数值 clamp）。 */
export function normalizeOptions(raw) {
  const input = raw && typeof raw === 'object' ? raw : {};
  return {
    timeoutMs: clamp(num(input.timeoutMs, DEFAULT_OPTIONS.timeoutMs), 500, 120000),
    allowPaidProbes: input.allowPaidProbes === true,
    maxModelsListed: clamp(num(input.maxModelsListed, DEFAULT_OPTIONS.maxModelsListed), 1, 100000),
    proxyUrl: typeof input.proxyUrl === 'string' && input.proxyUrl ? input.proxyUrl : DEFAULT_PROXY_URL,
    signal: input.signal && typeof input.signal === 'object' ? input.signal : null,
  };
}

/**
 * 纯函数：规范化基址。补协议、去尾斜杠、识别是否已含 /v1（或 /v1beta）。
 * @returns {{baseUrl:string, host:string, hadV1:boolean}}
 */
export function normalizeBaseUrl(input, provider = 'openai') {
  const raw = safeString(input).trim();
  const providerId = PROVIDERS[provider] ? provider : 'openai';
  const fallback = PROVIDER_DEFAULT_BASE_URL[providerId] || PROVIDER_DEFAULT_BASE_URL.openai;
  const v1Pattern = /(^|\/)v1(beta)?(\/|$)/i;

  if (!raw) {
    return { baseUrl: fallback.replace(/\/+$/, ''), host: hostOf(fallback), hadV1: v1Pattern.test(fallback) };
  }

  let candidate = raw;
  if (!/^[a-z][a-z0-9+.-]*:\/\//i.test(candidate)) {
    const local = /^(localhost|127\.0\.0\.1|\[?::1\]?|0\.0\.0\.0)(:|\/|$)/i.test(candidate);
    candidate = `${local ? 'http' : 'https'}://${candidate}`;
  }

  let url = null;
  try {
    url = new URL(candidate);
  } catch {
    url = null;
  }
  if (!url) {
    const stripped = raw.replace(/\/+$/, '');
    return { baseUrl: stripped, host: hostOf(stripped), hadV1: v1Pattern.test(stripped) };
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    try {
      url = new URL(`https://${raw.replace(/^[a-z][a-z0-9+.-]*:\/\//i, '')}`);
    } catch {
      const stripped = raw.replace(/\/+$/, '');
      return { baseUrl: stripped, host: hostOf(stripped), hadV1: v1Pattern.test(stripped) };
    }
  }
  const pathname = url.pathname.replace(/\/+$/, '');
  return {
    baseUrl: `${url.origin}${pathname}`,
    host: url.hostname.toLowerCase(),
    hadV1: v1Pattern.test(pathname),
  };
}

/**
 * 纯函数：推断协议。
 * hint 非 'auto' 时直接采用；否则按主机名 / 路径特征推断，默认 openai。
 */
export function pickProvider(baseUrl, hint = 'auto') {
  if (hint && hint !== 'auto' && PROVIDERS[hint]) return hint;
  const text = safeString(baseUrl).toLowerCase();
  const host = hostOf(text) || text;
  if (/anthropic|claude/.test(host)) return 'anthropic';
  if (/generativelanguage|gemini|googleapis/.test(host)) return 'gemini';
  if (/openai\.azure\.com|services\.ai\.azure\.com/.test(host)) return 'openai';
  if (/\/v1beta(\/|$)/.test(text)) return 'gemini';
  if (/(^|\/)v1(\/|$)/.test(text) || /openai/.test(host)) return 'openai';
  return 'openai';
}

/** 命中官方白名单 / 正规厂商 / Azure 模式的头（用于 report.target.matchedOfficialHost）。 */
export function findMatchedOfficialHost(host) {
  const h = safeString(host).toLowerCase();
  if (!h) return null;
  for (const list of Object.values(OFFICIAL_HOSTS)) {
    for (const cand of list || []) if (safeString(cand).toLowerCase() === h) return cand;
  }
  for (const pattern of OFFICIAL_HOST_PATTERNS) if (pattern.pattern.test(h)) return h;
  return null;
}

/**
 * 代理模式 transport：把目标 URL 包成 `proxyUrl/proxy?url=<encoded>`。
 * 与 fetch 同签名，便于 UI 直接注入 detect({ transport }).
 */
export function createProxyTransport(proxyUrl = DEFAULT_PROXY_URL, { fetchImpl } = {}) {
  const base = safeString(proxyUrl || DEFAULT_PROXY_URL).replace(/\/+$/, '');
  const impl =
    typeof fetchImpl === 'function'
      ? fetchImpl
      : typeof globalThis.fetch === 'function'
        ? globalThis.fetch.bind(globalThis)
        : null;
  return async function proxyTransport(url, init = {}) {
    if (typeof impl !== 'function') throw new TypeError('当前环境没有可用的 fetch 实现。');
    const target = `${base}/proxy?url=${encodeURIComponent(safeString(url))}`;
    const headers = { ...(init?.headers || {}), 'x-relay-detector-hop': '1' };
    return impl(target, { ...init, headers });
  };
}

function resolveTransport(input, options, mode) {
  if (typeof input?.transport === 'function') return input.transport;
  if (typeof globalThis.fetch !== 'function') return null;
  const rawFetch = globalThis.fetch.bind(globalThis);
  if (mode === 'proxy') return createProxyTransport(options.proxyUrl, { fetchImpl: rawFetch });
  return rawFetch;
}

function sanitizeSignal(raw, defaultSource) {
  if (!raw || typeof raw !== 'object') return null;
  const signal = mkSignal({ ...raw, source: raw.source || defaultSource || 'rules/index.js' });
  if (!signal) return null;
  if (!signal.evidence) signal.evidence = { note: '规则未提供原始证据' };
  return signal;
}

/**
 * 依次执行 provider.rules 与 COMMON_RULES，按 id 去重（同 id 保留第一个）。
 * @param {object} ctx
 * @param {{id?:string, rules?:Function[]}} [provider]
 * @returns {object[]} Signal[]
 */
export function runRules(ctx, provider) {
  const sources = [];
  if (provider && Array.isArray(provider.rules)) {
    for (const rule of provider.rules) sources.push({ rule, source: `providers/${provider.id}.js` });
  }
  for (const rule of COMMON_RULES) sources.push({ rule, source: 'rules/index.js' });

  const seen = new Set();
  const out = [];
  for (const { rule, source } of sources) {
    if (typeof rule !== 'function') continue;
    let produced = null;
    try {
      produced = rule(ctx);
    } catch (err) {
      if (typeof ctx?.note === 'function') ctx.note(`规则执行失败（${source}）：${err?.message || String(err)}`);
      continue;
    }
    if (!produced) continue;
    const list = Array.isArray(produced) ? produced : [produced];
    for (const raw of list) {
      const signal = sanitizeSignal(raw, source);
      if (!signal || seen.has(signal.id)) continue;
      seen.add(signal.id);
      out.push(signal);
    }
  }
  return out;
}

function dedupeSpecs(specs) {
  const seen = new Set();
  const out = [];
  for (const spec of specs) {
    if (!spec || typeof spec !== 'object') continue;
    const id = String(spec.id || '');
    if (!id || seen.has(id)) continue;
    seen.add(id);
    out.push(spec);
  }
  return out;
}

function hasCloudflareMarkers(ctx) {
  for (const probe of ctx.probes) {
    if (probe?.kind === 'tls') continue;
    const headers = probe?.response?.headers || {};
    if (headers['cf-ray'] || /cloudflare/i.test(String(headers.server || ''))) return true;
  }
  return false;
}

function buildNotes(ctx, options, mode, apiKey) {
  const notes = [];
  if (mode === 'browser') {
    notes.push('浏览器模式受 CORS 限制，部分响应头与 TLS 证书不可见。');
    notes.push('浏览器直连无法读取对端 TLS 证书；若需要证书层证据，请改用本地代理模式。');
  } else {
    notes.push('代理模式：TLS 证据来自本地代理的 /inspect 端点，反映的是「代理 → 目标」的对端证书。');
  }
  if (!apiKey) notes.push('未提供 API Key：本次只执行匿名 / 必然失败的探测，官方限流与计费类响应头不可见。');
  if (!options.allowPaidProbes) notes.push('未启用付费探测：未发送任何可能计费的 chat 请求，payload / 行为类证据有限。');
  if (detectEdgeProtection(ctx)) {
    notes.push('目标返回边缘防护拦截（HTTP 403 / Request not allowed），这是 CDN/WAF 行为，不能作为中转证据；建议改用本地代理或带密钥重试。');
  }
  if (hasCloudflareMarkers(ctx)) {
    notes.push('校准事实：官方 api.anthropic.com 本身就在 Cloudflare 后，且证书由公共 CA 签发；因此 CDN / 公共 CA 均不作为中转证据。');
  }
  if (ctx.probes.length > 0 && !ctx.probes.some((p) => p.kind !== 'tls' && p.response !== null)) {
    notes.push('所有探测均未得到响应，无法形成有效证据链。');
  }
  if (ctx.probes.some((p) => p.meta?.bodyTruncated === true)) {
    notes.push('至少一条响应正文超过 20000 字符，已截断（完整 JSON 仍用于结构解析）。');
  }
  for (const note of ctx.ruleNotes || []) notes.push(note);
  return [...new Set(notes.filter(Boolean))];
}

function emptyByCategory() {
  const out = {};
  for (const category of REPORT_CATEGORIES) out[category] = [];
  return out;
}

function buildReport({ target, mode, signals, probes, notes, startedAt, authenticity = null }) {
  const scored = scoreSignals(signals);
  const sorted = sortSignalsByContribution(signals);
  const byCategory = emptyByCategory();
  for (const signal of sorted) {
    if (!byCategory[signal.category]) byCategory[signal.category] = [];
    byCategory[signal.category].push(signal);
  }
  const finishedAt = Date.now();
  return {
    schema: 1,
    target,
    mode,
    score: scored.score,
    officialScore: scored.officialScore,
    evidenceStrength: scored.evidenceStrength,
    verdict: scored.verdict,
    signals: sorted,
    byCategory,
    probes,
    // 契约 v2：上游真伪轴（正交于上面的连接轴）。未请求真伪检测时为 null。
    authenticity,
    capabilities: {
      canReadHeaders: true,
      tlsAvailable: mode === 'proxy' && probes.some((p) => p.kind === 'tls' && Boolean(p.meta?.tls)),
      corsBlocked: probes.some((p) => p.error?.kind === 'cors'),
      networkReachable: probes.some((p) => p.kind !== 'tls' && p.response !== null),
      costIncurred:
        probes.some((p) => p.meta?.paid === true && p.response !== null) ||
        Boolean(authenticity?.cost?.requests),
    },
    notes,
    startedAt,
    finishedAt,
    durationMs: finishedAt - startedAt,
    // 以下为便于 UI 展示的附加诊断字段（契约未强制，向后兼容）
    points: {
      relay: scored.relayPoints,
      official: scored.officialPoints,
      neutral: scored.neutralPoints,
      directional: scored.directionalPoints,
    },
    breakdown: scored.breakdown,
    flags: scored.flags,
    detectorVersion: DETECTOR_VERSION,
  };
}

/**
 * 构造「检测无效」形态的真伪报告（契约 6.6）。
 * 这类结果**不是**低分，UI 必须显示为灰色无效态。
 */
function invalidAuthenticity({ providerId, model, mode, code, message }) {
  const now = Date.now();
  return {
    schema: 1,
    provider: providerId,
    model: model || null,
    mode: mode || 'standard',
    score: 0,
    verdict: 'invalid',
    summaryText: '检测无效',
    detectors: [],
    criticalIssues: [],
    runError: { code, message },
    cost: { requests: 0, promptTokens: 0, completionTokens: 0, note: '未发请求' },
    warnings: [],
    startedAt: now,
    finishedAt: now,
    durationMs: 0,
  };
}

/**
 * 契约 v2 真伪轴：按需执行上游真伪检测。
 *
 * 设计要点：
 * - 用**动态 import** 加载 `./auth/index.js`，因此 v2 模块缺失/语法错误都不会影响 v1 指纹检测。
 * - 任何异常都转成 `verdict: 'invalid'`，绝不让真伪检测把整个 detect() 搞崩。
 * - 未提供 key / 未指定模型时直接返回 invalid（而不是发一批注定 401 的请求）。
 */
async function runAuthenticityPhase({ input, options, mode, apiKey, providerId, norm, transport, notes }) {
  const requested = input?.authenticity;
  if (!requested) return null;

  const cfg = requested === true ? {} : typeof requested === 'object' ? requested : {};
  const model = safeString(cfg.model) || safeString(input?.model);
  const authMode = ['quick', 'standard', 'full'].includes(cfg.mode) ? cfg.mode : 'standard';

  if (!apiKey) {
    notes.push('未提供 API Key，已跳过上游真伪检测（真伪检测必须携带有效 Key）。');
    return invalidAuthenticity({
      providerId,
      model,
      mode: authMode,
      code: 'missing_api_key',
      message: '未提供 API Key，无法执行真伪检测。',
    });
  }
  if (!model) {
    notes.push('未指定模型，已跳过上游真伪检测（真伪判定必须绑定具体模型）。');
    return invalidAuthenticity({
      providerId,
      model,
      mode: authMode,
      code: 'missing_model',
      message: '未指定要检测的模型，无法执行真伪检测。',
    });
  }

  let mod;
  try {
    mod = await import('./auth/index.js');
  } catch (err) {
    notes.push('真伪检测模块不可用（可能是版本不匹配）：' + (err?.message || String(err)));
    return invalidAuthenticity({
      providerId,
      model,
      mode: authMode,
      code: 'engine_unavailable',
      message: '真伪检测模块不可用。',
    });
  }

  try {
    const result = await mod.runAuthenticity({
      provider: providerId,
      baseUrl: norm.baseUrl,
      apiKey,
      model,
      mode: authMode,
      transport,
      options: {
        // thinking 类探针单次可能 60s+，真伪阶段给更宽松的超时。
        timeoutMs: Number(cfg.timeoutMs) || 120000,
        signal: options.signal || null,
        // 注意：不能用 `Number(x) || undefined` —— 当调用方显式传 0（表示「一个请求都不许发」）
        // 时会被吞成 undefined，runner 会回落到默认 24，违反「maxRequests 是硬上限」的语义。
        maxRequests: Number.isFinite(Number(cfg.maxRequests)) ? Number(cfg.maxRequests) : undefined,
      },
    });
    if (!result || typeof result !== 'object') {
      notes.push('真伪检测返回了空结果。');
      return invalidAuthenticity({
        providerId,
        model,
        mode: authMode,
        code: 'empty_result',
        message: '真伪检测未返回结果。',
      });
    }
    if (result.runError) {
      notes.push('真伪检测无效：' + (result.runError.message || result.runError.code));
    }
    for (const warning of result.warnings || []) notes.push('真伪检测提示：' + warning);
    return result;
  } catch (err) {
    notes.push('真伪检测执行失败，已降级为「检测无效」：' + (err?.message || String(err)));
    return invalidAuthenticity({
      providerId,
      model,
      mode: authMode,
      code: 'engine_error',
      message: '真伪检测执行失败：' + (err?.message || String(err)),
    });
  }
}

/** 内部错误时的降级报告：保证 detect 永不抛异常。 */
function fallbackReport(input, startedAt, error) {
  let providerId = 'openai';
  let norm = { baseUrl: '', host: '', hadV1: false };
  try {
    providerId = pickProvider(safeString(input?.baseUrl), input?.provider ?? 'auto');
    norm = normalizeBaseUrl(input?.baseUrl, providerId);
  } catch {
    /* ignore */
  }
  const target = {
    input: redactUrl(safeString(input?.baseUrl)),
    baseUrl: norm.baseUrl,
    host: norm.host,
    provider: providerId,
    providerSource: input?.provider && input.provider !== 'auto' ? 'explicit' : 'auto',
    matchedOfficialHost: findMatchedOfficialHost(norm.host),
  };
  return buildReport({
    target,
    mode: input?.mode === 'proxy' ? 'proxy' : 'browser',
    signals: [],
    probes: [],
    notes: [
      `检测过程发生内部错误，已降级返回空报告（不影响后续重试）：${error?.message || String(error)}`,
    ],
    startedAt,
  });
}

/**
 * 执行一次完整检测。**绝不抛异常**。
 *
 * 两根正交的轴：
 * - 连接轴（v1）：`report.score` / `report.verdict`，回答「官方还是第三方」。
 * - 真伪轴（v2）：`report.authenticity`，回答「上游是不是真模型」。未请求时为 `null`。
 *
 * @param {object} input
 * @param {string} [input.baseUrl]
 * @param {string} [input.apiKey]
 * @param {'auto'|'openai'|'anthropic'|'gemini'} [input.provider]
 * @param {'browser'|'proxy'} [input.mode]
 * @param {Function} [input.transport]
 * @param {string} [input.model] 目标模型（真伪检测必填）
 * @param {false|true|{model?:string, mode?:'quick'|'standard'|'full', timeoutMs?:number, maxRequests?:number}} [input.authenticity]
 *   是否/如何执行 v2 真伪检测。`true` 等价于 `{mode:'standard'}` 且模型取 `input.model`。
 * @param {object} [input.options]
 */
export async function detect(input = {}) {
  const startedAt = Date.now();
  try {
    return await detectInner(input, startedAt);
  } catch (error) {
    return fallbackReport(input, startedAt, error);
  }
}

async function detectInner(input, startedAt) {
  const options = normalizeOptions(input.options);
  const mode = input.mode === 'proxy' ? 'proxy' : 'browser';
  const apiKey = safeString(input.apiKey);
  const providerId = pickProvider(safeString(input.baseUrl), input.provider);
  const norm = normalizeBaseUrl(input.baseUrl, providerId);
  const provider = PROVIDERS[providerId];

  const target = {
    // input 保留用户原始输入用于展示，但同样做密钥脱敏（用户可能把 key 写在 URL 查询串里）。
    input: redactUrl(safeString(input.baseUrl)),
    baseUrl: norm.baseUrl,
    host: norm.host,
    provider: providerId,
    providerSource: input.provider && input.provider !== 'auto' ? 'explicit' : 'auto',
    matchedOfficialHost: findMatchedOfficialHost(norm.host),
  };

  const probes = [];
  const ruleNotes = [];
  const ctx = {
    target,
    options,
    mode,
    probes,
    hasKey: Boolean(apiKey),
    get: (id) => probes.find((p) => p.id === id) || null,
    json: (id) => {
      const probe = probes.find((p) => p.id === id);
      return probe?.response?.bodyJson ?? null;
    },
    text: (id) => {
      const probe = probes.find((p) => p.id === id);
      return probe?.response?.bodyText ?? null;
    },
    note: (message) => {
      const text = safeString(message);
      if (text && !ruleNotes.includes(text)) ruleNotes.push(text);
    },
    ruleNotes,
  };

  const transport = resolveTransport(input, options, mode);
  const directTransport = typeof globalThis.fetch === 'function' ? globalThis.fetch.bind(globalThis) : null;
  const env = {
    provider: providerId,
    mode,
    timeoutMs: options.timeoutMs,
    signal: options.signal,
    apiKey,
    transport,
    directTransport,
  };

  // ---- 探测编排 ----------------------------------------------------------
  let specs = [];
  try {
    if (provider && typeof provider.buildProbes === 'function') {
      specs.push(...(provider.buildProbes(ctx) || []));
    }
  } catch (err) {
    ctx.note(`构造协议探测失败（${providerId}）：${err?.message || String(err)}`);
  }
  specs.push(buildUnknownPathProbeSpec({ provider: providerId, baseUrl: norm.baseUrl }));
  specs = dedupeSpecs(specs).filter((spec) => !spec.paid || options.allowPaidProbes);
  if (mode === 'proxy' && norm.host) {
    specs.push(
      buildTlsProbeSpec({
        provider: providerId,
        host: norm.host,
        port: portOf(norm.baseUrl),
        inspectUrl: options.proxyUrl,
      }),
    );
  }

  const results = await runProbes(specs, env);
  for (const result of results) probes.push(result);

  // 依赖上一步结果的后续探测（例如 GET /v1/models/{id}）
  try {
    if (provider && typeof provider.buildFollowUpProbes === 'function') {
      const extra = dedupeSpecs(provider.buildFollowUpProbes(ctx) || []).filter(
        (spec) => !spec.paid || options.allowPaidProbes,
      );
      const existing = new Set(probes.map((p) => p.id));
      const pending = extra.filter((spec) => !existing.has(spec.id));
      if (pending.length > 0) {
        const more = await runProbes(pending, env);
        for (const result of more) probes.push(result);
      }
    }
  } catch (err) {
    ctx.note(`构造后续探测失败：${err?.message || String(err)}`);
  }

  // ---- 规则与评分 --------------------------------------------------------
  const signals = runRules(ctx, provider);
  const notes = buildNotes(ctx, options, mode, apiKey);

  // ---- 契约 v2：上游真伪轴（与连接轴正交，按需执行） --------------------
  const authenticity = await runAuthenticityPhase({
    input,
    options,
    mode,
    apiKey,
    providerId,
    norm,
    transport,
    notes,
  });

  return buildReport({ target, mode, signals, probes, notes, startedAt, authenticity });
}

export { joinPath };
export default detect;
