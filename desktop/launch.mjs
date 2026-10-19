#!/usr/bin/env node
/**
 * 零依赖桌面启动器（不需要 Electron、不需要 npm install）。
 *
 * 做的是「桌面端」的核心价值：在本机起代理 → 自动打开浏览器 → 页面预置成本地代理模式。
 * 适合给「不想装 Electron、但愿意装 Node」的用户，也适合作为开发时的快速入口。
 *
 * 用法：
 *   node desktop/launch.mjs              # 起代理并打开系统浏览器
 *   node desktop/launch.mjs --no-open    # 只起服务，不打开浏览器
 *   node desktop/launch.mjs --port 8899  # 指定端口（默认自动挑空闲端口）
 */

import { spawn } from 'node:child_process';
import { createServer, CFG } from '../proxy/server.mjs';

const argv = process.argv.slice(2);
const has = (f) => argv.includes(f);
const val = (f) => {
  const i = argv.indexOf(f);
  return i >= 0 ? argv[i + 1] : undefined;
};

const wantedPort = Number(val('--port'));
const noOpen = has('--no-open');

/** 跨平台打开系统默认浏览器。 */
function openBrowser(url) {
  const cmd =
    process.platform === 'win32'
      ? ['cmd', ['/c', 'start', '""', url]]
      : process.platform === 'darwin'
        ? ['open', [url]]
        : ['xdg-open', [url]];
  try {
    const child = spawn(cmd[0], cmd[1], { detached: true, stdio: 'ignore' });
    child.unref();
  } catch (err) {
    console.error(`无法自动打开浏览器，请手动访问：${url}\n(${err?.message || err})`);
  }
}

function start() {
  return new Promise((resolve, reject) => {
    CFG.host = '127.0.0.1';
    CFG.port = Number.isFinite(wantedPort) && wantedPort > 0 ? wantedPort : 0;
    const server = createServer();
    server.once('error', reject);
    server.listen(CFG.port, '127.0.0.1', () => {
      const addr = server.address();
      const port = typeof addr === 'object' && addr ? addr.port : CFG.port;
      resolve({ server, url: `http://127.0.0.1:${port}` });
    });
  });
}

const { server, url } = await start().catch((err) => {
  console.error(`本地代理启动失败：${err?.message || err}`);
  process.exitCode = 1;
  return {};
});

if (server) {
  console.log('');
  console.log('  中转站检测器 · 桌面启动器');
  console.log('  ────────────────────────────────────────────');
  console.log(`  页面地址   ${url}/`);
  console.log(`  健康检查   ${url}/health`);
  console.log(`  TLS 检查   ${url}/inspect?host=api.anthropic.com&port=443`);
  console.log('  ────────────────────────────────────────────');
  console.log('  页面已预置「本地代理」模式：不受 CORS 限制、可读完整响应头与 TLS 证书。');
  console.log('  API Key 只在本机内存与请求头中，不经过任何第三方服务器。');
  console.log('  按 Ctrl+C 退出。');
  console.log('');

  if (!noOpen) openBrowser(`${url}/?mode=proxy&proxyUrl=${encodeURIComponent(url)}&desktop=1`);

  const shutdown = () => {
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(0), 1200).unref();
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}
