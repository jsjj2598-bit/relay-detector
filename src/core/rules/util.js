/**
 * 规则层共享工具（engine 所有）。纯逻辑模块，不触碰 document / window。
 *
 * 所有规则都通过 `mkSignal` 产出 Signal，`mkSignal` 负责：
 *   - 归一化 category / verdict
 *   - 强制 id 使用契约 §3 规定的命名空间前缀（避免 verifier 的形状断言失败）
 *   - clamp weight ∈ [0,100]、confidence ∈ [0,1]
 *   - 保证 evidence 一定存在（契约 1.3 硬性要求）
 */

const CATEGORY_PREFIX = {
  url: 'url.',
  tls: 'tls.',
  headers: 'headers.',
  error: 'error.',
  models: 'models.',
  payload: 'payload.',
  behavior: 'behavior.',
  signature: 'signature.',
  other: 'other.',
};

const VALID_VERDICTS = new Set(['relay', 'official', 'neutral']);

const num = (v, fallback = 0) => (typeof v === 'number' && Number.isFinite(v) ? v : fallback);
const clamp = (n, lo, hi) => Math.min(hi, Math.max(lo, n));

export function isObject(v) {
  return Boolean(v) && typeof v === 'object' && !Array.isArray(v);
}

export function safeStringify(value) {
  try {
    return JSON.stringify(value);
  } catch {
    return '';
  }
}

/**
 * 构造合法 Signal。
 * @param {{id:string, category:string, verdict:string, weight?:number, confidence?:number,
 *          title?:string, detail?:string, evidence?:any, source?:string}} spec
 */
export function mkSignal(spec) {
  if (!isObject(spec)) return null;
  const cat = typeof spec.category === 'string' && CATEGORY_PREFIX[spec.category] ? spec.category : 'other';
  let id = String(spec.id ?? '').trim();
  if (!id) return null;
  const prefix = CATEGORY_PREFIX[cat];
  if (!id.startsWith(prefix)) {
    id = prefix + id.replace(/^[a-z0-9_]+[.\-:]/i, '');
  }
  const verdict = VALID_VERDICTS.has(spec.verdict) ? spec.verdict : 'neutral';
  return {
    id,
    category: cat,
    verdict,
    weight: clamp(num(spec.weight), 0, 100),
    confidence: clamp(num(spec.confidence, 0.5), 0, 1),
    title: String(spec.title || id),
    detail: String(spec.detail || ''),
    evidence: spec.evidence == null ? { note: '规则未提供原始证据' } : spec.evidence,
    source: spec.source || 'rules/unknown.js',
  };
}

/** 取全部**面向目标**的探测（自动排除 kind === 'tls'）。 */
export function eachProbe(ctx, predicate) {
  // TLS 探测的响应来自本地代理的 /inspect，不是目标响应；其响应头（CORS、x-relay-detector-*）
  // 绝不能参与 headers / signature / payload / behavior 类规则，否则会污染证据链。
  const list = (Array.isArray(ctx?.probes) ? ctx.probes : []).filter((p) => p && p.kind !== 'tls');
  return predicate ? list.filter(predicate) : list;
}

/** 取第一条满足条件的探测。 */
export function firstProbe(ctx, predicate) {
  return eachProbe(ctx, predicate)[0] || null;
}

/** 响应头（过滤掉本工具代理自己添加的 x-relay-detector-* 传输层标记）。 */
export function headersOf(probe) {
  const h = probe?.response?.headers;
  if (!isObject(h)) return {};
  const out = {};
  for (const [key, value] of Object.entries(h)) {
    if (/^x-relay-detector-/i.test(key)) continue;
    out[key] = value;
  }
  return out;
}

export function jsonOf(probe) {
  const j = probe?.response?.bodyJson;
  return j === undefined ? null : j;
}

/** 某条探测可匹配的正文：bodyText + bodyJson 的紧凑序列化（保证正则能看到被截断 JSON 之外的结构）。 */
export function textOf(probe) {
  const r = probe?.response;
  if (!r) return '';
  const parts = [];
  if (typeof r.bodyText === 'string' && r.bodyText) parts.push(r.bodyText);
  if (r.bodyJson !== null && r.bodyJson !== undefined && r.bodyJson !== '') {
    const jsonText = safeStringify(r.bodyJson);
    if (jsonText && !parts.includes(jsonText)) parts.push(jsonText);
  }
  return parts.join('\n');
}

export function combinedText(ctx, predicate) {
  return eachProbe(ctx, predicate)
    .map((p) => textOf(p))
    .filter(Boolean)
    .join('\n');
}

/** 在所有探测的响应头里查找 name 匹配 predicate 的头。 */
export function findHeader(ctx, predicate) {
  for (const probe of eachProbe(ctx)) {
    const headers = headersOf(probe);
    for (const [name, value] of Object.entries(headers)) {
      if (predicate(String(name).toLowerCase(), String(value))) {
        return { probeId: probe.id, name, value: String(value) };
      }
    }
  }
  return null;
}

/** 从各种模型列表形状中提取模型 id / name。 */
export function modelIdsFrom(json) {
  if (!json) return [];
  let arr = null;
  if (Array.isArray(json)) arr = json;
  else if (Array.isArray(json.data)) arr = json.data;
  else if (Array.isArray(json.models)) arr = json.models;
  if (!arr) return [];
  const out = [];
  for (const item of arr) {
    if (typeof item === 'string' && item) out.push(item);
    else if (isObject(item)) {
      const id = item.id ?? item.name ?? item.model;
      if (typeof id === 'string' && id) out.push(id);
    }
  }
  return out;
}

/** 归一化模型 id：小写、去掉 `models/` 资源前缀。 */
export function normalizeModelId(id) {
  return String(id || '')
    .toLowerCase()
    .replace(/^models\//, '')
    .trim();
}

export { CATEGORY_PREFIX };
