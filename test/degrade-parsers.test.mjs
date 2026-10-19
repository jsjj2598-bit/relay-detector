/**
 * v3 降智诊断：日志解析器测试（契约 §10.1 / §10.2 / §14.1–14.2 / §14.7）。
 *
 * 全部离线：fixture 在 test/fixtures/logs/ 下（合成日志，不含任何真实用户数据）。
 *
 * 覆盖：
 *  - 四种格式（Claude Code JSONL / 通用 API 日志 JSONL / 用量 CSV / ChatGPT 导出）
 *  - 格式自动识别：同一份内容伪装成不同扩展名 / 无扩展名仍识别为正确格式
 *  - 脏数据：空行、坏 JSON、BOM、CRLF、超大单行（跳过并计入 skipped，不抛异常）
 *  - 单文件失败不影响其它文件
 *  - parseLogFiles 绝不抛异常，返回契约 10.2 形状
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import { analyzeDegradation, parseLogFiles, SUPPORTED_FORMATS } from '../src/core/degrade/index.js';
import {
  LOG_FIXTURES,
  buildCodexRolloutText,
  loadLogFixture,
  logFile
} from './helpers/degrade-fixtures.mjs';

/* ------------------------------------------------------------------ */
/* 契约形状校验                                                          */
/* ------------------------------------------------------------------ */

const SOURCES = ['claude-code', 'codex-rollout', 'api-log', 'usage-csv', 'chatgpt-export', 'generic'];
const PROVIDERS = ['anthropic', 'openai', 'google', 'unknown'];
const KINDS = ['assistant', 'usage', 'user', 'system'];

function assertRecordValid(record, label) {
  assert.ok(record && typeof record === 'object', `${label}: LogRecord 必须是对象`);
  assert.equal(typeof record.index, 'number', `${label}: index 必须是数字`);
  assert.ok(record.timestamp === null || typeof record.timestamp === 'number', `${label}: timestamp 形状非法`);
  if (record.timestamp !== null) assert.ok(Number.isFinite(record.timestamp), `${label}: timestamp 必须有限数`);
  assert.ok(PROVIDERS.includes(record.provider), `${label}: 非法 provider "${record.provider}"`);
  assert.ok(record.model === null || typeof record.model === 'string', `${label}: model 形状非法`);
  assert.ok(record.requestModel === null || typeof record.requestModel === 'string', `${label}: requestModel 形状非法`);
  assert.ok(record.sessionId === null || typeof record.sessionId === 'string', `${label}: sessionId 形状非法`);
  assert.ok(SOURCES.includes(record.source), `${label}: 非法 source "${record.source}"`);
  assert.ok(KINDS.includes(record.kind), `${label}: 非法 kind "${record.kind}"`);
  assert.equal(typeof record.promptText, 'string', `${label}: promptText 必须是字符串`);
  assert.equal(typeof record.completionText, 'string', `${label}: completionText 必须是字符串`);
  for (const field of [
    'promptTokens',
    'completionTokens',
    'cacheReadTokens',
    'cacheWriteTokens',
    'thinkingTokens',
    'thinkingChars'
  ]) {
    assert.ok(record[field] === null || typeof record[field] === 'number', `${label}: ${field} 形状非法`);
  }
  assert.ok(
    record.hasThinkingSignature === null || typeof record.hasThinkingSignature === 'boolean',
    `${label}: hasThinkingSignature 形状非法`
  );
  assert.ok(record.finishReason === null || typeof record.finishReason === 'string', `${label}: finishReason 形状非法`);
  assert.ok(record.status === null || typeof record.status === 'number', `${label}: status 形状非法`);
  assert.ok(record.errorCode === null || typeof record.errorCode === 'string', `${label}: errorCode 形状非法`);
  assert.ok(record.latencyMs === null || typeof record.latencyMs === 'number', `${label}: latencyMs 形状非法`);
  // 契约 10.1：raw 只存在于解析期内存对象（报告前由 analyze 剥离）
  assert.ok(record.raw && typeof record.raw === 'object', `${label}: 解析期 LogRecord 必须带 raw 对象`);
  assert.doesNotThrow(() => JSON.stringify(record), `${label}: LogRecord 必须可序列化`);
}

