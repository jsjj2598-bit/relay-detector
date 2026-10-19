/**
 * tls 类规则：证书层证据（engine 所有，仅在代理模式有数据）。
 *
 * ⚠️ 校准红线（constants.CALIBRATION）：
 *   api.anthropic.com 官方端点本身就在 Cloudflare 后，证书由 Google Trust Services 签发。
 *   ⇒ 「有 Cloudflare / 证书由公共 CA 签发」是中性的，绝不能作为中转证据。
 * 因此本文件里的 Cloudflare / 公共 CA 一律 verdict: 'neutral'，且权重刻意压低。
 */
import { OFFICIAL_TLS_ISSUERS, NEUTRAL_TLS_ISSUERS } from '../constants.js';
import { mkSignal, isObject } from './util.js';

function tlsInfo(ctx) {
  for (const probe of Array.isArray(ctx?.probes) ? ctx.probes : []) {
    if (probe?.kind === 'tls' && isObject(probe.meta?.tls)) return { probe, tls: probe.meta.tls };
  }
  return null;
}

function issuerText(tls) {
  const i = isObject(tls?.issuer) ? tls.issuer : {};
  return [i.O, i.CN, i.OU, i.C].filter(Boolean).join(' ');
}

function altNamesOf(tls) {
  const names = tls?.altNames;
  if (Array.isArray(names)) return names.map((n) => String(n));
  if (typeof names === 'string') return names.split(/,\s*/).map((n) => n.replace(/^DNS:/i, '').trim());
  return [];
}

function tlsCloudflareIssuerRule(ctx) {
  const found = tlsInfo(ctx);
  if (!found) return [];
  const text = issuerText(found.tls);
  if (!/cloudflare/i.test(text)) return [];
  return [
    mkSignal({
      id: 'tls.cloudflare_issuer',
      category: 'tls',
      verdict: 'neutral',
      weight: 20,
      confidence: 0.9,
      title: '证书由 Cloudflare 签发',
      detail:
        '校准事实：官方 api.anthropic.com 本身就在 Cloudflare 后、证书由公共 CA 签发。' +
        '因此 Cloudflare 证书属于中性观察，绝不计入中转证据。',
      evidence: { issuer: found.tls.issuer, certificate: 'Cloudflare 签发', calibration: 'constants.CALIBRATION' },
      source: 'rules/tls.js',
    }),
  ];
}

function tlsOfficialIssuerRule(ctx) {
  const found = tlsInfo(ctx);
  if (!found) return [];
  const text = issuerText(found.tls);
  if (/cloudflare/i.test(text)) return [];
  const match = OFFICIAL_TLS_ISSUERS.find((entry) => entry.match.test(text));
  if (!match || match.confidence < 0.8) return [];
  return [
    mkSignal({
      id: 'tls.official_issuer',
      category: 'tls',
      verdict: 'official',
      weight: 26,
      confidence: match.confidence,
      title: `证书签发者命中官方参考列表（${match.label}）`,
      detail: `${match.note} 注意：公共 CA 同时服务官方与中转站，因此这只是弱正向证据。`,
      evidence: { issuer: found.tls.issuer, matchedLabel: match.label },
      source: 'rules/tls.js',
    }),
  ];
}

function tlsPublicCaRule(ctx) {
  const found = tlsInfo(ctx);
  if (!found) return [];
  const text = issuerText(found.tls);
  if (/cloudflare/i.test(text)) return [];
  const match = NEUTRAL_TLS_ISSUERS.find((entry) => entry.match.test(text));
  if (!match) return [];
  return [
    mkSignal({
      id: 'tls.public_ca',
      category: 'tls',
      verdict: 'neutral',
      weight: 20,
      confidence: 0.85,
      title: `证书由公共 CA 签发（${match.label}）`,
      detail: '公共 CA 证书既服务官方端点也服务中转站，属于中性观察，不作为方向性证据。',
      evidence: { issuer: found.tls.issuer, matchedLabel: match.label },
      source: 'rules/tls.js',
    }),
  ];
}

