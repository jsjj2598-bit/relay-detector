/**
 * `model_consistency`（契约 v2 §6.4）—— 主动检测器，权重 15，quick+，全协议。
 *
 * 两项检查：
 *  1. **model 回显一致性**：响应里的 `model` 必须与请求的模型一致（允许日期后缀）。
 *     中转站「挂羊头卖狗肉」时经常回显另一个模型名，或干脆不回显模型。
 *  2. **确定性稳定性**：同一提示词、`temperature: 0` 连发 3 次，
 *     统计 `completion_tokens` 的变异系数 CV = 标准差 / 均值。
 *     真模型在同一输入下输出长度应高度稳定；CV 异常偏大说明上游在轮换模型 / 截断输出。
 *
 * 评分：model 回显不符 → 直接 0 分（这是硬证据）；回显一致再按 CV 加减分。
 */
import { ActiveDetector, buildResult } from '../base.js';
import {
  buildChatRequest,
  bodyJsonOf,
  extractAssistantText,
  extractModelEcho,
  extractUsage,
  failureOf,
  modelEchoMatches,
  performRequest
} from '../protocol.js';

const SAMPLES = 3;
const PROMPT = '请用一句话说明「质数」的数学定义，不要举例。';

/** 计算变异系数 CV（总体标准差 / 均值）；样本不足或均值为 0 时返回 null。 */
export function coefficientOfVariation(values) {
  const list = (Array.isArray(values) ? values : []).filter(
    (value) => typeof value === 'number' && Number.isFinite(value)
  );
  if (list.length < 2) return null;
  const mean = list.reduce((sum, value) => sum + value, 0) / list.length;
  if (!(mean > 0)) return null;
  const variance = list.reduce((sum, value) => sum + (value - mean) ** 2, 0) / list.length;
  return Math.sqrt(variance) / mean;
}

function round(value, digits = 4) {
  const factor = 10 ** digits;
  return Math.round(value * factor) / factor;
}

export class ModelConsistencyDetector extends ActiveDetector {
  constructor() {
    super({
      name: 'model_consistency',
      displayName: '模型回显与输出稳定性',
      weight: 15,
      modes: ['quick', 'standard', 'full'],
      provider: [],
      critical: false,
      description: '检查响应 model 字段是否回显请求模型，并用 3 次 temperature=0 请求统计 completion_tokens 变异系数。'
    });
  }

  async run(ctx) {
    const startedAt = Date.now();
    const samples = [];
    let firstFailure = null;

    for (let index = 0; index < SAMPLES; index += 1) {
      let exchange;
      try {
        exchange = await performRequest(
          ctx,
          buildChatRequest(ctx, {
            purpose: 'model_consistency',
            prompt: PROMPT,
            maxTokens: 64,
            temperature: 0
          })
        );
      } catch (error) {
        if (error && error.code === 'request_budget_exhausted') throw error;
        firstFailure = {
          status: 'error',
          score: 0,
          error: `请求异常：${error?.message || String(error)}`,
          details: { reason: 'exception' }
        };
        break;
      }
      const failure = failureOf(exchange);
      if (failure) {
        firstFailure = firstFailure || failure;
        // 致命错误（余额 / 模型不存在）或传输错误：继续发请求没有意义，直接停止
        if (failure.details?.fatal || failure.details?.reason === 'transport_error') break;
        break;
      }
      const payload = bodyJsonOf(exchange) || {};
      const usage = extractUsage(payload, ctx.provider);
      samples.push({
        index,
        modelEcho: extractModelEcho(payload),
        completionTokens: usage.completionTokens,
        promptTokens: usage.promptTokens,
        textLength: extractAssistantText(payload, ctx.provider).length,
        id: typeof payload.id === 'string' ? payload.id : ''
      });
    }

    if (samples.length === 0) {
      return buildResult(this, {
        ...(firstFailure || {
          status: 'error',
          score: 0,
          error: '未拿到任何可用响应。',
          details: { reason: 'no_sample' }
        }),
        durationMs: Date.now() - startedAt
      });
    }

    // 1) model 回显一致性
    const echoes = samples.map((sample) => sample.modelEcho);
    const echoOk = samples.every((sample) => modelEchoMatches(ctx.model, sample.modelEcho));

    // 2) completion_tokens 变异系数
    const tokenValues = samples.map((sample) => sample.completionTokens).filter((value) => value != null);
    const cv = coefficientOfVariation(tokenValues);
    const cvOk = cv != null && cv <= 0.15;
    const cvSuspicious = cv != null && cv > 0.4;

    // 3) 三次响应 id 应互不相同（相同说明可能在重放缓存响应）
    const ids = samples.map((sample) => sample.id).filter(Boolean);
    const idsUnique = ids.length < 2 || new Set(ids).size === ids.length;

    let score = 0;
    if (echoOk) {
      score = 60;
      if (cv == null) score += 20;
      else if (cv <= 0.15) score += 40;
      else if (cv <= 0.4) score += 10;
    }
    if (!idsUnique) score = Math.max(0, score - 20);
    score = Math.round(Math.min(100, Math.max(0, score)));

    const subChecks = [
      {
        id: 'model_echo',
        ok: echoOk,
        detail: echoOk ? '响应 model 与请求模型一致。' : '响应 model 与请求模型不一致：上游可能挂羊头卖狗肉。',
        evidence: { requested: ctx.model, echoes, expected: ctx.model }
      },
      {
        id: 'completion_token_cv',
        ok: cvOk,
        detail:
          cv == null
            ? '上游未返回可用的 completion_tokens，无法计算变异系数（本项不计分）。'
            : cvOk
              ? `3 次 completion_tokens 变异系数 ${round(cv)}，输出长度稳定。`
              : `3 次 completion_tokens 变异系数 ${round(cv)}，输出长度异常波动（疑似轮换模型 / 截断）。`,
        evidence: { values: tokenValues, cv: cv == null ? null : round(cv), threshold: 0.15, suspicious: cvSuspicious }
      },
      {
        id: 'response_ids_unique',
        ok: idsUnique,
        detail: idsUnique ? '3 次响应 id 互不相同。' : '多次响应出现相同 id，疑似重放缓存响应。',
        evidence: { ids }
      }
    ];

    return buildResult(this, {
      status: score >= 70 ? 'pass' : 'fail',
      score,
      details: {
        subChecks,
        requestedModel: ctx.model,
        samples: samples.map((sample) => ({
          index: sample.index,
          modelEcho: sample.modelEcho,
          completionTokens: sample.completionTokens,
          promptTokens: sample.promptTokens,
          textLength: sample.textLength,
          id: sample.id
        })),
        echoOk,
        cv: cv == null ? null : round(cv),
        samplesRequested: SAMPLES,
        samplesValid: samples.length,
        ...(firstFailure ? { note: `仅获得 ${samples.length}/${SAMPLES} 个有效样本。` } : {})
      },
      durationMs: Date.now() - startedAt
    });
  }
}

export const modelConsistency = new ModelConsistencyDetector();
export default modelConsistency;
