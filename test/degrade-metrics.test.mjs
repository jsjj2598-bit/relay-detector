/**
 * v3 降智诊断：13 个指标单测（契约 §10.4 / §11 / §12 / §14.8）。
 *
 * 全部离线：构造契约 §10.1 LogRecord 的明确「早期 vs 近期」数据，
 * 逐个断言 early / recent / deltaPct / direction / status。
 *
 * 覆盖：
 *  - 13 个指标 id / 顺序 / 权重 / worseDirection / critical 与契约 §11 冻结表一致
 *  - 每个指标的数值与方向（变差方向 = worse）
 *  - samples < 5 → status: 'insufficient'
 *  - insufficient 指标不进评分分母（与 v2 skip 同源，契约 §14.8）
 *  - series 降采样 ≤ 500 点
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import {
  DEGRADATION_METRICS,
  METRIC_IDS,
  METRICS_BY_ID,
  computeMetrics,
  finalizeMetric
} from '../src/core/degrade/metrics/index.js';
import { badnessOf, isUsableMetric, scoreDegradation } from '../src/core/degrade/scorer.js';
import { HOUR, makeRecord } from './helpers/degrade-fixtures.mjs';

const BASE = Date.parse('2026-06-01T00:00:00.000Z');
const EARLY_BASE = BASE;
const RECENT_BASE = BASE + 7 * 24 * HOUR;

const rec = (index, overrides = {}, base = EARLY_BASE) =>
  makeRecord({ index, timestamp: base + index * HOUR, ...overrides });

/** 20 条早期 + 20 条近期（契约 §11：每期 ≥5 样本才可用）。 */
function pair(makeEarly, makeRecent, count = 20) {
  const early = Array.from({ length: count }, (_, index) => makeEarly(index));
  const recent = Array.from({ length: count }, (_, index) => makeRecent(index));
  return { early, recent };
}

function metricsFor(early, recent) {
  const timed = [...early, ...recent].sort((a, b) => (a.timestamp ?? 0) - (b.timestamp ?? 0));
  return computeMetrics({ early, recent, timed, all: timed });
}

function metricFor(early, recent, id) {
  const metrics = metricsFor(early, recent);
  const metric = metrics.find((item) => item.id === id);
  assert.ok(metric, `指标 ${id} 未出现在 computeMetrics 结果中`);
  return metric;
}

function assertWorse(metric, { early, recent, deltaPct, id }) {
  assert.equal(metric.status, 'ok', `${id}: 20/20 样本时 status 必须是 ok，实际 ${metric.status}`);
  assert.ok(Math.abs(metric.early - early) < 1e-9, `${id}: early 期望 ${early}，实际 ${metric.early}`);
  assert.ok(Math.abs(metric.recent - recent) < 1e-9, `${id}: recent 期望 ${recent}，实际 ${metric.recent}`);
  if (deltaPct === null) {
    assert.equal(metric.deltaPct, null, `${id}: 早期为 0 时 deltaPct 必须为 null（相对变化无定义）`);
  } else {
    assert.ok(
      Math.abs(metric.deltaPct - deltaPct) < 1e-3,
      `${id}: deltaPct 期望 ${deltaPct}，实际 ${metric.deltaPct}`
    );
  }
  assert.equal(metric.direction, 'worse', `${id}: 变差方向必须判 worse，实际 ${metric.direction}`);
  assert.ok(metric.samples.early >= 5 && metric.samples.recent >= 5, `${id}: samples 应 ≥5`);
  assert.ok(metric.series.length <= 500, `${id}: series 不得超过 500 点`);
  assert.ok(metric.definition.length > 0, `${id}: definition 不得为空`);
}

/* ------------------------------------------------------------------ */
/* 契约 §11 冻结表                                                       */
/* ------------------------------------------------------------------ */

