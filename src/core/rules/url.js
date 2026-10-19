/**
 * url 类规则：域名与路径身份（engine 所有）。
 *
 * ⚠️ 承重结构：score.js 的「域名身份降级闸门」要求
 * `category === 'url' && verdict === 'official'` 的信号存在，否则一切 official / likely-official
 * 判定都会被降级为 inconclusive。因此本文件必须做到：
 *   1. 命中 OFFICIAL_HOSTS 的官方端点 → official 身份信号（高权重、高置信）。
 *   2. 命中 OFFICIAL_HOSTS.other_vendors / OFFICIAL_HOST_PATTERNS → 也是 official 身份信号（略低权重）。
 *   3. 命中 AGGREGATOR_HOSTS → 中性（它是多上游代理，不是官方直连，也不是灰产中转）。
 *   4. 未知域名 → **必须**产出 url 类中性信号，说明「非官方域名本身不足以定性」。
 *
 * 注意：本文件绝不把「非官方域名」当作中转证据 —— 中转站与自建/企业定制域无法仅凭域名区分。
 */
import { OFFICIAL_HOSTS, OFFICIAL_HOST_PATTERNS, AGGREGATOR_HOSTS } from '../constants.js';
import { mkSignal } from './util.js';

function targetHost(ctx) {
  const explicit = String(ctx?.target?.host || '').toLowerCase();
  if (explicit) return explicit;
  try {
    return new URL(String(ctx?.target?.baseUrl || '')).hostname.toLowerCase();
  } catch {
    return '';
  }
}

function parseTargetUrl(ctx) {
  try {
    return new URL(String(ctx?.target?.baseUrl || ''));
  } catch {
    return null;
  }
}

function isIpLiteral(host) {
  const h = String(host || '').replace(/^\[|\]$/g, '');
  if (/^\d{1,3}(\.\d{1,3}){3}$/.test(h)) return true;
  return /^(?=.*:)[0-9a-f:]+$/i.test(h) && h.includes(':');
}

function isLocalHost(host) {
  const h = String(host || '').replace(/^\[|\]$/g, '').toLowerCase();
  return h === 'localhost' || h === '127.0.0.1' || h === '::1' || h === '0.0.0.0' || h.endsWith('.localhost');
}

/** 精确命中的官方端点（provider 官方 or 其它正规厂商）。 */
export function findOfficialHostMatch(host) {
  const h = String(host || '').toLowerCase();
  if (!h) return null;
  for (const provider of ['openai', 'anthropic', 'gemini']) {
    for (const cand of OFFICIAL_HOSTS[provider] || []) {
      if (cand.toLowerCase() === h) return { kind: 'official', provider, host: cand };
    }
  }
  const vendors = OFFICIAL_HOSTS.other_vendors || [];
  for (const cand of vendors) {
    if (cand.toLowerCase() !== h) continue;
    if (AGGREGATOR_HOSTS.some((a) => a.toLowerCase() === h)) return { kind: 'aggregator', provider: null, host: cand };
    return { kind: 'vendor', provider: null, host: cand };
  }
  return null;
}

function urlOfficialHostRule(ctx) {
  const host = targetHost(ctx);
  const match = findOfficialHostMatch(host);
  if (!match || match.kind !== 'official') return [];
  const declared = ctx?.target?.provider;
  const mismatch = declared && declared !== match.provider;
  return [
    mkSignal({
      id: 'url.official_host',
      category: 'url',
      verdict: 'official',
      weight: 70,
      confidence: 0.92,
      title: '域名精确命中官方端点白名单',
      detail: mismatch
        ? `目标域名 ${host} 命中 ${match.provider} 官方端点白名单（与当前选择的协议 ${declared} 不一致，请确认协议选择）。域名身份是唯一能证明「直连官方」的证据类别。`
        : `目标域名 ${host} 精确命中 ${match.provider} 官方端点白名单。域名身份是唯一能证明「直连官方」而非「代理转发到官方上游」的证据类别。`,
      evidence: { host, matchedProvider: match.provider, declaredProvider: declared || null, whitelist: 'OFFICIAL_HOSTS' },
      source: 'rules/url.js',
    }),
  ];
}

function urlOfficialPatternRule(ctx) {
  const host = targetHost(ctx);
  if (!host) return [];
  const match = OFFICIAL_HOST_PATTERNS.find((p) => p.pattern.test(host));
  if (!match) return [];
  return [
    mkSignal({
      id: 'url.official_pattern',
      category: 'url',
      verdict: 'official',
      weight: 58,
      confidence: 0.8,
      title: `域名命中正规厂商域名模式（${match.label}）`,
      detail: `目标域名 ${host} 命中 ${match.label} 域名模式，属于正规厂商托管端点（非官方 OpenAI 直连，但也不是灰产中转）。`,
      evidence: { host, label: match.label, pattern: String(match.pattern) },
      source: 'rules/url.js',
    }),
  ];
}

