/**
 * ProbeSpec 执行器（engine 所有）。纯逻辑模块，可在 Node 与浏览器运行。
 *
 * 契约要点（docs/CONTRACT.md 1.1 / 1.2）：
 *  - 产出 ProbeResult，**绝不**把 API Key 原文写进结果：authorization / x-api-key /
 *    x-goog-api-key 一律替换为 `<redacted>`，URL 查询串里的 key/token 同样脱敏。
 *  - response.headers 的键必须小写化。
 *  - bodyText 截断到 20000 字符，超出置 meta.bodyTruncated = true（但 bodyJson 用完整正文解析）。
 *  - 超时 / AbortSignal / network / cors / aborted / http 等失败都表现为 error，不抛异常。
 *  - kind === 'tls' 的探测走代理的 /inspect，结果放在 meta.tls（契约 1.2）。
 */

export const DEFAULT_TIMEOUT_MS = 12000;
/** bodyText 上限（契约 1.1）。 */
export const MAX_BODY_TEXT = 20000;
/** 原始正文读取上限，防止巨大响应撑爆内存（仅用于解析 bodyJson）。 */
export const MAX_RAW_BYTES = 2 * 1024 * 1024;

export const COMMON_PROBE_IDS = {
  notFound: 'common.not_found',
  tls: 'tls.peer',
};

const SECRET_HEADER_RE = /^(authorization|proxy-authorization|x-api-key|x-goog-api-key|api-key|apikey|x-auth-token|x-access-token|cookie|set-cookie)$/i;
const SECRET_FIELD_RE = /(api[-_]?key|secret|token|password|authorization)/i;
const SECRET_QUERY_RE = /^(key|api[-_]?key|apikey|access[-_]?token|token|secret|password|auth)$/i;

/** 拼接路径，避免 baseUrl 已含 /v1 或 /v1beta 时重复。 */
export function joinPath(base, suffix) {
  const b = String(base || '').replace(/\/+$/, '');
  let s = '/' + String(suffix || '').replace(/^\/+/, '');
  if (/(^|\/)v1$/i.test(b) && /^\/v1(\/|$)/i.test(s)) s = s.replace(/^\/v1/i, '');
  if (/(^|\/)v1beta$/i.test(b) && /^\/v1beta(\/|$)/i.test(s)) s = s.replace(/^\/v1beta/i, '');
  return b + s;
}

export function hostOf(urlString) {
  try {
    return new URL(String(urlString)).hostname.toLowerCase();
  } catch {
    return '';
  }
}

export function portOf(urlString) {
  try {
    const u = new URL(String(urlString));
    if (u.port) return Number(u.port);
    return u.protocol === 'http:' ? 80 : 443;
  } catch {
    return 443;
  }
}

export function isSecretHeaderName(name) {
  return SECRET_HEADER_RE.test(String(name || ''));
}

/** 请求头脱敏（保留前 6 位 + … 的可读性，但不可逆）。 */
export function redactHeaders(headers) {
  const out = {};
  if (!headers || typeof headers !== 'object') return out;
  for (const [key, value] of Object.entries(headers)) {
    const lower = String(key).toLowerCase();
    if (isSecretHeaderName(lower)) out[lower] = '<redacted>';
    else out[lower] = Array.isArray(value) ? value.join(', ') : String(value);
  }
  return out;
}