const CONTRACT = [
  { id: 'truncation_rate', unit: '%', weight: 1.4, worseDirection: 'up', critical: true },
  { id: 'model_substitution', unit: '%', weight: 1.5, worseDirection: 'up', critical: true },
  { id: 'thinking_presence', unit: '%', weight: 1.3, worseDirection: 'down', critical: true },
  { id: 'thinking_share', unit: 'ratio', weight: 1.1, worseDirection: 'down', critical: false },
  { id: 'token_inflation', unit: 'ratio', weight: 1.2, worseDirection: 'down', critical: false },
  { id: 'output_length', unit: 'tok', weight: 1.0, worseDirection: 'down', critical: false },
  { id: 'completion_ratio', unit: 'ratio', weight: 0.7, worseDirection: 'down', critical: false },
  { id: 'latency_median', unit: 'ms', weight: 0.8, worseDirection: 'up', critical: false },
  { id: 'error_rate', unit: '%', weight: 1.2, worseDirection: 'up', critical: false },
  { id: 'refusal_rate', unit: '%', weight: 0.6, worseDirection: 'up', critical: false },
  { id: 'repetition_rate', unit: '%', weight: 0.7, worseDirection: 'up', critical: false },
  { id: 'empty_rate', unit: '%', weight: 0.9, worseDirection: 'up', critical: false },
  { id: 'cache_hit_rate', unit: '%', weight: 0.5, worseDirection: 'down', critical: false }
];

test('13 个指标与契约 §11 冻结表完全一致（id / 顺序 / 单位 / 权重 / 变差方向 / critical）', () => {
  assert.equal(DEGRADATION_METRICS.length, 13, `契约 §11 要求 13 个指标，实际 ${DEGRADATION_METRICS.length}`);
  assert.deepEqual(METRIC_IDS, CONTRACT.map((row) => row.id), '指标 id 与顺序必须与契约 §11 表格一致');
  for (const row of CONTRACT) {
    const metric = METRICS_BY_ID[row.id];
    assert.ok(metric, `缺少指标 ${row.id}`);
    assert.equal(metric.unit, row.unit, `${row.id}.unit 必须为 ${row.unit}`);
    assert.equal(metric.weight, row.weight, `${row.id}.weight 必须为 ${row.weight}`);
    assert.equal(metric.worseDirection, row.worseDirection, `${row.id}.worseDirection 必须为 ${row.worseDirection}`);
    assert.equal(metric.critical, row.critical, `${row.id}.critical 必须为 ${row.critical}`);
    assert.equal(typeof metric.label, 'string');
    assert.ok(metric.label.length > 0, `${row.id}.label 不得为空`);
    assert.equal(typeof metric.definition, 'string');
    assert.ok(metric.definition.length > 0, `${row.id}.definition 不得为空`);
    assert.equal(typeof metric.compute, 'function', `${row.id}.compute 必须是函数`);
  }
});

/* ------------------------------------------------------------------ */
/* 13 个指标逐个验证                                                     */
/* ------------------------------------------------------------------ */

test('truncation_rate：早期 10% → 近期 50%，deltaPct=4.0，worse', () => {
  const { early, recent } = pair(
    (index) => rec(index, { finishReason: index < 2 ? 'length' : 'stop' }),
    (index) => rec(index, { finishReason: index < 10 ? 'max_tokens' : 'stop' }, RECENT_BASE)
  );
  assertWorse(metricFor(early, recent, 'truncation_rate'), {
    id: 'truncation_rate',
    early: 0.1,
    recent: 0.5,
    deltaPct: 4.0
  });
});

test('model_substitution：早期 5% → 近期 50%，deltaPct=9.0，worse', () => {
  const { early, recent } = pair(
    (index) =>
      rec(index, index < 1 ? { model: 'gpt-4o-mini', requestModel: 'gpt-4o' } : { model: 'gpt-4o', requestModel: 'gpt-4o' }),
    (index) =>
      rec(
        index,
        index < 10 ? { model: 'gpt-4o-mini', requestModel: 'gpt-4o' } : { model: 'gpt-4o', requestModel: 'gpt-4o' },
        RECENT_BASE
      )
  );
  assertWorse(metricFor(early, recent, 'model_substitution'), {
    id: 'model_substitution',
    early: 0.05,
    recent: 0.5,
    deltaPct: 9.0
  });
});