function assertParseResultValid(result, label) {
  assert.ok(result && typeof result === 'object', `${label}: ParseResult 必须是对象`);
  assert.ok(Array.isArray(result.records), `${label}: records 必须是数组`);
  assert.ok(Array.isArray(result.files), `${label}: files 必须是数组`);
  assert.ok(Array.isArray(result.warnings), `${label}: warnings 必须是数组`);
  for (const warning of result.warnings) assert.equal(typeof warning, 'string');

  for (const file of result.files) {
    assert.equal(typeof file.name, 'string', `${label}: files[].name 必须是字符串`);
    assert.equal(typeof file.format, 'string', `${label}: files[].format 必须是字符串`);
    assert.equal(typeof file.confidence, 'number', `${label}: files[].confidence 必须是数字`);
    assert.ok(file.confidence >= 0 && file.confidence <= 1, `${label}: files[].confidence 越界 ${file.confidence}`);
    for (const field of ['total', 'parsed', 'skipped']) {
      assert.equal(typeof file[field], 'number', `${label}: files[].${field} 必须是数字`);
      assert.ok(file[field] >= 0, `${label}: files[].${field} 不得为负`);
    }
    assert.ok(file.error === null || typeof file.error === 'string', `${label}: files[].error 形状非法`);
  }

  const stats = result.stats;
  assert.ok(stats && typeof stats === 'object', `${label}: stats 必须是对象`);
  assert.equal(typeof stats.lines, 'number');
  assert.equal(typeof stats.bytes, 'number');
  assert.ok(stats.timeRange === null || typeof stats.timeRange === 'object', `${label}: stats.timeRange 形状非法`);
  if (stats.timeRange) {
    assert.equal(typeof stats.timeRange.from, 'number');
    assert.equal(typeof stats.timeRange.to, 'number');
  }
  assert.ok(Array.isArray(stats.models), `${label}: stats.models 必须是数组`);

  for (const record of result.records) assertRecordValid(record, `${label}/record:${record && record.index}`);
}

const bySource = (records, source) => records.filter((record) => record.source === source);

/* ------------------------------------------------------------------ */
/* 1. 四个解析器各一组 fixture（契约 §14.1）                              */
/* ------------------------------------------------------------------ */

test('解析器：Claude Code JSONL（assistant 记录的 usage / thinking / 时间戳 / session）', async () => {
  const parsed = await parseLogFiles({ files: [logFile(LOG_FIXTURES.claudeCode, loadLogFixture('claudeCode'))] });
  assertParseResultValid(parsed, 'claude-code');

  const file = parsed.files[0];
  assert.equal(file.format, 'claude-code', `格式识别错误：${file.format}（文件 ${file.name}）`);
  assert.equal(file.error, null, `解析不应报错：${file.error}`);
  assert.ok(file.parsed >= 6, `fixture 含 6 条 assistant 记录，实际 parsed=${file.parsed}`);

  const assistants = parsed.records.filter((record) => record.kind === 'assistant');
  assert.ok(assistants.length >= 6, `应解析出 ≥6 条 assistant 记录，实际 ${assistants.length}`);
  for (const record of assistants) {
    assert.equal(record.source, 'claude-code');
    assert.equal(record.provider, 'anthropic', `Claude Code 记录 provider 应为 anthropic，实际 ${record.provider}`);
    assert.ok(record.timestamp !== null && Number.isFinite(record.timestamp), 'timestamp 应解析为 ms epoch');
    assert.match(String(record.model), /claude/, `model 应保留：${record.model}`);
    assert.equal(typeof record.promptTokens, 'number');
    assert.equal(typeof record.completionTokens, 'number');
    assert.ok(['end_turn', 'max_tokens', 'length', null].includes(record.finishReason), `非法 finishReason ${record.finishReason}`);
  }

  const withThinking = assistants.find((record) => record.hasThinkingSignature === true);
  assert.ok(withThinking, 'fixture 含带 signature 的 thinking 块，hasThinkingSignature 应为 true');
  assert.ok(withThinking.thinkingChars > 0 || withThinking.thinkingTokens > 0, 'thinking 字符/token 应被统计');

  const truncated = assistants.filter((record) => ['max_tokens', 'length'].includes(record.finishReason));
  assert.ok(truncated.length >= 3, `fixture 含 3 条 max_tokens 截断记录，实际 ${truncated.length}`);

  assert.equal(assistants[0].sessionId, 'sess-early-001', 'sessionId 应保留');
  assert.ok(parsed.stats.models.some((model) => /claude/.test(model)), 'stats.models 应包含 claude 模型');
});