/** URL 脱敏：查询串里的密钥参数替换为 <redacted>。 */
export function redactUrl(url) {
  const raw = String(url || '');
  try {
    const u = new URL(raw);
    let changed = false;
    for (const key of [...u.searchParams.keys()]) {
      if (SECRET_QUERY_RE.test(key)) {
        u.searchParams.set(key, '<redacted>');
        changed = true;
      }
    }
    return changed ? u.toString() : raw;
  } catch {
    return raw.replace(/([?&](?:key|api[-_]?key|apikey|access[-_]?token|token|secret|password|auth)=)[^&#]*/gi, '$1<redacted>');
  }
}

/** 递归脱敏请求体（我们的 body 一般不含密钥，这里只是兜底）。 */
export function redactBody(value, depth = 0) {
  if (value == null || depth > 6) return value ?? null;
  if (typeof value === 'string') return value;
  if (Array.isArray(value)) return value.map((v) => redactBody(v, depth + 1));
  if (typeof value === 'object') {
    const out = {};
    for (const [k, v] of Object.entries(value)) {
      if (SECRET_FIELD_RE.test(k) && typeof v === 'string') out[k] = '<redacted>';
      else out[k] = redactBody(v, depth + 1);
    }
    return out;
  }
  return value;
}

/** 兼容 Headers 实例 / Map / 普通对象，统一为小写键的普通对象。 */
export function normalizeResponseHeaders(raw) {
  const out = {};
  const put = (name, value) => {
    const key = String(name).toLowerCase();
    out[key] = Array.isArray(value) ? value.join(', ') : String(value);
  };
  if (!raw) return out;
  if (typeof raw.forEach === 'function') {
    raw.forEach((value, name) => put(name, value));
    return out;
  }
  if (typeof raw.entries === 'function') {
    for (const [name, value] of raw.entries()) put(name, value);
    return out;
  }
  if (typeof raw === 'object') {
    for (const [name, value] of Object.entries(raw)) put(name, value);
  }
  return out;
}

/** 归一化代理 /inspect 返回的 TLS 对象（契约 1.2）。 */
export function normalizeTlsInfo(raw = {}) {
  const source = raw && typeof raw === 'object' ? raw : {};
  const issuer = source.issuer && typeof source.issuer === 'object' ? { ...source.issuer } : {};
  const subject = source.subject && typeof source.subject === 'object' ? { ...source.subject } : {};
  let altNames = source.altNames;
  if (typeof altNames === 'string') {
    altNames = altNames
      .split(/,\s*/)
      .map((n) => n.replace(/^DNS:/i, '').trim())
      .filter(Boolean);
  }
  if (!Array.isArray(altNames)) altNames = [];
  let daysRemaining = source.daysRemaining;
  if (!(typeof daysRemaining === 'number' && Number.isFinite(daysRemaining)) && source.validTo) {
    const t = Date.parse(source.validTo);
    if (Number.isFinite(t)) daysRemaining = Math.round((t - Date.now()) / 86400000);
  }
  return {
    authorized: source.authorized === true ? true : source.authorized === false ? false : null,
    issuer,
    subject,
    altNames,
    validFrom: source.validFrom ?? '',
    validTo: source.validTo ?? '',
    protocol: source.protocol ?? '',
    cipher: source.cipher ?? '',
    fingerprint256: source.fingerprint256 ?? '',
    selfSigned: source.selfSigned === true,
    daysRemaining: typeof daysRemaining === 'number' && Number.isFinite(daysRemaining) ? daysRemaining : null,
  };
}

/**
 * 把 transport 抛出的错误归类为契约允许的 kind。
 * browser 模式下 TypeError: Failed to fetch 无法区分 CORS 与网络故障，统一记为 cors 并标注歧义。
 */
export function classifyTransportError(err, mode) {
  const name = String(err?.name || '');
  const message = err && err.message ? String(err.message) : String(err ?? '未知错误');
  if (/abort/i.test(name) || /aborted|abort error/i.test(message)) return { kind: 'aborted', message };
  if (/timeout|timed out|etimedout/i.test(`${name} ${message}`)) return { kind: 'timeout', message };
  if (mode === 'browser' && /failed to fetch|networkerror|load failed|network request failed|cors/i.test(message)) {
    return { kind: 'cors', message, note: '浏览器无法区分 CORS 拦截与网络故障。' };
  }
  return { kind: 'network', message };
}

function makeTimeoutError() {
  const err = new Error('探测超时');
  err.name = 'TimeoutError';
  return err;
}

/** 在 deadline 之前完成，否则触发 onTimeout 并 reject。 */
function raceDeadline(promise, deadline, onTimeout) {
  const remain = deadline - Date.now();
  if (remain <= 0) {
    try {
      onTimeout();
    } catch {
      /* ignore */
    }
    return Promise.reject(makeTimeoutError());
  }
  let timer = null;
  const timeoutPromise = new Promise((_, reject) => {
    timer = setTimeout(() => {
      try {
        onTimeout();
      } catch {
        /* ignore */
      }
      reject(makeTimeoutError());
    }, remain);
  });
  return Promise.race([promise, timeoutPromise]).finally(() => {
    if (timer) clearTimeout(timer);
  });
}

function safeAbort(controller) {
  try {
    controller.abort();
  } catch {
    /* ignore */
  }
}

function hasHeader(headers, name) {
  return Object.keys(headers).some((k) => k.toLowerCase() === name);
}

/** 组装最终请求头：spec.headers + 按 spec.auth 注入密钥。 */
function buildRequestHeaders(spec, env) {
  const headers = {};
  for (const [k, v] of Object.entries(spec?.headers || {})) headers[String(k).toLowerCase()] = String(v);
  const key = typeof env?.apiKey === 'string' ? env.apiKey.trim() : '';
  const auth = spec?.auth || 'none';
  if (key && auth !== 'none') {
    if (auth === 'bearer') headers.authorization = `Bearer ${key}`;
    else if (auth === 'x-api-key') headers['x-api-key'] = key;
    else if (auth === 'x-goog-api-key') headers['x-goog-api-key'] = key;
  }
  return headers;
}

/** 有界读取响应正文（优先流式，兼容 fake transport 的 text/bodyText/bodyJson）。 */
async function readRawBody(res) {
  if (!res || typeof res !== 'object') return { text: '', truncated: false };
  const body = res.body;
  if (body && typeof body.getReader === 'function') {
    const reader = body.getReader();
    const chunks = [];
    let size = 0;
    let truncated = false;
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        const buf = value instanceof Uint8Array ? value : new Uint8Array(value);
        if (size + buf.byteLength > MAX_RAW_BYTES) {
          chunks.push(buf.subarray(0, Math.max(0, MAX_RAW_BYTES - size)));
          size = MAX_RAW_BYTES;
          truncated = true;
          break;
        }
        chunks.push(buf);
        size += buf.byteLength;
      }
    } finally {
      try {
        reader.releaseLock?.();
      } catch {
        /* ignore */
      }
    }
    const merged = new Uint8Array(size);
    let offset = 0;
    for (const chunk of chunks) {
      merged.set(chunk, offset);
      offset += chunk.byteLength;
    }
    return { text: new TextDecoder('utf-8').decode(merged), truncated };
  }
  if (typeof res.text === 'function') {
    const text = await res.text();
    if (typeof text === 'string' && text.length > MAX_RAW_BYTES) return { text: text.slice(0, MAX_RAW_BYTES), truncated: true };
    return { text: typeof text === 'string' ? text : String(text ?? ''), truncated: false };
  }
  if (typeof res.bodyText === 'string') return { text: res.bodyText, truncated: false };
  if (res.bodyJson !== undefined && res.bodyJson !== null) {
    try {
      return { text: JSON.stringify(res.bodyJson), truncated: false };
    } catch {
      return { text: '', truncated: false };
    }
  }
  return { text: '', truncated: false };
}

