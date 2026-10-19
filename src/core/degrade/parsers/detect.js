/**
 * 日志格式自动识别（契约 v3 §14.2）。
 *
 * **绝不依赖扩展名**：伪装成 `.csv` / `.log` / 无扩展名的 Claude Code JSONL
 * 仍必须识别为 `claude-code`。识别方式是「内容打分」：
 *  - `chatgpt-export`：整个文件能解析成 JSON，且元素含 `mapping` 节点树；
 *  - `codex-rollout`：JSONL 且 `type` 命中 Codex 行类型集合的比例；
 *  - `claude-code`：JSONL 且每行有 `type ∈ {assistant,user,system}` + `message` 结构；
 *  - `api-log`：JSONL 且每行像「API 响应」（usage / choices / request+response / content+stop_reason），
 *    或整文件是响应对象数组；
 *  - `usage-csv`：存在含 ≥2 个已知列名的分隔符表头 + 数据行。
 *
 * 打分全部在 `try/catch` 里执行：识别失败只会得到 `unknown`，绝不抛异常。
 */
import { FORMAT_CONFIDENCE_MIN, LOG_FORMATS } from '../constants.js';
import { clamp, isObject, isNum } from '../util.js';
import { detectDelimiter, mapHeader, normalizeHeaderKey, splitCsvLine } from './usage-csv.js';
import { CODEX_LINE_TYPES } from './codex-rollout.js';

/** 同分时的优先顺序。 */
const PRIORITY = ['chatgpt-export', 'codex-rollout', 'claude-code', 'api-log', 'usage-csv'];

const SAMPLE_LINE_LIMIT = 120;

function sampleJsonLines(text) {
  const lines = String(text == null ? '' : text).split(/\r?\n/);
  const objs = [];
  let attempts = 0;
  for (const raw of lines) {
    if (attempts >= SAMPLE_LINE_LIMIT) break;
    const line = raw.trim();
    if (!line) continue;
    attempts += 1;
    try {
      objs.push(JSON.parse(line));
    } catch {
      /* 该行不是 JSON，计入 attempts 但不计分 */
    }
  }
  return { objs, attempts };
}

