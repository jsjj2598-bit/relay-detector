#!/usr/bin/env node
/**
 * 本地验证 CLI（Lead 所有）。
 *
 * 三种用法，从「零依赖自证」到「验你自己的中转站」：
 *
 *   1) 内置假中转站自证（不需要任何 API Key、不联网）：
 *        node tools/check.mjs --demo genuine   # 诚实转发真 Claude
 *        node tools/check.mjs --demo kiro      # 拿不到 thinking 签名（冒充）
 *        node tools/check.mjs --demo leak      # GPT 请求被转给 Claude（跨厂商泄漏）
 *        node tools/check.mjs --demo dead      # 模型渠道不存在（检测无效）
 *
 *   2) 验你自己的中转站（需要你的 Key，会产生真实 token 费用）：
 *        node tools/check.mjs --base-url https://api.example.com/v1 \
 *          --api-key sk-xxx --model claude-sonnet-4-5 --depth full
 *
 *   3) 走本地代理（能读 TLS 证书与完整响应头）：
 *        node proxy/server.mjs                     # 另开一个终端
 *        node tools/check.mjs --base-url https://api.example.com/v1 \
 *          --api-key sk-xxx --model gpt-4o --depth full --proxy
 *
 * 加上 --json 打印完整报告 JSON。
 */

import http from 'node:http';
import { detect, createProxyTransport, DEFAULT_PROXY_URL } from '../src/core/engine.js';
import { estimateCost, AUTH_MODES } from '../src/core/auth/index.js';

// ------------------------------------------------------------------ 参数解析

function parseArgs(argv) {
  const args = { depth: 'auto', proxy: false, json: false };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    const next = () => argv[++i];
    switch (a) {
      case '--base-url': args.baseUrl = next(); break;
      case '--api-key': args.apiKey = next(); break;
      case '--model': args.model = next(); break;
      case '--provider': args.provider = next(); break;
      case '--depth': args.depth = next(); break;
      case '--demo': args.demo = next() || 'genuine'; break;
      case '--proxy': args.proxy = true; break;
      case '--proxy-url': args.proxyUrl = next(); break;
      case '--json': args.json = true; break;
      case '-h':
      case '--help': args.help = true; break;
      default:
        if (a.startsWith('--')) console.error(`未知参数：${a}`);
    }
  }
  return args;
}

const USAGE = `
用法：
  node tools/check.mjs --demo <genuine|kiro|leak|dead>     # 零依赖自证（推荐先跑这个）
  node tools/check.mjs --base-url <URL> --api-key <KEY> --model <MODEL> [--depth fingerprint|authenticity|full]
                       [--provider openai|anthropic|gemini] [--proxy] [--json]
`;

// ------------------------------------------------------- 内置假中转站（--demo）

const LONG_SIGNATURE =
  'EqQBCkgIBRABGAIiQJm3rXv2sT7pQ1yKdLw9nVc0fRz8aHbMtYoJpE4uWsQxNdCgVeB7kLm2nPo5rTa1zXc6vHjF8sQwErTyUiOp' +
  'AsDfGhJkLzXcVbNm1234567890abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ';

/** 结构化输出检测器期望的精确字面量（见 src/core/auth/detectors/structured-output.js）。 */
const EXPECTED_JSON_TEXT = '{"answer":42,"tag":"ok"}';

/** 从请求体里拼出用户提示文本，用于按真实比例估算 usage。 */
function requestText(body) {
  const parts = [];
  if (Array.isArray(body?.messages)) {
    for (const m of body.messages) {
      if (typeof m?.content === 'string') parts.push(m.content);
      else if (Array.isArray(m?.content)) {
        for (const c of m.content) if (typeof c?.text === 'string') parts.push(c.text);
      }
    }
  }
  if (typeof body?.input === 'string') parts.push(body.input);
  return parts.join('\n');
}

/** 中文/英文混合文本的粗估 token 数（约 3.5 字符/token），保证 demo 里 usage 自洽。 */
const estTokens = (text) => Math.max(1, Math.round(String(text || '').length / 3.5));

