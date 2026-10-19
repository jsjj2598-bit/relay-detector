/**
 * 单元测试：src/core/auth/scorer.js（契约 v2 §6.2 / §6.3）。
 *
 * 本文件只读源码、不修改源码；发现缺陷只报告（owner: auth-engine），不放宽断言。
 *
 * 覆盖契约 §8 第 1 条：
 *  - computeTotal：加权平均
 *  - computeTotal：**skip 与 error 都不进入分母**（一条 100 分 + 三条 skip → 100，而不是 25）
 *  - 全 skip → verdict 'invalid'
 *  - verdictFor 阈值边界 85 / 70 / 50
 *  - hasCriticalIssues / effectiveVerdict：critical 一票降级（90 分 + critical → marginal）
 *  - fatalRunError：insufficient_quota / model_unavailable 命中，普通报错不误判
 *  - summaryText 文案
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import {
  computeTotal,
  verdictFor,
  hasCriticalIssues,
  effectiveVerdict,
  fatalRunError,
  summaryText
} from '../src/core/auth/scorer.js';

/** 构造一条 DetectorResult（契约 6.2）。 */
function result({
  name = 'dummy',
  displayName = '占位检测器',
  weight = 10,
  status = 'pass',
  score = 100,
  criticalIssues = [],
  details = { subChecks: [] },
  error = null
} = {}) {
  return { name, displayName, weight, status, score, details, error, durationMs: 1, criticalIssues };
}

const skipped = (name, weight = 10) => result({ name, weight, status: 'skip', score: 0 });
const errored = (name, weight = 10) => result({ name, weight, status: 'error', score: 0, error: 'network' });
const problematic = (code = 'cross_vendor_leak') =>
  result({
    name: 'cross_vendor_leak',
    status: 'pass',
    score: 80,
    criticalIssues: [{ code, message: '检测到跨厂商字段泄漏', evidence: { field: 'input_tokens' } }]
  });

/* ------------------------------------------------------------------ */
/* 导出形状（契约 6.3）                                                  */
/* ------------------------------------------------------------------ */

test('scorer.js 导出契约 6.3 要求的全部函数', () => {
  const fns = { computeTotal, verdictFor, hasCriticalIssues, effectiveVerdict, fatalRunError, summaryText };
  for (const [name, fn] of Object.entries(fns)) {
    assert.equal(typeof fn, 'function', `scorer.js 必须导出函数 ${name}`);
  }
});

/* ------------------------------------------------------------------ */
/* computeTotal：加权平均                                                */
/* ------------------------------------------------------------------ */

test('computeTotal：加权平均 = Σ(score×weight)/Σ(weight)', () => {
  const total = computeTotal([
    result({ name: 'a', weight: 50, score: 100 }),
    result({ name: 'b', weight: 25, score: 40 })
  ]);
  // (100*50 + 40*25) / 75 = 80
  assert.equal(total, 80, '加权平均计算错误');
});

test('computeTotal：所有权重相等时等于算术平均', () => {
  const total = computeTotal([
    result({ name: 'a', weight: 20, score: 90 }),
    result({ name: 'b', weight: 20, score: 60 })
  ]);
  assert.equal(total, 75);
});

/* ------------------------------------------------------------------ */
/* 最关键语义：skip / error 不进入分母（契约 6.2 第 1 条）                 */
/* ------------------------------------------------------------------ */

test('[关键回归] computeTotal：一条 100 分 + 三条 skip → 100（skip 不进入分母，不是 25）', () => {
  const results = [
    result({ name: 'thinking_signature', weight: 25, status: 'pass', score: 100 }),
    skipped('token_usage', 10),
    skipped('stream_integrity', 10),
    skipped('token_parity', 10)
  ];
  assert.equal(
    computeTotal(results),
    100,
    'skip 不得进入加权分母（契约 6.2：skip 表示本来就无法测，不得当作 0 分拉低总分）'
  );
});

test('[关键回归] computeTotal：error 同样不进入分母', () => {
  const results = [
    result({ name: 'a', weight: 30, status: 'pass', score: 90 }),
    errored('b', 20),
    errored('c', 20)
  ];
  assert.equal(computeTotal(results), 90, 'error 不得进入加权分母');
});

test('computeTotal：pass 与 fail 混合按权重平均', () => {
  const results = [
    result({ name: 'a', weight: 25, status: 'pass', score: 100 }),
    result({ name: 'b', weight: 25, status: 'fail', score: 0 })
  ];
  assert.equal(computeTotal(results), 50);
});

test('computeTotal：空数组 / 全 skip / 全 error → 0（分母为 0 时返回 0）', () => {
  assert.equal(computeTotal([]), 0, '空结果分母为 0 必须返回 0');
  assert.equal(computeTotal([skipped('a'), skipped('b')]), 0, '全 skip 分母为 0 必须返回 0');
  assert.equal(computeTotal([errored('a'), errored('b')]), 0, '全 error 分母为 0 必须返回 0');
});

