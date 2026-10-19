/**
 * v3 降智诊断：分析端到端回归（契约 §9–§12 / §14.3–14.8）。
 *
 * 全部离线：直接构造契约 §10.1 LogRecord（合成日志），不读真实用户日志。
 *
 * 覆盖：
 *  - 退化场景：早期正常 + 近期截断率 24% / 输出变短 / thinking 消失
 *    → verdict === 'likely-degraded'，findings 含 truncation_spike 与 thinking_collapse
 *  - 稳定场景 → verdict === 'stable'，无 critical
 *  - 样本不足（5 条）→ insufficient，**绝不能**是 stable / 退化 0 分
 *  - critical 一票：只有 model_substitution critical 也应 likely-degraded
 *  - 隐私：报告序列化后不含日志原文标记串 / 文件名 / raw 字段
 *  - 空输入 / 垃圾输入 → insufficient 且不抛异常
 *  - 时间戳 null 记录：计入 coverage，不参与时间切分
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import { analyzeDegradation, parseLogFiles } from '../src/core/degrade/index.js';
import {
  DAY,
  HOUR,
  assertNoFieldDeep,
  assertNotStringified,
  buildCodexRolloutText,
  concatRecords,
  loadLogFixture,
  logFile,
  makeRecord,
  makeRecords
} from './helpers/degrade-fixtures.mjs';

/* ------------------------------------------------------------------ */
/* 契约形状校验                                                          */
/* ------------------------------------------------------------------ */

const VERDICTS = ['stable', 'suspicious', 'likely-degraded', 'insufficient'];
const SUMMARY_TEXT = {
  stable: '未见系统性退化',
  suspicious: '存在可疑变化',
  'likely-degraded': '多项指标一致退化',
  insufficient: '样本不足，无法判断'
};
const METRIC_STATUSES = ['ok', 'insufficient'];
const DIRECTIONS = ['worse', 'better', 'flat'];
const SEVERITIES = ['info', 'warning', 'critical'];

function assertMetricValid(metric, label) {
  assert.ok(metric && typeof metric === 'object', `${label}: MetricResult 必须是对象`);
  assert.equal(typeof metric.id, 'string', `${label}: metric.id 必须是字符串`);
  assert.ok(metric.id.length > 0, `${label}: metric.id 不得为空`);
  assert.equal(typeof metric.label, 'string', `${label}: metric.label 必须是字符串`);
  assert.ok(['%', 'ms', 'tok', 'ratio'].includes(metric.unit), `${label}: 非法 unit "${metric.unit}"`);
  assert.ok(METRIC_STATUSES.includes(metric.status), `${label}: 非法 status "${metric.status}"`);
  assert.ok(metric.early === null || typeof metric.early === 'number', `${label}: early 必须是 null 或数字`);
  assert.ok(metric.recent === null || typeof metric.recent === 'number', `${label}: recent 必须是 null 或数字`);
  assert.ok(metric.deltaPct === null || typeof metric.deltaPct === 'number', `${label}: deltaPct 必须是 null 或数字`);
  assert.ok(DIRECTIONS.includes(metric.direction), `${label}: 非法 direction "${metric.direction}"`);
  assert.ok(metric.samples && typeof metric.samples === 'object', `${label}: samples 必须是对象`);
  assert.equal(typeof metric.samples.early, 'number');
  assert.equal(typeof metric.samples.recent, 'number');
  assert.ok(Array.isArray(metric.series), `${label}: series 必须是数组`);
  assert.ok(metric.series.length <= 500, `${label}: series 必须降采样到 ≤500 点（契约 10.4），实际 ${metric.series.length}`);
  for (const point of metric.series) {
    assert.ok(point && typeof point === 'object', `${label}: series 点必须是对象`);
    assert.ok(point.t === null || typeof point.t === 'number', `${label}: series[].t 必须是 null 或数字`);
    assert.equal(typeof point.v, 'number', `${label}: series[].v 必须是数字`);
  }
  assert.equal(typeof metric.definition, 'string', `${label}: definition 必须是字符串`);
  assert.ok(metric.definition.length > 0, `${label}: definition 不得为空`);
}

function assertFindingValid(finding, label) {
  assert.ok(finding && typeof finding === 'object', `${label}: Finding 必须是对象`);
  assert.equal(typeof finding.id, 'string', `${label}: finding.id 必须是字符串`);
  assert.ok(SEVERITIES.includes(finding.severity), `${label}: 非法 severity "${finding.severity}"`);
  assert.equal(typeof finding.metric, 'string', `${label}: finding.metric 必须是字符串`);
  assert.equal(typeof finding.title, 'string', `${label}: finding.title 必须是字符串`);
  assert.equal(typeof finding.detail, 'string', `${label}: finding.detail 必须是字符串`);
  assert.ok(finding.evidence !== undefined && finding.evidence !== null, `${label}: finding 必须有 evidence`);
  assert.doesNotThrow(() => JSON.stringify(finding), `${label}: Finding 必须可序列化`);
  assert.equal(typeof finding.suggestion, 'string', `${label}: finding.suggestion 必须是字符串`);
}

