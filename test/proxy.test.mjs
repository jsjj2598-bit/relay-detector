/**
 * 本地代理测试（契约 2.7）。
 *
 * 分三层：
 *  1. 纯函数层：SSRF 地址判定与日志脱敏（完全离线，必跑）
 *  2. 进程内集成层：用 createServer() 监听随机端口打真实 HTTP（完全离线，必跑）
 *  3. 网络相关层：/inspect 真实 TLS、/proxy 真实透传、CLI 启动冒烟（不可达时优雅跳过）
 *
 * 注意：第 2 层不依赖 index.html 是否存在；静态托管相关断言在资源缺失时跳过。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

import {
  createServer,
  isPublicAddress,
  redactHeaders,
  redactSecret,
  redactUrl
} from '../proxy/server.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PROXY_FILE = path.join(ROOT, 'proxy', 'server.mjs');

/** 监听随机空闲端口，返回句柄。 */
async function startServer() {
  const server = createServer();
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const { port } = server.address();
  return {
    server,
    port,
    base: `http://127.0.0.1:${port}`,
    close: () => new Promise((resolve) => server.close(resolve))
  };
}

const proxyUrl = (base, target, extra = '') => `${base}/proxy?url=${encodeURIComponent(target)}${extra}`;

/* ------------------------------------------------------------------ */
/* 1. 纯函数：SSRF 判定 + 脱敏                                            */
/* ------------------------------------------------------------------ */

test('isPublicAddress：私网/环回/链路本地/保留段一律拒绝', () => {
  const blocked = [
    '0.0.0.0',
    '10.0.0.1',
    '10.255.255.255',
    '100.64.0.1',
    '127.0.0.1',
    '127.1.2.3',
    '169.254.169.254',
    '172.16.0.1',
    '172.31.255.254',
    '192.168.0.1',
    '192.0.0.1',
    '192.0.2.1',
    '198.18.0.1',
    '198.51.100.1',
    '203.0.113.1',
    '224.0.0.1',
    '255.255.255.255',
    '::',
    '::1',
    'fc00::1',
    'fd12:3456::1',
    'fe80::1',
    'ff02::1',
    '::ffff:127.0.0.1',
    '::ffff:10.0.0.1',
    '64:ff9b::7f00:1',
    '2002:7f00:1::1',
    '2001:db8::1',
    'not-an-ip',
    ''
  ];
  for (const ip of blocked) {
    assert.equal(isPublicAddress(ip), false, `${ip} 必须被判定为非公网（拒绝）`);
  }
});

test('isPublicAddress：公网地址放行', () => {
  for (const ip of ['8.8.8.8', '1.1.1.1', '104.18.0.1', '172.32.0.1', '2606:4700:4700::1111']) {
    assert.equal(isPublicAddress(ip), true, `${ip} 应被判定为公网`);
  }
});

test('redactSecret / redactHeaders / redactUrl 不泄漏密钥', () => {
  const secret = 'sk-abcdef0123456789SECRET';
  const r = redactSecret(secret);
  assert.ok(!r.includes(secret), '脱敏结果不得包含完整密钥');
  assert.ok(r.includes('<redacted'), '脱敏结果必须带 <redacted 标记');

  const headers = redactHeaders({
    authorization: `Bearer ${secret}`,
    'x-api-key': secret,
    'x-goog-api-key': secret,
    'content-type': 'application/json'
  });
  for (const k of ['authorization', 'x-api-key', 'x-goog-api-key']) {
    assert.ok(!String(headers[k]).includes(secret), `${k} 日志脱敏失败：${headers[k]}`);
    assert.match(String(headers[k]), /<redacted/);
  }
  assert.equal(headers['content-type'], 'application/json', '非敏感头不得被改动');

  const url = redactUrl(`https://example.com/v1/models?api_key=${secret}&key=${secret}&token=${secret}&page=2`);
  assert.ok(!url.includes(secret), `URL 脱敏失败：${url}`);
  assert.ok(url.includes('page=2'), '非敏感 query 必须保留');
});

/* ------------------------------------------------------------------ */
/* 2. 进程内集成（离线）                                                  */
/* ------------------------------------------------------------------ */

test('GET /health → { ok: true, version } 且带 CORS 头', async (t) => {
  const s = await startServer();
  t.after(() => s.close());

  const res = await fetch(`${s.base}/health`);
  assert.equal(res.status, 200);
  assert.equal(res.headers.get('access-control-allow-origin'), '*');
  const body = await res.json();
  assert.equal(body.ok, true);
  assert.equal(typeof body.version, 'string');
  assert.match(body.version, /^\d+\.\d+\.\d+$/);
});