test('thinking_presence：早期 100% → 近期 0%，deltaPct=-1，worse（下降方向）', () => {
  const { early, recent } = pair(
    (index) => rec(index, { hasThinkingSignature: true, thinkingTokens: 60, thinkingChars: 300 }),
    (index) => rec(index, { hasThinkingSignature: false, thinkingTokens: 0, thinkingChars: 0 }, RECENT_BASE)
  );
  assertWorse(metricFor(early, recent, 'thinking_presence'), {
    id: 'thinking_presence',
    early: 1,
    recent: 0,
    deltaPct: -1
  });
});

test('thinking_share：0.6 → 0.12，deltaPct=-0.8，worse（下降方向）', () => {
  const { early, recent } = pair(
    (index) => rec(index, { thinkingTokens: 60, completionTokens: 100 }),
    (index) => rec(index, { thinkingTokens: 12, completionTokens: 100 }, RECENT_BASE)
  );
  assertWorse(metricFor(early, recent, 'thinking_share'), {
    id: 'thinking_share',
    early: 0.6,
    recent: 0.12,
    deltaPct: -0.8
  });
});

test('token_inflation：字符/token 4 → 1，deltaPct=-0.75，worse（下降方向）', () => {
  const { early, recent } = pair(
    (index) => rec(index, { completionText: 'x'.repeat(200), completionTokens: 50 }),
    (index) => rec(index, { completionText: 'x'.repeat(50), completionTokens: 50 }, RECENT_BASE)
  );
  assertWorse(metricFor(early, recent, 'token_inflation'), {
    id: 'token_inflation',
    early: 4,
    recent: 1,
    deltaPct: -0.75
  });
});

test('output_length：输出 token 中位数 100 → 40，deltaPct=-0.6，worse', () => {
  const { early, recent } = pair(
    (index) => rec(index, { completionTokens: 100 }),
    (index) => rec(index, { completionTokens: 40 }, RECENT_BASE)
  );
  assertWorse(metricFor(early, recent, 'output_length'), {
    id: 'output_length',
    early: 100,
    recent: 40,
    deltaPct: -0.6
  });
});

test('completion_ratio：输出/输入 1.0 → 0.4，deltaPct=-0.6，worse', () => {
  const { early, recent } = pair(
    (index) => rec(index, { promptTokens: 100, completionTokens: 100 }),
    (index) => rec(index, { promptTokens: 100, completionTokens: 40 }, RECENT_BASE)
  );
  assertWorse(metricFor(early, recent, 'completion_ratio'), {
    id: 'completion_ratio',
    early: 1,
    recent: 0.4,
    deltaPct: -0.6
  });
});

test('latency_median：延迟 800ms → 2000ms，deltaPct=1.5，worse', () => {
  const { early, recent } = pair(
    (index) => rec(index, { latencyMs: 800 }),
    (index) => rec(index, { latencyMs: 2000 }, RECENT_BASE)
  );
  assertWorse(metricFor(early, recent, 'latency_median'), {
    id: 'latency_median',
    early: 800,
    recent: 2000,
    deltaPct: 1.5
  });
});

test('error_rate：非成功占比 5% → 50%，deltaPct=9.0，worse', () => {
  const { early, recent } = pair(
    (index) => rec(index, { status: index < 1 ? 500 : 200 }),
    (index) => rec(index, { status: index < 10 ? 429 : 200 }, RECENT_BASE)
  );
  assertWorse(metricFor(early, recent, 'error_rate'), {
    id: 'error_rate',
    early: 0.05,
    recent: 0.5,
    deltaPct: 9.0
  });
});

test('refusal_rate：拒答占比 5% → 50%，deltaPct=9.0，worse', () => {
  const refusal = 'I cannot help with that request.';
  const normal = 'This is a normal, helpful answer with details.';
  const { early, recent } = pair(
    (index) => rec(index, { completionText: index < 1 ? refusal : normal }),
    (index) => rec(index, { completionText: index < 10 ? refusal : normal }, RECENT_BASE)
  );
  assertWorse(metricFor(early, recent, 'refusal_rate'), {
    id: 'refusal_rate',
    early: 0.05,
    recent: 0.5,
    deltaPct: 9.0
  });
});