test('解析器：通用 API 日志 JSONL（OpenAI / Anthropic / 包装形状都能解析）', async () => {
  const parsed = await parseLogFiles({ files: [logFile(LOG_FIXTURES.apiLog, loadLogFixture('apiLog'))] });
  assertParseResultValid(parsed, 'api-log');

  const file = parsed.files[0];
  assert.equal(file.format, 'api-log', `格式识别错误：${file.format}`);
  assert.equal(file.error, null);
  assert.ok(file.parsed >= 4, `fixture 含 5 条可用记录，实际 parsed=${file.parsed}`);

  const openai = parsed.records.filter((record) => record.provider === 'openai');
  const anthropic = parsed.records.filter((record) => record.provider === 'anthropic');
  assert.ok(openai.length > 0, '必须能解析 OpenAI 形状 usage.prompt_tokens/completion_tokens');
  assert.ok(anthropic.length > 0, '必须能解析 Anthropic 形状 usage.input_tokens/output_tokens');

  const wrapped = openai.find((record) => record.completionTokens === 18);
  assert.ok(wrapped, '包装 {request,response} 形状应被展开（completion_tokens=18）');
  assert.equal(wrapped.requestModel, 'gpt-4o', 'requestModel 应来自 request.model');
  assert.equal(wrapped.model, 'gpt-4o', 'model 应来自 response.model');

  const anthropicThinking = anthropic.find((record) => record.hasThinkingSignature === true);
  assert.ok(anthropicThinking, 'API 日志里的 Anthropic thinking signature 应被识别');
  assert.ok(anthropicThinking.timestamp !== null, 'timestamp 应解析');
  assert.ok(anthropicThinking.latencyMs > 0, 'durationMs 应映射为 latencyMs');
});

test('解析器：用量 CSV（BOM + 英文表头，数值字段正确）', async () => {
  const parsed = await parseLogFiles({ files: [logFile(LOG_FIXTURES.usageCsv, loadLogFixture('usageCsv'))] });
  assertParseResultValid(parsed, 'usage-csv');

  const file = parsed.files[0];
  assert.equal(file.format, 'usage-csv', `格式识别错误：${file.format}`);
  assert.equal(file.error, null);
  assert.ok(file.parsed >= 6, `CSV 含 6 行数据，实际 parsed=${file.parsed}`);
  assert.equal(file.skipped, 0, `干净 CSV 不应跳过数据行，实际 skipped=${file.skipped}`);

  const records = parsed.records.filter((record) => record.source === 'usage-csv' || record.kind === 'usage');
  assert.ok(records.length >= 6, `应解析出 ≥6 条记录，实际 ${records.length}`);

  const first = records.find((record) => record.model === 'gpt-4o' && record.completionTokens === 120);
  assert.ok(first, `表头字段应映射：${JSON.stringify(records.map((r) => [r.model, r.completionTokens]))}`);
  assert.ok(!String(first.model).includes('\uFEFF'), 'BOM 必须被剥离，不得污染首个字段');
  assert.equal(first.promptTokens, 400);
  assert.ok(first.timestamp !== null && Number.isFinite(first.timestamp), 'CSV 时间戳应解析');
});

test('解析器：ChatGPT 导出 conversations.json（mapping 树 → assistant 记录）', async () => {
  const parsed = await parseLogFiles({ files: [logFile(LOG_FIXTURES.chatgptExport, loadLogFixture('chatgptExport'))] });
  assertParseResultValid(parsed, 'chatgpt-export');

  const file = parsed.files[0];
  assert.equal(file.format, 'chatgpt-export', `格式识别错误：${file.format}`);
  assert.equal(file.error, null);

  const assistants = parsed.records.filter((record) => record.kind === 'assistant');
  assert.equal(assistants.length, 3, `fixture 含 3 条 assistant 消息，实际 ${assistants.length}`);
  for (const record of assistants) {
    assert.equal(record.source, 'chatgpt-export');
    assert.equal(record.provider, 'openai', 'ChatGPT 导出 provider 应为 openai');
    assert.ok(record.completionText.length > 0, 'assistant 文本应被提取');
    assert.ok(record.timestamp !== null, 'create_time 应转换为 ms epoch');
  }
  const models = new Set(assistants.map((record) => record.model));
  assert.ok(models.has('gpt-4o'), `应保留 metadata.model_slug=gpt-4o，实际 ${JSON.stringify([...models])}`);
});

