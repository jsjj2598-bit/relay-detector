/**
 * v3 降智诊断（src/core/degrade/**）离线测试基础设施。
 *
 * 提供：
 *  - 四个日志格式 fixture 的读取（test/fixtures/logs/）
 *  - 契约 §10.1 LogRecord 的合成构造器（指标 / 分析测试共用，全部离线）
 *  - 时间序列构造与断言辅助
 *
 * 本文件只读源码、不修改源码。
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
export const LOG_FIXTURE_DIR = path.resolve(HERE, '..', 'fixtures', 'logs');

/** 五个格式 fixture 的文件名（契约 §10.2：四个原始格式 + v3.1 的 codex-rollout）。 */
export const LOG_FIXTURES = {
  claudeCode: 'claude-code.jsonl',
  codexRollout: 'codex-rollout.jsonl',
  apiLog: 'api-log.jsonl',
  usageCsv: 'usage.csv',
  chatgptExport: 'chatgpt-export.json'
};

/** 读取 fixture 原文（UTF-8，保留 BOM；用于伪装扩展名测试时换 name 传入）。 */
export function loadLogFixture(key) {
  const name = LOG_FIXTURES[key] || key;
  const file = path.join(LOG_FIXTURE_DIR, name);
  if (!fs.existsSync(file)) throw new Error(`日志 fixture 不存在: ${file}`);
  return fs.readFileSync(file, 'utf8');
}

/** 构造 `{ name, text }` 文件对象（浏览器端 FileReader 读出的形状）。 */
export function logFile(name, text) {
  return { name, text };
}

export const HOUR = 3600 * 1000;
export const DAY = 24 * HOUR;

const BASE_TIME = Date.parse('2026-01-01T00:00:00.000Z');

/**
 * 构造一条契约 §10.1 的 LogRecord。
 *
 * @param {object} [overrides]
 * @returns {object}
 */
export function makeRecord(overrides = {}) {
  return {
    index: 0,
    timestamp: BASE_TIME,
    provider: 'openai',
    model: 'gpt-4o',
    requestModel: 'gpt-4o',
    sessionId: null,
    source: 'api-log',
    kind: 'assistant',
    promptText: '',
    completionText: '',
    promptTokens: null,
    completionTokens: null,
    cacheReadTokens: null,
    cacheWriteTokens: null,
    thinkingTokens: null,
    thinkingChars: null,
    hasThinkingSignature: null,
    finishReason: null,
    status: 200,
    errorCode: null,
    latencyMs: null,
    raw: {},
    ...overrides
  };
}

/**
 * 构造一串按时间递增的 LogRecord。
 *
 * @param {number} count 条数
 * @param {object|((index:number)=>object)} [overrides] 固定覆盖或按索引生成覆盖
 * @param {{start?:number, stepMs?:number}} [timing]
 * @returns {object[]}
 */
export function makeRecords(count, overrides = {}, timing = {}) {
  const start = typeof timing.start === 'number' ? timing.start : BASE_TIME;
  const step = typeof timing.stepMs === 'number' ? timing.stepMs : HOUR;
  const list = [];
  for (let index = 0; index < count; index += 1) {
    const extra = typeof overrides === 'function' ? overrides(index) : overrides;
    list.push(
      makeRecord({
        index,
        timestamp: start + index * step,
        ...extra
      })
    );
  }
  return list;
}

/** 在时间轴上拼接多段记录（用于「早期正常 + 近期退化」）。 */
export function concatRecords(...groups) {
  const out = [];
  for (const group of groups) {
    for (const record of group || []) out.push(record);
  }
  return out.map((record, index) => ({ ...record, index }));
}

/**
 * 生成一段**合成** Codex rollout JSONL 文本（v3.1 第五格式）。
 *
 * 用于回归「纯空白 assistant 占位消息（keepalive / 进度消息）不应被当成空回答」：
 *  - `normal`：正常 assistant 消息数（`response_item` + `output_text`，非空文本）；
 *  - `placeholders`：占位消息数，文本恰好是一个空格（默认只出现在时间轴后半段，
 *    以复现「近期占位消息把 empty_rate 抬高」的假信号场景）；
 *  - `tokenCounts`：`event_msg.payload.type === 'token_count'` 的用量事件数。
 *
 * @param {object} [options]
 * @returns {string} JSONL 文本（每行一个合成对象，不含任何真实用户数据）
 */
