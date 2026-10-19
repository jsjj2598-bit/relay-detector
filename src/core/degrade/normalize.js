/**
 * LogRecord 归一化（契约 v3 §10.1）。
 *
 * 四个解析器都只负责「尽力从原始日志里认出字段」，把半成品交给这里统一：
 *  - 时间戳单位容错（ms / 秒 / 微秒 / 纳秒 / 常见字符串格式；缺失 = null，绝不伪造）；
 *  - 模型名 / provider 推断；
 *  - finish_reason / status 归一；
 *  - 文本长度上限（只进内存，报告前会被 `scrubRaw` 剥掉）。
 *
 * 纯逻辑模块：不触碰 `document` / `window` / `FileReader`。
 */
import {
  LOG_FORMATS,
  MAX_COMPLETION_TEXT,
  MAX_PROMPT_TEXT,
  TRUNCATION_FINISH_REASONS
} from './constants.js';
import { isNum, isObject, numOr, sanitizeLabel, strOr } from './util.js';

const VALID_KINDS = new Set(['assistant', 'usage', 'user', 'system']);

/** 年份合理性窗口（2000-01-01 ~ 2100-01-01，毫秒）。用于识别「不是时间戳的数字」。 */
const TS_FLOOR = Date.UTC(2000, 0, 1);
const TS_CEIL = Date.UTC(2100, 0, 1);

/** 截断文本，保持字符串（不假装完整）。 */
export function clampText(value, max) {
  if (typeof value !== 'string') return '';
  if (!value) return '';
  return value.length > max ? value.slice(0, max) : value;
}

/**
 * 解析时间戳为毫秒 epoch；无法可靠识别时返回 null（契约 §10.1：缺失为 null，不伪造）。
 *
 * 支持：
 *  - 数字：ms / 秒 / 微秒 / 纳秒（按量级自动识别）；小于 1e8 的正数按「相对毫秒」原样保留
 *    （合成日志常见 `1000, 2000, ...` 这种相对时钟）；
 *  - 字符串：13 位 ms、10 位秒、8 位 YYYYMMDD、ISO 8601、
 *    `YYYY-MM-DD HH:mm:ss`（无时区按 UTC）、`YYYY/MM/DD`、`YYYY年M月D日 H:m:s`。
 *
 * @param {unknown} value
 * @returns {number|null}
 */