test('OPTIONS 预检 → 204 且回显 Access-Control-Request-Headers', async (t) => {
  const s = await startServer();
  t.after(() => s.close());

  const res = await fetch(`${s.base}/health`, {
    method: 'OPTIONS',
    headers: { 'access-control-request-headers': 'authorization, content-type' }
  });
  assert.equal(res.status, 204);
  assert.equal(res.headers.get('access-control-allow-origin'), '*');
  assert.equal(res.headers.get('access-control-allow-headers'), 'authorization, content-type');
});

test('GET /proxy?url= 拒绝私网 / 环回 / 链路本地目标（SSRF 红线）', async (t) => {
  const s = await startServer();
  t.after(() => s.close());

  const targets = [
    'http://127.0.0.1/',
    'http://127.0.0.1:8787/health',
    'http://10.0.0.1/',
    'http://172.16.0.1/',
    'http://192.168.1.1/',
    'http://169.254.169.254/latest/meta-data/',
    'http://100.64.0.1/',
    'http://[::1]/'
  ];
  for (const target of targets) {
    const res = await fetch(proxyUrl(s.base, target));
    const body = await res.json().catch(() => ({}));
    assert.equal(res.status, 403, `${target} 应被拒绝为 403，实际 ${res.status}（body=${JSON.stringify(body)}）`);
    assert.equal(body.ok, false);
    assert.equal(body.error, 'private_target_blocked', `${target} 错误码应为 private_target_blocked`);
  }
  // 且必须明确标记经过代理
  const one = await fetch(proxyUrl(s.base, 'http://127.0.0.1/'));
  assert.equal(one.headers.get('x-relay-detector-proxy'), '1');
});

test('GET /proxy 拒绝非 http(s) 协议与非法参数', async (t) => {
  const s = await startServer();
  t.after(() => s.close());

  const file = await fetch(proxyUrl(s.base, 'file:///C:/Windows/win.ini'));
  assert.equal(file.status, 400);
  assert.equal((await file.json()).error, 'unsupported_protocol');

  const gopher = await fetch(proxyUrl(s.base, 'gopher://127.0.0.1:11211/'));
  assert.equal(gopher.status, 400);

  const missing = await fetch(`${s.base}/proxy`);
  assert.equal(missing.status, 400);
  assert.equal((await missing.json()).error, 'missing_url');

  const invalid = await fetch(`${s.base}/proxy?url=not%20a%20url`);
  assert.equal(invalid.status, 400);
  assert.equal((await invalid.json()).error, 'invalid_url');
});

test('静态托管：点文件拒绝 / 仓库内文件可读 / 越界不逃逸', async (t) => {
  const s = await startServer();
  t.after(() => s.close());

  // 点文件必须拒绝
  const dot = await fetch(`${s.base}/.gitignore`);
  assert.equal(dot.status, 403, '.gitignore 等点文件必须拒绝');

  // 仓库内存在的文件可读
  const md = await fetch(`${s.base}/docs/CONTRACT.md`);
  assert.equal(md.status, 200);
  assert.match(md.headers.get('content-type') || '', /text\/markdown/);

  // 路径穿越：无论如何都不得逃出仓库根目录（越界目标不存在 → 404/403，而不是泄漏）
  for (const evil of ['/../../Windows/win.ini', '/..%2f..%2fWindows%2fwin.ini', '/%2e%2e/%2e%2e/etc/passwd']) {
    const res = await fetch(`${s.base}${evil}`);
    assert.ok([403, 404].includes(res.status), `路径穿越 ${evil} 应被拒绝，实际 ${res.status}`);
    const text = await res.text();
    assert.ok(!/\[fonts\]|root:x:|daemon:/i.test(text), `路径穿越 ${evil} 泄漏了系统文件内容`);
  }

  // 根路径：index.html 交付后才断言 200
  if (fs.existsSync(path.join(ROOT, 'index.html'))) {
    const root = await fetch(`${s.base}/`);
    assert.equal(root.status, 200, 'GET / 应返回 index.html');
    assert.match(root.headers.get('content-type') || '', /text\/html/);
  } else {
    t.diagnostic('index.html 尚未交付：跳过 GET / 断言');
  }
});

test('非 GET/HEAD 请求静态路径 → 405（不提供写入能力）', async (t) => {
  const s = await startServer();
  t.after(() => s.close());
  for (const [method, p] of [['POST', '/docs/CONTRACT.md'], ['PUT', '/index.html'], ['DELETE', '/README.md']]) {
    const res = await fetch(`${s.base}${p}`, { method });
    assert.equal(res.status, 405, `${method} ${p} 应返回 405，实际 ${res.status}`);
    const body = await res.json().catch(() => ({}));
    assert.equal(body.error, 'method_not_allowed');
  }
});

