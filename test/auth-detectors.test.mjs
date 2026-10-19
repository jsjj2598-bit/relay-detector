/**
 * v2 真伪检测器单测（契约 §6.1 / §6.4 / §8 第 2、3 条）。
 *
 * 全部**离线**：用伪造 transport（test/helpers/auth-fixtures.mjs）构造响应，
 * 不联网、不需要真实 API Key。
 *
 * 覆盖：
 *  - 检测器注册表与契约 §6.4 冻结表（name / weight / modes / provider / kind / critical）
 *  - 每个检测器 run() 绝不抛异常
 *  - thinking_signature 四种状态（无块=0 / 有块无签名=30 / 短签名=70 / 正常=100）
 *  - v2.1：score<=30（缺失签名）必须报 `missing_thinking_signature` critical，并通过 effectiveVerdict
 *    把本应 passed 的高分冒充场景封顶为 marginal；score=70/100 不得报 critical；skip 绝不报 critical
 *  - thinking_signature 请求参数（非流式、max_tokens、adaptive vs extended）
 *  - 模型不支持 thinking → appliesTo=false / status=skip（不拉低总分）
 *  - cross_vendor_leak：跨厂商字段 → critical
 *  - message_id：msg_ / toolu_ 前缀、UUID、缺前缀扣分
 *  - model_consistency：model 回显不符 → 0 分；CV 稳定 / 异常
 *  - token_usage：字符/token 比、completion 超 max_tokens、total 不自洽
 *  - stream_integrity：流式文本不一致、input_tokens 差 10 倍
 *  - capability_tools / structured_output / protocol_shape / token_parity
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import { AUTH_DETECTORS, MODE_DETECTOR_RANGE, detectorsForMode } from '../src/core/auth/detectors/index.js';
import { thinkingSignature, scoreThinkingBlocks } from '../src/core/auth/detectors/thinking-signature.js';
import { crossVendorLeak, detectCrossVendorLeaks } from '../src/core/auth/detectors/cross-vendor-leak.js';
import { messageId } from '../src/core/auth/detectors/message-id.js';
import { modelConsistency, coefficientOfVariation } from '../src/core/auth/detectors/model-consistency.js';
import { tokenUsage } from '../src/core/auth/detectors/token-usage.js';
import { streamIntegrity, textSimilarity, tokenTolerance } from '../src/core/auth/detectors/stream-integrity.js';
import { structuredOutput, evaluateStructuredOutput } from '../src/core/auth/detectors/structured-output.js';
import { capabilityTools, argumentsMatch, toolCallIdCheck } from '../src/core/auth/detectors/capability-tools.js';
import { protocolShape } from '../src/core/auth/detectors/protocol-shape.js';
import { tokenParity } from '../src/core/auth/detectors/token-parity.js';
import { lookupModel } from '../src/core/auth/models.js';
import { computeTotal, effectiveVerdict, verdictFor } from '../src/core/auth/scorer.js';
import { buildResult } from '../src/core/auth/base.js';
import {
  anthropicMessage,
  createAuthTransport,
  jsonResponse,
  openaiCompletion,
  sseResponse,
  thinkingBlock
} from './helpers/auth-fixtures.mjs';

/* ------------------------------------------------------------------ */
/* 契约 §6.4 冻结表                                                      */
/* ------------------------------------------------------------------ */

const CONTRACT_TABLE = [
  { name: 'protocol_shape', weight: 20, kind: 'active', critical: false, modes: ['quick', 'standard', 'full'], provider: [] },
  { name: 'cross_vendor_leak', weight: 20, kind: 'passive', critical: true, modes: ['quick', 'standard', 'full'], provider: [] },
  { name: 'model_consistency', weight: 15, kind: 'active', critical: false, modes: ['quick', 'standard', 'full'], provider: [] },
  // 契约 v2.1 §6.4：thinking_signature 的 critical 列改为「是（仅缺失签名时）」。
  { name: 'thinking_signature', weight: 25, kind: 'active', critical: true, modes: ['standard', 'full'], provider: ['anthropic'] },
  { name: 'message_id', weight: 5, kind: 'passive', critical: false, modes: ['standard', 'full'], provider: ['anthropic'] },
  { name: 'token_usage', weight: 10, kind: 'active', critical: false, modes: ['standard', 'full'], provider: [] },
  { name: 'structured_output', weight: 10, kind: 'active', critical: false, modes: ['standard', 'full'], provider: [] },
  { name: 'capability_tools', weight: 10, kind: 'active', critical: false, modes: ['standard', 'full'], provider: [] },
  { name: 'stream_integrity', weight: 10, kind: 'active', critical: false, modes: ['full'], provider: [] },
  { name: 'token_parity', weight: 10, kind: 'active', critical: false, modes: ['full'], provider: [] }
];

