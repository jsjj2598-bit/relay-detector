/**
 * `structured_output`（契约 v2 §6.4）—— 主动检测器，权重 10，standard+，全协议。
 *
 * 要求模型返回**精确的 JSON 字面量**，检查它是否：
 *  - 真的返回了合法 JSON（而不是拒绝 / 空响应）；
 *  - 键值完全符合要求（`{"answer":42,"tag":"ok"}`）；
 *  - 没有被包在 ```json 代码块里（说明中间层/提示词模板改写了输出）。
 *
 * 这是一个**弱证据**：模型可以遵守格式但仍是假模型。因此权重只有 10。
 */
import { ActiveDetector, buildResult } from '../base.js';
import {
  bodyJsonOf,
  buildChatRequest,
  extractAssistantText,
  failureOf,
  performRequest
} from '../protocol.js';

export const EXPECTED_JSON = Object.freeze({ answer: 42, tag: 'ok' });
export const STRUCTURED_OUTPUT_PROMPT =
  '请只输出以下 JSON 字面量，不要 Markdown 代码块、不要任何解释：{"answer":42,"tag":"ok"}';

const FENCE_RE = /```(?:json)?\s*([\s\S]*?)```/i;

function jsonEqualsExpected(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const keys = Object.keys(value).sort();
  if (keys.length !== 2 || keys[0] !== 'answer' || keys[1] !== 'tag') return false;
  return Number(value.answer) === EXPECTED_JSON.answer && String(value.tag) === EXPECTED_JSON.tag;
}

/**
 * 评估模型输出（纯函数，便于单测）。
 *
 * @param {string} text
 * @returns {{score:number, fenced:boolean, parsed:boolean, matches:boolean, tier:string}}
 */
export function evaluateStructuredOutput(text) {
  const raw = typeof text === 'string' ? text : '';
  const trimmed = raw.trim();
  if (!trimmed) return { score: 0, fenced: false, parsed: false, matches: false, tier: 'empty' };

  const fencedMatch = FENCE_RE.exec(trimmed);
  const fenced = Boolean(fencedMatch);
  const candidate = fenced ? fencedMatch[1].trim() : trimmed;

  let parsedValue = null;
  let parsed = false;
  try {
    parsedValue = JSON.parse(candidate);
    parsed = true;
  } catch {
    parsed = false;
  }
  const matches = parsed && jsonEqualsExpected(parsedValue);

  let score;
  let tier;
  if (matches && !fenced && trimmed === JSON.stringify(EXPECTED_JSON)) {
    // 逐字符等于期望字面量：最理想
    score = 100;
    tier = 'exact_literal';
  } else if (matches && !fenced) {
    // 合法且键值正确，但有多余空白 / 顺序差异
    score = 90;
    tier = 'json_literal_with_whitespace';
  } else if (matches && fenced) {
    score = 50;
    tier = 'wrapped_in_code_fence';
  } else if (parsed) {
    score = 30;
    tier = 'json_but_wrong_values';
  } else if (fenced) {
    score = 20;
    tier = 'code_fence_but_invalid_json';
  } else {
    score = 10;
    tier = 'not_json';
  }
  return { score, fenced, parsed, matches, tier };
}

export class StructuredOutputDetector extends ActiveDetector {
  constructor() {
    super({
      name: 'structured_output',
      displayName: '结构化输出遵循度',
      weight: 10,
      modes: ['standard', 'full'],
      provider: [],
      critical: false,
      description: '要求返回精确 JSON 字面量，检查是否合法、键值正确、未被包 ```json 代码块。'
    });
  }

  async run(ctx) {
    const startedAt = Date.now();
    const request = buildChatRequest(ctx, {
      purpose: 'structured_output',
      prompt: STRUCTURED_OUTPUT_PROMPT,
      maxTokens: 128,
      temperature: 0
    });
    const exchange = await performRequest(ctx, request);
    const failure = failureOf(exchange);
    if (failure) {
      return buildResult(this, { ...failure, durationMs: Date.now() - startedAt });
    }

    const payload = bodyJsonOf(exchange) || {};
    const text = extractAssistantText(payload, ctx.provider);
    const evaluated = evaluateStructuredOutput(text);

    const subChecks = [
      {
        id: 'exact_json_literal',
        ok: evaluated.tier === 'exact_literal' || evaluated.tier === 'json_literal_with_whitespace',
        detail:
          evaluated.tier === 'exact_literal'
            ? '返回了精确的 JSON 字面量。'
            : evaluated.tier === 'json_literal_with_whitespace'
              ? '返回了合法且键值正确的 JSON（含多余空白/顺序差异）。'
              : '未返回精确的 JSON 字面量。',
        evidence: { tier: evaluated.tier }
      },
      {
        id: 'no_markdown_fence',
        ok: !evaluated.fenced,
        detail: evaluated.fenced ? '输出被包在 Markdown 代码块里（提示词模板/中间层改写了输出）。' : '输出未使用 Markdown 代码块。',
        evidence: { fenced: evaluated.fenced }
      },
      {
        id: 'json_values_correct',
        ok: evaluated.matches,
        detail: evaluated.matches ? 'JSON 键值符合要求。' : 'JSON 键值不符合要求或不是合法 JSON。',
        evidence: { expected: EXPECTED_JSON, parsed: evaluated.parsed }
      }
    ];

    return buildResult(this, {
      status: evaluated.score >= 70 ? 'pass' : 'fail',
      score: evaluated.score,
      details: {
        subChecks,
        tier: evaluated.tier,
        completionText: typeof text === 'string' ? text.slice(0, 500) : '',
        completionTextLength: typeof text === 'string' ? text.length : 0,
        model: ctx.model,
        httpStatus: exchange.response?.status ?? null
      },
      durationMs: Date.now() - startedAt
    });
  }
}

export const structuredOutput = new StructuredOutputDetector();
export default structuredOutput;