export function parseTimestamp(value) {
  let n = null;

  if (isNum(value)) {
    n = value;
  } else if (typeof value === 'string') {
    const s = value.trim();
    if (!s) return null;
    if (/^\d{13}$/.test(s)) {
      n = Number(s);
    } else if (/^\d{10}(\.\d+)?$/.test(s)) {
      n = Number(s) * 1000;
    } else if (/^\d{8}$/.test(s)) {
      const y = Number(s.slice(0, 4));
      const m = Number(s.slice(4, 6)) - 1;
      const d = Number(s.slice(6, 8));
      n = Date.UTC(y, m, d);
    } else if (/^\d{16,19}$/.test(s)) {
      n = Number(s) / 1e6; // 纳秒
    } else {
      let iso = s;
      const cn = /^(\d{4})年(\d{1,2})月(\d{1,2})日(?:[ T](\d{1,2}):(\d{2})(?::(\d{2}))?)?$/.exec(s);
      if (cn) {
        n = Date.UTC(
          Number(cn[1]),
          Number(cn[2]) - 1,
          Number(cn[3]),
          Number(cn[4] || 0),
          Number(cn[5] || 0),
          Number(cn[6] || 0)
        );
      } else {
        if (/^\d{4}[/-]\d{1,2}[/-]\d{1,2}[ T]\d{1,2}:\d{2}/.test(iso)) {
          iso = iso.replace(/\//g, '-').replace(' ', 'T');
          if (!/(?:[zZ]|[+-]\d{2}:?\d{2})$/.test(iso)) iso += 'Z'; // 无时区按 UTC，避免本地时区漂移
        } else if (/^\d{4}[/-]\d{1,2}[/-]\d{1,2}$/.test(iso)) {
          iso = `${iso.replace(/\//g, '-')}T00:00:00Z`;
        }
        const ms = Date.parse(iso);
        if (Number.isFinite(ms)) n = ms;
      }
    }
  } else {
    return null;
  }

  if (!Number.isFinite(n) || n <= 0) return null;

  // 量级归一：纳秒 → 微秒 → 秒 → 毫秒
  if (n >= 1e16) n = n / 1e6;
  else if (n >= 1e13) n = n / 1e3;
  else if (n >= 1e8 && n < 1e11) n = n * 1000; // 秒
  // 1e11 ~ 1e13 视为毫秒；< 1e8 视为相对毫秒，原样保留

  if (!Number.isFinite(n) || n <= 0) return null;
  // 毫秒量级的时间戳再做一次合理性检查；相对时钟（<1e11）不裁剪。
  if (n >= 1e11 && (n < TS_FLOOR - 1e11 || n > TS_CEIL + 1e11)) return null;
  return Math.round(n);
}

/**
 * 模型名规范化：用于判断「响应的 model 是否就是请求的 model」。
 *
 * 归一化会去掉：厂商前缀（`anthropic/`、`bedrock.`）、`@20241022` 后缀、
 * `-20241022` / `-2024-08-06` 日期快照后缀、`-latest` / `-preview` 之类的别名后缀，
 * 以及大小写 / 下划线 / 点号差异。这样 `claude-sonnet-4-5` 与
 * `claude-sonnet-4-5-20250929` 会被视为同一模型，而 `claude-sonnet-4-5` 与
 * `claude-3-5-haiku-20241022` 会被视为不同模型。
 *
 * @param {unknown} value
 * @returns {string}
 */
export function normalizeModelName(value) {
  let s = strOr(value, '');
  if (!s) return '';
  s = s.toLowerCase().trim();
  s = s.replace(/^[a-z0-9_-]+\//, ''); // anthropic/claude-...
  s = s.replace(/^[a-z0-9_-]+\.(?=[a-z])/, ''); // bedrock: anthropic.claude-...
  s = s.replace(/@[0-9a-z._-]+$/i, '');
  s = s.replace(/_/g, '-');
  s = s.replace(/\./g, '-');
  s = s.replace(/-\d{4}-\d{2}-\d{2}$/, '');
  s = s.replace(/-\d{8}$/, '');
  s = s.replace(/-v\d+(?::\d+)?$/, ''); // bedrock: ...-v2:0
  s = s.replace(/-(latest|preview|exp|experimental|beta|alpha)$/, '');
  s = s.replace(/\s+/g, '');
  return s;
}

/**
 * 判断响应模型与请求模型是否「同一模型」。
 * 任一缺失时返回 null（表示无法判断，指标会把它排除出分母）。
 *
 * @returns {boolean|null}
 */
export function sameModelFamily(responseModel, requestModel) {
  const a = normalizeModelName(responseModel);
  const b = normalizeModelName(requestModel);
  if (!a || !b) return null;
  return a === b;
}

/** 推断 provider：显式字段优先，其次模型名 / 响应 id 指纹。 */
export function inferProvider({ provider, model, requestModel, responseId } = {}) {
  const explicit = strOr(provider, '').toLowerCase();
  if (explicit === 'gemini') return 'google';
  if (explicit === 'anthropic' || explicit === 'openai' || explicit === 'google') return explicit;

  const text = `${strOr(model, '')} ${strOr(requestModel, '')} ${strOr(responseId, '')}`.toLowerCase();
  if (!text.trim()) return 'unknown';
  if (/claude|anthropic|msg_0/.test(text)) return 'anthropic';
  if (/gpt|openai|chatcmpl|davinci|text-embedding|whisper/.test(text)) return 'openai';
  if (/(?:^|[^a-z])o[1-4](?:[^a-z]|$)/.test(text)) return 'openai';
  if (/gemini|palm|bard|google/.test(text)) return 'google';
  return 'unknown';
}

/** finish_reason 归一：截断类统一成 `length` / `max_tokens`，其它保留小写原值。 */
export function normalizeFinishReason(value) {
  const raw = strOr(value, '').toLowerCase();
  if (!raw) return null;
  if (TRUNCATION_FINISH_REASONS.has(raw)) {
    return raw === 'length' ? 'length' : 'max_tokens';
  }
  return sanitizeLabel(raw, 40) || null;
}

/** HTTP 状态归一：只接受 100..599 的整数；其它 → null（不伪造）。 */
export function normalizeStatus(value) {
  const n = numOr(value, null);
  if (n === null) return null;
  return n >= 100 && n <= 599 ? Math.round(n) : null;
}

function nonNegativeOrNull(value) {
  const n = numOr(value, null);
  if (n === null || n < 0) return null;
  return n;
}

/** 把半成品字段组装成契约 §10.1 的 LogRecord。 */
export function createRecord(partial = {}, { index = 0, source = 'generic' } = {}) {
  const p = isObject(partial) ? partial : {};
  const kindRaw = strOr(p.kind, '');
  const kind = VALID_KINDS.has(kindRaw)
    ? kindRaw
    : source === 'usage-csv'
      ? 'usage'
      : 'assistant';
  const resolvedSource = LOG_FORMATS.includes(p.source) ? p.source : source;

  const record = {
    index: isNum(p.index) ? p.index : index,
    timestamp: parseTimestamp(p.timestamp),
    provider: inferProvider({
      provider: p.provider,
      model: p.model,
      requestModel: p.requestModel,
      responseId: p.responseId
    }),
    model: sanitizeLabel(strOr(p.model, ''), 120) || null,
    requestModel: sanitizeLabel(strOr(p.requestModel, ''), 120) || null,
    sessionId: sanitizeLabel(strOr(p.sessionId, ''), 120) || null,
    source: resolvedSource,
    kind,
    promptText: clampText(p.promptText, MAX_PROMPT_TEXT),
    completionText: clampText(p.completionText, MAX_COMPLETION_TEXT),
    promptTokens: nonNegativeOrNull(p.promptTokens),
    completionTokens: nonNegativeOrNull(p.completionTokens),
    cacheReadTokens: nonNegativeOrNull(p.cacheReadTokens),
    cacheWriteTokens: nonNegativeOrNull(p.cacheWriteTokens),
    thinkingTokens: nonNegativeOrNull(p.thinkingTokens),
    thinkingChars: nonNegativeOrNull(p.thinkingChars),
    hasThinkingSignature: typeof p.hasThinkingSignature === 'boolean' ? p.hasThinkingSignature : null,
    finishReason: normalizeFinishReason(p.finishReason),
    status: normalizeStatus(p.status),
    errorCode: sanitizeLabel(strOr(p.errorCode, ''), 80) || null,
    latencyMs: nonNegativeOrNull(p.latencyMs)
  };

  // raw 只允许存在于解析期内对象里，且做成不可枚举：
  // 即使有调用方误把 records 直接 JSON.stringify，也不会带出日志原文（纵深防御）。
  const raw = isObject(p.raw) ? p.raw : p;
  Object.defineProperty(record, 'raw', {
    value: raw,
    enumerable: false,
    writable: true,
    configurable: true
  });

  // 以下两个字段是「解析期提示位」（非契约 10.1 字段，不可枚举，不进报告）：
  //  - completionObserved：是否真的观测到完成内容（区分「空回答」与「日志没记文本」）；
  //  - hasThinking：Codex 等格式没有 thinking token 字段时的「时段内有推理」提示。
  if (p.completionObserved === true) {
    Object.defineProperty(record, 'completionObserved', {
      value: true,
      enumerable: false,
      writable: true,
      configurable: true
    });
  }
  if (typeof p.hasThinking === 'boolean') {
    Object.defineProperty(record, 'hasThinking', {
      value: p.hasThinking,
      enumerable: false,
      writable: true,
      configurable: true
    });
  }
  return record;
}

/** 是否为参与分析的记录（assistant / usage；缺失 kind 视为 assistant，兼容手写记录）。 */
export function isUsableRecord(record) {
  if (!isObject(record)) return false;
  const kind = strOr(record.kind, 'assistant');
  return kind === 'assistant' || kind === 'usage';
}

/** 是否有可比较的时间戳（毫秒）。 */
export function isTimedRecord(record) {
  return isObject(record) && isNum(record.timestamp);
}

/** 该记录是否携带「thinking 是否发生」的可观测信息。 */
export function hasThinkingInfo(record) {
  if (!isObject(record)) return false;
  return (
    isNum(record.thinkingTokens) ||
    isNum(record.thinkingChars) ||
    typeof record.hasThinkingSignature === 'boolean' ||
    typeof record.hasThinking === 'boolean'
  );
}

/** 该记录本轮是否出现了 thinking（块或思考 token）。 */
export function hasThinking(record) {
  if (!isObject(record)) return false;
  if (typeof record.hasThinking === 'boolean') return record.hasThinking;
  if (isNum(record.thinkingTokens) && record.thinkingTokens > 0) return true;
  if (isNum(record.thinkingChars) && record.thinkingChars > 0) return true;
  return record.hasThinkingSignature === true;
}

/** 从 records 中筛出参与分析的记录（保持原顺序）。 */
export function pickAnalyzeableRecords(records) {
  return (Array.isArray(records) ? records : []).filter(isUsableRecord);
}

export default {
  clampText,
  parseTimestamp,
  normalizeModelName,
  sameModelFamily,
  inferProvider,
  normalizeFinishReason,
  normalizeStatus,
  createRecord,
  isUsableRecord,
  isTimedRecord,
  hasThinkingInfo,
  hasThinking,
  pickAnalyzeableRecords
};
