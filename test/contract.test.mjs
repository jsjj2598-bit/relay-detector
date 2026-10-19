/**
 * 契约一致性测试（docs/CONTRACT.md FROZEN v1，含 v1.1/v1.2 修正）。
 *
 * 覆盖：
 *  - 2.4 score.js / 2.5 constants.js 的导出形状
 *  - 1.3 Signal 形状约束（id 命名空间、weight/confidence 范围、evidence、verdict）
 *  - 1.4 DetectionReport 形状与 signals 排序、byCategory 一致性
 *  - 1.1 ProbeResult 形状（小写响应头、脱敏、bodyText 截断）
 *  - 2.1 detect() 绝不抛异常 + fixture 端到端期望（含关键回归）
 *  - 2.1 normalizeBaseUrl / pickProvider 纯函数行为
 *  - 密钥脱敏 / allowPaidProbes=false 不产生费用
 *
 * 本文件只读源码。engine 未交付时相关用例显式 skip（不静默放宽）。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import * as constants from '../src/core/constants.js';
import * as score from '../src/core/score.js';
import { loadAllFixtures, loadFixture, createFakeTransport } from './fixtures/index.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');
const ENGINE_FILE = path.join(ROOT, 'src', 'core', 'engine.js');
const RULES_INDEX_FILE = path.join(ROOT, 'src', 'core', 'rules', 'index.js');

/** engine 未交付 → null（相关用例 skip）；已存在但 import 失败 → 直接抛错暴露真实问题。 */
const engine = fs.existsSync(ENGINE_FILE) ? await import(pathToFileURL(ENGINE_FILE).href) : null;

const PROVIDERS = ['openai', 'anthropic', 'gemini'];
/** DetectionReport.verdict 的取值（契约 1.4）。 */
const VERDICTS = ['relay', 'likely-relay', 'inconclusive', 'likely-official', 'official'];
/** Signal.verdict 的取值（契约 1.3）——与报告级 verdict 不同，只有三种。 */
const SIGNAL_VERDICTS = ['relay', 'official', 'neutral'];
const CATEGORIES = ['url', 'tls', 'headers', 'error', 'models', 'payload', 'behavior', 'signature'];
const CATEGORY_PREFIX = {
  url: 'url.',
  tls: 'tls.',
  headers: 'headers.',
  error: 'error.',
  models: 'models.',
  payload: 'payload.',
  behavior: 'behavior.',
  signature: 'signature.'
};
const PROBE_KINDS = ['models', 'chat', 'error', 'root', 'tls'];
const ERROR_KINDS = ['network', 'cors', 'timeout', 'http', 'aborted'];

const skipEngine = (t) => t.skip('engine 未交付：src/core/engine.js 不存在（等待 engine 落地后重跑）');

/* ------------------------------------------------------------------ */
/* 形状校验器                                                           */
/* ------------------------------------------------------------------ */

function assertSignalValid(s, label) {
  assert.ok(s && typeof s === 'object', `${label}: Signal 必须是对象`);
  assert.equal(typeof s.id, 'string', `${label}: id 必须是字符串`);
  assert.ok(s.id.length > 0, `${label}: id 不得为空`);
  assert.ok(CATEGORIES.includes(s.category), `${label}: 非法 category "${s.category}"`);
  assert.ok(
    s.id.startsWith(CATEGORY_PREFIX[s.category]),
    `${label}: id "${s.id}" 前缀与 category "${s.category}" 不匹配（契约 §3）`
  );
  assert.ok(SIGNAL_VERDICTS.includes(s.verdict), `${label}: 非法 Signal.verdict "${s.verdict}"（契约 1.3 只允许 relay/official/neutral）`);
  assert.equal(typeof s.weight, 'number', `${label}: weight 必须是数字`);
  assert.ok(s.weight >= 0 && s.weight <= 100, `${label}: weight 越界 ${s.weight}`);
  assert.equal(typeof s.confidence, 'number', `${label}: confidence 必须是数字`);
  assert.ok(s.confidence >= 0 && s.confidence <= 1, `${label}: confidence 越界 ${s.confidence}`);
  assert.equal(typeof s.title, 'string', `${label}: title 必须是字符串`);
  assert.equal(typeof s.detail, 'string', `${label}: detail 必须是字符串`);
  assert.ok('evidence' in s && s.evidence !== undefined && s.evidence !== null, `${label}: 必须有 evidence`);
  assert.doesNotThrow(() => JSON.stringify(s.evidence), `${label}: evidence 必须可序列化`);
}

