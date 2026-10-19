#!/usr/bin/env node
/**
 * relay-detector 本地代理服务器（infra 所有，契约 2.7）
 * =====================================================
 * 用途：浏览器模式受 CORS 限制，既读不到完整响应头，也读不到 TLS 证书。
 *       本代理在**本机**提供三个能力，让页面可以拿到更完整的指纹证据：
 *
 *   GET  /                     静态托管仓库根目录（等价 GitHub Pages，便于本地验证）
 *   GET  /proxy?url=<encoded>  透传 GET（可带 follow=0 关闭重定向跟随）
 *   POST /proxy?url=<encoded>  透传 POST（请求体原样转发）
 *   GET  /inspect?host=<h>&port=443  用 node:tls 读取对端证书 → 契约 1.2 的 meta.tls
 *   GET  /health               { ok: true, version }
 *
 * 安全红线（全部真实实现，见 README「本地代理安全说明」）：
 *   1. 仅允许 http / https；拒绝 file: 等一切其它协议。
 *   2. 默认拒绝私网 / 环回 / 链路本地 / CGNAT / 组播 / NAT64 等非公网目标，
 *      且**先解析 DNS 再把连接固定到已校验的 IP**（防 DNS rebinding），
 *      除非显式传入 --allow-private。对 /proxy 与 /inspect 一视同仁。
 *   3. 手动跟随重定向，**每一跳都重新走一遍协议 + 地址校验**（防 SSRF 绕过）。
 *   4. 请求体 / 响应体大小上限、连接超时 + 总超时、并发上限。
 *   5. 用户的 API Key 绝不落盘；日志里 authorization / x-api-key / x-goog-api-key /
 *      cookie 以及 url 中的 key= / api_key= / token= 一律脱敏。
 *
 * 用法：
 *   node proxy/server.mjs [--host 127.0.0.1] [--port 8787] [--allow-private]
 *                        [--max-response-bytes 2097152] [--max-request-bytes 1048576]
 *                        [--timeout 30000] [--max-concurrency 8] [--max-redirects 5]
 *   node proxy/server.mjs --help
 *
 * 退出码：0 正常；2 参数错误；1 启动失败（如端口被占用）。
 */

import http from 'node:http';
import https from 'node:https';
import tls from 'node:tls';
import net from 'node:net';
import dns from 'node:dns/promises';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
/** 仓库根目录：静态托管的边界，任何路径都不得逃逸出这里。 */
const ROOT = path.resolve(__dirname, '..');

const IS_MAIN = process.argv[1]
  ? path.resolve(process.argv[1]) === path.resolve(__filename)
  : false;

/* ------------------------------------------------------------------ *
 * 版本号：优先读冻结的 constants.VERSION，源码不可用时回退。
 * 用动态 import，保证代理在 src 被改坏时仍能独立启动。
 * ------------------------------------------------------------------ */
async function loadVersion() {
  try {
    const mod = await import(new URL('../src/core/constants.js', import.meta.url).href);
    if (mod && typeof mod.VERSION === 'string' && mod.VERSION.trim()) return mod.VERSION.trim();
  } catch {
    /* 忽略：代理不依赖 src 才能运行 */
  }
  return '1.0.0';
}
const VERSION = await loadVersion();

/* ------------------------------------------------------------------ *
 * 配置与命令行参数
 * ------------------------------------------------------------------ */
const CFG = {
  host: '127.0.0.1',
  port: 8787,
  allowPrivate: false,
  maxRequestBytes: 1 * 1024 * 1024, // 1 MiB
  maxResponseBytes: 2 * 1024 * 1024, // 2 MiB
  connectTimeoutMs: 10_000, // 单跳连接/静默超时
  totalTimeoutMs: 30_000, // 一次请求（含全部重定向跳）的总超时
  maxConcurrency: 8, // /proxy 与 /inspect 的并发上限
  maxRedirects: 5,
};

const HELP = `relay-detector 本地代理（契约 2.7）

用法：
  node proxy/server.mjs [选项]

选项：
  --host <addr>               监听地址，默认 127.0.0.1（仅本机可访问）
  --port <n>                  监听端口，默认 8787
  --allow-private             允许访问私网/环回/链路本地目标（危险，默认关闭）
  --max-request-bytes <n>     请求体上限，默认 1048576（1 MiB）
  --max-response-bytes <n>    响应体上限，默认 2097152（2 MiB）
  --timeout <ms>              单次请求总超时，默认 30000
  --max-concurrency <n>       并发上限，默认 8
  --max-redirects <n>         最多跟随的重定向跳数，默认 5
  -h, --help                  显示本帮助

路由：
  GET  /                            静态托管仓库根目录
  GET/POST /proxy?url=<encoded>     透传（follow=0 关闭重定向跟随）
  GET  /inspect?host=<h>&port=443   读取对端 TLS 证书
  GET  /health                      { ok: true, version }

安全：默认只允许 http/https 且只允许公网目标；重定向每一跳都会重新校验。
`;

/** 读取一个数值型参数并做范围校验，非法即退出（退出码 2）。 */
function readNumber(raw, flag, min, max) {
  const n = Number(raw);
  if (!Number.isFinite(n) || Math.floor(n) !== n || n < min || n > max) {
    console.error(`[relay-detector-proxy] 参数 ${flag} 非法：${raw}（应为 ${min}..${max} 的整数）`);
    process.exit(2);
  }
  return n;
}

