/**
 * payload 类规则：响应载荷（engine 所有）。
 *
 * 契约 1.3 硬性要求：official 方向只能来自「官方独有正向证据」，
 * 绝不能用「没看到中转特征」当 official 证据。本文件因此几乎没有 official 信号，
 * 协议专属的成功响应结构判定放在各 provider 的 rules 里（避免同一证据重复计分）。
 */
import { mkSignal, eachProbe, textOf } from './util.js';

function contentTypeOf(probe) {
  const ct = probe?.response?.contentType || probe?.response?.headers?.['content-type'] || '';
  return String(ct).toLowerCase();
}

/** 未启用付费探测时给出明确说明（中性、权重 0，不影响评分）。 */
function paidProbeSkippedRule(ctx) {
  if (ctx?.options?.allowPaidProbes === true) return [];
  const paidRan = (ctx?.probes || []).some((p) => p?.meta?.paid === true);
  if (paidRan) return [];
  return [
    mkSignal({
      id: 'payload.paid_probe_skipped',
      category: 'payload',
      verdict: 'neutral',
      weight: 0,
      confidence: 1,
      title: '未启用付费探测',
      detail: '本次检测未发送任何可能计费的 chat/messages/generateContent 请求，因此没有成功响应载荷可分析（这是默认的安全行为）。',
      evidence: { allowPaidProbes: false },
      source: 'rules/payload.js',
    }),
  ];
}

/** API 路径返回 HTML 页面。
 *  ⚠️ 语义：这只能证明「该路径不是 API 端点」（错误域名 / 部署未完成 / 路径不对 / 静态托管），
 *  与「第三方中转站」没有因果关系，因此必须是中性信号，绝不能单独构成 relay 方向证据。
 */
function apiPathHtmlRule(ctx) {
  const hit = eachProbe(ctx, (p) => (p.kind === 'models' || p.kind === 'chat') && p.response !== null && contentTypeOf(p).includes('html'))[0];
  if (!hit) return [];
  return [
    mkSignal({
      id: 'payload.api_path_html',
      category: 'payload',
      verdict: 'neutral',
      weight: 30,
      confidence: 0.5,
      title: 'API 路径返回 HTML 页面',
      detail:
        '本应是 JSON API 的路径返回了 HTML（通常是网关首页、静态托管页或默认页）。' +
        '这只说明该路径没有提供 API 服务，不能推断上游是否为中转站，故按中性处理。',
      evidence: { probeId: hit.id, contentType: contentTypeOf(hit), snippet: textOf(hit).slice(0, 200) },
      source: 'rules/payload.js',
    }),
  ];
}

/** 成功响应正文出现中文服务/计费话术。 */
function cnServiceTextRule(ctx) {
  const re = /(中转|转发|聚合|公益|额度|余额|分组|渠道|上游|充值|套餐)/;
  for (const probe of eachProbe(ctx, (p) => (p.kind === 'models' || p.kind === 'chat') && p.response !== null)) {
    const body = textOf(probe);
    const idx = body.search(re);
    if (idx < 0) continue;
    return [
      mkSignal({
        id: 'payload.cn_service_text',
        category: 'payload',
        verdict: 'relay',
        weight: 22,
        confidence: 0.35,
        title: '成功响应中出现中文服务/计费话术',
        detail: '官方 API 的成功响应一律为英文结构化 JSON；正文出现中文计费/服务话术，疑似网关自行包装。指示力弱，置信度低。',
        evidence: { probeId: probe.id, matched: body.slice(Math.max(0, idx - 30), idx + 80) },
        source: 'rules/payload.js',
      }),
    ];
  }
  return [];
}

/** API 路径返回既不是 JSON 也不是 HTML 的正文。 */
function nonJsonResponseRule(ctx) {
  const hit = eachProbe(
    ctx,
    (p) =>
      (p.kind === 'models' || p.kind === 'chat') &&
      p.response !== null &&
      p.response.bodyText &&
      !p.response.bodyJson &&
      !contentTypeOf(p).includes('json') &&
      !contentTypeOf(p).includes('html'),
  )[0];
  if (!hit) return [];
  return [
    mkSignal({
      id: 'payload.non_json_response',
      category: 'payload',
      verdict: 'neutral',
      weight: 8,
      confidence: 0.6,
      title: 'API 路径返回非 JSON 正文',
      detail: 'API 路径返回了无法解析为 JSON 的正文，可能是文本错误页或网关拦截页，无法据此判断方向。',
      evidence: { probeId: hit.id, contentType: contentTypeOf(hit), snippet: hit.response.bodyText.slice(0, 200) },
      source: 'rules/payload.js',
    }),
  ];
}

export const PAYLOAD_RULES = [paidProbeSkippedRule, apiPathHtmlRule, cnServiceTextRule, nonJsonResponseRule];