function assertReportValid(report, label) {
  assert.ok(report && typeof report === 'object', `${label}: DegradationReport 必须是对象`);
  assert.equal(report.schema, 1, `${label}: schema 必须为 1`);
  assert.ok(VERDICTS.includes(report.verdict), `${label}: 非法 verdict "${report.verdict}"`);
  assert.equal(typeof report.score, 'number', `${label}: score 必须是数字`);
  assert.ok(report.score >= 0 && report.score <= 100, `${label}: score 越界 ${report.score}`);
  assert.equal(typeof report.evidenceStrength, 'number', `${label}: evidenceStrength 必须是数字`);
  assert.ok(report.evidenceStrength >= 0 && report.evidenceStrength <= 1, `${label}: evidenceStrength 越界`);
  assert.equal(typeof report.summaryText, 'string', `${label}: summaryText 必须是字符串`);
  if (SUMMARY_TEXT[report.verdict]) {
    assert.equal(report.summaryText, SUMMARY_TEXT[report.verdict], `${label}: summaryText 与 verdict 不匹配`);
  }

  const segments = report.segments;
  assert.ok(segments && typeof segments === 'object', `${label}: segments 必须是对象`);
  for (const name of ['early', 'recent']) {
    const seg = segments[name];
    assert.ok(seg && typeof seg === 'object', `${label}: segments.${name} 必须是对象`);
    assert.equal(typeof seg.count, 'number', `${label}: segments.${name}.count 必须是数字`);
    assert.ok(seg.from === null || typeof seg.from === 'number', `${label}: segments.${name}.from 形状非法`);
    assert.ok(seg.to === null || typeof seg.to === 'number', `${label}: segments.${name}.to 形状非法`);
  }
  assert.ok(segments.splitAt === null || typeof segments.splitAt === 'number', `${label}: segments.splitAt 形状非法`);

  assert.ok(Array.isArray(report.metrics), `${label}: metrics 必须是数组`);
  const metricIds = new Set();
  for (const metric of report.metrics) {
    assertMetricValid(metric, `${label}/metric:${metric && metric.id}`);
    assert.ok(!metricIds.has(metric.id), `${label}: metric id 重复 "${metric.id}"`);
    metricIds.add(metric.id);
  }

  assert.ok(Array.isArray(report.findings), `${label}: findings 必须是数组`);
  for (const finding of report.findings) assertFindingValid(finding, `${label}/finding:${finding && finding.id}`);

  assert.ok(Array.isArray(report.criticalIssues), `${label}: criticalIssues 必须是数组`);
  const criticalFromFindings = report.findings.filter((finding) => finding.severity === 'critical');
  assert.deepEqual(
    report.criticalIssues.map((finding) => finding.id),
    criticalFromFindings.map((finding) => finding.id),
    `${label}: criticalIssues 必须恰好是 findings 中 severity=critical 的子集`
  );

  const coverage = report.coverage;
  assert.ok(coverage && typeof coverage === 'object', `${label}: coverage 必须是对象`);
  assert.equal(typeof coverage.records, 'number', `${label}: coverage.records 必须是数字`);
  assert.equal(typeof coverage.usable, 'number', `${label}: coverage.usable 必须是数字`);
  assert.ok(coverage.bySource && typeof coverage.bySource === 'object', `${label}: coverage.bySource 必须是对象`);
  assert.ok(coverage.byModel && typeof coverage.byModel === 'object', `${label}: coverage.byModel 必须是对象`);
  assert.equal(typeof coverage.spanDays, 'number', `${label}: coverage.spanDays 必须是数字`);

  assert.ok(Array.isArray(report.notes), `${label}: notes 必须是数组`);
  for (const note of report.notes) assert.equal(typeof note, 'string');
  assert.equal(typeof report.startedAt, 'number');
  assert.equal(typeof report.finishedAt, 'number');
  assert.ok(report.finishedAt >= report.startedAt);

  // 隐私红线（契约 §9.2 / §10.3）：报告里不得有 raw 字段
  assertNoFieldDeep(report, 'raw', label);

  // S1 关键回归：verdict 必须能用**舍入后**的 report.score 按契约 §12 顺序复算出来。
  assertVerdictConsistent(report, label);
}

