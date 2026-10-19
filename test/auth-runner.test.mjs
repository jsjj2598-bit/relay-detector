/**
 * v2 真伪检测运行器端到端测试（契约 §6.6 / §6.7 / §8 第 1、4、5 条）。
 *
 * 全部**离线**：注入伪造 transport，不联网、不需要真实 API Key。
 *
 * 覆盖：
 *  - 公开 API 形状（runAuthenticity / estimateCost / AUTH_MODES）
 *  - authenticity 报告符合契约 §6.6
 *  - transport 全部失败 → 不抛异常、verdict=invalid
 *  - 余额不足 / model_not_found → verdict=invalid（不是低分）
 *  - maxRequests 硬上限（剩余检测器 skip，reason=request_budget_exhausted）
 *  - 全 skip → verdict=invalid
 *  - 报告不含完整 API key（含上游回显 key 的脱敏）
 *  - 每个检测器 weight / status 合法，skip 时 score===0，report.score 与加权平均自洽
 *  - thinking 不支持 → skip 且总分不被拉低
 *  - cross_vendor critical → verdict 被封顶 marginal
 *  - estimateCost 请求数 / token 预估
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import {
  runAuthenticity,
  estimateCost,
  AUTH_MODES,
  AUTH_MODE_LABELS,
  getSuggestedModels,
  maskApiKey,
  scrubSecrets
} from '../src/core/auth/index.js';
import { AUTH_DETECTORS } from '../src/core/auth/detectors/index.js';
import { computeTotal, effectiveVerdict, verdictFor } from '../src/core/auth/scorer.js';
import {
  ERROR_BODIES,
  anthropicMessage,
  createAuthTransport,
  jsonResponse,
  openaiCompletion,
  sseResponse,
  thinkingBlock,
  throwingTransport
} from './helpers/auth-fixtures.mjs';

/* ------------------------------------------------------------------ */
/* 契约形状校验                                                          */
/* ------------------------------------------------------------------ */

const AUTH_VERDICTS = ['excellent', 'passed', 'marginal', 'failed', 'invalid'];
const VERDICT_LABELS = { excellent: '优秀', passed: '通过', marginal: '基本合格', failed: '未达标', invalid: '检测无效' };
const DETECTOR_STATUSES = ['pass', 'fail', 'skip', 'error'];
const PROVIDERS = ['openai', 'anthropic', 'gemini'];
const DETECTOR_BY_NAME = Object.fromEntries(AUTH_DETECTORS.map((detector) => [detector.name, detector]));

function assertDetectorResultValid(result, label) {
  assert.ok(result && typeof result === 'object', `${label}: DetectorResult 必须是对象`);
  assert.equal(typeof result.name, 'string', `${label}: name 必须是字符串`);
  assert.ok(result.name.length > 0, `${label}: name 不得为空`);
  assert.equal(typeof result.displayName, 'string', `${label}: displayName 必须是字符串`);
  assert.equal(typeof result.weight, 'number', `${label}: weight 必须是数字`);
  assert.ok(result.weight >= 0 && result.weight <= 100, `${label}: weight 越界 ${result.weight}`);
  assert.ok(DETECTOR_STATUSES.includes(result.status), `${label}: 非法 status "${result.status}"`);
  assert.equal(typeof result.score, 'number', `${label}: score 必须是数字`);
  assert.ok(result.score >= 0 && result.score <= 100, `${label}: score 越界 ${result.score}`);
  if (result.status === 'skip' || result.status === 'error') {
    assert.equal(result.score, 0, `${label}: status=${result.status} 时 score 必须为 0（契约 6.2）`);
  }
  assert.ok(result.details === undefined || (result.details && typeof result.details === 'object'), `${label}: details 形状非法`);
  assert.ok(result.error === null || result.error === undefined || typeof result.error === 'string', `${label}: error 形状非法`);
  assert.equal(typeof result.durationMs, 'number', `${label}: durationMs 必须是数字`);
  assert.ok(result.durationMs >= 0, `${label}: durationMs 不得为负`);
  const critical = result.criticalIssues === undefined ? [] : result.criticalIssues;
  assert.ok(Array.isArray(critical), `${label}: criticalIssues 必须是数组`);
  for (const issue of critical) {
    assert.equal(typeof issue.code, 'string', `${label}: criticalIssue.code 必须是字符串`);
    assert.equal(typeof issue.message, 'string', `${label}: criticalIssue.message 必须是字符串`);
    assert.ok('evidence' in issue, `${label}: criticalIssue 必须有 evidence`);
    assert.doesNotThrow(() => JSON.stringify(issue), `${label}: criticalIssue 必须可序列化`);
  }

  // 注册表里的元信息必须一致（防止 runner 把 weight 写错）
  const registry = DETECTOR_BY_NAME[result.name];
  assert.ok(registry, `${label}: 未知检测器 "${result.name}"`);
  assert.equal(result.weight, registry.weight, `${label}: weight 必须与注册表一致`);
}