test('computeTotal：对非数组 / 垃圾输入不抛错', () => {
  for (const bad of [null, undefined, 'x', 0, {}, [null], [{ weight: 0, score: 100, status: 'pass' }]]) {
    assert.doesNotThrow(() => computeTotal(bad), `computeTotal(${JSON.stringify(bad)}) 不得抛异常`);
    assert.equal(typeof computeTotal(bad), 'number', 'computeTotal 必须始终返回数字');
  }
});

test('computeTotal 返回值落在 0..100', () => {
  const total = computeTotal([
    result({ name: 'a', weight: 100, score: 100 }),
    result({ name: 'b', weight: 1, score: 0 })
  ]);
  assert.ok(total >= 0 && total <= 100, `computeTotal 越界：${total}`);
});

/* ------------------------------------------------------------------ */
/* verdictFor：阈值边界（契约 6.3：>=85 excellent / >=70 passed / >=50 marginal / <50 failed） */
/* ------------------------------------------------------------------ */

test('verdictFor：阈值边界 85 / 70 / 50', () => {
  assert.equal(verdictFor(100), 'excellent');
  assert.equal(verdictFor(85), 'excellent', '85 是 excellent 闭区间下界');
  assert.equal(verdictFor(84.99), 'passed', '84.99 应降为 passed');
  assert.equal(verdictFor(84), 'passed');
  assert.equal(verdictFor(70), 'passed', '70 是 passed 闭区间下界');
  assert.equal(verdictFor(69.99), 'marginal', '69.99 应降为 marginal');
  assert.equal(verdictFor(69), 'marginal');
  assert.equal(verdictFor(50), 'marginal', '50 是 marginal 闭区间下界');
  assert.equal(verdictFor(49.99), 'failed', '49.99 应为 failed');
  assert.equal(verdictFor(0), 'failed');
});

test('verdictFor：非法输入不抛错且返回合法 verdict', () => {
  const legal = ['excellent', 'passed', 'marginal', 'failed'];
  for (const bad of [null, undefined, NaN, -1, 101, Infinity, '90']) {
    let v;
    assert.doesNotThrow(() => {
      v = verdictFor(bad);
    }, `verdictFor(${String(bad)}) 不得抛异常`);
    assert.ok(legal.includes(v), `verdictFor(${String(bad)}) 返回非法 verdict "${v}"`);
  }
});

/* ------------------------------------------------------------------ */
/* hasCriticalIssues                                                     */
/* ------------------------------------------------------------------ */

test('hasCriticalIssues：有 criticalIssues → true，无 → false', () => {
  assert.equal(hasCriticalIssues([result({ name: 'a' })]), false);
  assert.equal(hasCriticalIssues([]), false);
  assert.equal(hasCriticalIssues([skipped('a')]), false);
  assert.equal(hasCriticalIssues([problematic()]), true);
  assert.equal(
    hasCriticalIssues([result({ name: 'a' }), problematic('cross_vendor_leak'), skipped('b')]),
    true,
    '任意一条 critical 即视为有严重问题'
  );
});

test('hasCriticalIssues：对缺失 / 畸形 criticalIssues 不抛错', () => {
  const weird = [
    { name: 'x', weight: 10, status: 'pass', score: 100 }, // 无 criticalIssues 字段
    { name: 'y', weight: 10, status: 'pass', score: 100, criticalIssues: null },
    { name: 'z', weight: 10, status: 'pass', score: 100, criticalIssues: 'oops' }
  ];
  for (const w of weird) {
    assert.doesNotThrow(() => hasCriticalIssues([w]), `畸形 criticalIssues 不得抛错：${JSON.stringify(w)}`);
    assert.equal(hasCriticalIssues([w]), false, '畸形 criticalIssues 不应被当作有 critical');
  }
});

/* ------------------------------------------------------------------ */
/* effectiveVerdict：critical 一票降级（契约 6.3）                        */
/* ------------------------------------------------------------------ */

test('[关键回归] effectiveVerdict：分数 90 但有 critical → 封顶 marginal（不是 excellent/passed）', () => {
  const results = [problematic()];
  assert.equal(computeTotal(results), 80);
  assert.equal(verdictFor(80), 'passed', '前置：80 分本应 passed');
  assert.equal(
    effectiveVerdict(90, results),
    'marginal',
    'critical 一票降级：base=excellent 必须封顶为 marginal'
  );
});

test('effectiveVerdict：无 critical 时等于 verdictFor(score)', () => {
  const clean = [result({ name: 'fine', status: 'pass', score: 90 })];
  assert.equal(effectiveVerdict(90, clean), 'excellent');
  assert.equal(effectiveVerdict(75, clean), 'passed');
  assert.equal(effectiveVerdict(55, clean), 'marginal');
  assert.equal(effectiveVerdict(20, clean), 'failed');
});

test('effectiveVerdict：critical 只封顶不抬升（低分仍然是 failed/marginal）', () => {
  const results = [problematic()];
  assert.equal(effectiveVerdict(30, results), 'failed', 'critical 不得把 failed 抬升');
  assert.equal(effectiveVerdict(55, results), 'marginal', '已是 marginal 时保持不变');
  assert.equal(effectiveVerdict(75, results), 'marginal', 'passed 被压到 marginal');
  assert.equal(effectiveVerdict(100, results), 'marginal', 'excellent 被压到 marginal');
});

