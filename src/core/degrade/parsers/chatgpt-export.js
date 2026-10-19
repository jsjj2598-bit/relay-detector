/**
 * ChatGPT 官方导出解析器（`conversations.json`，契约 v3 §10.2）。
 *
 * 导出文件是「会话数组」，每个会话含 `mapping` 节点树：
 * ```json
 * [{ "title": "...", "create_time": 1710000000.123,
 *    "mapping": { "node-id": {
 *        "id": "node-id", "parent": "...", "children": [],
 *        "message": { "author": {"role": "assistant"},
 *                     "content": {"content_type": "text", "parts": ["..."]},
 *                     "create_time": 1710000000.5,
 *                     "metadata": {"model_slug": "gpt-4o"} } } },
 *    "current_node": "..." }]
 * ```
 *
 * 设计要点：
 *  - 只产出 **assistant 消息** 记录（用户提示词不需要进分析）；
 *  - 遍历 `mapping` 全部节点（不假设只有一条主线；导出里可能有重新生成的分支）；
 *  - `create_time` 是秒，统一交给 `normalize.parseTimestamp` 处理单位；
 *  - `metadata.model_slug` / `metadata.model` → model；
 *  - 该格式**没有 token 与 requestModel**：字段留 null（绝不编造 0），
 *    因此大多数 token 类指标会自动 `insufficient`。
 */
import { isObject, strOr } from '../util.js';

/** 从内容对象里提取纯文本。 */
function readParts(content) {
  if (typeof content === 'string') return content;
  if (!isObject(content)) return '';
  if (Array.isArray(content.parts)) {
    return content.parts
      .map((part) => {
        if (typeof part === 'string') return part;
        if (isObject(part) && typeof part.text === 'string') return part.text;
        return '';
      })
      .filter(Boolean)
      .join('\n');
  }
  if (typeof content.text === 'string') return content.text;
  return '';
}

function readFinishReason(message) {
  const details = isObject(message.metadata) && isObject(message.metadata.finish_details)
    ? message.metadata.finish_details
    : null;
  if (details && typeof details.type === 'string') return details.type;
  if (typeof message.status === 'string') return message.status;
  return null;
}

/**
 * 解析 ChatGPT 导出 JSON。
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

  let data;
  try {
    data = JSON.parse(source);
  } catch {
    return {
      records: [],
      total: 0,
      skipped: 0,
      warnings: ['ChatGPT 导出文件不是合法 JSON，无法解析。']
    };
  }

  const conversations = Array.isArray(data)
    ? data
    : isObject(data) && Array.isArray(data.conversations)
      ? data.conversations
      : isObject(data) && isObject(data.mapping)
        ? [data]
        : null;

  if (!conversations) {
    return {
      records: [],
      total: 0,
      skipped: 0,
      warnings: ['未找到 conversations 数组或 mapping 节点树。']
    };
  }

  let malformed = 0;
  outer: for (const conversation of conversations) {
    if (!isObject(conversation) || !isObject(conversation.mapping)) {
      malformed += 1;
      continue;
    }
    const conversationTs = conversation.create_time ?? conversation.createTime;
    for (const node of Object.values(conversation.mapping)) {
      const message = isObject(node) && isObject(node.message) ? node.message : null;
      if (!message) continue;
      const role = isObject(message.author) ? strOr(message.author.role, '') : '';
      if (role !== 'assistant') continue;
      total += 1;
      const model =
        isObject(message.metadata) && (strOr(message.metadata.model_slug, null) || strOr(message.metadata.model, null));
      const completionText = readParts(message.content);
      records.push({
        timestamp: message.create_time ?? message.createTime ?? conversationTs,
        provider: 'openai',
        model: model || null,
        requestModel: null,
        sessionId: strOr(conversation.id, null) || strOr(conversation.title, null),
        kind: 'assistant',
        promptText: '',
        completionText,
        completionObserved: true,
        finishReason: readFinishReason(message),
        status: null,
        errorCode: null,
        latencyMs: null,
        raw: node
      });
      if (records.length >= maxRecords) break outer;
    }
  }

  const skipped = Math.max(0, total - records.length);
  if (malformed > 0) warnings.push(`跳过 ${malformed} 个缺少 mapping 的会话。`);
  if (records.length === 0) warnings.push('没有解析到 assistant 消息。');

  return {
    records: records.map((record, offset) => ({ ...record, __index: startIndex + offset })),
    total,
    skipped,
    warnings
  };
}
