/**
 * `capability_tools`（契约 v2 §6.4）—— 主动检测器，权重 10，standard+，全协议。
 *
 * 用一次真实的 tool / function calling 请求，验证工具调用是否**真正生效**：
 *  - 响应里是否出现结构正确的 tool_calls / tool_use / functionCall；
 *  - 工具名与参数是否符合要求（`add_numbers(2378, 1547)`）；
 *  - 工具调用 id 是否带官方前缀（Anthropic `toolu_`、OpenAI `call_`）。
 *
 * 假的「文本模型冒充工具模型」通常只能返回一段自然语言，拿不出结构化调用。
 * 模型能力表说 supportsTools === false，或完全查不到模型时，直接 skip（不扣分）。
 */
import { ActiveDetector, buildResult, safeText } from '../base.js';
import {
  bodyJsonOf,
  buildChatRequest,
  extractToolCalls,
  failureOf,
  performRequest
} from '../protocol.js';

export const TOOL_PROMPT = '请调用 add_numbers 工具计算 2378 + 1547，不要自己心算。';
export const TOOL_NAME = 'add_numbers';

const TOOL_WEIGHTS = { present: 40, name: 30, arguments: 20, id: 10 };

function addNumbersSchema() {
  return {
    type: 'object',
    properties: { a: { type: 'number' }, b: { type: 'number' } },
    required: ['a', 'b']
  };
}

/** 构造各协议的工具定义。 */
export function toolsPatch(provider) {
  if (provider === 'anthropic') {
    return {
      tools: [
        {
          name: TOOL_NAME,
          description: '计算两个数字之和',
          input_schema: addNumbersSchema()
        }
      ],
      tool_choice: { type: 'tool', name: TOOL_NAME }
    };
  }
  if (provider === 'gemini') {
    return {
      tools: [
        {
          functionDeclarations: [
            {
              name: TOOL_NAME,
              description: '计算两个数字之和',
              parameters: {
                type: 'OBJECT',
                properties: { a: { type: 'NUMBER' }, b: { type: 'NUMBER' } },
                required: ['a', 'b']
              }
            }
          ]
        }
      ],
      toolConfig: { functionCallingConfig: { mode: 'ANY', allowedFunctionNames: [TOOL_NAME] } }
    };
  }
  return {
    tools: [
      {
        type: 'function',
        function: {
          name: TOOL_NAME,
          description: '计算两个数字之和',
          parameters: addNumbersSchema()
        }
      }
    ],
    tool_choice: { type: 'function', function: { name: TOOL_NAME } }
  };
}

/** 判断工具参数是否是 (2378, 1547)（顺序可交换）。 */
export function argumentsMatch(args) {
  if (!args || typeof args !== 'object') return false;
  const a = Number(args.a);
  const b = Number(args.b);
  if (!Number.isFinite(a) || !Number.isFinite(b)) return false;
  return (a === 2378 && b === 1547) || (a === 1547 && b === 2378);
}

/** 校验工具调用 id 前缀；Gemini 的 functionCall 通常没有 id（视为 N/A）。 */
export function toolCallIdCheck(provider, call) {
  if (!call) return { applicable: false, ok: true, detail: '未提供工具调用信息。' };
  const id = safeText(call.id);
  if (provider === 'gemini') {
    if (!id) return { applicable: false, ok: true, detail: 'Gemini functionCall 通常不返回 id，跳过前缀检查。' };
    return { applicable: true, ok: true, detail: 'functionCall 带 id。' };
  }
  if (!id) {
    return { applicable: true, ok: false, detail: '工具调用缺少 id 字段。' };
  }
  if (provider === 'anthropic') {
    const ok = /^toolu_[A-Za-z0-9_-]{4,}$/.test(id) || /^srvtoolu_[A-Za-z0-9_-]{4,}$/.test(id);
    return {
      applicable: true,
      ok,
      detail: ok ? 'tool_use id 符合 toolu_ 前缀。' : `tool_use id 缺少 toolu_ 前缀（实际 "${id.slice(0, 64)}"）。`
    };
  }
  const ok = id.length > 0;
  return { applicable: true, ok, detail: ok ? 'tool_calls 带非空 id。' : 'tool_calls 缺少 id。' };
}

export class CapabilityToolsDetector extends ActiveDetector {
  constructor() {
    super({
      name: 'capability_tools',
      displayName: '工具调用能力',
      weight: 10,
      modes: ['standard', 'full'],
      provider: [],
      critical: false,
      description: '发送真实工具定义，验证响应是否返回结构正确的 tool_calls / tool_use / functionCall。'
    });
  }

