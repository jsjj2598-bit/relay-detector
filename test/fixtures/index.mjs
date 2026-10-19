/**
 * 伪造响应 fixture 的加载器与 fetch 兼容 transport 工厂。
 *
 * 所有 fixture 都是**完全离线**的：transport 不触碰真实网络，只按 URL/method
 * 匹配预先声明的响应。这样检测引擎的核心测试无需联网即可复现。
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const FIXTURE_DIR = path.dirname(fileURLToPath(import.meta.url));

/** 全部 fixture 的稳定顺序（报告与回归测试按此顺序跑）。 */
export const FIXTURE_IDS = [
  'openai-official-401',
  'oneapi-401',
  'cloudflare-403',
  'anthropic-official-cf-403',
  'forwarded-official-headers',
  'aggregated-models',
  'static-placeholder',
  'network-error'
];

/** 读取单个 fixture（JSON）。 */
export function loadFixture(id) {
  const file = path.join(FIXTURE_DIR, `${id}.json`);
  if (!fs.existsSync(file)) throw new Error(`fixture 不存在: ${id} (${file})`);
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

/** 读取全部 fixture。 */
export function loadAllFixtures() {
  return FIXTURE_IDS.map(loadFixture);
}

function routeMatches(route, url, method) {
  const m = String(route.method ?? 'ANY').toUpperCase();
  if (m !== 'ANY' && m !== method) return false;
  if (typeof route.pathContains === 'string' && route.pathContains.length > 0) {
    return url.includes(route.pathContains);
  }
  return true;
}

/**
 * 构造一个与 `fetch` 同签名的伪造 transport。
 *
 * @param {object} fixture loadFixture 结果
 * @param {object} [opts]
 * @param {'network'|'timeout'|'cors'|null} [opts.fail] 强制失败模式（默认取 fixture.transportFail）
 * @returns {Function & {calls: Array<object>}} transport，附带 calls 记录
 */
export function createFakeTransport(fixture, opts = {}) {
  const fail = opts.fail !== undefined ? opts.fail : fixture.transportFail ?? null;
  const calls = [];

  const transport = async (url, init = {}) => {
    const u = String(url);
    const method = String(init?.method ?? 'GET').toUpperCase();
    calls.push({
      url: u,
      method,
      headers: init?.headers ?? null,
      body: init?.body === undefined ? null : init.body
    });

    if (fail === 'network') throw new TypeError('fetch failed');
    if (fail === 'cors') throw new TypeError('Failed to fetch');
    if (fail === 'timeout') {
      const err = new Error('The operation was aborted due to timeout');
      err.name = 'TimeoutError';
      throw err;
    }

    const route = (fixture.routes || []).find((r) => routeMatches(r, u, method));
    const spec = route || fixture.defaultResponse;
    if (!spec) throw new TypeError('fetch failed');

    const status = spec.status ?? 200;
    const headers = new Headers(spec.headers || {});
    let bodyText = '';
    if (typeof spec.rawText === 'string') bodyText = spec.rawText;
    else if (spec.body !== undefined && spec.body !== null) bodyText = JSON.stringify(spec.body);

    const body = status === 204 || status === 304 ? null : bodyText;
    return new Response(body, { status, headers });
  };

  transport.calls = calls;
  transport.fixtureId = fixture.id;
  return transport;
}
