/**
 * Google Gemini 协议适配（engine 所有）。
 *
 * 关键路径：GET /v1beta/models（免费）、匿名同路径（必然 400/403，读取 Google 标准错误体）、
 * 以及仅在 allowPaidProbes 时 POST /v1beta/models/{model}:generateContent。
 *
 * 密钥通过 x-goog-api-key 头传递（避免把 key 写进 URL）；ProbeResult 仍对 URL 与头做脱敏。
 * 注意：本机网络无法访问 generativelanguage.googleapis.com，相关规则依赖伪造 fixture 校准。
 */
import { joinPath } from '../core/probes.js';
import { mkSignal, firstProbe, jsonOf, modelIdsFrom } from '../core/rules/util.js';

function generateProbe(ctx) {
  return firstProbe(ctx, (p) => p.kind === 'chat' && p.response !== null && p.response.bodyJson);
}

function geminiCandidateShapeRule(ctx) {
  const probe = generateProbe(ctx);
  if (!probe) return [];
  const json = jsonOf(probe);
  if (!json || typeof json !== 'object') return [];
  if (!Array.isArray(json.candidates)) return [];
  return [
    mkSignal({
      id: 'payload.gemini_candidate_shape',
      category: 'payload',
      verdict: 'official',
      weight: 26,
      confidence: 0.5,
      title: '成功响应符合 Gemini candidates 结构',
      detail: '响应包含 candidates 数组（常与 usageMetadata 同现），符合 Google Generative Language 结构；代理会透传该结构，仅为弱正向证据。',
      evidence: { probeId: probe.id, hasUsageMetadata: Boolean(json.usageMetadata), modelVersion: json.modelVersion ?? null },
      source: 'providers/gemini.js',
    }),
  ];
}

function geminiModelsResourceRule(ctx) {
  const probe = firstProbe(ctx, (p) => p.kind === 'models' && p.response !== null && p.response.bodyJson);
  if (!probe) return [];
  const ids = modelIdsFrom(jsonOf(probe));
  if (ids.length === 0) return [];
  const resourceNames = ids.filter((id) => /^models\//i.test(String(id))).length;
  if (resourceNames < Math.max(1, ids.length * 0.8)) return [];
  return [
    mkSignal({
      id: 'models.gemini_resource_names',
      category: 'models',
      verdict: 'official',
      weight: 20,
      confidence: 0.5,
      title: '模型名使用 Gemini 资源全名（models/...）',
      detail: '模型条目使用 "models/gemini-..." 资源全名，符合 Google 原生返回；但中转站也可能透传该字段，仅为弱正向证据。',
      evidence: { probeId: probe.id, total: ids.length, resourceNames, sample: ids.slice(0, 8) },
      source: 'providers/gemini.js',
    }),
  ];
}

export const geminiProvider = {
  id: 'gemini',
  label: 'Google Gemini',
  defaultBaseUrl: 'https://generativelanguage.googleapis.com',

  matches(baseUrl, hint) {
    if (hint && hint !== 'auto') return hint === 'gemini';
    const s = String(baseUrl || '').toLowerCase();
    return /generativelanguage|gemini|googleapis|v1beta/.test(s);
  },

  buildProbes(ctx) {
    const base = ctx?.target?.baseUrl;
    const specs = [
      {
        id: 'gemini.models',
        provider: 'gemini',
        kind: 'models',
        method: 'GET',
        url: joinPath(base, '/v1beta/models'),
        headers: { accept: 'application/json' },
        auth: 'x-goog-api-key',
        body: null,
        expectStatus: 'any',
        requiresKey: true,
        paid: false,
      },
    ];
    if (ctx?.hasKey) {
      specs.push({
        id: 'gemini.auth_error',
        provider: 'gemini',
        kind: 'error',
        method: 'GET',
        url: joinPath(base, '/v1beta/models'),
        headers: { accept: 'application/json' },
        auth: 'none',
        body: null,
        expectStatus: 'any',
        requiresKey: false,
        paid: false,
        meta: { anonymous: true },
      });
    }
    if (ctx?.options?.allowPaidProbes === true) {
      specs.push({
        id: 'gemini.generate',
        provider: 'gemini',
        kind: 'chat',
        method: 'POST',
        url: joinPath(base, '/v1beta/models/gemini-2.5-flash:generateContent'),
        headers: { accept: 'application/json' },
        auth: 'x-goog-api-key',
        body: { contents: [{ parts: [{ text: 'ping' }] }], generationConfig: { maxOutputTokens: 1 } },
        expectStatus: 'any',
        requiresKey: false,
        paid: true,
      });
    }
    return specs;
  },

  rules: [geminiCandidateShapeRule, geminiModelsResourceRule],
};

export default geminiProvider;
