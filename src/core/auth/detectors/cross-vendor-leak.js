/**
 * `cross_vendor_leak`（契约 v2 §6.4）—— 被动检测器，权重 20，**critical**，quick+，全协议。
 *
 * 核心思想（见 LEARNINGS §2.5）：
 * 一个中转站如果「用 Kimi/Claude 冒充 OpenAI」，往往会在 OpenAI 格式的响应里
 * 漏出原厂商的字段：`claude_cache_creation_5_m_tokens`、`usage_source: anthropic`、
 * 乃至 Anthropic 命名的 `input_tokens` / `output_tokens`。
 * 这些字段**官方 OpenAI 响应永远不会出现**，因此一旦出现就是 critical 级证据。
 *
 * 双向检测：
 *  - OpenAI 形状里出现 Anthropic / Google 痕迹；
 *  - Anthropic 形状里出现 OpenAI / Google 痕迹；
 *  - Gemini 形状里出现 OpenAI / Anthropic 痕迹。
 *
 * 零额外请求成本（复用其他主动检测器已经发出的响应）。
 */
import { PassiveDetector, buildResult, collectJsonLeaves, safeText, stateFor } from '../base.js';

/** Anthropic 独有的 usage 字段名（含中转站泄漏时常见的 claude_* 变体）。 */
const ANTHROPIC_USAGE_KEYS = new Set([
  'input_tokens',
  'output_tokens',
  'cache_creation_input_tokens',
  'cache_read_input_tokens',
  'claude_cache_creation_5_m_tokens',
  'claude_cache_read_input_tokens',
  'claude_cache_creation_1_h_tokens'
]);

/** Google Gemini 独有的 usage 字段名。 */
const GEMINI_USAGE_KEYS = new Set([
  'prompttokencount',
  'candidatestokencount',
  'totaltokencount',
  'cachedcontenttokencount',
  'thoughtstokencount',
  'usagemetadata'
]);

/** OpenAI 独有的 usage 字段名。 */
const OPENAI_USAGE_KEYS = new Set(['prompt_tokens', 'completion_tokens', 'total_tokens']);

const VENDOR_ALIASES = [
  { vendor: 'anthropic', pattern: /anthropic|claude/i },
  { vendor: 'gemini', pattern: /google|gemini|vertex|palm/i },
  { vendor: 'openai', pattern: /openai|azure|gpt/i }
];

/** 从任意字符串里识别厂商名。 */
export function vendorOf(value) {
  const text = safeText(value);
  if (!text) return null;
  for (const { vendor, pattern } of VENDOR_ALIASES) if (pattern.test(text)) return vendor;
  return null;
}

const VENDOR_LABELS = { openai: 'OpenAI', anthropic: 'Anthropic / Claude', gemini: 'Google Gemini' };

const isObject = (value) => Boolean(value) && typeof value === 'object';

/**
 * 判断一份响应载荷是否值得做跨厂商检查。
 * 排除 `/v1/models` 列表（其中合法地包含各家模型名）。
 */
export function looksLikeModelResponse(payload) {
  if (!isObject(payload)) return false;
  if (Array.isArray(payload.choices) && payload.choices.length > 0) return true;
  if (Array.isArray(payload.content)) return true;
  if (Array.isArray(payload.candidates)) return true;
  if (payload.type === 'message') return true;
  if (payload.usage && typeof payload.usage === 'object') return true;
  if (payload.usageMetadata && typeof payload.usageMetadata === 'object') return true;
  return false;
}

/** 证据里的值做安全截断，避免把超长内容塞进报告。 */
function previewValue(value, max = 120) {
  if (typeof value === 'string') return value.length > max ? `${value.slice(0, max)}…` : value;
  if (typeof value === 'number' || typeof value === 'boolean' || value === null) return value;
  try {
    const text = JSON.stringify(value);
    if (typeof text !== 'string') return null;
    return text.length > max ? `${text.slice(0, max)}…` : text;
  } catch {
    return null;
  }
}

