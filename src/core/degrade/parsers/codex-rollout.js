/**
 * Codex CLI rollout 会话日志解析器（契约 v3 §10.2 v3.1 新增第五格式）。
 *
 * 真实文件位于 `~/.codex/sessions/YYYY/MM/DD/rollout-*.jsonl`，每行一个对象，
 * `type` ∈ {`session_meta`, `turn_context`, `event_msg`, `response_item`,
 * `token_usage_record`, `world_state`}。
 *
 * 关键映射（字段名已对真实样例核对）：
 *  - **usage 记录** ← `event_msg` 且 `payload.type === 'token_count'`
 *    （`payload.info.last_token_usage`：input_tokens / output_tokens /
 *    reasoning_output_tokens / cached_input_tokens / cache_write_input_tokens）；
 *  - **assistant 文本** ← `response_item` 且 `payload.role === 'assistant'`
 *    （`payload.content[].type === 'output_text'`）；
 *  - **思考存在性** ← `response_item` 且 `payload.type === 'reasoning'`
 *    （带 `encrypted_content` / `summary`，属于 Codex 的加密推理，
 *    **不是** Claude 的 thinking signature，因此绝不设 `hasThinkingSignature`）；
 *  - **失败信号** ← `event_msg` 且 `payload.type === 'turn_aborted'` → status 499；
 *  - **延迟** ← `event_msg.payload.duration_ms`，其次 `time_to_first_token_ms`；
 *  - **去重**：`token_usage_record` 与 `token_count` 内容重叠，只采用 `token_count`。
 *
 * 该格式**没有 finish_reason**：一律置 null，绝不编造。
 */
import { isObject, numOr, strOr } from '../util.js';

/** 该格式可能出现的行类型（用于格式识别，不做解析）。 */
export const CODEX_LINE_TYPES = new Set([
  'session_meta',
  'turn_context',
  'event_msg',
  'response_item',
  'token_usage_record',
  'world_state'
]);

function lower(value) {
  return strOr(value, '').toLowerCase();
}

/** 从 response_item / message 的内容块里拼接正文。 */
function readMessageText(payload) {
  const parts = [];
  const content = payload.content;
  if (typeof content === 'string') parts.push(content);
  if (Array.isArray(content)) {
    for (const block of content) {
      if (typeof block === 'string') {
        parts.push(block);
        continue;
      }
      if (!isObject(block)) continue;
      if (typeof block.text === 'string') parts.push(block.text);
      else if (typeof block.output_text === 'string') parts.push(block.output_text);
    }
  }
  const output = payload.output;
  if (Array.isArray(output)) {
    for (const item of output) {
      if (typeof item === 'string') parts.push(item);
      else if (isObject(item) && typeof item.text === 'string') parts.push(item.text);
    }
  }
  return parts.filter(Boolean).join('\n');
}

/** 读取 token 用量（`payload.info.last_token_usage`）。 */
function readTokenCount(payload) {
  const info = isObject(payload.info) ? payload.info : null;
  const usage = info && isObject(info.last_token_usage) ? info.last_token_usage : null;
  if (!usage) return null;
  return {
    promptTokens: numOr(usage.input_tokens ?? usage.prompt_tokens, null),
    completionTokens: numOr(usage.output_tokens ?? usage.completion_tokens, null),
    thinkingTokens: numOr(usage.reasoning_output_tokens ?? usage.reasoning_tokens, null),
    cacheReadTokens: numOr(usage.cached_input_tokens ?? usage.cache_read_input_tokens, null),
    cacheWriteTokens: numOr(usage.cache_write_input_tokens ?? usage.cache_creation_input_tokens, null)
  };
}

function readError(payload) {
  if (!isObject(payload) || !isObject(payload.error)) return null;
  const error = payload.error;
  const status =
    numOr(error.status, null) ??
    numOr(error.status_code, null) ??
    numOr(error.http_status, null) ??
    500;
  return { status, code: strOr(error.code ?? error.type ?? error.message, null) };
}

