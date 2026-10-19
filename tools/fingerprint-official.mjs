/**
 * 官方端点实测脚本（Lead 所有）。
 *
 * 用途：抓取 OpenAI / Anthropic / Gemini 官方端点的**真实**响应头与 TLS 证书签发者，
 * 用来生成 src/core/constants.js 中的 OFFICIAL_* 常量，避免凭记忆写错导致误判。
 *
 * 用法：node tools/fingerprint-official.mjs [--json]
 *
 * 注意：本脚本会向官方端点发起**匿名**请求（无 API Key），只会拿到 401，
 * 不消耗任何额度，属于只读指纹采集。
 */

import https from 'node:https';
import tls from 'node:tls';

const TARGETS = [
  { provider: 'openai', url: 'https://api.openai.com/v1/models' },
  { provider: 'openai', url: 'https://api.openai.com/v1/chat/completions' },
  { provider: 'anthropic', url: 'https://api.anthropic.com/v1/messages' },
  { provider: 'anthropic', url: 'https://api.anthropic.com/v1/models' },
  { provider: 'gemini', url: 'https://generativelanguage.googleapis.com/v1beta/models' },
  { provider: 'gemini', url: 'https://generativelanguage.googleapis.com/v1/models' }
];

const HEADER_KEEP = /^(server|date|content-type|cf-|x-|openai-|anthropic-|request-id|via|alt-svc|strict-transport-security|access-control-|vary|set-cookie|report-to|nel|cf-cache-status)$/;

/** 发起一次 GET，返回状态码、响应头与正文（截断）。 */
function httpGet(url, timeoutMs = 20000) {
  return new Promise((resolve) => {
    const req = https.request(url, { method: 'GET', timeout: timeoutMs }, (res) => {
      let body = '';
      res.setEncoding('utf8');
      res.on('data', (c) => { if (body.length < 4000) body += c; });
      res.on('end', () => {
        const headers = {};
        for (const [k, v] of Object.entries(res.headers)) headers[k.toLowerCase()] = Array.isArray(v) ? v.join(', ') : v;
        resolve({ ok: true, status: res.statusCode, headers, body: body.slice(0, 2000) });
      });
    });
    req.on('timeout', () => req.destroy(new Error('timeout')));
    req.on('error', (e) => resolve({ ok: false, error: `${e.code || ''} ${e.message}`.trim() }));
    req.end();
  });
}

/** 读取对端证书链的关键字段。 */
function inspectTls(hostname, timeoutMs = 15000) {
  return new Promise((resolve) => {
    const socket = tls.connect(
      { host: hostname, port: 443, servername: hostname, timeout: timeoutMs, rejectUnauthorized: false },
      () => {
        try {
          const cert = socket.getPeerCertificate(true);
          const chain = [];
          let node = cert;
          const seen = new Set();
          while (node && node.fingerprint256 && !seen.has(node.fingerprint256)) {
            seen.add(node.fingerprint256);
            chain.push({
              subject: node.subject,
              issuer: node.issuer,
              altNames: node.subjectaltname,
              validFrom: node.valid_from,
              validTo: node.valid_to,
              fingerprint256: node.fingerprint256
            });
            node = node.issuerCertificate;
          }
          resolve({
            ok: true,
            host: hostname,
            authorized: socket.authorized,
            authorizationError: socket.authorizationError && String(socket.authorizationError),
            protocol: socket.getProtocol(),
            cipher: socket.getCipher()?.name,
            selfSigned: Boolean(cert.issuerCertificate && cert.fingerprint256 === cert.issuerCertificate.fingerprint256),
            chain
          });
        } catch (e) {
          resolve({ ok: false, host: hostname, error: String(e && e.message) });
        } finally {
          socket.end();
        }
      }
    );
    socket.on('timeout', () => { socket.destroy(); resolve({ ok: false, host: hostname, error: 'timeout' }); });
    socket.on('error', (e) => resolve({ ok: false, host: hostname, error: `${e.code || ''} ${e.message}`.trim() }));
  });
}

const asJson = process.argv.includes('--json');
const results = [];

for (const t of TARGETS) {
  const host = new URL(t.url).hostname;
  const [http, tlsInfo] = await Promise.all([httpGet(t.url), inspectTls(host)]);
  results.push({ ...t, host, http, tls: tlsInfo });

  if (!asJson) {
    console.log(`\n=== ${t.provider}  ${t.url}`);
    if (!http.ok) {
      console.log(`  HTTP 失败: ${http.error}`);
    } else {
      console.log(`  status: ${http.status}`);
      for (const [k, v] of Object.entries(http.headers)) {
        if (HEADER_KEEP.test(k) || k.startsWith('x-')) console.log(`    ${k}: ${v}`);
      }
      console.log(`  body: ${http.body.replace(/\s+/g, ' ').slice(0, 600)}`);
    }
    if (tlsInfo.ok) {
      console.log(`  TLS: ${tlsInfo.protocol} / ${tlsInfo.cipher} / authorized=${tlsInfo.authorized} / selfSigned=${tlsInfo.selfSigned}`);
      for (const c of tlsInfo.chain) {
        console.log(`    链: subject=${c.subject?.CN}  issuer=${c.issuer?.O} | ${c.issuer?.CN}  SAN=${String(c.altNames).slice(0, 120)}`);
      }
    } else {
      console.log(`  TLS 失败: ${tlsInfo.error}`);
    }
  }
}

if (asJson) console.log(JSON.stringify(results, null, 2));
