/**
 * 报告隐私剥离（契约 v3 §9.2，最高优先级）。
 *
 * 规则：**报告对象里不允许出现** `raw`、日志原文（prompt/completion 文本）、
 * 文件路径 / 文件名。`raw` 只允许停留在解析期的内存 LogRecord 上。
 *
 * 实现方式：`scrubRaw()` 深拷贝并递归删除敏感键；`assertScrubbed()` 再独立走一遍
 * 断言（防御「以后有人往报告里加了 raw 字段」这类回归）。
 * 两个函数都绝不抛异常以外的副作用 —— 断言失败由 `analyzeDegradation` 捕获并降级。
 */
import { SCRUB_KEYS } from './constants.js';
import { isObject } from './util.js';

const MAX_VIOLATIONS = 20;

/**
 * 深拷贝并递归剥离敏感键。
 *
 * - 数组逐项处理，`undefined` 项被丢弃；
 * - 数字归一（NaN/Infinity → null），保证报告一定可以 `JSON.stringify`；
 * - Date → epoch ms；
 * - 循环引用按引用复用（报告本身不会有，但防御恶意输入）。
 *
 * @param {unknown} value
 * @param {WeakMap<object, unknown>} [seen]
 * @returns {unknown}
 */
export function scrubRaw(value, seen = new WeakMap()) {
  if (value == null) return value;
  const type = typeof value;
  if (type === 'number') return Number.isFinite(value) ? value : null;
  if (type === 'string' || type === 'boolean') return value;
  if (type === 'function' || type === 'symbol') return undefined;
  if (type !== 'object') return undefined;

  if (seen.has(value)) return seen.get(value);
  if (value instanceof Date) {
    const ms = value.getTime();
    return Number.isFinite(ms) ? ms : null;
  }
  if (Array.isArray(value)) {
    const out = [];
    seen.set(value, out);
    for (const item of value) {
      const copy = scrubRaw(item, seen);
      if (copy !== undefined) out.push(copy);
    }
    return out;
  }
  if (!isObject(value)) {
    // Map / Set / 其他宿主对象：报告里不应该出现，直接丢成 null 的替代品。
    return null;
  }
  const out = {};
  seen.set(value, out);
  for (const [key, child] of Object.entries(value)) {
    if (SCRUB_KEYS.has(key)) continue;
    const copy = scrubRaw(child, seen);
    if (copy !== undefined) out[key] = copy;
  }
  return out;
}

/**
 * 独立扫描一棵对象树，返回所有敏感键的路径（最多 20 条）。
 * 与 `scrubRaw` 分开实现，是为了让断言不依赖「剥离函数写对了」。
 *
 * @param {unknown} value
 * @param {string} [rootPath]
 * @returns {string[]}
 */
export function findScrubViolations(value, rootPath = '$') {
  const violations = [];
  const seen = new WeakSet();
  const walk = (node, path) => {
    if (violations.length >= MAX_VIOLATIONS || node == null || typeof node !== 'object') return;
    if (seen.has(node)) return;
    seen.add(node);
    if (Array.isArray(node)) {
      for (let i = 0; i < node.length && violations.length < MAX_VIOLATIONS; i += 1) {
        walk(node[i], `${path}[${i}]`);
      }
      return;
    }
    for (const [key, child] of Object.entries(node)) {
      const childPath = `${path}.${key}`;
      if (SCRUB_KEYS.has(key)) {
        violations.push(childPath);
        continue;
      }
      if (child != null && typeof child === 'object') walk(child, childPath);
    }
  };
  walk(value, rootPath);
  return violations;
}

/**
 * 断言对象树里没有任何敏感键。
 * 失败时抛出带有 `violations` 字段的 Error，由调用方捕获并降级（绝不外抛给 UI）。
 *
 * @param {unknown} report
 * @returns {true}
 */
export function assertScrubbed(report) {
  const violations = findScrubViolations(report);
  if (violations.length > 0) {
    const error = new Error(`degrade report privacy violation: ${violations.join(', ')}`);
    error.code = 'DEGRADE_PRIVACY_VIOLATION';
    error.violations = violations;
    throw error;
  }
  return true;
}

export default { scrubRaw, findScrubViolations, assertScrubbed };
