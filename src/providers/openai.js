/**
 * OpenAI / OpenAI 兼容协议适配（engine 所有）。
 *
 * 安全约束（契约 2.1）：默认 allowPaidProbes === false 时只允许
 *   GET /v1/models、GET /v1/models/{id}（可选）、以及一次必然失败的匿名鉴权探测。
 * 这里绝不发送 chat/completions，除非用户显式开启付费探测。
 */
import { joinPath } from '../core/probes.js';
import { mkSignal, firstProbe, jsonOf } from '../core/rules/util.js';

function ensureV1(base) {
  const b = String(base || '').replace(/\/+$/, '');
  return /(^|\/)v1$/i.test(b) ? b : `${b}/v1`;
}

function chatProbe(ctx) {
  return firstProbe(ctx, (p) => p.kind === 'chat' && p.response !== null && p.response.bodyJson);
}

function openaiChatShapeRule(ctx) {
  const probe = chatProbe(ctx);
  if (!probe) return [];
  const json = jsonOf(probe);
  if (!json || typeof json !== 'object') return [];
  if (json.object !== 'chat.completion' || typeof json.id !== 'string' || !Array.isArray(json.choices)) return [];
  return [
    mkSignal({
      id: 'payload.openai_chat_shape',
      category: 'payload',
      verdict: 'official',
      weight: 28,
      confidence: 0.5,
      title: '成功响应符合 OpenAI chat.completion 结构',
      detail:
        '响应包含 object: "chat.completion"、id 与 choices 数组，与官方结构一致。' +
        '但中转站通常直接透传上游响应，因此只能算弱正向证据。',
      evidence: { probeId: probe.id, object: json.object, model: json.model ?? null },
      source: 'providers/openai.js',
    }),
  ];
}

function openaiChatMetadataMissingRule(ctx) {
  const probe = chatProbe(ctx);
  if (!probe) return [];
  const json = jsonOf(probe);
  if (!json || typeof json !== 'object') return [];
  if (Number(probe.response.status) !== 200) return [];
  const out = [];
  if (json.object !== 'chat.completion' || typeof json.id !== 'string' || !Array.isArray(json.choices)) {
    out.push(
      mkSignal({
        id: 'payload.openai_chat_metadata_missing',
        category: 'payload',
        verdict: 'relay',
        weight: 45,
        confidence: 0.6,
        title: '成功响应缺少 OpenAI 标准元数据',
        detail: 'HTTP 200 但缺少 object/id/choices 等官方必含字段，说明中间层改写了响应结构（可能是自行包装的网关）。',
        evidence: { probeId: probe.id, keys: Object.keys(json).slice(0, 20) },
        source: 'providers/openai.js',
      }),
    );
  } else if (!json.usage || typeof json.usage !== 'object') {
    out.push(
      mkSignal({
        id: 'payload.openai_usage_missing',
        category: 'payload',
        verdict: 'relay',
        weight: 20,
        confidence: 0.4,
        title: 'chat.completion 缺少 usage 字段',
        detail: '官方 chat.completion 一定带 usage（token 计数）；缺失通常意味着响应被中间层改写，但流式/兼容实现也可能省略，故置信度低。',
        evidence: { probeId: probe.id },
        source: 'providers/openai.js',
      }),
    );
  }
  return out;
}

export const openaiProvider = {
  id: 'openai',
  label: 'OpenAI / 兼容',
  defaultBaseUrl: 'https://api.openai.com/v1',

  /** 纯函数：OpenAI 兼容协议对任何目标都可用，永远返回 true。 */
  matches() {
    return true;
  },

  buildProbes(ctx) {
    const base = ensureV1(ctx?.target?.baseUrl);
    const specs = [
      {
        id: 'openai.models',
        provider: 'openai',
        kind: 'models',
        method: 'GET',
        url: joinPath(base, '/models'),
        headers: { accept: 'application/json' },
        auth: 'bearer',
        body: null,
        expectStatus: 'any',
        requiresKey: true,
        paid: false,
      },
    ];
    // 有 key 时，再补一条**匿名**探测：必然 401，用来读取官方/网关的错误报文（免费）。
    if (ctx?.hasKey) {
      specs.push({
        id: 'openai.auth_error',
        provider: 'openai',
        kind: 'error',
        method: 'GET',
        url: joinPath(base, '/models'),
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
        id: 'openai.chat',
        provider: 'openai',
        kind: 'chat',
        method: 'POST',
        url: joinPath(base, '/chat/completions'),
        headers: { accept: 'application/json' },
        auth: 'bearer',
        body: {
          model: 'gpt-4o-mini',
          messages: [{ role: 'user', content: 'ping' }],
          max_tokens: 1,
          stream: false,
        },
        expectStatus: 'any',
        requiresKey: false,
        paid: true,
      });
    }
    return specs;
  },

  /** 拿到模型列表后，额外请求一个具体模型（GET /v1/models/{id}，免费）。 */
  buildFollowUpProbes(ctx) {
    const models = ctx?.json?.('openai.models');
    const ids = [];
    if (models && Array.isArray(models.data)) {
      for (const item of models.data) {
        const id = typeof item === 'string' ? item : item?.id;
        if (typeof id === 'string' && id) ids.push(id);
      }
    }
    if (ids.length === 0) return [];
    const chosen = ids[0];
    return [
      {
        id: 'openai.models_detail',
        provider: 'openai',
        kind: 'models',
        method: 'GET',
        url: joinPath(ensureV1(ctx.target.baseUrl), `/models/${encodeURIComponent(chosen)}`),
        headers: { accept: 'application/json' },
        auth: 'bearer',
        body: null,
        expectStatus: 'any',
        requiresKey: false,
        paid: false,
        meta: { modelId: chosen },
      },
    ];
  },

  rules: [openaiChatShapeRule, openaiChatMetadataMissingRule],
};

export default openaiProvider;
