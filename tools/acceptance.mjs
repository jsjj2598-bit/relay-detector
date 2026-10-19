/**
 * Lead 端到端验收脚本（Lead 所有）。
 *
 * 与 test/** 的区别：test 的 unit/contract 断言由 verifier 写；本脚本是 Lead 的
 * **独立验收**，重点是「真实 HTTP 上的整链路行为」，而不是 mock transport。
 *
 * 用法：
 *   node tools/acceptance.mjs            # 离线 fixture 扫描 + 本地真实 HTTP 假中转站
 *   node tools/acceptance.mjs --live     # 额外联网复核 api.anthropic.com（本机可达）
 *
 * 退出码：0 = 全部验收项通过；1 = 有验收项失败。
 */

import http from 'node:http';
import { detect } from '../src/core/engine.js';
import { FIXTURE_IDS, loadFixture, createFakeTransport } from '../test/fixtures/index.mjs';

const LIVE = process.argv.includes('--live');
let failures = 0;
const results = [];

const ok = (name, pass, detail) => {
  results.push({ name, pass, detail });
  if (!pass) failures += 1;
  console.log(`${pass ? 'PASS' : 'FAIL'}  ${name}${detail ? `  — ${detail}` : ''}`);
};

const brief = (r) => `verdict=${r.verdict} score=${r.score} e=${r.evidenceStrength} signals=${r.signals.length}`;

// ---------------------------------------------------------------- 1. 离线 fixture 扫描

console.log('\n=== 1) 离线 fixture 扫描（不联网，验证方向性判定）');
for (const id of FIXTURE_IDS) {
  const fixture = loadFixture(id);
  const report = await detect({
    baseUrl: fixture.baseUrl || 'https://api.example.com/v1',
    apiKey: fixture.apiKey || 'sk-test-not-a-real-key',
    provider: fixture.provider || 'auto',
    mode: 'browser',
    transport: createFakeTransport(fixture),
    options: { allowPaidProbes: false, timeoutMs: 3000 }
  });
  console.log(`  ${id.padEnd(28)} ${brief(report)}`);
  console.log(`      信号: ${report.signals.map((s) => `${s.id}(${s.verdict})`).join(', ') || '（无）'}`);

  if (id === 'static-placeholder') {
    // 最高风险假阳性：一个静态占位页绝不能被判为中转站
    ok('静态占位页不得判为中转站', report.verdict !== 'relay' && report.verdict !== 'likely-relay', brief(report));
  }
  if (id === 'cloudflare-403' || id === 'anthropic-official-cf-403') {
    // 关键回归：Cloudflare 边缘防护拦截必须 inconclusive
    ok(`${id} 边缘防护 → inconclusive`, report.verdict === 'inconclusive', brief(report));
  }
  if (id === 'oneapi-401') {
    ok('one-api 风格错误体 → 中转方向', report.score >= 58, brief(report));
  }
  if (id === 'aggregated-models') {
    ok('聚合模型列表 → 中转方向', report.score >= 58, brief(report));
  }
  if (id === 'openai-official-401') {
    ok('官方 401 报文（无域名身份）→ 不得判 relay', report.score < 58 && report.verdict !== 'relay', brief(report));
  }
  if (id === 'forwarded-official-headers') {
    // v1.2 漏判路径：反代透传官方头 + 官方错误报文，域名身份未确认
    ok('反代透传官方头 → 不得判 official', report.verdict !== 'official' && report.verdict !== 'likely-official', brief(report));
  }
  if (id === 'network-error') {
    ok('网络不可达 → 不抛异常且不判方向', report.verdict === 'inconclusive', brief(report));
  }
}

// ------------------------------------------------- 2. 本地真实 HTTP 假中转站（整链路）

console.log('\n=== 2) 本地真实 HTTP 假中转站（模拟 one-api/new-api，走真实 socket）');

/** 起一个模拟 one-api 的中转站：所有路径都返回扁平业务包装体。 */
function startFakeRelay() {
  const server = http.createServer((req, res) => {
    const headers = {
      'content-type': 'application/json; charset=utf-8',
      server: 'nginx',
      'x-powered-by': 'Express'
    };
    if (req.url === '/' || req.url === '/index.html') {
      res.writeHead(200, { 'content-type': 'text/html', server: 'nginx' });
      res.end('<html><head><title>Welcome to nginx!</title></head><body><h1>Welcome to nginx!</h1></body></html>');
      return;
    }
    res.writeHead(401, headers);
    res.end(JSON.stringify({ code: 401, message: '无效的令牌', data: null }));
  });
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve(server)));
}

const relay = await startFakeRelay();
const relayPort = relay.address().port;
try {
  const report = await detect({
    baseUrl: `http://127.0.0.1:${relayPort}/v1`,
    apiKey: 'sk-fake-key-for-acceptance',
    provider: 'openai',
    mode: 'browser',
    transport: globalThis.fetch,
    options: { allowPaidProbes: false, timeoutMs: 5000 }
  });
  console.log(`  假中转站 http://127.0.0.1:${relayPort}/v1 → ${brief(report)}`);
  console.log(`  判定文案: ${report.verdict}  评分: ${report.score}/100`);
  console.log(`  信号: ${report.signals.map((s) => `${s.id}(${s.verdict},${s.weight}×${s.confidence})`).join('\n         ') || '（无）'}`);
  ok('真实 HTTP 假中转站 → 被判为中转方向', report.score >= 58, brief(report));
  ok('真实 HTTP 假中转站 → 未出现官方方向证据', report.officialScore >= 0 && !report.signals.some((s) => s.verdict === 'official' && s.category !== 'url'), brief(report));
  ok('报告未泄露 API Key', !JSON.stringify(report).includes('sk-fake-key-for-acceptance'), '密钥脱敏');
  ok('报告形状符合契约 1.4', report.schema === 1 && Array.isArray(report.signals) && Array.isArray(report.probes) && typeof report.mode === 'string');
} finally {
  relay.close();
}

// ------------------------------------------------------- 3. 可选：真实官方端点复核

if (LIVE) {
  console.log('\n=== 3) 联网复核真实端点（--live）');
  for (const [label, baseUrl, provider] of [
    ['api.anthropic.com（官方，本机可达）', 'https://api.anthropic.com', 'anthropic']
  ]) {
    const report = await detect({
      baseUrl,
      apiKey: 'sk-ant-not-a-real-key',
      provider,
      mode: 'browser',
      transport: globalThis.fetch,
      options: { allowPaidProbes: false, timeoutMs: 20000 }
    });
    console.log(`  ${label} → ${brief(report)}`);
    console.log(`  信号: ${report.signals.map((s) => `${s.id}(${s.verdict})`).join(', ') || '（无）'}`);
    ok(`${label} 不得被判为中转站`, report.verdict !== 'relay' && report.verdict !== 'likely-relay', brief(report));
  }
} else {
  console.log('\n=== 3) 联网复核已跳过（加 --live 启用）');
}

// ---------------------------------------------------------------------- 汇总

const passed = results.filter((r) => r.pass).length;
console.log(`\n===== 验收汇总：${passed}/${results.length} 通过，${failures} 失败 =====`);
process.exit(failures === 0 ? 0 : 1);
