/**
 * 单元测试：src/core/score.js（Lead 冻结模块）。
 *
 * 断言全部以 docs/CONTRACT.md §2.4 与 score.js 自身文档的设计意图为准。
 * 本文件只读源码、不修改源码；发现缺陷只报告，不放宽断言。
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import {
  scoreSignals,
  verdictFromScore,
  contributionOf,
  sortSignalsByContribution,
  CATEGORY_WEIGHTS,
  VERDICT_THRESHOLDS,
  EVIDENCE_HALF,
  REQUIRE_URL_EVIDENCE_FOR_OFFICIAL,
  MIN_DIRECTIONAL_POINTS,
  VERDICT_LABELS,
  VERDICT_TONES
} from '../src/core/score.js';

const VALID_VERDICTS = ['relay', 'likely-relay', 'inconclusive', 'likely-official', 'official'];

/** 构造一条形状完整的 Signal。 */
function sig({ id = 'x.test', category = 'url', verdict = 'neutral', weight = 0, confidence = 1, evidence = { note: 'test' } } = {}) {
  return { id, category, verdict, weight, confidence, title: '测试信号', detail: '测试用途', evidence };
}

const neutral = (weight, confidence, category) =>
  sig({ verdict: 'neutral', weight, confidence, category });
const relay = (weight, confidence, category) =>
  sig({ verdict: 'relay', weight, confidence, category });
const official = (weight, confidence, category) =>
  sig({ verdict: 'official', weight, confidence, category });

/* ------------------------------------------------------------------ */
/* 阈值常量与导出形状                                                    */
/* ------------------------------------------------------------------ */

test('score.js 导出契约 2.4 要求的公开 API', () => {
  assert.equal(typeof scoreSignals, 'function', 'scoreSignals 必须是函数');
  assert.equal(typeof verdictFromScore, 'function', 'verdictFromScore 必须是函数');
  assert.equal(typeof VERDICT_LABELS, 'object');
  assert.equal(typeof VERDICT_TONES, 'object');
  for (const v of VALID_VERDICTS) {
    assert.equal(typeof VERDICT_LABELS[v], 'string', `VERDICT_LABELS 缺少 ${v}`);
    assert.equal(typeof VERDICT_TONES[v], 'string', `VERDICT_TONES 缺少 ${v}`);
  }
});

test('v1.2 降级闸门常量已导出且为 true（契约 2.4）', () => {
  assert.equal(REQUIRE_URL_EVIDENCE_FOR_OFFICIAL, true, 'REQUIRE_URL_EVIDENCE_FOR_OFFICIAL 必须导出且为 true');
});

test('v1.3 绝对量闸门常量已导出且为 15（契约 2.4）', () => {
  assert.equal(MIN_DIRECTIONAL_POINTS, 15, 'MIN_DIRECTIONAL_POINTS 必须是 15（刻意的保守设计，不得放宽）');
});

test('阈值常量与 CONTRACT 2.4 表格一致（0.40 / 70 / 58 / 42 / 30）', () => {
  assert.equal(VERDICT_THRESHOLDS.evidenceStrengthMin, 0.4);
  assert.equal(VERDICT_THRESHOLDS.relay, 70);
  assert.equal(VERDICT_THRESHOLDS.likelyRelay, 58);
  assert.equal(VERDICT_THRESHOLDS.likelyOfficial, 42);
  assert.equal(VERDICT_THRESHOLDS.official, 30);
  assert.ok(Number.isFinite(EVIDENCE_HALF) && EVIDENCE_HALF > 0, 'EVIDENCE_HALF 必须为正有限数');
});

/* ------------------------------------------------------------------ */
/* 空信号 / 中立信号：绝不能判成 official                               */
/* ------------------------------------------------------------------ */

test('空信号 → score 0 / evidenceStrength 0 / inconclusive', () => {
  const r = scoreSignals([]);
  assert.equal(r.score, 0);
  assert.equal(r.officialScore, 100);
  assert.equal(r.evidenceStrength, 0);
  assert.equal(r.verdict, 'inconclusive');
  assert.equal(r.relayPoints, 0);
  assert.equal(r.officialPoints, 0);
  assert.equal(r.neutralPoints, 0);
  assert.deepEqual(r.breakdown, {});
});