test('检测器注册表与契约 §6.4 冻结表完全一致（顺序 / name / weight / 档位 / 协议 / kind / critical）', () => {
  assert.equal(AUTH_DETECTORS.length, 10, `契约 §6.4 要求 10 个检测器，实际 ${AUTH_DETECTORS.length}`);
  assert.deepEqual(
    AUTH_DETECTORS.map((d) => d.name),
    CONTRACT_TABLE.map((d) => d.name),
    '检测器顺序必须与契约 §6.4 表格一致（也决定 quick/standard 档位的前 N 项）'
  );

  for (const row of CONTRACT_TABLE) {
    const detector = AUTH_DETECTORS.find((d) => d.name === row.name);
    assert.ok(detector, `缺少检测器 ${row.name}`);
    assert.equal(detector.weight, row.weight, `${row.name}.weight 必须为 ${row.weight}`);
    assert.equal(detector.critical, row.critical, `${row.name}.critical 必须为 ${row.critical}`);
    assert.equal(detector.kind, row.kind, `${row.name}.kind 必须为 ${row.kind}`);
    assert.deepEqual(detector.modes, row.modes, `${row.name}.modes 必须为 ${JSON.stringify(row.modes)}`);
    assert.deepEqual(detector.provider, row.provider, `${row.name}.provider 必须为 ${JSON.stringify(row.provider)}`);
    assert.equal(typeof detector.displayName, 'string', `${row.name}.displayName 必须是字符串`);
    assert.ok(detector.displayName.length > 0, `${row.name}.displayName 不得为空`);
    assert.match(row.name, /^[a-z]+(_[a-z]+)*$/, `检测器名必须是 snake_case：${row.name}`);
  }

  assert.deepEqual(MODE_DETECTOR_RANGE, { quick: 3, standard: 8, full: 10 }, '档位包含的检测器数量错误');
  assert.deepEqual(detectorsForMode('quick').map((d) => d.name), CONTRACT_TABLE.slice(0, 3).map((d) => d.name));
  assert.deepEqual(detectorsForMode('standard').map((d) => d.name), CONTRACT_TABLE.slice(0, 8).map((d) => d.name));
  assert.deepEqual(detectorsForMode('full').map((d) => d.name), CONTRACT_TABLE.map((d) => d.name));
});

/* ------------------------------------------------------------------ */
/* 测试工具                                                              */
/* ------------------------------------------------------------------ */

/** 构造一个检测器可用的 ctx（transport 走 performRequest 的离线兜底）。 */
function makeCtx({ provider = 'openai', model = 'gpt-4o', modelInfo, transport, exchanges } = {}) {
  return {
    provider,
    model,
    baseUrl: 'https://relay.example.com',
    apiKey: 'sk-test-key-for-detector-test',
    modelInfo: modelInfo === undefined ? lookupModel(provider, model) : modelInfo,
    options: {},
    transport,
    exchanges: exchanges || [],
    authState: {}
  };
}

/** 单请求 transport：总是返回给定 payload / Response。 */
function once(response) {
  return createAuthTransport(() => response);
}

function assertDetectorResultShape(result, label) {
  assert.ok(result && typeof result === 'object', `${label}: 必须返回 DetectorResult`);
  assert.equal(typeof result.name, 'string');
  assert.equal(typeof result.displayName, 'string');
  assert.equal(typeof result.weight, 'number');
  assert.ok(['pass', 'fail', 'skip', 'error'].includes(result.status), `${label}: 非法 status "${result.status}"`);
  assert.equal(typeof result.score, 'number');
  if (result.status === 'skip' || result.status === 'error') {
    assert.equal(result.score, 0, `${label}: status=${result.status} 时 score 必须为 0（契约 6.2）`);
  }
  assert.ok(result.details && typeof result.details === 'object', `${label}: details 必须是对象`);
  assert.doesNotThrow(() => JSON.stringify(result), `${label}: DetectorResult 必须可序列化`);
}

test('全部检测器 run() 在 transport 抛错时都不抛异常（契约 6.2 第 4 条）', async () => {
  const throwing = async () => {
    throw new TypeError('fetch failed');
  };
  for (const detector of AUTH_DETECTORS) {
    const ctx = makeCtx({ provider: 'anthropic', model: 'claude-sonnet-4-5', transport: throwing });
    let result;
    await assert.doesNotReject(async () => {
      result = await detector.run(ctx);
    }, `${detector.name}.run() 不得抛异常`);
    assertDetectorResultShape(result, detector.name);
  }
});

/* ------------------------------------------------------------------ */
/* thinking_signature                                                    */
/* ------------------------------------------------------------------ */

const SONNET = 'claude-sonnet-4-5';

function anthropicThinkingCtx(content, { model = SONNET } = {}) {
  const transport = once(
    jsonResponse(
      anthropicMessage({
        model,
        content,
        usage: { input_tokens: 120, output_tokens: 80 }
      })
    )
  );
  return makeCtx({ provider: 'anthropic', model, transport });
}

test('[v2.1 关键回归] thinking_signature：无 thinking 块 → 0 分 fail + critical missing_thinking_signature', async () => {
  const ctx = anthropicThinkingCtx([{ type: 'text', text: '1547' }]);
  const result = await thinkingSignature.run(ctx);
  assertDetectorResultShape(result, 'thinking_signature');
  assert.equal(result.status, 'fail', '无 thinking 块必须 fail');
  assert.equal(result.score, 0, '无 thinking 块必须 0 分（契约 §8.3）');
  assert.equal(result.details.tier, 'no_thinking_block');
  assert.ok(
    Array.isArray(result.criticalIssues) && result.criticalIssues.some((issue) => issue.code === 'missing_thinking_signature'),
    `契约 v2.1：score<=30 必须报 missing_thinking_signature critical，实际 ${JSON.stringify(result.criticalIssues)}`
  );
  const issue = result.criticalIssues.find((item) => item.code === 'missing_thinking_signature');
  assert.equal(typeof issue.message, 'string', 'criticalIssue.message 必须是字符串');
  assert.ok(issue.message.length > 0, 'criticalIssue.message 不得为空');
  assert.ok('evidence' in issue, 'criticalIssue 必须带 evidence');
});