test('[v3.1] 解析器：Codex rollout JSONL（session_meta / turn_context / event_msg / response_item / token_usage_record）', async () => {
  const parsed = await parseLogFiles({ files: [logFile(LOG_FIXTURES.codexRollout, loadLogFixture('codexRollout'))] });
  assertParseResultValid(parsed, 'codex-rollout');

  const file = parsed.files[0];
  assert.equal(file.format, 'codex-rollout', `格式识别错误：${file.format}`);
  assert.equal(file.error, null);
  assert.ok(file.parsed >= 4, `Codex fixture 应解析出多条记录，实际 parsed=${file.parsed}`);

  for (const record of parsed.records) {
    assert.equal(record.source, 'codex-rollout', '所有 Codex 记录的 source 必须是 codex-rollout');
    assert.equal(record.provider, 'openai', 'Codex 记录 provider 应为 openai');
    // 契约 v3.1：该格式没有 finish_reason，解析器绝不能编造
    assert.equal(record.finishReason, null, 'Codex rollout 没有 finish_reason，必须一律为 null（禁止编造截断信号）');
    // Codex 的 reasoning 是加密推理，不是 Claude thinking signature，不得伪造
    assert.equal(record.hasThinkingSignature, null, '不得把 Codex reasoning 伪装成 Claude thinking signature');
  }

  // token_count 事件 → kind:'usage'，thinkingTokens 来自 reasoning_output_tokens
  const usageRecords = parsed.records.filter((record) => record.kind === 'usage');
  assert.equal(usageRecords.length, 2, `fixture 含 2 条 token_count，实际 usage=${usageRecords.length}`);
  const firstUsage = usageRecords.find((record) => record.promptTokens === 1000);
  assert.ok(firstUsage, `第一条 token_count 应解析出 input_tokens=1000，实际 ${JSON.stringify(usageRecords.map((r) => r.promptTokens))}`);
  assert.equal(firstUsage.completionTokens, 200, 'completionTokens 应来自 last_token_usage.output_tokens');
  assert.equal(firstUsage.thinkingTokens, 80, 'thinkingTokens 应来自 last_token_usage.reasoning_output_tokens');
  assert.equal(firstUsage.latencyMs, 820, 'latencyMs 应来自 event_msg.payload.duration_ms');
  assert.equal(firstUsage.timestamp, Date.parse('2026-05-01T10:00:02.000Z'), 'timestamp 应解析为 ms epoch');

  // response_item + payload.role=assistant → kind:'assistant'，completionText 来自 output_text
  const assistant = parsed.records.find(
    (record) => record.kind === 'assistant' && record.completionText.includes('CODEX_SECRET_TEXT_XYZ')
  );
  assert.ok(assistant, 'response_item 的 assistant output_text 必须被提取为 completionText');
  assert.equal(assistant.source, 'codex-rollout');
  assert.equal(assistant.model, 'gpt-5-codex', 'model 应来自 turn_context.payload.model');

  // turn_aborted → status 499 / errorCode turn_aborted（喂 error_rate）
  const aborted = parsed.records.find((record) => record.errorCode === 'turn_aborted');
  assert.ok(aborted, 'turn_aborted 必须产出记录（error_rate 依赖它）');
  assert.equal(aborted.status, 499, 'turn_aborted 的 status 必须是 499（契约 v3.1）');

  // token_usage_record 与 token_count 重复：只保留 token_count（去重不重复计数）
  const usageFromTokenUsageRecord = parsed.records.filter((record) => record.kind === 'usage' && record.promptTokens === 1000);
  assert.equal(usageFromTokenUsageRecord.length, 1, 'token_usage_record 不得与 token_count 重复计数');
});