test('repetition_rate：重复 n-gram 占比明显上升 → worse', () => {
  const uniqueText =
    '天地玄黄宇宙洪荒日月盈昃辰宿列张寒来暑往秋收冬藏闰余成岁律吕调阳云腾致雨露结为霜金生丽水玉出昆冈';
  const repetitive = '重复重复'.repeat(40);
  const { early, recent } = pair(
    (index) => rec(index, { completionText: uniqueText }),
    (index) => rec(index, { completionText: repetitive }, RECENT_BASE)
  );
  const metric = metricFor(early, recent, 'repetition_rate');
  assert.equal(metric.status, 'ok');
  assert.ok(metric.recent > metric.early, `近期重复率(${metric.recent})应高于早期(${metric.early})`);
  assert.equal(metric.direction, 'worse', '重复率上升是变差方向');
  assert.ok(metric.samples.early >= 5 && metric.samples.recent >= 5);
});

test('empty_rate：空回答占比 5% → 50%，deltaPct=9.0，worse', () => {
  const { early, recent } = pair(
    (index) => rec(index, index < 1 ? { completionText: '', completionTokens: 0 } : { completionText: '正常回答', completionTokens: 10 }),
    (index) =>
      rec(
        index,
        index < 10 ? { completionText: '', completionTokens: 0 } : { completionText: '正常回答', completionTokens: 10 },
        RECENT_BASE
      )
  );
  assertWorse(metricFor(early, recent, 'empty_rate'), {
    id: 'empty_rate',
    early: 0.05,
    recent: 0.5,
    deltaPct: 9.0
  });
});

test('cache_hit_rate：缓存命中率 10% → 0%，deltaPct=-1，worse（下降方向）', () => {
  const { early, recent } = pair(
    (index) => rec(index, { cacheReadTokens: 100, promptTokens: 900, cacheWriteTokens: 0 }),
    (index) => rec(index, { cacheReadTokens: 0, promptTokens: 900, cacheWriteTokens: 0 }, RECENT_BASE)
  );
  assertWorse(metricFor(early, recent, 'cache_hit_rate'), {
    id: 'cache_hit_rate',
    early: 0.1,
    recent: 0,
    deltaPct: -1
  });
});

/* ------------------------------------------------------------------ */
/* 关键回归：Codex 纯空白占位消息（keepalive / 进度消息）不得算作空回答      */
/* ------------------------------------------------------------------ */

test('[关键回归] empty_rate：10 条纯空白占位消息（无 token）不进分母 → empty_rate 为 0 或 insufficient', () => {
  // 真实 Codex 日志里存在文本恰为一个空格的 assistant 占位消息（keepalive），
  // 它们不是「空回答」：没有 completionObserved 语义、也没有 token 消耗。
  const placeholder = (index, base) =>
    rec(index, { completionText: ' ', completionTokens: null, completionObserved: true, finishReason: null }, base);
  const normal = (index, base) =>
    rec(index, { completionText: '这是正常的回答内容。', completionTokens: 20, completionObserved: true }, base);
  const early = [
    ...Array.from({ length: 10 }, (_, index) => placeholder(index, EARLY_BASE)),
    ...Array.from({ length: 5 }, (_, index) => normal(100 + index, EARLY_BASE))
  ];
  const recent = [
    ...Array.from({ length: 10 }, (_, index) => placeholder(index, RECENT_BASE)),
    ...Array.from({ length: 5 }, (_, index) => normal(100 + index, RECENT_BASE))
  ];

  const metric = metricFor(early, recent, 'empty_rate');
  assert.ok(
    metric.status === 'insufficient' || (metric.early === 0 && metric.recent === 0),
    `10 条占位消息不得被算成空回答：期望 empty_rate=0 或 insufficient，实际 status=${metric.status} early=${metric.early} recent=${metric.recent}`
  );
  assert.ok(
    metric.samples.early <= 5 && metric.samples.recent <= 5,
    `纯空白占位消息不得进入分母：samples 应为 ≤5，实际 ${JSON.stringify(metric.samples)}`
  );
});