function assertProbeValid(p, label) {
  assert.ok(p && typeof p === 'object', `${label}: ProbeResult 必须是对象`);
  assert.equal(typeof p.id, 'string', `${label}: probe.id 必须是字符串`);
  assert.ok(PROVIDERS.includes(p.provider), `${label}: 非法 provider "${p.provider}"`);
  assert.ok(PROBE_KINDS.includes(p.kind), `${label}: 非法 kind "${p.kind}"`);

  const req = p.request;
  assert.ok(req && typeof req === 'object', `${label}: request 必须是对象`);
  assert.equal(typeof req.method, 'string');
  assert.equal(typeof req.url, 'string');
  assert.ok(req.headersSent === null || typeof req.headersSent === 'object', `${label}: headersSent 形状非法`);
  assert.ok(req.bodySent === null || typeof req.bodySent === 'object', `${label}: bodySent 形状非法`);
  assert.equal(typeof req.startedAt, 'number');
  assert.equal(typeof req.durationMs, 'number');
  assert.ok(req.durationMs >= 0, `${label}: durationMs 不得为负`);

  if (p.response !== null) {
    const r = p.response;
    assert.equal(typeof r.status, 'number', `${label}: response.status 必须是数字`);
    assert.ok(r.headers && typeof r.headers === 'object', `${label}: response.headers 必须是对象`);
    for (const k of Object.keys(r.headers)) {
      assert.equal(k, k.toLowerCase(), `${label}: response.headers 键必须小写（契约 1.1）实际 "${k}"`);
    }
    assert.equal(typeof r.bodyText, 'string', `${label}: bodyText 必须是字符串`);
    assert.ok(r.bodyText.length <= 20000, `${label}: bodyText 必须截断到 20000 以内（契约 1.1）`);
    assert.ok(r.bodyJson === null || typeof r.bodyJson === 'object', `${label}: bodyJson 形状非法`);
    assert.equal(typeof r.contentType, 'string', `${label}: contentType 必须是字符串`);
  } else {
    assert.ok(p.error, `${label}: response 与 error 不得同时为 null`);
  }

  if (p.error !== null) {
    assert.ok(ERROR_KINDS.includes(p.error.kind), `${label}: 非法 error.kind "${p.error.kind}"`);
    assert.equal(typeof p.error.message, 'string', `${label}: error.message 必须是字符串`);
  }
  assert.ok(p.meta && typeof p.meta === 'object', `${label}: meta 必须是对象`);
}