function assertAuthReportValid(report, label) {
  assert.ok(report && typeof report === 'object', `${label}: 报告必须是对象`);
  assert.equal(report.schema, 1, `${label}: schema 必须为 1`);
  assert.ok(PROVIDERS.includes(report.provider), `${label}: 非法 provider "${report.provider}"`);
  assert.equal(typeof report.model, 'string', `${label}: model 必须是字符串`);
  assert.ok(AUTH_MODES.includes(report.mode), `${label}: 非法 mode "${report.mode}"`);
  assert.equal(typeof report.score, 'number', `${label}: score 必须是数字`);
  assert.ok(report.score >= 0 && report.score <= 100, `${label}: score 越界 ${report.score}`);
  assert.ok(AUTH_VERDICTS.includes(report.verdict), `${label}: 非法 verdict "${report.verdict}"`);
  assert.equal(typeof report.summaryText, 'string', `${label}: summaryText 必须是字符串`);
  if (VERDICT_LABELS[report.verdict]) {
    assert.ok(
      report.summaryText.includes(VERDICT_LABELS[report.verdict]),
      `${label}: summaryText "${report.summaryText}" 与 verdict "${report.verdict}" 不匹配`
    );
  }

  assert.ok(Array.isArray(report.detectors), `${label}: detectors 必须是数组`);
  const names = new Set();
  for (const result of report.detectors) {
    assertDetectorResultValid(result, `${label}/${result && result.name}`);
    assert.ok(!names.has(result.name), `${label}: 检测器重复 "${result.name}"`);
    names.add(result.name);
  }

  assert.ok(Array.isArray(report.criticalIssues), `${label}: criticalIssues 必须是数组`);
  for (const issue of report.criticalIssues) {
    assert.equal(typeof issue.detector, 'string', `${label}: criticalIssue.detector 必须是字符串`);
    assert.equal(typeof issue.code, 'string');
    assert.equal(typeof issue.message, 'string');
    assert.ok('evidence' in issue);
    assert.doesNotThrow(() => JSON.stringify(issue));
  }

  assert.ok(report.runError === null || typeof report.runError === 'object', `${label}: runError 必须是 null 或对象`);
  if (report.runError) {
    assert.match(String(report.runError.code), /^[a-z][a-z0-9_]*$/, `${label}: runError.code 必须是 snake_case`);
    assert.equal(typeof report.runError.message, 'string');
    assert.equal(report.verdict, 'invalid', `${label}: 有 runError 时 verdict 必须 invalid`);
  }

  assert.ok(report.cost && typeof report.cost === 'object', `${label}: cost 必须是对象`);
  for (const key of ['requests', 'promptTokens', 'completionTokens']) {
    assert.equal(typeof report.cost[key], 'number', `${label}: cost.${key} 必须是数字`);
    assert.ok(report.cost[key] >= 0, `${label}: cost.${key} 不得为负`);
    assert.ok(Number.isFinite(report.cost[key]), `${label}: cost.${key} 必须有限`);
  }
  assert.equal(typeof report.cost.note, 'string', `${label}: cost.note 必须是字符串`);

  assert.ok(Array.isArray(report.warnings), `${label}: warnings 必须是数组`);
  for (const warning of report.warnings) assert.equal(typeof warning, 'string');

  for (const key of ['startedAt', 'finishedAt', 'durationMs']) {
    assert.equal(typeof report[key], 'number', `${label}: ${key} 必须是数字`);
    assert.ok(Number.isFinite(report[key]));
  }
  assert.ok(report.durationMs >= 0);

  // 分数与 verdict 必须可由 scorer 从 detectors 复算（防止统计口径不一致）
  assert.equal(report.score, computeTotal(report.detectors), `${label}: report.score 必须等于 computeTotal(detectors)`);
  assert.equal(
    report.verdict,
    report.runError ? 'invalid' : effectiveVerdict(report.score, report.detectors),
    `${label}: verdict 必须由 scorer 复算一致`
  );
}

/* ------------------------------------------------------------------ */
/* 兼容 fetch 的伪造上游                                                 */
/* ------------------------------------------------------------------ */

const OPENAI_TEXT = '1,2,3,4,5,6,7,8,9,10,11,12,13,14,15,16,17,18,19,20';

function withLeak(usage, leak) {
  if (!leak) return usage;
  return { ...usage, claude_cache_creation_5_m_tokens: 3, usage_source: 'anthropic' };
}

