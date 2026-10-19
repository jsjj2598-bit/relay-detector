/**
 * 真伪检测器基类与通用工具（契约 v2 §6.1 / §6.2）。
 *
 * 纯逻辑模块：不得直接触碰 `document` / `window`，必须能在 Node 下 import。
 *
 * 两类检测器：
 *  - `ActiveDetector`：自己发请求（`run(ctx)`）；
 *  - `PassiveDetector`：复用别人已经发出的请求（`observe(ctx, exchange)` + `finalize(ctx)`），
 *    零额外 token 成本。
 *
 * **硬性语义**：检测器 `run()` / `finalize()` 绝不抛异常（runner 也会兜住），
 * 失败一律表达为 `status: 'error'`；`skip` / `error` 的 `score` 恒为 0 且不进入加权分母。
 */

const clampNumber = (n, lo, hi) => Math.min(hi, Math.max(lo, n));

/** 安全取有限数字。 */
export function toFiniteNumber(value, fallback = 0) {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback;
}

/** 把分数夹到 0..100 并取整。 */
export function clampScore(value) {
  return Math.round(clampNumber(toFiniteNumber(value, 0), 0, 100));
}

/** 安全字符串化（对象返回空串，避免把 `[object Object]` 写进报告）。 */
export function safeText(value) {
  return typeof value === 'string' ? value : '';
}

/**
 * API Key 脱敏（契约 §6.7）：保留前 4 + 后 4，中间替换为 `••••`。
 * 报告里**绝不**出现完整 key。
 *
 * @param {string} apiKey
 * @returns {string}
 */
export function maskApiKey(apiKey) {
  const key = typeof apiKey === 'string' ? apiKey : '';
  if (!key) return '';
  if (key.length <= 8) return '••••';
  return `${key.slice(0, 4)}••••${key.slice(-4)}`;
}

/**
 * 拼接 Anthropic / OpenAI 内容块数组里的文本。
 * 只取真正的正文块（`type === 'text'` 或没有 type 但带 text 的块），
 * **不**把 thinking / redacted_thinking / tool_use 的内容混进正文。
 *
 * @param {Array<unknown>} blocks
 * @param {string} [glue]
 * @returns {string}
 */
export function joinTextBlocks(blocks, glue = '') {
  if (!Array.isArray(blocks)) return '';
  const parts = [];
  for (const block of blocks) {
    if (!block) continue;
    if (typeof block === 'string') {
      parts.push(block);
      continue;
    }
    if (typeof block !== 'object') continue;
    const type = typeof block.type === 'string' ? block.type : '';
    if (type && type !== 'text') continue;
    const text = typeof block.text === 'string' ? block.text : '';
    if (text) parts.push(text);
  }
  return parts.join(glue);
}

/**
 * 从任意协议的响应载荷里提取助手正文文本（契约 §6.4 的检测器共用）。
 *
 * 支持：
 *  - OpenAI：`choices[0].message.content`（字符串或内容块数组）/ `choices[0].delta.content`
 *  - Anthropic：`content[]` 的 text 块
 *  - Gemini：`candidates[0].content.parts[]` 的 text 块
 *  - 直接传字符串 / 内容块数组
 *
 * @param {unknown} payload
 * @param {string} [provider] 提示协议；缺省时自动识别
 * @returns {string}
 */
export function pickTextContent(payload, provider = '') {
  if (payload == null) return '';
  if (typeof payload === 'string') return payload;
  if (Array.isArray(payload)) return joinTextBlocks(payload);
  if (typeof payload !== 'object') return '';

  const hint = safeText(provider).toLowerCase();
  const hasOwn = (obj, key) => Object.prototype.hasOwnProperty.call(obj, key);
  const fromChoices = () => {
    const choice = Array.isArray(payload.choices) ? payload.choices[0] : null;
    if (!choice || typeof choice !== 'object') return '';
    const message = choice.message && typeof choice.message === 'object' ? choice.message : null;
    const delta = choice.delta && typeof choice.delta === 'object' ? choice.delta : null;
    const content = message ? message.content : delta ? delta.content : undefined;
    if (typeof content === 'string') return content;
    if (Array.isArray(content)) return joinTextBlocks(content);
    if (typeof choice.text === 'string') return choice.text;
    return '';
  };

  if (hint === 'openai') {
    const text = fromChoices();
    if (text) return text;
  }
  if (hint === 'anthropic') {
    if (Array.isArray(payload.content)) return joinTextBlocks(payload.content);
  }
  if (hint === 'gemini') {
    const parts = payload.candidates?.[0]?.content?.parts;
    if (Array.isArray(parts)) return joinTextBlocks(parts);
  }

  // 自动识别
  if (Array.isArray(payload.content)) return joinTextBlocks(payload.content);
  const choicesText = fromChoices();
  if (choicesText) return choicesText;
  const parts = payload.candidates?.[0]?.content?.parts;
  if (Array.isArray(parts)) return joinTextBlocks(parts);
  if (hasOwn(payload, 'output_text') && typeof payload.output_text === 'string') return payload.output_text;
  return '';
}

