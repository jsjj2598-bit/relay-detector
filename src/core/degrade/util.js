/**
 * 降智诊断（契约 v3）通用小工具。
 *
 * 纯函数、无 I/O、不触碰 `document` / `window` / `FileReader`，
 * 保证引擎可以同时在 Node（自测 / 验收）与浏览器（UI）中直接 import。
 *
 * 这里只放与业务无关的数值 / 字符串工具；日志字段归一化见 `normalize.js`。
 */

/** 是否为普通对象（排除 null / 数组）。 */
export function isObject(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

/** 是否为有限数字。 */
export function isNum(value) {
  return typeof value === 'number' && Number.isFinite(value);
}

/**
 * 宽容地取数字：接受 number 与数字字符串（会去掉千分位逗号与空格）。
 * 取不到时返回 fallback（默认 null）。绝不返回 NaN。
 */
export function numOr(value, fallback = null) {
  if (isNum(value)) return value;
  if (typeof value === 'string') {
    const trimmed = value.trim();
    if (!trimmed) return fallback;
    const n = Number(trimmed.replace(/,/g, '').replace(/\s+/g, ''));
    if (Number.isFinite(n)) return n;
  }
  return fallback;
}

/** 宽容地取字符串：number 会转成字符串，取不到返回 fallback。 */
export function strOr(value, fallback = null) {
  if (typeof value === 'string') {
    const trimmed = value.trim();
    return trimmed ? trimmed : fallback;
  }
  if (typeof value === 'number' && Number.isFinite(value)) return String(value);
  return fallback;
}

/** 夹取到 [lo, hi]；非数字取 lo。 */
export function clamp(n, lo, hi) {
  const x = isNum(n) ? n : lo;
  return Math.min(hi, Math.max(lo, x));
}

/**
 * 四舍五入到指定小数位；非数字返回 null。
 * 顺便把 `-0` 归一成 `0`，避免报告里出现 `-0`。
 */
export function round(n, digits = 4) {
  if (!isNum(n)) return null;
  const factor = 10 ** digits;
  const value = Math.round(n * factor) / factor;
  return Object.is(value, -0) ? 0 : value;
}

/** 中位数；空数组返回 null。不修改入参。 */
export function median(values) {
  const arr = Array.isArray(values) ? values.filter(isNum) : [];
  if (!arr.length) return null;
  const sorted = [...arr].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

/** 算术平均；空数组返回 null。 */
export function mean(values) {
  const arr = Array.isArray(values) ? values.filter(isNum) : [];
  if (!arr.length) return null;
  return arr.reduce((acc, n) => acc + n, 0) / arr.length;
}

/** 求和；空数组返回 0。 */
export function sum(values) {
  const arr = Array.isArray(values) ? values.filter(isNum) : [];
  return arr.reduce((acc, n) => acc + n, 0);
}

/** 契约 §12 的饱和函数：saturate(x) = x / (x + 1)。 */
export function saturate(x) {
  const n = isNum(x) && x > 0 ? x : 0;
  return n / (n + 1);
}

/** 保证是数组（否则返回空数组）。 */
export function safeArray(value) {
  return Array.isArray(value) ? value : [];
}

/**
 * UTF-8 字节数（用于 limits.maxBytesPerFile 与 stats.bytes）。
 * 优先用 TextEncoder；极端环境下退化为字符数（契约只要求上限保护）。
 */
export function utf8Bytes(text) {
  const s = typeof text === 'string' ? text : '';
  if (typeof TextEncoder !== 'undefined') {
    try {
      return new TextEncoder().encode(s).length;
    } catch {
      return s.length;
    }
  }
  return s.length;
}

/**
 * 把任意字符串变成可安全写进报告的短标签：
 * 去控制字符、压缩空白、限制长度。绝不执行任何 HTML/脚本语义。
 */
export function sanitizeLabel(value, max = 80) {
  if (typeof value !== 'string') return '';
  const cleaned = value.replace(/[\u0000-\u001f\u007f]+/g, ' ').replace(/\s+/g, ' ').trim();
  return cleaned.length > max ? cleaned.slice(0, max) : cleaned;
}

/** 把 0..1 的比例格式化成百分比文案（仅用于 finding 的 detail）。 */
export function pctText(ratio, digits = 1) {
  if (!isNum(ratio)) return '—';
  return `${(ratio * 100).toFixed(digits)}%`;
}

/** 安全 JSON.stringify：失败返回空串（报告与告警都不允许抛异常）。 */
export function safeJsonStringify(value) {
  try {
    const text = JSON.stringify(value);
    return typeof text === 'string' ? text : '';
  } catch {
    return '';
  }
}

/** 统计词频，返回 `{ key: count }`；null/空字符串 key 会被忽略。 */
export function countMap(items, keyFn) {
  const out = {};
  const list = Array.isArray(items) ? items : [];
  for (const item of list) {
    const key = keyFn(item);
    if (key == null) continue;
    const text = String(key);
    if (!text) continue;
    out[text] = (out[text] || 0) + 1;
  }
  return out;
}

export default {
  isObject,
  isNum,
  numOr,
  strOr,
  clamp,
  round,
  median,
  mean,
  sum,
  saturate,
  safeArray,
  utf8Bytes,
  sanitizeLabel,
  pctText,
  safeJsonStringify,
  countMap
};