/** 全绿的 OpenAI 兼容上游（按 prompt 路由响应）。 */
function openaiHappyTransport({ model = 'gpt-4o', leak = false } = {}) {
  let counter = 0;
  const usage = (prompt, completion) => withLeak(
    { prompt_tokens: prompt, completion_tokens: completion, total_tokens: prompt + completion },
    leak
  );
  return createAuthTransport(({ bodyJson, url }) => {
    const prompt = String(bodyJson?.messages?.[0]?.content ?? '');
    const isStream = bodyJson?.stream === true;

    if (prompt.includes('请只回复 ok')) {
      return jsonResponse(
        openaiCompletion({
          model,
          choices: [{ index: 0, message: { role: 'assistant', content: 'ok' }, finish_reason: 'stop' }],
          usage: usage(20, 2)
        })
      );
    }
    if (prompt.includes('质数')) {
      counter += 1;
      return jsonResponse(
        openaiCompletion({
          id: `chatcmpl-consistency-${counter}`,
          model,
          choices: [
            {
              index: 0,
              message: { role: 'assistant', content: '质数是只能被 1 和自身整除的大于 1 的自然数。' },
              finish_reason: 'stop'
            }
          ],
          usage: usage(30, 20)
        })
      );
    }
    if (prompt.includes('integers from 1 to 20')) {
      return jsonResponse(
        openaiCompletion({
          model,
          choices: [{ index: 0, message: { role: 'assistant', content: OPENAI_TEXT }, finish_reason: 'stop' }],
          usage: usage(30, 20)
        })
      );
    }
    if (prompt.includes('{"answer":42')) {
      return jsonResponse(
        openaiCompletion({
          model,
          choices: [
            { index: 0, message: { role: 'assistant', content: '{"answer":42,"tag":"ok"}' }, finish_reason: 'stop' }
          ],
          usage: usage(50, 20)
        })
      );
    }
    if (prompt.includes('add_numbers')) {
      return jsonResponse(
        openaiCompletion({
          model,
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
          usage: usage(50, 10)
        })
      );
    }
    if (prompt.includes('流式一致性测试')) {
      if (isStream) {
        return sseResponse([
          { choices: [{ index: 0, delta: { content: prompt.replace(/^[^：:]*[：:]/, '') } }] },
          { choices: [{ index: 0, delta: {}, finish_reason: 'stop' }], usage: usage(40, 20) }
        ]);
      }
      return jsonResponse(
        openaiCompletion({
          model,
          choices: [
            {
              index: 0,
              message: { role: 'assistant', content: prompt.replace(/^[^：:]*[：:]/, '') },
              finish_reason: 'stop'
            }
          ],
          usage: usage(40, 20)
        })
      );
    }
    return jsonResponse(
      openaiCompletion({
        model,
        choices: [{ index: 0, message: { role: 'assistant', content: 'ok' }, finish_reason: 'stop' }],
        usage: usage(20, 2)
      })
    );
  });
}

const STREAM_TEXT = '流式一致性测试 2378 1547';

/** 全绿的 Anthropic 兼容上游；thinking 参数控制签名状态。 */
function anthropicHappyTransport({ model = 'claude-sonnet-4-5', thinking = 'valid' } = {}) {
  let counter = 0;
  const usage = (input, output) => ({ input_tokens: input, output_tokens: output });
  const message = (content, usageOverride = usage(20, 5)) => {
    counter += 1;
    return anthropicMessage({
      id: `msg_01HAPPY${String(counter).padStart(6, '0')}`,
      model,
      content,
      stop_reason: content.some((block) => block.type === 'tool_use') ? 'tool_use' : 'end_turn',
      usage: usageOverride
    });
  };

  return createAuthTransport(({ bodyJson }) => {
    const prompt = String(bodyJson?.messages?.[0]?.content ?? '');
    const isStream = bodyJson?.stream === true;

    if (prompt.includes('请只回复 ok')) {
      return jsonResponse(message([{ type: 'text', text: 'ok' }], usage(20, 2)));
    }
    if (prompt.includes('质数')) {
      return jsonResponse(message([{ type: 'text', text: '质数是只能被 1 和自身整除的大于 1 的自然数。' }], usage(30, 20)));
    }
    if (prompt.includes('gcd(2378, 1547)')) {
      let content;
      if (thinking === 'valid') {
        content = [
          thinkingBlock({ signature: 'EqQBCkgIBRABGAIiQL' + 'a'.repeat(300) }),
          { type: 'text', text: 'gcd = 1' }
        ];
      } else if (thinking === 'nosig') {
        content = [{ type: 'thinking', thinking: '先做欧几里得除法……' }, { type: 'text', text: 'gcd = 1' }];
      } else if (thinking === 'short') {
        content = [thinkingBlock({ signature: 'short-sig' }), { type: 'text', text: 'gcd = 1' }];
      } else {
        content = [{ type: 'text', text: 'gcd = 1' }];
      }
      return jsonResponse(message(content, usage(120, 80)));
    }
    if (prompt.includes('integers from 1 to 20')) {
      return jsonResponse(message([{ type: 'text', text: OPENAI_TEXT }], usage(30, 20)));
    }
    if (prompt.includes('{"answer":42')) {
      return jsonResponse(message([{ type: 'text', text: '{"answer":42,"tag":"ok"}' }], usage(50, 20)));
    }
    if (prompt.includes('add_numbers')) {
      return jsonResponse(
        message(
          [
            {
              type: 'tool_use',
              id: 'toolu_abc123456',
              name: 'add_numbers',
              input: { a: 2378, b: 1547 }
            }
          ],
          usage(50, 10)
        )
      );
    }
    if (prompt.includes('流式一致性测试')) {
      if (isStream) {
        return sseResponse([
          { type: 'message_start', message: { id: 'msg_stream', type: 'message', role: 'assistant', model, content: [], usage: usage(40, 0) } },
          { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } },
          { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: STREAM_TEXT } },
          { type: 'content_block_stop', index: 0 },
          { type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 20 } },
          { type: 'message_stop' }
        ]);
      }
      return jsonResponse(message([{ type: 'text', text: STREAM_TEXT }], usage(40, 20)));
    }
    return jsonResponse(message([{ type: 'text', text: 'ok' }], usage(20, 2)));
  });
}