test('只有单条中立信号 → inconclusive（绝不能 official）', () => {
  const r = scoreSignals([neutral(60, 1, 'url')]);
  assert.equal(r.score, 0, '中立信号不得贡献方向分');
  assert.equal(r.relayPoints, 0);
  assert.equal(r.officialPoints, 0);
  assert.ok(r.neutralPoints > 0, '中立贡献应被统计');
  assert.equal(r.verdict, 'inconclusive');
});

test('[关键回归] 只有中立信号且累计贡献越过证据强度 0.40 时，仍必须 inconclusive', () => {
  // score.js 第 104 行注释的设计意图：完全没有方向证据时 score 保持 0，
  // 并「配合低证据强度判为 inconclusive」。若中立信号累计足够多，
  // evidenceStrength 会越过 0.40，此时必须仍然 inconclusive。
  // 典型现实场景：Cloudflare 403 边缘防护只会产生中性信号（见 constants.CALIBRATION）。
  const signals = [neutral(60, 0.9, 'headers'), neutral(60, 0.9, 'url')];
  const r = scoreSignals(signals);
  assert.equal(r.score, 0, '中立信号不得贡献方向分');
  assert.equal(r.officialPoints, 0);
  assert.ok(
    r.evidenceStrength >= 0.4,
    `本用例的目的是覆盖证据强度越界：期望 >= 0.40，实际 ${r.evidenceStrength}`
  );
  assert.equal(
    r.verdict,
    'inconclusive',
    `只有中立证据（neutralPoints=${r.neutralPoints}, evidenceStrength=${r.evidenceStrength}）时，` +
      `期望 inconclusive，实际 ${r.verdict} —— 无方向证据不得推出 official`
  );
});

test('scoreSignals 返回 directionalPoints，无方向证据时为 0（v1.1 修正字段）', () => {
  const neutralOnly = scoreSignals([neutral(60, 0.9, 'headers'), neutral(60, 0.9, 'url')]);
  assert.equal(typeof neutralOnly.directionalPoints, 'number', '必须返回 directionalPoints');
  assert.equal(neutralOnly.directionalPoints, 0);
  assert.equal(neutralOnly.verdict, 'inconclusive');

  const mixed = scoreSignals([relay(50, 1, 'url'), official(30, 1, 'url')]);
  assert.equal(mixed.directionalPoints, 80, 'relay + official 都应计入方向分');

  const withNeutral = scoreSignals([relay(50, 1, 'url'), neutral(60, 1, 'url')]);
  assert.equal(withNeutral.directionalPoints, 50, '中立信号不计入方向分');
});

test('中立信号不得逆转方向：relay + 大量中立仍为 relay', () => {
  const r = scoreSignals([
    relay(80, 1, 'signature'),
    neutral(100, 1, 'url'),
    neutral(100, 1, 'tls'),
    neutral(100, 1, 'headers')
  ]);
  assert.equal(r.score, 100);
  assert.equal(r.verdict, 'relay');
});

/* ------------------------------------------------------------------ */
/* v1.2 域名身份降级闸门（防「反向代理透传官方头」漏判）                    */
/* ------------------------------------------------------------------ */

const officialSignal = (id, category, weight, confidence) =>
  sig({ id, category, verdict: 'official', weight, confidence });
const relaySignal = (id, category, weight, confidence) =>
  sig({ id, category, verdict: 'relay', weight, confidence });
const neutralSignal = (id, category, weight, confidence) =>
  sig({ id, category, verdict: 'neutral', weight, confidence });

/** 反向代理透传的官方响应头 + 官方错误报文（无任何 url 域名身份证据）。 */
const TRANSPARENT_OFFICIAL_HEADERS = () => [
  officialSignal('headers.openai_version', 'headers', 34, 0.55),
  officialSignal('headers.openai_processing_ms', 'headers', 26, 0.5),
  officialSignal('headers.openai_organization', 'headers', 22, 0.5),
  officialSignal('error.openai_shape', 'error', 45, 0.6)
];

test('flags 结构完整（契约 2.4 v1.2/v1.3）', () => {
  const r = scoreSignals([]);
  assert.equal(typeof r.flags, 'object', '必须返回 flags');
  for (const key of [
    'hasDirectionalEvidence',
    'urlIdentityConfirmed',
    'officialDowngraded',
    'insufficientDirectionalPoints',
    'upstreamLooksGenuine'
  ]) {
    assert.equal(typeof r.flags[key], 'boolean', `flags.${key} 必须是布尔`);
  }
  assert.equal(r.flags.hasDirectionalEvidence, false);
  assert.equal(r.flags.urlIdentityConfirmed, false);
  assert.equal(r.flags.officialDowngraded, false);
  assert.equal(r.flags.insufficientDirectionalPoints, false);
  assert.equal(r.flags.upstreamLooksGenuine, false);
});

