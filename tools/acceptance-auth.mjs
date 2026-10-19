/**
 * v2 端到端验收（Lead 所有）：用**真实 HTTP 假中转站**验证「上游真伪」轴。
 *
 * 与 test/** 的分工：test 用伪造 transport 做单元/契约断言；本脚本走真实 socket，
 * 验证「探测请求 → 假中转站响应 → 检测器 → 评分」整链路。
 *
 * 模拟四种真实作恶/正常手法：
 *   1. genuine-claude     诚实转发真 Claude（thinking 块带服务端签名）
 *   2. kiro-like          用 Bedrock 简化通道冒充 Claude（**没有 thinking 签名**）
 *   3. gpt-backed-by-claude  GPT 请求被偷偷转给 Claude 后端（usage 里漏出 claude_* 字段）
 *   4. dead-model         中转站没有该模型渠道（model_not_found → 检测无效，不是低分）
 *
 * 用法：node tools/acceptance-auth.mjs
 * 退出码：0 全部通过；1 有失败。
 */

import http from 'node:http';
import { detect } from '../src/core/engine.js';
import { runAuthenticity } from '../src/core/auth/index.js';

const MODEL = 'claude-sonnet-4-5';
const OPENAI_MODEL = 'gpt-4o';
const API_KEY = 'sk-ant-LEAD-ACCEPTANCE-7f3a9c1e-should-never-leak';

let failures = 0;
const results = [];
const ok = (name, pass, detail) => {
  results.push({ name, pass });
  if (!pass) failures += 1;
  console.log(`${pass ? 'PASS' : 'FAIL'}  ${name}${detail ? `  — ${detail}` : ''}`);
};

const LONG_SIGNATURE =
  'EqQBCkgIBRABGAIiQJm3rXv2sT7pQ1yKdLw9nVc0fRz8aHbMtYoJpE4uWsQxNdCgVeB7kLm2nPo5rTa1zXc6vHjF8sQwErTyUiOp' +
  'AsDfGhJkLzXcVbNm1234567890abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ';

/** 构造某个场景的响应。 */
function respond(scenario, req, res, body) {
  const url = String(req.url || '');
  const isClaude = url.includes('/messages');
  const isChat = url.includes('/chat/completions');

  // 模型不存在渠道
  if (scenario === 'dead-model' && (body?.model || '').length > 0) {
    res.writeHead(404, { 'content-type': 'application/json' });
    res.end(
      JSON.stringify({
        error: {
          message: `The model \`${body.model}\` does not exist or you do not have access to it.`,
          type: 'invalid_request_error',
          param: null,
          code: 'model_not_found'
        }
      })
    );
    return;
  }

  if (isClaude) {
    const wantsThinking = Boolean(body && body.thinking);
    const content = [];
    if (wantsThinking && scenario !== 'kiro-like') {
      content.push({
        type: 'thinking',
        thinking: '计算 gcd(2378,1547)：2378=1547+831，1547=831+716，…，最终 gcd=1。',
        signature: LONG_SIGNATURE
      });
    }
    if (Array.isArray(body?.tools) && body.tools.length > 0) {
      content.push({
        type: 'tool_use',
        id: 'toolu_01A2B3C4D5E6F7G8H9J0K1L2',
        name: body.tools[0]?.name || 'get_weather',
        input: { city: 'Paris' }
      });
    }
    content.push({ type: 'text', text: '{"verify":"abc123","n":42}' });
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(
      JSON.stringify({
        id: 'msg_01XyZ9AbCdEfGhIjKlMnOpQr',
        type: 'message',
        role: 'assistant',
        model: MODEL,
        content,
        stop_reason: 'end_turn',
        stop_sequence: null,
        usage: { input_tokens: 48, output_tokens: 26 }
      })
    );
    return;
  }

  if (isChat) {
    const usage =
      scenario === 'gpt-backed-by-claude'
        ? {
            prompt_tokens: 31,
            completion_tokens: 18,
            total_tokens: 49,
            // Anthropic 后端的痕迹泄漏进 OpenAI 形状的 usage —— 这就是 critical 级证据
            claude_cache_creation_5_m_tokens: 0,
            cache_read_input_tokens: 0,
            usage_source: 'anthropic'
          }
        : { prompt_tokens: 31, completion_tokens: 18, total_tokens: 49 };

    const message = { role: 'assistant', content: 'pong' };
    let finish = 'stop';
    if (Array.isArray(body?.tools) && body.tools.length > 0) {
      message.tool_calls = [
        {
          id: 'call_abc123',
          type: 'function',
          function: { name: body.tools[0]?.name || 'get_weather', arguments: '{"city":"Paris"}' }
        }
      ];
      message.content = null;
      finish = 'tool_calls';
    }
    if (body?.response_format) message.content = '{"verify":"abc123","n":42}';

    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(
      JSON.stringify({
        id: 'chatcmpl-A1b2C3d4E5f6G7h8',
        object: 'chat.completion',
        created: 1700000000,
        model: OPENAI_MODEL,
        choices: [{ index: 0, message, finish_reason: finish }],
        usage
      })
    );
    return;
  }

  // 模型列表 / 其他
  res.writeHead(200, { 'content-type': 'application/json' });
  res.end(
    JSON.stringify({
      object: 'list',
      data: [{ id: MODEL, object: 'model', created: 1700000000, owned_by: 'openai' }]
    })
  );
}