/** 对检测器 result 手工算加权平均（skip/error 不进入分母），用于验证「skip 不拉低总分」。 */
function weightedAverageExcludingSkip(results) {
  let weighted = 0;
  let weight = 0;
  for (const result of results) {
    if (result.status === 'skip' || result.status === 'error') continue;
    weighted += result.score * result.weight;
    weight += result.weight;
  }
  return weight <= 0 ? 0 : Number((weighted / weight).toFixed(4));
}

/* ------------------------------------------------------------------ */
/* 公开 API 形状                                                         */
/* ------------------------------------------------------------------ */

test('auth/index.js 导出契约 6.6 要求的公开 API', () => {
  assert.equal(typeof runAuthenticity, 'function');
  assert.equal(typeof estimateCost, 'function');
  assert.deepEqual(AUTH_MODES, ['quick', 'standard', 'full'], 'AUTH_MODES 必须是 quick/standard/full');
  assert.equal(typeof AUTH_MODE_LABELS, 'object');
  for (const mode of AUTH_MODES) assert.equal(typeof AUTH_MODE_LABELS[mode], 'string');
  assert.equal(typeof getSuggestedModels, 'function');
  assert.equal(typeof maskApiKey, 'function');
  assert.equal(typeof scrubSecrets, 'function');
});

test('runAuthenticity：默认 provider/mode/model 归一化（契约 6.6）', async () => {
  const transport = openaiHappyTransport();
  const report = await runAuthenticity({ transport });
  assertAuthReportValid(report, 'defaults');
  assert.equal(report.provider, 'openai');
  assert.equal(report.model, 'gpt-4o');
  assert.equal(report.mode, 'standard');
});

/* ------------------------------------------------------------------ */
/* 全绿 e2e                                                              */
/* ------------------------------------------------------------------ */

test('runAuthenticity：OpenAI 全绿上游 → score 100 / excellent，报告形状合法', async () => {
  const transport = openaiHappyTransport();
  const report = await runAuthenticity({
    provider: 'openai',
    baseUrl: 'https://relay.example.com/v1',
    apiKey: 'sk-test-openai-happy',
    model: 'gpt-4o',
    mode: 'standard',
    transport
  });
  assertAuthReportValid(report, 'openai-happy');
  assert.equal(report.score, 100, `全绿上游应 100 分，实际 ${report.score}（detectors=${JSON.stringify(report.detectors.map((d) => [d.name, d.status, d.score]))}）`);
  assert.equal(report.verdict, 'excellent');
  assert.equal(report.runError, null);
  assert.equal(report.criticalIssues.length, 0);
  assert.equal(report.cost.requests, transport.calls.length, 'cost.requests 必须等于实际请求数');

  const byName = Object.fromEntries(report.detectors.map((d) => [d.name, d]));
  assert.equal(byName.protocol_shape.status, 'pass');
  assert.equal(byName.cross_vendor_leak.status, 'pass');
  assert.equal(byName.model_consistency.status, 'pass');
  assert.equal(byName.token_usage.status, 'pass');
  assert.equal(byName.structured_output.status, 'pass');
  assert.equal(byName.capability_tools.status, 'pass');
  assert.equal(byName.thinking_signature.status, 'skip', '非 Anthropic 协议 thinking 必须 skip');
  assert.equal(byName.message_id.status, 'skip', '非 Anthropic 协议 message_id 必须 skip');
  assert.equal(byName.token_parity.status, 'skip', 'standard 档不包含 token_parity，必须 skip');
  assert.equal(byName.token_parity.reason, 'mode_not_selected', 'standard 档的 token_parity 应为档位未选择');
});

test('runAuthenticity：cost 统计汇总上游 usage（requests / promptTokens / completionTokens）', async () => {
  const transport = openaiHappyTransport();
  const report = await runAuthenticity({
    provider: 'openai',
    model: 'gpt-4o',
    mode: 'standard',
    apiKey: 'sk-test',
    transport
  });
  // standard：protocol 1 + model_consistency 3 + token_usage 1 + structured 1 + capability 1 = 7
  assert.equal(report.cost.requests, 7, `standard 档应有 7 个请求，实际 ${report.cost.requests}`);
  assert.equal(transport.calls.length, 7, `实际发出 ${transport.calls.length} 个请求`);
  // prompt: 20 + 30*3 + 30 + 50 + 50 = 240；completion: 2 + 20*3 + 20 + 20 + 10 = 112
  assert.equal(report.cost.promptTokens, 240, 'promptTokens 汇总错误');
  assert.equal(report.cost.completionTokens, 112, 'completionTokens 汇总错误');
});