/**
 * 用 report 自身的字段按契约 §12 的判定顺序重算 verdict：
 * 可用指标数 <3 / 可用记录 <minRecords → insufficient；critical → likely-degraded；
 * evidence <0.35 → insufficient；score>=60 → likely-degraded；>=30 → suspicious；否则 stable。
 * 注意这里只用报告里**舍入后的 score**，因此能抓住「先按未舍入分数判、再舍入输出」的不自洽。
 */
function assertVerdictConsistent(report, label) {
  const usableMetrics = report.metrics.filter((metric) => metric.status === 'ok').length;
  let expected;
  if (usableMetrics < 3 || report.coverage.usable < 20) expected = 'insufficient';
  else if (report.criticalIssues.length > 0) expected = 'likely-degraded';
  else if (report.evidenceStrength < 0.35) expected = 'insufficient';
  else if (report.score >= 60) expected = 'likely-degraded';
  else if (report.score >= 30) expected = 'suspicious';
  else expected = 'stable';
  assert.equal(
    report.verdict,
    expected,
    `${label}: verdict「${report.verdict}」必须等于用舍入后 score=${report.score} 按契约 §12 重判的「${expected}」（S1：先舍入再判定）`
  );
}

/* ------------------------------------------------------------------ */
/* 合成日志构造                                                          */
/* ------------------------------------------------------------------ */

const BASE = Date.parse('2026-04-01T00:00:00.000Z');

/** 早期正常记录（Anthropic 形状，带 thinking 签名、正常输出）。 */
function earlyRecord(index, overrides = {}) {
  return makeRecord({
    index,
    timestamp: BASE + index * HOUR,
    provider: 'anthropic',
    source: 'api-log',
    model: 'claude-sonnet-4-5',
    requestModel: 'claude-sonnet-4-5',
    sessionId: `sess-early-${index % 3}`,
    completionText: '正常回答内容'.repeat(40),
    promptText: '请解释这个问题',
    promptTokens: 400,
    completionTokens: 120,
    thinkingTokens: 60,
    thinkingChars: 300,
    hasThinkingSignature: true,
    finishReason: 'end_turn',
    status: 200,
    latencyMs: 900,
    cacheReadTokens: 0,
    ...overrides
  });
}

/** 近期退化记录：截断 25%（>15% 且较早期翻 5 倍）、输出变短、thinking 消失。 */
function recentRecord(index, overrides = {}) {
  return makeRecord({
    index,
    timestamp: BASE + 48 * HOUR + index * HOUR,
    provider: 'anthropic',
    source: 'api-log',
    model: 'claude-sonnet-4-5',
    requestModel: 'claude-sonnet-4-5',
    sessionId: `sess-late-${index % 3}`,
    completionText: '短答'.repeat(5),
    promptText: '请解释这个问题',
    promptTokens: 700,
    completionTokens: 12,
    thinkingTokens: 0,
    thinkingChars: 0,
    hasThinkingSignature: false,
    finishReason: index < 10 ? 'max_tokens' : 'end_turn',
    status: 200,
    latencyMs: 2600,
    cacheReadTokens: 0,
    ...overrides
  });
}

/** 退化场景：40 条早期正常 + 40 条近期退化（早期截断 1 条 = 2.5%，近期 10 条 = 25%）。 */
function degradedRecords() {
  return concatRecords(
    makeRecords(40, (index) => earlyRecord(index, { finishReason: index === 0 ? 'length' : 'end_turn' })),
    makeRecords(
      40,
      (index) => recentRecord(index, { finishReason: index < 10 ? 'max_tokens' : 'end_turn' }),
      { start: BASE + 48 * HOUR, stepMs: HOUR }
    )
  );
}

/** 稳定场景：100 条前后完全一致（v3.1 公式：100 条 + ≥5 可用指标即可过 0.35 证据闸门）。 */
function stableRecords(count = 100) {
  return makeRecords(count, (index) =>
    makeRecord({
      index,
      timestamp: BASE + index * HOUR,
      provider: 'anthropic',
      source: 'api-log',
      model: 'claude-sonnet-4-5',
      requestModel: 'claude-sonnet-4-5',
      sessionId: `sess-stable-${index % 5}`,
      completionText: `稳定回答 #${index}：` + '内容'.repeat(60),
      promptText: '请解释这个问题',
      promptTokens: 400,
      completionTokens: 120,
      thinkingTokens: 60,
      thinkingChars: 300,
      hasThinkingSignature: true,
      finishReason: 'end_turn',
      status: 200,
      latencyMs: 900,
      cacheReadTokens: 0
    })
  );
}

/* ------------------------------------------------------------------ */
/* 1. 退化场景（契约 §14.3）                                             */
/* ------------------------------------------------------------------ */