export function buildCodexRolloutText(options = {}) {
  const {
    normal = 0,
    placeholders = 0,
    tokenCounts = 0,
    days = 4,
    sessionId = 'sess-codex-synthetic',
    model = 'gpt-5-codex',
    start = Date.parse('2026-08-01T00:00:00.000Z')
  } = options;
  const slotCount = Math.max(1, normal + placeholders + tokenCounts);
  const spanMs = Math.max(HOUR, days * DAY);
  const at = (position, index) =>
    new Date(start + Math.round(spanMs * position) + index * 1000).toISOString();

  const events = [];
  const add = (position, line) => events.push({ position, line });

  // 元数据行（格式识别依赖 type 集合）
  add(0, JSON.stringify({ timestamp: at(0, 0), type: 'session_meta', payload: { id: sessionId, timestamp: at(0, 0), cwd: '/synthetic/codex/workdir' } }));
  add(0.001, JSON.stringify({ timestamp: at(0.001, 0), type: 'turn_context', payload: { cwd: '/synthetic/codex/workdir', model, effort: 'medium' } }));

  let sequence = 0;
  const nextIndex = () => {
    sequence += 1;
    return sequence;
  };

  // 正常 assistant 消息：均匀铺满整个时间轴
  for (let i = 0; i < normal; i += 1) {
    const position = normal <= 1 ? 0.5 : 0.02 + (0.96 * i) / (normal - 1);
    const index = nextIndex();
    add(
      position,
      JSON.stringify({
        timestamp: at(position, index),
        type: 'response_item',
        payload: {
          type: 'message',
          role: 'assistant',
          content: [{ type: 'output_text', text: `合成正常回答 #${index}：这是一段足够长的回答内容。` }]
        }
      })
    );
  }

  // 占位消息：文本恰好是一个空格（keepalive / 进度消息），只出现在后半段
  for (let i = 0; i < placeholders; i += 1) {
    const position = placeholders <= 1 ? 0.8 : 0.6 + (0.38 * i) / (placeholders - 1);
    const index = nextIndex();
    add(
      position,
      JSON.stringify({
        timestamp: at(position, index),
        type: 'response_item',
        payload: {
          type: 'message',
          role: 'assistant',
          content: [{ type: 'output_text', text: ' ' }]
        }
      })
    );
  }

  // token_count 用量事件：均匀铺满
  for (let i = 0; i < tokenCounts; i += 1) {
    const position = tokenCounts <= 1 ? 0.5 : 0.01 + (0.98 * i) / (tokenCounts - 1);
    const index = nextIndex();
    add(
      position,
      JSON.stringify({
        timestamp: at(position, index),
        type: 'event_msg',
        payload: {
          type: 'token_count',
          thread_id: sessionId,
          duration_ms: 800,
          info: {
            last_token_usage: {
              input_tokens: 1000,
              output_tokens: 200,
              reasoning_output_tokens: 80,
              cached_input_tokens: 0,
              cache_write_input_tokens: 0
            }
          }
        }
      })
    );
  }

  // 再补一条 task_complete / turn_aborted 让 assistant / status 记录形态更完整
  const tailIndex = nextIndex();
  add(
    0.99,
    JSON.stringify({
      timestamp: at(0.99, tailIndex),
      type: 'event_msg',
      payload: { type: 'task_complete', thread_id: sessionId, last_agent_message: '合成任务完成。', duration_ms: 6000 }
    })
  );
  add(
    0.995,
    JSON.stringify({
      timestamp: at(0.995, tailIndex),
      type: 'token_usage_record',
      payload: { input_tokens: 1000, output_tokens: 200, reasoning_output_tokens: 80 }
    })
  );
  add(
    0.997,
    JSON.stringify({
      timestamp: at(0.997, tailIndex),
      type: 'event_msg',
      payload: { type: 'turn_aborted', thread_id: sessionId, reason: 'user_interrupt', duration_ms: 300 }
    })
  );

  events.sort((a, b) => a.position - b.position);
  // slotCount 只用于参数校验（事件数由各分支决定）
  void slotCount;
  return events.map((event) => event.line).join('\n') + '\n';
}

/** 断言对象（含嵌套）序列化后不含某个敏感字符串。 */
export function assertNotStringified(value, needle, label = '报告') {
  const blob = JSON.stringify(value);
  if (blob.includes(needle)) {
    throw new Error(`${label} 中出现敏感字符串「${needle}」（契约 §9：报告不得包含日志原文/文件名）`);
  }
}

/** 递归断言对象里不存在某些字段名（如 raw）。 */
export function assertNoFieldDeep(value, fieldName, label = '报告') {
  const seen = new Set();
  const walk = (node, depth) => {
    if (depth > 12 || node == null || typeof node !== 'object') return;
    if (seen.has(node)) return;
    seen.add(node);
    if (Array.isArray(node)) {
      for (const item of node) walk(item, depth + 1);
      return;
    }
    for (const [key, child] of Object.entries(node)) {
      if (key === fieldName) {
        throw new Error(`${label} 中出现了禁止字段「${fieldName}」（契约 §9/§10.3：raw 必须在序列化前剥离）`);
      }
      walk(child, depth + 1);
    }
  };
  walk(value, 0);
}

/** 时间戳格式化（仅测试日志可读性，不参与断言）。 */
export function iso(ms) {
  return new Date(ms).toISOString();
}