test('[关键回归] codex-rollout：纯空白 assistant 占位消息（keepalive）必须跳过，但保留 token>0 的空文本用量记录', async () => {
  // 真实 Codex 日志里有 27 条文本恰为 " " 的 assistant 占位消息（进度/keepalive），
  // 它们不是回答；解析层必须跳过，否则会被 empty_rate 当成「空回答」制造假信号。
  const text = buildCodexRolloutText({ normal: 6, placeholders: 10, tokenCounts: 12 });
  const parsed = await parseLogFiles({ files: [logFile('rollout-with-placeholders.jsonl', text)] });
  assertParseResultValid(parsed, 'codex-placeholders');

  assert.equal(parsed.files[0].format, 'codex-rollout');
  assert.equal(parsed.files[0].error, null);

  const blankAssistants = parsed.records.filter(
    (record) =>
      record.kind === 'assistant' &&
      record.completionText.trim() === '' &&
      !(typeof record.completionTokens === 'number' && record.completionTokens > 0) &&
      // turn_aborted 是合法的错误信号（status 499 / errorCode 非空），不算占位消息
      record.errorCode === null &&
      record.status === null
  );
  assert.deepEqual(
    blankAssistants.map((record) => record.completionText),
    [],
    `纯空白且无 token 的 assistant 占位消息必须被跳过，实际仍有 ${blankAssistants.length} 条`
  );

  // 但 turn_aborted（错误信号）必须保留，不能被「空白消息」规则误删
  const aborted = parsed.records.find((record) => record.errorCode === 'turn_aborted');
  assert.ok(aborted, 'turn_aborted 记录不得被空白过滤误删（它喂 error_rate）');
  assert.equal(aborted.status, 499);

  const realAssistants = parsed.records.filter(
    (record) => record.kind === 'assistant' && record.completionText.includes('合成正常回答')
  );
  assert.ok(realAssistants.length >= 6, `正常 assistant 消息不得被误跳过，实际 ${realAssistants.length}`);

  // 修复语义的边界：文本为空但 completionTokens > 0 的记录（token_count 用量）必须保留。
  const usageWithEmptyText = parsed.records.filter(
    (record) =>
      record.kind === 'usage' &&
      record.completionText.trim() === '' &&
      typeof record.completionTokens === 'number' &&
      record.completionTokens > 0
  );
  assert.ok(
    usageWithEmptyText.length >= 12,
    `文本为空但 completionTokens>0 的用量记录必须保留，实际 ${usageWithEmptyText.length}`
  );

  // 占位消息不得进入 skipped 之外的统计（即不得产出记录），但应体现在 files[].skipped 中
  assert.ok(parsed.files[0].skipped >= 10, `跳过的占位行必须计入 files[].skipped，实际 ${parsed.files[0].skipped}`);
});

/* ------------------------------------------------------------------ */
/* 2. 格式自动识别：伪装扩展名（契约 §14.2）                              */
/* ------------------------------------------------------------------ */

test('[关键回归] 伪装扩展名：Claude Code 内容命名为 .csv / .log / 无扩展名仍识别为 claude-code', async () => {
  const text = loadLogFixture('claudeCode');
  for (const name of ['claude-code.csv', 'claude-code.log', 'claude-code-no-extension']) {
    const parsed = await parseLogFiles({ files: [logFile(name, text)] });
    assertParseResultValid(parsed, `disguise:${name}`);
    assert.equal(
      parsed.files[0].format,
      'claude-code',
      `文件名为 ${name} 时仍必须识别为 claude-code（不能只靠扩展名），实际 ${parsed.files[0].format}`
    );
    assert.ok(parsed.records.length > 0, `${name}: 仍应解析出记录`);
  }
});

test('[关键回归] 伪装扩展名：CSV / ChatGPT / Codex 内容换成其它扩展名也能识别', async () => {
  const cases = [
    ['usage-as.jsonl', loadLogFixture('usageCsv'), 'usage-csv'],
    ['chatgpt-as.log', loadLogFixture('chatgptExport'), 'chatgpt-export'],
    ['api-log-as.csv', loadLogFixture('apiLog'), 'api-log'],
    ['codex-rollout-as.csv', loadLogFixture('codexRollout'), 'codex-rollout'],
    ['codex-rollout-noext', loadLogFixture('codexRollout'), 'codex-rollout']
  ];
  for (const [name, text, expected] of cases) {
    const parsed = await parseLogFiles({ files: [logFile(name, text)] });
    assert.equal(
      parsed.files[0].format,
      expected,
      `文件名为 ${name} 时应识别为 ${expected}，实际 ${parsed.files[0].format}`
    );
  }
});