test('[关键回归] 退化场景：截断率 24% + 输出变短 + thinking 消失 → likely-degraded', () => {
  const records = degradedRecords();
  // 契约允许 options.segment='early-recent'（§10.3）：构造的合成日志前后期各 40 条，
  // 显式指定切分以保证本回归用例稳定（auto 变化点探测另有专门用例覆盖）。
  const report = analyzeDegradation({ records, options: { segment: 'early-recent' } });
  assertReportValid(report, 'degraded');

  assert.equal(report.verdict, 'likely-degraded', `期望 likely-degraded，实际 ${report.verdict}（score=${report.score}）`);
  assert.equal(report.summaryText, '多项指标一致退化');
  assert.ok(report.criticalIssues.length > 0, '退化场景必须至少有一条 critical');

  const truncation = report.findings.find((finding) => finding.id === 'truncation_spike');
  assert.ok(truncation, `findings 必须含 truncation_spike，实际 ${JSON.stringify(report.findings.map((f) => f.id))}`);
  assert.equal(truncation.severity, 'critical', 'truncation_spike 必须是 critical（契约 §11）');
  assert.equal(truncation.metric, 'truncation_rate');
  assert.equal(typeof truncation.suggestion, 'string');
  assert.ok(truncation.suggestion.length > 0);

  const thinking = report.findings.find((finding) => finding.id === 'thinking_collapse');
  assert.ok(thinking, `findings 必须含 thinking_collapse，实际 ${JSON.stringify(report.findings.map((f) => f.id))}`);
  assert.equal(thinking.severity, 'critical', 'thinking_collapse 必须是 critical（契约 §11）');
  assert.equal(thinking.metric, 'thinking_presence');

  // 截断率指标本身：近期应明显高于早期
  const truncationMetric = report.metrics.find((metric) => metric.id === 'truncation_rate');
  assert.ok(truncationMetric, 'metrics 必须含 truncation_rate');
  assert.equal(truncationMetric.status, 'ok');
  assert.ok(truncationMetric.recent > truncationMetric.early, '近期截断率必须高于早期');
  assert.equal(truncationMetric.direction, 'worse', '截断率上升方向是 worse');
  assert.equal(truncationMetric.early, 0.025);
  assert.equal(truncationMetric.recent, 0.25);
});

test('[关键回归] 退化场景（默认 auto 变化点探测）→ 同样必须 likely-degraded + 两条 critical', () => {
  const records = degradedRecords();
  const report = analyzeDegradation({ records });
  assertReportValid(report, 'degraded-auto');
  assert.notEqual(report.verdict, 'stable', '明显退化绝不能被判成 stable（默认 auto 切分下）');
  assert.equal(
    report.verdict,
    'likely-degraded',
    `默认 auto 切分下退化场景必须 likely-degraded，实际 ${report.verdict}（score=${report.score}，segments=${JSON.stringify(report.segments)}）`
  );
  assert.ok(report.segments.splitAt !== null, '存在明显阶跃时必须探测到变化点（splitAt 非 null）');
  assert.ok(
    report.notes.some((note) => note.includes('变化点')),
    `应提示使用了变化点探测，实际 ${JSON.stringify(report.notes)}`
  );
  const ids = report.findings.map((finding) => finding.id);
  assert.ok(ids.includes('truncation_spike'), `默认切分下 findings 必须含 truncation_spike，实际 ${JSON.stringify(ids)}`);
  assert.ok(ids.includes('thinking_collapse'), `默认切分下 findings 必须含 thinking_collapse，实际 ${JSON.stringify(ids)}`);
});

test('[关键回归] 默认 auto 切分下的截断/thinking 指标必须反映退化方向（防切分稀释）', () => {
  const records = degradedRecords();
  const report = analyzeDegradation({ records });
  const truncation = report.metrics.find((metric) => metric.id === 'truncation_rate');
  const thinking = report.metrics.find((metric) => metric.id === 'thinking_presence');
  assert.ok(truncation.recent > truncation.early, '默认切分下近期截断率仍必须高于早期');
  assert.equal(truncation.direction, 'worse');
  assert.ok(thinking.recent < thinking.early, '默认切分下 thinking 出现率必须下降');
  assert.equal(thinking.direction, 'worse');
  assert.ok(report.score >= 30, `明显退化时 score 应至少达到 suspicious 阈值，实际 ${report.score}`);
});

/* ------------------------------------------------------------------ */
/* 2. 稳定场景（契约 §14.4）                                             */
/* ------------------------------------------------------------------ */