function toProbeResponse(res, rawText, rawTruncated, fakeJson) {
  const headers = normalizeResponseHeaders(res?.headers);
  let text = typeof rawText === 'string' ? rawText : '';
  let truncated = Boolean(rawTruncated);
  if (text.length > MAX_BODY_TEXT) {
    text = text.slice(0, MAX_BODY_TEXT);
    truncated = true;
  }
  let bodyJson = null;
  try {
    bodyJson = JSON.parse(rawText || '');
  } catch {
    bodyJson = null;
  }
  if (bodyJson == null && fakeJson !== undefined && fakeJson !== null) bodyJson = fakeJson;
  const contentType = headers['content-type'] || '';
  const status = typeof res?.status === 'number' && Number.isFinite(res.status) ? res.status : 0;
  return { status, headers, bodyText: text, bodyJson, contentType };
}

/** 判断 /inspect 返回的对象是否真的包含可用的 TLS 信息。 */
function looksLikeTlsInfo(tls) {
  if (!tls || typeof tls !== 'object') return false;
  if (tls.authorized === true || tls.authorized === false) return true;
  if (tls.issuer && typeof tls.issuer === 'object' && Object.keys(tls.issuer).length > 0) return true;
  if (Array.isArray(tls.altNames) && tls.altNames.length > 0) return true;
  if (typeof tls.altNames === 'string' && tls.altNames.length > 0) return true;
  if (tls.protocol || tls.fingerprint256 || tls.validTo) return true;
  return false;
}

