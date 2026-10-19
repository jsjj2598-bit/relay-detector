/**
 * src/ui/auth-api.js —— 「上游真伪」引擎（契约 v2）的防御性访问层。
 *
 * 允许的唯一入口（契约 6.6）：
 *   src/core/auth/index.js  → runAuthenticity / estimateCost / AUTH_MODES
 *   src/core/auth/models.js → suggestModels / MODEL_REGISTRY / lookupModel
 *
 * auth-engine 与本模块并行开发，因此这里全部使用 **动态 import + try/catch**：
 * - 模块尚不存在 / 导出不完整 / 加载抛错时，本模块不会抛异常；
 * - 调用方拿到 { ok: false, error }，页面其余功能照常可用；
 * - 只有在用户选择「真伪 / 完整」档位时才提示「真伪引擎未就绪」。
 *
 * 注意：本文件不 import 任何 rules/** 或 providers/**（契约 2.6）。
 */

const AUTH_INDEX_SPEC = '../core/auth/index.js';
const AUTH_MODELS_SPEC = '../core/auth/models.js';

/** 契约 6.6 的档位顺序，用于 UI 兜底展示。 */
export const AUTH_MODE_ORDER = ['quick', 'standard', 'full'];

const state = {
  module: null,
  moduleError: null,
  modulePromise: null,
  moduleSettled: false,
  models: null,
  modelsError: null,
  modelsPromise: null,
  modelsSettled: false
};

/** 把任意抛出物转成可展示的 Error。 */
function toError(value) {
  if (value instanceof Error) return value;
  return new Error(String(value === undefined ? '未知错误' : value));
}

/**
 * 当前真伪引擎状态快照。
 * @returns {{ready:boolean, modelsReady:boolean, loading:boolean,
 *   error:Error|null, modelsError:Error|null}}
 */
export function getAuthStatus() {
  return {
    ready: Boolean(state.module && typeof state.module.runAuthenticity === 'function'),
    modelsReady: Boolean(state.models && typeof state.models.suggestModels === 'function'),
    loading: Boolean(state.modulePromise) && !state.moduleSettled,
    error: state.moduleError,
    modelsError: state.modelsError
  };
}

/**
 * 加载真伪引擎主模块。永不 reject。
 * @param {boolean} [force] 强制重新加载
 * @returns {Promise<{ok:boolean, module?:object, error?:Error}>}
 */
export async function loadAuthModule(force = false) {
  if (state.module && !force) return { ok: true, module: state.module };
  if (state.modulePromise && !force) return state.modulePromise;

  state.moduleSettled = false;
  state.modulePromise = (async () => {
    try {
      const mod = await import(AUTH_INDEX_SPEC);
      const problems = [];
      if (!mod || typeof mod.runAuthenticity !== 'function') problems.push('缺少 runAuthenticity()');
      if (!mod || typeof mod.estimateCost !== 'function') problems.push('缺少 estimateCost()');
      if (!mod || !mod.AUTH_MODES) problems.push('缺少 AUTH_MODES');
      if (problems.length) {
        state.module = null;
        state.moduleError = new Error(`真伪引擎导出不符合契约 6.6：${problems.join('、')}`);
        return { ok: false, error: state.moduleError };
      }
      state.module = mod;
      state.moduleError = null;
      return { ok: true, module: mod };
    } catch (error) {
      state.module = null;
      state.moduleError = toError(error);
      return { ok: false, error: state.moduleError };
    } finally {
      state.moduleSettled = true;
    }
  })();

  return state.modulePromise;
}

/**
 * 加载模型能力表（用于模型下拉）。永不 reject。
 * @returns {Promise<{ok:boolean, module?:object, error?:Error}>}
 */
export async function loadAuthModels(force = false) {
  if (state.models && !force) return { ok: true, module: state.models };
  if (state.modelsPromise && !force) return state.modelsPromise;

  state.modelsSettled = false;
  state.modelsPromise = (async () => {
    try {
      const mod = await import(AUTH_MODELS_SPEC);
      if (!mod || typeof mod.suggestModels !== 'function') {
        state.models = null;
        state.modelsError = new Error('模型能力表不符合契约 6.5：缺少 suggestModels()');
        return { ok: false, error: state.modelsError };
      }
      state.models = mod;
      state.modelsError = null;
      return { ok: true, module: mod };
    } catch (error) {
      state.models = null;
      state.modelsError = toError(error);
      return { ok: false, error: state.modelsError };
    } finally {
      state.modelsSettled = true;
    }
  })();

  return state.modelsPromise;
}

/**
 * 取某协议族的建议模型列表（契约 6.5）。模型表未就绪时返回空数组。
 * @param {'openai'|'anthropic'|'gemini'} provider
 * @returns {Array<{id:string, thinking?:string|null, supportsTools?:boolean, contextWindow?:number}>}
 */