test('[关键回归] 透传官方响应头 + 官方错误报文（无域名身份）→ 必须 inconclusive', () => {
  // 反向代理会把真实 api.openai.com 的官方头与官方错误报文原样透传。
  // 「响应头像官方」只证明上游是真的，不证明你直连官方。
  const r = scoreSignals(TRANSPARENT_OFFICIAL_HEADERS());
  assert.equal(r.score, 0, '官方方向证据不得产生 relay 分');
  assert.ok(Math.abs(r.officialPoints - 71.4) < 0.01, `officialPoints 期望 ≈71.4，实际 ${r.officialPoints}`);
  assert.equal(r.flags.hasDirectionalEvidence, true);
  assert.equal(r.flags.urlIdentityConfirmed, false);
  assert.equal(r.flags.officialDowngraded, true, '无 url 身份证据时必须降级');
  assert.equal(r.flags.upstreamLooksGenuine, true, '上游看起来是真的官方实现');
  assert.equal(r.verdict, 'inconclusive', `期望 inconclusive，实际 ${r.verdict}`);
});

test('[关键回归] 未知域名 + 强官方响应头 → 必须 inconclusive（不是 official）', () => {
  const r = scoreSignals([
    ...TRANSPARENT_OFFICIAL_HEADERS(),
    neutralSignal('url.non_official_host', 'url', 20, 0.5)
  ]);
  assert.equal(r.flags.urlIdentityConfirmed, false);
  assert.equal(r.flags.officialDowngraded, true);
  assert.equal(r.verdict, 'inconclusive');
  assert.ok(!['official', 'likely-official'].includes(r.verdict));
});

test('真正官方直连（含 url 域名身份信号）→ official 且不降级', () => {
  const r = scoreSignals([
    officialSignal('url.official_host', 'url', 70, 0.95),
    officialSignal('headers.openai_version', 'headers', 34, 0.55)
  ]);
  assert.equal(r.score, 0);
  assert.equal(r.flags.urlIdentityConfirmed, true, 'url 类 official 信号必须确认域名身份');
  assert.equal(r.flags.officialDowngraded, false);
  assert.equal(r.flags.upstreamLooksGenuine, false);
  assert.equal(r.verdict, 'official', `期望 official，实际 ${r.verdict}`);
});

test('降级闸门不影响 relay 判定：有中转证据时方向仍为 relay 方向', () => {
  const r = scoreSignals([relaySignal('signature.one_api', 'signature', 80, 1), ...TRANSPARENT_OFFICIAL_HEADERS()]);
  assert.equal(r.score, 61, 'relay 112 分 / official 71.4 分 → 61');
  assert.equal(r.flags.urlIdentityConfirmed, false);
  assert.equal(r.flags.officialDowngraded, false, 'relay 方向判定期不得触发官方降级');
  assert.ok(
    ['relay', 'likely-relay'].includes(r.verdict),
    `有强中转证据时方向必须为 relay 方向（relay / likely-relay），实际 ${r.verdict}`
  );
});

test('降级仅在 official / likely-official 时发生（inconclusive 不置 officialDowngraded）', () => {
  const r = scoreSignals([
    officialSignal('headers.openai_version', 'headers', 10, 0.2),
    neutralSignal('url.non_official_host', 'url', 20, 0.5)
  ]);
  // 无 url official 证据，但 evidenceStrength 过低 → 本就 inconclusive，不应标记为「被降级」
  assert.equal(r.flags.urlIdentityConfirmed, false);
  assert.equal(r.verdict, 'inconclusive');
  assert.ok(r.evidenceStrength < 0.4);
  assert.equal(r.flags.officialDowngraded, false, '未被判定为 official 就不算降级');
});

/* ------------------------------------------------------------------ */
/* v1.3 绝对量闸门 MIN_DIRECTIONAL_POINTS = 15                          */
/* ------------------------------------------------------------------ */

/** 抬高 evidenceStrength 的中立信号（不产生方向分）。 */
const NEUTRAL_BOOST = () => neutralSignal('url.neutral_observation', 'url', 100, 0.85);