/**
 * 解析 Codex rollout JSONL。
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
  let deduped = 0;

  // 会话状态（单文件通常就是单会话）
  let sessionId = null;
  let lastTurnModel = null;
  let lastThreadSettingsModel = null;
  let reasoningSeen = false;

  const currentModel = () => lastThreadSettingsModel || lastTurnModel || null;

  const push = (partial) => {
    if (!partial) return;
    records.push({ ...partial, __index: startIndex + records.length });
  };

  for (const rawLine of source.split(/\r?\n/)) {
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
    const type = lower(obj.type);
    const payload = isObject(obj.payload) ? obj.payload : {};
    const timestamp = obj.timestamp ?? payload.timestamp ?? null;

    if (type === 'session_meta') {
      sessionId = sessionId || strOr(payload.session_id ?? payload.id ?? payload.thread_id, null);
      continue;
    }

    if (type === 'turn_context') {
      lastTurnModel = strOr(payload.model, null) || lastTurnModel;
      reasoningSeen = false;
      continue;
    }

    if (type === 'token_usage_record') {
      // 与 event_msg/token_count 重复，只保留后者（去重）。
      deduped += 1;
      continue;
    }

    if (type === 'event_msg') {
      const eventType = lower(payload.type);
      if (eventType === 'token_count') {
        // 有些版本把 thread_settings 内联在 token_count 里（真实样例另有独立事件，两者都兼容）。
        if (isObject(payload.thread_settings)) {
          lastThreadSettingsModel = strOr(payload.thread_settings.model, null) || lastThreadSettingsModel;
        }
        const usage = readTokenCount(payload);
        if (usage) {
          const error = readError(payload);
          push({
            timestamp,
            provider: 'openai',
            model: currentModel(),
            requestModel: lastTurnModel,
            sessionId: strOr(payload.thread_id, null) || sessionId,
            kind: 'usage',
            promptText: '',
            completionText: '',
            completionObserved: false,
            thinkingChars: null,
            hasThinkingSignature: null,
            finishReason: null, // 该格式没有 finish_reason
            status: error ? error.status : null,
            errorCode: error ? error.code : null,
            latencyMs: numOr(payload.duration_ms, null),
            ...usage
          });
        }
      } else if (eventType === 'task_complete') {
        const error = readError(payload);
        const text = typeof payload.last_agent_message === 'string' ? payload.last_agent_message : '';
        push({
          timestamp,
          provider: 'openai',
          model: currentModel(),
          requestModel: lastTurnModel,
          sessionId,
          kind: 'assistant',
          promptText: '',
          completionText: text,
          completionObserved: true,
          thinkingChars: reasoningSeen ? 1 : 0,
          hasThinking: reasoningSeen,
          hasThinkingSignature: null,
          finishReason: null,
          status: error ? error.status : 200,
          errorCode: error ? error.code : null,
          latencyMs:
            numOr(payload.duration_ms, null) ?? numOr(payload.time_to_first_token_ms, null)
        });
      } else if (eventType === 'turn_aborted') {
        push({
          timestamp,
          provider: 'openai',
          model: currentModel(),
          requestModel: lastTurnModel,
          sessionId,
          kind: 'assistant',
          promptText: '',
          completionText: '',
          completionObserved: false,
          thinkingChars: null,
          hasThinkingSignature: null,
          finishReason: null,
          status: 499, // 客户端主动中断（契约 v3.1 约定）
          errorCode: 'turn_aborted',
          latencyMs: numOr(payload.duration_ms, null)
        });
      }
      // task_started / item_completed / thread_settings_applied 等不产出记录
      if (eventType === 'thread_settings_applied' && isObject(payload.thread_settings)) {
        lastThreadSettingsModel = strOr(payload.thread_settings.model, null) || lastThreadSettingsModel;
      }
    } else if (type === 'response_item') {
      const itemType = lower(payload.type);
      if (itemType === 'reasoning') {
        reasoningSeen = true;
        continue;
      }
      if (itemType === 'message' && lower(payload.role) === 'assistant') {
        const text = readMessageText(payload);
        // Codex 的 keepalive / 进度占位消息：content 只有一个空格或空串，
        // 不携带任何回答信号（用户真实样例里 41 条 assistant 消息中有 27 条是这种）。
        // 若把它们当成「空回答」，empty_rate 会被抬到 ~50% 并产生假的 empty_rate_spike，
        // 因此「空白且没有 token 记录的 assistant 消息」不进入分析。
        // 注意：真正的空响应仍然会通过 usage 记录（completionTokens===0）或其它格式的
        // completionObserved 记录体现，不会因为这里跳过而丢失。
        if (text.trim() === '') continue;
        push({
          timestamp,
          provider: 'openai',
          model: currentModel(),
          requestModel: lastTurnModel,
          sessionId: sessionId || strOr(payload.thread_id, null),
          kind: 'assistant',
          promptText: '',
          completionText: text,
          completionObserved: true,
          thinkingChars: reasoningSeen ? 1 : 0,
          hasThinking: reasoningSeen,
          hasThinkingSignature: null,
          finishReason: null,
          status: null,
          errorCode: null,
          latencyMs: null
        });
      }
      // custom_tool_call / function_call 等不是回答，不产出记录
    }
    // session_meta / turn_context / world_state 已在上面处理或忽略

    if (records.length >= maxRecords) break;
  }

  const skipped = Math.max(0, total - records.length);
  if (badJson > 0) warnings.push(`跳过 ${badJson} 行无法解析的 JSON。`);
  if (deduped > 0) warnings.push(`忽略 ${deduped} 行 token_usage_record（与 token_count 重复，已去重）。`);
  const nonRecord = skipped - badJson - deduped;
  if (nonRecord > 0) warnings.push(`跳过 ${nonRecord} 行元数据 / 工具调用记录。`);

  return { records, total, skipped, warnings };
}