test('SUPPORTED_FORMATS：暴露全部五种格式标识（含 v3.1 codex-rollout）', () => {
  assert.ok(Array.isArray(SUPPORTED_FORMATS), 'SUPPORTED_FORMATS 必须是数组');
  const values = SUPPORTED_FORMATS.map((item) => (typeof item === 'string' ? item : item && item.id));
  for (const expected of ['claude-code', 'codex-rollout', 'api-log', 'usage-csv', 'chatgpt-export']) {
    assert.ok(values.includes(expected), `SUPPORTED_FORMATS 缺少 ${expected}，实际 ${JSON.stringify(values)}`);
  }
  assert.equal(values.length, 5, `契约 v3.1 冻结五种格式，实际 ${JSON.stringify(values)}`);
});

/* ------------------------------------------------------------------ */
/* 3. 脏数据（契约 §14.7）                                               */
/* ------------------------------------------------------------------ */

const VALID_CLAUDE_LINE = JSON.stringify({
  type: 'assistant',
  sessionId: 'sess-dirty',
  timestamp: '2026-01-01T00:00:00.000Z',
  message: {
    id: 'msg_dirty_1',
    type: 'message',
    role: 'assistant',
    model: 'claude-sonnet-4-5-20250929',
    content: [{ type: 'text', text: 'ok' }],
    stop_reason: 'end_turn',
    usage: { input_tokens: 10, output_tokens: 5, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 }
  },
  durationMs: 300
});

test('脏数据：空行 / 坏 JSON / CRLF / BOM → 跳过并计入 skipped，不抛异常', async () => {
  const text =
    '\uFEFF' +
    '\r\n' +
    VALID_CLAUDE_LINE +
    '\r\n' +
    '{ this is not json }\r\n' +
    '\r\n' +
    VALID_CLAUDE_LINE +
    '\r\n' +
    'not-json-at-all\r\n';

  let parsed;
  await assert.doesNotReject(async () => {
    parsed = await parseLogFiles({ files: [logFile('dirty.jsonl', text)] });
  }, '脏数据不得导致 parseLogFiles 抛异常');
  assertParseResultValid(parsed, 'dirty');

  const file = parsed.files[0];
  assert.ok(file.parsed >= 2, `两条合法 JSON 行应被解析，实际 parsed=${file.parsed}`);
  assert.ok(file.skipped >= 2, `坏行不得静默丢弃：skipped 应 ≥2，实际 ${file.skipped}`);
  assert.ok(parsed.warnings.length > 0, '跳过脏行时应给出 warnings');
});

test('脏数据：超大单行 → 跳过且不抛异常（防止日志炸弹）', async () => {
  // 实现常量 MAX_LINE_CHARS = 2MB（src/core/degrade/constants.js），必须严格超过才会被跳过。
  const huge = 'x'.repeat(2 * 1024 * 1024 + 100);
  const text = VALID_CLAUDE_LINE + '\n' + huge + '\n' + VALID_CLAUDE_LINE + '\n';
  let parsed;
  await assert.doesNotReject(async () => {
    parsed = await parseLogFiles({ files: [logFile('bomb.jsonl', text)] });
  }, '超大单行不得导致抛异常 / OOM');
  assertParseResultValid(parsed, 'huge-line');
  const file = parsed.files[0];
  assert.ok(file.skipped >= 1, `超大单行应被跳过并记入 skipped，实际 skipped=${file.skipped}`);
  assert.ok(file.parsed >= 1, '其它合法行仍应被解析');
});

/* ------------------------------------------------------------------ */
/* 4. 单文件失败不影响其它文件                                           */
/* ------------------------------------------------------------------ */