function demoReply(scenario, req, res, body) {
  const url = String(req.url || '');
  const isClaude = url.includes('/messages');

  if (scenario === 'dead' && body?.model) {
    res.writeHead(404, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ error: { message: `The model \`${body.model}\` does not exist`, type: 'invalid_request_error', code: 'model_not_found' } }));
    return;
  }

  const promptText = requestText(body);
  const wantsStructured = /"answer"\s*:/.test(promptText) || Boolean(body?.response_format);
  const hasTools = Array.isArray(body?.tools) && body.tools.length > 0;

  // 让 token 用量与真实文本长度自洽，否则 token_usage 的字符/token 比会误判。
  const promptTokens = estTokens(promptText);

  if (isClaude) {
    const content = [];
    if (body?.thinking && scenario !== 'kiro') {
      content.push({ type: 'thinking', thinking: '用欧几里得算法逐步求 gcd。', signature: LONG_SIGNATURE });
    }
    let text = wantsStructured ? EXPECTED_JSON_TEXT : '最大公约数是 1。';
    if (hasTools) {
      content.push({ type: 'tool_use', id: 'toolu_01A2B3C4D5E6F7G8H9J0', name: body.tools[0].name || 'get_weather', input: { city: 'Paris' } });
    }
    content.push({ type: 'text', text });
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({
      id: 'msg_01XyZ9AbCdEfGhIjKlMnOpQr', type: 'message', role: 'assistant', model: 'claude-sonnet-4-5',
      content, stop_reason: 'end_turn', stop_sequence: null,
      usage: { input_tokens: promptTokens, output_tokens: estTokens(text) }
    }));
    return;
  }

  let text = wantsStructured ? EXPECTED_JSON_TEXT : 'HTTP 418 是 "I\'m a teapot"，源自 1998 年愚人节 RFC。';
  const message = { role: 'assistant', content: text };
  let finish = 'stop';
  if (hasTools) {
    message.content = null;
    message.tool_calls = [{ id: 'call_abc', type: 'function', function: { name: body.tools[0].name || 'get_weather', arguments: '{"city":"Paris"}' } }];
    finish = 'tool_calls';
  }
  const completionTokens = estTokens(text);
  const usage = {
    prompt_tokens: promptTokens,
    completion_tokens: completionTokens,
    total_tokens: promptTokens + completionTokens
  };
  if (scenario === 'leak') {
    // Anthropic 后端的痕迹泄漏进 OpenAI 形状的 usage —— 这是 critical 级证据
    usage.claude_cache_creation_5_m_tokens = 0;
    usage.usage_source = 'anthropic';
  }
  res.writeHead(200, { 'content-type': 'application/json' });
  res.end(JSON.stringify({
    id: 'chatcmpl-A1b2C3d4E5f6G7h8', object: 'chat.completion', created: 1700000000, model: 'gpt-4o',
    choices: [{ index: 0, message, finish_reason: finish }], usage
  }));
}

function startDemoRelay(scenario) {
  const server = http.createServer((req, res) => {
    let raw = '';
    req.on('data', (c) => { raw += c; });
    req.on('end', () => {
      let body = null;
      try { body = raw ? JSON.parse(raw) : null; } catch { body = null; }
      demoReply(scenario, req, res, body);
    });
  });
  return new Promise((r) => server.listen(0, '127.0.0.1', () => r(server)));
}

// ------------------------------------------------------------------ 输出格式

const bar = (v, width = 20) => {
  const filled = Math.round((Math.max(0, Math.min(100, v)) / 100) * width);
  return '█'.repeat(filled) + '░'.repeat(width - filled);
};
const STATUS_ICON = { pass: '✔', fail: '✖', skip: '◌', error: '!' };

