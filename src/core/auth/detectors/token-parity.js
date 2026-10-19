/**
 * `token_parity`（契约 v2 §6.4）—— 主动检测器，权重 10，full 档，全协议。
 *
 * 与内置官方基线对齐 token 计数。⚠️ 设计取舍（LEARNINGS §3）：
 * 硬编码基线会随模型 / 分词器 / 系统提示词版本过期，过期基线会制造**假阳性**
 * （把正常模型误判为掉包）。因此本项目默认**没有**内置基线：
 *  - 无基线 → `skip`（reason: `no_baseline`），不进入加权分母、不扣分（契约 §6.4）；
 *  - 有基线 → 发一条与基线相同提示词的请求，比较 prompt/completion token 偏差。
 *
 * 基线必须由可信渠道（同一模型快照、同一提示词、官方 key 实测）产出，
 * 详见 `baselines.js` 的结构说明。
 */
import { ActiveDetector, buildResult } from '../base.js';
import { getBaseline } from '../baselines.js';
import {
  bodyJsonOf,
  buildChatRequest,
  extractUsage,
  failureOf,
  performRequest
} from '../protocol.js';

/** 基线未附带提示词时使用的通用校准题（稳定、低 token、答案确定）。 */
export const PARITY_PROMPT = 'Compute 19 * 23 and reply with only the integer.';

function deviationScore(actual, expected, tolerance) {
  if (typeof actual !== 'number' || typeof expected !== 'number' || !Number.isFinite(actual) || !Number.isFinite(expected)) {
    return { applicable: false, score: 0, diff: null, tolerance };
  }
  const diff = Math.abs(actual - expected);
  const tol = Math.max(1, Math.round(tolerance));
  if (diff <= tol) return { applicable: true, score: 100, diff, tolerance: tol };
  if (diff <= tol * 2 + 2) return { applicable: true, score: 60, diff, tolerance: tol };
  return { applicable: true, score: 20, diff, tolerance: tol };
}

export class TokenParityDetector extends ActiveDetector {
  constructor() {
    super({
      name: 'token_parity',
      displayName: '官方基线 Token 对齐',
      weight: 10,
      modes: ['full'],
      provider: [],
      critical: false,
      description: '与内置官方基线比较 token 计数偏差；没有基线时 skip，不扣分。'
    });
  }

  /** 有基线才视为适用；否则 skip（契约 §6.4）。 */
  appliesTo(ctx) {
    return Boolean(ctx && getBaseline(ctx.provider, ctx.model));
  }

  skipReason() {
    return 'no_baseline';
  }

  skipMessage(ctx) {
    return `没有「${ctx?.provider || '未知协议'} / ${ctx?.model || '未知模型'}」的内置官方基线，token_parity 已跳过（skip 不计入加权分母，不扣分）。`;
  }

  /** 估计请求数：仅当存在基线时发 1 条。 */
  estimatedRequests(ctx) {
    return this.appliesTo(ctx) ? 1 : 0;
  }

  async run(ctx) {
    const startedAt = Date.now();
    const baseline = getBaseline(ctx.provider, ctx.model);
    if (!baseline) {
      return buildResult(this, {
        status: 'skip',
        score: 0,
        reason: 'no_baseline',
        details: {
          reason: 'no_baseline',
          message: this.skipMessage(ctx),
          baselineVersion: null
        }
      });
    }
    if (typeof baseline.promptTokens !== 'number') {
      return buildResult(this, {
        status: 'skip',
        score: 0,
        reason: 'no_baseline',
        details: {
          reason: 'no_baseline',
          message: '内置基线缺少 promptTokens 字段，无法比较，已跳过。'
        }
      });
    }

    const prompt = typeof baseline.prompt === 'string' && baseline.prompt.trim() ? baseline.prompt : PARITY_PROMPT;
    const exchange = await performRequest(
      ctx,
      buildChatRequest(ctx, {
        purpose: 'token_parity',
        prompt,
        maxTokens: 32,
        temperature: 0
      })
    );
    const failure = failureOf(exchange);
    if (failure) {
      return buildResult(this, { ...failure, durationMs: Date.now() - startedAt });
    }

    const payload = bodyJsonOf(exchange) || {};
    const usage = extractUsage(payload, ctx.provider);
    const tolerance = baseline.tolerance && typeof baseline.tolerance === 'object' ? baseline.tolerance : {};
    const promptCheck = deviationScore(
      usage.promptTokens,
      baseline.promptTokens,
      typeof tolerance.promptTokens === 'number' ? tolerance.promptTokens : 2
    );
    const completionCheck = deviationScore(
      usage.completionTokens,
      baseline.completionTokens,
      typeof tolerance.completionTokens === 'number' ? tolerance.completionTokens : 2
    );

    const applicable = [promptCheck, completionCheck].filter((item) => item.applicable);
    const score =
      applicable.length > 0
        ? Math.round(applicable.reduce((sum, item) => sum + item.score, 0) / applicable.length)
        : 0;

    return buildResult(this, {
      status: score >= 70 ? 'pass' : 'fail',
      score,
      details: {
        subChecks: [
          {
            id: 'prompt_tokens_parity',
            ok: promptCheck.applicable && promptCheck.score >= 70,
            detail: promptCheck.applicable
              ? `prompt_tokens 实际 ${usage.promptTokens}，基线 ${baseline.promptTokens}，差值 ${promptCheck.diff}（容差 ${promptCheck.tolerance}）。`
              : '上游未返回 prompt_tokens，无法与基线比较。',
            evidence: { actual: usage.promptTokens, expected: baseline.promptTokens, diff: promptCheck.diff }
          },
          {
            id: 'completion_tokens_parity',
            ok: completionCheck.applicable && completionCheck.score >= 70,
            detail: completionCheck.applicable
              ? `completion_tokens 实际 ${usage.completionTokens}，基线 ${baseline.completionTokens}，差值 ${completionCheck.diff}（容差 ${completionCheck.tolerance}）。`
              : '上游未返回 completion_tokens，无法与基线比较。',
            evidence: {
              actual: usage.completionTokens,
              expected: baseline.completionTokens,
              diff: completionCheck.diff
            }
          }
        ],
        baseline: {
          promptTokens: baseline.promptTokens,
          completionTokens: baseline.completionTokens,
          tolerance,
          source: baseline.source ?? null,
          measuredAt: baseline.measuredAt ?? null
        },
        promptUsed: prompt,
        model: ctx.model,
        httpStatus: exchange.response?.status ?? null
      },
      durationMs: Date.now() - startedAt
    });
  }
}

export const tokenParity = new TokenParityDetector();
export default tokenParity;