test('[v2.1 关键回归] thinking_signature：有 thinking 块但无签名 → 30 分 fail + critical', async () => {
  // 注意：不能用 thinkingBlock({ signature: undefined })——函数默认参数会把 undefined 变成正常长签名。
  const noSignature = [{ type: 'thinking', thinking: '先把 2378 除以 1547……' }, { type: 'text', text: '1547' }];
  const ctx = anthropicThinkingCtx(noSignature);
  const result = await thinkingSignature.run(ctx);
  assert.equal(result.status, 'fail', '有块无签名必须 fail');
  assert.equal(result.score, 30, '有块无签名必须 30 分（契约 §8.3）');
  assert.equal(result.details.signatureLength, 0);
  assert.equal(result.details.tier, 'block_without_signature');
  assert.ok(
    result.criticalIssues.some((issue) => issue.code === 'missing_thinking_signature'),
    '契约 v2.1：score=30 同样必须报 missing_thinking_signature critical'
  );
});

test('[v2.1] thinking_signature：签名 < 50 字符（70 分）→ 只扣分、不产 critical', async () => {
  const ctx = anthropicThinkingCtx([thinkingBlock({ signature: 'short-signature-abc' }), { type: 'text', text: '1' }]);
  const result = await thinkingSignature.run(ctx);
  assert.equal(result.score, 70, '短签名必须 70 分');
  assert.equal(result.status, 'pass', '70 分按 >=70 判 pass');
  assert.equal(result.details.tier, 'signature_too_short');
  assert.deepEqual(result.criticalIssues, [], '契约 v2.1：score=70 只扣分，不得报 critical');
});

test('[v2.1 关键回归] thinking_signature：正常长签名 → 100 分且无 critical（genuine 不得被误伤）', async () => {
  const context = anthropicThinkingCtx([
    thinkingBlock({ signature: 'EqQBCkgIBRABGAIiQL' + 'a'.repeat(400) }),
    { type: 'text', text: '1547' }
  ]);
  const result = await thinkingSignature.run(context);
  assert.equal(result.score, 100, '正常长签名必须 100 分（契约 §8.3）');
  assert.equal(result.status, 'pass');
  assert.equal(result.details.tier, 'signature_ok');
  assert.deepEqual(result.criticalIssues, [], '正常签名不得报 critical');
});

test('[v2.1 关键回归] 签名缺失 critical → 高总分 78.26（本应 passed）必须被 effectiveVerdict 封顶 marginal', async () => {
  // 复现 Kiro/Amazon Q 冒充场景：thinking 0 分 + critical，其余 standard 档 7 项全部 100 分。
  const missingSignature = await thinkingSignature.run(anthropicThinkingCtx([{ type: 'text', text: '1547' }]));
  const standardOthers = AUTH_DETECTORS.slice(0, 8).filter((detector) => detector.name !== 'thinking_signature');
  assert.equal(standardOthers.length, 7, '标准档除 thinking 外应有 7 个检测器');
  const results = [missingSignature, ...standardOthers.map((detector) => buildResult(detector, { status: 'pass', score: 100 }))];

  const total = computeTotal(results);
  // 权重 90（其余 7 项）* 100 + 25 * 0 = 9000 / 115 ≈ 78.26
  assert.ok(total >= 70 && total < 85, `前置：冒充场景总分应落在 passed 区间（70..85），实际 ${total}`);
  assert.equal(verdictFor(total), 'passed', '前置：没有 critical 时这个分数会判 passed（正是缺陷所在）');
  assert.equal(
    effectiveVerdict(total, results),
    'marginal',
    '契约 v2.1：缺失 thinking signature 的 critical 必须把 passed 封顶为 marginal，绝不能让冒充者「通过」'
  );
});

test('scoreThinkingBlocks 纯函数：四档边界（0 / 30 / 70 / 100）', () => {
  assert.equal(scoreThinkingBlocks({ blocks: [], signatures: [] }).score, 0);
  assert.equal(
    scoreThinkingBlocks({ blocks: [{ type: 'thinking', thinking: 'x' }], signatures: [] }).score,
    30
  );
  assert.equal(
    scoreThinkingBlocks({ blocks: [{ type: 'thinking' }], signatures: ['a'.repeat(49)] }).score,
    70,
    '49 字符必须 70 分'
  );
  assert.equal(
    scoreThinkingBlocks({ blocks: [{ type: 'thinking' }], signatures: ['a'.repeat(50)] }).score,
    100,
    '50 字符必须 100 分（阈值闭区间）'
  );
  assert.doesNotThrow(() => scoreThinkingBlocks(undefined), '非法输入不得抛错');
});

test('thinking_signature：请求必须非流式、max_tokens=16000，adaptive 模型用顶层 output_config.effort', async () => {
  const transport = once(jsonResponse(anthropicMessage({ content: [thinkingBlock(), { type: 'text', text: '1' }] })));
  const ctx = makeCtx({ provider: 'anthropic', model: SONNET, transport });
  await thinkingSignature.run(ctx);
  assert.equal(transport.calls.length, 1, 'thinking 检测应只发 1 个请求');
  const body = transport.calls[0].bodyJson;
  assert.equal(body.max_tokens, 16000, 'max_tokens 必须给足 16000（太小模型会跳过思考）');
  assert.notEqual(body.stream, true, '必须使用非流式请求（streaming + adaptive 会丢 thinking 块）');
  assert.deepEqual(body.thinking, { type: 'adaptive', display: 'summarized' }, 'adaptive 模型的 thinking 参数错误');
  assert.deepEqual(body.output_config, { effort: 'high' }, 'effort 必须是顶层 output_config.effort（放进 thinking 会 400）');
});