function assertReportValid(report, label) {
  assert.ok(report && typeof report === 'object', `${label}: DetectionReport 必须是对象`);
  assert.equal(report.schema, 1, `${label}: schema 必须为 1`);

  const tg = report.target;
  assert.ok(tg && typeof tg === 'object', `${label}: target 必须是对象`);
  assert.equal(typeof tg.input, 'string', `${label}: target.input`);
  assert.equal(typeof tg.baseUrl, 'string', `${label}: target.baseUrl`);
  assert.ok(!tg.baseUrl.endsWith('/'), `${label}: baseUrl 不得有尾斜杠（"${tg.baseUrl}"）`);
  assert.equal(typeof tg.host, 'string', `${label}: target.host`);
  assert.ok(PROVIDERS.includes(tg.provider), `${label}: 非法 target.provider "${tg.provider}"`);
  assert.ok(['explicit', 'auto'].includes(tg.providerSource), `${label}: 非法 providerSource "${tg.providerSource}"`);
  assert.ok(
    tg.matchedOfficialHost === null || typeof tg.matchedOfficialHost === 'string',
    `${label}: matchedOfficialHost 形状非法`
  );

  assert.ok(['browser', 'proxy'].includes(report.mode), `${label}: 非法 mode "${report.mode}"`);
  assert.equal(typeof report.score, 'number', `${label}: score 必须是数字`);
  assert.ok(report.score >= 0 && report.score <= 100, `${label}: score 越界 ${report.score}`);
  assert.equal(report.officialScore, 100 - report.score, `${label}: officialScore 必须为 100-score`);
  assert.equal(typeof report.evidenceStrength, 'number');
  assert.ok(report.evidenceStrength >= 0 && report.evidenceStrength <= 1, `${label}: evidenceStrength 越界`);
  assert.ok(VERDICTS.includes(report.verdict), `${label}: 非法 verdict "${report.verdict}"`);

  assert.ok(Array.isArray(report.signals), `${label}: signals 必须是数组`);
  const seen = new Set();
  for (const s of report.signals) {
    assertSignalValid(s, `${label}/signal:${s && s.id}`);
    assert.ok(!seen.has(s.id), `${label}: signal id 重复 "${s.id}"（契约 1.3：同一 id 最多一次）`);
    seen.add(s.id);
  }
  // 必须按贡献降序（契约 1.4）
  const contribs = report.signals.map((s) => score.contributionOf(s));
  for (let i = 1; i < contribs.length; i++) {
    assert.ok(
      contribs[i - 1] + 1e-9 >= contribs[i],
      `${label}: signals 未按贡献降序（${report.signals[i - 1].id}=${contribs[i - 1].toFixed(2)} < ${report.signals[i].id}=${contribs[i].toFixed(2)}）`
    );
  }

  assert.ok(report.byCategory && typeof report.byCategory === 'object', `${label}: byCategory 必须是对象`);
  for (const cat of CATEGORIES) {
    assert.ok(Array.isArray(report.byCategory[cat]), `${label}: byCategory.${cat} 必须是数组`);
    const expectedIds = report.signals.filter((s) => s.category === cat).map((s) => s.id);
    assert.deepEqual(
      report.byCategory[cat].map((s) => s.id),
      expectedIds,
      `${label}: byCategory.${cat} 与 signals 不一致`
    );
  }

  assert.ok(Array.isArray(report.probes), `${label}: probes 必须是数组`);
  const probeIds = new Set();
  for (const p of report.probes) {
    assertProbeValid(p, `${label}/probe:${p && p.id}`);
    assert.ok(!probeIds.has(p.id), `${label}: probe id 重复 "${p.id}"`);
    probeIds.add(p.id);
  }

  const caps = report.capabilities;
  assert.ok(caps && typeof caps === 'object', `${label}: capabilities 必须是对象`);
  for (const k of ['canReadHeaders', 'tlsAvailable', 'corsBlocked', 'networkReachable', 'costIncurred']) {
    assert.equal(typeof caps[k], 'boolean', `${label}: capabilities.${k} 必须是布尔`);
  }

  assert.ok(Array.isArray(report.notes), `${label}: notes 必须是数组`);
  for (const n of report.notes) assert.equal(typeof n, 'string', `${label}: notes 元素必须是字符串`);

  for (const k of ['startedAt', 'finishedAt', 'durationMs']) {
    assert.equal(typeof report[k], 'number', `${label}: ${k} 必须是数字`);
    assert.ok(Number.isFinite(report[k]), `${label}: ${k} 必须有限`);
  }
  assert.ok(report.durationMs >= 0, `${label}: durationMs 不得为负`);
}

/** fixture → detect() 参数。 */
function detectArgs(fixture, transport, extra = {}) {
  const explicit = fixture.target.providerSource === 'explicit';
  return {
    baseUrl: fixture.target.input,
    provider: explicit ? fixture.target.provider : 'auto',
    mode: fixture.mode || 'browser',
    transport,
    options: { ...(fixture.options || {}) },
    ...extra
  };
}

/* ------------------------------------------------------------------ */
/* 2.5 constants.js                                                     */
/* ------------------------------------------------------------------ */

test('constants.js 导出契约 2.5 要求的全部常量', () => {
  for (const name of [
    'OFFICIAL_HOSTS',
    'OFFICIAL_HOST_PATTERNS',
    'OFFICIAL_TLS_ISSUERS',
    'OFFICIAL_MODEL_PREFIXES',
    'CATEGORY_WEIGHTS',
    'CATEGORY_LABELS',
    'PROVIDER_LABELS',
    'VERSION'
  ]) {
    assert.ok(name in constants, `constants.js 缺少导出 ${name}`);
  }
  assert.equal(typeof constants.VERSION, 'string');
  assert.match(constants.VERSION, /^\d+\.\d+\.\d+$/);

  for (const p of PROVIDERS) {
    assert.ok(Array.isArray(constants.OFFICIAL_HOSTS[p]) && constants.OFFICIAL_HOSTS[p].length > 0, `OFFICIAL_HOSTS.${p}`);
    assert.ok(Array.isArray(constants.OFFICIAL_MODEL_PREFIXES[p]), `OFFICIAL_MODEL_PREFIXES.${p}`);
    assert.equal(typeof constants.PROVIDER_LABELS[p], 'string', `PROVIDER_LABELS.${p}`);
  }
  assert.ok(constants.OFFICIAL_HOSTS.openai.includes('api.openai.com'));
  assert.ok(constants.OFFICIAL_HOSTS.anthropic.includes('api.anthropic.com'));
  assert.ok(constants.OFFICIAL_HOSTS.gemini.includes('generativelanguage.googleapis.com'));

  assert.ok(Array.isArray(constants.OFFICIAL_HOST_PATTERNS));
  for (const row of constants.OFFICIAL_HOST_PATTERNS) {
    assert.ok(row.pattern instanceof RegExp, 'OFFICIAL_HOST_PATTERNS.pattern 必须是 RegExp');
    assert.equal(typeof row.label, 'string');
    assert.ok(PROVIDERS.includes(row.provider));
  }

  assert.ok(Array.isArray(constants.OFFICIAL_TLS_ISSUERS));
  for (const row of constants.OFFICIAL_TLS_ISSUERS) {
    assert.ok(row.match instanceof RegExp, 'OFFICIAL_TLS_ISSUERS.match 必须是 RegExp');
    assert.equal(typeof row.confidence, 'number');
  }

  for (const cat of CATEGORIES) {
    assert.equal(typeof constants.CATEGORY_LABELS[cat], 'string', `CATEGORY_LABELS.${cat}`);
    assert.equal(typeof constants.CATEGORY_WEIGHTS[cat], 'number', `CATEGORY_WEIGHTS.${cat}`);
  }
  assert.deepEqual(constants.CATEGORY_WEIGHTS, score.CATEGORY_WEIGHTS, 'constants 的 CATEGORY_WEIGHTS 必须与 score.js 同源');
});