/** TLS 探测：把 /inspect 的 JSON 映射为契约 1.2 的 meta.tls。 */
function applyTlsResult(result, res, raw) {
  let parsed = null;
  try {
    parsed = raw?.text ? JSON.parse(raw.text) : null;
  } catch {
    parsed = null;
  }
  if (!parsed && res && res.bodyJson) parsed = res.bodyJson;
  const tlsSource = parsed && typeof parsed === 'object' ? parsed.tls || parsed : null;
  // ⚠️ 只有当返回内容确实像 TLS 信息时才写入 meta.tls；否则宁可不产出证书证据，
  // 也不要把「代理读取失败」误当成「certificate 未授权」并产出 relay 信号。
  if (!looksLikeTlsInfo(tlsSource)) {
    const detail =
      parsed && typeof parsed === 'object' && parsed.error ? String(parsed.error) : '代理 /inspect 未返回可用的 TLS 证书字段。';
    result.error = { kind: 'network', message: `未能从代理 /inspect 获取 TLS 证书信息：${detail}` };
    return;
  }
  result.meta.tls = normalizeTlsInfo(tlsSource);
  result.response = { status: 0, headers: normalizeResponseHeaders(res?.headers), bodyText: '', bodyJson: null, contentType: '' };
}

function pickTransport(spec, env) {
  if (spec?.kind === 'tls') return env?.directTransport || env?.transport || null;
  return env?.transport || null;
}

/**
 * 执行单个 ProbeSpec。绝不抛异常。
 * @param {object} spec ProbeSpec
 * @param {{provider?:string, mode?:string, timeoutMs?:number, signal?:AbortSignal|null,
 *          apiKey?:string, transport?:Function|null, directTransport?:Function|null}} env
 * @returns {Promise<object>} ProbeResult
 */
export async function runProbe(spec, env = {}) {
  const startedAt = Date.now();
  const timeoutMs = Number.isFinite(env.timeoutMs) && env.timeoutMs > 0 ? env.timeoutMs : DEFAULT_TIMEOUT_MS;
  const deadline = startedAt + timeoutMs;

  const specUrl = String(spec?.url ?? '');
  const actualUrl = spec?.urlTemplate
    ? String(spec.urlTemplate).replace('{key}', encodeURIComponent(typeof env.apiKey === 'string' ? env.apiKey : ''))
    : specUrl;

  const result = {
    id: String(spec?.id ?? 'probe.unknown'),
    provider: spec?.provider ?? env.provider ?? 'openai',
    kind: spec?.kind ?? 'error',
    request: {
      method: String(spec?.method || 'GET').toUpperCase(),
      url: redactUrl(actualUrl),
      headersSent: {},
      bodySent: null,
      startedAt,
      durationMs: 0,
    },
    response: null,
    error: null,
    meta: {},
  };
  if (spec?.meta && typeof spec.meta === 'object') Object.assign(result.meta, spec.meta);
  if (spec?.paid === true) result.meta.paid = true;

  const transport = pickTransport(spec, env);
  if (typeof transport !== 'function') {
    result.error = {
      kind: 'network',
      message: '当前环境没有可用的 transport（浏览器模式需要 fetch，代理模式需要 proxyUrl 或注入 transport）。',
    };
    result.request.durationMs = Date.now() - startedAt;
    return result;
  }

  const headers = buildRequestHeaders(spec, env);
  const init = { method: result.request.method, headers };
  if (spec?.redirect) init.redirect = spec.redirect;
  if (spec?.body != null) {
    init.body = typeof spec.body === 'string' ? spec.body : JSON.stringify(spec.body);
    if (!hasHeader(headers, 'content-type')) headers['content-type'] = 'application/json';
    result.request.bodySent = redactBody(spec.body);
  }
  result.request.headersSent = redactHeaders(headers);

  const controller = typeof AbortController === 'function' ? new AbortController() : null;
  let timedOut = false;
  let externallyAborted = false;
  let onAbort = null;
  if (controller) {
    init.signal = controller.signal;
    const external = env.signal;
    if (external && typeof external === 'object') {
      if (external.aborted) {
        externallyAborted = true;
        safeAbort(controller);
      } else if (typeof external.addEventListener === 'function') {
        onAbort = () => {
          externallyAborted = true;
          safeAbort(controller);
        };
        external.addEventListener('abort', onAbort, { once: true });
      }
    }
  }
  const onTimeout = () => {
    timedOut = true;
    if (controller) safeAbort(controller);
  };

  try {
    let pending;
    try {
      pending = transport(actualUrl, init);
    } catch (err) {
      pending = Promise.reject(err);
    }
    const res = await raceDeadline(Promise.resolve(pending), deadline, onTimeout);
    if (res === null || typeof res !== 'object') {
      result.error = { kind: 'http', message: 'transport 返回了无效响应对象。' };
      result.request.durationMs = Date.now() - startedAt;
      return result;
    }
    if (spec?.kind === 'tls') {
      const raw = await raceDeadline(readRawBody(res), deadline, onTimeout);
      applyTlsResult(result, res, raw);
    } else {
      const fakeJson = res.bodyJson !== undefined ? res.bodyJson : undefined;
      const raw = await raceDeadline(readRawBody(res), deadline, onTimeout);
      result.response = toProbeResponse(res, raw.text, raw.truncated, fakeJson);
      if (raw.truncated || (typeof raw.text === 'string' && raw.text.length > MAX_BODY_TEXT)) {
        result.meta.bodyTruncated = true;
      }
      result.meta.rawLength = raw.text.length;
    }
  } catch (err) {
    if (timedOut) result.error = { kind: 'timeout', message: `探测在 ${timeoutMs}ms 内未完成。` };
    else if (externallyAborted) result.error = { kind: 'aborted', message: '探测被外部 AbortSignal 取消。' };
    else result.error = classifyTransportError(err, env.mode);
  } finally {
    if (onAbort && env.signal && typeof env.signal.removeEventListener === 'function') {
      try {
        env.signal.removeEventListener('abort', onAbort);
      } catch {
        /* ignore */
      }
    }
  }

  result.request.durationMs = Date.now() - startedAt;
  return result;
}

