/**
 * `thinking_signature`（契约 v2 §6.4）—— 主动检测器，权重 **25**，standard+，仅 Anthropic。
 *
 * 这是整套真伪检测里最强的单点证据（见 LEARNINGS §2.4）：
 * Claude 开启 extended / adaptive thinking 时，响应 `content[]` 里的 `thinking` 块
 * 会带一个由 Anthropic 服务端私钥产生的 `signature`。Bedrock 简化接口（Kiro / Amazon Q
 * 走的那条路）与「用别的模型冒充 Claude」的中转站**拿不到**这个签名。
 *
 * 源码级踩坑点（必须按此实现，否则会大量误报）：
 *  1. **必须非流式**：`stream: true` + adaptive + `display: 'summarized'` 时会静默丢弃 thinking 块。
 *  2. `thinking: { type: 'enabled', budget_tokens: 2000 }`；
 *     新模型用 `{ type: 'adaptive', display: 'summarized' }`，且 effort 是**独立顶层字段**
 *     `output_config.effort`（放进 thinking 里会 400）。
 *  3. `max_tokens` 给足（16000）：太小模型会为了塞下而直接跳过思考。
 *  4. 探针用「多步欧几里得 GCD(2378, 1547)」这类需要真正推理的题，
 *     不要用官方文档里的 1071/462 示例（避免中转站对固定题面特判）。
 *  5. 评分：无 thinking 块 = 0；有块无签名 = 30；签名 < 50 字符 = 70；正常 = 100。
 */
import { ActiveDetector, buildResult, safeText } from '../base.js';
import {
  bodyJsonOf,
  buildChatRequest,
  extractThinking,
  failureOf,
  performRequest
} from '../protocol.js';

/** 多步欧几里得 GCD 探针（刻意避开官方文档的 1071/462）。 */
export const THINKING_PROBE_PROMPT =
  '请用不跳步的欧几里得算法计算 gcd(2378, 1547)。要求：每一步都写成「a = q × b + r」的形式，' +
  '最后单独一行只输出最终的最大公约数整数。';

/** thinking budget（契约 / LEARNINGS 指定）。 */
export const THINKING_BUDGET_TOKENS = 2000;
/** max_tokens 必须给足，否则模型会跳过思考。 */
export const THINKING_MAX_TOKENS = 16000;
/** 正常签名的长度下限（实测真实签名 500–2000+ 字符）。 */
export const SIGNATURE_MIN_LENGTH = 50;

/**
 * v2.1：签名缺失属于 **critical**（critical 一票降级，见契约 §6.2 / §6.3 的机制）。
 *
 * 为什么不是普通扣分（见 docs/AUTH-NOTES.md §4.4 / §9）：
 *  - thinking 签名由 Anthropic 服务端私钥产生，是「加密级」证据；
 *    **真实 Anthropic 实现在开启 thinking 时必然返回签名**。
 *  - 拿不到签名意味着上游不是真实 Anthropic 实现（Kiro / Amazon Q / Bedrock
 *    简化通道，或中转层把签名剥离了），这不是「质量略差」，而是「模型被掉包」。
 *  - 在加权平均里，这条 25% 权重的证据会被 7 条 100 分的廉价结构项淹没
 *    （实测：kiro 场景 73.9 分 → passed），必须用 critical 一票降级兜住。
 *  - 但「签名过短（70 分）」只扣分、不 critical：那是弱证据，可能是截断/格式差异。
 */
export const MISSING_SIGNATURE_CRITICAL_CODE = 'missing_thinking_signature';

const MISSING_SIGNATURE_MESSAGE =
  '拿不到 Claude 服务端 thinking 签名，上游不是真实 Anthropic 实现（可能是 Kiro/Amazon Q/Bedrock 简化通道或签名被剥离）';

/**
 * 构造「签名缺失」critical 问题（契约 v2.1 固定 code / message / evidence 四字段）。
 *
 * @param {{score:number, thinkingBlockSeen:boolean, signatureReceived:boolean,
 *          signatureLength:number, extra?:object}} input
 */
export function missingSignatureCritical(input = {}) {
  const evidence = {
    score: Number.isFinite(input.score) ? input.score : 0,
    thinkingBlockSeen: input.thinkingBlockSeen === true,
    signatureReceived: input.signatureReceived === true,
    signatureLength: Number.isFinite(input.signatureLength) ? input.signatureLength : 0
  };
  if (input.extra && typeof input.extra === 'object') Object.assign(evidence, input.extra);
  return {
    code: MISSING_SIGNATURE_CRITICAL_CODE,
    message: MISSING_SIGNATURE_MESSAGE,
    evidence
  };
}

function preview(value, max = 160) {
  const text = safeText(value);
  return text.length > max ? `${text.slice(0, max)}…` : text;
}