/* ------------------------------------------------------------------ */
/* 2.4 score.js                                                         */
/* ------------------------------------------------------------------ */

test('score.js 导出契约 2.4 要求的公开 API 与字段', () => {
  assert.equal(typeof score.scoreSignals, 'function');
  assert.equal(typeof score.verdictFromScore, 'function');
  assert.equal(typeof score.VERDICT_LABELS, 'object');
  assert.equal(typeof score.VERDICT_TONES, 'object');
  const r = score.scoreSignals([]);
  for (const k of ['score', 'officialScore', 'evidenceStrength', 'verdict', 'relayPoints', 'officialPoints', 'neutralPoints', 'directionalPoints', 'breakdown', 'flags']) {
    assert.ok(k in r, `scoreSignals 返回值缺少 ${k}`);
  }
  for (const k of [
    'hasDirectionalEvidence',
    'urlIdentityConfirmed',
    'officialDowngraded',
    'insufficientDirectionalPoints',
    'upstreamLooksGenuine'
  ]) {
    assert.equal(typeof r.flags[k], 'boolean', `flags.${k} 必须是布尔`);
  }
  assert.equal(score.REQUIRE_URL_EVIDENCE_FOR_OFFICIAL, true);
  assert.equal(score.MIN_DIRECTIONAL_POINTS, 15, '契约 2.4 v1.3：绝对量下限为 15');
});

/* ------------------------------------------------------------------ */
/* 2.1 engine 导出                                                       */
/* ------------------------------------------------------------------ */

test('engine.js 导出契约 2.1 / 2.2 / 2.3 要求的 API', (t) => {
  if (!engine) return skipEngine(t);
  for (const fn of ['detect', 'normalizeBaseUrl', 'pickProvider', 'createProxyTransport', 'runRules']) {
    assert.equal(typeof engine[fn], 'function', `engine.js 必须导出函数 ${fn}`);
  }
});

test('rules/index.js 的 COMMON_RULES 是函数数组（契约 2.3）', async (t) => {
  if (!fs.existsSync(RULES_INDEX_FILE)) return t.skip('rules/index.js 未交付');
  const mod = await import(pathToFileURL(RULES_INDEX_FILE).href);
  assert.ok(Array.isArray(mod.COMMON_RULES), 'COMMON_RULES 必须是数组');
  assert.ok(mod.COMMON_RULES.length > 0, 'COMMON_RULES 不得为空');
  for (const rule of mod.COMMON_RULES) assert.equal(typeof rule, 'function', 'COMMON_RULES 元素必须是函数');
});

/* ------------------------------------------------------------------ */
/* detect() 绝不抛异常 + DetectionReport 形状                            */
/* ------------------------------------------------------------------ */

test('detect() 对全部 fixture 不抛异常且产出合法 DetectionReport', async (t) => {
  if (!engine) return skipEngine(t);
  for (const fixture of loadAllFixtures()) {
    const transport = createFakeTransport(fixture);
    let report;
    await assert.doesNotReject(async () => {
      report = await engine.detect(detectArgs(fixture, transport));
    }, `${fixture.id}: detect() 不得抛异常`);
    assertReportValid(report, fixture.id);
  }
});