/**
 * 遍历 JSON，收集 `{ path, key, value }` 叶子（用于跨厂商字段泄漏检查）。
 * 有节点上限，防止恶意超大响应阻塞；不抛异常。
 *
 * @param {unknown} root
 * @param {{maxNodes?:number, maxDepth?:number}} [options]
 * @returns {Array<{path:string, key:string, value:unknown}>}
 */
export function collectJsonLeaves(root, options = {}) {
  const maxNodes = clampNumber(toFiniteNumber(options.maxNodes, 2000), 1, 20000);
  const maxDepth = clampNumber(toFiniteNumber(options.maxDepth, 6), 1, 12);
  const out = [];
  const seen = new Set();
  const walk = (value, path, depth) => {
    if (out.length >= maxNodes || depth > maxDepth) return;
    if (value == null) return;
    if (Array.isArray(value)) {
      const limit = Math.min(value.length, 100);
      for (let i = 0; i < limit; i += 1) walk(value[i], `${path}[${i}]`, depth + 1);
      return;
    }
    if (typeof value !== 'object') {
      out.push({ path, key: path.split('.').pop() || '', value });
      return;
    }
    if (seen.has(value)) return;
    seen.add(value);
    for (const [key, child] of Object.entries(value)) {
      if (out.length >= maxNodes) break;
      const childPath = path ? `${path}.${key}` : key;
      if (child != null && typeof child === 'object') walk(child, childPath, depth + 1);
      else out.push({ path: childPath, key, value: child });
    }
  };
  walk(root, '', 0);
  return out;
}

/** 深拷贝为可序列化结构；失败时返回保底值（报告必须能 JSON.stringify）。 */
export function toSerializable(value, fallback = {}) {
  try {
    const text = JSON.stringify(value);
    if (typeof text !== 'string') return fallback;
    return JSON.parse(text);
  } catch {
    return fallback;
  }
}

/**
 * 取（或初始化）某检测器在本轮运行中的状态。
 * 状态挂在 ctx 上而不是检测器实例上，避免同一实例被并发运行时互相污染。
 *
 * @param {object} ctx
 * @param {string} name
 * @param {() => object} init
 */
export function stateFor(ctx, name, init) {
  if (!ctx || typeof ctx !== 'object') return init();
  if (!ctx.authState || typeof ctx.authState !== 'object') ctx.authState = {};
  if (!ctx.authState[name]) ctx.authState[name] = init();
  return ctx.authState[name];
}

/** 一条 DetectorResult 的合法 status。 */
export const DETECTOR_STATUSES = ['pass', 'fail', 'skip', 'error'];

/**
 * 把裸结果规范成契约 §6.2 的 DetectorResult（检测器内部统一用它，runner 也会再兜一层）。
 *
 * @param {object} detector
 * @param {object} fields
 * @returns {object}
 */