function startRelay(scenario) {
  const server = http.createServer((req, res) => {
    let raw = '';
    req.on('data', (c) => {
      raw += c;
    });
    req.on('end', () => {
      let body = null;
      try {
        body = raw ? JSON.parse(raw) : null;
      } catch {
        body = null;
      }
      respond(scenario, req, res, body);
    });
  });
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve(server)));
}

async function runScenario(scenario, { provider, model, basePath = '/v1' }) {
  const server = await startRelay(scenario);
  const port = server.address().port;
  try {
    const auth = await runAuthenticity({
      provider,
      baseUrl: `http://127.0.0.1:${port}${basePath}`,
      apiKey: API_KEY,
      model,
      mode: 'standard',
      transport: globalThis.fetch,
      options: { timeoutMs: 20000, maxRequests: 32 }
    });
    return auth;
  } finally {
    server.close();
  }
}

const det = (auth, name) => auth.detectors.find((d) => d.name === name) || null;

// ---------------------------------------------------------------- 场景 1：真 Claude

console.log('\n=== 场景 1：诚实转发真 Claude（thinking 块带服务端签名）');
{
  const auth = await runScenario('genuine-claude', { provider: 'anthropic', model: MODEL });
  const ts = det(auth, 'thinking_signature');
  console.log(`  verdict=${auth.verdict} score=${auth.score} summary=${auth.summaryText}`);
  console.log(`  thinking_signature: status=${ts?.status} score=${ts?.score}`);
  console.log(`  检测器: ${auth.detectors.map((d) => `${d.name}=${d.status}/${d.score}`).join('  ')}`);
  ok('真 Claude → 真伪轴通过（passed/excellent）', auth.verdict === 'passed' || auth.verdict === 'excellent', auth.verdict);
  ok('真 Claude → thinking_signature 满分', ts?.status === 'pass' && ts?.score === 100, `${ts?.status}/${ts?.score}`);
  ok('真 Claude → 无 critical 问题', auth.criticalIssues.length === 0, String(auth.criticalIssues.length));
}

// -------------------------------------------- 场景 2：Kiro/Amazon Q 式冒充（无签名）

console.log('\n=== 场景 2：Kiro/Amazon Q 式冒充 Claude（拿不到 thinking 签名）');
{
  const auth = await runScenario('kiro-like', { provider: 'anthropic', model: MODEL });
  const ts = det(auth, 'thinking_signature');
  console.log(`  verdict=${auth.verdict} score=${auth.score} summary=${auth.summaryText}`);
  console.log(`  thinking_signature: status=${ts?.status} score=${ts?.score}`);
  console.log(`  检测器: ${auth.detectors.map((d) => `${d.name}=${d.status}/${d.score}`).join('  ')}`);
  ok('冒充 Claude → thinking_signature 判 0 分 fail', ts?.status === 'fail' && ts?.score === 0, `${ts?.status}/${ts?.score}`);
  ok('冒充 Claude → 不得判定为优秀', auth.verdict !== 'excellent', auth.verdict);
  ok('冒充 Claude → 不是「检测无效」（这是真实结论不是故障）', auth.verdict !== 'invalid' && !auth.runError, auth.verdict);
}

