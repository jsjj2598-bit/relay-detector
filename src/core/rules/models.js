/**
 * models 类规则：模型列表证据（engine 所有）。
 *
 * 判据核心：**多上游聚合**。一个端点同时列出 Claude / Gemini / Qwen / DeepSeek 等
 * 不同家族的模型，说明它把多家上游拼在一个列表里 —— 这是中转站最稳定的特征之一。
 *
 * 注意两个反向约束：
 *  1. 正规厂商（OFFICIAL_HOSTS.other_vendors / Azure 等）列表里出现 deepseek-* 等
 *     是它自己的产品，不构成聚合证据。
 *  2. 官方端点「只列自家模型」也**不能**算官方证据（中转站通常直接透传官方模型名），
 *     因此 official 方向信号权重刻意压低。
 */
import { OFFICIAL_MODEL_PREFIXES, THIRD_PARTY_MODEL_PREFIXES, OFFICIAL_HOST_PATTERNS } from '../constants.js';
import { findOfficialHostMatch } from './url.js';
import { mkSignal, firstProbe, modelIdsFrom, normalizeModelId } from './util.js';

const OFFICIAL_FAMILIES = ['openai', 'anthropic', 'gemini'];

/** 判定模型 id 属于哪个家族：官方三家族优先，其次第三方家族，最后 unknown。 */
export function familyOfModel(rawId) {
  const id = normalizeModelId(rawId);
  for (const fam of OFFICIAL_FAMILIES) {
    for (const prefix of OFFICIAL_MODEL_PREFIXES[fam] || []) {
      if (id.startsWith(String(prefix).toLowerCase())) return fam;
    }
  }
  for (const prefix of THIRD_PARTY_MODEL_PREFIXES) {
    if (id.startsWith(String(prefix).toLowerCase())) return 'thirdparty';
  }
  return 'unknown';
}

function modelsProbeOf(ctx) {
  return firstProbe(ctx, (p) => p.kind === 'models' && p.response !== null && p.response.bodyJson);
}

function isRecognizedVendorHost(ctx) {
  const host = String(ctx?.target?.host || '');
  if (!host) return false;
  if (findOfficialHostMatch(host)) return true;
  return OFFICIAL_HOST_PATTERNS.some((p) => p.pattern.test(host));
}

function analyzeModels(ctx) {
  const probe = modelsProbeOf(ctx);
  if (!probe) return null;
  const ids = modelIdsFrom(probe.response.bodyJson);
  const declared = ctx?.target?.provider || 'openai';
  const counts = { openai: 0, anthropic: 0, gemini: 0, thirdparty: 0, unknown: 0 };
  for (const id of ids) counts[familyOfModel(id)] += 1;
  const otherFamilies = OFFICIAL_FAMILIES.filter((f) => f !== declared && counts[f] > 0);
  return { probe, ids, declared, counts, otherFamilies, total: ids.length, vendor: isRecognizedVendorHost(ctx) };
}