test('detect() 面对异常 transport / 畸形响应仍不抛异常', async (t) => {
  if (!engine) return skipEngine(t);
  const base = { baseUrl: 'https://weird.example.com/v1', mode: 'browser', options: { timeoutMs: 500 } };

  const throwingString = async () => {
    throw 'string-error-not-an-Error';
  };
  await assert.doesNotReject(() => engine.detect({ ...base, transport: throwingString }), 'transport 抛字符串时不得抛出');

  const notAResponse = async () => ({ not: 'a Response' });
  await assert.doesNotReject(() => engine.detect({ ...base, transport: notAResponse }), 'transport 返回非 Response 时不得抛出');

  const malformedJson = async () =>
    new Response('{ this is not json', { status: 200, headers: { 'content-type': 'application/json' } });
  const report = await engine.detect({ ...base, transport: malformedJson });
  assertReportValid(report, 'malformed-json');

  const emptyBody = async () => new Response(null, { status: 204 });
  await assert.doesNotReject(() => engine.detect({ ...base, transport: emptyBody }), '204 空响应不得抛出');
});

/* ------------------------------------------------------------------ */
/* fixture 端到端期望（含关键回归）                                        */
/* ------------------------------------------------------------------ */

test('[关键回归] Cloudflare 边缘防护 403（非官方域名）必须 inconclusive', async (t) => {
  if (!engine) return skipEngine(t);
  const fixture = loadFixture('cloudflare-403');
  const report = await engine.detect(detectArgs(fixture, createFakeTransport(fixture)));
  assertReportValid(report, 'cloudflare-403');
  assert.ok(
    !['relay', 'likely-relay'].includes(report.verdict),
    `Cloudflare 403 边缘防护被误判为中转站：verdict=${report.verdict}（score=${report.score}, evidenceStrength=${report.evidenceStrength}）`
  );
  assert.equal(
    report.verdict,
    'inconclusive',
    `期望 inconclusive（无 API 鉴权报文，仅有中性边缘证据），实际 ${report.verdict}（score=${report.score}, evidenceStrength=${report.evidenceStrength}）`
  );
});

test('[最大失败模式] api.anthropic.com 官方端点 + CF 403 绝不可判为 relay', async (t) => {
  if (!engine) return skipEngine(t);
  const fixture = loadFixture('anthropic-official-cf-403');
  const report = await engine.detect(detectArgs(fixture, createFakeTransport(fixture)));
  assertReportValid(report, 'anthropic-official-cf-403');
  assert.equal(report.target.host, 'api.anthropic.com');
  assert.ok(
    !['relay', 'likely-relay'].includes(report.verdict),
    `官方直连被误判为中转站（本项目最大失败模式）：verdict=${report.verdict}`
  );
});

test('[v1.2 关键回归] 反向代理透传官方响应头（无域名身份）必须 inconclusive', async (t) => {
  if (!engine) return skipEngine(t);
  const fixture = loadFixture('forwarded-official-headers');
  const report = await engine.detect(detectArgs(fixture, createFakeTransport(fixture)));
  assertReportValid(report, 'forwarded-official-headers');
  assert.ok(
    !['relay', 'likely-relay'].includes(report.verdict),
    `透传官方头不得被判为中转：verdict=${report.verdict}`
  );
  assert.equal(
    report.verdict,
    'inconclusive',
    `期望 inconclusive（上游为真但不能证明直连），实际 ${report.verdict}（score=${report.score}）`
  );
});

test('全部 fixture 的 verdictIn / verdictNotIn / direction / networkReachable 期望成立', async (t) => {
  if (!engine) return skipEngine(t);
  for (const fixture of loadAllFixtures()) {
    const report = await engine.detect(detectArgs(fixture, createFakeTransport(fixture)));
    const exp = fixture.expect || {};
    const who = `fixture=${fixture.id} owner=${fixture.owner}`;
    if (exp.verdictIn) {
      assert.ok(
        exp.verdictIn.includes(report.verdict),
        `${who}: 期望 verdict ∈ [${exp.verdictIn}]，实际 "${report.verdict}"（score=${report.score}, evidenceStrength=${report.evidenceStrength}）`
      );
    }
    if (exp.verdictNotIn) {
      assert.ok(
        !exp.verdictNotIn.includes(report.verdict),
        `${who}: verdict "${report.verdict}" 在禁止集合 [${exp.verdictNotIn}] 内（score=${report.score}）`
      );
    }
    if (exp.direction === 'relay') {
      assert.ok(report.score > 50, `${who}: 期望 relay 方向（score>50），实际 score=${report.score}`);
    }
    if (exp.direction === 'official') {
      assert.ok(report.score < 50, `${who}: 期望 official 方向（score<50），实际 score=${report.score}`);
    }
    if (exp.networkReachable === false) {
      assert.equal(report.capabilities.networkReachable, false, `${who}: networkReachable 应为 false`);
      assert.ok(report.probes.every((p) => p.error !== null), `${who}: 网络不可达时每条 probe 都应有 error`);
    }
  }
});

