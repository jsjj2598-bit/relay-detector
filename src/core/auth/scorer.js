/**
 * 真伪轴评分器（契约 v2 §6.3）。纯函数，无 I/O，可在 Node 与浏览器运行。
 *
 * 两条不可违反的语义（契约 §6.2，这是 v2 相对 v1 最核心的修正）：
 *  1. `skip` 与 `error` **不进入**加权平均分母：
 *     `skip` 表示「本来就无法测」（模型不支持 / 档位没选），
 *     `error` 表示「测了但网络/上游报错」。两者都不得被当作 0 分拉低总分。
 *  2. 全部检测器都 `skip`（或全部 `error`）时 verdict 必须是 `invalid`（「检测无效」），
 *     而不是 0 分 `failed`。
 *
 * 另外，`fatalRunError` 负责识别「上游余额不足 / model_not_found / 无可用渠道」这类
 * **检测本身无效**的失败：命中时整份报告 verdict = `invalid`，禁止输出低分误导用户。
 */

/** verdictFor 的档位阈值（契约 §6.3，冻结）。 */
export const AUTH_VERDICT_THRESHOLDS = {
  excellent: 85,
  passed: 70,
  marginal: 50
};

/** fatalRunError 允许返回的两种 code（契约 §6.3）。 */
export const FATAL_CODES = ['insufficient_quota', 'model_unavailable'];

const clamp = (n, lo, hi) => Math.min(hi, Math.max(lo, n));
const num = (v, fallback = 0) => (typeof v === 'number' && Number.isFinite(v) ? v : fallback);
const isObject = (v) => Boolean(v) && typeof v === 'object';

/** 安全截断错误文本，避免把整页 HTML / 超长响应塞进报告。 */
function snippet(text, max = 240) {
  const s = String(text ?? '').replace(/\s+/g, ' ').trim();
  if (!s) return '';
  return s.length > max ? `${s.slice(0, max)}…` : s;
}

function safeJson(value, max = 4000) {
  try {
    const text = JSON.stringify(value);
    if (typeof text !== 'string') return '';
    return text.length > max ? text.slice(0, max) : text;
  } catch {
    return '';
  }
}

/* ------------------------------------------------------------------ */
/* 致命错误识别（余额不足 / 模型不存在 / 无可用渠道）                     */
/* ------------------------------------------------------------------ */

/**
 * 「余额 / 额度不足」类特征。
 * 命中即说明用户根本没被正常服务，检测结果无意义。
 */
const QUOTA_PATTERNS = [
  /insufficient[_\s-]*quota/i,
  /insufficient[_\s-]*(user[_\s-]*)?(quota|balance|credit|funds)/i,
  /exceeded\s+your\s+current\s+quota/i,
  /quota\s+(has\s+been\s+)?(exceeded|exhausted)/i,
  /(credit|balance)[_\s-]*(balance[_\s-]*)?(insufficient|exhausted|too\s+low)/i,
  /billing\s+(hard\s+limit|issue|error|not\s+active)/i,
  /(not\s+enough|no)\s+(user\s+)?(quota|balance|credit|funds)/i,
  /余额不足|额度不足|额度已用尽|余额已用尽|余额为零|欠费|余额耗尽/
];

/**
 * 「模型不存在 / 无可用渠道」类特征。
 * 注意不能把普通 404 页面或普通 500 当成检测无效，因此只匹配明确的语义。
 */