function parseArgs(argv) {
  const next = (inline, flag) => {
    if (inline !== undefined && inline !== '') return inline;
    const v = argv[++argv._i];
    if (v === undefined || v.startsWith('--')) {
      console.error(`[relay-detector-proxy] 参数 ${flag} 缺少取值`);
      process.exit(2);
    }
    return v;
  };
  argv._i = 0;
  for (argv._i = 0; argv._i < argv.length; argv._i++) {
    const a = argv[argv._i];
    const eq = a.indexOf('=');
    const flag = eq >= 0 ? a.slice(0, eq) : a;
    const inline = eq >= 0 ? a.slice(eq + 1) : undefined;
    switch (flag) {
      case '--allow-private':
        CFG.allowPrivate = true;
        break;
      case '--host':
        CFG.host = next(inline, flag);
        break;
      case '--port':
        CFG.port = readNumber(next(inline, flag), flag, 1, 65535);
        break;
      case '--max-request-bytes':
        CFG.maxRequestBytes = readNumber(next(inline, flag), flag, 1024, 64 * 1024 * 1024);
        break;
      case '--max-response-bytes':
        CFG.maxResponseBytes = readNumber(next(inline, flag), flag, 1024, 64 * 1024 * 1024);
        break;
      case '--timeout':
        CFG.totalTimeoutMs = readNumber(next(inline, flag), flag, 1000, 600_000);
        break;
      case '--max-concurrency':
        CFG.maxConcurrency = readNumber(next(inline, flag), flag, 1, 256);
        break;
      case '--max-redirects':
        CFG.maxRedirects = readNumber(next(inline, flag), flag, 0, 20);
        break;
      case '-h':
      case '--help':
        console.log(HELP);
        process.exit(0);
        break;
      default:
        console.error(`[relay-detector-proxy] 未知参数：${a}\n\n${HELP}`);
        process.exit(2);
    }
  }
}

/* ------------------------------------------------------------------ *
 * 脱敏：任何进入日志的字符串都不允许包含完整密钥
 * ------------------------------------------------------------------ */
const SENSITIVE_HEADERS = new Set([
  'authorization',
  'proxy-authorization',
  'x-api-key',
  'api-key',
  'x-goog-api-key',
  'cookie',
  'set-cookie',
]);
const SENSITIVE_QUERY = /^(api[-_]?key|key|token|access[-_]?token|auth|authorization|password|secret|sig|signature)$/i;

/** 保留前 6 位 + 标记，不可逆（禁止还原完整密钥）。 */
function redactSecret(value) {
  const v = typeof value === 'string' ? value : String(value ?? '');
  if (v.length === 0) return '<redacted:empty>';
  if (v.length <= 6) return '<redacted>';
  return `${v.slice(0, 6)}…<redacted:${v.length}>`;
}

/** 返回脱敏后的请求头副本（只用于日志，绝不用于转发）。 */
function redactHeaders(headers) {
  const out = {};
  for (const [k, v] of Object.entries(headers || {})) {
    const key = String(k).toLowerCase();
    out[key] = SENSITIVE_HEADERS.has(key) ? redactSecret(Array.isArray(v) ? v.join(',') : v) : v;
  }
  return out;
}

/** url 中的密钥型 query 一律替换，返回可安全打印的短串。 */
function redactUrl(raw) {
  try {
    const u = new URL(String(raw));
    for (const key of [...u.searchParams.keys()]) {
      if (SENSITIVE_QUERY.test(key)) u.searchParams.set(key, '<redacted>');
    }
    return u.href;
  } catch {
    return String(raw).replace(/([?&](?:api[-_]?key|key|token|access[-_]?token)=)[^&]*/gi, '$1<redacted>');
  }
}

/** 统一日志出口：所有参数先经 URL / 密钥脱敏。 */
function log(...parts) {
  const line = parts
    .map((p) => {
      if (typeof p === 'string') return redactUrl(p);
      if (p && typeof p === 'object') {
        try {
          return JSON.stringify(p, (k, v) => (SENSITIVE_HEADERS.has(String(k).toLowerCase()) ? redactSecret(v) : v));
        } catch {
          return '[object]';
        }
      }
      return String(p);
    })
    .join(' ');
  console.log(`[relay-detector-proxy] ${line}`);
}

/* ------------------------------------------------------------------ *
 * 目标地址安全校验（SSRF 防线）
 * ------------------------------------------------------------------ */
class ProxyError extends Error {
  constructor(code, message, status = 502) {
    super(message);
    this.name = 'ProxyError';
    this.code = code;
    this.status = status;
  }
}

const IPV6_BRACKETS = /^\[|\]$/g;