test('[关键回归] 全 skip → verdict invalid（不是 0 分 failed）', () => {
  const allSkipped = [skipped('thinking_signature', 25), skipped('token_usage', 10), skipped('stream_integrity', 10)];
  assert.equal(computeTotal(allSkipped), 0, '全 skip 总分为 0');
  assert.equal(
    effectiveVerdict(computeTotal(allSkipped), allSkipped),
    'invalid',
    '全部检测器都 skip 时 verdict 必须是 invalid（契约 6.2 第 2 条），不得输出 failed 低分'
  );
});

test('effectiveVerdict：全 error 也不得被判成低分（invalid）', () => {
  const allErrored = [errored('a', 20), errored('b', 20)];
  assert.equal(
    effectiveVerdict(computeTotal(allErrored), allErrored),
    'invalid',
    '全部检测器都 error 时同样属于「检测无效」，不得输出低分'
  );
});

/* ------------------------------------------------------------------ */
/* fatalRunError：契约 6.3 两种 code                                     */
/* ------------------------------------------------------------------ */

test('[关键回归] fatalRunError：insufficient_quota 命中（余额/额度不足 → 检测无效）', () => {
  const results = [
    result({
      name: 'protocol_shape',
      status: 'error',
      score: 0,
      error: 'HTTP 429: {"error":{"type":"insufficient_quota","message":"You exceeded your current quota"}}'
    })
  ];
  const fatal = fatalRunError(results);
  assert.ok(fatal, '余额不足必须被 fatalRunError 命中');
  assert.equal(fatal.code, 'insufficient_quota');
  assert.equal(typeof fatal.message, 'string');
  assert.ok(fatal.message.length > 0, 'fatalRunError.message 不得为空');
});

test('[关键回归] fatalRunError：model_unavailable 命中（model_not_found / 无可用渠道 → 检测无效）', () => {
  const notFound = [
    result({
      name: 'protocol_shape',
      status: 'error',
      score: 0,
      error: 'HTTP 404: {"error":{"type":"not_found_error","message":"model: claude-sonnet-4-5 not found"}}'
    })
  ];
  const f1 = fatalRunError(notFound);
  assert.ok(f1, 'model_not_found 必须被 fatalRunError 命中');
  assert.equal(f1.code, 'model_unavailable');

  const noChannel = [
    result({
      name: 'protocol_shape',
      status: 'error',
      score: 0,
      error: '{"error":{"message":"当前分组上游负载已饱和，无可用渠道","type":"new_api_error"}}'
    })
  ];
  const f2 = fatalRunError(noChannel);
  assert.ok(f2, '「无可用渠道」必须被 fatalRunError 命中');
  assert.equal(f2.code, 'model_unavailable');
});

test('fatalRunError：普通网络错误 / 鉴权错误 / 正常结果不得误判为检测无效', () => {
  const cases = [
    [errored('a')],
    [result({ name: 'a', error: 'TypeError: fetch failed' })],
    [result({ name: 'a', error: 'HTTP 500: internal server error' })],
    [result({ name: 'a', error: 'HTTP 401: invalid x-api-key' })],
    [result({ name: 'a', status: 'pass', score: 100 })],
    [skipped('a')],
    []
  ];
  for (const results of cases) {
    const fatal = fatalRunError(results);
    assert.equal(fatal, null, `普通错误不得被判为检测无效：${JSON.stringify(results.map((r) => r.error || r.status))}`);
  }
});

test('fatalRunError：对垃圾输入不抛错且返回 null', () => {
  for (const bad of [null, undefined, 'x', {}, [null], [{ name: 'a' }]]) {
    assert.doesNotThrow(() => fatalRunError(bad));
    assert.equal(fatalRunError(bad), null);
  }
});

/* ------------------------------------------------------------------ */
/* summaryText                                                           */
/* ------------------------------------------------------------------ */

test('summaryText：五种 verdict 的中文文案（契约 6.3 / 6.6）', () => {
  const expected = {
    excellent: '优秀',
    passed: '通过',
    marginal: '基本合格',
    failed: '未达标',
    invalid: '检测无效'
  };
  for (const [verdict, label] of Object.entries(expected)) {
    const text = summaryText(verdict, 80);
    assert.equal(typeof text, 'string', `summaryText('${verdict}') 必须返回字符串`);
    assert.ok(text.length > 0, `summaryText('${verdict}') 不得为空`);
    assert.ok(text.includes(label), `summaryText('${verdict}') 必须包含「${label}」，实际 "${text}"`);
  }
});

test('summaryText：非法输入不抛错', () => {
  for (const bad of [null, undefined, 'nope', 0]) {
    assert.doesNotThrow(() => summaryText(bad, 0), `summaryText(${String(bad)}) 不得抛异常`);
    assert.equal(typeof summaryText(bad, 0), 'string');
  }
});