test('[我发现的遗留风险回归] 极弱 relay 证据 + 充足中立证据 → inconclusive（v1.3）', () => {
  // 修复前：score=100、evidenceStrength=0.4307 → verdict='relay'（「高度确信是中转站」），
  // 而绝对 relay 证据只有 4.76 分。这是 verifier 发现的 score 比例制放大问题。
  const r = scoreSignals([relaySignal('headers.gateway_server', 'headers', 14, 0.4), NEUTRAL_BOOST()]);
  assert.equal(r.score, 100, '比例制下仍是 100（这正是需要绝对量兜底的原因）');
  assert.ok(Math.abs(r.relayPoints - 4.76) < 0.01, `relayPoints 期望 4.76，实际 ${r.relayPoints}`);
  assert.ok(r.evidenceStrength >= 0.4, `本用例需覆盖「证据强度已达标」：实际 ${r.evidenceStrength}`);
  assert.equal(r.verdict, 'inconclusive', `绝对证据量不足时必须 inconclusive，实际 ${r.verdict}`);
  assert.equal(r.flags.insufficientDirectionalPoints, true, '必须标记 insufficientDirectionalPoints');
});

test('绝对量闸门边界：relayPoints 恰好 15 可通过，14.5 必须拦截（v1.3）', () => {
  const atBoundary = scoreSignals([relaySignal('url.relay_feature', 'url', 30, 0.5), NEUTRAL_BOOST()]);
  assert.equal(atBoundary.relayPoints, 15, 'url 类 30×0.5 = 15.0');
  assert.ok(atBoundary.evidenceStrength >= 0.4);
  assert.equal(atBoundary.score, 100);
  assert.equal(atBoundary.verdict, 'relay', `恰好达到下限应可判 relay，实际 ${atBoundary.verdict}`);
  assert.equal(atBoundary.flags.insufficientDirectionalPoints, false);

  const below = scoreSignals([relaySignal('url.relay_feature', 'url', 29, 0.5), NEUTRAL_BOOST()]);
  assert.equal(below.relayPoints, 14.5, 'url 类 29×0.5 = 14.5');
  assert.ok(below.evidenceStrength >= 0.4);
  assert.equal(below.score, 100);
  assert.equal(below.verdict, 'inconclusive', `低于下限必须 inconclusive，实际 ${below.verdict}`);
  assert.equal(below.flags.insufficientDirectionalPoints, true);
});

test('绝对量下限对 official 方向同样生效，且与 officialDowngraded 相互独立（v1.3）', () => {
  // 有 url 域名身份 ⇒ 不触发 officialDowngraded；但 officialPoints=10 < 15 ⇒ 绝对量闸门生效
  const weakOfficial = scoreSignals([officialSignal('url.official_host', 'url', 10, 1), NEUTRAL_BOOST()]);
  assert.equal(weakOfficial.officialPoints, 10);
  assert.ok(weakOfficial.evidenceStrength >= 0.4);
  assert.equal(weakOfficial.flags.urlIdentityConfirmed, true);
  assert.equal(weakOfficial.flags.officialDowngraded, false, '有域名身份时不应触发官方降级');
  assert.equal(weakOfficial.flags.insufficientDirectionalPoints, true, 'official 方向同样受绝对量下限约束');
  assert.equal(weakOfficial.verdict, 'inconclusive');

  // 无 url 身份且绝对量也不足：先被 officialDowngraded 拦下，绝对量闸门不再重复置位
  const weakHeadersOnly = scoreSignals([officialSignal('headers.openai_version', 'headers', 10, 1), NEUTRAL_BOOST()]);
  assert.equal(weakHeadersOnly.flags.officialDowngraded, true);
  assert.equal(weakHeadersOnly.flags.insufficientDirectionalPoints, false, '已被上一闸门降级时不重复标记');
  assert.equal(weakHeadersOnly.verdict, 'inconclusive');
});