/** IPv4 是否属于「不可公网直达」的保留段。 */
function isPublicIPv4(ip) {
  const parts = String(ip).split('.').map(Number);
  if (parts.length !== 4 || parts.some((n) => !Number.isInteger(n) || n < 0 || n > 255)) return false;
  const [a, b, c] = parts;
  if (a === 0) return false; // 0.0.0.0/8 "this network"
  if (a === 10) return false; // 私网
  if (a === 127) return false; // 环回
  if (a === 100 && b >= 64 && b <= 127) return false; // CGNAT 100.64/10
  if (a === 169 && b === 254) return false; // 链路本地
  if (a === 172 && b >= 16 && b <= 31) return false; // 私网
  if (a === 192 && b === 168) return false; // 私网
  if (a === 192 && b === 0 && c === 0) return false; // IETF 协议保留
  if (a === 192 && b === 0 && c === 2) return false; // TEST-NET-1
  if (a === 198 && b === 51 && c === 100) return false; // TEST-NET-2
  if (a === 203 && b === 0 && c === 113) return false; // TEST-NET-3
  if (a === 198 && (b === 18 || b === 19)) return false; // 基准测试
  if (a >= 224) return false; // 组播 / 保留 / 广播
  return true;
}

/** IPv6 是否属于「不可公网直达」的保留段（含 IPv4-mapped / NAT64）。 */
function isPublicIPv6(ip) {
  let s = String(ip).toLowerCase().split('%')[0]; // 去掉 zone id
  if (s.startsWith('[') && s.endsWith(']')) s = s.slice(1, -1);
  if (!net.isIPv6(s)) return false;

  // IPv4-mapped（::ffff:a.b.c.d）与其十六进制写法 → 按 IPv4 判定
  const mapped = s.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/);
  if (mapped) return isPublicIPv4(mapped[1]);
  const mappedHex = s.match(/^::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/);
  if (mappedHex) {
    const hi = parseInt(mappedHex[1], 16);
    const lo = parseInt(mappedHex[2], 16);
    return isPublicIPv4(`${hi >> 8}.${hi & 255}.${lo >> 8}.${lo & 255}`);
  }

  if (s === '::' || s === '::1') return false; // 未指定 / 环回
  if (/^f[cd]/.test(s)) return false; // fc00::/7 ULA
  if (/^fe[89ab]/.test(s)) return false; // fe80::/10 链路本地
  if (/^ff/.test(s)) return false; // ff00::/8 组播
  if (s.startsWith('64:ff9b:')) return false; // NAT64（可绕过 IPv4 检查）
  if (s.startsWith('2002:')) return false; // 6to4（内嵌 IPv4）
  if (s.startsWith('2001:db8')) return false; // 文档段
  if (s.startsWith('2001:0:')) return false; // Teredo
  if (s.startsWith('100::')) return false; // 丢弃前缀
  return true; // 其余按全球单播处理
}

/** 统一入口：字符串形式的 IP 是否可直接访问。 */
function isPublicAddress(ip) {
  if (net.isIPv4(ip)) return isPublicIPv4(ip);
  if (net.isIPv6(ip)) return isPublicIPv6(ip);
  return false;
}

/** 把连接固定到已校验的地址，杜绝「校验后 DNS 再变」的 rebinding 窗口。 */
function makePinnedLookup(address, family) {
  const fam = family || (net.isIPv6(address) ? 6 : 4);
  return (_hostname, options, callback) => {
    let opts = options;
    let cb = callback;
    if (typeof opts === 'function') {
      cb = opts;
      opts = {};
    }
    if (!cb) return;
    if (opts && opts.all) return cb(null, [{ address, family: fam }]);
    return cb(null, address, fam);
  };
}

/**
 * 解析主机名并校验：返回固定使用的公网 IP。
 * 默认策略：**任一**解析结果落在非公网段即整体拒绝（防解析分散绕过）。
 */
async function resolveAndValidate(hostname, port) {
  const bare = String(hostname || '').replace(IPV6_BRACKETS, '');
  if (!bare) throw new ProxyError('invalid_host', '缺少目标主机名', 400);

  let addresses;
  const literal = net.isIP(bare);
  if (literal) {
    addresses = [bare];
  } else {
    try {
      const rows = await dns.lookup(bare, { all: true, verbatim: true });
      addresses = rows.map((r) => r.address);
    } catch (err) {
      throw new ProxyError('dns_failed', `DNS 解析失败：${bare}（${err && (err.code || err.message)}）`, 502);
    }
  }
  if (!addresses.length) throw new ProxyError('dns_failed', `DNS 未返回任何地址：${bare}`, 502);

  if (!CFG.allowPrivate) {
    const bad = addresses.find((a) => !isPublicAddress(a));
    if (bad) {
      throw new ProxyError(
        'private_target_blocked',
        `目标 ${bare} 解析到非公网地址 ${bad}；默认拒绝私网/环回/链路本地目标（如确需访问请用 --allow-private 启动）`,
        403,
      );
    }
  }

  const address = addresses.find((a) => net.isIPv4(a)) || addresses[0];
  return { hostname: bare, port, addresses, address, family: net.isIP(address) };
}

/* ------------------------------------------------------------------ *
 * HTTP 转发
 * ------------------------------------------------------------------ */
const REQ_HOP_BY_HOP = new Set([
  'connection',
  'keep-alive',
  'proxy-authenticate',
  'proxy-authorization',
  'te',
  'trailer',
  'transfer-encoding',
  'upgrade',
  'host',
  'content-length',
]);
const RES_HOP_BY_HOP = new Set([
  'connection',
  'keep-alive',
  'proxy-authenticate',
  'trailer',
  'transfer-encoding',
  'upgrade',
]);

