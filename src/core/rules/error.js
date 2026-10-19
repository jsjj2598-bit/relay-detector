/**
 * error 类规则：错误报文证据（engine 所有）。
 *
 * ⚠️ 最关键的一条回归约束（constants.CALIBRATION）：
 *   受限网络下匿名访问官方 api.anthropic.com 会得到
 *   403 {"error":{"type":"forbidden","message":"Request not allowed"}}
 *   这是 **边缘防护拦截**，不是 API 自身的鉴权响应，必须判为中性/无法判定。
 *   本文件把它作为 weight: 0 的中性信号产出（不抬高证据强度、不影响方向），
 *   从而保证该 fixture 的最终 verdict 是 inconclusive。
 *
 * 另外：官方形状的错误报文在反向代理下会被原样透传，因此它们只是 official 方向的弱证据。
 */
import { OPENAI_ERROR_SHAPE } from '../constants.js';
import { isFlatGatewayEnvelope } from '../signatures.js';
import { mkSignal, eachProbe, jsonOf, headersOf } from './util.js';

/** 检测边缘防护拦截（403 Request not allowed / cf-mitigated）。 */
export function detectEdgeProtection(ctx) {
  for (const probe of eachProbe(ctx, (p) => p.response !== null)) {
    const status = Number(probe.response.status);
    const headers = headersOf(probe);
    const json = jsonOf(probe);
    const errObj = json && typeof json === 'object' && json.error && typeof json.error === 'object' ? json.error : null;
    const message = errObj && typeof errObj.message === 'string' ? errObj.message : '';
    const cfMitigated = Boolean(headers['cf-mitigated']);
    const blocked = status === 403 && errObj && errObj.type === 'forbidden' && /request not allowed/i.test(message);
    const mitigated = cfMitigated && status >= 400;
    if (blocked || mitigated) {
      return {
        probeId: probe.id,
        status,
        message: message || '边缘防护拦截',
        cfMitigated,
      };
    }
  }
  return null;
}

function errorObjectOf(json) {
  if (!json || typeof json !== 'object' || Array.isArray(json)) return null;
  return json.error && typeof json.error === 'object' && !Array.isArray(json.error) ? json.error : null;
}

/** 找到第一条「可识别的错误报文形状」。 */
export function findRecognizedErrorShape(ctx) {
  for (const probe of eachProbe(ctx, (p) => p.response !== null)) {
    const json = jsonOf(probe);
    const errObj = errorObjectOf(json);

    if (errObj) {
      const keys = ['message', 'type', 'param', 'code'];
      const hasAll = keys.every((k) => k in errObj);
      const typeStr = typeof errObj.type === 'string' ? errObj.type : '';
      if (hasAll && OPENAI_ERROR_SHAPE.types.includes(typeStr) && typeStr !== 'forbidden') {
        return { kind: 'openai', probeId: probe.id, json, errObj };
      }
      if (typeof errObj.code === 'number' && typeof errObj.status === 'string') {
        return { kind: 'gemini', probeId: probe.id, json, errObj };
      }
    }
    if (json && typeof json === 'object' && json.type === 'error' && errObj) {
      const inner = errObj.type;
      if (typeof inner === 'string' && inner !== 'forbidden' && typeof errObj.message === 'string') {
        return { kind: 'anthropic', probeId: probe.id, json, errObj };
      }
    }
    if (isFlatGatewayEnvelope(json)) {
      return { kind: 'gateway_flat', probeId: probe.id, json, errObj: null };
    }
  }
  return null;
}

function edgeProtectionRule(ctx) {
  const hit = detectEdgeProtection(ctx);
  if (!hit) return [];
  return [
    mkSignal({
      id: 'error.edge_protection',
      category: 'error',
      verdict: 'neutral',
      weight: 0,
      confidence: 0.95,
      title: '边缘防护拦截（非 API 自身鉴权响应）',
      detail:
        `目标返回 ${hit.status} 边缘防护拦截（${hit.message}），这是 CDN/WAF 行为，` +
        '不代表 API 身份，不能作为中转证据，也不构成官方证据。建议改用本地代理模式或带密钥重试。' +
        '（校准事实：受限网络下匿名访问官方 api.anthropic.com 也会得到同样的 403。）',
      evidence: { probeId: hit.probeId, status: hit.status, message: hit.message, cfMitigated: hit.cfMitigated },
      source: 'rules/error.js',
    }),
  ];
}