test('强方向证据不受绝对量闸门影响（v1.3）', () => {
  const strongRelay = scoreSignals([relay(62, 0.75, 'signature')]);
  assert.ok(Math.abs(strongRelay.relayPoints - 65.1) < 0.01, `signature 62×0.75×1.4 = 65.1，实际 ${strongRelay.relayPoints}`);
  assert.equal(strongRelay.verdict, 'relay');
  assert.equal(strongRelay.flags.insufficientDirectionalPoints, false);

  const strongOfficial = scoreSignals([officialSignal('url.official_host', 'url', 70, 0.95)]);
  assert.ok(strongOfficial.officialPoints >= 15, `officialPoints=${strongOfficial.officialPoints} 应达标`);
  assert.equal(strongOfficial.verdict, 'official');
  assert.equal(strongOfficial.flags.insufficientDirectionalPoints, false);
});

/* ------------------------------------------------------------------ */
/* 方向判定                                                             */
/* ------------------------------------------------------------------ */

test('单条高权重 relay 信号 → 方向 relay 且 evidenceStrength 充足', () => {
  const r = scoreSignals([relay(80, 1, 'signature')]);
  assert.equal(r.score, 100);
  assert.ok(r.evidenceStrength >= 0.4);
  assert.equal(r.verdict, 'relay');
});

test('单条高权重 official 信号 → 方向 official 且绝不 relay', () => {
  const r = scoreSignals([official(80, 1, 'url')]);
  assert.equal(r.score, 0);
  assert.equal(r.officialScore, 100);
  assert.ok(VALID_VERDICTS.includes(r.verdict));
  assert.ok(!['relay', 'likely-relay'].includes(r.verdict), `不得判为 relay，实际 ${r.verdict}`);
});

test('官方正向信号多于 relay → 方向 official', () => {
  const r = scoreSignals([
    official(60, 1, 'url'),
    official(60, 1, 'url'),
    relay(50, 1, 'behavior') // 类别权重 0.5 → 25 分
  ]);
  assert.equal(r.relayPoints, 25);
  assert.equal(r.officialPoints, 120);
  assert.equal(r.score, 17, '方向分应为 25/(25+120)=17.2 → 17');
  assert.ok(r.evidenceStrength >= 0.4);
  assert.equal(r.verdict, 'official');
});

test('relay 与 official 等权时 score 为 50 → inconclusive（42..58 区间）', () => {
  const r = scoreSignals([relay(50, 1, 'url'), official(50, 1, 'url')]);
  assert.equal(r.score, 50);
  assert.equal(r.verdict, 'inconclusive');
});

test('score 与 officialScore 互补且都在 0..100', () => {
  for (const signals of [[], [relay(63, 0.77, 'error')], [official(31, 0.9, 'tls'), relay(17, 0.4, 'models')]]) {
    const r = scoreSignals(signals);
    assert.ok(r.score >= 0 && r.score <= 100, `score 越界: ${r.score}`);
    assert.ok(r.officialScore >= 0 && r.officialScore <= 100, `officialScore 越界: ${r.officialScore}`);
    assert.equal(r.officialScore, 100 - r.score);
  }
});

test('方向比例只由有方向证据决定（分母不含 neutral）', () => {
  const r = scoreSignals([relay(40, 1, 'url'), neutral(100, 1, 'url')]);
  assert.equal(r.score, 100, '中立信号不得稀释 relay 方向比例');
  assert.equal(r.neutralPoints, 100);
});

/* ------------------------------------------------------------------ */
/* verdictFromScore 全部阈值边界                                          */
/* ------------------------------------------------------------------ */

test('verdictFromScore：证据强度 0.40 边界（< 0.40 一律 inconclusive）', () => {
  for (const score of [0, 29, 41, 57, 69, 70, 100]) {
    assert.equal(verdictFromScore(score, 0.3999), 'inconclusive', `e=0.3999, score=${score} 必须 inconclusive`);
  }
  assert.equal(verdictFromScore(100, 0.4), 'relay', 'e 恰好 0.40 时应进入分数判定');
});

test('verdictFromScore 方向证据硬闸门：hasDirectionalEvidence=false 一律 inconclusive（v1.1）', () => {
  assert.equal(verdictFromScore(0, 0.9, false), 'inconclusive');
  assert.equal(verdictFromScore(100, 1, false), 'inconclusive', '即使 score 达 relay 阈值，无方向证据也必须 inconclusive');
  assert.equal(verdictFromScore(50, 0.5, false), 'inconclusive');
  assert.equal(verdictFromScore(0, 0, false), 'inconclusive');
  assert.equal(verdictFromScore(NaN, NaN, false), 'inconclusive');
});

