/**
 * 通用 API 请求 / 响应日志解析器（契约 v3 §10.2）。
 *
 * 面向「自己抓包 / 网关 / 反代导出的 JSONL」，一行一次调用，形状高度不统一，
 * 因此这里走**宽进严出**：
 *  - 兼容包装形状 `{timestamp, request:{...}, response:{...}, latency_ms, status}`；
 *  - 兼容 OpenAI Chat Completions（`choices[].message` / `usage.prompt_tokens`）；
 *  - 兼容 OpenAI Responses API（`output[]` / `usage.input_tokens` / `usage.input_tokens_details.cached_tokens`）；
 *  - 兼容 Anthropic Messages（`content[]` / `stop_reason` / `usage.input_tokens`）；
 *  - 兼容 Gemini（`candidates[].content.parts` / `usageMetadata.*TokenCount`）；
 *  - `response` / `response.body` 是字符串时尝试再解一层 JSON。
 *
 * 只有「确实发生了响应」的行才会产出记录（错误响应也算：用于 error_rate）；
 * 只有 request 没有 response 的行会被跳过（记入 files[].skipped）。
 */
import { isObject, numOr, strOr } from '../util.js';

const TOKEN_KEYS = [
  'prompt_tokens',
  'completion_tokens',
  'input_tokens',
  'output_tokens',
  'promptTokenCount',
  'inputTokenCount',
  'completionTokenCount',
  'candidatesTokenCount'
];

function lower(value) {
  return strOr(value, '').toLowerCase();
}