/** 构造转发用的请求头：剔除逐跳头，并去掉本工具自己的标记。 */
function buildUpstreamHeaders(req, targetUrl, body) {
  const out = {};
  for (const [k, v] of Object.entries(req.headers)) {
    const key = String(k).toLowerCase();
    if (REQ_HOP_BY_HOP.has(key)) continue;
    if (key.startsWith('sec-')) continue; // 浏览器安全头无意义且会暴露本地上下文
    if (key.startsWith('x-relay-detector')) continue;
    if (key === 'origin' || key === 'referer') continue;
    out[key] = v;
  }
  out.host = targetUrl.host; // 由目标 URL 重算，避免 Host 头被用来做虚拟主机绕行
  if (body && body.length >= 0) out['content-length'] = String(body.length);
  return out;
}

/** 单跳请求：返回 { status, headers, body, truncated, streamError }。 */
function requestOnce(targetUrl, { method, headers, body, address, family, timeoutMs }) {
  return new Promise((resolve, reject) => {
    const isTls = targetUrl.protocol === 'https:';
    const mod = isTls ? https : http;
    const hostname = targetUrl.hostname.replace(IPV6_BRACKETS, '');
    const port = Number(targetUrl.port || (isTls ? 443 : 80));

    const options = {
      hostname,
      port,
      method,
      path: `${targetUrl.pathname}${targetUrl.search}`,
      headers,
      lookup: makePinnedLookup(address, family),
      timeout: Math.max(1, timeoutMs),
      // 中转站常使用自签 / 过期证书，正是我们要观测的对象；
      // 因此不校验证书，只把证书状态通过响应头回传给调用方（见 README 安全说明）。
      rejectUnauthorized: false,
    };
    if (isTls && net.isIP(hostname) === 0) options.servername = hostname;

    let settled = false;
    const upstream = mod.request(options, (upRes) => {
      const chunks = [];
      let size = 0;
      let truncated = false;
      const finish = () => {
        if (settled) return;
        settled = true;
        resolve({
          status: upRes.statusCode || 502,
          headers: { ...upRes.headers },
          body: Buffer.concat(chunks),
          truncated,
          tlsAuthorized: typeof upRes.socket?.authorized === 'boolean' ? upRes.socket.authorized : undefined,
          tlsError: upRes.socket?.authorizationError ? String(upRes.socket.authorizationError) : undefined,
        });
      };
      upRes.on('data', (chunk) => {
        if (settled) return;
        const prev = size;
        size += chunk.length;
        if (size > CFG.maxResponseBytes) {
          truncated = true;
          const keep = CFG.maxResponseBytes - prev;
          if (keep > 0) chunks.push(chunk.subarray(0, keep));
          upRes.destroy();
          finish();
          return;
        }
        chunks.push(chunk);
      });
      upRes.on('end', finish);
      upRes.on('aborted', finish);
      upRes.on('error', (err) => {
        if (settled) return;
        settled = true;
        resolve({
          status: upRes.statusCode || 502,
          headers: { ...(upRes.headers || {}) },
          body: Buffer.concat(chunks),
          truncated: true,
          streamError: redactSecret(err && err.message),
        });
      });
    });

    upstream.on('timeout', () => {
      upstream.destroy(Object.assign(new Error('upstream timeout'), { code: 'ETIMEDOUT' }));
    });
    upstream.on('error', (err) => {
      if (settled) return;
      settled = true;
      const timedOut = err && (err.code === 'ETIMEDOUT' || err.code === 'ESOCKETTIMEDOUT');
      reject(
        new ProxyError(
          timedOut ? 'upstream_timeout' : 'upstream_error',
          `上游请求失败：${err && (err.code || err.message)}`,
          timedOut ? 504 : 502,
        ),
      );
    });

    if (body && body.length) upstream.write(body);
    upstream.end();
  });
}

const REDIRECT_STATUS = new Set([301, 302, 303, 307, 308]);

/** 重定向后的方法改写规则：301/302/303 的 POST 降级为 GET（浏览器行为）。 */
function redirectMethod(status, method) {
  const m = String(method || 'GET').toUpperCase();
  if (status === 303) return 'GET';
  if ((status === 301 || status === 302) && m === 'POST') return 'GET';
  return m;
}

/**
 * 透明转发（含手动重定向）。
 * 每跟随一跳，都会回到循环开头重新执行 resolveAndValidate —— 这是防 SSRF 绕过的关键。
 */