test('runAuthenticity：Anthropic 全绿上游（thinking 签名正常）→ score 100 / excellent', async () => {
  const transport = anthropicHappyTransport({ model: 'claude-sonnet-4-5', thinking: 'valid' });
  const report = await runAuthenticity({
    provider: 'anthropic',
    baseUrl: 'https://relay.example.com',
    apiKey: 'sk-ant-test-happy-key',
    model: 'claude-sonnet-4-5',
    mode: 'standard',
    transport
  });
  assertAuthReportValid(report, 'anthropic-happy');
  assert.equal(report.score, 100, `detectors=${JSON.stringify(report.detectors.map((d) => [d.name, d.status, d.score]))}`);
  assert.equal(report.verdict, 'excellent');
  const thinking = report.detectors.find((d) => d.name === 'thinking_signature');
  assert.equal(thinking.status, 'pass');
  assert.equal(thinking.score, 100);
  const messageId = report.detectors.find((d) => d.name === 'message_id');
  assert.equal(messageId.status, 'pass');
});

/* ------------------------------------------------------------------ */
/* 关键回归：thinking skip 不拉低总分                                     */
/* ------------------------------------------------------------------ */

test('[关键回归] thinking 不支持 → thinking_signature skip，且总分不被拉低（与 Sonnet 缺失签名对比）', async () => {
  const haiku = 'claude-3-5-haiku-20241022'; // 模型能力表：thinking = null
  const haikuReport = await runAuthenticity({
    provider: 'anthropic',
    model: haiku,
    mode: 'standard',
    apiKey: 'sk-ant-test-haiku',
    transport: anthropicHappyTransport({ model: haiku, thinking: 'none' })
  });
  assertAuthReportValid(haikuReport, 'haiku');
  const haikuThinking = haikuReport.detectors.find((d) => d.name === 'thinking_signature');
  assert.equal(haikuThinking.status, 'skip', '模型不支持 thinking 时必须 skip');
  assert.equal(haikuThinking.score, 0);
  assert.equal(haikuThinking.reason, 'model_capability_missing');
  assert.equal(
    haikuReport.score,
    weightedAverageExcludingSkip(haikuReport.detectors),
    'skip 不得进入加权分母'
  );
  assert.equal(haikuReport.score, 100, `其他检测器全绿时总分必须 100（skip 不拉低），实际 ${haikuReport.score}`);
  assert.ok(
    haikuReport.warnings.some((w) => w.includes('思维签名') || w.includes('thinking')),
    `必须给出 skip 说明 warnings，实际 ${JSON.stringify(haikuReport.warnings)}`
  );

  // 同一个全绿上游，Sonnet 但上游吞掉 thinking 块 → 0 分，总分明显更低
  const sonnetReport = await runAuthenticity({
    provider: 'anthropic',
    model: 'claude-sonnet-4-5',
    mode: 'standard',
    apiKey: 'sk-ant-test-sonnet',
    transport: anthropicHappyTransport({ model: 'claude-sonnet-4-5', thinking: 'none' })
  });
  const sonnetThinking = sonnetReport.detectors.find((d) => d.name === 'thinking_signature');
  assert.equal(sonnetThinking.status, 'fail');
  assert.equal(sonnetThinking.score, 0, '被声明支持 thinking 的模型无 thinking 块必须 0 分');
  assert.ok(sonnetReport.score < haikuReport.score, `Sonnet 无 thinking 的总分(${sonnetReport.score})应低于 haiku 的 skip(${haikuReport.score})`);
  assert.ok(sonnetReport.score >= 70, `其余检测器全绿时总分应仍在 passed 区间，实际 ${sonnetReport.score}`);
});

/* ------------------------------------------------------------------ */
/* 关键回归：余额不足 / model_not_found → invalid                         */
/* ------------------------------------------------------------------ */

test('[关键回归] runAuthenticity：上游 insufficient_quota → verdict invalid（不是低分）', async () => {
  const transport = createAuthTransport(() => jsonResponse(ERROR_BODIES.insufficientQuota, { status: 429 }));
  const report = await runAuthenticity({
    provider: 'openai',
    model: 'gpt-4o',
    mode: 'quick',
    apiKey: 'sk-test-quota',
    transport
  });
  assertAuthReportValid(report, 'quota');
  assert.equal(report.verdict, 'invalid', `余额不足必须判「检测无效」，实际 ${report.verdict}（score=${report.score}）`);
  assert.equal(report.summaryText, '检测无效');
  assert.ok(report.runError, '必须带 runError');
  assert.equal(report.runError.code, 'insufficient_quota');
  assert.ok(
    !report.detectors.some((d) => d.status === 'pass'),
    '余额不足时不应有任何检测器判 pass'
  );
  assert.ok(report.warnings.some((w) => w.includes('检测无效')), 'warnings 必须解释检测无效');
});