test('[关键回归] empty_rate：文本为空但 completionTokens=50 的记录仍必须计入分母（不放宽语义）', () => {
  const emptyWithTokens = (index, base) =>
    rec(index, { completionText: '', completionTokens: 50, completionObserved: true }, base);
  const normal = (index, base) =>
    rec(index, { completionText: '这是正常的回答内容。', completionTokens: 20, completionObserved: true }, base);
  const early = [
    ...Array.from({ length: 5 }, (_, index) => emptyWithTokens(index, EARLY_BASE)),
    ...Array.from({ length: 5 }, (_, index) => normal(100 + index, EARLY_BASE))
  ];
  const recent = [
    ...Array.from({ length: 5 }, (_, index) => emptyWithTokens(index, RECENT_BASE)),
    ...Array.from({ length: 5 }, (_, index) => normal(100 + index, RECENT_BASE))
  ];

  const metric = metricFor(early, recent, 'empty_rate');
  assert.equal(metric.status, 'ok', '空文本 + token>0 的记录有完成的 token 计数，指标应 available');
  assert.equal(metric.samples.early, 10, `文本为空但 token>0 的记录必须计入分母（early samples 应为 10），实际 ${metric.samples.early}`);
  assert.equal(metric.samples.recent, 10);
  // 它们不是「空回答」（有 50 个输出 token），所以命中数应为 0
  assert.equal(metric.early, 0, '空文本 + token>0 不应被算作空回答（hit 需 token 为 0/缺失）');
  assert.equal(metric.recent, 0);
});

test('empty_rate：真·空响应（无文本且 token=0）仍会计入分子（防止过度修复）', () => {
  const trueEmpty = (index, base) =>
    rec(index, { completionText: '', completionTokens: 0, completionObserved: true }, base);
  const normal = (index, base) =>
    rec(index, { completionText: '这是正常的回答内容。', completionTokens: 20, completionObserved: true }, base);
  const early = [
    ...Array.from({ length: 2 }, (_, index) => trueEmpty(index, EARLY_BASE)),
    ...Array.from({ length: 8 }, (_, index) => normal(100 + index, EARLY_BASE))
  ];
  const recent = [
    ...Array.from({ length: 5 }, (_, index) => trueEmpty(index, RECENT_BASE)),
    ...Array.from({ length: 5 }, (_, index) => normal(100 + index, RECENT_BASE))
  ];

  const metric = metricFor(early, recent, 'empty_rate');
  assert.equal(metric.status, 'ok');
  assert.ok(Math.abs(metric.early - 0.2) < 1e-9, `early 空回答率应为 0.2，实际 ${metric.early}`);
  assert.ok(Math.abs(metric.recent - 0.5) < 1e-9, `recent 空回答率应为 0.5，实际 ${metric.recent}`);
  assert.equal(metric.direction, 'worse', '真·空响应上升是变差方向');
});

/* ------------------------------------------------------------------ */
/* samples 闸门：<5 → insufficient                                        */
/* ------------------------------------------------------------------ */

test('samples 闸门：每期只有 4 个样本 → status=insufficient（不得按 0 分/正常值参与评分）', () => {
  const { early, recent } = pair(
    (index) => rec(index, { finishReason: 'stop' }),
    (index) => rec(index, { finishReason: 'max_tokens' }, RECENT_BASE),
    4
  );
  const metrics = metricsFor(early, recent);
  const truncation = metrics.find((metric) => metric.id === 'truncation_rate');
  assert.equal(truncation.samples.early, 4);
  assert.equal(truncation.samples.recent, 4);
  assert.equal(truncation.status, 'insufficient', '少于 5 个样本必须 insufficient（契约 §11 末注）');
  assert.equal(isUsableMetric(truncation), false, 'insufficient 指标不得参与评分');
  // badnessOf 是纯幅度函数（调用方负责先过滤可用指标）；这里验证评分器确实排除了它。
  const scored = scoreDegradation([truncation], [], { usableRecords: 40, minRecords: 20 });
  assert.equal(scored.score, 0, '没有可用指标时评分分母为 0，不得把 insufficient 当 0 分纳入');
  assert.equal(scored.verdict, 'insufficient');
});

/* ------------------------------------------------------------------ */
/* insufficient 不进评分分母（契约 §12 / §14.8）—— 关键一条                */
/* ------------------------------------------------------------------ */