/* ------------------------------------------------------------------ */
/* 脱敏 / 成本红线                                                       */
/* ------------------------------------------------------------------ */

test('密钥绝不进入 ProbeResult，且 allowPaidProbes=false 不产生费用', async (t) => {
  if (!engine) return skipEngine(t);
  const SECRET = 'sk-verifier-SECRET-0123456789abcdef';
  const fixture = loadFixture('aggregated-models');
  const transport = createFakeTransport(fixture);
  const report = await engine.detect({
    ...detectArgs(fixture, transport),
    apiKey: SECRET
  });
  assertReportValid(report, 'redaction');
  assert.equal(report.capabilities.costIncurred, false, 'allowPaidProbes=false 时不得产生费用');

  for (const p of report.probes) {
    const blob = JSON.stringify(p);
    assert.ok(!blob.includes(SECRET), `${p.id}: ProbeResult 泄漏了密钥原文`);
    if (p.kind === 'chat') {
      assert.fail(`${p.id}: allowPaidProbes=false 时不得发送 chat（可能计费）探测`);
    }
    for (const [k, v] of Object.entries(p.request?.headersSent || {})) {
      const lk = k.toLowerCase();
      if (['authorization', 'x-api-key', 'api-key', 'x-goog-api-key'].includes(lk)) {
        assert.equal(v, '<redacted>', `${p.id}: 请求头 ${k} 必须脱敏为 '<redacted>'，实际 "${v}"`);
      }
    }
    if (p.request?.bodySent) {
      assert.ok(!JSON.stringify(p.request.bodySent).includes(SECRET), `${p.id}: bodySent 泄漏密钥`);
    }
  }
});

test('allowPaidProbes=false 时所有探测均为 GET（契约 2.1）', async (t) => {
  if (!engine) return skipEngine(t);
  const fixture = loadFixture('openai-official-401');
  const report = await engine.detect(detectArgs(fixture, createFakeTransport(fixture)));
  for (const p of report.probes) {
    assert.equal(String(p.request.method).toUpperCase(), 'GET', `${p.id}: allowPaidProbes=false 只允许 GET 探测`);
  }
});

/* ------------------------------------------------------------------ */
/* 2.2 createProxyTransport / 2.3 runRules                              */
/* ------------------------------------------------------------------ */

test('createProxyTransport 把目标 URL 包成 proxyUrl/proxy?url=<encoded>（契约 2.2）', async (t) => {
  if (!engine) return skipEngine(t);
  assert.equal(typeof engine.createProxyTransport, 'function');

  const calls = [];
  const fakeFetch = async (url, init) => {
    calls.push({ url, init });
    return new Response('{}', { status: 200, headers: { 'content-type': 'application/json' } });
  };
  const transport = engine.createProxyTransport('http://127.0.0.1:8787/', { fetchImpl: fakeFetch });
  const target = 'https://api.example.com/v1/models?x=1';
  await transport(target, { method: 'GET', headers: { accept: 'application/json' } });

  assert.equal(calls.length, 1, '必须恰好转发一次');
  const sent = String(calls[0].url);
  assert.ok(sent.startsWith('http://127.0.0.1:8787/proxy?url='), `代理 URL 前缀错误：${sent}`);
  const encoded = sent.slice(sent.indexOf('url=') + 4);
  assert.equal(decodeURIComponent(encoded), target, 'url 参数必须可还原为原始目标');
  assert.equal(calls[0].init.headers.accept, 'application/json', '原请求头必须保留');
  assert.equal(calls[0].init.headers['x-relay-detector-hop'], '1', '必须带代理跳数标记');
});