function openaiShapeRule(ctx) {
  for (const probe of eachProbe(ctx, (p) => p.response !== null)) {
    const json = jsonOf(probe);
    const errObj = errorObjectOf(json);
    if (!errObj) continue;
    if (!['message', 'type', 'param', 'code'].every((k) => k in errObj)) continue;
    const typeStr = typeof errObj.type === 'string' ? errObj.type : '';
    const strict = OPENAI_ERROR_SHAPE.types.includes(typeStr) && typeStr !== 'forbidden';
    if (!strict) continue;
    return [
      mkSignal({
        id: 'error.openai_shape',
        category: 'error',
        verdict: 'official',
        weight: 30,
        confidence: 0.55,
        title: '错误报文符合 OpenAI 官方字段组合',
        detail:
          'error 对象同时具备 message/type/param/code 四字段且 type 取值合法，与官方错误体一致。' +
          '伪造成本低，且反向代理会原样透传官方错误体，因此这只是 official 方向的弱证据。',
        evidence: { probeId: probe.id, type: errObj.type, code: errObj.code ?? null, param: errObj.param ?? null },
        source: 'rules/error.js',
      }),
    ];
  }
  return [];
}

function anthropicShapeRule(ctx) {
  for (const probe of eachProbe(ctx, (p) => p.response !== null)) {
    const json = jsonOf(probe);
    const errObj = errorObjectOf(json);
    if (!json || typeof json !== 'object' || json.type !== 'error' || !errObj) continue;
    if (typeof errObj.type !== 'string' || errObj.type === 'forbidden') continue;
    if (typeof errObj.message !== 'string') continue;
    return [
      mkSignal({
        id: 'error.anthropic_shape',
        category: 'error',
        verdict: 'official',
        weight: 28,
        confidence: 0.6,
        title: '错误报文符合 Anthropic 官方包装体',
        detail:
          '{"type":"error","error":{"type":...,"message":...}} 与 Anthropic 官方错误体一致。' +
          '反向代理同样会透传该结构，因此只是 official 方向的弱证据。',
        evidence: { probeId: probe.id, innerType: errObj.type },
        source: 'rules/error.js',
      }),
    ];
  }
  return [];
}

function geminiShapeRule(ctx) {
  for (const probe of eachProbe(ctx, (p) => p.response !== null)) {
    const json = jsonOf(probe);
    const errObj = errorObjectOf(json);
    if (!errObj) continue;
    if (typeof errObj.code !== 'number' || typeof errObj.status !== 'string') continue;
    return [
      mkSignal({
        id: 'error.gemini_shape',
        category: 'error',
        verdict: 'official',
        weight: 26,
        confidence: 0.5,
        title: '错误报文符合 Google API 错误形状',
        detail:
          'error.code + error.status（如 PERMISSION_DENIED）是 Google API 标准错误形状，' +
          '但 Google 系网关与代理也会复用该形状，故置信度中等偏低。',
        evidence: { probeId: probe.id, code: errObj.code, status: errObj.status },
        source: 'rules/error.js',
      }),
    ];
  }
  return [];
}

function flatGatewayEnvelopeRule(ctx) {
  for (const probe of eachProbe(ctx, (p) => p.response !== null)) {
    const json = jsonOf(probe);
    if (!isFlatGatewayEnvelope(json)) continue;
    return [
      mkSignal({
        id: 'error.flat_gateway_envelope',
        category: 'error',
        verdict: 'relay',
        weight: 52,
        confidence: 0.6,
        title: '错误报文是扁平业务包装体（网关风格）',
        detail:
          '形如 {"code":401,"message":"...","data":null} 的顶层扁平结构，是常见中转网关返回格式，' +
          '官方 API 使用 {"error":{...}} 包装体。注意：自建业务网关也可能采用该格式，故置信度中等。',
        evidence: { probeId: probe.id, keys: Object.keys(json), code: json.code, message: json.message },
        source: 'rules/error.js',
      }),
    ];
  }
  return [];
}

function unrecognizedAuthFailureRule(ctx) {
  const statuses = eachProbe(ctx, (p) => p.response !== null)
    .map((p) => ({ id: p.id, status: Number(p.response.status) }))
    .filter((x) => x.status === 401 || x.status === 403);
  if (statuses.length === 0) return [];
  if (findRecognizedErrorShape(ctx) || detectEdgeProtection(ctx)) return [];
  return [
    mkSignal({
      id: 'error.unrecognized_auth_failure',
      category: 'error',
      verdict: 'neutral',
      weight: 6,
      confidence: 0.5,
      title: '鉴权失败报文形状无法识别',
      detail: '收到 401/403 但报文形状既不符合官方结构也不符合已知网关指纹，无法据此判断方向。',
      evidence: { statuses },
      source: 'rules/error.js',
    }),
  ];
}

export const ERROR_RULES = [
  edgeProtectionRule,
  openaiShapeRule,
  anthropicShapeRule,
  geminiShapeRule,
  flatGatewayEnvelopeRule,
  unrecognizedAuthFailureRule,
];