const MODEL_PATTERNS = [
  /model[_\s-]*not[_\s-]*found/i,
  /model\b[^,;{}"'<\n]{0,80}?\bnot\s+found/i,
  /model\b[^,;{}"'<\n]{0,60}?(does\s+not\s+exist|不存在|未找到|暂不可用|不可用)/i,
  /not_found_error/i,
  /no\s+available\s+(channel|channels|upstream|upstreams|provider|providers)/i,
  /channel[_\s-]*(not[_\s-]*found|unavailable|exhausted)/i,
  /upstream[_\s-]*(not[_\s-]*found|unavailable|exhausted)/i,
  /无可用渠道|无可用上游|没有可用渠道|渠道不可用|渠道已耗尽|分组[^，。;；]{0,20}(饱和|无可用)/
];

/** 显式写入 DetectorResult 的 fatal 标记（优先于文本扫描）。 */
function pickExplicitFatal(result) {
  if (!isObject(result)) return null;
  const candidates = [
    result.fatal,
    result.fatalError,
    result.runError,
    isObject(result.details) ? result.details.fatal : null,
    isObject(result.details) ? result.details.fatalError : null,
    isObject(result.details) ? result.details.runError : null
  ];
  for (const candidate of candidates) {
    if (!isObject(candidate)) continue;
    const code = String(candidate.code || '');
    if (!FATAL_CODES.includes(code)) continue;
    const message = typeof candidate.message === 'string' && candidate.message ? candidate.message : code;
    return { code, message: snippet(message) || code };
  }
  return null;
}

/** 收集一条 DetectorResult 里所有可能包含上游错误文本的字符串。 */
function collectTexts(result) {
  if (!isObject(result)) return [];
  const out = [];
  const push = (value) => {
    if (typeof value === 'string' && value) out.push(value);
    else if (isObject(value) || Array.isArray(value)) {
      const json = safeJson(value);
      if (json) out.push(json);
    }
  };
  push(result.error);
  push(result.message);
  if (isObject(result.details)) {
    push(result.details.message);
    push(result.details.error);
    push(result.details.responseBodyPreview);
    push(result.details.bodyPreview);
    push(result.details.reason);
    const subChecks = Array.isArray(result.details.subChecks) ? result.details.subChecks : [];
    for (const check of subChecks) {
      if (!isObject(check)) continue;
      push(check.detail);
      push(check.message);
      push(check.error);
      push(check.evidence);
    }
  }
  const criticalIssues = Array.isArray(result.criticalIssues) ? result.criticalIssues : [];
  for (const issue of criticalIssues) {
    if (!isObject(issue)) continue;
    push(issue.message);
    push(issue.evidence);
  }
  return out;
}

/**
 * 判断一段文本是否属于「检测无效」的致命错误。
 * 导出供检测器在构造错误结果时复用（契约只强制 fatalRunError，额外导出不冲突）。
 *
 * @param {string|object} input
 * @returns {null | { code: 'insufficient_quota'|'model_unavailable', message: string }}
 */
export function classifyFatalText(input) {
  const text = typeof input === 'string' ? input : safeJson(input);
  if (!text) return null;
  for (const pattern of QUOTA_PATTERNS) {
    if (pattern.test(text)) return { code: 'insufficient_quota', message: snippet(text) };
  }
  for (const pattern of MODEL_PATTERNS) {
    if (pattern.test(text)) return { code: 'model_unavailable', message: snippet(text) };
  }
  return null;
}

/**
 * 扫描全部检测结果，判断是否命中「检测无效」的致命错误（契约 §6.3）。
 *
 * 命中条件：
 *  - 检测器显式给出 `details.fatal = { code, message }`（两种 code 之一）；
 *  - 或错误文本中出现余额不足 / model_not_found / 无可用渠道等语义。
 *
 * 普通网络错误、401、500 等**不得**命中（否则会把「检测失败」误判成「站不行」）。
 *
 * @param {Array<object>} results DetectorResult[]
 * @returns {null | { code: 'insufficient_quota'|'model_unavailable', message: string }}
 */
export function fatalRunError(results) {
  const list = Array.isArray(results) ? results : [];
  // 1) 显式 fatal 标记优先
  for (const result of list) {
    const explicit = pickExplicitFatal(result);
    if (explicit) return explicit;
  }
  // 2) 文本扫描：余额类优先于模型类（余额不足时任何模型都不可用）
  let modelHit = null;
  for (const result of list) {
    if (!isObject(result)) continue;
    for (const text of collectTexts(result)) {
      const hit = classifyFatalText(text);
      if (!hit) continue;
      if (hit.code === 'insufficient_quota') return hit;
      if (!modelHit) modelHit = hit;
    }
  }
  return modelHit;
}

/* ------------------------------------------------------------------ */
/* 契约 §6.3 四个评分函数                                                */
/* ------------------------------------------------------------------ */

/**
 * 加权平均总分：`Σ(score × weight) / Σ(weight)`。
 * **只统计 status !== 'skip' && status !== 'error' 的结果**（契约 §6.2 第 1 条）。
 *
 * @param {Array<object>} results
 * @returns {number} 0..100；没有任何可计分结果时返回 0
 */
export function computeTotal(results) {
  const list = Array.isArray(results) ? results : [];
  let weighted = 0;
  let totalWeight = 0;
  for (const result of list) {
    if (!isObject(result)) continue;
    if (result.status === 'skip' || result.status === 'error') continue;
    const weight = clamp(num(result.weight, 0), 0, 100);
    if (weight <= 0) continue;
    const score = clamp(num(result.score, 0), 0, 100);
    weighted += score * weight;
    totalWeight += weight;
  }
  if (totalWeight <= 0) return 0;
  const total = weighted / totalWeight;
  if (!Number.isFinite(total)) return 0;
  // 去掉浮点尾差，但保留 4 位小数以免丢失加权平均的精度。
  return Number(clamp(total, 0, 100).toFixed(4));
}

/**
 * 由分数推导真伪档位（契约 §6.3，阈值冻结）：
 * `>=85 excellent / >=70 passed / >=50 marginal / <50 failed`。
 *
 * @param {number} score
 * @returns {'excellent'|'passed'|'marginal'|'failed'}
 */
export function verdictFor(score) {
  const s = clamp(num(score, 0), 0, 100);
  if (s >= AUTH_VERDICT_THRESHOLDS.excellent) return 'excellent';
  if (s >= AUTH_VERDICT_THRESHOLDS.passed) return 'passed';
  if (s >= AUTH_VERDICT_THRESHOLDS.marginal) return 'marginal';
  return 'failed';
}

/**
 * 是否存在 critical 级严重问题（任意检测器上报即 true）。
 * 对缺失 / 畸形 criticalIssues 必须安全返回 false。
 *
 * @param {Array<object>} results
 * @returns {boolean}
 */
export function hasCriticalIssues(results) {
  const list = Array.isArray(results) ? results : [];
  return list.some((result) => {
    if (!isObject(result)) return false;
    if (Array.isArray(result.criticalIssues) && result.criticalIssues.length > 0) return true;
    if (isObject(result.details)) {
      if (Array.isArray(result.details.criticalIssues) && result.details.criticalIssues.length > 0) return true;
      if (result.details.critical === true) return true;
    }
    return false;
  });
}

/**
 * 最终 verdict：在 `verdictFor(score)` 之上叠两个闸门。
 *
 * 1. **检测无效**：命中 `fatalRunError`，或没有任何「有效测量」（全 skip / 全 error）→ `invalid`。
 * 2. **critical 一票降级**：`excellent` / `passed` 封顶为 `marginal`
 *    （分数可以仍然很高：一条 25% 权重的致命项会被多条 100 分的结构项淹没）。
 *    critical 只封顶、不抬升：`failed` 仍是 `failed`，`marginal` 仍保持。
 *
 * @param {number} score
 * @param {Array<object>} results
 * @returns {'excellent'|'passed'|'marginal'|'failed'|'invalid'}
 */
export function effectiveVerdict(score, results) {
  const list = Array.isArray(results) ? results : [];
  if (fatalRunError(list)) return 'invalid';
  const measured = list.some(
    (result) => isObject(result) && result.status !== 'skip' && result.status !== 'error'
  );
  if (!measured) return 'invalid';
  const base = verdictFor(score);
  if (hasCriticalIssues(list) && (base === 'excellent' || base === 'passed')) return 'marginal';
  return base;
}

/**
 * verdict 的中文文案（契约 §6.3 / §6.6）。
 *
 * @param {'excellent'|'passed'|'marginal'|'failed'|'invalid'} verdict
 * @param {number} [score]
 * @returns {string}
 */
export function summaryText(verdict, score) {
  const labels = {
    excellent: '优秀',
    passed: '通过',
    marginal: '基本合格',
    failed: '未达标',
    invalid: '检测无效'
  };
  const key = typeof verdict === 'string' ? verdict : '';
  if (labels[key]) return labels[key];
  return '检测结果未知';
}

export default {
  computeTotal,
  verdictFor,
  hasCriticalIssues,
  effectiveVerdict,
  fatalRunError,
  summaryText,
  classifyFatalText
};