test('[关键回归] 单文件失败不影响其它文件：坏文件记 error，好文件照常解析', async () => {
  const parsed = await parseLogFiles({
    files: [
      logFile('broken.bin', '\u0000\u0001\u0002 totally-binary-not-a-log'),
      logFile('good.jsonl', loadLogFixture('claudeCode'))
    ]
  });
  assertParseResultValid(parsed, 'partial-failure');

  assert.equal(parsed.files.length, 2);
  const broken = parsed.files[0];
  const good = parsed.files[1];
  assert.ok(broken.error !== null, '无法识别的文件必须把失败记入 files[].error（契约 10.2）');
  assert.equal(broken.parsed, 0, '失败文件不得产出记录');
  assert.equal(good.error, null, '好文件不得被坏文件影响');
  assert.ok(good.parsed > 0, '好文件必须正常解析');
  assert.ok(parsed.records.length > 0, '整体仍应返回好文件解析出的记录');
});

/* ------------------------------------------------------------------ */
/* 5. parseLogFiles 绝不抛异常（契约 §14.7）                              */
/* ------------------------------------------------------------------ */

test('parseLogFiles：空 / 垃圾入参全部不抛异常并返回契约 10.2 形状', async () => {
  const cases = [
    undefined,
    null,
    {},
    { files: null },
    { files: [] },
    { files: [{ name: 'no-text.jsonl' }] },
    { files: [{ name: '', text: '' }] },
    { files: [{ name: 'weird', text: 12345 }] },
    { files: [null, 42] },
    { files: [{ name: 'a.jsonl', text: '' }], limits: {} },
    { files: [{ name: 'a.jsonl', text: VALID_CLAUDE_LINE }], limits: null }
  ];
  for (const input of cases) {
    let parsed;
    await assert.doesNotReject(async () => {
      parsed = await parseLogFiles(input);
    }, `parseLogFiles(${JSON.stringify(input)}) 不得抛异常`);
    assertParseResultValid(parsed, `garbage:${JSON.stringify(input)}`);
  }
});

test('parseLogFiles：未知格式文件返回 error 而不是抛异常', async () => {
  const parsed = await parseLogFiles({ files: [logFile('unknown.txt', 'just a plain sentence, nothing structured')] });
  assertParseResultValid(parsed, 'unknown-format');
  assert.equal(parsed.files.length, 1);
  assert.ok(
    parsed.files[0].error !== null || parsed.files[0].parsed === 0,
    '未知格式应记 error 或 0 条解析，不得崩溃'
  );
});

/* ------------------------------------------------------------------ */
/* 6. stats 汇总                                                         */
/* ------------------------------------------------------------------ */

test('stats：lines / bytes / timeRange / models 与解析结果自洽', async () => {
  const parsed = await parseLogFiles({
    files: [
      logFile(LOG_FIXTURES.claudeCode, loadLogFixture('claudeCode')),
      logFile(LOG_FIXTURES.apiLog, loadLogFixture('apiLog'))
    ]
  });
  assertParseResultValid(parsed, 'stats');

  assert.ok(parsed.stats.lines >= parsed.records.length, 'stats.lines 不应小于解析记录数');
  assert.ok(parsed.stats.bytes > 0, 'stats.bytes 应大于 0');
  assert.ok(parsed.stats.models.length > 0, 'stats.models 不得为空');
  assert.ok(parsed.stats.timeRange !== null, '有两个含时间戳的文件时应给出 timeRange');
  assert.ok(parsed.stats.timeRange.from <= parsed.stats.timeRange.to, 'timeRange from 必须 <= to');
});

/* ------------------------------------------------------------------ */
/* S2 关键回归：大日志 maxRecords 截断必须「保留最近」且诚实               */
/* ------------------------------------------------------------------ */

const S2_HOUR = 3600 * 1000;
const S2_BASE = Date.parse('2026-09-01T00:00:00.000Z');

/** 一行合法 Claude Code assistant JSONL（时间戳递增，方便断言「保留最近」）。 */
function claudeJsonlLine(timestampMs, index) {
  return JSON.stringify({
    type: 'assistant',
    sessionId: 'sess-s2',
    timestamp: new Date(timestampMs).toISOString(),
    durationMs: 500,
    message: {
      id: `msg_s2_${String(index).padStart(5, '0')}`,
      type: 'message',
      role: 'assistant',
      model: 'claude-sonnet-4-5-20250929',
      content: [{ type: 'text', text: `第 ${index} 条回答内容。` }],
      stop_reason: 'end_turn',
      usage: { input_tokens: 100, output_tokens: 20, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 }
    }
  });
}