function crossFamilyRule(ctx) {
  const a = analyzeModels(ctx);
  if (!a || a.total === 0) return [];
  const evidence = {
    probeId: a.probe.id,
    total: a.total,
    declaredProvider: a.declared,
    counts: a.counts,
    sample: a.ids.slice(0, 12),
  };
  if (a.vendor) {
    return [
      mkSignal({
        id: 'models.vendor_own_family',
        category: 'models',
        verdict: 'neutral',
        weight: 12,
        confidence: 0.6,
        title: '模型列表属于正规厂商自有家族',
        detail: '目标域名是已识别的正规厂商端点，其模型名（如 deepseek-*）属于该厂商自有产品，不构成多上游聚合证据。',
        evidence,
        source: 'rules/models.js',
      }),
    ];
  }
  const tp = a.counts.thirdparty;
  const declaredCount = a.counts[a.declared] || 0;
  const multiUpstream = a.otherFamilies.length >= 1 || (tp > 0 && (declaredCount === 0 || tp >= Math.max(2, a.total * 0.3)));
  if (!multiUpstream) {
    if (tp > 0) {
      return [
        mkSignal({
          id: 'models.third_party_present',
          category: 'models',
          verdict: 'relay',
          weight: 26,
          confidence: 0.5,
          title: '列表混入少量第三方家族模型',
          detail: '模型列表中混入了非声明协议家族的模型（如 qwen/deepseek/llama），疑似多上游聚合；也可能是厂商自有的兼容模型，故置信度中等。',
          evidence,
          source: 'rules/models.js',
        }),
      ];
    }
    return [];
  }
  return [
    mkSignal({
      id: 'models.cross_family',
      category: 'models',
      verdict: 'relay',
      weight: 58,
      confidence: 0.72,
      title: '模型列表跨多个上游家族（聚合特征）',
      detail:
        '单端点同时列出多个厂商家族的模型，说明它把多家上游拼在同一个列表里。' +
        '这是中转站/聚合网关最稳定的特征之一；官方端点只列自家家族（但中转站也可能只列单家上游，故未命中不代表官方）。',
      evidence: { ...evidence, otherFamilies: a.otherFamilies },
      source: 'rules/models.js',
    }),
  ];
}

function officialOverlapRule(ctx) {
  const a = analyzeModels(ctx);
  if (!a || a.total === 0 || a.vendor) return [];
  const declaredCount = a.counts[a.declared] || 0;
  if (a.otherFamilies.length > 0 || a.counts.thirdparty > 0) return [];
  if (declaredCount < Math.max(2, a.total * 0.7)) return [];
  return [
    mkSignal({
      id: 'models.official_overlap_high',
      category: 'models',
      verdict: 'official',
      weight: 22,
      confidence: 0.45,
      title: '模型列表全部属于声明协议的官方家族',
      detail:
        '列表中的模型名全部命中声明协议的官方模型家族前缀。' +
        '⚠️ 中转站通常直接透传官方模型名，所以这只能算很弱的正向证据，不能证明直连。',
      evidence: { probeId: a.probe.id, total: a.total, declaredProvider: a.declared, counts: a.counts },
      source: 'rules/models.js',
    }),
  ];
}

function oversizedListRule(ctx) {
  const a = analyzeModels(ctx);
  if (!a || a.total === 0 || a.vendor) return [];
  const cap = Number(ctx?.options?.maxModelsListed);
  const capped = Number.isFinite(cap) && cap > 0 && a.total >= cap;
  if (a.total < 200 && !capped) return [];
  return [
    mkSignal({
      id: 'models.oversized_list',
      category: 'models',
      verdict: 'relay',
      weight: 28,
      confidence: 0.5,
      title: '模型列表异常庞大',
      detail: `模型列表包含 ${a.total} 个条目${capped ? '（已达用户设置的解析上限，可能被截断）' : ''}，远超单一官方端点常见的规模，疑似聚合了多个上游。`,
      evidence: { probeId: a.probe.id, total: a.total, cap: Number.isFinite(cap) ? cap : null },
      source: 'rules/models.js',
    }),
  ];
}

function unusableListRule(ctx) {
  const a = analyzeModels(ctx);
  if (!a || a.total > 0) return [];
  const probe = a.probe;
  return [
    mkSignal({
      id: 'models.unusable_list',
      category: 'models',
      verdict: 'neutral',
      weight: 8,
      confidence: 0.6,
      title: '模型列表无法解析出条目',
      detail: '拿到了 /models 响应但没有解析出任何模型 id，可能是非标准结构或被防护页面替换。',
      evidence: { probeId: probe.id, keys: probe.response.bodyJson ? Object.keys(probe.response.bodyJson) : [] },
      source: 'rules/models.js',
    }),
  ];
}

export const MODELS_RULES = [crossFamilyRule, officialOverlapRule, oversizedListRule, unusableListRule];