async function proxyTransparent(req, targetUrl, { follow, body }) {
  const deadline = Date.now() + CFG.totalTimeoutMs;
  const chain = [];
  let current = targetUrl;
  let method = String(req.method || 'GET').toUpperCase();
  let payload = body;
  let hops = 0;

  for (;;) {
    const remaining = deadline - Date.now();
    if (remaining <= 0) throw new ProxyError('upstream_timeout', '请求总超时', 504);

    // 每一跳都重新校验：协议 + 地址段 + DNS 固定
    if (current.protocol !== 'http:' && current.protocol !== 'https:') {
      throw new ProxyError('unsupported_protocol', `仅允许 http/https，收到 ${current.protocol}`, 400);
    }
    const isTls = current.protocol === 'https:';
    const port = Number(current.port || (isTls ? 443 : 80));
    const { address, family } = await resolveAndValidate(current.hostname, port);

    const hop = await requestOnce(current, {
      method,
      headers: buildUpstreamHeaders(req, current, payload),
      body: payload,
      address,
      family,
      timeoutMs: Math.min(CFG.connectTimeoutMs, remaining),
    });

    const location = hop.headers ? hop.headers.location : undefined;
    if (follow && REDIRECT_STATUS.has(hop.status) && location) {
      if (hops >= CFG.maxRedirects) {
        // 超过跳数上限：把 3xx 原样回传，并留下标记（证据优于吞掉）
        return { hop, hops, chain, finalUrl: current.href, redirectLimit: true, follow };
      }
      let next;
      try {
        next = new URL(String(location), current);
      } catch {
        throw new ProxyError('invalid_redirect', `重定向目标无法解析：${redactUrl(String(location))}`, 502);
      }
      chain.push({ status: hop.status, location: redactUrl(next.href) });
      log('redirect', hop.status, redactUrl(next.href), `hop=${hops + 1}`);
      const newMethod = redirectMethod(hop.status, method);
      if (newMethod !== method) payload = undefined;
      method = newMethod;
      current = next;
      hops += 1;
      continue;
    }

    return { hop, hops, chain, finalUrl: current.href, redirectLimit: false, follow };
  }
}

/** 读取客户端请求体并强制大小上限。超限后不再缓冲，只把后续数据丢弃并立刻报 413。 */
function readRequestBody(req, limit) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    let exceeded = false;
    req.on('data', (chunk) => {
      if (exceeded) return; // 超限后丢弃，不再占用内存
      size += chunk.length;
      if (size > limit) {
        exceeded = true;
        chunks.length = 0;
        reject(new ProxyError('request_too_large', `请求体超过上限 ${limit} 字节`, 413));
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => {
      if (!exceeded) resolve(Buffer.concat(chunks));
    });
    req.on('error', (err) => {
      if (exceeded) return;
      reject(new ProxyError('client_aborted', `读取请求体失败：${err && err.message}`, 400));
    });
  });
}

/* ------------------------------------------------------------------ *
 * TLS 证书读取（/inspect → 契约 1.2 meta.tls）
 * ------------------------------------------------------------------ */
/** "DNS:a.com, DNS:*.a.com" → ['a.com', '*.a.com'] */
function parseAltNames(san) {
  if (!san) return [];
  return String(san)
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean)
    .map((s) => s.replace(/^(DNS|IP Address|IP|email|URI):/i, '').trim());
}

function daysUntil(dateStr) {
  const t = new Date(String(dateStr)).getTime();
  if (!Number.isFinite(t)) return null;
  return Math.ceil((t - Date.now()) / 86_400_000);
}

/**
 * 读取对端证书，产出契约 1.2 要求的字段。
 * 顶层同时给出 tls 字段与嵌套的 tls 对象，两种取法都能用。
 */
function inspectPeerCertificate(host, port, address, family) {
  return new Promise((resolve, reject) => {
    const hostname = String(host).replace(IPV6_BRACKETS, '');
    const options = {
      host: hostname,
      port,
      lookup: makePinnedLookup(address, family),
      rejectUnauthorized: false, // 需要观测自签 / 过期证书，故不校验
      timeout: CFG.connectTimeoutMs,
    };
    if (net.isIP(hostname) === 0) options.servername = hostname;

    let settled = false;
    const fail = (code, message, status = 502) => {
      if (settled) return;
      settled = true;
      reject(new ProxyError(code, message, status));
    };

    const socket = tls.connect(options, () => {
      if (settled) return;
      try {
        const cert = socket.getPeerCertificate(true) || {};
        const chain = [];
        const seen = new Set();
        let node = cert;
        while (node && node.fingerprint256 && !seen.has(node.fingerprint256) && chain.length < 6) {
          seen.add(node.fingerprint256);
          chain.push({
            subject: node.subject || {},
            issuer: node.issuer || {},
            altNames: parseAltNames(node.subjectaltname),
            validFrom: node.valid_from || null,
            validTo: node.valid_to || null,
            fingerprint256: node.fingerprint256,
          });
          node = node.issuerCertificate;
        }

        const cipher = socket.getCipher && socket.getCipher();
        const selfSigned = Boolean(
          (cert.issuerCertificate && cert.fingerprint256 === cert.issuerCertificate.fingerprint256) ||
            (cert.issuer && cert.subject && JSON.stringify(cert.issuer) === JSON.stringify(cert.subject)),
        );

        const tlsInfo = {
          authorized: Boolean(socket.authorized),
          authorizationError: socket.authorizationError ? String(socket.authorizationError) : null,
          issuer: cert.issuer || {},
          subject: cert.subject || {},
          altNames: parseAltNames(cert.subjectaltname),
          validFrom: cert.valid_from || null,
          validTo: cert.valid_to || null,
          protocol: socket.getProtocol() || null,
          cipher: cipher ? cipher.name : null,
          fingerprint256: cert.fingerprint256 || null,
          selfSigned,
          daysRemaining: daysUntil(cert.valid_to),
        };

        settled = true;
        resolve({
          ok: true,
          host: hostname,
          port,
          resolvedAddress: address,
          ...tlsInfo,
          chain,
          tls: tlsInfo,
        });
      } catch (err) {
        fail('tls_inspect_failed', `读取证书失败：${err && err.message}`);
      } finally {
        socket.end();
      }
    });

    socket.on('timeout', () => {
      socket.destroy();
      fail('upstream_timeout', `读取 ${hostname}:${port} 证书超时`, 504);
    });
    socket.on('error', (err) => {
      fail('tls_connect_failed', `TLS 连接失败：${err && (err.code || err.message)}`);
    });
  });
}

