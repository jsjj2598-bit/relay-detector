/**
 * Claude Code 会话日志解析器（`~/.claude/projects/**\/*.jsonl`，契约 v3 §10.2）。
 *
 * 真实文件每行一个 JSON 对象，例如：
 * ```json
 * {"type":"assistant","uuid":"...","parentUuid":"...","sessionId":"...","timestamp":"2026-09-20T00:00:11.000Z",
 *  "durationMs":2345,
 *  "message":{"id":"msg_01...","role":"assistant","model":"claude-sonnet-4-5-20250929",
 *             "content":[{"type":"thinking","thinking":"...","signature":"..."},{"type":"text","text":"..."}],
 *             "stop_reason":"end_turn",
 *             "usage":{"input_tokens":320,"output_tokens":780,
 *                      "cache_creation_input_tokens":0,"cache_read_input_tokens":128}}}
 * ```
 *
 * 设计要点：
 *  - **字段容错**：`type` / `message.role` / 顶层 `role` 任一能判定即可；
 *  - assistant 行产出 kind:'assistant' 记录；user / system 行也产出记录
 *    （kind:'user' / 'system'），它们只计入 coverage，不参与指标分母；
 *  - 其它行类型（summary / file-history-snapshot / queue-operation…）与坏 JSON 记入 skipped；
 *  - 大小写与命名差异（`cache_creation_input_tokens` vs `cacheCreationInputTokens`）都容忍。
 */
import { isObject, numOr, strOr } from '../util.js';

const MESSAGE_TYPES = new Set(['assistant', 'user', 'system']);

function lower(value) {
  return strOr(value, '').toLowerCase();
}

/** 从内容块数组里提取正文 / thinking 信息。 */
function readContentBlocks(content) {
  let text = '';
  let thinkingChars = 0;
  let hasThinking = false;
  let hasSignature = false;
  if (!Array.isArray(content)) {
    if (typeof content === 'string') text = content;
    return { text, thinkingChars, hasThinking, hasSignature };
  }
  const textParts = [];
  for (const block of content) {
    if (typeof block === 'string') {
      textParts.push(block);
      continue;
    }
    if (!isObject(block)) continue;
    const type = lower(block.type);
    if (type === 'text' || (!type && typeof block.text === 'string')) {
      if (typeof block.text === 'string') textParts.push(block.text);
      continue;
    }
    if (type === 'thinking' || type === 'redacted_thinking') {
      hasThinking = true;
      if (typeof block.thinking === 'string') thinkingChars += block.thinking.length;
      if (typeof block.signature === 'string' && block.signature.length > 0) hasSignature = true;
      continue;
    }
    // tool_use / tool_result / image 等块与「回答变短 / thinking 消失」无关，忽略。
  }
  text = textParts.join('\n');
  return { text, thinkingChars, hasThinking, hasSignature };
}

/** 从 usage 里取 token 字段（兼容 snake_case / camelCase）。 */
function readUsage(usage) {
  if (!isObject(usage)) return {};
  return {
    promptTokens: numOr(usage.input_tokens ?? usage.inputTokens ?? usage.prompt_tokens ?? usage.promptTokens, null),
    completionTokens: numOr(usage.output_tokens ?? usage.outputTokens ?? usage.completion_tokens ?? usage.completionTokens, null),
    cacheReadTokens: numOr(
      usage.cache_read_input_tokens ?? usage.cacheReadInputTokens ?? usage.cache_read_tokens ?? usage.cached_tokens,
      null
    ),
    cacheWriteTokens: numOr(
      usage.cache_creation_input_tokens ?? usage.cacheCreationInputTokens ?? usage.cache_write_tokens,
      null
    ),
    thinkingTokens: numOr(usage.thinking_tokens ?? usage.reasoning_tokens ?? usage.thought_tokens, null)
  };
}

/** 把一行 JSON 对象转成半成品记录；不是 assistant 消息行返回 null。 */
export function toPartialRecord(obj) {
  if (!isObject(obj)) return null;
  const type = lower(obj.type);
  const message = isObject(obj.message) ? obj.message : null;
  const role = lower(message ? message.role : obj.role) || type;
  const kindSource = MESSAGE_TYPES.has(role) ? role : type;
  if (!MESSAGE_TYPES.has(kindSource)) return null; // summary / snapshot 等行
  if (kindSource !== 'assistant') return null; // user / system 行不计入分析

  const blocks = readContentBlocks(message ? message.content : obj.content);
  const usage = readUsage(message ? message.usage : obj.usage);
  const model = strOr(message ? message.model : obj.model, null) || strOr(obj.model, null);

  return {
    timestamp: obj.timestamp ?? obj.createdAt ?? obj.created_at,
    sessionId: obj.sessionId ?? obj.session_id ?? obj.conversationId ?? null,
    provider: 'anthropic',
    responseId: strOr(message ? message.id : null, null),
    model,
    requestModel: strOr(message ? message.requestModel : obj.requestModel, null),
    kind: 'assistant',
    completionText: blocks.text,
    completionObserved: true,
    promptText: '',
    ...usage,
    thinkingChars: blocks.thinkingChars, // 0 表示「观测到没有 thinking」，null 才表示未知
    hasThinkingSignature: blocks.hasThinking ? blocks.hasSignature : null,
    finishReason: message ? message.stop_reason ?? message.stopReason : obj.stop_reason,
    latencyMs: numOr(obj.durationMs ?? obj.duration_ms ?? obj.latencyMs ?? obj.latency_ms, null),
    status: numOr(obj.status ?? obj.statusCode, null),
    errorCode: isObject(obj.error) ? strOr(obj.error.type ?? obj.error.code, null) : strOr(obj.error, null),
    raw: obj
  };
}

/**
 * 解析 Claude Code JSONL 文本。
 *
 * @param {string} text
 * @param {{startIndex?: number, maxRecords?: number}} [options]
 * @returns {{records: object[], total: number, skipped: number, warnings: string[]}}
 */
export function parse(text, options = {}) {
  const source = typeof text === 'string' ? text : '';
  const startIndex = Number.isFinite(options.startIndex) ? options.startIndex : 0;
  const maxRecords = Number.isFinite(options.maxRecords) ? options.maxRecords : Infinity;

  const lines = source.split(/\r?\n/);
  const records = [];
  const warnings = [];
  let total = 0;
  let badJson = 0;
  let ignored = 0;

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
    const partial = toPartialRecord(obj);
    if (!partial) {
      ignored += 1;
      continue;
    }
    records.push({ ...partial, __index: startIndex + records.length });
    if (records.length >= maxRecords) break;
  }

  const skipped = Math.max(0, total - records.length);
  if (badJson > 0) warnings.push(`跳过 ${badJson} 行无法解析的 JSON。`);
  const nonMessage = skipped - badJson;
  if (nonMessage > 0) warnings.push(`跳过 ${nonMessage} 行非 assistant 消息记录（user/system/summary 等）。`);

  return { records, total, skipped, warnings };
}
