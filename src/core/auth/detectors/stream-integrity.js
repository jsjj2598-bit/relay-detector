/**
 * `stream_integrity`（契约 v2 §6.4）—— 主动检测器，权重 10，full 档，全协议。
 *
 * 同一提示词分别走**非流式**和**流式**两条路径，比较：
 *  1. 两条路径的正文相似度 ≥ 85（流式解析错误 / 被掉包时会明显不一致）；
 *  2. `input_tokens` 差异 ≤ max(3, 20%)；
 *  3. `output_tokens` 差异 ≤ max(3, 20%)。
 *
 * 真实官方实现的两条路径应当基本等价；「假流式」（把完整 JSON 一次吐出）
 * 或流式路径被另一套上游服务时，文本/usage 会出现明显偏差。
 *
 * 三项等权（34/33/33）：任一项失败 → 67 分 → status: fail。
 * 这符合「流式与非流式必须一致」的强约束：官方实现不会在其中一条路径上变形。
 */
import { ActiveDetector, buildResult } from '../base.js';
import {
  bodyJsonOf,
  buildChatRequest,
  extractAssistantText,
  extractUsage,
  failureOf,
  parseStream,
  performRequest
} from '../protocol.js';

export const STREAM_PROMPT =
  '请原样输出这一行文字（不要加引号、不要任何解释）：流式一致性测试 2378 1547';

const SIMILARITY_MIN = 85;