/**
 * 按「有无块 / 有无签名 / 签名长度」给 thinking 签名打分（契约冻结的四档）。
 *
 * @param {{blocks:Array<object>, signatures:string[], redactedCount:number}} thinking
 * @returns {{score:number, hasBlock:boolean, signature:string, signatureLength:number, tier:string}}
 */
export function scoreThinkingBlocks(thinking) {
  const blocks = Array.isArray(thinking?.blocks) ? thinking.blocks : [];
  const signatures = Array.isArray(thinking?.signatures) ? [...thinking.signatures] : [];
  signatures.sort((a, b) => b.length - a.length);
  const signature = safeText(signatures[0]);
  const hasBlock = blocks.length > 0;
  const signatureLength = signature.length;
  let score;
  let tier;
  if (!hasBlock) {
    score = 0;
    tier = 'no_thinking_block';
  } else if (!signature) {
    score = 30;
    tier = 'block_without_signature';
  } else if (signatureLength < SIGNATURE_MIN_LENGTH) {
    score = 70;
    tier = 'signature_too_short';
  } else {
    score = 100;
    tier = 'signature_ok';
  }
  return { score, hasBlock, signature, signatureLength, tier };
}

export class ThinkingSignatureDetector extends ActiveDetector {
  constructor() {
    super({
      name: 'thinking_signature',
      displayName: 'Claude 思维签名验证',
      weight: 25,
      modes: ['standard', 'full'],
      provider: ['anthropic'],
      // 契约 v2.1 §6.4：critical 列改为「是（仅缺失签名时）」——
      // 仅当 status=fail 且 score<=30 时产出 criticalIssues；签名过短(70)/skip 绝不产出。
      critical: true,
      description: '用非流式 thinking 请求检查 Claude 服务端签名（无块=0 / 无签名=30 / 过短=70 / 正常=100）。'
    });
  }

  /** 只有「协议是 Anthropic 且模型明确支持 thinking」时才跑；否则 skip，不拉低总分。 */
  appliesTo(ctx) {
    return Boolean(ctx && ctx.provider === 'anthropic' && ctx.modelInfo && ctx.modelInfo.thinking);
  }

  skipReason(ctx) {
    if (!ctx || ctx.provider !== 'anthropic') return 'provider_not_applicable';
    if (!ctx.modelInfo) return 'unknown_model';
    return 'model_capability_missing';
  }

  skipMessage(ctx) {
    if (!ctx || ctx.provider !== 'anthropic') {
      return '该检测器仅适用于 Anthropic Claude 协议，已跳过。';
    }
    if (!ctx.modelInfo) {
      return `模型「${safeText(ctx.model)}」不在内置模型能力表中，无法确认是否支持 thinking，已跳过签名验证（skip 不计入加权分母）。`;
    }
    return `模型「${safeText(ctx.modelInfo.id)}」不支持 extended / adaptive thinking，跳过签名验证（skip 不计入加权分母，不会拉低总分）。`;
  }

