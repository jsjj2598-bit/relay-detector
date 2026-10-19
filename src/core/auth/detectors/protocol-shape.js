/**
 * `protocol_shape`（契约 v2 §6.4）—— 主动检测器，权重 20，quick+，全协议。
 *
 * 发一条最便宜的 chat 请求，检查响应结构是否符合官方协议：
 * id / object / choices / stop_reason / usage 等关键键是否存在且类型正确。
 *
 * 说明：结构合规是**弱证据**（中转站可以照抄官方结构），因此权重只有 20，
 * 且只作为总评分的一部分；真正有指示力的是 thinking 签名与跨厂商泄漏。
 */
import { ActiveDetector, buildResult, safeText } from '../base.js';
import {
  buildChatRequest,
  failureOf,
  extractStopReason,
  extractUsage,
  bodyJsonOf,
  performRequest
} from '../protocol.js';

const OPENAI_FINISH_REASONS = new Set([
  'stop',
  'length',
  'tool_calls',
  'content_filter',
  'function_call'
]);

const ANTHROPIC_STOP_REASONS = new Set([
  'end_turn',
  'max_tokens',
  'stop_sequence',
  'tool_use',
  'pause_turn',
  'refusal'
]);

const isObject = (value) => Boolean(value) && typeof value === 'object';
const isNumber = (value) => typeof value === 'number' && Number.isFinite(value);

function check(id, ok, detail, evidence) {
  return { id, ok: Boolean(ok), detail, evidence: evidence ?? null };
}

/** OpenAI 协议结构检查。 */
function openaiChecks(payload, provider) {
  const choice = Array.isArray(payload.choices) ? payload.choices[0] : null;
  const message = choice?.message && typeof choice.message === 'object' ? choice.message : null;
  const usage = extractUsage(payload, provider);
  return [
    check('object', payload.object === 'chat.completion', 'object 应为 "chat.completion"', {
      object: payload.object ?? null
    }),
    check(
      'id',
      typeof payload.id === 'string' && payload.id.length > 0,
      'id 应为非空字符串',
      { id: typeof payload.id === 'string' ? payload.id.slice(0, 80) : null }
    ),
    check('choices', Array.isArray(payload.choices) && payload.choices.length > 0, 'choices 应为非空数组', {
      count: Array.isArray(payload.choices) ? payload.choices.length : null
    }),
    check('message_role', safeText(message?.role) === 'assistant', 'choices[0].message.role 应为 "assistant"', {
      role: safeText(message?.role) || null
    }),
    check(
      'finish_reason',
      OPENAI_FINISH_REASONS.has(safeText(extractStopReason(payload, 'openai'))),
      'finish_reason 应为官方枚举值',
      { finishReason: extractStopReason(payload, 'openai') }
    ),
    check(
      'usage',
      isNumber(usage.promptTokens) && isNumber(usage.completionTokens) && isNumber(usage.totalTokens),
      'usage 应同时包含数字型 prompt_tokens / completion_tokens / total_tokens',
      usage.raw || null
    )
  ];
}

/** Anthropic 协议结构检查。 */
function anthropicChecks(payload) {
  const content = Array.isArray(payload.content) ? payload.content : null;
  const usage = extractUsage(payload, 'anthropic');
  return [
    check('type', payload.type === 'message', 'type 应为 "message"', { type: payload.type ?? null }),
    check(
      'id',
      /^msg_[A-Za-z0-9_-]{6,}$/.test(safeText(payload.id)),
      'id 应符合 msg_ 前缀格式',
      { id: safeText(payload.id).slice(0, 80) || null }
    ),
    check('role', payload.role === 'assistant', 'role 应为 "assistant"', { role: payload.role ?? null }),
    check('content', Boolean(content && content.length > 0), 'content 应为非空数组', {
      blocks: content ? content.map((block) => safeText(block?.type)).slice(0, 10) : null
    }),
    check(
      'stop_reason',
      ANTHROPIC_STOP_REASONS.has(safeText(payload.stop_reason)),
      'stop_reason 应为官方枚举值',
      { stopReason: payload.stop_reason ?? null }
    ),
    check(
      'usage',
      isNumber(usage.promptTokens) && isNumber(usage.completionTokens),
      'usage 应包含数字型 input_tokens / output_tokens',
      usage.raw || null
    )
  ];
}

/** Gemini 协议结构检查。 */
function geminiChecks(payload) {
  const candidate = Array.isArray(payload.candidates) ? payload.candidates[0] : null;
  const parts = candidate?.content?.parts;
  const usage = extractUsage(payload, 'gemini');
  return [
    check('candidates', Array.isArray(payload.candidates) && payload.candidates.length > 0, 'candidates 应为非空数组', {
      count: Array.isArray(payload.candidates) ? payload.candidates.length : null
    }),
    check(
      'content_parts',
      Array.isArray(parts) && parts.length > 0,
      'candidates[0].content.parts 应为非空数组',
      { parts: Array.isArray(parts) ? parts.length : null }
    ),
    check(
      'finish_reason',
      Boolean(safeText(candidate?.finishReason)),
      '应包含 finishReason',
      { finishReason: candidate?.finishReason ?? null }
    ),
    check(
      'usage',
      isNumber(usage.promptTokens) && isNumber(usage.completionTokens) && isNumber(usage.totalTokens),
      'usageMetadata 应包含数字型 promptTokenCount / candidatesTokenCount / totalTokenCount',
      usage.raw || null
    )
  ];
}

export class ProtocolShapeDetector extends ActiveDetector {
  constructor() {
    super({
      name: 'protocol_shape',
      displayName: '响应协议结构',
      weight: 20,
      modes: ['quick', 'standard', 'full'],
      provider: [],
      critical: false,
      description: '检查 chat 响应的 id / object / choices / stop_reason / usage 等结构是否符合官方协议。'
    });
  }

  async run(ctx) {
    const startedAt = Date.now();
    const request = buildChatRequest(ctx, {
      purpose: 'protocol_shape',
      prompt: '请只回复 ok 两个英文字母，不要任何解释。',
      maxTokens: 16,
      temperature: 0
    });
    const exchange = await performRequest(ctx, request);
    const failure = failureOf(exchange);
    if (failure) {
      return buildResult(this, { ...failure, durationMs: Date.now() - startedAt });
    }

    const payload = bodyJsonOf(exchange) || {};
    let checks;
    if (ctx.provider === 'anthropic') checks = anthropicChecks(payload);
    else if (ctx.provider === 'gemini') checks = geminiChecks(payload);
    else checks = openaiChecks(payload, ctx.provider);

    const passed = checks.filter((item) => item.ok).length;
    const score = Math.round((passed / Math.max(1, checks.length)) * 100);
    return buildResult(this, {
      status: score >= 70 ? 'pass' : 'fail',
      score,
      details: {
        subChecks: checks,
        httpStatus: exchange.response?.status ?? null,
        model: ctx.model,
        expectedProtocol: ctx.provider,
        modelEcho: payload.model ?? null
      },
      durationMs: Date.now() - startedAt
    });
  }
}

export const protocolShape = new ProtocolShapeDetector();
export default protocolShape;