export function buildResult(detector, fields = {}) {
  const meta = detector && typeof detector === 'object' ? detector : {};
  const status = DETECTOR_STATUSES.includes(fields.status) ? fields.status : 'error';
  const terminal = status === 'skip' || status === 'error';
  const details =
    fields.details && typeof fields.details === 'object' ? toSerializable(fields.details, {}) : {};
  const criticalIssues = Array.isArray(fields.criticalIssues)
    ? fields.criticalIssues
        .filter((issue) => issue && typeof issue === 'object')
        .map((issue) => ({
          code: safeText(issue.code) || 'unknown',
          message: safeText(issue.message) || '未提供说明',
          evidence: issue.evidence !== undefined ? toSerializable(issue.evidence, {}) : { note: '未提供证据' }
        }))
    : [];
  const reason =
    (typeof fields.reason === 'string' && fields.reason) ||
    (typeof details.reason === 'string' && details.reason) ||
    null;
  const result = {
    name: safeText(meta.name) || 'unknown_detector',
    displayName: safeText(meta.displayName) || safeText(meta.name) || '未知检测器',
    weight: clampNumber(toFiniteNumber(meta.weight, 0), 0, 100),
    status,
    score: terminal ? 0 : clampScore(fields.score),
    details,
    error: typeof fields.error === 'string' && fields.error ? fields.error : null,
    durationMs: Math.max(0, Math.round(toFiniteNumber(fields.durationMs, 0))),
    criticalIssues
  };
  if (reason) {
    result.reason = reason;
    if (typeof result.details.reason !== 'string') result.details.reason = reason;
  }
  if (typeof fields.errorKind === 'string' && fields.errorKind) result.errorKind = fields.errorKind;
  return result;
}

/** 构造 skip 结果：score 恒为 0，理由同时放在 `reason` 与 `details.reason`。 */
export function buildSkip(detector, reason, message, extraDetails = {}) {
  return buildResult(detector, {
    status: 'skip',
    score: 0,
    reason,
    details: {
      ...extraDetails,
      reason,
      message: message || reason,
      skip: true
    }
  });
}

/** 构造 error 结果：score 恒为 0；若命中致命错误则带上 `details.fatal`。 */
export function buildError(detector, message, extraDetails = {}) {
  return buildResult(detector, {
    status: 'error',
    score: 0,
    error: message || '检测执行失败',
    details: { ...extraDetails }
  });
}

/**
 * 检测器基类。子类必须提供 name / displayName / weight / modes 等元信息，
 * 并实现 `run`（active）或 `observe` + `finalize`（passive）。
 */
export class BaseDetector {
  /**
   * @param {{
   *   name: string, displayName: string, weight: number,
   *   modes?: string[], provider?: string[], critical?: boolean,
   *   kind?: 'active'|'passive', description?: string
   * }} options
   */
  constructor(options = {}) {
    this.name = safeText(options.name);
    this.displayName = safeText(options.displayName) || this.name;
    this.weight = clampNumber(toFiniteNumber(options.weight, 0), 0, 100);
    this.modes = Array.isArray(options.modes) && options.modes.length > 0 ? [...options.modes] : ['standard', 'full'];
    this.provider = Array.isArray(options.provider) ? [...options.provider] : [];
    this.critical = options.critical === true;
    this.kind = options.kind === 'passive' ? 'passive' : 'active';
    this.description = safeText(options.description);
  }

  /** 模型 / 档位 / 协议能力是否允许运行该检测器。 */
  appliesTo() {
    return true;
  }

  /** appliesTo 为 false 时的机器可读原因（snake_case）。 */
  skipReason() {
    return 'not_applicable';
  }

  /** appliesTo 为 false 时给用户看的中文说明。 */
  skipMessage() {
    return '当前条件下无法执行该检测器，已跳过（skip 不计入加权分母）。';
  }

  /** active 检测器必须覆盖；这里给安全兜底，避免基类被误用。 */
  async run() {
    return buildSkip(this, 'not_implemented', '该检测器未实现 run()，已跳过。');
  }

  /** passive 检测器：观察一次请求/响应（零额外成本）。 */
  observe() {
    /* 默认什么都不做 */
  }

  /** passive 检测器：在全部主动检测结束后汇总。 */
  finalize() {
    return buildSkip(this, 'no_observation', '没有可复用的请求，已跳过。');
  }
}

/** 主动检测器基类（自己发请求）。 */
export class ActiveDetector extends BaseDetector {
  constructor(options = {}) {
    super({ ...options, kind: 'active' });
  }
}

/** 被动检测器基类（复用已发出的请求，零额外成本）。 */
export class PassiveDetector extends BaseDetector {
  constructor(options = {}) {
    super({ ...options, kind: 'passive' });
  }
}

export default {
  ActiveDetector,
  PassiveDetector,
  BaseDetector,
  maskApiKey,
  joinTextBlocks,
  pickTextContent,
  collectJsonLeaves,
  buildResult,
  buildSkip,
  buildError,
  stateFor,
  clampScore,
  toFiniteNumber,
  toSerializable,
  safeText,
  DETECTOR_STATUSES
};