/**
 * 检测跨厂商字段泄漏（纯函数，供单元测试直接调用）。
 *
 * @param {'openai'|'anthropic'|'gemini'} provider 请求使用的协议（期望的“真厂商”）
 * @param {object} payload 响应 JSON
 * @returns {Array<{id:string, message:string, evidence:object}>}
 */
export function detectCrossVendorLeaks(provider, payload) {
  const protocol = provider === 'anthropic' || provider === 'gemini' ? provider : 'openai';
  if (!looksLikeModelResponse(payload)) return [];

  const leaks = new Map();
  const add = (id, message, evidence) => {
    if (!leaks.has(id)) leaks.set(id, { id, message, evidence });
  };

  const leaves = collectJsonLeaves(payload, { maxNodes: 1500, maxDepth: 6 });
  for (const leaf of leaves) {
    const key = safeText(leaf.key).toLowerCase();
    if (!key) continue;

    // Anthropic 痕迹：claude_* / anthropic_* / Anthropic usage 键名
    const isAnthropicTrace =
      key.startsWith('claude') ||
      key.startsWith('anthropic') ||
      ANTHROPIC_USAGE_KEYS.has(key);
    // Gemini 痕迹：usageMetadata 及其 token 计数键
    const isGeminiTrace =
      GEMINI_USAGE_KEYS.has(key) || key === 'candidates' || key.startsWith('gemini');
    // OpenAI 痕迹：choices / OpenAI usage 键名
    const isOpenAITrace =
      key === 'choices' ||
      key === 'chat.completion' ||
      OPENAI_USAGE_KEYS.has(key) ||
      key.startsWith('chatcmpl');

    if (protocol !== 'anthropic' && isAnthropicTrace) {
      add('cross_vendor_anthropic_field', '响应中出现 Anthropic / Claude 独有字段（上游疑似被换成 Claude）', {
        path: leaf.path,
        field: leaf.key,
        value: previewValue(leaf.value)
      });
      continue;
    }
    if (protocol !== 'gemini' && isGeminiTrace) {
      add('cross_vendor_gemini_field', '响应中出现 Google Gemini 独有字段（上游疑似被换成 Gemini）', {
        path: leaf.path,
        field: leaf.key,
        value: previewValue(leaf.value)
      });
      continue;
    }
    if (protocol !== 'openai' && isOpenAITrace) {
      add('cross_vendor_openai_field', '响应中出现 OpenAI 独有字段（上游疑似被换成 OpenAI）', {
        path: leaf.path,
        field: leaf.key,
        value: previewValue(leaf.value)
      });
      continue;
    }

    // 显式的厂商标识字段（usage_source / provider / vendor / upstream）
    if (key === 'usage_source' || key === 'usagesource' || key === 'vendor' || key === 'upstream' || key === 'provider') {
      const vendor = vendorOf(leaf.value);
      if (vendor && vendor !== protocol) {
        add('cross_vendor_vendor_marker', `响应字段 ${leaf.key} 指向其他厂商（${VENDOR_LABELS[vendor]}）`, {
          path: leaf.path,
          field: leaf.key,
          value: previewValue(leaf.value),
          expectedVendor: protocol
        });
      }
    }
  }

  // 顶层形状错位（例如 Anthropic 请求返回了 OpenAI 的 choices 数组）
  if (protocol === 'anthropic' && payload.object === 'chat.completion') {
    add('cross_vendor_openai_shape', 'Anthropic 协议的响应返回了 OpenAI chat.completion 形状', {
      object: payload.object,
      id: previewValue(payload.id)
    });
  }
  if (protocol === 'openai' && payload.type === 'message' && Array.isArray(payload.content)) {
    add('cross_vendor_anthropic_shape', 'OpenAI 协议的响应返回了 Anthropic message 形状', {
      type: payload.type,
      id: previewValue(payload.id)
    });
  }
  if (protocol === 'gemini' && Array.isArray(payload.choices)) {
    add('cross_vendor_openai_shape', 'Gemini 协议的响应返回了 OpenAI choices 形状', {
      object: payload.object ?? null
    });
  }

  return [...leaks.values()];
}