test('[关键回归] insufficient 指标不进评分分母：1 个满分恶化指标 + 12 个 insufficient → score=100（不是被 13 摊薄）', () => {
  // 只构造一个可用指标（truncation 0 → 1，badness=1），其余 12 个数据不足。
  const usable = finalizeMetric(METRICS_BY_ID.truncation_rate, {
    early: 0,
    recent: 1,
    samples: { early: 20, recent: 20 },
    series: []
  });
  assert.equal(usable.status, 'ok');
  assert.equal(badnessOf(usable), 1, '0 → 100% 的变化应记满分 badness=1');

  const insufficient = CONTRACT.filter((row) => row.id !== 'truncation_rate').map((row) =>
    finalizeMetric(METRICS_BY_ID[row.id], {
      early: null,
      recent: null,
      samples: { early: 2, recent: 2 },
      series: []
    })
  );
  assert.equal(insufficient.length, 12);
  for (const metric of insufficient) assert.equal(metric.status, 'insufficient', `${metric.id} 应为 insufficient`);

  const scored = scoreDegradation([usable, ...insufficient], [], { usableRecords: 40, minRecords: 20 });
  assert.equal(
    scored.score,
    100,
    `insufficient 不得进分母：只有 1 个可用指标且 badness=1 时 score 必须是 100，实际 ${scored.score}`
  );
});

test('评分：反向（better）变化记 0 分但保留在报告中', () => {
  const improved = finalizeMetric(METRICS_BY_ID.truncation_rate, {
    early: 0.5,
    recent: 0.1,
    samples: { early: 20, recent: 20 },
    series: []
  });
  assert.equal(improved.direction, 'better', '截断率下降应判 better');
  assert.equal(badnessOf(improved), 0, 'better 不计入恶化分');
  assert.equal(improved.recent, 0.1, '反向变化必须保留在 MetricResult 中展示');
});

/* ------------------------------------------------------------------ */
/* series 降采样 ≤ 500（契约 §10.4）                                      */
/* ------------------------------------------------------------------ */

test('series 降采样：1200 条记录时所有指标 series 都 ≤500 点', () => {
  const early = Array.from({ length: 600 }, (_, index) =>
    rec(index, { finishReason: 'stop', completionTokens: 100, promptTokens: 100, latencyMs: 800 })
  );
  const recent = Array.from({ length: 600 }, (_, index) =>
    rec(index, { finishReason: 'stop', completionTokens: 100, promptTokens: 100, latencyMs: 800 }, RECENT_BASE)
  );
  const metrics = metricsFor(early, recent);
  for (const metric of metrics) {
    assert.ok(
      metric.series.length <= 500,
      `${metric.id}: series 必须降采样到 ≤500 点（契约 §10.4），实际 ${metric.series.length}`
    );
    for (const point of metric.series) {
      assert.equal(typeof point.v, 'number', `${metric.id}: series[].v 必须是数字`);
      assert.ok(point.t === null || typeof point.t === 'number', `${metric.id}: series[].t 形状非法`);
    }
  }
});

test('指标对垃圾输入不抛异常：computeMetrics 始终返回 13 个合法 MetricResult', () => {
  for (const bad of [undefined, null, {}, [], { early: [null, 1], recent: 'x' }]) {
    let metrics;
    assert.doesNotThrow(() => {
      metrics = computeMetrics(bad);
    }, `computeMetrics(${JSON.stringify(bad)}) 不得抛异常`);
    assert.equal(metrics.length, 13);
    for (const metric of metrics) {
      assert.ok(['ok', 'insufficient'].includes(metric.status));
      assert.ok(['worse', 'better', 'flat'].includes(metric.direction));
      assert.ok(Array.isArray(metric.series));
    }
  }
});

/* ------------------------------------------------------------------ */
/* S1 关键回归：verdict 必须与「舍入后的 report.score」自洽（契约 §12）    */
/* ------------------------------------------------------------------ */