test('thinking_signature：extended 模型使用 thinking {type:"enabled", budget_tokens:2000}', async () => {
  const model = 'claude-opus-4-1'; // 注册表中无 adaptive 标记
  assert.equal(lookupModel('anthropic', model).adaptive, undefined);
  const transport = once(jsonResponse(anthropicMessage({ model, content: [thinkingBlock(), { type: 'text', text: '1' }] })));
  const ctx = makeCtx({ provider: 'anthropic', model, transport });
  await thinkingSignature.run(ctx);
  const body = transport.calls[0].bodyJson;
  assert.deepEqual(body.thinking, { type: 'enabled', budget_tokens: 2000 });
  assert.equal(body.output_config, undefined, 'extended 模式不需要 output_config');
});

test('[v2.1 关键回归] thinking_signature：模型不支持 thinking（claude-3-5-haiku-20241022）→ skip、无 critical、且不拉低总分', async () => {
  const model = 'claude-3-5-haiku-20241022';
  const ctx = makeCtx({ provider: 'anthropic', model });
  assert.equal(thinkingSignature.appliesTo(ctx), false, '不支持 thinking 的模型 appliesTo 必须为 false');
  assert.equal(thinkingSignature.skipReason(ctx), 'model_capability_missing');
  const skip = buildResult(thinkingSignature, { status: 'skip', score: 0, reason: 'model_capability_missing' });
  assert.equal(skip.score, 0);
  assert.deepEqual(skip.criticalIssues, [], '契约 v2.1：skip 场景绝不能报 critical（模型本来就不支持 thinking）');

  // 只有「其他检测器 100 分」时，thinking 的 skip 不得把总分拉低
  const results = [
    buildResult(thinkingSignature, { status: 'skip', score: 0 }),
    buildResult({ name: 'protocol_shape', displayName: 'x', weight: 20 }, { status: 'pass', score: 100 }),
    buildResult({ name: 'token_usage', displayName: 'y', weight: 10 }, { status: 'pass', score: 100 })
  ];
  assert.equal(computeTotal(results), 100, 'skip 不进入分母：总分必须仍是 100');
  assert.equal(effectiveVerdict(computeTotal(results), results), 'excellent', 'skip 不得把 excellent 拉低');
});

test('[v2.1] thinking_signature：skip 结果不得让 effectiveVerdict 降级（与 fail/critical 明确区分）', () => {
  const skipResult = buildResult(thinkingSignature, {
    status: 'skip',
    score: 0,
    reason: 'model_capability_missing'
  });
  const others = [
    buildResult({ name: 'protocol_shape', displayName: 'x', weight: 20 }, { status: 'pass', score: 100 }),
    buildResult({ name: 'model_consistency', displayName: 'y', weight: 15 }, { status: 'pass', score: 100 })
  ];
  const results = [skipResult, ...others];
  assert.equal(computeTotal(results), 100, 'skip 不进分母');
  assert.equal(effectiveVerdict(computeTotal(results), results), 'excellent', 'skip 不产生 critical，不得封顶');
});

test('thinking_signature：非 Anthropic 协议 → appliesTo=false（provider_not_applicable）', () => {
  const ctx = makeCtx({ provider: 'openai', model: 'gpt-4o' });
  assert.equal(thinkingSignature.appliesTo(ctx), false);
  assert.equal(thinkingSignature.skipReason(ctx), 'provider_not_applicable');
});

/* ------------------------------------------------------------------ */
/* cross_vendor_leak（critical）                                          */
/* ------------------------------------------------------------------ */

test('detectCrossVendorLeaks：OpenAI 响应出现 claude_* / input_tokens / usage_source:anthropic → 检出', () => {
  const baseUsage = { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 };
  const cases = [
    [
      'claude_cache_creation_5_m_tokens',
      openaiCompletion({ usage: { ...baseUsage, claude_cache_creation_5_m_tokens: 5 } })
    ],
    ['input_tokens', openaiCompletion({ usage: { ...baseUsage, input_tokens: 10 } })],
    ['usage_source', openaiCompletion({ usage: { ...baseUsage, usage_source: 'anthropic' } })],
    ['anthropic 形状', { ...anthropicMessage(), choices: undefined }]
  ];
  for (const [label, payload] of cases) {
    if (label !== 'anthropic 形状') {
      // 确保这是 OpenAI 形状（含 choices）
      assert.ok(Array.isArray(payload.choices), `${label}: 前置条件失败`);
    }
    const leaks = detectCrossVendorLeaks('openai', payload);
    assert.ok(leaks.length > 0, `${label}: 必须检出跨厂商痕迹`);
  }
});

test('detectCrossVendorLeaks：官方 OpenAI 响应不得误报', () => {
  const leaks = detectCrossVendorLeaks('openai', openaiCompletion());
  assert.deepEqual(leaks, [], `官方 OpenAI 形状被误报：${JSON.stringify(leaks)}`);
});

test('detectCrossVendorLeaks：Anthropic 响应里出现 OpenAI choices → 检出', () => {
  const leaks = detectCrossVendorLeaks('anthropic', {
    ...anthropicMessage(),
    object: 'chat.completion',
    choices: [{ index: 0, message: { role: 'assistant', content: 'x' } }]
  });
  assert.ok(leaks.length > 0, 'Anthropic 协议响应里出现 OpenAI 形状必须检出');
});