function normalizeForCompare(text) {
  return String(text ?? '')
    .toLowerCase()
    .replace(/\s+/g, '')
    .replace(/[，。！？、；：""''《》（）【】…—,.!?;:'"()\[\]{}<>`*_~]/g, '');
}

/**
 * 计算两段文本的字符二元组 Dice 相似度（0..100）。
 * 对短文本退化为完全相等判断。
 */
export function textSimilarity(a, b) {
  const left = normalizeForCompare(a);
  const right = normalizeForCompare(b);
  if (!left && !right) return 100;
  if (!left || !right) return 0;
  if (left === right) return 100;
  if (left.length < 2 || right.length < 2) return left === right ? 100 : 0;
  const bigrams = new Map();
  for (let i = 0; i < left.length - 1; i += 1) {
    const gram = left.slice(i, i + 2);
    bigrams.set(gram, (bigrams.get(gram) || 0) + 1);
  }
  let common = 0;
  for (let i = 0; i < right.length - 1; i += 1) {
    const gram = right.slice(i, i + 2);
    const count = bigrams.get(gram) || 0;
    if (count > 0) {
      common += 1;
      bigrams.set(gram, count - 1);
    }
  }
  const total = left.length - 1 + (right.length - 1);
  return Math.round((2 * common) / total * 100);
}

/** token 数允许的偏差：max(3, 20%)。 */
export function tokenTolerance(reference) {
  const ref = typeof reference === 'number' && Number.isFinite(reference) ? Math.abs(reference) : 0;
  return Math.max(3, Math.ceil(ref * 0.2));
}

export class StreamIntegrityDetector extends ActiveDetector {
  constructor() {
    super({
      name: 'stream_integrity',
      displayName: '流式与非流式一致性',
      weight: 10,
      modes: ['full'],
      provider: [],
      critical: false,
      description: '比较流式与非流式路径的正文相似度与 input/output token 计数差异。'
    });
  }

  async run(ctx) {
    const startedAt = Date.now();

    // 1) 非流式
    const nonStreamExchange = await performRequest(
      ctx,
      buildChatRequest(ctx, {
        purpose: 'stream_integrity_nonstream',
        prompt: STREAM_PROMPT,
        maxTokens: 128,
        temperature: 0,
        stream: false
      })
    );
    const nonStreamFailure = failureOf(nonStreamExchange);
    if (nonStreamFailure) {
      return buildResult(this, { ...nonStreamFailure, durationMs: Date.now() - startedAt });
    }
    const nonStreamPayload = bodyJsonOf(nonStreamExchange) || {};
    const nonStreamText = extractAssistantText(nonStreamPayload, ctx.provider);
    const nonStreamUsage = extractUsage(nonStreamPayload, ctx.provider);

    // 2) 流式
    const streamExchange = await performRequest(
      ctx,
      buildChatRequest(ctx, {
        purpose: 'stream_integrity_stream',
        prompt: STREAM_PROMPT,
        maxTokens: 128,
        temperature: 0,
        stream: true
      })
    );
    const streamFailure = failureOf(streamExchange);
    if (streamFailure) {
      const httpStatus = Number(streamExchange?.response?.status) || 0;
      // 传输错误 / 鉴权错误 / 致命错误：检测无法完成，记 error（不计入分母）
      if (
        streamFailure.details?.fatal ||
        streamFailure.details?.reason === 'transport_error' ||
        httpStatus === 401 ||
        httpStatus === 403
      ) {
        return buildResult(this, {
          ...streamFailure,
          details: { ...streamFailure.details, stage: 'stream_request' },
          durationMs: Date.now() - startedAt
        });
      }
      // 官方实现不可能拒绝流式；被拒绝本身就是可疑信号
      return buildResult(this, {
        status: 'fail',
        score: 0,
        details: {
          subChecks: [
            {
              id: 'stream_supported',
              ok: false,
              detail: '上游拒绝了流式请求（真实官方实现必然支持流式）。',
              evidence: { httpStatus, error: streamFailure.error }
            }
          ],
          stage: 'stream_request',
          httpStatus,
          streamError: streamFailure.error
        },
        durationMs: Date.now() - startedAt
      });
    }

    const streamText = parseStream(streamExchange?.response?.bodyText, ctx.provider);
    const streamUsage = streamText.usage || {};
    const similarity = textSimilarity(nonStreamText, streamText.text);

    const checks = [];
    checks.push({
      id: 'text_similarity',
      ok: similarity >= SIMILARITY_MIN,
      detail:
        similarity >= SIMILARITY_MIN
          ? `流式与非流式正文相似度 ${similarity}（≥ ${SIMILARITY_MIN}）。`
          : `流式与非流式正文相似度仅 ${similarity}（< ${SIMILARITY_MIN}），两条路径可能不是同一上游/同一模型。`,
      weight: 34,
      evidence: {
        similarity,
        threshold: SIMILARITY_MIN,
        nonStreamPreview: String(nonStreamText).slice(0, 200),
        streamPreview: String(streamText.text).slice(0, 200)
      }
    });

    const inputRef = nonStreamUsage.promptTokens;
    const inputGot = streamUsage.promptTokens;
    const inputApplicable = typeof inputRef === 'number' && typeof inputGot === 'number';
    if (inputApplicable) {
      const tolerance = tokenTolerance(inputRef);
      const diff = Math.abs(inputRef - inputGot);
      const ok = diff <= tolerance;
      checks.push({
        id: 'input_tokens_parity',
        ok,
        weight: 33,
        detail: ok
          ? `input_tokens 差异 ${diff} ≤ 容差 ${tolerance}。`
          : `input_tokens 差异 ${diff} 超过容差 ${tolerance}（非流式 ${inputRef} vs 流式 ${inputGot}），两路径的计费口径不一致。`,
        evidence: { nonStream: inputRef, stream: inputGot, diff, tolerance }
      });
    }

    const outputRef = nonStreamUsage.completionTokens;
    const outputGot = streamUsage.completionTokens;
    const outputApplicable = typeof outputRef === 'number' && typeof outputGot === 'number';
    if (outputApplicable) {
      const tolerance = tokenTolerance(outputRef);
      const diff = Math.abs(outputRef - outputGot);
      const ok = diff <= tolerance;
      checks.push({
        id: 'output_tokens_parity',
        ok,
        weight: 33,
        detail: ok
          ? `output_tokens 差异 ${diff} ≤ 容差 ${tolerance}。`
          : `output_tokens 差异 ${diff} 超过容差 ${tolerance}（非流式 ${outputRef} vs 流式 ${outputGot}）。`,
        evidence: { nonStream: outputRef, stream: outputGot, diff, tolerance }
      });
    }

    const applicableWeight = checks.reduce((sum, item) => sum + item.weight, 0);
    const passedWeight = checks.filter((item) => item.ok).reduce((sum, item) => sum + item.weight, 0);
    const score = applicableWeight > 0 ? Math.round((passedWeight / applicableWeight) * 100) : 0;

    return buildResult(this, {
      status: score >= 70 ? 'pass' : 'fail',
      score,
      details: {
        subChecks: checks,
        similarity,
        nonStream: {
          textLength: String(nonStreamText).length,
          promptTokens: nonStreamUsage.promptTokens,
          completionTokens: nonStreamUsage.completionTokens,
          totalTokens: nonStreamUsage.totalTokens
        },
        stream: {
          textLength: String(streamText.text).length,
          promptTokens: streamUsage.promptTokens ?? null,
          completionTokens: streamUsage.completionTokens ?? null,
          frameCount: streamText.frameCount,
          sawDone: streamText.sawDone,
          jsonFallback: Boolean(streamText.jsonFallback)
        },
        usageCompared: { inputApplicable, outputApplicable },
        model: ctx.model,
        httpStatus: nonStreamExchange.response?.status ?? null,
        streamHttpStatus: streamExchange.response?.status ?? null
      },
      durationMs: Date.now() - startedAt
    });
  }
}

export const streamIntegrity = new StreamIntegrityDetector();
export default streamIntegrity;