export class CrossVendorLeakDetector extends PassiveDetector {
  constructor() {
    super({
      name: 'cross_vendor_leak',
      displayName: '跨厂商字段泄漏',
      weight: 20,
      modes: ['quick', 'standard', 'full'],
      provider: [],
      critical: true,
      description: '检查成功响应里是否漏出其他厂商（Claude / Gemini / OpenAI）的独有字段。'
    });
  }

  /** 被动累积观察到的响应。 */
  observe(ctx, exchange) {
    // 检测器自身绝不抛异常
    try {
      const state = stateFor(ctx, this.name, () => ({ checked: 0, leaks: [], purposes: [] }));
      const response = exchange?.response;
      if (!response) return;
      const status = Number(response.status) || 0;
      if (status >= 400) return; // 错误报文交给 v1 规则；这里只检查成功响应的结构
      const payload = response.bodyJson;
      if (!looksLikeModelResponse(payload)) return;
      state.checked += 1;
      const purpose = safeText(exchange?.purpose) || 'unknown';
      if (!state.purposes.includes(purpose)) state.purposes.push(purpose);
      const leaks = detectCrossVendorLeaks(ctx?.provider || 'openai', payload);
      for (const leak of leaks) {
        if (state.leaks.some((existing) => existing.id === leak.id && existing.evidence?.path === leak.evidence?.path)) {
          continue;
        }
        state.leaks.push(leak);
      }
    } catch {
      /* 被动观察失败不影响主流程 */
    }
  }

  finalize(ctx) {
    const state = stateFor(ctx, this.name, () => ({ checked: 0, leaks: [], purposes: [] }));
    if (state.checked === 0) {
      return buildResult(this, {
        status: 'skip',
        score: 0,
        reason: 'no_exchange',
        details: {
          reason: 'no_exchange',
          message: '本次没有可复用的成功响应，跨厂商泄漏检查已跳过（skip 不计入加权分母）。'
        }
      });
    }
    if (state.leaks.length > 0) {
      const criticalIssues = state.leaks.map((leak) => ({
        code: leak.id,
        message: leak.message,
        evidence: leak.evidence
      }));
      return buildResult(this, {
        status: 'fail',
        score: 0,
        criticalIssues,
        details: {
          subChecks: state.leaks.map((leak) => ({
            id: leak.id,
            ok: false,
            detail: leak.message,
            evidence: leak.evidence
          })),
          checkedResponses: state.checked,
          inspectedPurposes: state.purposes,
          criticalCount: state.leaks.length,
          note: '跨厂商字段是 critical 级证据：即使总分很高，最终 verdict 也会被封顶为「基本合格」。'
        }
      });
    }
    return buildResult(this, {
      status: 'pass',
      score: 100,
      details: {
        subChecks: [
          {
            id: 'no_cross_vendor_trace',
            ok: true,
            detail: `已检查 ${state.checked} 个成功响应，未发现跨厂商字段。`,
            evidence: { checkedResponses: state.checked, inspectedPurposes: state.purposes }
          }
        ],
        checkedResponses: state.checked,
        inspectedPurposes: state.purposes
      }
    });
  }

  /** 直接调用时的兼容入口：扫描 ctx.exchanges 后 finalize。 */
  async run(ctx) {
    const exchanges = Array.isArray(ctx?.exchanges) ? ctx.exchanges : [];
    for (const exchange of exchanges) this.observe(ctx, exchange);
    return this.finalize(ctx);
  }
}

export const crossVendorLeak = new CrossVendorLeakDetector();
export default crossVendorLeak;