/* ------------------------------------------------------------------ *
 * HTTP 响应工具
 * ------------------------------------------------------------------ */
function applyCors(req, headers) {
  headers['access-control-allow-origin'] = '*';
  headers['access-control-allow-methods'] = 'GET, POST, PUT, PATCH, DELETE, HEAD, OPTIONS';
  // 注意：Authorization 不能被 `*` 通配，必须回显预检请求声明的头
  const requested = req && req.headers ? req.headers['access-control-request-headers'] : undefined;
  headers['access-control-allow-headers'] = requested || '*';
  headers['access-control-expose-headers'] = '*';
  headers['access-control-max-age'] = '600';
  headers['vary'] = 'Origin, Access-Control-Request-Headers';
}

function sendJson(req, res, status, payload, extra = {}) {
  const body = Buffer.from(JSON.stringify(payload, null, 2), 'utf8');
  const headers = {
    'content-type': 'application/json; charset=utf-8',
    'content-length': String(body.length),
    'x-content-type-options': 'nosniff',
    ...extra,
  };
  applyCors(req, headers);
  res.writeHead(status, headers);
  if (req.method === 'HEAD') res.end();
  else res.end(body);
}

function sendProxyError(req, res, err) {
  const known = err instanceof ProxyError;
  const status = known ? err.status : 500;
  const code = known ? err.code : 'internal_error';
  const message = known ? err.message : '代理内部错误';
  if (!known) log('internal_error', redactSecret(err && err.stack ? String(err.stack).split('\n')[0] : String(err)));
  const extra = { 'x-relay-detector-proxy': '1' };
  if (status === 413) extra.connection = 'close'; // 请求体未读完，先让客户端拿到 413 再断开
  sendJson(req, res, status, { ok: false, error: code, message }, extra);
  if (status === 413 && req) {
    res.on('finish', () => {
      try {
        req.socket && req.socket.destroy();
      } catch {
        /* 忽略 */
      }
    });
  }
}

/** 把上游响应回传给客户端：真实响应头 + CORS + 本工具标记。 */
function sendUpstream(req, res, hop, meta) {
  const headers = {};
  for (const [k, v] of Object.entries(hop.headers || {})) {
    const key = String(k).toLowerCase();
    if (RES_HOP_BY_HOP.has(key)) continue;
    headers[key] = v;
  }
  delete headers['content-length']; // 可能被截断，一律重算
  if (hop.truncated) delete headers['content-encoding']; // 截断后压缩流不再可用

  headers['x-relay-detector-proxy'] = '1';
  headers['x-relay-detector-hop'] = String(meta.hops);
  headers['x-relay-detector-final-url'] = meta.finalUrl;
  if (meta.chain.length) headers['x-relay-detector-redirects'] = encodeURIComponent(JSON.stringify(meta.chain));
  if (meta.redirectLimit) headers['x-relay-detector-redirect-limit'] = '1';
  if (hop.truncated) headers['x-relay-detector-truncated'] = '1';
  if (typeof hop.tlsAuthorized === 'boolean') {
    headers['x-relay-detector-tls-authorized'] = hop.tlsAuthorized ? '1' : '0';
  }
  if (hop.streamError) headers['x-relay-detector-stream-error'] = '1';

  // 回传 3xx 时把 Location 改写回本代理，保证客户端自行跟随也仍会经过代理（并再次接受每跳校验）；
  // 上游原始 Location 保留在 x-relay-detector-location 里供指纹规则使用。
  if (REDIRECT_STATUS.has(hop.status) && headers.location) {
    let absolute = null;
    try {
      absolute = new URL(String(headers.location), meta.finalUrl).href;
    } catch {
      absolute = null;
    }
    if (absolute) {
      headers['x-relay-detector-location'] = absolute;
      headers.location = `/proxy?url=${encodeURIComponent(absolute)}${meta.follow === false ? '&follow=0' : ''}`;
    }
  }

  const body = hop.body || Buffer.alloc(0);
  headers['content-length'] = String(body.length);
  applyCors(req, headers);

  res.writeHead(hop.status || 502, headers);
  if (req.method === 'HEAD') res.end();
  else res.end(body);
}

/* ------------------------------------------------------------------ *
 * 静态托管（等价 GitHub Pages）
 * ------------------------------------------------------------------ */
const CONTENT_TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.htm': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.map': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.gif': 'image/gif',
  '.ico': 'image/x-icon',
  '.txt': 'text/plain; charset=utf-8',
  '.md': 'text/markdown; charset=utf-8',
  '.woff2': 'font/woff2',
  '.wasm': 'application/wasm',
};