test('[关键回归] cross_vendor_leak：检出泄漏时 status=fail + criticalIssues，且 effectiveVerdict 被封顶 marginal', async () => {
  const leaked = openaiCompletion({
    usage: {
      prompt_tokens: 10,
      completion_tokens: 5,
      total_tokens: 15,
      claude_cache_creation_5_m_tokens: 5
    }
  });
  const ctx = makeCtx({
    provider: 'openai',
    model: 'gpt-4o',
    exchanges: [
      {
        purpose: 'protocol_shape',
        response: { status: 200, headers: {}, bodyText: JSON.stringify(leaked), bodyJson: leaked, contentType: 'application/json' }
      }
    ]
  });
  const result = await crossVendorLeak.run(ctx);
  assertDetectorResultShape(result, 'cross_vendor_leak');
  assert.equal(result.status, 'fail');
  assert.equal(result.score, 0, 'critical 检测器检出时必须 0 分');
  assert.ok(result.criticalIssues.length > 0, '必须产出 criticalIssues');
  assert.equal(result.criticalIssues[0].code, 'cross_vendor_anthropic_field');

  // 其余检测器各得 100 分（权重合计 85）时，总分 = 100*65/85 ≈ 76.47 → 本应 passed，
  // 但 critical 一票降级必须把 passed 封顶为 marginal（分数仍可能很高）。
  const others = [
    { name: 'protocol_shape', weight: 20 },
    { name: 'model_consistency', weight: 15 },
    { name: 'token_usage', weight: 10 },
    { name: 'structured_output', weight: 10 },
    { name: 'capability_tools', weight: 10 }
  ].map(({ name, weight }) =>
    buildResult({ name, displayName: name, weight }, { status: 'pass', score: 100 })
  );
  const results = [result, ...others];
  const total = computeTotal(results);
  assert.ok(total >= 70 && total < 85, `前置：总分应落在 passed 区间（70..85），实际 ${total}`);
  assert.equal(verdictFor(total), 'passed', '前置：无 critical 时该分数应判 passed');
  assert.equal(effectiveVerdict(total, results), 'marginal', 'critical 一票降级：passed 必须封顶为 marginal');
});

test('cross_vendor_leak：没有可复用的成功响应 → skip（不扣分）', async () => {
  const ctx = makeCtx({ provider: 'openai', model: 'gpt-4o', exchanges: [] });
  const result = await crossVendorLeak.run(ctx);
  assert.equal(result.status, 'skip');
  assert.equal(result.score, 0);
  assert.equal(result.reason, 'no_exchange');
});

/* ------------------------------------------------------------------ */
/* message_id                                                            */
/* ------------------------------------------------------------------ */

function messageIdExchange(payload, purpose = 'protocol_shape') {
  return {
    purpose,
    response: {
      status: 200,
      headers: {},
      bodyText: JSON.stringify(payload),
      bodyJson: payload,
      contentType: 'application/json'
    }
  };
}

test('message_id：官方 msg_ / toolu_ 前缀齐全 → 100 分 pass', async () => {
  const payload = anthropicMessage({
    id: 'msg_01ABCDEFGHIJKLMNOPQRSTUV',
    content: [
      { type: 'text', text: 'ok' },
      { type: 'tool_use', id: 'toolu_01ABCdef123456', name: 'add_numbers', input: { a: 1, b: 2 } }
    ]
  });
  const ctx = makeCtx({ provider: 'anthropic', model: SONNET, exchanges: [messageIdExchange(payload)] });
  const result = await messageId.run(ctx);
  assertDetectorResultShape(result, 'message_id');
  assert.equal(result.score, 100);
  assert.equal(result.status, 'pass');
});

test('message_id：UUID 风格 id + model 不含 claude → 扣分 fail', async () => {
  const payload = anthropicMessage({
    id: '9f8b7c6d-1e2f-4a5b-8c9d-0e1f2a3b4c5d',
    model: 'kimi-k2-0905',
    content: [{ type: 'text', text: 'ok' }]
  });
  const ctx = makeCtx({ provider: 'anthropic', model: SONNET, exchanges: [messageIdExchange(payload)] });
  const result = await messageId.run(ctx);
  assert.equal(result.status, 'fail');
  assert.ok(result.score < 70, `UUID 风格 id 应显著扣分，实际 ${result.score}`);
  const prefixCheck = result.details.subChecks.find((c) => c.id === 'message_id_prefix');
  assert.equal(prefixCheck.ok, false, 'msg_ 前缀检查必须失败');
});

test('message_id：工具调用 id 缺 toolu_ 前缀 → 扣分', async () => {
  const payload = anthropicMessage({
    content: [
      { type: 'text', text: 'ok' },
      { type: 'tool_use', id: 'call_abc123', name: 'add_numbers', input: { a: 1, b: 2 } }
    ]
  });
  const ctx = makeCtx({ provider: 'anthropic', model: SONNET, exchanges: [messageIdExchange(payload, 'capability_tools')] });
  const result = await messageId.run(ctx);
  const toolCheck = result.details.subChecks.find((c) => c.id === 'tool_use_id_prefix');
  assert.ok(toolCheck, '出现过 tool_use 时必须检查 toolu_ 前缀');
  assert.equal(toolCheck.ok, false, '缺 toolu_ 前缀必须扣分');
  assert.ok(result.score < 100, `缺 toolu_ 前缀应扣分，实际 ${result.score}`);
});

test('message_id：没有可复用的 Anthropic message 响应 → skip', async () => {
  const ctx = makeCtx({ provider: 'anthropic', model: SONNET, exchanges: [] });
  const result = await messageId.run(ctx);
  assert.equal(result.status, 'skip');
  assert.equal(result.score, 0);
  assert.equal(result.reason, 'no_exchange');
});

/* ------------------------------------------------------------------ */
/* model_consistency                                                     */
/* ------------------------------------------------------------------ */