test('[关键回归] 稳定场景：100 条可用记录 + ≥5 可用指标 → 能出结论（stable，不是 insufficient）', () => {
  const records = stableRecords(100);
  const report = analyzeDegradation({ records });
  assertReportValid(report, 'stable');

  // 契约 v3.1 §12：usable = 参与分析的记录数（assistant / usage），100 条全部 assistant。
  assert.equal(report.coverage.usable, 100, `coverage.usable 应为 100，实际 ${report.coverage.usable}`);
  const usableMetrics = report.metrics.filter((metric) => metric.status === 'ok');
  assert.ok(usableMetrics.length >= 5, `100 条记录应至少有 5 个可用指标，实际 ${usableMetrics.length}`);
  // evidence = saturate(可用指标/4) × saturate(usable/50) ≥ 0.35
  assert.ok(
    report.evidenceStrength >= 0.35,
    `100 条可用记录 + ${usableMetrics.length} 个可用指标时证据强度必须过闸（≥0.35），实际 ${report.evidenceStrength}`
  );
  assert.notEqual(report.verdict, 'insufficient', '100 条可用记录 + ≥5 指标不得判样本不足（v3.1 修正的核心）');
  assert.equal(report.verdict, 'stable', `期望 stable，实际 ${report.verdict}（score=${report.score}）`);
  assert.equal(report.summaryText, '未见系统性退化');
  assert.deepEqual(report.criticalIssues, [], '稳定场景不得有 critical');
  assert.ok(report.score < 5, `稳定场景 score 应接近 0，实际 ${report.score}`);
});

test('证据闸门：30 条记录 + 多指标仍 insufficient（v3.1 公式下 0.287 < 0.35）', () => {
  const report = analyzeDegradation({ records: stableRecords(30) });
  assertReportValid(report, 'evidence-gate-30');
  assert.equal(report.coverage.usable, 30);
  assert.ok(report.evidenceStrength < 0.35, `30 条记录证据强度应 <0.35，实际 ${report.evidenceStrength}`);
  assert.equal(report.verdict, 'insufficient', '证据不足必须 insufficient，不得判 stable');
});

test('默认 minSpanMs=0：单次会话（<1 小时跨度）也能出结论，notes 提示时间跨度短', () => {
  // 100 条记录集中在 50 分钟内（30 秒一条）→ 跨度 < 6h。
  const records = makeRecords(
    100,
    (index) => earlyRecord(index, { timestamp: BASE + index * 30 * 1000 }),
    { start: BASE, stepMs: 30 * 1000 }
  );
  const report = analyzeDegradation({ records });
  assertReportValid(report, 'short-span');
  assert.notEqual(report.verdict, 'insufficient', 'minSpanMs 默认 0：短跨度单次会话不得因跨度被卡成 insufficient');
  assert.equal(report.verdict, 'stable');
  assert.ok(
    report.notes.some((note) => note.includes('时间跨度') || note.includes('跨度')),
    `跨度 < 6h 时 notes 必须提示置信度低，实际 ${JSON.stringify(report.notes)}`
  );
});

/* ------------------------------------------------------------------ */
/* 3. 样本不足（契约 §14.5）——最关键的一条                               */
/* ------------------------------------------------------------------ */

test('[关键回归] 样本不足（5 条）→ insufficient，绝不能是 stable 或「退化 0 分」', () => {
  const records = makeRecords(5, (index) => earlyRecord(index));
  const report = analyzeDegradation({ records });
  assertReportValid(report, 'insufficient-5');
  assert.equal(
    report.verdict,
    'insufficient',
    `5 条记录必须判 insufficient，绝不能判 stable（实际 ${report.verdict}, score=${report.score}）`
  );
  assert.equal(report.summaryText, '样本不足，无法判断');
  assert.ok(report.evidenceStrength < 0.35, `样本不足时 evidenceStrength 必须 < 0.35，实际 ${report.evidenceStrength}`);
  assert.ok(
    report.score < 30,
    `样本不足时 score 不得被当成「退化」展示（<30），实际 ${report.score}`
  );
  assert.ok(report.segments.early.count + report.segments.recent.count > 0, '仍需展示已解析的样本量');
});

test('样本不足：只有 1 条 / 0 条记录也必须 insufficient 且不抛异常', () => {
  for (const records of [[], makeRecords(1, (index) => earlyRecord(index))]) {
    const report = analyzeDegradation({ records });
    assertReportValid(report, `insufficient-${records.length}`);
    assert.equal(report.verdict, 'insufficient', `${records.length} 条记录必须 insufficient`);
  }
});

/* ------------------------------------------------------------------ */
/* 4. critical 一票（契约 §12 / §14）                                    */
/* ------------------------------------------------------------------ */