test('verdictFromScore 第三参数默认 true，保持向后兼容', () => {
  assert.equal(verdictFromScore(0, 0.9), 'official', '省略第三参时行为与 v1 一致');
  assert.equal(verdictFromScore(0, 0.9, true), 'official');
  assert.equal(verdictFromScore(NaN, NaN), 'inconclusive', '默认 true，但 e=0 仍由证据强度闸门拦下');
});

test('verdictFromScore：分数 70 / 58 / 42 / 30 边界', () => {
  const e = 0.6;
  assert.equal(verdictFromScore(100, e), 'relay');
  assert.equal(verdictFromScore(70, e), 'relay');
  assert.equal(verdictFromScore(69.999, e), 'likely-relay');
  assert.equal(verdictFromScore(58, e), 'likely-relay');
  assert.equal(verdictFromScore(57.999, e), 'inconclusive');
  assert.equal(verdictFromScore(42, e), 'inconclusive');
  assert.equal(verdictFromScore(41.999, e), 'likely-official');
  assert.equal(verdictFromScore(30, e), 'likely-official');
  assert.equal(verdictFromScore(29.999, e), 'official');
  assert.equal(verdictFromScore(0, e), 'official');
});

test('verdictFromScore：非法输入安全处理（clamp + 非有限数视为 0）', () => {
  assert.equal(verdictFromScore(NaN, NaN), 'inconclusive', 'NaN 证据强度按 0 处理');
  assert.equal(verdictFromScore(undefined, 0.9), 'official', 'undefined score 按 0 处理');
  assert.equal(verdictFromScore(150, 0.9), 'relay', 'score 上限 clamp 到 100');
  assert.equal(verdictFromScore(-10, 0.9), 'official', 'score 下限 clamp 到 0');
  assert.equal(verdictFromScore(50, 5), 'inconclusive', 'evidenceStrength 上限 clamp 到 1，score 50 落 inconclusive 区');
  assert.equal(verdictFromScore(90, 'not-a-number'), 'inconclusive', '非数字证据强度按 0 处理');
});

/* ------------------------------------------------------------------ */
/* 类别权重与贡献计算                                                     */
/* ------------------------------------------------------------------ */

test('类别权重确实生效：同权重信号在不同类别贡献不同', () => {
  const s = (category) => ({ weight: 100, confidence: 1, category });
  assert.equal(contributionOf(s('signature')), 140, 'signature 权重 1.4');
  assert.equal(contributionOf(s('error')), 130, 'error 权重 1.3');
  assert.equal(contributionOf(s('behavior')), 50, 'behavior 权重 0.5');
  assert.equal(contributionOf(s('headers')), 85, 'headers 权重 0.85');
  assert.ok(contributionOf(s('signature')) > contributionOf(s('behavior')));
});

test('贡献 = weight × confidence × categoryWeight', () => {
  assert.equal(contributionOf({ weight: 50, confidence: 0.5, category: 'tls' }), 31.25);
});

test('自定义 categoryWeights 覆盖默认表', () => {
  const signals = [relay(40, 1, 'headers')];
  assert.equal(scoreSignals(signals).relayPoints, 34, '默认 headers=0.85 → 34');
  assert.equal(scoreSignals(signals, { headers: 1.7 }).relayPoints, 68, '覆盖后应翻倍');
  assert.equal(scoreSignals(signals, {}).relayPoints, 40, '未定义类别回退系数 1');
});

test('weight / confidence 越界时被 clamp', () => {
  assert.equal(contributionOf({ weight: 500, confidence: 1, category: 'url' }), 100, 'weight clamp 到 100');
  assert.equal(contributionOf({ weight: -20, confidence: 1, category: 'url' }), 0, 'weight clamp 到 0');
  assert.equal(contributionOf({ weight: 100, confidence: 9, category: 'url' }), 100, 'confidence clamp 到 1');
  assert.equal(contributionOf({ weight: 100, confidence: -1, category: 'url' }), 0, 'confidence clamp 到 0');
});

test('contributionOf 对非法输入返回 0 且不抛错', () => {
  for (const bad of [null, undefined, 42, 'signal', true, Symbol('x'), () => {}]) {
    assert.doesNotThrow(() => contributionOf(bad), `contributionOf(${String(bad)}) 不得抛错`);
    assert.equal(contributionOf(bad), 0, `contributionOf(${String(bad)}) 应为 0`);
  }
  assert.equal(contributionOf({}), 0, '缺字段对象应为 0');
  assert.equal(contributionOf({ weight: NaN, confidence: NaN, category: 'url' }), 0, 'NaN 按 0 处理');
  assert.equal(contributionOf({ weight: '60', confidence: 1, category: 'url' }), 0, '字符串 weight 不得被当作数字');
});