function wholeJson(text) {
  const trimmed = String(text == null ? '' : text).trim();
  if (!trimmed || !/^[[{]/.test(trimmed)) return null;
  if (trimmed.length > 64 * 1024 * 1024) return null;
  try {
    return JSON.parse(trimmed);
  } catch {
    return null;
  }
}

/* ------------------------------------------------------------------ */
/* 各格式打分（0..1，越高越像）                                          */
/* ------------------------------------------------------------------ */

function sniffChatgpt(text) {
  const whole = wholeJson(text);
  if (!whole) return 0;
  const list = Array.isArray(whole)
    ? whole
    : isObject(whole) && Array.isArray(whole.conversations)
      ? whole.conversations
      : null;
  if (!list || list.length === 0) return 0;
  const sample = list.slice(0, 5);
  let points = 0;
  for (const conversation of sample) {
    if (!isObject(conversation)) continue;
    let p = 0;
    if (isObject(conversation.mapping)) {
      p += 2;
      const hasMessageNode = Object.values(conversation.mapping).some(
        (node) => isObject(node) && isObject(node.message) && isObject(node.message.author)
      );
      if (hasMessageNode) p += 2;
    }
    if (typeof conversation.title === 'string') p += 1;
    if (isNum(conversation.create_time) || isNum(conversation.update_time)) p += 1;
    if (typeof conversation.current_node === 'string') p += 1;
    points += p;
  }
  return clamp(points / (sample.length * 7), 0, 1);
}

function sniffCodex(text) {
  const { objs, attempts } = sampleJsonLines(text);
  if (!objs.length || !attempts) return 0;
  let known = 0;
  let payloadTyped = 0;
  for (const obj of objs) {
    if (!isObject(obj)) continue;
    if (typeof obj.type === 'string' && CODEX_LINE_TYPES.has(obj.type)) {
      known += 1;
      if (isObject(obj.payload)) payloadTyped += 1;
    }
  }
  const ratio = known / attempts;
  if (ratio <= 0.3) return 0;
  // 置信度按比例给，并稍微参考 payload 结构完整度
  const structure = known > 0 ? payloadTyped / known : 0;
  return clamp(ratio * (0.85 + 0.15 * structure), 0, 1);
}

function sniffClaudeCode(text) {
  const { objs, attempts } = sampleJsonLines(text);
  if (!objs.length || !attempts) return 0;
  let points = 0;
  let strong = 0;
  for (const obj of objs) {
    if (!isObject(obj)) continue;
    const type = typeof obj.type === 'string' ? obj.type.toLowerCase() : '';
    const message = isObject(obj.message) ? obj.message : null;
    let p = 0;
    if (type === 'assistant' || type === 'user' || type === 'system') p += 2;
    if (message && typeof message.role === 'string') p += 1;
    if (message && isObject(message.usage)) {
      p += 2;
      if (type === 'assistant' || type === 'user' || type === 'system') strong += 1;
    }
    if (message && Array.isArray(message.content)) p += 1;
    if (obj.sessionId || obj.parentUuid || obj.cwd || obj.version) p += 1;
    if (type === 'assistant' && message && Array.isArray(message.content)) strong += 1;
    points += p;
  }
  const confidence = clamp(points / (objs.length * 7), 0, 1) * (objs.length / attempts);
  if (strong === 0 && confidence < 0.5) return 0;
  return confidence;
}

function scoreApiLogLine(obj) {
  if (!isObject(obj)) return 0;
  let p = 0;
  if (isObject(obj.usage)) p += 2;
  if (isObject(obj.request)) p += 2;
  if (isObject(obj.response)) p += 2;
  if (Array.isArray(obj.choices)) p += 2;
  const response = isObject(obj.response) ? obj.response : null;
  const usage = isObject(obj.usage) ? obj.usage : response && isObject(response.usage) ? response.usage : null;
  if (usage) p += 1;
  if (typeof obj.model === 'string' && obj.model) p += 1;
  if (response && typeof response.model === 'string') p += 1;
  if (isObject(obj.request) && (typeof obj.request.model === 'string' || Array.isArray(obj.request.messages))) p += 1;
  if (Array.isArray(obj.content) && (typeof obj.stop_reason === 'string' || isObject(obj.usage))) p += 2;
  if (typeof obj.status === 'number' || typeof obj.status_code === 'number') p += 1;
  if (typeof obj.error_code === 'string' || isObject(obj.error)) p += 1;
  return p;
}

function sniffApiLog(text) {
  const trimmed = String(text == null ? '' : text).trim();
  // 整文件是响应对象数组
  if (/^\[/.test(trimmed)) {
    const whole = wholeJson(text);
    if (Array.isArray(whole) && whole.length > 0) {
      const sample = whole.slice(0, 20);
      let matched = 0;
      let points = 0;
      for (const obj of sample) {
        const p = scoreApiLogLine(obj);
        if (p >= 3) matched += 1;
        points += p;
      }
      if (matched === 0) return 0;
      return clamp((points / (sample.length * 10)) * 0.9, 0, 1);
    }
    return 0;
  }
  const { objs, attempts } = sampleJsonLines(text);
  if (!objs.length || !attempts) return 0;
  let matched = 0;
  let points = 0;
  for (const obj of objs) {
    const p = scoreApiLogLine(obj);
    if (p >= 3) matched += 1;
    points += p;
  }
  if (matched === 0) return 0;
  return clamp(points / (objs.length * 10), 0, 1) * (objs.length / attempts);
}

function sniffCsv(text) {
  const trimmed = String(text == null ? '' : text)
    .replace(/^\uFEFF/, '')
    .trimStart();
  if (!trimmed || /^[[{]/.test(trimmed)) return 0;
  const lines = trimmed
    .split(/\r?\n/)
    .filter((line) => line.trim())
    .slice(0, 6);
  if (lines.length < 2) return 0;
  const delimiter = detectDelimiter(lines[0]);
  if (!delimiter) return 0;
  const headerCells = splitCsvLine(lines[0], delimiter);
  if (headerCells.length < 2) return 0;
  const mapping = mapHeader(headerCells);
  const matched = Object.keys(mapping).length;
  if (matched < 2) return 0;
  const consistentRows = lines
    .slice(1)
    .filter((line) => splitCsvLine(line, delimiter).length >= Math.min(headerCells.length, 2)).length;
  const headerLooksLikeCsv = headerCells.some((cell) => /[a-zA-Z\u4e00-\u9fa5]/.test(cell));
  if (!headerLooksLikeCsv) return 0;
  return clamp((matched / 5) * 0.75 + (consistentRows >= 2 ? 0.25 : 0), 0, 1);
}

/**
 * 识别日志格式。
 *
 * @param {string} text 文件全文
 * @param {string} [name] 文件名（**仅用于调试/提示，绝不参与格式判定**）
 * @returns {{format: string, confidence: number, scores: Record<string, number>}}
 */
export function detectFormat(text, name = '') {
  const source = typeof text === 'string' ? text : '';
  const scores = {};
  for (const format of LOG_FORMATS) scores[format] = 0;
  try {
    scores['chatgpt-export'] = sniffChatgpt(source);
    scores['codex-rollout'] = sniffCodex(source);
    scores['claude-code'] = sniffClaudeCode(source);
    scores['api-log'] = sniffApiLog(source);
    scores['usage-csv'] = sniffCsv(source);
  } catch {
    // 识别异常一律 unknown（契约：绝不抛异常）
    return { format: 'unknown', confidence: 0, scores };
  }

  let best = 'unknown';
  let bestScore = 0;
  for (const format of PRIORITY) {
    const score = scores[format] || 0;
    if (score > bestScore + 1e-9) {
      bestScore = score;
      best = format;
    }
  }
  const confidence = clamp(bestScore, 0, 1);
  if (confidence < FORMAT_CONFIDENCE_MIN) {
    return { format: 'unknown', confidence, scores };
  }
  return { format: best, confidence, scores };
}

export { normalizeHeaderKey };
export default { detectFormat };