test('[关键回归] critical 一票：只有 model_substitution（100% 替换）也判 likely-degraded', () => {
  // 早期 40 条 model 与 requestModel 一致；近期 40 条响应 model 被换成另一个模型。
  const early = makeRecords(40, (index) =>
    earlyRecord(index, { model: 'claude-sonnet-4-5', requestModel: 'claude-sonnet-4-5' })
  );
  const recent = makeRecords(
    40,
    (index) =>
      earlyRecord(index, {
        model: 'claude-3-5-haiku-20241022',
        requestModel: 'claude-sonnet-4-5',
        timestamp: BASE + 48 * HOUR + index * HOUR
      }),
    { start: BASE + 48 * HOUR, stepMs: HOUR }
  );
  // 注意：其它指标保持完全一致（不截断、等长输出），只有模型字段不同。
  const report = analyzeDegradation({ records: concatRecords(early, recent) });
  assertReportValid(report, 'critical-model-substitution');

  const substitutionCritical = report.criticalIssues.find((finding) => finding.metric === 'model_substitution');
  assert.ok(
    substitutionCritical,
    `model_substitution 必须报 critical，实际 critical=${JSON.stringify(report.criticalIssues.map((f) => [f.id, f.metric, f.severity]))}`
  );
  assert.equal(substitutionCritical.severity, 'critical', '>10% 的模型替换必须是 critical（契约 §11）');
  assert.equal(report.verdict, 'likely-degraded', '存在 criticalIssue 时无论分数都必须 likely-degraded（契约 §12 表格）');
});

/* ------------------------------------------------------------------ */
/* 5. 隐私红线（契约 §9 / §14.6）                                        */
/* ------------------------------------------------------------------ */

test('[最高优先级回归] 隐私：报告序列化后不含日志原文标记串、文件名、raw 字段', async () => {
  const SECRET_PROMPT = 'SECRET_PROMPT_XYZ_请勿泄漏';
  const SECRET_COMPLETION = 'SECRET_COMPLETION_XYZ_机密回答';
  const SECRET_RAW = 'SECRET_RAW_FIELD_XYZ';
  const SECRET_FILENAME = 'SECRET_FILENAME_ABC_用户路径';

  const records = makeRecords(300, (index) =>
    makeRecord({
      index,
      timestamp: BASE + index * HOUR,
      provider: 'openai',
      source: 'api-log',
      model: 'gpt-4o',
      requestModel: 'gpt-4o',
      promptText: `${SECRET_PROMPT}#${index}`,
      completionText: `${SECRET_COMPLETION}#${index}`,
      promptTokens: 400,
      completionTokens: 120,
      finishReason: 'stop',
      status: 200,
      latencyMs: 800,
      raw: { bodyText: `${SECRET_RAW}` }
    })
  );

  // 先模拟「解析了带敏感文件名的文件」再分析：报告里绝不允许出现文件名或路径。
  const parsed = await parseLogFiles({
    files: [
      logFile(`C:\\Users\\${SECRET_FILENAME}\\claude-code.jsonl`, loadLogFixture('claudeCode')),
      logFile(`C:\\Users\\${SECRET_FILENAME}\\rollout-synthetic.jsonl`, loadLogFixture('codexRollout'))
    ]
  });
  const report = analyzeDegradation({ records: [...records, ...parsed.records] });
  assertReportValid(report, 'privacy');

  assertNotStringified(report, SECRET_PROMPT, '报告');
  assertNotStringified(report, SECRET_COMPLETION, '报告');
  assertNotStringified(report, SECRET_RAW, '报告');
  assertNotStringified(report, SECRET_FILENAME, '报告');
  assertNotStringified(report, 'C:\\Users\\', '报告');
  // Codex fixture 里的合成对话原文 / 工作目录也不得泄漏
  assertNotStringified(report, 'CODEX_SECRET_TEXT_XYZ', '报告');
  assertNotStringified(report, '/synthetic/codex/workdir', '报告');
  assertNoFieldDeep(report, 'raw', '报告');
  assertNoFieldDeep(report, 'promptText', '报告');
  assertNoFieldDeep(report, 'completionText', '报告');
});

/* ------------------------------------------------------------------ */
/* 6. 空输入 / 垃圾输入：绝不抛异常（契约 §14.7）                          */
/* ------------------------------------------------------------------ */

test('analyzeDegradation：空 / 垃圾输入全部返回 insufficient 且不抛异常', () => {
  const cases = [
    undefined,
    null,
    {},
    { records: null },
    { records: 'not-an-array' },
    { records: {} },
    { records: [] },
    { records: [null, 42, 'garbage', { foo: 'bar' }] },
    { records: makeRecords(3, (index) => ({ bogus: index })) }
  ];
  for (const input of cases) {
    let report;
    assert.doesNotThrow(() => {
      report = analyzeDegradation(input);
    }, `analyzeDegradation(${JSON.stringify(input)}) 不得抛异常`);
    assert.equal(typeof report, 'object');
    assert.equal(report.verdict, 'insufficient', `垃圾输入必须 insufficient，实际 ${report.verdict}`);
    assertReportValid(report, `garbage-${JSON.stringify(input)}`);
  }
});