test('[关键回归] runAuthenticity：上游 model_not_found → verdict invalid（不是低分）', async () => {
  const transport = createAuthTransport(() => jsonResponse(ERROR_BODIES.modelNotFound, { status: 404 }));
  const report = await runAuthenticity({
    provider: 'openai',
    model: 'gpt-4o',
    mode: 'quick',
    apiKey: 'sk-test-notfound',
    transport
  });
  assertAuthReportValid(report, 'model-not-found');
  assert.equal(report.verdict, 'invalid');
  assert.ok(report.runError);
  assert.equal(report.runError.code, 'model_unavailable');
});

test('runAuthenticity：普通 500 错误不判 fatal，但全部测不出来 → invalid（不是 failed 低分）', async () => {
  const transport = createAuthTransport(() => jsonResponse({ error: { message: 'internal server error' } }, { status: 500 }));
  const report = await runAuthenticity({
    provider: 'openai',
    model: 'gpt-4o',
    mode: 'quick',
    apiKey: 'sk-test-500',
    transport
  });
  assertAuthReportValid(report, 'http-500');
  assert.equal(report.runError, null, '普通 500 不得被判为 fatal runError');
  assert.equal(report.verdict, 'invalid', '全部检测器 error 时必须是「检测无效」而不是低分 failed');
  assert.ok(report.warnings.length > 0);
});

test('[关键回归] runAuthenticity：transport 全部抛错 → 不抛异常，verdict invalid', async () => {
  const transport = throwingTransport('fetch failed');
  let report;
  await assert.doesNotReject(async () => {
    report = await runAuthenticity({
      provider: 'openai',
      baseUrl: 'https://relay.example.com/v1',
      model: 'gpt-4o',
      mode: 'standard',
      apiKey: 'sk-test-transport-fail',
      transport
    });
  }, 'runAuthenticity 在 transport 全部失败时不得抛异常（契约 §8.4）');
  assertAuthReportValid(report, 'transport-fail');
  assert.equal(report.verdict, 'invalid');
  assert.equal(report.summaryText, '检测无效');
  assert.ok(
    report.detectors.every((d) => ['error', 'skip'].includes(d.status)),
    `全部 transport 失败时不应有 pass/fail 结果，实际 ${JSON.stringify(report.detectors.map((d) => [d.name, d.status]))}`
  );
});

/* ------------------------------------------------------------------ */
/* maxRequests 硬上限                                                     */
/* ------------------------------------------------------------------ */

test('[关键回归] maxRequests 硬上限：超出部分 skip（reason=request_budget_exhausted），不发多余请求', async () => {
  const transport = openaiHappyTransport();
  const report = await runAuthenticity({
    provider: 'openai',
    model: 'gpt-4o',
    mode: 'quick',
    apiKey: 'sk-test-budget',
    transport,
    options: { maxRequests: 1 }
  });
  assertAuthReportValid(report, 'budget-1');
  assert.equal(transport.calls.length, 1, `maxRequests=1 时只能发出 1 个请求，实际 ${transport.calls.length}`);
  assert.equal(report.cost.requests, 1);
  const modelConsistency = report.detectors.find((d) => d.name === 'model_consistency');
  assert.equal(modelConsistency.status, 'skip', '预算耗尽的检测器必须 skip');
  assert.equal(modelConsistency.score, 0);
  assert.equal(modelConsistency.reason, 'request_budget_exhausted');
  assert.ok(
    report.warnings.some((w) => w.includes('硬上限')),
    `必须给出预算耗尽 warning，实际 ${JSON.stringify(report.warnings)}`
  );
});

test('[关键回归] maxRequests=0：不发出任何请求，全部 skip → verdict invalid', async () => {
  const transport = openaiHappyTransport();
  const report = await runAuthenticity({
    provider: 'openai',
    model: 'gpt-4o',
    mode: 'quick',
    apiKey: 'sk-test-budget-zero',
    transport,
    options: { maxRequests: 0 }
  });
  assertAuthReportValid(report, 'budget-0');
  assert.equal(transport.calls.length, 0, 'maxRequests=0 时不得发出任何请求');
  assert.equal(report.cost.requests, 0);
  assert.ok(report.detectors.every((d) => d.status === 'skip'), '全部检测器都应 skip');
  assert.equal(report.verdict, 'invalid', '全 skip 必须是「检测无效」而不是 0 分 failed（契约 6.2 第 2 条）');
});

test('maxRequests 硬上限：full 档也不会超出上限', async () => {
  const transport = openaiHappyTransport();
  const report = await runAuthenticity({
    provider: 'openai',
    model: 'gpt-4o',
    mode: 'full',
    apiKey: 'sk-test-budget-full',
    transport,
    options: { maxRequests: 3 }
  });
  assertAuthReportValid(report, 'budget-full');
  assert.ok(transport.calls.length <= 3, `请求数 ${transport.calls.length} 超过 maxRequests=3`);
  assert.equal(report.cost.requests, transport.calls.length);
  assert.ok(
    report.detectors.some((d) => d.reason === 'request_budget_exhausted'),
    '预算耗尽后剩余检测器必须 skip 并给出 reason'
  );
});

