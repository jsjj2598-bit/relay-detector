/**
 * signature 类规则：已知网关软件指纹（engine 所有）。
 *
 * 指纹数据集中在 src/core/signatures.js；本文件只负责遍历探测结果并产出信号。
 * 注意：`signature` 是类别权重最高的一类（1.4），所以每条指纹的 confidence 都写明理由，
 * 并且明确标注哪些指纹由别的规则负责（避免同证据重复计分）。
 */
import {
  KNOWN_GATEWAY_SIGNATURES,
  SIGNATURE_IDS_OWNED_BY_OTHER_RULES,
  SIGNATURE_DISCLAIMER,
} from '../signatures.js';
import { mkSignal, eachProbe, headersOf, textOf } from './util.js';

function probeContentType(probe) {
  const ct = probe?.response?.contentType || headersOf(probe)['content-type'] || '';
  return String(ct).toLowerCase();
}

function snippet(text, index, before = 40, after = 140) {
  const start = Math.max(0, index - before);
  return text.slice(start, start + before + after);
}

function gatewaySignatureRule(ctx) {
  const probes = eachProbe(ctx, (p) => p.response !== null);
  if (probes.length === 0) return [];

  const out = [];
  for (const entry of KNOWN_GATEWAY_SIGNATURES) {
    if (SIGNATURE_IDS_OWNED_BY_OTHER_RULES.has(entry.id)) continue;

    let hit = null;
    if (entry.headerName) {
      for (const probe of probes) {
        for (const [name, value] of Object.entries(headersOf(probe))) {
          if (entry.headerName.test(name)) {
            hit = { probeId: probe.id, matched: `${name}: ${String(value).slice(0, 80)}` };
            break;
          }
        }
        if (hit) break;
      }
    } else if (entry.text) {
      for (const probe of probes) {
        const isHtml = probeContentType(probe).includes('html');
        if (entry.requiresHtml && !isHtml) continue;
        if (entry.skipForHtml && isHtml) continue;
        const body = textOf(probe);
        const index = body.search(entry.text);
        if (index >= 0) {
          hit = { probeId: probe.id, matched: snippet(body, index), isHtml };
          break;
        }
      }
    }
    if (!hit) continue;

    out.push(
      mkSignal({
        id: `signature.${entry.id}`,
        category: 'signature',
        verdict: 'relay',
        weight: entry.weight,
        confidence: entry.confidence,
        title: `命中已知网关指纹：${entry.id}`,
        detail: `${entry.note}（软件：${entry.software}）${SIGNATURE_DISCLAIMER}`,
        evidence: {
          software: entry.software,
          fingerprint: entry.id,
          probeId: hit.probeId,
          matched: hit.matched,
          origin: entry.origin || 'engine',
        },
        source: 'rules/signature.js',
      }),
    );
  }
  return out;
}

export const SIGNATURE_RULES = [gatewaySignatureRule];