/* ------------------------------------------------------------------ */
/* 7. 时间戳为 null 的记录：计入 coverage，不参与时间切分                 */
/* ------------------------------------------------------------------ */

test('时间戳 null 的记录：计入 coverage.records，但不参与时间切分 / 时间序列', () => {
  const timed = makeRecords(240, (index) => earlyRecord(index));
  const untimed = makeRecords(10, (index) =>
    makeRecord({ ...earlyRecord(index), index, timestamp: null, source: 'generic' })
  );
  const report = analyzeDegradation({ records: [...timed, ...untimed] });
  assertReportValid(report, 'null-timestamp');
  assert.equal(report.coverage.records, timed.length + untimed.length, 'coverage.records 必须包含全部输入记录');
  assert.equal(report.coverage.usable, timed.length + untimed.length, '无时间戳记录同样属于可用记录');
  assert.ok(report.verdict === 'stable', `无时间戳记录不应造成伪退化，实际 ${report.verdict}（score=${report.score}）`);

  // 契约 §10.3：无时间戳记录不参与时间切分，因此也不进入时间序列（series）。
  const latency = report.metrics.find((metric) => metric.id === 'latency_median');
  assert.ok(latency, 'metrics 应包含 latency_median');
  assert.equal(
    latency.series.length,
    timed.length,
    `series 只能来自有时序的记录：期望 ${timed.length}，实际 ${latency.series.length}（无时间戳记录不得进入序列）`
  );

  for (const metric of report.metrics) {
    if (metric.status !== 'ok') continue;
    for (const point of metric.series) {
      assert.ok(point.t === null || Number.isFinite(point.t), 'series[].t 必须有限数或 null');
    }
  }
});

/* ------------------------------------------------------------------ */
/* 8. 分析结果与 parseLogFiles 组合（离线端到端）                          */
/* ------------------------------------------------------------------ */

test('端到端：五个 fixture（含 codex-rollout）解析后合并分析可用且不抛异常', async () => {
  const files = [
    logFile('claude-code.jsonl', loadLogFixture('claudeCode')),
    logFile('codex-rollout.jsonl', loadLogFixture('codexRollout')),
    logFile('api-log.jsonl', loadLogFixture('apiLog')),
    logFile('usage.csv', loadLogFixture('usageCsv')),
    logFile('chatgpt-export.json', loadLogFixture('chatgptExport'))
  ];
  const parsed = await parseLogFiles({ files });
  assert.ok(Array.isArray(parsed.records) && parsed.records.length > 0, '五个 fixture 都应解析出记录');
  const sources = new Set(parsed.records.map((record) => record.source));
  assert.ok(sources.has('codex-rollout'), '合并解析结果必须包含 codex-rollout 记录');
  assert.ok(sources.size >= 4, `应覆盖多种来源，实际 ${JSON.stringify([...sources])}`);

  let report;
  assert.doesNotThrow(() => {
    report = analyzeDegradation({ records: parsed.records });
  }, '真实解析结果的分析不得抛异常');
  assertReportValid(report, 'e2e-fixtures');
  // 只有 20 多条记录，证据强度通常不足 → insufficient；只要求形状合法 + 结论在枚举内。
  assert.ok(VERDICTS.includes(report.verdict));
});

/* ------------------------------------------------------------------ */
/* 9. 关键回归：Codex 纯空白占位消息不得制造 empty_rate_spike 假信号        */
/* ------------------------------------------------------------------ */

test('[关键回归] 端到端 Codex 占位消息（keepalive）不得产出 empty_rate_spike，也不得被判退化', async () => {
  // 合成一段真实形态的 Codex 日志：正常 assistant 消息 + 后半段 27 条 " " 占位消息 + 用量事件。
  const text = buildCodexRolloutText({ normal: 60, placeholders: 27, tokenCounts: 80 });
  const parsed = await parseLogFiles({ files: [logFile('rollout-keepalive.jsonl', text)] });
  assert.ok(parsed.records.length > 100, `合成 Codex 日志应解析出较多记录，实际 ${parsed.records.length}`);

  // 解析层：占位消息必须已被跳过（否则 empty_rate 会把它当空回答）。
  // 注意 turn_aborted（status 499 / errorCode 非空）是合法错误信号，不算占位消息。
  const blankAssistants = parsed.records.filter(
    (record) =>
      record.kind === 'assistant' &&
      record.completionText.trim() === '' &&
      !(typeof record.completionTokens === 'number' && record.completionTokens > 0) &&
      record.errorCode === null &&
      record.status === null
  );
  assert.equal(blankAssistants.length, 0, `占位 assistant 消息必须在解析层被跳过，实际仍有 ${blankAssistants.length} 条`);

  const report = analyzeDegradation({ records: parsed.records });
  assertReportValid(report, 'codex-keepalive');

  assert.equal(
    report.findings.filter((finding) => finding.id === 'empty_rate_spike').length,
    0,
    `占位消息不得产出 empty_rate_spike 假信号，实际 findings=${JSON.stringify(report.findings.map((f) => f.id))}`
  );

  const emptyRate = report.metrics.find((metric) => metric.id === 'empty_rate');
  assert.ok(emptyRate, 'metrics 必须包含 empty_rate');
  assert.ok(
    emptyRate.status === 'insufficient' || (emptyRate.early === 0 && emptyRate.recent === 0),
    `占位消息不得抬高 empty_rate：status=${emptyRate.status} early=${emptyRate.early} recent=${emptyRate.recent}（raw placeholders=27）`
  );
  assert.notEqual(
    report.verdict,
    'likely-degraded',
    `占位消息不得导致「退化」误判，实际 ${report.verdict}（score=${report.score}）`
  );
});