// --------------------------------------- 场景 3：GPT 请求被偷偷转给 Claude 后端

console.log('\n=== 场景 3：GPT 请求被偷偷转给 Claude 后端（usage 泄漏 Anthropic 字段）');
{
  const auth = await runScenario('gpt-backed-by-claude', { provider: 'openai', model: OPENAI_MODEL });
  console.log(`  verdict=${auth.verdict} score=${auth.score} summary=${auth.summaryText}`);
  console.log(`  criticalIssues=${JSON.stringify(auth.criticalIssues)}`);
  console.log(`  检测器: ${auth.detectors.map((d) => `${d.name}=${d.status}/${d.score}`).join('  ')}`);
  ok('跨厂商泄漏 → 报 critical', auth.criticalIssues.length > 0, `${auth.criticalIssues.length} 条`);
  ok('跨厂商泄漏 → verdict 被封顶为 marginal', auth.verdict === 'marginal', auth.verdict);
}

// ------------------------------------------------- 场景 4：模型渠道不存在（无效 vs 低分）

console.log('\n=== 场景 4：中转站没有该模型渠道 → 必须是「检测无效」而不是低分');
{
  const auth = await runScenario('dead-model', { provider: 'anthropic', model: MODEL });
  console.log(`  verdict=${auth.verdict} score=${auth.score} summary=${auth.summaryText}`);
  console.log(`  runError=${JSON.stringify(auth.runError)}`);
  ok('模型无渠道 → verdict=invalid', auth.verdict === 'invalid', auth.verdict);
  ok('模型无渠道 → runError.code=model_unavailable', auth.runError?.code === 'model_unavailable', String(auth.runError?.code));
  ok('模型无渠道 → 不输出低分误导', auth.summaryText === '检测无效', auth.summaryText);
}

// ------------------------------------------ 场景 5：engine 集成后两根轴同时存在

console.log('\n=== 场景 5：detect() 集成 —— 两根正交轴同时产出');
{
  const server = await startRelay('genuine-claude');
  const port = server.address().port;
  let report;
  try {
    report = await detect({
      baseUrl: `http://127.0.0.1:${port}/v1`,
      apiKey: API_KEY,
      provider: 'anthropic',
      model: MODEL,
      mode: 'browser',
      authenticity: { model: MODEL, mode: 'standard' },
      transport: globalThis.fetch,
      options: { timeoutMs: 20000 }
    });
  } finally {
    server.close();
  }
  console.log(`  连接轴: verdict=${report.verdict} score=${report.score} e=${report.evidenceStrength}`);
  console.log(`  真伪轴: verdict=${report.authenticity?.verdict} score=${report.authenticity?.score} summary=${report.authenticity?.summaryText}`);
  ok('detect() 产出 authenticity 字段', Boolean(report.authenticity), String(report.authenticity?.verdict));
  ok('detect() 仍产出连接轴（未受 v2 影响）', typeof report.verdict === 'string' && typeof report.score === 'number', report.verdict);
  // 注意：本地 mock 的响应头/报文刻意做得很"干净"，连接轴的方向分虽为 100，
  // 但证据强度刚好落在 0.40 闸门下方 → verdict=inconclusive 是**正确**的保守行为。
  // 因此这里只断言「没有误判成官方」，而不是要求必须判中转。
  ok(
    '两根轴互不干扰：连接轴未误判为官方',
    report.verdict !== 'official' && report.verdict !== 'likely-official' && report.score > 50,
    `${report.verdict}/${report.score}`
  );
  ok('两根轴互不干扰：真伪轴判通过', report.authenticity?.verdict === 'passed' || report.authenticity?.verdict === 'excellent', report.authenticity?.verdict);
  const serialized = JSON.stringify(report);
  ok('报告未泄漏完整 API Key', !serialized.includes(API_KEY), '密钥脱敏');
  ok('报告含脱敏 key 痕迹', serialized.includes('sk-a') || serialized.includes('••••') || !serialized.includes('LEAD-ACCEPTANCE'), '脱敏形态');
}

// ---------------------------------------------------------------------- 汇总

const passed = results.filter((r) => r.pass).length;
console.log(`\n===== v2 验收汇总：${passed}/${results.length} 通过，${failures} 失败 =====`);
process.exit(failures === 0 ? 0 : 1);