function printReport(report) {
  const target = report.target;
  console.log('\n' + '─'.repeat(72));
  console.log(`目标  ${target.baseUrl}`);
  console.log(`协议  ${target.provider}   模式  ${report.mode}`);
  console.log('─'.repeat(72));

  // 轴 1：连接方式
  const verdictZh = {
    relay: '高度确信是中转站',
    'likely-relay': '疑似中转站',
    inconclusive: '证据不足 / 无法判定',
    'likely-official': '疑似官方直连',
    official: '官方直连特征明显'
  }[report.verdict] || report.verdict;
  console.log(`\n【轴 1 · 连接方式】${verdictZh}`);
  console.log(`  中转倾向 ${String(report.score).padStart(3)}/100  ${bar(report.score)}`);
  console.log(`  证据强度 ${(report.evidenceStrength * 100).toFixed(1).padStart(5)}%  ${bar(report.evidenceStrength * 100)}`);
  const top = report.signals.slice(0, 5);
  if (top.length === 0) console.log('  （无方向性信号）');
  for (const s of top) {
    console.log(`  · [${s.verdict}] ${s.id}  w=${s.weight} c=${s.confidence}  ${s.title}`);
  }

  // 轴 2：上游真伪
  const auth = report.authenticity;
  if (!auth) {
    console.log('\n【轴 2 · 上游真伪】未检测（本次深度不含真伪检测）');
  } else {
    console.log(`\n【轴 2 · 上游真伪】${auth.summaryText}  (${auth.verdict})`);
    console.log(`  真伪评分 ${String(auth.score).padStart(3)}/100  ${bar(auth.score)}`);
    if (auth.runError) {
      console.log(`  ⚠ 检测无效：${auth.runError.code} — ${String(auth.runError.message).slice(0, 120)}`);
    }
    if (auth.criticalIssues?.length) {
      console.log(`  ⚠ 严重问题 ${auth.criticalIssues.length} 条：`);
      for (const c of auth.criticalIssues.slice(0, 3)) {
        console.log(`     - [${c.code}] ${c.message}`);
      }
    }
    if (auth.detectors?.length) {
      console.log('  检测器：');
      for (const d of auth.detectors) {
        const icon = STATUS_ICON[d.status] || '?';
        const reason = d.status === 'skip' || d.status === 'error'
          ? `  (${d.details?.reason || d.details?.message || d.error || '未说明'})`
          : '';
        console.log(`    ${icon} ${String(d.name).padEnd(20)} ${String(d.status).padEnd(6)} ${String(d.score).padStart(3)}  w=${d.weight}${reason}`);
      }
    }
    const note = auth.cost?.note ? String(auth.cost.note) : '';
    const shortNote = note.length > 70 ? `${note.slice(0, 70)}…` : note;
    console.log(`  请求数 ${auth.cost?.requests ?? 0}${shortNote ? `  （${shortNote}）` : ''}`);
    for (const w of auth.warnings || []) console.log(`  ! ${w}`);
  }

  // 组合解读
  console.log('\n【组合解读】' + comboText(report));
  if (report.notes?.length) {
    console.log('\n【说明】');
    for (const n of report.notes.slice(0, 8)) console.log(`  · ${n}`);
  }
  console.log('─'.repeat(72));
}

function comboText(report) {
  const conn = report.verdict;
  const auth = report.authenticity;
  if (!auth) {
    return '本次只做了连接方式检测，真伪结果未检测。';
  }
  if (auth.verdict === 'invalid') return '真伪检测无效（换 Key 或换模型后重试），连接轴结论单独参考。';
  const relayLike = conn === 'relay' || conn === 'likely-relay';
  if (conn === 'official' || conn === 'likely-official') return '官方直连，无需真伪检测。';
  if (relayLike) {
    if (auth.verdict === 'excellent' || auth.verdict === 'passed') return '中转站，但上游是真模型 → 可用。';
    if (auth.verdict === 'marginal') return '中转站，存在可疑迹象 → 谨慎使用。';
    return '中转站，且上游疑似被掉包 → 建议更换。';
  }
  return '连接方式无法判定，真伪结果单独参考。';
}