  /** 未知模型 / 明确不支持工具的模型 → skip，不拉低总分。 */
  appliesTo(ctx) {
    if (!ctx) return false;
    if (!ctx.modelInfo) return false;
    return ctx.modelInfo.supportsTools !== false;
  }

  skipReason(ctx) {
    if (!ctx?.modelInfo) return 'unknown_model';
    return 'model_capability_missing';
  }

  skipMessage(ctx) {
    if (!ctx?.modelInfo) {
      return `模型「${safeText(ctx?.model)}」不在内置模型能力表中，无法确认是否支持工具调用，已跳过（skip 不计入加权分母）。`;
    }
    return `模型「${safeText(ctx.modelInfo.id)}」不支持工具调用，已跳过（skip 不计入加权分母，不会拉低总分）。`;
  }

  async run(ctx) {
    const startedAt = Date.now();
    const request = buildChatRequest(ctx, {
      purpose: 'capability_tools',
      prompt: TOOL_PROMPT,
      maxTokens: 256,
      temperature: 0,
      patch: toolsPatch(ctx.provider)
    });
    const exchange = await performRequest(ctx, request);
    const failure = failureOf(exchange);
    if (failure) {
      return buildResult(this, { ...failure, durationMs: Date.now() - startedAt });
    }

    const payload = bodyJsonOf(exchange) || {};
    const toolInfo = extractToolCalls(payload, ctx.provider);
    const call = toolInfo.calls[0] || null;
    const nameOk = Boolean(call && call.name === TOOL_NAME);
    const argsOk = Boolean(call && argumentsMatch(call.args));
    const idCheck = toolCallIdCheck(ctx.provider, call);

    let structureOk = toolInfo.found;
    if (call && ctx.provider === 'openai') {
      const choice = Array.isArray(payload.choices) ? payload.choices[0] : null;
      const rawCall = Array.isArray(choice?.message?.tool_calls) ? choice.message.tool_calls[0] : null;
      structureOk = Boolean(rawCall) && rawCall.type === 'function';
    }

    let passedWeight = 0;
    let applicableWeight = 0;
    const subChecks = [];
    const addCheck = (id, weight, applicable, ok, detail, evidence) => {
      subChecks.push({ id, ok: Boolean(ok), detail, evidence: evidence ?? null });
      if (!applicable) return;
      applicableWeight += weight;
      if (ok) passedWeight += weight;
    };

    addCheck(
      'tool_call_present',
      TOOL_WEIGHTS.present,
      true,
      toolInfo.found,
      toolInfo.found ? '响应包含结构化工具调用。' : '响应没有任何工具调用结构（疑似纯文本模型冒充）。',
      { rawFound: toolInfo.found, callCount: toolInfo.calls.length }
    );
    addCheck('tool_call_structure', 0, false, structureOk, structureOk ? '工具调用结构符合协议。' : '工具调用结构不符合协议。', null);
    addCheck(
      'tool_name',
      TOOL_WEIGHTS.name,
      true,
      nameOk,
      nameOk ? `工具名为 ${TOOL_NAME}。` : `工具名不是 ${TOOL_NAME}（实际 "${safeText(call?.name) || '无'}"）。`,
      { expected: TOOL_NAME, actual: call?.name ?? null }
    );
    addCheck(
      'tool_arguments',
      TOOL_WEIGHTS.arguments,
      true,
      argsOk,
      argsOk
        ? '工具参数正确（2378, 1547）。'
        : '工具参数缺失或数值不对（期望 a/b = 2378/1547）。',
      { expected: { a: 2378, b: 1547 }, actual: call?.args ?? null, argumentsText: safeText(call?.argumentsText).slice(0, 200) }
    );
    addCheck('tool_call_id', TOOL_WEIGHTS.id, idCheck.applicable, idCheck.ok, idCheck.detail, {
      id: call?.id ?? null
    });

    const score = applicableWeight > 0 ? Math.round((passedWeight / applicableWeight) * 100) : 0;

    return buildResult(this, {
      status: score >= 70 ? 'pass' : 'fail',
      score,
      details: {
        subChecks,
        toolFound: toolInfo.found,
        toolName: call?.name ?? null,
        toolArguments: call?.args ?? null,
        toolCallId: call?.id ?? null,
        provider: ctx.provider,
        model: ctx.model,
        finishReason: safeText(payload?.choices?.[0]?.finish_reason) || safeText(payload?.stop_reason) || null,
        httpStatus: exchange.response?.status ?? null
      },
      durationMs: Date.now() - startedAt
    });
  }
}

export const capabilityTools = new CapabilityToolsDetector();
export default capabilityTools;