function openaiSamples({ model = 'gpt-4o', completionTokens = [20, 20, 20], echoes } = {}) {
  return completionTokens.map((tokens, index) =>
    jsonResponse(
      openaiCompletion({
        id: `chatcmpl-sample-${index}`,
        model: Array.isArray(echoes) ? echoes[index] : model,
        usage: { prompt_tokens: 30, completion_tokens: tokens, total_tokens: 30 + tokens }
      })
    )
  );
}

test('model_consistency：响应 model 与请求不符 → 0 分 fail', async () => {
  const transport = createAuthTransport(openaiSamples({ model: 'gpt-4o-mini', echoes: ['gpt-4o-mini', 'gpt-4o-mini', 'gpt-4o-mini'] }));
  const ctx = makeCtx({ provider: 'openai', model: 'gpt-4o', transport });
  const result = await modelConsistency.run(ctx);
  assertDetectorResultShape(result, 'model_consistency');
  assert.equal(result.status, 'fail');
  assert.equal(result.score, 0, 'model 回显不一致必须 0 分（硬证据）');
  assert.equal(transport.calls.length, 3, '必须发 3 次 temp=0 采样');
});

test('model_consistency：3 次 completion_tokens 稳定（CV=0）→ 100 分 pass', async () => {
  const transport = createAuthTransport(openaiSamples({ completionTokens: [20, 20, 20] }));
  const ctx = makeCtx({ provider: 'openai', model: 'gpt-4o', transport });
  const result = await modelConsistency.run(ctx);
  assert.equal(result.details.cv, 0, '相同 completion_tokens 的 CV 应为 0');
  assert.equal(result.score, 100);
  assert.equal(result.status, 'pass');
});

test('model_consistency：3 次 completion_tokens 异常波动（CV>0.4）→ 明显扣分', async () => {
  const transport = createAuthTransport(openaiSamples({ completionTokens: [10, 10, 100] }));
  const ctx = makeCtx({ provider: 'openai', model: 'gpt-4o', transport });
  const result = await modelConsistency.run(ctx);
  const cv = coefficientOfVariation([10, 10, 100]);
  assert.ok(cv > 0.4, `前置：CV 应 > 0.4，实际 ${cv}`);
  assert.ok(result.details.cv > 0.4, `details.cv 应 > 0.4，实际 ${result.details.cv}`);
  assert.ok(result.score < 85, `输出长度异常波动应明显扣分，实际 ${result.score}`);
  const cvCheck = result.details.subChecks.find((c) => c.id === 'completion_token_cv');
  assert.equal(cvCheck.ok, false, 'CV 检查必须失败');
  assert.equal(cvCheck.evidence.suspicious, true, 'CV>0.4 必须标记 suspicious');
});

/* ------------------------------------------------------------------ */
/* token_usage                                                           */
/* ------------------------------------------------------------------ */

test('token_usage：全部自洽 → 100 分 pass', async () => {
  const text = '1,2,3,4,5,6,7,8,9,10,11,12,13,14,15,16,17,18,19,20';
  const transport = once(
    jsonResponse(
      openaiCompletion({
        choices: [{ index: 0, message: { role: 'assistant', content: text }, finish_reason: 'stop' }],
        usage: { prompt_tokens: 30, completion_tokens: 20, total_tokens: 50 }
      })
    )
  );
  const ctx = makeCtx({ provider: 'openai', model: 'gpt-4o', transport });
  const result = await tokenUsage.run(ctx);
  assertDetectorResultShape(result, 'token_usage');
  assert.equal(result.score, 100);
  assert.equal(result.status, 'pass');
});

test('token_usage：字符/token 比越界 → 扣分 fail', async () => {
  const transport = once(
    jsonResponse(
      openaiCompletion({
        choices: [{ index: 0, message: { role: 'assistant', content: 'ok' }, finish_reason: 'stop' }],
        usage: { prompt_tokens: 30, completion_tokens: 100, total_tokens: 130 }
      })
    )
  );
  const ctx = makeCtx({ provider: 'openai', model: 'gpt-4o', transport });
  const result = await tokenUsage.run(ctx);
  assert.equal(result.status, 'fail');
  const ratioCheck = result.details.subChecks.find((c) => c.id === 'char_token_ratio');
  assert.equal(ratioCheck.ok, false, '2 字符 / 100 tokens = 0.02 必须判越界');
  assert.ok(result.score < 70);
});

test('token_usage：completion_tokens 超过 max_tokens → 扣分 fail', async () => {
  const transport = once(
    jsonResponse(
      openaiCompletion({
        choices: [{ index: 0, message: { role: 'assistant', content: 'x'.repeat(500) }, finish_reason: 'stop' }],
        usage: { prompt_tokens: 30, completion_tokens: 200, total_tokens: 230 }
      })
    )
  );
  const ctx = makeCtx({ provider: 'openai', model: 'gpt-4o', transport });
  const result = await tokenUsage.run(ctx);
  assert.equal(result.status, 'fail');
  const maxCheck = result.details.subChecks.find((c) => c.id === 'completion_within_max_tokens');
  assert.equal(maxCheck.ok, false, 'completion_tokens=200 > max_tokens=128 必须判失败');
  const ratioCheck = result.details.subChecks.find((c) => c.id === 'char_token_ratio');
  assert.equal(ratioCheck.ok, true, '本用例的字符/token 比应当正常，以隔离 max_tokens 这一条');
});

