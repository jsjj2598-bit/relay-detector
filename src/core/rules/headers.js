/**
 * headers 类规则：响应头证据（engine 所有）。
 *
 * ⚠️ 红线与校准：
 *  - Cloudflare / 其它公共 CDN 头属于中性（官方 api.anthropic.com 就在 Cloudflare 后）。
 *  - 官方特征头（openai-version 等）只能证明「上游是真的」，在反向代理下会被原样透传，
 *    所以它们只是 official 方向的弱证据；真正决定性的是 url 类域名身份信号。
 */
import { OFFICIAL_HEADER_MARKERS, NEUTRAL_EDGE_MARKERS, GENERIC_SERVER_MARKERS } from '../constants.js';
import { mkSignal, eachProbe, headersOf } from './util.js';

/** 在所有探测响应头里按小写名精确取值并匹配期望正则。 */
function findHeaderValue(ctx, nameLower, expect) {
  for (const probe of eachProbe(ctx)) {
    const headers = headersOf(probe);
    const value = headers[nameLower];
    if (value === undefined || value === null) continue;
    const str = String(value);
    if (!expect || expect.test(str)) return { probeId: probe.id, name: nameLower, value: str };
  }
  return null;
}

function findServer(ctx) {
  for (const probe of eachProbe(ctx)) {
    const headers = headersOf(probe);
    if (headers.server) return { probeId: probe.id, server: String(headers.server) };
  }
  return null;
}

/** 收集所有官方特征头命中（常量表 + 当前协议优先）。 */
export function officialHeaderHits(ctx) {
  const declared = ctx?.target?.provider;
  const order = [declared, 'openai', 'anthropic', 'gemini'].filter(Boolean);
  const seen = new Set();
  const hits = [];
  for (const provider of [...new Set(order)]) {
    for (const marker of OFFICIAL_HEADER_MARKERS[provider] || []) {
      const id = `headers.${marker.header.toLowerCase().replace(/[^a-z0-9]+/g, '_')}`;
      if (seen.has(id)) continue;
      const hit = findHeaderValue(ctx, marker.header.toLowerCase(), marker.expect);
      if (!hit) continue;
      seen.add(id);
      hits.push({
        id,
        provider,
        marker,
        ...hit,
      });
    }
  }
  return hits;
}

function officialMarkersRule(ctx) {
  return officialHeaderHits(ctx).map((hit) =>
    mkSignal({
      id: hit.id,
      category: 'headers',
      verdict: 'official',
      weight: hit.marker.weight,
      confidence: hit.marker.confidence,
      title: `响应头出现官方特征：${hit.marker.header}`,
      detail:
        `${hit.marker.note} ⚠️ 该类响应头在反向代理下会被原样透传，只能说明上游是真的官方实现，` +
        '不能证明你就是直连官方；决定「直连」的是域名身份信号。',
      evidence: { header: hit.name, value: hit.value, probeId: hit.probeId, provider: hit.provider },
      source: 'rules/headers.js',
    }),
  );
}

function cfRayRule(ctx) {
  const hit = findHeaderValue(ctx, 'cf-ray', null);
  const server = findServer(ctx);
  const isCf = Boolean(hit) || Boolean(server && /cloudflare/i.test(server.server));
  if (!isCf) return [];
  return [
    mkSignal({
      id: 'headers.cf_ray',
      category: 'headers',
      verdict: 'neutral',
      weight: 20,
      confidence: 0.9,
      title: '响应头出现 Cloudflare 边缘特征',
      detail:
        '检测到 cf-ray / server: cloudflare，说明站点经 Cloudflare 反代。' +
        '校准事实：官方 api.anthropic.com 本身就在 Cloudflare 后，因此这是中性观察，不作为中转证据。',
      evidence: {
        'cf-ray': hit ? hit.value : undefined,
        server: server ? server.server : undefined,
        probeId: (hit || server || {}).probeId,
      },
      source: 'rules/headers.js',
    }),
  ];
}