function tlsSelfSignedRule(ctx) {
  const found = tlsInfo(ctx);
  if (!found || found.tls.selfSigned !== true) return [];
  return [
    mkSignal({
      id: 'tls.self_signed',
      category: 'tls',
      verdict: 'relay',
      weight: 48,
      confidence: 0.8,
      title: '证书为自签名',
      detail: '公开提供 API 服务的官方端点不会使用自签名证书；自签名证书通常是自建网关/反代的默认配置。',
      evidence: { selfSigned: true, subject: found.tls.subject, issuer: found.tls.issuer },
      source: 'rules/tls.js',
    }),
  ];
}

function tlsNotAuthorizedRule(ctx) {
  const found = tlsInfo(ctx);
  if (!found || found.tls.authorized !== false || found.tls.selfSigned === true) return [];
  return [
    mkSignal({
      id: 'tls.not_authorized',
      category: 'tls',
      verdict: 'relay',
      weight: 30,
      confidence: 0.55,
      title: '证书链未通过验证',
      detail: '对端证书未能被系统信任链验证通过；可能是未知 CA 或配置错误的自建网关（也可能是代理读取方式导致，置信度中等）。',
      evidence: { authorized: false, issuer: found.tls.issuer },
      source: 'rules/tls.js',
    }),
  ];
}

function tlsAltNameMismatchRule(ctx) {
  const found = tlsInfo(ctx);
  if (!found) return [];
  const host = String(ctx?.target?.host || '').toLowerCase();
  const names = altNamesOf(found.tls).map((n) => n.toLowerCase().replace(/^\*\./, ''));
  if (!host || names.length === 0) return [];
  const ok = names.some((n) => host === n || host.endsWith(`.${n}`) || n === '*');
  if (ok) return [];
  return [
    mkSignal({
      id: 'tls.altname_mismatch',
      category: 'tls',
      verdict: 'relay',
      weight: 40,
      confidence: 0.75,
      title: '证书 SAN 与目标域名不匹配',
      detail: '证书主体备用名（SAN）不包含目标域名，说明该证书并非为目标域名签发（常见于共享反代网关）。',
      evidence: { host, altNames: names.slice(0, 10) },
      source: 'rules/tls.js',
    }),
  ];
}

function tlsShortValidityRule(ctx) {
  const found = tlsInfo(ctx);
  const days = found?.tls?.daysRemaining;
  if (!Number.isFinite(days) || days > 3) return [];
  return [
    mkSignal({
      id: 'tls.short_validity',
      category: 'tls',
      verdict: 'relay',
      weight: 22,
      confidence: 0.55,
      title: '证书剩余有效期极短',
      detail: `证书仅剩 ${days} 天有效期，常见于自动化短期证书（自建网关默认配置）；官方端点通常会提前续期，故指示力较弱。`,
      evidence: { daysRemaining: days, validTo: found.tls.validTo },
      source: 'rules/tls.js',
    }),
  ];
}

function tlsProbeFailedRule(ctx) {
  if (ctx?.mode !== 'proxy') return [];
  const probe = (ctx?.probes || []).find((p) => p.kind === 'tls');
  if (!probe || probe.error == null) return [];
  return [
    mkSignal({
      id: 'tls.unavailable',
      category: 'tls',
      verdict: 'neutral',
      weight: 0,
      confidence: 0.9,
      title: 'TLS 信息不可用',
      detail: `代理模式下的 TLS 探测失败（${probe.error.kind}: ${probe.error.message}），本次检测缺少证书层证据。`,
      evidence: { probeId: probe.id, error: probe.error },
      source: 'rules/tls.js',
    }),
  ];
}

export const TLS_RULES = [
  tlsCloudflareIssuerRule,
  tlsOfficialIssuerRule,
  tlsPublicCaRule,
  tlsSelfSignedRule,
  tlsNotAuthorizedRule,
  tlsAltNameMismatchRule,
  tlsShortValidityRule,
  tlsProbeFailedRule,
];