test('token_usage：total 不等于 prompt+completion → 扣分 fail', async () => {
  const transport = once(
    jsonResponse(
      openaiCompletion({
        choices: [{ index: 0, message: { role: 'assistant', content: 'x'.repeat(40) }, finish_reason: 'stop' }],
        usage: { prompt_tokens: 40, completion_tokens: 20, total_tokens: 100 }
      })
    )
  );
  const ctx = makeCtx({ provider: 'openai', model: 'gpt-4o', transport });
  const result = await tokenUsage.run(ctx);
  assert.equal(result.status, 'fail');
  const totalCheck = result.details.subChecks.find((c) => c.id === 'total_self_consistent');
  assert.equal(totalCheck.ok, false, 'total=100 ≠ prompt 40 + completion 20 必须判失败');
});

/* ------------------------------------------------------------------ */
/* stream_integrity（full 档）                                            */
/* ------------------------------------------------------------------ */

function openaiStreamChunks(text, usage) {
  const half = Math.floor(text.length / 2);
  return [
    { choices: [{ index: 0, delta: { content: text.slice(0, half) } }] },
    { choices: [{ index: 0, delta: { content: text.slice(half) }, finish_reason: 'stop' }] },
    { choices: [{ index: 0, delta: {} }], usage }
  ];
}

test('[关键回归] stream_integrity：流式与非流式文本明显不一致 → 扣分', async () => {
  const nonStreamText = '流式一致性测试 2378 1547';
  const transport = createAuthTransport(({ bodyJson }) => {
    if (bodyJson?.stream === true) {
      return sseResponse(openaiStreamChunks('完全不同的另一套上游输出内容', { prompt_tokens: 40, completion_tokens: 20, total_tokens: 60 }));
    }
    return jsonResponse(
      openaiCompletion({
        choices: [{ index: 0, message: { role: 'assistant', content: nonStreamText }, finish_reason: 'stop' }],
        usage: { prompt_tokens: 40, completion_tokens: 20, total_tokens: 60 }
      })
    );
  });
  const ctx = makeCtx({ provider: 'openai', model: 'gpt-4o', transport });
  const result = await streamIntegrity.run(ctx);
  assertDetectorResultShape(result, 'stream_integrity');
  assert.ok(result.details.similarity < 85, `相似度应 < 85，实际 ${result.details.similarity}`);
  const check = result.details.subChecks.find((c) => c.id === 'text_similarity');
  assert.equal(check.ok, false, '文本不一致必须判失败');
  assert.equal(result.status, 'fail');
});

test('[关键回归] stream_integrity：input_tokens 差 10 倍 → 判失败', async () => {
  const nonStreamText = '流式一致性测试 2378 1547';
  const transport = createAuthTransport(({ bodyJson }) => {
    if (bodyJson?.stream === true) {
      return sseResponse(
        openaiStreamChunks(nonStreamText, { prompt_tokens: 400, completion_tokens: 20, total_tokens: 420 })
      );
    }
    return jsonResponse(
      openaiCompletion({
        choices: [{ index: 0, message: { role: 'assistant', content: nonStreamText }, finish_reason: 'stop' }],
        usage: { prompt_tokens: 40, completion_tokens: 20, total_tokens: 60 }
      })
    );
  });
  const ctx = makeCtx({ provider: 'openai', model: 'gpt-4o', transport });
  const result = await streamIntegrity.run(ctx);
  assert.equal(result.details.similarity, 100, '前置：两路文本应一致');
  const check = result.details.subChecks.find((c) => c.id === 'input_tokens_parity');
  assert.equal(check.ok, false, 'input_tokens 40 vs 400（10 倍）必须判失败');
  assert.ok(result.score < 100, `input_tokens 严重不一致应扣分，实际 ${result.score}`);
});

test('stream_integrity：两条路径完全一致 → 100 分 pass', async () => {
  const text = '流式一致性测试 2378 1547';
  const usage = { prompt_tokens: 40, completion_tokens: 20, total_tokens: 60 };
  const transport = createAuthTransport(({ bodyJson }) => {
    if (bodyJson?.stream === true) return sseResponse(openaiStreamChunks(text, usage));
    return jsonResponse(
      openaiCompletion({
        choices: [{ index: 0, message: { role: 'assistant', content: text }, finish_reason: 'stop' }],
        usage
      })
    );
  });
  const ctx = makeCtx({ provider: 'openai', model: 'gpt-4o', transport });
  const result = await streamIntegrity.run(ctx);
  assert.equal(result.score, 100);
  assert.equal(result.status, 'pass');
  assert.equal(transport.calls.length, 2, '必须恰好 2 个请求（非流式 + 流式）');
});

test('textSimilarity / tokenTolerance 纯函数边界', () => {
  assert.equal(textSimilarity('abc', 'abc'), 100);
  assert.equal(textSimilarity('', ''), 100);
  assert.equal(tokenTolerance(40), 8, 'max(3, 20%)：40 → 8');
  assert.equal(tokenTolerance(5), 3, 'max(3, 20%)：5 → 3');
});

/* ------------------------------------------------------------------ */
/* capability_tools                                                      */
/* ------------------------------------------------------------------ */

test('capability_tools：真实 tool_calls（add_numbers 2378/1547）→ 100 分 pass', async () => {
  const transport = once(
    jsonResponse(
      openaiCompletion({
        choices: [
          {
            index: 0,
            message: {
              role: 'assistant',
              content: null,
              tool_calls: [
                {
                  id: 'call_abc123',
                  type: 'function',
                  function: { name: 'add_numbers', arguments: '{"a":2378,"b":1547}' }
                }
              ]
            },
            finish_reason: 'tool_calls'
          }
        ],
        usage: { prompt_tokens: 50, completion_tokens: 10, total_tokens: 60 }
      })
    )
  );
  const ctx = makeCtx({ provider: 'openai', model: 'gpt-4o', transport });
  const result = await capabilityTools.run(ctx);
  assertDetectorResultShape(result, 'capability_tools');
  assert.equal(result.score, 100);
  assert.equal(result.status, 'pass');
});