function neutralEdgeRule(ctx) {
  const server = findServer(ctx);
  const markers = [];
  if (server) {
    for (const marker of NEUTRAL_EDGE_MARKERS) {
      if (/cloudflare/i.test(String(marker.match))) continue; // Cloudflare 已由 cf_ray 规则处理
      if (marker.match.test(server.server)) markers.push(marker.label);
    }
  }
  const extraHeaders = ['x-vercel-id', 'x-amz-cf-id', 'akamai-grn', 'x-served-by', 'x-cache'];
  const headerHits = [];
  for (const name of extraHeaders) {
    const hit = findHeaderValue(ctx, name, null);
    if (hit) headerHits.push({ name, value: hit.value, probeId: hit.probeId });
  }
  if (markers.length === 0 && headerHits.length === 0) return [];
  return [
    mkSignal({
      id: 'headers.neutral_edge',
      category: 'headers',
      verdict: 'neutral',
      weight: 18,
      confidence: 0.85,
      title: '响应头出现公共 CDN / 边缘服务特征',
      detail: '公共 CDN 与边缘服务既不指向官方直连，也不指向中转站，属于中性观察。',
      evidence: { edgeMarkers: [...new Set(markers)], headers: headerHits },
      source: 'rules/headers.js',
    }),
  ];
}

function gatewayServerRule(ctx) {
  const server = findServer(ctx);
  if (!server) return [];
  const marker = GENERIC_SERVER_MARKERS.find((m) => m.match.test(server.server));
  if (!marker || /^cloudflare$/i.test(marker.label)) return [];
  return [
    mkSignal({
      id: 'headers.gateway_server',
      category: 'headers',
      verdict: 'relay',
      weight: 12,
      confidence: 0.4,
      title: `Server 头为通用 Web 服务器（${marker.label}）`,
      detail:
        '直接暴露 nginx / OpenResty / uvicorn 等通用服务器头，说明响应由自建网关处理；' +
        '但官方端点也可能在 CDN 之后使用同类软件，故指示力很弱、置信度低。',
      evidence: { server: server.server, marker: marker.label, probeId: server.probeId },
      source: 'rules/headers.js',
    }),
  ];
}

function missingOfficialHeadersRule(ctx) {
  if (officialHeaderHits(ctx).length > 0) return [];
  const responded = eachProbe(ctx, (p) => p.response !== null && Object.keys(headersOf(p)).length > 0);
  if (responded.length === 0) return [];
  return [
    mkSignal({
      id: 'headers.official_markers_absent',
      category: 'headers',
      verdict: 'neutral',
      weight: 10,
      confidence: 0.5,
      title: '未观察到官方特征响应头',
      detail:
        '「缺少官方头」既不能证明官方直连，也不能证明中转：无密钥、被 CORS 过滤、或 CDN 改写都会导致官方头缺失。',
      evidence: { respondedProbes: responded.map((p) => p.id) },
      source: 'rules/headers.js',
    }),
  ];
}

function wildcardCorsRule(ctx) {
  const hit = findHeaderValue(ctx, 'access-control-allow-origin', /^\*$/);
  if (!hit) return [];
  return [
    mkSignal({
      id: 'headers.wildcard_cors',
      category: 'headers',
      verdict: 'relay',
      weight: 14,
      confidence: 0.4,
      title: '接口开放通配 CORS',
      detail:
        '响应 Access-Control-Allow-Origin: *，常见于面向浏览器开放的网关；' +
        '但部分官方端点也会为公开接口开启通配 CORS，指示力很弱。',
      evidence: { header: hit.name, value: hit.value, probeId: hit.probeId },
      source: 'rules/headers.js',
    }),
  ];
}

export const HEADERS_RULES = [
  cfRayRule,
  neutralEdgeRule,
  officialMarkersRule,
  gatewayServerRule,
  missingOfficialHeadersRule,
  wildcardCorsRule,
];