/** 把请求路径安全映射到仓库内文件；任何逃逸或点文件一律拒绝。 */
function resolveStaticPath(pathname) {
  let rel = pathname;
  try {
    rel = decodeURIComponent(pathname);
  } catch {
    throw new ProxyError('bad_request', '路径编码非法', 400);
  }
  if (rel.includes('\0')) throw new ProxyError('bad_request', '路径包含非法字符', 400);
  if (rel === '/' || rel === '') rel = '/index.html';
  const safe = path.normalize(rel).replace(/^[/\\]+/, '');
  const segments = safe.split(/[/\\]/).filter(Boolean);
  if (segments.some((s) => s === '..')) throw new ProxyError('forbidden', '路径越界被拒绝', 403);
  if (segments.some((s) => s.startsWith('.'))) throw new ProxyError('forbidden', '点文件/点目录不可访问', 403);
  const abs = path.resolve(ROOT, safe);
  if (abs !== ROOT && !abs.startsWith(ROOT + path.sep)) throw new ProxyError('forbidden', '路径越界被拒绝', 403);
  return abs;
}

async function serveStatic(req, res, pathname) {
  let abs = resolveStaticPath(pathname);
  let stat;
  try {
    stat = await fsp.stat(abs);
    if (stat.isDirectory()) {
      abs = path.join(abs, 'index.html');
      stat = await fsp.stat(abs);
    }
  } catch {
    const html =
      '<!doctype html><meta charset="utf-8"><title>404 未找到</title>' +
      '<body style="font-family:system-ui;padding:2rem;line-height:1.6"><h1>404</h1>' +
      `<p>本地代理找不到静态资源：<code>${pathname.replace(/[<>&"]/g, '')}</code></p>` +
      '<p><a href="/">返回首页</a></p></body>';
    const buf = Buffer.from(html, 'utf8');
    const headers = {
      'content-type': 'text/html; charset=utf-8',
      'content-length': String(buf.length),
      'x-content-type-options': 'nosniff',
    };
    applyCors(req, headers);
    res.writeHead(404, headers);
    if (req.method === 'HEAD') res.end();
    else res.end(buf);
    return;
  }
  const ext = path.extname(abs).toLowerCase();
  const data = await fsp.readFile(abs);
  const headers = {
    'content-type': CONTENT_TYPES[ext] || 'application/octet-stream',
    'content-length': String(data.length),
    'cache-control': 'no-cache',
    'x-content-type-options': 'nosniff',
  };
  applyCors(req, headers);
  res.writeHead(200, headers);
  if (req.method === 'HEAD') res.end();
  else res.end(data);
}

/* ------------------------------------------------------------------ *
 * 路由
 * ------------------------------------------------------------------ */
let inflight = 0;

async function handleProxy(req, res, urlObj) {
  if (inflight >= CFG.maxConcurrency) {
    sendJson(req, res, 503, {
      ok: false,
      error: 'busy',
      message: `并发已达上限 ${CFG.maxConcurrency}，请稍后重试`,
    }, { 'x-relay-detector-proxy': '1' });
    return;
  }
  inflight += 1;
  const started = Date.now();
  try {
    const raw = urlObj.searchParams.get('url');
    if (!raw) throw new ProxyError('missing_url', '缺少 url 参数，形如 /proxy?url=https%3A%2F%2Fexample.com%2Fv1%2Fmodels', 400);
    let target;
    try {
      target = new URL(raw);
    } catch {
      throw new ProxyError('invalid_url', 'url 参数不是合法 URL', 400);
    }
    if (target.protocol !== 'http:' && target.protocol !== 'https:') {
      throw new ProxyError('unsupported_protocol', `仅允许 http/https，拒绝 ${target.protocol}`, 400);
    }

    const hasBody = req.method === 'POST' || req.method === 'PUT' || req.method === 'PATCH';
    const body = hasBody ? await readRequestBody(req, CFG.maxRequestBytes) : undefined;

    const result = await proxyTransparent(req, target, {
      follow: urlObj.searchParams.get('follow') !== '0',
      body,
    });

    log(
      'proxy',
      req.method,
      redactUrl(raw),
      `→ ${result.hop.status} hops=${result.hops} bytes=${result.hop.body.length}${result.hop.truncated ? ' truncated' : ''} ${Date.now() - started}ms`,
    );
    sendUpstream(req, res, result.hop, result);
  } catch (err) {
    sendProxyError(req, res, err);
  } finally {
    inflight -= 1;
  }
}

async function handleInspect(req, res, urlObj) {
  if (inflight >= CFG.maxConcurrency) {
    sendJson(req, res, 503, { ok: false, error: 'busy', message: `并发已达上限 ${CFG.maxConcurrency}` });
    return;
  }
  inflight += 1;
  try {
    const host = urlObj.searchParams.get('host');
    if (!host) throw new ProxyError('missing_host', '缺少 host 参数，形如 /inspect?host=api.anthropic.com&port=443', 400);
    const portRaw = urlObj.searchParams.get('port');
    const port = portRaw ? Number(portRaw) : 443;
    if (!Number.isInteger(port) || port < 1 || port > 65535) {
      throw new ProxyError('invalid_port', `port 非法：${portRaw}`, 400);
    }
    const { address, family } = await resolveAndValidate(host, port);
    log('inspect', `${host}:${port}`, `addr=${address}`);
    const info = await inspectPeerCertificate(host, port, address, family);
    sendJson(req, res, 200, info);
  } catch (err) {
    sendProxyError(req, res, err);
  } finally {
    inflight -= 1;
  }
}