test('runRules 按 id 去重且保留第一个（provider 规则先于 COMMON_RULES，契约 2.3）', (t) => {
  if (!engine) return skipEngine(t);
  const first = {
    id: 'url.official_host',
    category: 'url',
    verdict: 'official',
    weight: 70,
    confidence: 0.95,
    title: 'provider 先产出的官方身份信号',
    detail: '用于验证去重保留第一个',
    evidence: { host: 'api.example.com' }
  };
  const second = { ...first, verdict: 'relay', title: '同 id 的第二条（必须被丢弃）' };
  const ctx = { target: { provider: 'openai', host: 'api.example.com', baseUrl: 'https://api.example.com/v1' }, options: {}, mode: 'browser', probes: [], get: () => null, json: () => null, text: () => null };
  const signals = engine.runRules(ctx, { id: 'openai', rules: [() => [first, second]] });
  const hits = signals.filter((s) => s.id === 'url.official_host');
  assert.equal(hits.length, 1, `同 id 信号必须去重，实际 ${hits.length} 条`);
  assert.equal(hits[0].verdict, 'official', '必须保留 provider 规则的第一个（official），而不是后来的 relay');
});

test('runRules 容忍规则抛错：不抛异常、跳过该规则并记入 notes（契约 2.3）', (t) => {
  if (!engine) return skipEngine(t);
  const notes = [];
  const good = () => [
    {
      id: 'url.official_host',
      category: 'url',
      verdict: 'official',
      weight: 60,
      confidence: 0.9,
      title: 'ok',
      detail: 'ok',
      evidence: { host: 'api.example.com' }
    }
  ];
  const ctx = {
    target: { provider: 'openai', host: 'api.example.com', baseUrl: 'https://api.example.com/v1' },
    options: {},
    mode: 'browser',
    probes: [],
    get: () => null,
    json: () => null,
    text: () => null,
    note: (m) => notes.push(String(m))
  };
  let signals;
  assert.doesNotThrow(() => {
    signals = engine.runRules(ctx, {
      id: 'openai',
      rules: [
        () => {
          throw new Error('故意的规则错误');
        },
        good
      ]
    });
  }, 'runRules 不得让单条规则的异常逃逸');
  assert.ok(signals.some((s) => s.id === 'url.official_host'), '抛错规则之后的规则仍应执行');
  assert.ok(notes.some((m) => m.includes('故意的规则错误')), `规则错误必须记入 notes，实际 notes=${JSON.stringify(notes)}`);
});

test('detect provider=auto 时正确推断协议与官方主机（providerSource=auto）', async (t) => {
  if (!engine) return skipEngine(t);
  const failing = async () => {
    throw new TypeError('fetch failed');
  };
  const cases = [
    ['https://api.anthropic.com', 'anthropic', 'api.anthropic.com'],
    ['https://generativelanguage.googleapis.com', 'gemini', 'generativelanguage.googleapis.com'],
    ['https://api.openai.com/v1', 'openai', 'api.openai.com']
  ];
  for (const [baseUrl, provider, matched] of cases) {
    const report = await engine.detect({ baseUrl, provider: 'auto', mode: 'browser', transport: failing, options: { timeoutMs: 500 } });
    assert.equal(report.target.provider, provider, `${baseUrl} 应推断为 ${provider}`);
    assert.equal(report.target.providerSource, 'auto');
    assert.equal(report.target.matchedOfficialHost, matched, `matchedOfficialHost 应为 ${matched}`);
    assert.equal(report.capabilities.networkReachable, false, '全部探测失败时 networkReachable 必须为 false');
  }
});

/* ------------------------------------------------------------------ */
/* 2.1 纯函数                                                           */
/* ------------------------------------------------------------------ */

test('normalizeBaseUrl 纯函数符合契约 2.1', (t) => {
  if (!engine) return skipEngine(t);
  const n = engine.normalizeBaseUrl;

  const a = n('https://x.com/v1/');
  assert.equal(a.baseUrl, 'https://x.com/v1', '必须去尾斜杠');
  assert.equal(a.host, 'x.com');
  assert.equal(a.hadV1, true);

  const b = n('https://x.com/v1');
  assert.equal(b.baseUrl, 'https://x.com/v1');
  assert.equal(b.hadV1, true);

  const c = n('x.com');
  assert.equal(c.host, 'x.com');
  assert.ok(c.baseUrl.startsWith('https://'), `补协议失败：${c.baseUrl}`);
  assert.equal(c.hadV1, false);

  const d = n('api.example.com/v1');
  assert.equal(d.host, 'api.example.com');
  assert.equal(d.hadV1, true);

  const e = n('http://x.com/');
  assert.ok(e.baseUrl.startsWith('http://'), `显式协议应保留：${e.baseUrl}`);
  assert.ok(!e.baseUrl.endsWith('/'), '任何情况都不得有尾斜杠');

  assert.equal(n(a.baseUrl).baseUrl, a.baseUrl, 'normalizeBaseUrl 必须幂等');

  assert.doesNotThrow(() => n(''), '空输入不得抛错');
  assert.equal(typeof n('').baseUrl, 'string');
});