/* ------------------------------------------------------------------ */
/* 汇总与排序                                                            */
/* ------------------------------------------------------------------ */

test('scoreSignals 对非数组 / 垃圾输入不抛错', () => {
  for (const bad of [null, undefined, 0, 'x', {}, [null, 1, 'a', undefined]]) {
    assert.doesNotThrow(() => scoreSignals(bad), `scoreSignals(${String(bad)}) 不得抛错`);
    assert.equal(scoreSignals(bad).verdict, 'inconclusive');
    assert.equal(scoreSignals(bad).score, 0);
  }
});

test('未知 verdict 值一律按中立处理', () => {
  const r = scoreSignals([sig({ verdict: 'weird', weight: 100, confidence: 1, category: 'url' })]);
  assert.equal(r.score, 0);
  assert.equal(r.relayPoints, 0);
  assert.equal(r.officialPoints, 0);
  assert.equal(r.neutralPoints, 100);
});

test('breakdown 按类别分别累计 relay / official / neutral', () => {
  const r = scoreSignals([
    relay(50, 1, 'error'), // 65
    official(50, 1, 'error'), // 65
    neutral(50, 1, 'error') // 65
  ]);
  assert.deepEqual(Object.keys(r.breakdown), ['error']);
  assert.equal(r.breakdown.error.relay, 65);
  assert.equal(r.breakdown.error.official, 65);
  assert.equal(r.breakdown.error.neutral, 65);
  assert.equal(r.relayPoints, 65);
  assert.equal(r.officialPoints, 65);
  assert.equal(r.neutralPoints, 65);
});

test('evidenceStrength 单调递增且始终落在 [0,1]', () => {
  let prev = -1;
  for (const n of [0, 10, 25, 50, 100, 400, 10000]) {
    const r = scoreSignals(n === 0 ? [] : [relay(n, 1, 'url')]);
    assert.ok(r.evidenceStrength >= 0 && r.evidenceStrength <= 1, `越界: ${r.evidenceStrength}`);
    assert.ok(r.evidenceStrength >= prev, 'evidenceStrength 应随证据增加单调不减');
    prev = r.evidenceStrength;
  }
});

test('sortSignalsByContribution 按贡献降序，且并列时保持原顺序（稳定）', () => {
  const a = sig({ id: 'headers.a', weight: 10, confidence: 1, category: 'url' }); // 10
  const b = sig({ id: 'headers.b', weight: 90, confidence: 1, category: 'behavior' }); // 45
  const c = sig({ id: 'headers.c', weight: 50, confidence: 1, category: 'url' }); // 50
  const d = sig({ id: 'headers.d', weight: 45, confidence: 1, category: 'behavior' }); // 22.5
  const sorted = sortSignalsByContribution([a, b, c, d]);
  assert.deepEqual(
    sorted.map((s) => s.id),
    ['headers.c', 'headers.b', 'headers.d', 'headers.a']
  );

  const t1 = sig({ id: 'headers.t1', weight: 20, confidence: 1, category: 'url' });
  const t2 = sig({ id: 'headers.t2', weight: 20, confidence: 1, category: 'url' });
  assert.deepEqual(
    sortSignalsByContribution([t1, t2]).map((s) => s.id),
    ['headers.t1', 'headers.t2'],
    '并列贡献应保持输入顺序'
  );
});

test('sortSignalsByContribution 对非数组不抛错', () => {
  for (const bad of [null, undefined, 0, 'x']) {
    assert.doesNotThrow(() => sortSignalsByContribution(bad));
    assert.deepEqual(sortSignalsByContribution(bad), []);
  }
});

test('CATEGORY_WEIGHTS 覆盖契约 1.3 的全部类别', () => {
  for (const cat of ['url', 'tls', 'headers', 'error', 'models', 'payload', 'behavior', 'signature']) {
    assert.equal(typeof CATEGORY_WEIGHTS[cat], 'number', `缺少类别权重 ${cat}`);
    assert.ok(CATEGORY_WEIGHTS[cat] > 0, `${cat} 权重必须为正`);
  }
});
