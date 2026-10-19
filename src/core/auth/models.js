/**
 * 模型能力表（契约 v2 §6.5）。
 *
 * 用途：
 *  - 让依赖模型能力的检测器做**前置过滤**（如模型不支持 thinking → 签名检测 `skip`），
 *    避免把「模型本来就不支持」误判成「中转站吞掉了特性」（这是 v1 最大的假阴性来源）。
 *  - 给 UI 提供模型下拉候选（`suggestModels`）。
 *
 * 设计原则：
 *  - 匹配不到必须返回 `null`（而不是抛错），并让依赖能力的检测器 `skip`；
 *  - 支持带日期后缀 / `-latest` / `-preview` 的模型名（中转站常回显完整版本号）；
 *  - 能力表宁缺毋滥：只收录有相对把握的公开模型，不臆造。
 */

/**
 * @typedef {Object} ModelInfo
 * @property {string} id 模型 id（注册表中的规范 id）
 * @property {string} label 展示名
 * @property {'extended'|'adaptive'|null} thinking 是否支持 Claude extended / adaptive thinking
 * @property {boolean} [adaptive] 是否应使用 adaptive thinking 参数（仅 thinking 为真时有意义）
 * @property {boolean} supportsTools 是否支持 tool / function calling
 * @property {number} contextWindow 上下文窗口（token）
 */

/** 支持 thinking 的 Anthropic 模型默认 max_tokens 下限（thinking budget 之外还要给答案留空间）。 */
const ANTHROPIC_LARGE_CONTEXT = 200000;

/**
 * 模型能力表（契约 §6.5）。
 * 说明：`thinking: 'extended'` 表示支持 `{ type: 'extended', budget_tokens }` 风格的
 * `thinking` 参数；`adaptive: true` 表示该模型应使用较新的 adaptive 形式
 * `{ type: 'adaptive', display: 'summarized' }` + **顶层** `output_config.effort`。
 *
 * @type {{ anthropic: ModelInfo[], openai: ModelInfo[], gemini: ModelInfo[] }}
 */
export const MODEL_REGISTRY = {
  anthropic: [
    {
      id: 'claude-sonnet-4-5',
      label: 'Claude Sonnet 4.5',
      thinking: 'extended',
      adaptive: true,
      supportsTools: true,
      contextWindow: ANTHROPIC_LARGE_CONTEXT
    },
    {
      id: 'claude-opus-4-5',
      label: 'Claude Opus 4.5',
      thinking: 'extended',
      adaptive: true,
      supportsTools: true,
      contextWindow: ANTHROPIC_LARGE_CONTEXT
    },
    {
      id: 'claude-haiku-4-5',
      label: 'Claude Haiku 4.5',
      thinking: 'extended',
      adaptive: true,
      supportsTools: true,
      contextWindow: ANTHROPIC_LARGE_CONTEXT
    },
    {
      id: 'claude-opus-4-1',
      label: 'Claude Opus 4.1',
      thinking: 'extended',
      supportsTools: true,
      contextWindow: ANTHROPIC_LARGE_CONTEXT
    },
    {
      id: 'claude-opus-4-0',
      label: 'Claude Opus 4',
      thinking: 'extended',
      supportsTools: true,
      contextWindow: ANTHROPIC_LARGE_CONTEXT
    },
    {
      id: 'claude-sonnet-4-0',
      label: 'Claude Sonnet 4',
      thinking: 'extended',
      supportsTools: true,
      contextWindow: ANTHROPIC_LARGE_CONTEXT
    },
    {
      id: 'claude-3-7-sonnet',
      label: 'Claude 3.7 Sonnet',
      thinking: 'extended',
      supportsTools: true,
      contextWindow: ANTHROPIC_LARGE_CONTEXT
    },
    {
      id: 'claude-3-5-sonnet-20241022',
      label: 'Claude 3.5 Sonnet',
      thinking: null,
      supportsTools: true,
      contextWindow: ANTHROPIC_LARGE_CONTEXT
    },
    {
      id: 'claude-3-5-haiku-20241022',
      label: 'Claude 3.5 Haiku',
      thinking: null,
      supportsTools: true,
      contextWindow: ANTHROPIC_LARGE_CONTEXT
    },
    {
      id: 'claude-3-opus-20240229',
      label: 'Claude 3 Opus',
      thinking: null,
      supportsTools: true,
      contextWindow: ANTHROPIC_LARGE_CONTEXT
    }
  ],
  openai: [
    { id: 'gpt-5', label: 'GPT-5', thinking: null, supportsTools: true, contextWindow: 400000 },
    { id: 'gpt-4.1', label: 'GPT-4.1', thinking: null, supportsTools: true, contextWindow: 1047576 },
    { id: 'gpt-4.1-mini', label: 'GPT-4.1 mini', thinking: null, supportsTools: true, contextWindow: 1047576 },
    { id: 'gpt-4.1-nano', label: 'GPT-4.1 nano', thinking: null, supportsTools: true, contextWindow: 1047576 },
    { id: 'gpt-4o', label: 'GPT-4o', thinking: null, supportsTools: true, contextWindow: 128000 },
    { id: 'gpt-4o-mini', label: 'GPT-4o mini', thinking: null, supportsTools: true, contextWindow: 128000 },
    { id: 'gpt-4-turbo', label: 'GPT-4 Turbo', thinking: null, supportsTools: true, contextWindow: 128000 },
    { id: 'gpt-4', label: 'GPT-4', thinking: null, supportsTools: true, contextWindow: 8192 },
    { id: 'gpt-3.5-turbo', label: 'GPT-3.5 Turbo', thinking: null, supportsTools: true, contextWindow: 16385 },
    { id: 'o3', label: 'o3', thinking: null, supportsTools: true, contextWindow: 200000 },
    { id: 'o4-mini', label: 'o4-mini', thinking: null, supportsTools: true, contextWindow: 200000 },
    { id: 'o1', label: 'o1', thinking: null, supportsTools: true, contextWindow: 200000 }
  ],
  gemini: [
    {
      id: 'gemini-2.5-pro',
      label: 'Gemini 2.5 Pro',
      thinking: null,
      supportsTools: true,
      contextWindow: 1048576
    },
    {
      id: 'gemini-2.5-flash',
      label: 'Gemini 2.5 Flash',
      thinking: null,
      supportsTools: true,
      contextWindow: 1048576
    },
    {
      id: 'gemini-2.0-flash',
      label: 'Gemini 2.0 Flash',
      thinking: null,
      supportsTools: true,
      contextWindow: 1048576
    },
    {
      id: 'gemini-1.5-pro',
      label: 'Gemini 1.5 Pro',
      thinking: null,
      supportsTools: true,
      contextWindow: 2097152
    },
    {
      id: 'gemini-1.5-flash',
      label: 'Gemini 1.5 Flash',
      thinking: null,
      supportsTools: true,
      contextWindow: 1048576
    }
  ]
};