/** 顺序执行一批 ProbeSpec，保证不抛异常。 */
export async function runProbes(specs, env = {}) {
  const out = [];
  const list = Array.isArray(specs) ? specs : [];
  for (const spec of list) {
    try {
      out.push(await runProbe(spec, env));
    } catch (err) {
      out.push({
        id: String(spec?.id ?? 'probe.unknown'),
        provider: spec?.provider ?? env.provider ?? 'openai',
        kind: spec?.kind ?? 'error',
        request: { method: String(spec?.method || 'GET').toUpperCase(), url: redactUrl(spec?.url || ''), headersSent: {}, bodySent: null, startedAt: Date.now(), durationMs: 0 },
        response: null,
        error: { kind: 'network', message: `执行器内部错误：${err?.message || String(err)}` },
        meta: {},
      });
    }
  }
  return out;
}

/** 代理模式下的 TLS 探测：请求代理的 /inspect 端点。 */
export function buildTlsProbeSpec({ provider = 'openai', host, port = 443, inspectUrl = 'http://127.0.0.1:8787' } = {}) {
  const base = String(inspectUrl || '').replace(/\/+$/, '');
  return {
    id: COMMON_PROBE_IDS.tls,
    provider,
    kind: 'tls',
    method: 'GET',
    url: `${base}/inspect?host=${encodeURIComponent(host)}&port=${encodeURIComponent(String(port))}`,
    headers: { accept: 'application/json' },
    auth: 'none',
    body: null,
    expectStatus: 'any',
    requiresKey: false,
    paid: false,
    meta: { tlsProbe: true, inspectHost: host },
  };
}

const UNKNOWN_PATHS = {
  openai: '/__relay_detector_unknown__',
  anthropic: '/v1/__relay_detector_unknown__',
  gemini: '/v1beta/__relay_detector_unknown__',
};

/** 通用探测：请求一个随机不存在的路径，观察网关兜底行为（免费、匿名、必然失败）。 */
export function buildUnknownPathProbeSpec({ provider = 'openai', baseUrl } = {}) {
  return {
    id: COMMON_PROBE_IDS.notFound,
    provider,
    kind: 'error',
    method: 'GET',
    url: joinPath(baseUrl, UNKNOWN_PATHS[provider] || UNKNOWN_PATHS.openai),
    headers: { accept: 'application/json' },
    auth: 'none',
    body: null,
    expectStatus: 'any',
    requiresKey: false,
    paid: false,
    meta: { unknownPath: true },
  };
}