/* ------------------------------------------------------------------ */
/* 关键回归：cross_vendor_leak critical → verdict 封顶                   */
/* ------------------------------------------------------------------ */

test('[关键回归] cross_vendor_leak 检出跨厂商字段 → 报告 criticalIssues，verdict 封顶 marginal', async () => {
  const transport = openaiHappyTransport({ leak: true });
  const report = await runAuthenticity({
    provider: 'openai',
    model: 'gpt-4o',
    mode: 'standard',
    apiKey: 'sk-test-leak',
    transport
  });
  assertAuthReportValid(report, 'cross-vendor-leak');
  assert.ok(report.criticalIssues.length > 0, '必须产出报告级 criticalIssues');
  assert.equal(report.criticalIssues[0].detector, 'cross_vendor_leak');
  assert.match(report.criticalIssues[0].code, /cross_vendor/);

  const leakDetector = report.detectors.find((d) => d.name === 'cross_vendor_leak');
  assert.equal(leakDetector.status, 'fail');
  assert.equal(leakDetector.score, 0);
  assert.ok(leakDetector.criticalIssues.length > 0, '检测器自身也必须带 criticalIssues');

  assert.ok(report.score >= 70, `其余检测器全绿时分数仍然不低，实际 ${report.score}（这正是 critical 与分数解耦的原因）`);
  assert.equal(verdictFor(report.score), 'passed', '前置：无 critical 时该分数应判 passed');
  assert.equal(report.verdict, 'marginal', 'critical 一票降级：passed 必须封顶为 marginal');
  assert.equal(report.runError, null);
});

/* ------------------------------------------------------------------ */
/* 密钥脱敏（契约 6.7）                                                  */
/* ------------------------------------------------------------------ */

test('[关键回归] 报告内绝不出现完整 API key（请求头与上游回显都不得泄漏）', async () => {
  const SECRET = 'sk-ant-api03-UNIQUE-SECRET-abcdef0123456789';
  const transport = openaiHappyTransport();
  const report = await runAuthenticity({
    provider: 'openai',
    model: 'gpt-4o',
    mode: 'standard',
    apiKey: SECRET,
    transport
  });
  assertAuthReportValid(report, 'redaction');
  assert.ok(!JSON.stringify(report).includes(SECRET), '报告中出现了完整 API key');
  // 但请求本身必须带上 key（证明脱敏只发生在报告层）
  assert.equal(transport.calls[0].headers.authorization, `Bearer ${SECRET}`, '真实请求必须携带 API key');
  // 报告中如出现 key，只能是 maskApiKey 形式
  const masked = maskApiKey(SECRET);
  assert.equal(masked.startsWith('sk-a'), true);
  assert.ok(masked.includes('••••'));
});

test('上游把 API key 回显在错误报文里 → 报告必须脱敏', async () => {
  const SECRET = 'sk-ant-api03-ECHOED-IN-ERROR-0123456789';
  const transport = createAuthTransport(() =>
    jsonResponse({ error: { message: `Incorrect API key provided: ${SECRET}. Check your key.`, type: 'invalid_request_error' } }, { status: 401 })
  );
  const report = await runAuthenticity({
    provider: 'openai',
    model: 'gpt-4o',
    mode: 'quick',
    apiKey: SECRET,
    transport
  });
  assertAuthReportValid(report, 'echoed-key');
  assert.ok(!JSON.stringify(report).includes(SECRET), '上游回显的 key 必须被脱敏');
  assert.ok(
    JSON.stringify(report).includes(maskApiKey(SECRET)),
    '报告里应出现 maskApiKey 形式（前 4 + •••• + 后 4）'
  );
});

test('scrubSecrets：递归替换对象/数组中的完整 key', () => {
  const SECRET = 'sk-secret-value-1234567890';
  const input = {
    a: `prefix ${SECRET} suffix`,
    b: [SECRET, { c: SECRET }],
    d: 42,
    e: true
  };
  const out = scrubSecrets(input, SECRET);
  assert.ok(!JSON.stringify(out).includes(SECRET));
  assert.ok(String(out.a).includes(maskApiKey(SECRET)));
  assert.equal(out.d, 42);
  assert.equal(out.e, true);
  assert.equal(scrubSecrets(input, ''), input, '空 key 原样返回');
});

/* ------------------------------------------------------------------ */
/* 检测器结果语义                                                        */
/* ------------------------------------------------------------------ */

test('报告 detectors 顺序与注册表一致，且每个 skip 的 reason 可解释', async () => {
  const transport = anthropicHappyTransport({ model: 'claude-3-5-haiku-20241022', thinking: 'none' });
  const report = await runAuthenticity({
    provider: 'anthropic',
    model: 'claude-3-5-haiku-20241022',
    mode: 'quick',
    apiKey: 'sk-ant-quick',
    transport
  });
  assertAuthReportValid(report, 'quick-order');
  assert.deepEqual(
    report.detectors.map((d) => d.name),
    AUTH_DETECTORS.map((d) => d.name),
    'detectors 顺序必须与注册表（契约 §6.4）一致'
  );
  // quick 档：thinking / message_id / token_usage / ... 应 skip 且带 reason
  const thinking = report.detectors.find((d) => d.name === 'thinking_signature');
  assert.equal(thinking.status, 'skip');
  assert.ok(thinking.reason, 'skip 必须带机器可读 reason');
});