/** 各协议默认模型（用户未指定时使用）。 */
export const DEFAULT_MODELS = {
  anthropic: 'claude-sonnet-4-5',
  openai: 'gpt-4o',
  gemini: 'gemini-2.5-flash'
};

const PROVIDER_ALIASES = {
  anthropic: 'anthropic',
  claude: 'anthropic',
  openai: 'openai',
  gemini: 'gemini',
  google: 'gemini'
};

/** 归一化协议名（未知返回 null）。 */
export function normalizeProviderId(provider) {
  const key = String(provider ?? '').trim().toLowerCase();
  return PROVIDER_ALIASES[key] || null;
}

/** 去掉 `-latest` / 日期后缀，便于前缀匹配。 */
function stripVersionSuffix(id) {
  return String(id)
    .replace(/-(latest|preview|stable)$/i, '')
    .replace(/-(?:\d{8}|\d{4}-\d{2}-\d{2})$/i, '');
}

/** 去掉厂商前缀（`anthropic/claude-...`、`openai/gpt-...`）与 `:free` 之类后缀。 */
function normalizeModelId(model) {
  let id = String(model ?? '').trim();
  if (!id) return '';
  id = id.replace(/^[^/]+\//, ''); // vendor/model → model
  id = id.replace(/:[a-z0-9_-]+$/i, ''); // model:free → model
  return id.toLowerCase();
}

/**
 * 查找模型能力信息（契约 §6.5）。
 *
 * 匹配顺序：
 *  1. 精确匹配（大小写不敏感）；
 *  2. 去掉 `-latest` / 日期后缀后精确匹配；
 *  3. 前缀匹配：注册表 id 是请求 id 的前缀（请求名带日期 / preview / 长版本号）。
 *
 * 匹配不到时返回 `null`（**绝不抛错**），依赖模型能力的检测器据此 `skip`。
 *
 * @param {string} provider
 * @param {string} model
 * @returns {ModelInfo|null}
 */
export function lookupModel(provider, model) {
  const providerId = normalizeProviderId(provider);
  if (!providerId) return null;
  const list = MODEL_REGISTRY[providerId];
  if (!Array.isArray(list)) return null;

  const requested = normalizeModelId(model);
  if (!requested) return null;

  // 1) 精确匹配
  let found = list.find((entry) => entry.id.toLowerCase() === requested);
  if (found) return { ...found };

  // 2) 去掉版本后缀后精确匹配
  const requestedBase = stripVersionSuffix(requested);
  found = list.find((entry) => stripVersionSuffix(entry.id.toLowerCase()) === requestedBase);
  if (found) return { ...found };

  // 3) 前缀匹配：请求名以「注册表 id + 分隔符」开头（最长匹配优先）
  const sorted = [...list].sort((a, b) => b.id.length - a.id.length);
  for (const entry of sorted) {
    const id = entry.id.toLowerCase();
    if (requested === id || requested.startsWith(`${id}-`) || requested.startsWith(`${id}.`)) {
      return { ...entry };
    }
  }

  return null;
}

/**
 * 某协议的可选模型列表（供 UI 下拉）。未知协议返回空数组。
 *
 * @param {string} provider
 * @returns {ModelInfo[]}
 */
export function suggestModels(provider) {
  const providerId = normalizeProviderId(provider);
  const list = providerId ? MODEL_REGISTRY[providerId] : null;
  if (!Array.isArray(list)) return [];
  return list.map((entry) => ({ ...entry }));
}

/** 解析默认模型（未知协议回落到 openai 默认模型）。 */
export function defaultModelFor(provider) {
  const providerId = normalizeProviderId(provider) || 'openai';
  return DEFAULT_MODELS[providerId] || DEFAULT_MODELS.openai;
}

export default {
  MODEL_REGISTRY,
  DEFAULT_MODELS,
  lookupModel,
  suggestModels,
  defaultModelFor,
  normalizeProviderId
};