  async run(ctx) {
    const startedAt = Date.now();
    const info = ctx.modelInfo || {};
    const adaptive = info.adaptive === true || info.thinking === 'adaptive';
    const thinkingParam = adaptive
      ? { type: 'adaptive', display: 'summarized' }
      : { type: 'enabled', budget_tokens: THINKING_BUDGET_TOKENS };
    const patch = { thinking: thinkingParam };
    // ⚠️ effort 是**顶层** output_config.effort，放进 thinking 会 400
    if (adaptive) patch.output_config = { effort: 'high' };

    const request = buildChatRequest(ctx, {
      purpose: 'thinking_signature',
      prompt: THINKING_PROBE_PROMPT,
      maxTokens: THINKING_MAX_TOKENS,
      // thinking 开启时不能传 temperature；必须非流式（streaming + adaptive 会丢 thinking 块）
      temperature: null,
      stream: false,
      patch
    });

    const exchange = await performRequest(ctx, request);
    const failure = failureOf(exchange);
    if (failure) {
      const errorText = `${safeText(failure.error)} ${safeText(exchange?.response?.bodyText)}`;
      const thinkingRejected =
        !failure.details?.fatal &&
        /thinking|budget_tokens|budget tokens|output_config|effort|adaptive/i.test(errorText);
      if (thinkingRejected) {
        // 模型能力表说它支持 thinking，但上游拒绝了 thinking 参数：
        // 对被声明支持的模型，这是明显的「不是真模型 / 中转层改写了请求」信号。
        // v2.1：拿不到签名（含请求被拒）→ critical，verdict 封顶 marginal。
        return buildResult(this, {
          status: 'fail',
          score: 0,
          error: failure.error,
          criticalIssues: [
            missingSignatureCritical({
              score: 0,
              thinkingBlockSeen: false,
              signatureReceived: false,
              signatureLength: 0,
              extra: {
                requestRejected: true,
                httpStatus: exchange?.response?.status ?? null
              }
            })
          ],
          details: {
            ...failure.details,
            httpStatus: exchange?.response?.status ?? null,
            nonStreaming: true,
            thinkingMode: adaptive ? 'adaptive' : 'extended',
            requestParams: { thinking: thinkingParam, max_tokens: THINKING_MAX_TOKENS, output_config: patch.output_config ?? null },
            thinkingRejected: true,
            subChecks: [
              {
                id: 'thinking_request_accepted',
                ok: false,
                detail: '上游拒绝了 thinking 参数（被声明支持的模型不应如此），疑似中转层改写了请求或不支持该能力。',
                evidence: { error: preview(failure.error, 300) }
              }
            ]
          },
          durationMs: Date.now() - startedAt
        });
      }
      return buildResult(this, {
        ...failure,
        details: {
          ...failure.details,
          nonStreaming: true,
          thinkingMode: adaptive ? 'adaptive' : 'extended'
        },
        durationMs: Date.now() - startedAt
      });
    }

    const payload = bodyJsonOf(exchange) || {};
    const thinking = extractThinking(payload);
    const scored = scoreThinkingBlocks(thinking);
    const signature = scored.signature;

    const subChecks = [
      {
        id: 'non_streaming_request',
        ok: true,
        detail: '使用非流式请求（streaming + adaptive 会静默丢弃 thinking 块，无法验证签名）。',
        evidence: { stream: false }
      },
      {
        id: 'request_params',
        ok: true,
        detail: adaptive
          ? '使用 adaptive thinking + 顶层 output_config.effort。'
          : '使用 thinking: { type: "enabled", budget_tokens: 2000 }。',
        evidence: {
          thinking: thinkingParam,
          max_tokens: THINKING_MAX_TOKENS,
          output_config: patch.output_config ?? null
        }
      },
      {
        id: 'thinking_block_present',
        ok: scored.hasBlock,
        detail: scored.hasBlock
          ? '响应包含 thinking / redacted_thinking 块。'
          : '响应不含任何 thinking 块（Kiro / Amazon Q 等简化接口的典型特征）。',
        evidence: {
          blockTypes: Array.isArray(payload.content)
            ? payload.content.map((block) => safeText(block?.type)).slice(0, 20)
            : [],
          redactedCount: thinking.redactedCount
        }
      },
      {
        id: 'signature_present',
        ok: Boolean(signature),
        detail: signature
          ? 'thinking 块包含服务端签名。'
          : 'thinking 块存在但没有 signature 字段（可能是中转层丢弃了签名）。',
        evidence: { signatureLength: scored.signatureLength }
      },
      {
        id: 'signature_length',
        ok: scored.signatureLength >= SIGNATURE_MIN_LENGTH,
        detail:
          scored.signatureLength >= SIGNATURE_MIN_LENGTH
            ? `签名长度 ${scored.signatureLength} 字符，符合真实签名特征（实测 500–2000+）。`
            : `签名长度仅 ${scored.signatureLength} 字符（< ${SIGNATURE_MIN_LENGTH}），疑似伪造或被截断。`,
        evidence: { signatureLength: scored.signatureLength, threshold: SIGNATURE_MIN_LENGTH }
      }
    ];

    // v2.1：status=fail 且 score<=30（无 thinking 块=0 / 有块无签名=30）
    // ⇒ 完全拿不到服务端签名 ⇒ critical 一票降级（70 分的「签名过短」不算）。
    const missingSignature = scored.score <= 30;
    const criticalIssues = missingSignature
      ? [
          missingSignatureCritical({
            score: scored.score,
            thinkingBlockSeen: scored.hasBlock,
            signatureReceived: Boolean(signature),
            signatureLength: scored.signatureLength
          })
        ]
      : [];

    return buildResult(this, {
      status: scored.score >= 70 ? 'pass' : 'fail',
      score: scored.score,
      criticalIssues,
      details: {
        subChecks,
        tier: scored.tier,
        signatureMissingCritical: missingSignature,
        signatureLength: scored.signatureLength,
        signaturePreview: signature ? preview(signature, 24) : '',
        thinkingTextLength: thinking.thinkingText.length,
        thinkingTextPreview: preview(thinking.thinkingText, 200),
        thinkingBlockCount: thinking.blocks.length,
        redactedThinkingCount: thinking.redactedCount,
        nonStreaming: true,
        thinkingMode: adaptive ? 'adaptive' : 'extended',
        model: ctx.model,
        httpStatus: exchange.response?.status ?? null
      },
      durationMs: Date.now() - startedAt
    });
  }
}

export const thinkingSignature = new ThinkingSignatureDetector();
export default thinkingSignature;
