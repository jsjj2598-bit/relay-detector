/**
 * Anthropic Claude 协议适配（engine 所有）。
 *
 * 关键路径：GET /v1/models（免费）、匿名 GET /v1/models（必然 401，读取官方错误体）、
 * 以及仅在 allowPaidProbes 时 POST /v1/messages。
 * Anthropic 官方默认基址是 https://api.anthropic.com（不含 /v1）。
 */
import { joinPath } from '../core/probes.js';
import { mkSignal, firstProbe, jsonOf } from '../core/rules/util.js';

const ANTHROPIC_VERSION = '2023-06-01';

function messagesProbe(ctx) {
  return firstProbe(ctx, (p) => p.kind === 'chat' && p.response !== null && p.response.bodyJson);
}

function anthropicMessageShapeRule(ctx) {
  const probe = messagesProbe(ctx);
  if (!probe) return [];
  const json = jsonOf(probe);
  if (!json || typeof json !== 'object') return [];
  if (json.type !== 'message' || !Array.isArray(json.content)) return [];
  return [
    mkSignal({
      id: 'payload.anthropic_message_shape',
      category: 'payload',
      verdict: 'official',
      weight: 26,
      confidence: 0.55,
      title: '成功响应符合 Anthropic message 结构',
      detail: '响应包含 type: "message" 与 content 数组，与官方结构一致；但反向代理会原样透传，仅为弱正向证据。',
      evidence: { probeId: probe.id, model: json.model ?? null, role: json.role ?? null },
      source: 'providers/anthropic.js',
    }),
  ];
}

function anthropicMessageMetadataMissingRule(ctx) {
  const probe = messagesProbe(ctx);
  if (!probe) return [];
  const json = jsonOf(probe);
  if (!json || typeof json !== 'object') return [];
  if (Number(probe.response.status) !== 200) return [];
  if (json.type === 'message' && Array.isArray(json.content)) return [];
  return [
    mkSignal({
      id: 'payload.anthropic_message_metadata_missing',
      category: 'payload',
      verdict: 'relay',
      weight: 40,
      confidence: 0.55,
      title: '成功响应缺少 Anthropic 标准结构',
      detail: 'HTTP 200 但缺少 type: "message" / content 数组，说明中间层改写了响应（Anthropic 官方协议不会出现该情况）。',
      evidence: { probeId: probe.id, keys: Object.keys(json).slice(0, 20) },
      source: 'providers/anthropic.js',
    }),
  ];
}

export const anthropicProvider = {
  id: 'anthropic',
  label: 'Anthropic Claude',
  defaultBaseUrl: 'https://api.anthropic.com',

  matches(baseUrl, hint) {
    if (hint && hint !== 'auto') return hint === 'anthropic';
    const s = String(baseUrl || '').toLowerCase();
    return /anthropic|claude/.test(s);
  },

  buildProbes(ctx) {
    const base = ctx?.target?.baseUrl;
    const specs = [
      {
        id: 'anthropic.models',
        provider: 'anthropic',
        kind: 'models',
        method: 'GET',
        url: joinPath(base, '/v1/models'),
        headers: { accept: 'application/json', 'anthropic-version': ANTHROPIC_VERSION },
        auth: 'x-api-key',
        body: null,
        expectStatus: 'any',
        requiresKey: true,
        paid: false,
      },
    ];
    if (ctx?.hasKey) {
      specs.push({
        id: 'anthropic.auth_error',
        provider: 'anthropic',
        kind: 'error',
        method: 'GET',
        url: joinPath(base, '/v1/models'),
        headers: { accept: 'application/json', 'anthropic-version': ANTHROPIC_VERSION },
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
        id: 'anthropic.messages',
        provider: 'anthropic',
        kind: 'chat',
        method: 'POST',
        url: joinPath(base, '/v1/messages'),
        headers: { accept: 'application/json', 'anthropic-version': ANTHROPIC_VERSION },
        auth: 'x-api-key',
        body: {
          model: 'claude-3-5-haiku-latest',
          max_tokens: 1,
          messages: [{ role: 'user', content: 'ping' }],
        },
        expectStatus: 'any',
        requiresKey: false,
        paid: true,
      });
    }
    return specs;
  },

  rules: [anthropicMessageShapeRule, anthropicMessageMetadataMissingRule],
};

export default anthropicProvider;