test('full 档跑满 10 个检测器：stream_integrity pass，token_parity 因无基线 skip', async () => {
  const transport = openaiHappyTransport();
  const report = await runAuthenticity({
    provider: 'openai',
    model: 'gpt-4o',
    mode: 'full',
    apiKey: 'sk-test-full',
    transport
  });
  assertAuthReportValid(report, 'full');
  const byName = Object.fromEntries(report.detectors.map((d) => [d.name, d]));
  assert.equal(byName.stream_integrity.status, 'pass', `stream_integrity 应 pass，实际 ${byName.stream_integrity.status}: ${byName.stream_integrity.error}`);
  assert.equal(byName.token_parity.status, 'skip');
  assert.equal(byName.token_parity.reason, 'no_baseline');
  assert.equal(report.score, 100);
  assert.equal(report.verdict, 'excellent');
});

/* ------------------------------------------------------------------ */
/* estimateCost（发请求前的费用预估，契约 6.6）                           */
/* ------------------------------------------------------------------ */

test('estimateCost：返回契约要求的字段与合理请求数（档位单调、契约区间）', () => {
  const cases = [
    ['openai', 'gpt-4o'],
    ['anthropic', 'claude-sonnet-4-5'],
    ['gemini', 'gemini-2.5-flash']
  ];
  for (const [provider, model] of cases) {
    let previous = 0;
    for (const [mode, min, max] of [['quick', 3, 6], ['standard', 6, 14], ['full', 8, 20]]) {
      const estimate = estimateCost({ provider, model, mode });
      assert.equal(typeof estimate.requests, 'number', `${provider}/${mode}: requests 必须是数字`);
      assert.ok(Number.isInteger(estimate.requests), `${provider}/${mode}: requests 必须是整数`);
      assert.ok(
        estimate.requests >= min && estimate.requests <= max,
        `${provider}/${mode}: 请求数 ${estimate.requests} 超出契约 6.4 的经验区间 ${min}–${max}`
      );
      assert.ok(estimate.requests >= previous, `${provider}/${mode}: 档位越大请求数不得减少`);
      previous = estimate.requests;
      assert.equal(typeof estimate.promptTokens, 'number');
      assert.equal(typeof estimate.completionTokens, 'number');
      assert.ok(estimate.promptTokens > 0 && estimate.completionTokens > 0);
      assert.equal(typeof estimate.note, 'string');
      assert.ok(estimate.note.length > 0, 'estimateCost 必须给出可展示的说明');
      const breakdownSum = Array.isArray(estimate.breakdown)
        ? estimate.breakdown.reduce((sum, row) => sum + row.requests, 0)
        : estimate.requests;
      assert.equal(estimate.requests, breakdownSum, `${provider}/${mode}: breakdown 与请求数不一致`);
    }
  }
});

test('estimateCost：支持 thinking 的模型会多一个 thinking 请求，不支持的模型更少', () => {
  const sonnet = estimateCost({ provider: 'anthropic', model: 'claude-sonnet-4-5', mode: 'standard' });
  const haiku = estimateCost({ provider: 'anthropic', model: 'claude-3-5-haiku-20241022', mode: 'standard' });
  assert.equal(sonnet.requests, haiku.requests + 1, 'thinking 模型应多 1 个请求');
  assert.ok(sonnet.completionTokens > haiku.completionTokens, 'thinking 的 token 预估应更高');
});

test('estimateCost：非法 / 缺省输入安全回落（不抛错）', () => {
  for (const bad of [null, undefined, {}, { provider: 'nope', model: '', mode: 'bogus' }]) {
    let estimate;
    assert.doesNotThrow(() => {
      estimate = estimateCost(bad);
    }, `estimateCost(${JSON.stringify(bad)}) 不得抛错`);
    assert.equal(typeof estimate.requests, 'number');
    assert.ok(estimate.requests >= 0);
    assert.equal(typeof estimate.note, 'string');
  }
  const fallback = estimateCost({});
  assert.equal(fallback.requests, estimateCost({ provider: 'openai', model: 'gpt-4o', mode: 'standard' }).requests);
});

test('getSuggestedModels：各协议返回非空模型列表（UI 下拉用，契约 6.5）', () => {
  for (const provider of ['openai', 'anthropic', 'gemini']) {
    const models = getSuggestedModels(provider);
    assert.ok(Array.isArray(models) && models.length > 0, `${provider}: 模型列表不得为空`);
    for (const model of models) {
      assert.equal(typeof model.id, 'string');
      assert.ok(model.id.length > 0);
    }
  }
});