function urlVendorHostRule(ctx) {
  const host = targetHost(ctx);
  const match = findOfficialHostMatch(host);
  if (!match || match.kind !== 'vendor') return [];
  return [
    mkSignal({
      id: 'url.vendor_host',
      category: 'url',
      verdict: 'official',
      weight: 55,
      confidence: 0.7,
      title: '域名属于正规厂商自有端点',
      detail: `目标域名 ${host} 是已知正规厂商端点；它不是官方 OpenAI 直连，但也不属于灰产中转站。`,
      evidence: { host, hostList: 'OFFICIAL_HOSTS.other_vendors' },
      source: 'rules/url.js',
    }),
  ];
}

function urlAggregatorHostRule(ctx) {
  const host = targetHost(ctx);
  const match = findOfficialHostMatch(host);
  if (!match || match.kind !== 'aggregator') return [];
  return [
    mkSignal({
      id: 'url.aggregator_host',
      category: 'url',
      verdict: 'neutral',
      weight: 22,
      confidence: 0.7,
      title: '域名属于聚合平台',
      detail: `目标域名 ${host} 是聚合型平台，本质即「多上游转发」：既不是官方直连，也不同于灰产中转。按中性处理，方向应由其它证据决定。`,
      evidence: { host, hostList: 'AGGREGATOR_HOSTS' },
      source: 'rules/url.js',
    }),
  ];
}

function urlNonOfficialHostRule(ctx) {
  const host = targetHost(ctx);
  if (!host) return [];
  const matched = findOfficialHostMatch(host);
  const pattern = OFFICIAL_HOST_PATTERNS.find((p) => p.pattern.test(host));
  if (matched || pattern) return [];
  return [
    mkSignal({
      id: 'url.nonofficial_host',
      category: 'url',
      verdict: 'neutral',
      weight: 25,
      confidence: 0.85,
      title: '域名不在官方白名单内',
      detail:
        '非官方域名本身不足以定性为中转站：它可能是 Azure/企业定制域、自建部署、聚合平台或第三方中转。' +
        '该信号仅说明域名身份未被确认，不能证明也不是官方直连。',
      evidence: { host, note: '未知域名，方向性判定必须依赖其它证据' },
      source: 'rules/url.js',
    }),
  ];
}

function urlIpHostRule(ctx) {
  const host = targetHost(ctx);
  if (!host || !isIpLiteral(host) || isLocalHost(host)) return [];
  return [
    mkSignal({
      id: 'url.ip_host',
      category: 'url',
      verdict: 'relay',
      weight: 42,
      confidence: 0.7,
      title: '目标使用 IP 字面量而非域名',
      detail: '官方 API 均以固定域名提供服务，直接使用 IP 通常是自建反代或内网网关。',
      evidence: { host },
      source: 'rules/url.js',
    }),
  ];
}

function urlHttpSchemeRule(ctx) {
  const url = parseTargetUrl(ctx);
  const host = targetHost(ctx);
  if (!url || url.protocol !== 'http:') return [];
  if (isLocalHost(host)) return [];
  return [
    mkSignal({
      id: 'url.http_scheme',
      category: 'url',
      verdict: 'relay',
      weight: 32,
      confidence: 0.85,
      title: '使用明文 HTTP 而非 HTTPS',
      detail: '官方 API 强制 HTTPS；明文 HTTP 说明目标是自建/内网网关或未配置 TLS 的反代。',
      evidence: { baseUrl: String(ctx?.target?.baseUrl || ''), protocol: url.protocol },
      source: 'rules/url.js',
    }),
  ];
}

function urlNonstandardPortRule(ctx) {
  const url = parseTargetUrl(ctx);
  if (!url || !url.port) return [];
  if (url.port === '443' || url.port === '80') return [];
  return [
    mkSignal({
      id: 'url.nonstandard_port',
      category: 'url',
      verdict: 'relay',
      weight: 18,
      confidence: 0.6,
      title: '使用非标准端口',
      detail: '官方端点使用 443；非标准端口常见于自建网关，但也可能是企业内网合法部署，指示力较弱。',
      evidence: { port: url.port, host: url.hostname },
      source: 'rules/url.js',
    }),
  ];
}

function urlLocalhostHostRule(ctx) {
  const host = targetHost(ctx);
  if (!host || !isLocalHost(host)) return [];
  return [
    mkSignal({
      id: 'url.localhost_host',
      category: 'url',
      verdict: 'neutral',
      weight: 15,
      confidence: 0.7,
      title: '目标是本机 / 环回地址',
      detail: '目标为 localhost / 环回地址，通常是你自己运行的本地代理或网关；本工具无法据此判断上游身份。',
      evidence: { host },
      source: 'rules/url.js',
    }),
  ];
}

export const URL_RULES = [
  urlOfficialHostRule,
  urlOfficialPatternRule,
  urlVendorHostRule,
  urlAggregatorHostRule,
  urlNonOfficialHostRule,
  urlIpHostRule,
  urlHttpSchemeRule,
  urlNonstandardPortRule,
  urlLocalhostHostRule,
];
