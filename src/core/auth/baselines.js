/**
 * 内置官方基线（契约 v2 §6.4 / §6.5，`token_parity` 使用）。
 *
 * ⚠️ 设计取舍（见 docs/LEARNINGS-FROM-VERIDROP.md §3）：
 * 真实的 token 基线会随模型、分词器、系统提示词版本而变，硬编码过期基线会制造
 * **假阳性**（把正常模型判成掉包）。本项目是纯静态/本地工具，没有后端持续更新基线，
 * 因此这里**默认不内置任何实测基线**：没有基线时 `token_parity` 必须 `skip`，
 * 不进入加权分母、不扣分（契约 §6.4）。
 *
 * 如果将来由可信渠道（同一模型、同一提示词、官方 key 实测）产出了基线，
 * 按下面的结构填入即可，`token_parity` 会自动启用。
 *
 * 基线结构：
 * {
 *   [provider]: {
 *     [modelId]: {
 *       prompt: '校准探针提示词的稳定 hash 或原文 id', // 必须是 token_parity 实际使用的同一提示词
 *       promptTokens: 123,
 *       completionTokens: 45,
 *       tolerance: { promptTokens: 2, completionTokens: 2 }, // 允许的绝对偏差
 *       source: '官方 key 实测（日期、模型快照）',
 *       measuredAt: 'YYYY-MM-DD'
 *     }
 *   }
 * }
 */

export const BASELINES_VERSION = '2026-10-19';

/** 当前**故意为空**的官方基线表：宁可 skip，也不伪造基线。 */
export const BASELINES = {
  openai: {},
  anthropic: {},
  gemini: {}
};

const PROVIDER_ALIASES = { claude: 'anthropic', google: 'gemini' };

function normalizeProvider(provider) {
  const key = String(provider ?? '').trim().toLowerCase();
  const mapped = PROVIDER_ALIASES[key] || key;
  return BASELINES[mapped] ? mapped : null;
}

/** 归一化模型名，用于基线的精确 / 前缀查找。 */
function normalizeModel(model) {
  return String(model ?? '')
    .trim()
    .replace(/^[^/]+\//, '')
    .replace(/:[a-z0-9_-]+$/i, '')
    .toLowerCase();
}

/**
 * 取某协议 + 模型的官方基线；没有则返回 `null`（调用方据此 `skip`）。
 *
 * @param {string} provider
 * @param {string} model
 * @returns {null | { prompt: string, promptTokens: number, completionTokens: number,
 *                   tolerance?: {promptTokens?:number, completionTokens?:number},
 *                   source?: string, measuredAt?: string }}
 */
export function getBaseline(provider, model) {
  const providerId = normalizeProvider(provider);
  if (!providerId) return null;
  const table = BASELINES[providerId];
  if (!table || typeof table !== 'object') return null;
  const requested = normalizeModel(model);
  if (!requested) return null;

  if (table[requested]) return { ...table[requested] };
  // 前缀匹配（带日期后缀的模型可复用同族基线）
  const keys = Object.keys(table).sort((a, b) => b.length - a.length);
  for (const key of keys) {
    const id = key.toLowerCase();
    if (requested === id || requested.startsWith(`${id}-`) || requested.startsWith(`${id}.`)) {
      return { ...table[key] };
    }
  }
  return null;
}

/** 是否有可用基线。 */
export function hasBaseline(provider, model) {
  return getBaseline(provider, model) !== null;
}

export default { BASELINES, BASELINES_VERSION, getBaseline, hasBaseline };