// ------------------------------------------------------------------------ 主流程

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    console.log(USAGE);
    return 0;
  }

  // 模式 A：内置假中转站自证（零依赖、不联网、不需要 Key）
  if (args.demo) {
    const scenario = args.demo;
    const provider = scenario === 'leak' ? 'openai' : 'anthropic';
    const model = scenario === 'leak' ? 'gpt-4o' : 'claude-sonnet-4-5';
    const server = await startDemoRelay(scenario);
    const port = server.address().port;
    console.log(`\n[自证模式] 场景 = ${scenario}，内置假中转站 http://127.0.0.1:${port}/v1（不联网、不需要真实 Key）`);
    try {
      const cost = estimateCost({ provider, model, mode: 'standard' });
      console.log(`[费用预估] ${cost.requests} 个请求 / 约 ${cost.promptTokens} 输入 + ${cost.completionTokens} 输出 token（由内置假站消费，免费）`);
      const report = await detect({
        baseUrl: `http://127.0.0.1:${port}/v1`,
        apiKey: 'sk-demo-not-a-real-key',
        provider,
        model,
        authenticity: { model, mode: 'standard' },
        transport: globalThis.fetch,
        options: { timeoutMs: 20000 }
      });
      printReport(report);
      if (args.json) console.log(JSON.stringify(report, null, 2));
    } finally {
      await new Promise((resolve) => server.close(resolve));
    }
    return 0;
  }

  // 模式 B/C：验真实端点
  if (!args.baseUrl) {
    console.error('缺少 --base-url（或用 --demo 做零依赖自证）。\n' + USAGE);
    return 2;
  }

  const depth = args.depth === 'auto'
    ? (args.apiKey ? 'full' : 'fingerprint')
    : args.depth;
  if (!['fingerprint', 'authenticity', 'full'].includes(depth)) {
    console.error(`--depth 只能是 fingerprint / authenticity / full，收到 ${depth}`);
    return 2;
  }
  const authMode = depth === 'authenticity' ? 'standard' : depth === 'full' ? 'full' : null;
  if (authMode && !args.apiKey) {
    console.error(`--depth ${depth} 需要 --api-key（真伪检测要发真实请求）。`);
    return 2;
  }
  if (authMode && !args.model) {
    console.error(`--depth ${depth} 需要 --model（真伪判定必须绑定具体模型，例如 claude-sonnet-4-5 / gpt-4o）。`);
    return 2;
  }

  const transport = args.proxy ? createProxyTransport(args.proxyUrl || DEFAULT_PROXY_URL) : globalThis.fetch;

  if (authMode) {
    const provider = args.provider || 'openai';
    const cost = estimateCost({ provider, model: args.model, mode: authMode });
    console.log(`\n[费用预估] ${cost.requests} 个请求 / 约 ${cost.promptTokens} 输入 + ${cost.completionTokens} 输出 token。`);
    console.log('[注意] 以下请求会由你的 API Key 真实付费，按 Ctrl+C 可中止。');
  }

  const report = await detect({
    baseUrl: args.baseUrl,
    apiKey: args.apiKey || undefined,
    provider: args.provider || 'auto',
    model: args.model || undefined,
    mode: args.proxy ? 'proxy' : 'browser',
    transport,
    authenticity: authMode ? { model: args.model, mode: authMode } : false,
    options: { timeoutMs: 120000, proxyUrl: args.proxyUrl || DEFAULT_PROXY_URL }
  });

  printReport(report);
  if (args.json) console.log(JSON.stringify(report, null, 2));
  return 0;
}

// ⚠️ 不要用 process.exit()：在 Windows + Node 24 上，「大量 console.log 之后立刻 process.exit()」
// 会以 0xC0000409（STATUS_STACK_BUFFER_OVERRUN）崩溃，退出码变成 -1073740791。
// 正确做法是设置 process.exitCode，让事件循环自然退出。
main()
  .then((code) => {
    process.exitCode = code;
  })
  .catch((err) => {
    console.error('执行失败：', err?.stack || err);
    process.exitCode = 1;
  });