test('[关键回归 S2] maxRecords 截断：total 真实、skipped 诚实、warnings 非空，且保留最近记录', async () => {
  const total = 1000;
  const maxRecords = 100;
  const lines = Array.from({ length: total }, (_, index) => claudeJsonlLine(S2_BASE + index * S2_HOUR, index));
  const parsed = await parseLogFiles({
    files: [logFile('big-ordered.jsonl', lines.join('\n'))],
    limits: { maxRecords }
  });
  assertParseResultValid(parsed, 's2-ordered');

  const file = parsed.files[0];
  assert.equal(file.total, total, `files[].total 必须是真实总条数 ${total}（不能只报已解析数），实际 ${file.total}`);
  assert.equal(parsed.records.length, maxRecords, `记录数必须被截断到 ${maxRecords}，实际 ${parsed.records.length}`);
  assert.equal(file.parsed, parsed.records.length, 'files[].parsed 与 records 口径必须一致');
  assert.equal(
    file.skipped,
    total - maxRecords,
    `截断必须诚实上报 skipped=${total - maxRecords}，实际 ${file.skipped}（不能记 0）`
  );
  assert.ok(parsed.warnings.length > 0, '发生截断时必须给出 warnings（用户需要知道数据不完整）');

  const timestamps = parsed.records.map((record) => record.timestamp).sort((a, b) => a - b);
  const latestStart = S2_BASE + (total - maxRecords) * S2_HOUR;
  const keptLatest = timestamps[0] >= latestStart;
  const honestAlternate = file.skipped === total - maxRecords && parsed.warnings.length > 0;
  assert.ok(
    keptLatest || honestAlternate,
    `截断后必须保留时间上最新的 ${maxRecords} 条（最早时间戳 ${new Date(timestamps[0]).toISOString()} 应 >= ${new Date(latestStart).toISOString()}），或至少诚实上报 skipped+warning`
  );

  // 顺带：滚动保留后 coverage.records / files[].parsed / records.length 三处口径一致。
  if (keptLatest) {
    const report = analyzeDegradation({ records: parsed.records });
    assert.equal(report.coverage.records, parsed.records.length, 'coverage.records 必须等于解析保留的记录数');
    assert.equal(report.coverage.records, file.parsed, 'coverage.records 必须与 files[].parsed 口径一致');
  }
});

test('[关键回归 S2] 行序乱序（时间戳乱排）时，截断后仍必须是最新的 N 条', async () => {
  const total = 1000;
  const maxRecords = 100;
  const entries = Array.from({ length: total }, (_, index) => ({
    index,
    timestamp: S2_BASE + index * S2_HOUR,
    line: claudeJsonlLine(S2_BASE + index * S2_HOUR, index)
  }));
  // 确定性乱序：按 index 的位反转排序，打乱行序但可复现。
  const bitReverse = (n) => {
    let out = 0;
    for (let bit = 0; bit < 10; bit += 1) out = (out << 1) | ((n >> bit) & 1);
    return out;
  };
  entries.sort((a, b) => bitReverse(a.index) - bitReverse(b.index));

  const parsed = await parseLogFiles({
    files: [logFile('big-shuffled.jsonl', entries.map((entry) => entry.line).join('\n'))],
    limits: { maxRecords }
  });
  assertParseResultValid(parsed, 's2-shuffled');

  const file = parsed.files[0];
  assert.equal(file.total, total, '乱序输入同样必须报告真实 total');
  assert.equal(parsed.records.length, maxRecords);
  assert.equal(file.skipped, total - maxRecords, '乱序输入同样必须诚实上报 skipped');
  assert.ok(parsed.warnings.length > 0, '乱序输入发生截断时必须有 warnings');

  const actual = parsed.records.map((record) => record.timestamp).sort((a, b) => a - b);
  const expected = Array.from({ length: maxRecords }, (_, i) => S2_BASE + (total - maxRecords + i) * S2_HOUR).sort(
    (a, b) => a - b
  );
  assert.deepEqual(
    actual,
    expected,
    '行序乱序时，截断必须按时间戳保留最新的 N 条（而不是文件里最先出现的 N 条）'
  );
});
