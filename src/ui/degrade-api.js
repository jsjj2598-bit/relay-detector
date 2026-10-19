/**
 * src/ui/degrade-api.js —— 「降智诊断」引擎（契约 v3）的防御性访问层。
 *
 * 允许的唯一入口（契约 10.2 / 10.3）：
 *   src/core/degrade/index.js
 *     → parseLogFiles({ files, limits })       （异步）
 *     → analyzeDegradation({ records, options })（同步）
 *     → SUPPORTED_FORMATS / DEGRADATION_METRICS（可选，用于 UI 展示）
 *
 * degrade-core 与本模块并行开发，因此这里全部使用 **动态 import + try/catch**：
 * 模块尚不存在 / 导出不完整 / 加载抛错时，本模块不会抛异常；
 * 调用方拿到 { ok:false }，页面其余功能（连接轴 / 真伪轴）照常可用，
 * 只在降智诊断区提示「降智诊断引擎未就绪」，绝不白屏。
 *
 * 隐私红线（契约 §9）：
 * - 本文件不得发起任何网络请求，不得读写 localStorage；
 * - 日志文本只作为参数在内存中传递给引擎。
 */

const DEGRADE_INDEX_SPEC = '../core/degrade/index.js';

/** 支持的日志格式中文名（核心模块未就绪时的兜底；与 docs/LOG-FORMATS.md 对齐）。 */
export const FORMAT_LABELS = {
  'claude-code': 'Claude Code 会话 JSONL',
  'api-log': '通用 API 请求日志 JSONL',
  'usage-csv': '用量 / 账单 CSV',
  'chatgpt-export': 'ChatGPT 导出 conversations.json',
  'codex-rollout': 'Codex CLI 会话日志 JSONL',
  generic: '未识别（通用）',
  unknown: '未识别'
};

const state = {
  module: null,
  error: null,
  promise: null,
  settled: false
};

function toError(value) {
  if (value instanceof Error) return value;
  return new Error(String(value === undefined ? '未知错误' : value));
}

/** 当前降智诊断引擎状态快照。 */
export function getDegradeStatus() {
  return {
    ready: Boolean(state.module
      && typeof state.module.parseLogFiles === 'function'
      && typeof state.module.analyzeDegradation === 'function'),
    loading: Boolean(state.promise) && !state.settled,
    error: state.error
  };
}

/**
 * 加载降智诊断引擎主模块。永不 reject。
 * @param {boolean} [force]
 * @returns {Promise<{ok:boolean, module?:object, error?:Error}>}
 */
export async function loadDegradeModule(force = false) {
  if (state.module && !force) return { ok: true, module: state.module };
  if (state.promise && !force) return state.promise;

  state.settled = false;
  state.promise = (async () => {
    try {
      const mod = await import(DEGRADE_INDEX_SPEC);
      const problems = [];
      if (!mod || typeof mod.parseLogFiles !== 'function') problems.push('缺少 parseLogFiles()');
      if (!mod || typeof mod.analyzeDegradation !== 'function') problems.push('缺少 analyzeDegradation()');
      if (problems.length) {
        state.module = null;
        state.error = new Error(`降智诊断引擎导出不符合契约 10.2/10.3：${problems.join('、')}`);
        return { ok: false, error: state.error };
      }
      state.module = mod;
      state.error = null;
      return { ok: true, module: mod };
    } catch (error) {
      state.module = null;
      state.error = toError(error);
      return { ok: false, error: state.error };
    } finally {
      state.settled = true;
    }
  })();

  return state.promise;
}

/**
 * 支持格式列表（用于帮助文案；核心未就绪时返回契约规定的四种 + Codex rollout）。
 * @returns {Array<{id:string, label:string}>}
 */
export function getSupportedFormats() {
  const fallback = ['claude-code', 'api-log', 'usage-csv', 'chatgpt-export', 'codex-rollout']
    .map((id) => ({ id, label: FORMAT_LABELS[id] }));
  const formats = state.module && state.module.SUPPORTED_FORMATS;
  if (!formats) return fallback;

  const list = [];
  if (Array.isArray(formats)) {
    for (const item of formats) {
      if (typeof item === 'string' && item) list.push({ id: item, label: FORMAT_LABELS[item] || item });
      else if (item && typeof item === 'object') {
        const id = String(item.id || item.format || item.value || '');
        if (id) list.push({ id, label: String(item.label || item.name || FORMAT_LABELS[id] || id) });
      }
    }
  } else if (typeof formats === 'object') {
    for (const [id, label] of Object.entries(formats)) {
      if (typeof label === 'string') list.push({ id, label });
    }
  }
  return list.length ? list : fallback;
}

/** 格式中文名（未知格式原样返回）。 */
export function formatLabel(format) {
  if (!format) return FORMAT_LABELS.unknown;
  return FORMAT_LABELS[String(format)] || String(format);
}

/**
 * 解析多个日志文件（契约 10.2）。永不 reject。
 * @param {{files:Array<{name:string,text:string}>, limits?:object}} args
 * @returns {Promise<{ok:true, result:object} | {ok:false, code:string, error:string}>}
 */
export async function parseLogFilesSafe(args = {}) {
  const loaded = await loadDegradeModule();
  if (!loaded.ok) {
    return {
      ok: false,
      code: 'degrade_module_missing',
      error: loaded.error ? loaded.error.message : '降智诊断引擎未就绪。'
    };
  }
  try {
    const result = await state.module.parseLogFiles({
      files: Array.isArray(args.files) ? args.files : [],
      limits: args.limits && typeof args.limits === 'object' ? args.limits : {}
    });
    if (!result || typeof result !== 'object') {
      return { ok: false, code: 'degrade_bad_result', error: 'parseLogFiles() 未返回符合契约 10.2 的结果对象。' };
    }
    return { ok: true, result };
  } catch (error) {
    return { ok: false, code: 'degrade_parse_failed', error: toError(error).message };
  }
}

/**
 * 分析规范化记录（契约 10.3）。永不 reject。
 * @param {{records:Array<object>, options?:object}} args
 * @returns {Promise<{ok:true, result:object} | {ok:false, code:string, error:string}>}
 */
export async function analyzeDegradationSafe(args = {}) {
  const loaded = await loadDegradeModule();
  if (!loaded.ok) {
    return {
      ok: false,
      code: 'degrade_module_missing',
      error: loaded.error ? loaded.error.message : '降智诊断引擎未就绪。'
    };
  }
  try {
    const result = await state.module.analyzeDegradation({
      records: Array.isArray(args.records) ? args.records : [],
      options: args.options && typeof args.options === 'object' ? args.options : {}
    });
    if (!result || typeof result !== 'object') {
      return { ok: false, code: 'degrade_bad_result', error: 'analyzeDegradation() 未返回符合契约 10.3 的报告对象。' };
    }
    return { ok: true, result };
  } catch (error) {
    return { ok: false, code: 'degrade_analyze_failed', error: toError(error).message };
  }
}

/** 简短错误文案：去掉堆栈，只保留第一行。 */
export function describeDegradeError(error) {
  if (!error) return '';
  const message = typeof error === 'string' ? error : error.message || String(error);
  return String(message).split('\n')[0].slice(0, 300);
}