/* ------------------------------------------------------------------ */
/* 10. S3 关键回归：变化点必须能捕捉「只有最近才退化」                      */
/* ------------------------------------------------------------------ */

/** 1000 条中只有最后 tail 条退化（30% 截断 + 输出减半），其余完全正常。 */
function tailDegradedRecords({ total = 1000, tail = 50 } = {}) {
  const start = total - tail;
  return makeRecords(total, (index) => {
    const inTail = index >= start;
    const truncated = inTail && (index - start) % 10 < 3; // 尾段 30% 截断
    return {
      timestamp: BASE + index * HOUR,
      provider: 'openai',
      source: 'api-log',
      model: 'gpt-4o',
      requestModel: 'gpt-4o',
      completionText: inTail ? '短回答' : `正常回答 #${index}：这是一段足够长的回答内容用于稳定统计。`,
      promptTokens: 400,
      completionTokens: inTail ? 40 : 120,
      thinkingTokens: null,
      thinkingChars: null,
      hasThinkingSignature: null,
      finishReason: truncated ? 'max_tokens' : 'stop',
      status: 200,
      latencyMs: inTail ? 1500 : 800,
      cacheReadTokens: 0
    };
  });
}

test('[关键回归 S3] 1000 条里只有最后 50 条退化 → 不得判 stable，且 splitAt 落在后 10% 区间', () => {
  const records = tailDegradedRecords({ total: 1000, tail: 50 });
  const report = analyzeDegradation({ records });
  assertReportValid(report, 'tail-degraded');

  assert.notEqual(report.verdict, 'stable', `只有最近退化时不得判 stable（实际 ${report.verdict}, score=${report.score}）`);
  assert.ok(
    ['likely-degraded', 'suspicious'].includes(report.verdict),
    `期望 likely-degraded 或 suspicious，实际 ${report.verdict}（score=${report.score}, segments=${JSON.stringify(report.segments)}）`
  );

  assert.ok(report.segments.splitAt !== null, '必须探测到变化点（splitAt 非 null）');
  const last10Start = records[Math.floor(records.length * 0.9)].timestamp;
  assert.ok(
    report.segments.splitAt >= last10Start,
    `变化点必须落在后 10% 区间（>= ${new Date(last10Start).toISOString()}），实际 ${new Date(report.segments.splitAt).toISOString()}`
  );

  const truncation = report.metrics.find((metric) => metric.id === 'truncation_rate');
  assert.ok(truncation, 'metrics 必须包含 truncation_rate');
  assert.ok(truncation.recent > truncation.early, '近期截断率必须高于早期');
  assert.equal(truncation.direction, 'worse', '截断率上升方向是 worse');
});

test('[关键回归 S3] 反向保护：1000 条前后完全一致的稳定日志仍必须 stable（放宽窗口后不得误报）', () => {
  const records = makeRecords(1000, (index) => ({
    timestamp: BASE + index * HOUR,
    provider: 'openai',
    source: 'api-log',
    model: 'gpt-4o',
    requestModel: 'gpt-4o',
    completionText: `稳定回答 #${index}：这是一段足够长的回答内容用于稳定统计。`,
    promptTokens: 400,
    completionTokens: 120,
    thinkingTokens: null,
    thinkingChars: null,
    hasThinkingSignature: null,
    finishReason: 'stop',
    status: 200,
    latencyMs: 800,
    cacheReadTokens: 0
  }));

  const report = analyzeDegradation({ records });
  assertReportValid(report, 's3-stable-protection');
  assert.equal(report.verdict, 'stable', `稳定日志不得因变化点窗口放宽而误报，实际 ${report.verdict}（score=${report.score}）`);
  assert.deepEqual(report.criticalIssues, [], '稳定日志不得有 critical');
  assert.ok(report.score < 5, `稳定日志 score 应接近 0，实际 ${report.score}`);
});