/** 405 响应：按 RFC 7231 带上 Allow 头，明确该路由支持的方法。 */
function sendMethodNotAllowed(req, res, allow) {
  sendJson(
    req,
    res,
    405,
    { ok: false, error: 'method_not_allowed', message: `${req.method} 不被支持；允许：${allow}` },
    { allow },
  );
}

async function handle(req, res) {
  let urlObj;
  try {
    urlObj = new URL(req.url || '/', `http://${req.headers.host || '127.0.0.1'}`);
  } catch {
    sendJson(req, res, 400, { ok: false, error: 'bad_request', message: '请求 URL 非法' });
    return;
  }

  if (req.method === 'OPTIONS') {
    const headers = { 'content-length': '0' };
    applyCors(req, headers);
    res.writeHead(204, headers);
    res.end();
    return;
  }

  // 只读路由只接受 GET/HEAD（契约 2.7 只声明 GET /health 与 GET /inspect）
  const readOnly = req.method === 'GET' || req.method === 'HEAD';

  if (urlObj.pathname === '/health') {
    if (!readOnly) return sendMethodNotAllowed(req, res, 'GET, HEAD');
    sendJson(req, res, 200, { ok: true, version: VERSION });
    return;
  }
  if (urlObj.pathname === '/proxy') {
    // 契约 2.7 声明 GET|POST /proxy；HEAD 无副作用也放行
    if (req.method !== 'GET' && req.method !== 'POST' && req.method !== 'HEAD') {
      return sendMethodNotAllowed(req, res, 'GET, POST, HEAD');
    }
    await handleProxy(req, res, urlObj);
    return;
  }
  if (urlObj.pathname === '/inspect') {
    if (!readOnly) return sendMethodNotAllowed(req, res, 'GET, HEAD');
    await handleInspect(req, res, urlObj);
    return;
  }
  if (readOnly) {
    await serveStatic(req, res, urlObj.pathname);
    return;
  }
  sendMethodNotAllowed(req, res, 'GET, HEAD');
}

/** 创建 HTTP 服务器（导出以便测试时不抢占端口）。 */
function createServer() {
  const server = http.createServer((req, res) => {
    handle(req, res).catch((err) => {
      // 兜底：绝不让异常打断进程
      try {
        sendProxyError(req, res, err);
      } catch {
        try {
          res.destroy();
        } catch {
          /* 忽略 */
        }
      }
    });
  });
  server.headersTimeout = CFG.totalTimeoutMs + 5000;
  server.requestTimeout = CFG.totalTimeoutMs + 10_000;
  server.keepAliveTimeout = 5000;
  return server;
}

function printBanner(server) {
  const addr = server.address();
  const host = typeof addr === 'object' && addr ? addr.address : CFG.host;
  const port = typeof addr === 'object' && addr ? addr.port : CFG.port;
  console.log('');
  console.log(`relay-detector 本地代理 v${VERSION}`);
  console.log(`  监听        http://${host}:${port}`);
  console.log(`  静态根目录  ${ROOT}`);
  console.log(`  健康检查    http://${host}:${port}/health`);
  console.log(`  证书检查    http://${host}:${port}/inspect?host=api.anthropic.com&port=443`);
  console.log(`  透传        http://${host}:${port}/proxy?url=<encoded>`);
  console.log(
    `  限制        请求体 ${CFG.maxRequestBytes}B / 响应体 ${CFG.maxResponseBytes}B / ` +
      `总超时 ${CFG.totalTimeoutMs}ms / 并发 ${CFG.maxConcurrency} / 重定向 ${CFG.maxRedirects} 跳`,
  );
  if (CFG.allowPrivate) {
    console.log('  ⚠️  已启用 --allow-private：可以访问私网/环回目标，SSRF 防护被放宽，请勿长期开启。');
  } else {
    console.log('  安全        仅 http/https；默认拒绝私网/环回/链路本地目标；重定向每跳重新校验');
  }
  if (host !== '127.0.0.1' && host !== '::1' && host !== 'localhost') {
    console.log('  ⚠️  监听地址不是环回地址，局域网内其他机器可能访问本代理，请确认这是你的本意。');
  }
  console.log('');
}

function start() {
  const server = createServer();
  server.on('error', (err) => {
    if (err && err.code === 'EADDRINUSE') {
      console.error(`[relay-detector-proxy] 端口 ${CFG.port} 已被占用，请用 --port 换一个端口。`);
    } else {
      console.error(`[relay-detector-proxy] 启动失败：${err && (err.code || err.message)}`);
    }
    process.exitCode = 1;
  });
  server.listen(CFG.port, CFG.host, () => printBanner(server));

  const shutdown = (sig) => {
    log('shutdown', sig);
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(0), 1500).unref();
  };
  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));
}

if (IS_MAIN) {
  parseArgs(process.argv.slice(2));
  start();
}

export {
  CFG,
  VERSION,
  ProxyError,
  createServer,
  handle,
  isPublicAddress,
  isPublicIPv4,
  isPublicIPv6,
  makePinnedLookup,
  parseAltNames,
  redactHeaders,
  redactSecret,
  redactUrl,
  resolveAndValidate,
};