test('pickProvider 纯函数符合契约 2.1', (t) => {
  if (!engine) return skipEngine(t);
  const p = engine.pickProvider;

  assert.equal(p('https://api.anthropic.com', 'auto'), 'anthropic');
  assert.equal(p('https://generativelanguage.googleapis.com', 'auto'), 'gemini');
  assert.equal(p('https://api.openai.com/v1', 'auto'), 'openai');
  assert.equal(p('https://x.com/v1', 'openai'), 'openai', '显式 hint 优先');
  assert.equal(p('https://api.anthropic.com', 'openai'), 'openai', '显式 hint 优先于自动识别');
  assert.equal(p('https://x.com', 'anthropic'), 'anthropic');
  assert.equal(p('https://x.com', 'gemini'), 'gemini');

  for (const url of ['https://unknown.example.com/v1', '', 'not a url', 'https://api.openai.com']) {
    assert.ok(PROVIDERS.includes(p(url, 'auto')), `pickProvider('${url}','auto') 必须返回合法 provider`);
  }
  assert.doesNotThrow(() => p(null, null), '非法输入不得抛错');
});

/* ------------------------------------------------------------------ */
/* 浏览器侧静态检查（ui 交付后生效）                                       */
/* ------------------------------------------------------------------ */

test('index.html 引用的本地资源全部存在（契约 2.6）', (t) => {
  const file = path.join(ROOT, 'index.html');
  if (!fs.existsSync(file)) return t.skip('index.html 未交付（ui 进行中）');
  const html = fs.readFileSync(file, 'utf8');

  const refs = [...html.matchAll(/(?:src|href)\s*=\s*["']([^"']+)["']/gi)]
    .map((m) => m[1])
    .filter((u) => !/^(https?:|data:|mailto:|#|\/\/)/i.test(u));

  assert.ok(refs.length > 0, 'index.html 必须引用本地资源');
  for (const ref of refs) {
    const clean = ref.split('?')[0].split('#')[0];
    const abs = path.resolve(path.dirname(file), clean);
    assert.ok(fs.existsSync(abs), `index.html 引用了不存在的资源：${ref}（${abs}）`);
  }
  assert.match(html, /src=["']\.\/src\/ui\/app\.js["']/, 'index.html 必须通过 ./src/ui/app.js 加载 UI');
  assert.match(html, /lang=["']zh-CN["']/, 'index.html 必须是中文页面（lang="zh-CN"）');
  assert.match(html, /\.\/src\/styles\/main\.css/, 'index.html 必须引用 ./src/styles/main.css');
});

test('UI 文案不出现「100% 确定」类表述（质量红线 4.1）', (t) => {
  const targets = [];
  const indexFile = path.join(ROOT, 'index.html');
  if (fs.existsSync(indexFile)) targets.push(indexFile);
  const uiDir = path.join(ROOT, 'src', 'ui');
  if (fs.existsSync(uiDir)) {
    for (const f of fs.readdirSync(uiDir).filter((x) => x.endsWith('.js'))) {
      targets.push(path.join(uiDir, f));
    }
  }
  if (targets.length === 0) return t.skip('UI 尚未交付');
  const forbidden = /100\s*%|100％|百分百|完全确定|绝对确定/;
  for (const file of targets) {
    const src = fs.readFileSync(file, 'utf8');
    const m = src.match(forbidden);
    assert.ok(
      !m,
      `${path.relative(ROOT, file)} 出现「${m && m[0]}」：契约 §4.1 禁止声称 100% 确定`
    );
  }
});

test('src/ui/** 不 import rules/** 或 provider 内部（契约 2.6）', (t) => {
  const uiDir = path.join(ROOT, 'src', 'ui');
  if (!fs.existsSync(uiDir)) return t.skip('src/ui 未交付');
  const files = fs.readdirSync(uiDir).filter((f) => f.endsWith('.js'));
  assert.ok(files.length > 0, 'src/ui 下应有 js 文件');

  for (const f of files) {
    const src = fs.readFileSync(path.join(uiDir, f), 'utf8');
    assert.ok(
      !/from\s+["'][^"']*rules\//.test(src),
      `src/ui/${f} 不得 import rules/**（契约 2.6）`
    );
    assert.ok(
      !/from\s+["'][^"']*providers\//.test(src),
      `src/ui/${f} 不得 import providers/**（契约 2.6）`
    );
  }
});
