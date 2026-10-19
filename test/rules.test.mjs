/**
 * 规则层单元测试：直接以伪造 ctx 调用 engine.runRules（不联网、不依赖探测编排）。
 *
 * 重点覆盖 detect 端到端 fixture 覆盖不到的类别与路径：
 *  - tls 类规则（契约 1.2 的 meta.tls 只在代理模式存在）
 *  - 「Cloudflare / 公共 CA 不得作为中转证据」的校准红线（constants.CALIBRATION）
 *  - tls 探测失败不得被误读成证书问题
 *
 * 只读源码；发现缺陷只报告，不改源码。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { assertSignalValid } from './helpers/signal-shape.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const ENGINE_FILE = path.join(ROOT, 'src', 'core', 'engine.js');
const engine = fs.existsSync(ENGINE_FILE) ? await import(pathToFileURL(ENGINE_FILE).href) : null;
const skipEngine = (t) => t.skip('engine 未交付：src/core/engine.js 不存在');

/** 构造一条契约 1.2 形状的 kind:'tls' 探测。 */
function tlsProbe({ tls = null, error = null } = {}) {
  return {
    id: 'tls.peer',
    provider: 'openai',
    kind: 'tls',
    request: {
      method: 'GET',
      url: 'http://127.0.0.1:8787/inspect?host=api.example.com&port=443',
      headersSent: {},
      bodySent: null,
      startedAt: 0,
      durationMs: 0
    },
    response: tls ? { status: 0, headers: {}, bodyText: '', bodyJson: null, contentType: '' } : null,
    error,
    meta: tls ? { tls } : {}
  };
}

function makeCtx(probes, { host = 'api.example.com', baseUrl = 'https://api.example.com/v1', mode = 'proxy' } = {}) {
  return {
    target: { input: baseUrl, baseUrl, host, provider: 'openai' },
    options: {},
    mode,
    probes,
    get: (id) => probes.find((p) => p.id === id) || null,
    json: () => null,
    text: () => null,
    note: () => {}
  };
}

/** 跑完整规则集，返回 tls 类信号。 */
function tlsSignals(ctx) {
  const all = engine.runRules(ctx, { id: 'openai', rules: [] });
  return all.filter((s) => s.category === 'tls');
}

const CF_TLS = {
  authorized: true,
  issuer: { O: 'Cloudflare, Inc.', CN: 'Cloudflare Inc ECC CA-3', C: 'US' },
  subject: { CN: 'api.example.com' },
  altNames: ['api.example.com', '*.api.example.com'],
  validFrom: 'Jan  1 00:00:00 2026 GMT',
  validTo: 'Jan  1 00:00:00 2027 GMT',
  protocol: 'TLSv1.3',
  cipher: 'TLS_AES_128_GCM_SHA256',
  fingerprint256: 'AA:BB:CC',
  selfSigned: false,
  daysRemaining: 60
};

test('[校准红线] Cloudflare 签发证书只产生 neutral 的 tls 信号，绝无 relay', (t) => {
  if (!engine) return skipEngine(t);
  const signals = tlsSignals(makeCtx([tlsProbe({ tls: CF_TLS })]));
  for (const s of signals) assertSignalValid(s, `tls/${s.id}`);
  assert.ok(signals.some((s) => s.id === 'tls.cloudflare_issuer'), `应产出 tls.cloudflare_issuer，实际 ${signals.map((s) => s.id)}`);
  assert.ok(signals.every((s) => s.verdict !== 'relay'), `Cloudflare 证书不得产出任何 relay 信号：${JSON.stringify(signals.map((s) => [s.id, s.verdict]))}`);
});

test('[校准红线] Google Trust Services（官方实测签发者）只产生 official/neutral，绝无 relay', (t) => {
  if (!engine) return skipEngine(t);
  const tls = {
    ...CF_TLS,
    issuer: { O: 'Google Trust Services', CN: 'WE1', C: 'US' }
  };
  const signals = tlsSignals(makeCtx([tlsProbe({ tls })]));
  for (const s of signals) assertSignalValid(s, `tls/${s.id}`);
  assert.ok(signals.some((s) => s.id === 'tls.official_issuer' && s.verdict === 'official'), `应产出 official 的 tls.official_issuer，实际 ${JSON.stringify(signals.map((s) => [s.id, s.verdict]))}`);
  assert.ok(signals.every((s) => s.verdict !== 'relay'), '官方签发者不得产出任何 relay 信号');
});

test('自签名 / SAN 不匹配 / 临期证书产出形状合法的 relay 信号', (t) => {
  if (!engine) return skipEngine(t);
  const tls = {
    authorized: false,
    issuer: { O: 'Self-signed', CN: 'gateway.local' },
    subject: { CN: 'gateway.local' },
    altNames: ['other.example.net'],
    validTo: 'Jan  2 00:00:00 2026 GMT',
    protocol: 'TLSv1.2',
    cipher: 'ECDHE-RSA-AES128-GCM-SHA256',
    fingerprint256: 'DD:EE:FF',
    selfSigned: true,
    daysRemaining: 1
  };
  const signals = tlsSignals(makeCtx([tlsProbe({ tls })]));
  for (const s of signals) assertSignalValid(s, `tls/${s.id}`);
  const ids = signals.map((s) => s.id);
  assert.ok(ids.includes('tls.self_signed'), `应识别自签名证书，实际 ${ids}`);
  assert.ok(ids.includes('tls.altname_mismatch'), `应识别 SAN 与目标域名不匹配，实际 ${ids}`);
  assert.ok(ids.includes('tls.short_validity'), `应识别证书临期，实际 ${ids}`);
  for (const id of ['tls.self_signed', 'tls.altname_mismatch', 'tls.short_validity']) {
    assert.equal(signals.find((s) => s.id === id).verdict, 'relay', `${id} 方向应为 relay`);
  }
});

test('tls 探测失败（代理 /inspect 无可用信息）只产出 neutral 的 tls.unavailable', (t) => {
  if (!engine) return skipEngine(t);
  const probe = tlsProbe({ error: { kind: 'network', message: '未能从代理 /inspect 获取 TLS 证书信息：代理未响应' } });
  const signals = tlsSignals(makeCtx([probe]));
  for (const s of signals) assertSignalValid(s, `tls/${s.id}`);
  assert.ok(signals.some((s) => s.id === 'tls.unavailable' && s.verdict === 'neutral'), `应产出 neutral 的 tls.unavailable，实际 ${JSON.stringify(signals.map((s) => [s.id, s.verdict]))}`);
  assert.ok(signals.every((s) => s.verdict !== 'relay'), '读取失败不得被当作证书不可信而产出 relay');
});

test('browser 模式没有 tls 探测时不产出任何 tls 信号', (t) => {
  if (!engine) return skipEngine(t);
  const signals = tlsSignals(makeCtx([], { mode: 'browser' }));
  assert.deepEqual(signals, [], `browser 模式不应有 tls 信号，实际 ${JSON.stringify(signals.map((s) => s.id))}`);
});

test('runRules 产出的全部信号都满足契约 1.3 形状（含 tls 场景）', (t) => {
  if (!engine) return skipEngine(t);
  const all = engine.runRules(makeCtx([tlsProbe({ tls: CF_TLS })]), { id: 'openai', rules: [] });
  assert.ok(all.length > 0, '规则集应产出信号');
  const ids = new Set();
  for (const s of all) {
    assertSignalValid(s, `runRules/${s.id}`);
    assert.ok(!ids.has(s.id), `runRules 输出 id 重复：${s.id}`);
    ids.add(s.id);
  }
});