/** 用 3 个可用指标、相同 deltaPct 构造总分：score = 200 × deltaPct（权重相同可约掉）。 */
function threeMetricsAtDelta(deltaPct) {
  return ['truncation_rate', 'model_substitution', 'thinking_presence'].map((id) => ({
    id,
    label: METRICS_BY_ID[id].label,
    unit: METRICS_BY_ID[id].unit,
    status: 'ok',
    early: 0.4,
    recent: 0.4 * (1 + deltaPct),
    deltaPct,
    direction: 'worse',
    samples: { early: 20, recent: 20 },
    series: [],
    definition: METRICS_BY_ID[id].definition
  }));
}

/** 按契约 §12 的顺序，用**报告里的 score** 重算 verdict（不含 critical 的简单路径）。 */
function expectedVerdictForScore(score) {
  if (score >= 60) return 'likely-degraded';
  if (score >= 30) return 'suspicious';
  return 'stable';
}

test('[关键回归 S1] verdict 必须与舍入后的 score 自洽：阈值 60 / 30 附近（3 可用指标）', () => {
  const context = { usableRecords: 1000, minRecords: 20 };
  const cases = [
    { name: '恰好 60（badness 0.6 × 3，浮点可能略低于 60）', deltaPct: 0.3, expected: 'likely-degraded' },
    { name: '恰好 30（badness 0.3 × 3）', deltaPct: 0.15, expected: 'suspicious' },
    { name: '50 / badness 0.5（阈值之间）', deltaPct: 0.25, expected: 'suspicious' },
    { name: '略低于 60', deltaPct: 0.298, expected: 'suspicious' },
    { name: '略高于 60', deltaPct: 0.302, expected: 'likely-degraded' },
    { name: '略低于 30', deltaPct: 0.149, expected: 'stable' },
    { name: '略高于 30', deltaPct: 0.151, expected: 'suspicious' }
  ];

  for (const item of cases) {
    const metrics = threeMetricsAtDelta(item.deltaPct);
    const scored = scoreDegradation(metrics, [], context);
    assert.equal(typeof scored.score, 'number');
    assert.notEqual(scored.verdict, 'insufficient', `${item.name}: 3 个可用指标 + 1000 条记录不得 insufficient`);
    assert.equal(
      scored.verdict,
      expectedVerdictForScore(scored.score),
      `S1：${item.name}（report.score=${scored.score}）的 verdict「${scored.verdict}」必须等于用舍入后 score 重判的「${expectedVerdictForScore(scored.score)}」`
    );
    assert.equal(
      scored.verdict,
      item.expected,
      `S1：${item.name}（report.score=${scored.score}）期望 ${item.expected}，实际 ${scored.verdict}`
    );
  }
});

test('[关键回归 S1] 60 / 30 阈值正上方与正下方严格区分（先舍入再判定）', () => {
  const context = { usableRecords: 1000, minRecords: 20 };
  const below60 = scoreDegradation(threeMetricsAtDelta(0.2999), [], context);
  const at60 = scoreDegradation(threeMetricsAtDelta(0.3), [], context);
  const above60 = scoreDegradation(threeMetricsAtDelta(0.3001), [], context);
  // 0.2999 → 59.98 → suspicious；0.3 → 60.0 → likely-degraded；0.3001 → 60.02 → likely-degraded
  assert.equal(below60.verdict, 'suspicious', `score=${below60.score} 应为 suspicious`);
  assert.equal(at60.score, 60, `坏值 0.6×3 的舍入后 score 应为 60，实际 ${at60.score}`);
  assert.equal(at60.verdict, 'likely-degraded', `score=${at60.score} 必须判 likely-degraded（不能因未舍入的 59.999… 判 suspicious）`);
  assert.equal(above60.verdict, 'likely-degraded');

  const below30 = scoreDegradation(threeMetricsAtDelta(0.1499), [], context);
  const at30 = scoreDegradation(threeMetricsAtDelta(0.15), [], context);
  assert.equal(below30.verdict, 'stable', `score=${below30.score} 应为 stable`);
  assert.equal(at30.score, 30, `舍入后 score 应为 30，实际 ${at30.score}`);
  assert.equal(at30.verdict, 'suspicious', `score=${at30.score} 必须判 suspicious（不能因未舍入的 29.999… 判 stable）`);
});
