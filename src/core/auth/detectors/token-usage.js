/**
 * `token_usage`（契约 v2 §6.4）—— 主动检测器，权重 10，standard+，全协议。
 *
 * 检查 usage 的**自洽性**（不依赖官方基线，因此不会因基线过期而误报）：
 *  1. 字符/token 比 ∈ [1.2, 10]：一个中文字符约 1 token、英文单词约 1.3 token、
 *     ASCII 文本通常 3–5 字符/token。比例严重越界说明 usage 是编造的或按别的模型算的。
 *  2. `completion_tokens` 不得超过请求的 `max_tokens`。
 *  3. `total = prompt + completion` 必须自洽（Gemini 还要把 thoughts token 计入）。
 *
 * 三项等权：任一项失败 → 33/100 → 不及格（status: fail）。这是刻意的：
 * 1/3 的检查失败已足够说明 usage 不可信。
 */
import { ActiveDetector, buildResult } from '../base.js';
import {
  bodyJsonOf,
  buildChatRequest,
  extractAssistantText,
  extractUsage,
  failureOf,
  performRequest
} from '../protocol.js';

/** 用 ASCII 提示词，字符/token 比才有稳定的预期区间（中文的字符/token 比受分词器影响大）。 */
export const TOKEN_USAGE_PROMPT =
  'Output only the integers from 1 to 20, separated by commas, with no other text.';

export const TOKEN_USAGE_MAX_TOKENS = 128;

const CHAR_TOKEN_MIN = 1.2;
const CHAR_TOKEN_MAX = 10;

const finite = (value) => typeof value === 'number' && Number.isFinite(value);

function round(value, digits = 3) {
  const factor = 10 ** digits;
  return Math.round(value * factor) / factor;
}

export class TokenUsageDetector extends ActiveDetector {
  constructor() {
    super({
      name: 'token_usage',
      displayName: 'Token 用量自洽性',
      weight: 10,
      modes: ['standard', 'full'],
      provider: [],
      critical: false,
      description: '检查字符/token 比、completion 是否超 max_tokens、total 是否等于 prompt+completion。'
    });
  }

  async run(ctx) {
    const startedAt = Date.now();
    const request = buildChatRequest(ctx, {
      purpose: 'token_usage',
      prompt: TOKEN_USAGE_PROMPT,
      maxTokens: TOKEN_USAGE_MAX_TOKENS,
      temperature: 0
    });
    const exchange = await performRequest(ctx, request);
    const failure = failureOf(exchange);
    if (failure) {
      return buildResult(this, { ...failure, durationMs: Date.now() - startedAt });
    }

    const payload = bodyJsonOf(exchange) || {};
    const usage = extractUsage(payload, ctx.provider);
    const text = extractAssistantText(payload, ctx.provider);
    const completionTokens = usage.completionTokens;
    const promptTokens = usage.promptTokens;
    const totalTokens = usage.totalTokens;

    // 1) 字符/token 比
    const completionRatio = finite(completionTokens) && completionTokens > 0 ? text.length / completionTokens : null;
    const promptRatio = finite(promptTokens) && promptTokens > 0 ? TOKEN_USAGE_PROMPT.length / promptTokens : null;
    const ratioOk =
      completionRatio != null && completionRatio >= CHAR_TOKEN_MIN && completionRatio <= CHAR_TOKEN_MAX;

    // 2) completion 不得超过 max_tokens
    const maxTokensOk = finite(completionTokens) && completionTokens <= TOKEN_USAGE_MAX_TOKENS;

    // 3) total 自洽（按协议口径）
    let totalOk = false;
    let totalDetail = '';
    let expectedTotal = null;
    if (finite(promptTokens) && finite(completionTokens)) {
      if (ctx.provider === 'gemini') {
        const thoughts = finite(usage.thoughtsTokens) ? usage.thoughtsTokens : 0;
        expectedTotal = promptTokens + completionTokens + thoughts;
        totalOk = !finite(totalTokens) || Math.abs(totalTokens - expectedTotal) <= 1;
        totalDetail = `Gemini 口径：totalTokenCount 应 ≈ prompt ${promptTokens} + candidates ${completionTokens} + thoughts ${thoughts} = ${expectedTotal}（容差 ±1）。`;
      } else {
        expectedTotal = promptTokens + completionTokens;
        totalOk =
          !finite(totalTokens) ||
          Math.abs(totalTokens - expectedTotal) <= (ctx.provider === 'anthropic' ? 1 : 0);
        totalDetail = `total 应等于 prompt ${promptTokens} + completion ${completionTokens} = ${expectedTotal}。`;
      }
    } else {
      totalDetail = '上游未返回完整的 prompt / completion token 计数，无法判断 total 自洽性。';
    }

    const checks = [
      {
        id: 'char_token_ratio',
        ok: ratioOk,
        detail: ratioOk
          ? `字符/token 比 ${round(completionRatio)}，落在 ${CHAR_TOKEN_MIN}–${CHAR_TOKEN_MAX} 内。`
          : completionRatio == null
            ? '上游未返回可用的 completion_tokens，无法计算字符/token 比。'
            : `字符/token 比 ${round(completionRatio)} 越界（期望 ${CHAR_TOKEN_MIN}–${CHAR_TOKEN_MAX}），usage 可能按别的模型/编造。`,
        evidence: {
          completionChars: text.length,
          completionTokens,
          ratio: completionRatio == null ? null : round(completionRatio),
          bounds: [CHAR_TOKEN_MIN, CHAR_TOKEN_MAX],
          promptChars: TOKEN_USAGE_PROMPT.length,
          promptTokens,
          promptRatio: promptRatio == null ? null : round(promptRatio)
        }
      },
      {
        id: 'completion_within_max_tokens',
        ok: maxTokensOk,
        detail: maxTokensOk
          ? `completion_tokens ${completionTokens} ≤ max_tokens ${TOKEN_USAGE_MAX_TOKENS}。`
          : `completion_tokens ${completionTokens ?? '缺失'} 超过请求的 max_tokens ${TOKEN_USAGE_MAX_TOKENS}（usage 不可信）。`,
        evidence: { completionTokens, maxTokens: TOKEN_USAGE_MAX_TOKENS }
      },
      {
        id: 'total_self_consistent',
        ok: totalOk,
        detail: totalOk
          ? `token 总数自洽（total=${totalTokens ?? expectedTotal}）。`
          : `${totalDetail} 实际 total=${totalTokens ?? '缺失'}。`,
        evidence: {
          promptTokens,
          completionTokens,
          thoughtsTokens: usage.thoughtsTokens,
          totalTokens,
          expectedTotal
        }
      }
    ];

    const passed = checks.filter((item) => item.ok).length;
    const score = Math.round((passed / checks.length) * 100);

    return buildResult(this, {
      status: score >= 70 ? 'pass' : 'fail',
      score,
      details: {
        subChecks: checks,
        vendor: usage.vendor,
        rawUsage: usage.raw,
        promptTextChars: TOKEN_USAGE_PROMPT.length,
        completionTextChars: text.length,
        model: ctx.model,
        httpStatus: exchange.response?.status ?? null
      },
      durationMs: Date.now() - startedAt
    });
  }
}

export const tokenUsage = new TokenUsageDetector();
export default tokenUsage;