test('capability_tools：纯文本响应（没有工具调用）→ 扣分 fail', async () => {
  const transport = once(
    jsonResponse(
      openaiCompletion({
        choices: [
          {
            index: 0,
            message: { role: 'assistant', content: '2378 + 1547 = 3925' },
            finish_reason: 'stop'
          }
        ],
        usage: { prompt_tokens: 50, completion_tokens: 10, total_tokens: 60 }
      })
    )
  );
  const ctx = makeCtx({ provider: 'openai', model: 'gpt-4o', transport });
  const result = await capabilityTools.run(ctx);
  assert.equal(result.status, 'fail');
  const present = result.details.subChecks.find((c) => c.id === 'tool_call_present');
  assert.equal(present.ok, false, '没有 tool_calls 必须判失败');
  assert.ok(result.score < 70);
});

test('capability_tools：查不到模型能力 → appliesTo=false（skip，不拉低总分）', () => {
  const ctx = makeCtx({ provider: 'openai', model: 'some-unknown-model-xyz', modelInfo: null });
  assert.equal(capabilityTools.appliesTo(ctx), false);
  assert.equal(capabilityTools.skipReason(ctx), 'unknown_model');
});

test('argumentsMatch / toolCallIdCheck 纯函数', () => {
  assert.equal(argumentsMatch({ a: 2378, b: 1547 }), true);
  assert.equal(argumentsMatch({ a: 1547, b: 2378 }), true, '参数顺序可交换');
  assert.equal(argumentsMatch({ a: 1, b: 2 }), false);
  assert.equal(toolCallIdCheck('anthropic', { id: 'toolu_abc123' }).ok, true);
  assert.equal(toolCallIdCheck('anthropic', { id: 'call_abc' }).ok, false);
  assert.equal(toolCallIdCheck('gemini', { id: '' }).applicable, false, 'Gemini 无 id 视为 N/A');
});

/* ------------------------------------------------------------------ */
/* structured_output                                                     */
/* ------------------------------------------------------------------ */

test('evaluateStructuredOutput：精确字面量 100 / 代码块 50 / 错值 30 / 非 JSON 10 / 空 0', () => {
  assert.equal(evaluateStructuredOutput('{"answer":42,"tag":"ok"}').score, 100);
  assert.equal(evaluateStructuredOutput('```json\n{"answer":42,"tag":"ok"}\n```').score, 50);
  assert.equal(evaluateStructuredOutput('{"answer":1,"tag":"no"}').score, 30);
  assert.equal(evaluateStructuredOutput('not json').score, 10);
  assert.equal(evaluateStructuredOutput('').score, 0);
  assert.equal(evaluateStructuredOutput('```json\n{"answer":42,"tag":"ok"}\n```').fenced, true);
});

test('structured_output：被包在 Markdown 代码块里 → fail', async () => {
  const transport = once(
    jsonResponse(
      openaiCompletion({
        choices: [
          {
            index: 0,
            message: { role: 'assistant', content: '```json\n{"answer":42,"tag":"ok"}\n```' },
            finish_reason: 'stop'
          }
        ],
        usage: { prompt_tokens: 50, completion_tokens: 20, total_tokens: 70 }
      })
    )
  );
  const ctx = makeCtx({ provider: 'openai', model: 'gpt-4o', transport });
  const result = await structuredOutput.run(ctx);
  assert.equal(result.status, 'fail');
  assert.equal(result.score, 50, '代码块包裹必须扣到 50 分');
  const fenceCheck = result.details.subChecks.find((c) => c.id === 'no_markdown_fence');
  assert.equal(fenceCheck.ok, false);
});

/* ------------------------------------------------------------------ */
/* protocol_shape                                                        */
/* ------------------------------------------------------------------ */

test('protocol_shape：官方 OpenAI 结构 → 100 分 pass', async () => {
  const transport = once(jsonResponse(openaiCompletion()));
  const ctx = makeCtx({ provider: 'openai', model: 'gpt-4o', transport });
  const result = await protocolShape.run(ctx);
  assert.equal(result.score, 100);
  assert.equal(result.status, 'pass');
  assert.equal(result.details.subChecks.length, 6, 'OpenAI 结构应有 6 项检查');
});

test('protocol_shape：结构完全不符合官方协议 → fail', async () => {
  const transport = once(jsonResponse({ hello: 'world' }));
  const ctx = makeCtx({ provider: 'openai', model: 'gpt-4o', transport });
  const result = await protocolShape.run(ctx);
  assert.equal(result.status, 'fail');
  assert.ok(result.score < 70, `结构不符必须低分，实际 ${result.score}`);
});

/* ------------------------------------------------------------------ */
/* token_parity（默认无基线 → skip）                                      */
/* ------------------------------------------------------------------ */

test('token_parity：默认无内置基线 → skip（reason no_baseline），不扣分', async () => {
  const ctx = makeCtx({ provider: 'openai', model: 'gpt-4o' });
  assert.equal(tokenParity.appliesTo(ctx), false, '没有基线时 appliesTo 必须为 false');
  assert.equal(tokenParity.skipReason(ctx), 'no_baseline');
  const result = await tokenParity.run(ctx);
  assert.equal(result.status, 'skip');
  assert.equal(result.score, 0);
  assert.equal(result.reason, 'no_baseline');
  assert.equal(computeTotal([result]), 0);
});
