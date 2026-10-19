/**
 * behavior 类规则：行为特征（engine 所有）。
 *
 * 行为类证据天然受网络、地理、负载影响，categoryWeight 也最低（0.5），
 * 因此本文件所有信号的权重都刻意压低；同时绝不产出「因为没看到中转特征所以官方」的 official 信号。
 */
import { mkSignal, firstProbe, eachProbe, jsonOf, headersOf } from './util.js';
import { isFlatGatewayEnvelope } from '../signatures.js';

const UNKNOWN_PATH_ID = 'common.not_found';

function unknownPathProbe(ctx) {
  return typeof ctx?.get === 'function' ? ctx.get(UNKNOWN_PATH_ID) : firstProbe(ctx, (p) => p.id === UNKNOWN_PATH_ID);
}

function unknownPath200Rule(ctx) {
  const probe = unknownPathProbe(ctx);
  if (!probe || probe.response === null) return [];
  if (Number(probe.response.status) !== 200) return [];
  return [
    mkSignal({
      id: 'behavior.unknown_path_200',
      category: 'behavior',
      verdict: 'neutral',
      weight: 40,
      confidence: 0.6,
      title: '不存在的路径返回 200',
      detail:
        '对随机不存在的路径返回 200（而非 404），说明前面存在兜底路由/首页路由。' +
        '这只说明该路径不是 API 端点（可能是静态托管、SPA 回退、部署未完成），不能推断上游是否为中转站，故按中性处理。',
      evidence: { probeId: probe.id, status: probe.response.status, snippet: String(probe.response.bodyText || '').slice(0, 200) },
      source: 'rules/behavior.js',
    }),
  ];
}

function unknownPathHtmlRule(ctx) {
  const probe = unknownPathProbe(ctx);
  if (!probe || probe.response === null) return [];
  const contentType = String(probe.response.contentType || probe.response.headers?.['content-type'] || '').toLowerCase();
  if (!contentType.includes('html')) return [];
  if (probe.response.bodyJson) return [];
  return [
    mkSignal({
      id: 'behavior.unknown_path_html',
      category: 'behavior',
      verdict: 'neutral',
      weight: 30,
      confidence: 0.5,
      title: '未知路径返回 HTML 错误页',
      detail:
        '不存在的 API 路径返回 HTML（通常是 nginx/网关默认页或静态站点）。' +
        '这只能说明该 URL 未提供 API 服务，与是否为中转站无因果关系，故按中性处理。',
      evidence: { probeId: probe.id, status: probe.response.status, contentType, snippet: String(probe.response.bodyText || '').slice(0, 200) },
      source: 'rules/behavior.js',
    }),
  ];
}

function unknownPathOfficial404Rule(ctx) {
  const probe = unknownPathProbe(ctx);
  if (!probe || probe.response === null) return [];
  if (Number(probe.response.status) !== 404) return [];
  const json = jsonOf(probe);
  const errObj = json && typeof json === 'object' && json.error && typeof json.error === 'object' ? json.error : null;
  const recognized =
    (errObj && typeof errObj.message === 'string' && typeof errObj.type === 'string') ||
    (errObj && typeof errObj.code === 'number' && typeof errObj.status === 'string') ||
    (json && typeof json === 'object' && json.type === 'error' && errObj);
  if (!recognized) return [];
  return [
    mkSignal({
      id: 'behavior.unknown_path_official_404',
      category: 'behavior',
      verdict: 'official',
      weight: 18,
      confidence: 0.45,
      title: '未知路径返回官方风格 404 错误体',
      detail: '不存在的路径返回了结构化 404 错误体（而非网关首页）；伪造成本低且反向代理会透传，仅为很弱的正向证据。',
      evidence: { probeId: probe.id, status: 404 },
      source: 'rules/behavior.js',
    }),
  ];
}

function corsAmbiguousRule(ctx) {
  const hits = eachProbe(ctx, (p) => p.error && p.error.kind === 'cors');
  if (hits.length === 0) return [];
  return [
    mkSignal({
      id: 'behavior.cors_ambiguous',
      category: 'behavior',
      verdict: 'neutral',
      weight: 5,
      confidence: 0.5,
      title: '探测被浏览器拦截（CORS 或网络故障）',
      detail:
        '浏览器无法区分 CORS 拦截与网络故障（两者都是 TypeError: Failed to fetch）。' +
        '本次检测的『不可达』结论必须视为不确定，请改用本地代理模式复核。',
      evidence: { probes: hits.map((p) => ({ id: p.id, message: p.error.message })) },
      source: 'rules/behavior.js',
    }),
  ];
}

function unreachableRule(ctx) {
  const probes = eachProbe(ctx);
  if (probes.length === 0) return [];
  if (probes.some((p) => p.response !== null)) return [];
  return [
    mkSignal({
      id: 'behavior.unreachable',
      category: 'behavior',
      verdict: 'neutral',
      weight: 10,
      confidence: 0.7,
      title: '目标完全不可达',
      detail: '所有探测都没有拿到响应，无法形成任何方向性证据。',
      evidence: { probes: probes.map((p) => ({ id: p.id, error: p.error?.kind || 'unknown' })) },
      source: 'rules/behavior.js',
    }),
  ];
}

function latencyOutlierRule(ctx) {
  const probe = firstProbe(ctx, (p) => p.kind === 'models' && p.response !== null);
  const duration = probe?.request?.durationMs;
  if (!Number.isFinite(duration) || duration < 5000) return [];
  return [
    mkSignal({
      id: 'behavior.latency_outlier',
      category: 'behavior',
      verdict: 'relay',
      weight: 12,
      confidence: 0.25,
      title: '模型列表探测耗时异常',
      detail: `单次探测耗时 ${duration}ms。延迟受网络与地理影响极大，也可由中转站二次请求上游造成，指示力很弱、置信度很低。`,
      evidence: { probeId: probe.id, durationMs: duration },
      source: 'rules/behavior.js',
    }),
  ];
}

function gatewayEnvelopeInAnyProbeRule(ctx) {
  // 扁平网关体的结构判定已由 error.flat_gateway_envelope 负责；
  // 这里只补充「行为」层面的事实：任意路径都返回同一种网关包装体。
  const probes = eachProbe(ctx, (p) => p.response !== null && p.response.bodyJson);
  if (probes.length < 2) return [];
  const flatCount = probes.filter((p) => isFlatGatewayEnvelope(jsonOf(p))).length;
  if (flatCount < 2) return [];
  return [
    mkSignal({
      id: 'behavior.uniform_gateway_envelope',
      category: 'behavior',
      verdict: 'relay',
      weight: 24,
      confidence: 0.5,
      title: '所有路径返回同一种网关包装体',
      detail: '多个不同路径都返回同一种扁平业务包装体，说明前端的网关对所有请求统一兜底处理。',
      evidence: { probes: probes.map((p) => p.id), flatCount },
      source: 'rules/behavior.js',
    }),
  ];
}

export const BEHAVIOR_RULES = [
  unknownPath200Rule,
  unknownPathHtmlRule,
  unknownPathOfficial404Rule,
  corsAmbiguousRule,
  unreachableRule,
  latencyOutlierRule,
  gatewayEnvelopeInAnyProbeRule,
];