/** 尝试把字符串解析成 JSON 对象（形如 `{...}` / `[...]`）。 */
function tryParseJsonObject(value) {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  if (!trimmed || !/^[[{]/.test(trimmed)) return null;
  try {
    const parsed = JSON.parse(trimmed);
    return isObject(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

/** 从若干候选对象里挑第一个非空值。 */
function pickFirst(objects, keys) {
  for (const obj of objects) {
    if (!isObject(obj)) continue;
    for (const key of keys) {
      const value = obj[key];
      if (value !== undefined && value !== null && value !== '') return value;
    }
  }
  return undefined;
}

/** 拆解 `{request, response}` 包装（含 `response.body` 字符串二次解析）。 */
function unwrap(obj) {
  const request = isObject(obj.request)
    ? obj.request
    : isObject(obj.req)
      ? obj.req
      : isObject(obj.input) && (Array.isArray(obj.input.messages) || typeof obj.input.model === 'string')
        ? obj.input
        : null;

  let response = null;
  const rawResponse = obj.response ?? obj.res ?? obj.resp;
  if (rawResponse !== undefined && rawResponse !== null) {
    let candidate = typeof rawResponse === 'string' ? tryParseJsonObject(rawResponse) : rawResponse;
    if (isObject(candidate)) {
      const body = candidate.body ?? candidate.json ?? candidate.data;
      const parsedBody = typeof body === 'string' ? tryParseJsonObject(body) : isObject(body) ? body : null;
      if (parsedBody) {
        response = { ...parsedBody };
        if (candidate.status !== undefined) response.__status = candidate.status;
        if (isObject(candidate.headers)) response.__headers = candidate.headers;
      } else {
        response = candidate;
      }
    } else if (typeof rawResponse === 'string') {
      response = { __text: rawResponse };
    }
  }
  return { request, response };
}

function hasTokenKeys(obj) {
  if (!isObject(obj)) return false;
  return TOKEN_KEYS.some((key) => key in obj);
}

/** 找到 usage 对象：`usage` / `usage_metadata` / 直接就是 token 字段的对象。 */
function extractUsage(sources) {
  for (const source of sources) {
    if (!isObject(source)) continue;
    const usage = source.usage ?? source.usage_metadata ?? source.usageMetadata ?? source.token_usage;
    if (isObject(usage)) return usage;
    if (hasTokenKeys(source)) return source;
  }
  return null;
}

function readToken(usage, keys) {
  for (const key of keys) {
    const value = numOr(usage[key], null);
    if (value !== null) return value;
  }
  return null;
}

/** 统一读取 usage（OpenAI / Anthropic / Gemini 字段名）。 */
function readUsage(usage) {
  if (!isObject(usage)) return {};
  const promptDetails = isObject(usage.prompt_tokens_details) ? usage.prompt_tokens_details : null;
  const inputDetails = isObject(usage.input_tokens_details) ? usage.input_tokens_details : null;
  const completionDetails = isObject(usage.completion_tokens_details) ? usage.completion_tokens_details : null;
  const outputDetails = isObject(usage.output_tokens_details) ? usage.output_tokens_details : null;

  const cacheRead =
    readToken(usage, [
      'cache_read_input_tokens',
      'cache_read_tokens',
      'cached_tokens',
      'cacheReadInputTokens',
      'prompt_cache_hit_tokens',
      'cache_read_token_count'
    ]) ??
    numOr(promptDetails && promptDetails.cached_tokens, null) ??
    numOr(inputDetails && inputDetails.cached_tokens, null);

  const cacheWrite =
    readToken(usage, ['cache_creation_input_tokens', 'cache_write_input_tokens', 'cache_creation_tokens', 'cache_write_tokens']) ??
    numOr(inputDetails && inputDetails.cache_write_tokens, null);

  const thinking =
    readToken(usage, ['thinking_tokens', 'reasoning_tokens', 'thoughts_token_count', 'thoughtsTokenCount']) ??
    numOr(completionDetails && completionDetails.reasoning_tokens, null) ??
    numOr(outputDetails && outputDetails.reasoning_tokens, null);

  return {
    promptTokens: readToken(usage, [
      'prompt_tokens',
      'input_tokens',
      'promptTokenCount',
      'inputTokenCount',
      'prompt_token_count',
      'input_token_count'
    ]),
    completionTokens: readToken(usage, [
      'completion_tokens',
      'output_tokens',
      'completionTokenCount',
      'candidatesTokenCount',
      'output_token_count',
      'completion_token_count'
    ]),
    cacheReadTokens: cacheRead,
    cacheWriteTokens: cacheWrite,
    thinkingTokens: thinking
  };
}

/** 读取内容块数组，提取正文 / thinking。 */
function readBlocks(content) {
  const result = { text: '', thinkingChars: 0, hasThinking: false, hasSignature: false, observed: false };
  if (typeof content === 'string') {
    result.text = content;
    result.observed = true;
    return result;
  }
  if (!Array.isArray(content)) return result;
  result.observed = true;
  const parts = [];
  for (const block of content) {
    if (typeof block === 'string') {
      parts.push(block);
      continue;
    }
    if (!isObject(block)) continue;
    const type = lower(block.type);
    if (type === 'thinking' || type === 'reasoning' || type === 'redacted_thinking') {
      result.hasThinking = true;
      if (typeof block.thinking === 'string') result.thinkingChars += block.thinking.length;
      if (typeof block.text === 'string') result.thinkingChars += block.text.length;
      if (typeof block.signature === 'string' && block.signature) result.hasSignature = true;
      continue;
    }
    if (typeof block.text === 'string') {
      parts.push(block.text);
      continue;
    }
    if (typeof block.output_text === 'string') {
      parts.push(block.output_text);
      continue;
    }
    if (type === 'message' && Array.isArray(block.content)) {
      const nested = readBlocks(block.content);
      if (nested.text) parts.push(nested.text);
      result.thinkingChars += nested.thinkingChars;
      result.hasThinking = result.hasThinking || nested.hasThinking;
      result.hasSignature = result.hasSignature || nested.hasSignature;
    }
  }
  result.text = parts.join('\n');
  return result;
}

/** 从响应载荷里提取文本 / thinking / finish_reason。 */
function extractContent(payload) {
  const out = { text: '', thinkingChars: 0, hasThinking: false, hasSignature: false, observed: false, finishReason: null };
  if (!isObject(payload)) return out;

  const merge = (blockInfo) => {
    if (!blockInfo.observed && !blockInfo.text) return;
    out.observed = out.observed || blockInfo.observed;
    if (blockInfo.text) out.text = out.text ? `${out.text}\n${blockInfo.text}` : blockInfo.text;
    out.thinkingChars += blockInfo.thinkingChars;
    out.hasThinking = out.hasThinking || blockInfo.hasThinking;
    out.hasSignature = out.hasSignature || blockInfo.hasSignature;
  };

  // OpenAI Chat Completions
  if (Array.isArray(payload.choices) && payload.choices.length > 0) {
    const choice = isObject(payload.choices[0]) ? payload.choices[0] : {};
    const message = isObject(choice.message) ? choice.message : null;
    const delta = isObject(choice.delta) ? choice.delta : null;
    merge(readBlocks(message ? message.content : delta ? delta.content : choice.text));
    if (message && typeof message.refusal === 'string' && message.refusal) {
      out.text = out.text ? `${out.text}\n${message.refusal}` : message.refusal;
      out.observed = true;
    }
    out.finishReason =
      choice.finish_reason ?? choice.finishReason ?? out.finishReason;
  }

  // Anthropic Messages
  if (Array.isArray(payload.content)) {
    merge(readBlocks(payload.content));
    out.finishReason = payload.stop_reason ?? payload.stopReason ?? out.finishReason;
  }

  // Gemini
  if (Array.isArray(payload.candidates) && payload.candidates.length > 0) {
    const candidate = isObject(payload.candidates[0]) ? payload.candidates[0] : {};
    const parts = candidate.content && Array.isArray(candidate.content.parts) ? candidate.content.parts : null;
    merge(readBlocks(parts));
    out.finishReason = candidate.finishReason ?? candidate.finish_reason ?? out.finishReason;
  }

  // OpenAI Responses API：output[] 里既有 message 也有 reasoning
  if (Array.isArray(payload.output)) {
    for (const item of payload.output) {
      if (!isObject(item)) continue;
      if (lower(item.type) === 'reasoning') {
        out.hasThinking = true;
        out.observed = true;
        continue;
      }
      if (Array.isArray(item.content)) {
        merge(readBlocks(item.content));
      } else if (typeof item.text === 'string') {
        out.text = out.text ? `${out.text}\n${item.text}` : item.text;
        out.observed = true;
      }
    }
    out.finishReason = payload.finish_reason ?? payload.finishReason ?? out.finishReason;
  }

  // 某些日志把最终文本直接放在 response.text / output_text
  if (!out.text) {
    if (typeof payload.text === 'string' && payload.text) {
      out.text = payload.text;
      out.observed = true;
    } else if (typeof payload.output_text === 'string' && payload.output_text) {
      out.text = payload.output_text;
      out.observed = true;
    }
  }

  return out;
}

function readErrorCode(obj, response, payload) {
  const containers = [payload, response, obj];
  for (const container of containers) {
    if (!isObject(container)) continue;
    const direct = container.error_code ?? container.errorCode;
    if (direct !== undefined && direct !== null && direct !== '') return String(direct);
    const error = container.error;
    if (isObject(error)) {
      const code = error.code ?? error.type ?? error.status ?? error.message;
      if (code !== undefined && code !== null && code !== '') return String(code);
    } else if (typeof error === 'string' && error) {
      return error.slice(0, 80);
    }
  }
  return null;
}

/** 单行对象 → 半成品记录；不是「调用记录」返回 null。 */
export function toPartialRecord(obj) {
  if (!isObject(obj)) return null;
  // SSE / 流式事件行不是完整调用，跳过。
  if (lower(obj.type) === 'message_start' || lower(obj.type) === 'content_block_delta') return null;

  const { request, response } = unwrap(obj);
  const payload = response || obj;
  const usage = extractUsage([payload, response, obj, request]);
  const content = extractContent(payload);
  const wrappedStatus = isObject(response) && response.__status !== undefined ? response.__status : undefined;
  const status = numOr(
    wrappedStatus ??
      pickFirst([payload, response, obj], ['status', 'status_code', 'statusCode', 'http_status', 'httpStatus']),
    null
  );
  const errorCode = readErrorCode(obj, response, payload);
  const model = strOr(pickFirst([payload, response, obj], ['model', 'response_model', 'responseModel', 'model_slug']), null);
  const requestModel = strOr(
    pickFirst([request, obj, payload], ['model', 'request_model', 'requestModel', 'requested_model', 'model_requested']),
    null
  );
  const hasResponseEvidence =
    Boolean(response) ||
    Boolean(usage) ||
    content.text !== '' ||
    content.observed ||
    content.finishReason != null ||
    status != null ||
    errorCode != null;
  if (!hasResponseEvidence) return null;
  if (!usage && !content.observed && content.finishReason == null && status == null && errorCode == null) return null;

  const latency = numOr(
    pickFirst(
      [obj, response, payload],
      [
        'latency_ms', 'latencyMs', 'duration_ms', 'durationMs', 'elapsed_ms', 'elapsedMs',
        'response_time_ms', 'responseTimeMs', 'response_time', 'latency', 'duration'
      ]
    ),
    null
  );

  return {
    timestamp: pickFirst([obj, response], ['timestamp', 'ts', 'time', 'created_at', 'createdAt', 'date', 'created']),
    provider: strOr(obj.provider, null),
    responseId: strOr(pickFirst([payload, response], ['id', 'response_id', 'responseId']), null),
    model,
    requestModel,
    sessionId: strOr(
      pickFirst([obj, request, response], ['sessionId', 'session_id', 'conversation_id', 'conversationId', 'thread_id']),
      null
    ),
    kind: 'assistant',
    promptText: '',
    completionText: content.text,
    completionObserved: content.observed || content.text !== '' || usage != null,
    // 只有「确实观测到 thinking 块」时才给 thinkingChars；
    // 纯文本响应无法区分「没开 thinking」与「日志没记 thinking」，一律 null（不当作 0）。
    thinkingChars: content.hasThinking ? content.thinkingChars : null,
    hasThinkingSignature: content.hasThinking ? content.hasSignature : null,
    ...readUsage(usage),
    finishReason: content.finishReason,
    status: status,
    errorCode,
    latencyMs: latency,
    raw: obj
  };
}

/**
 * 解析通用 API 日志。支持 JSONL 与「整文件是一个响应对象数组」两种形态。
 *
 * @param {string} text
 * @param {{startIndex?: number, maxRecords?: number}} [options]
 * @returns {{records: object[], total: number, skipped: number, warnings: string[]}}
 */
export function parse(text, options = {}) {
  const source = typeof text === 'string' ? text : '';
  const startIndex = Number.isFinite(options.startIndex) ? options.startIndex : 0;
  const maxRecords = Number.isFinite(options.maxRecords) ? options.maxRecords : Infinity;
  const records = [];
  const warnings = [];
  let total = 0;
  let badJson = 0;
  let ignored = 0;

  const trimmed = source.trim();
  const wholeArray = /^\[/.test(trimmed) ? tryParseJsonObject(trimmed) : null;

  const pushPartial = (partial) => {
    if (!partial) {
      ignored += 1;
      return;
    }
    records.push({ ...partial, __index: startIndex + records.length });
  };

  if (wholeArray && Array.isArray(wholeArray)) {
    for (const item of wholeArray) {
      total += 1;
      if (isObject(item)) {
        // 数组元素可能再包一层 {request,response}
        pushPartial(toPartialRecord(item));
      } else {
        badJson += 1;
      }
      if (records.length >= maxRecords) break;
    }
  } else {
    const lines = source.split(/\r?\n/);
    for (const rawLine of lines) {
      const line = rawLine.trim();
      if (!line) continue;
      total += 1;
      let obj;
      try {
        obj = JSON.parse(line);
      } catch {
        badJson += 1;
        continue;
      }
      if (!isObject(obj)) {
        badJson += 1;
        continue;
      }
      pushPartial(toPartialRecord(obj));
      if (records.length >= maxRecords) break;
    }
  }

  const skipped = Math.max(0, total - records.length);
  if (badJson > 0) warnings.push(`跳过 ${badJson} 行无法解析的 JSON。`);
  const nonRecord = skipped - badJson;
  if (nonRecord > 0) warnings.push(`跳过 ${nonRecord} 行非响应记录（只有请求 / 流式事件 / 未知形状）。`);

  return { records, total, skipped, warnings };
}