export function suggestModels(provider) {
  const mod = state.models;
  if (!mod || typeof mod.suggestModels !== 'function') return [];
  try {
    const list = mod.suggestModels(provider);
    if (!Array.isArray(list)) return [];
    return list.filter((item) => item && typeof item === 'object' && typeof item.id === 'string' && item.id);
  } catch {
    return [];
  }
}

/** 模型能力表里 ALL provider 的建议模型（provider=auto 时使用）。 */
export function suggestAllModels() {
  const out = [];
  for (const provider of ['openai', 'anthropic', 'gemini']) {
    for (const model of suggestModels(provider)) {
      out.push({ provider, ...model });
    }
  }
  return out;
}

/** AUTH_MODES 的可用取值（模块未就绪时按契约兜底）。 */
export function getAuthModes() {
  const modes = state.module && state.module.AUTH_MODES;
  const values = [];
  if (Array.isArray(modes)) {
    for (const item of modes) {
      if (typeof item === 'string' && item) values.push(item);
      else if (item && typeof item === 'object' && typeof item.id === 'string') values.push(item.id);
      else if (item && typeof item === 'object' && typeof item.mode === 'string') values.push(item.mode);
    }
  } else if (modes && typeof modes === 'object') {
    values.push(...Object.keys(modes));
  }
  const filtered = values.filter((mode) => mode === 'quick' || mode === 'standard' || mode === 'full');
  return filtered.length ? filtered : AUTH_MODE_ORDER.slice();
}

/** 数值归一：非有限数一律当作缺省值。 */
function safeInt(value, fallback = 0) {
  const n = typeof value === 'number' ? value : Number(value);
  return Number.isFinite(n) ? Math.max(0, Math.round(n)) : fallback;
}

/**
 * 归一化 estimateCost 的返回值（契约 6.6：{requests, promptTokens, completionTokens, note}）。
 * 解析不了的字段一律补 0 / 空串，绝不抛错。
 */
export function normalizeCost(cost) {
  const raw = cost && typeof cost === 'object' ? cost : {};
  return {
    requests: safeInt(raw.requests, 0),
    promptTokens: safeInt(raw.promptTokens, 0),
    completionTokens: safeInt(raw.completionTokens, 0),
    note: typeof raw.note === 'string' ? raw.note : ''
  };
}

/**
 * 发请求前的费用预估（契约 6.6）。
 * @param {{provider?:string, model?:string, mode?:string}} params
 * @returns {{ok:true, cost:{requests:number,promptTokens:number,completionTokens:number,note:string}}
 *   | {ok:false, code:'auth_module_missing'|'estimate_failed', error:string}}
 */
export function estimateAuthCost(params = {}) {
  const mod = state.module;
  if (!mod || typeof mod.estimateCost !== 'function') {
    return {
      ok: false,
      code: 'auth_module_missing',
      error: '真伪引擎未就绪，无法预估请求数与 token（页面其余功能不受影响）。'
    };
  }
  try {
    const cost = mod.estimateCost({
      provider: params.provider,
      model: params.model,
      mode: params.mode
    });
    if (!cost || typeof cost !== 'object') {
      return { ok: false, code: 'estimate_failed', error: 'estimateCost() 的返回值不符合契约 6.6。' };
    }
    return { ok: true, cost: normalizeCost(cost) };
  } catch (error) {
    return { ok: false, code: 'estimate_failed', error: `费用预估失败：${toError(error).message}` };
  }
}

/**
 * 运行真伪检测（契约 6.6）。永不 reject：异常被转成 { ok:false }。
 * @param {{provider:string, baseUrl:string, apiKey:string, model:string,
 *   mode:string, transport?:Function, options?:object}} args
 * @returns {Promise<{ok:true, result:object} | {ok:false, code:string, error:string}>}
 */
export async function runAuthDetection(args = {}) {
  const loaded = await loadAuthModule();
  if (!loaded.ok) {
    return {
      ok: false,
      code: 'auth_module_missing',
      error: loaded.error ? loaded.error.message : '真伪引擎未就绪。'
    };
  }
  try {
    const result = await state.module.runAuthenticity({
      provider: args.provider,
      baseUrl: args.baseUrl,
      apiKey: args.apiKey,
      model: args.model,
      mode: args.mode,
      transport: args.transport,
      options: args.options && typeof args.options === 'object' ? args.options : {}
    });
    if (!result || typeof result !== 'object') {
      return { ok: false, code: 'auth_bad_result', error: 'runAuthenticity() 未返回符合契约 6.6 的报告对象。' };
    }
    return { ok: true, result };
  } catch (error) {
    return { ok: false, code: 'auth_run_failed', error: toError(error).message };
  }
}

/** 简短错误文案：去掉堆栈，只保留第一行。 */
export function describeAuthError(error) {
  if (!error) return '';
  const message = typeof error === 'string' ? error : error.message || String(error);
  return String(message).split('\n')[0].slice(0, 300);
}