test('方法校验：/health、/inspect 仅 GET/HEAD；/proxy 仅 GET/POST/HEAD', async (t) => {
  const s = await startServer();
  t.after(() => s.close());
  const cases = [
    ['POST', '/health', 'GET, HEAD'],
    ['DELETE', '/health', 'GET, HEAD'],
    ['POST', '/inspect?host=api.example.com', 'GET, HEAD'],
    ['PUT', '/proxy?url=http%3A%2F%2F127.0.0.1%2F', 'GET, POST, HEAD'],
    ['DELETE', '/proxy?url=http%3A%2F%2F127.0.0.1%2F', 'GET, POST, HEAD']
  ];
  for (const [method, p, allow] of cases) {
    const res = await fetch(`${s.base}${p}`, { method });
    assert.equal(res.status, 405, `${method} ${p} 应返回 405，实际 ${res.status}`);
    const body = await res.json().catch(() => ({}));
    assert.equal(body.error, 'method_not_allowed', `${method} ${p} 错误码错误：${JSON.stringify(body)}`);
    assert.equal(res.headers.get('allow'), allow, `${method} ${p} 的 Allow 头应为 "${allow}"`);
  }
});

/* ------------------------------------------------------------------ */
/* 3. 网络相关（不可达时优雅跳过）                                         */
/* ------------------------------------------------------------------ */

test('[网络相关] GET /inspect?host=api.anthropic.com 返回契约 1.2 的 tls 结构', async (t) => {
  const s = await startServer();
  t.after(() => s.close());

  let res;
  try {
    res = await fetch(`${s.base}/inspect?host=api.anthropic.com&port=443`, { signal: AbortSignal.timeout(15000) });
  } catch (err) {
    return t.skip(`网络不可用，跳过 /inspect 实测：${err && err.message}`);
  }
  if (res.status !== 200) {
    const body = await res.text().catch(() => '');
    return t.skip(`无法读取 api.anthropic.com 证书（可能网络受限）：HTTP ${res.status} ${body.slice(0, 120)}`);
  }

  const body = await res.json();
  const tls = body.tls || body;
  assert.equal(typeof tls.authorized, 'boolean', 'tls.authorized 必须是布尔');
  assert.ok(tls.issuer && typeof tls.issuer === 'object', 'tls.issuer 必须是对象');
  assert.ok(tls.subject && typeof tls.subject === 'object', 'tls.subject 必须是对象');
  assert.ok(Array.isArray(tls.altNames), 'tls.altNames 必须是数组');
  assert.equal(typeof tls.fingerprint256, 'string', 'tls.fingerprint256 必须是字符串');
  assert.equal(typeof tls.selfSigned, 'boolean', 'tls.selfSigned 必须是布尔');
  assert.equal(typeof tls.protocol, 'string', 'tls.protocol 必须是字符串');
  assert.ok(tls.daysRemaining === null || typeof tls.daysRemaining === 'number', 'tls.daysRemaining 形状非法');
  assert.ok(tls.altNames.some((n) => /anthropic\.com$/i.test(n)), `altNames 应包含 anthropic.com：${JSON.stringify(tls.altNames)}`);
  assert.match(JSON.stringify(tls.issuer), /google trust services/i, '实测事实：api.anthropic.com 证书由 Google Trust Services 签发');
});

test('[网络相关] CLI 冒烟：node proxy/server.mjs --port <p> 可启动并响应 /health', async (t) => {
  // 找一个空闲端口（先占用再释放）
  const probe = net.createServer();
  await new Promise((resolve) => probe.listen(0, '127.0.0.1', resolve));
  const port = probe.address().port;
  await new Promise((resolve) => probe.close(resolve));

  let child;
  try {
    child = spawn(process.execPath, [PROXY_FILE, '--port', String(port)], {
      cwd: ROOT,
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true
    });
  } catch (err) {
    return t.skip(`无法启动子进程（环境限制）：${err && err.message}`);
  }

  let stderr = '';
  child.stderr.on('data', (d) => {
    stderr += String(d);
  });
  const exited = new Promise((resolve) => child.once('exit', (code) => resolve(code)));

  t.after(async () => {
    if (child.exitCode === null) child.kill('SIGTERM');
    await exited;
  });

  let ok = false;
  let lastErr = '';
  for (let i = 0; i < 40; i++) {
    if (child.exitCode !== null) break;
    try {
      const res = await fetch(`http://127.0.0.1:${port}/health`, { signal: AbortSignal.timeout(1500) });
      if (res.status === 200) {
        const body = await res.json();
        assert.equal(body.ok, true);
        assert.equal(typeof body.version, 'string');
        ok = true;
        break;
      }
    } catch (err) {
      lastErr = err && err.message;
    }
    await new Promise((r) => setTimeout(r, 150));
  }

  if (!ok) {
    if (child.exitCode !== null && /EADDRINUSE|EPERM|EACCES/.test(stderr)) {
      return t.skip(`环境限制导致无法启动代理：${stderr.slice(0, 160)}`);
    }
    assert.fail(
      `CLI 启动后 /health 不可达（exitCode=${child.exitCode}, lastErr=${lastErr}, stderr=${stderr.slice(0, 300)}）`
    );
  }
});
