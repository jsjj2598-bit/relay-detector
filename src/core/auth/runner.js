/**
 * 真伪检测运行器（契约 v2 §6.6 / §6.7）。
 *
 * 职责：
 *  - 档位编排（quick 3 项 / standard 8 项 / full 10 项）；
 *  - `maxRequests` 硬上限（命中后剩余检测器 `skip`，reason: `request_budget_exhausted`）；
 *  - **串行**执行（默认 concurrency: 1，避免触发上游风控）；
 *  - 每请求超时 + AbortSignal；
 *  - 检测器异常兜底（run 绝不把异常抛给调用方）；
 *  - 被动检测器 `observe()` 分发与 `finalize()`；
 *  - cost 统计（requests / promptTokens / completionTokens）；
 *  - API key 脱敏（报告中绝不出现完整 key）。
 *
 * `runAuthenticity()` **绝不抛异常**：任何内部错误都降级为 `verdict: 'invalid'` 的报告。
 */
import { AUTH_DETECTORS, detectorsForMode } from './detectors/index.js';
import { buildResult, maskApiKey, safeText, toFiniteNumber } from './base.js';
import {
  computeTotal,
  effectiveVerdict,
  fatalRunError,
  summaryText
} from './scorer.js';
import { getBaseline } from './baselines.js';
import { lookupModel, suggestModels } from './models.js';
import {
  DEFAULT_MODELS,
  extractUsage,
  normalizeProvider,
  readTransportResponse,
  resolveBaseUrl,
  resolveModel
} from './protocol.js';

/** 检测档位（契约 §6.6 的 mode 枚举）。 */
export const AUTH_MODES = Object.freeze(['quick', 'standard', 'full']);

/** 档位中文说明（UI 可直接用）。 */
export const AUTH_MODE_LABELS = Object.freeze({
  quick: '快速（只跑 3 项低成本检测）',
  standard: '标准（8 项检测，推荐）',
  full: '完整（10 项检测，含流式一致性）'
});

/** 默认请求硬上限（契约 §6.6 示例）。 */
export const DEFAULT_MAX_REQUESTS = 24;
/** 默认单请求超时。 */
export const DEFAULT_TIMEOUT_MS = 60000;

const REPORT_SCHEMA = 1;

const clamp = (value, lo, hi) => Math.min(hi, Math.max(lo, value));

/** 各检测器「预计请求数」与「单请求 token 上界估算」（供 estimateCost 使用）。 */
const REQUEST_PLAN = {
  protocol_shape: () => 1,
  cross_vendor_leak: () => 0,
  model_consistency: () => 3,
  thinking_signature: (ctx) => (ctx.provider === 'anthropic' && ctx.modelInfo?.thinking ? 1 : 0),
  message_id: () => 0,
  token_usage: () => 1,
  structured_output: () => 1,
  capability_tools: (ctx) => (ctx.modelInfo && ctx.modelInfo.supportsTools !== false ? 1 : 0),
  stream_integrity: () => 2,
  token_parity: (ctx) => (getBaseline(ctx.provider, ctx.model) ? 1 : 0)
};

const TOKEN_PLAN = {
  protocol_shape: { prompt: 40, completion: 24 },
  model_consistency: { prompt: 40, completion: 80 },
  thinking_signature: { prompt: 160, completion: 2600 },
  token_usage: { prompt: 50, completion: 90 },
  structured_output: { prompt: 90, completion: 60 },
  capability_tools: { prompt: 160, completion: 90 },
  stream_integrity: { prompt: 70, completion: 200 },
  token_parity: { prompt: 50, completion: 40 }
};

const COST_NOTE =
  'requests / promptTokens / completionTokens 来自本次实际发出的请求与上游返回的 usage 汇总；' +
  '缺失 usage 的响应记为 0。thinking 的思考 token 计入 completionTokens。';

/* ------------------------------------------------------------------ */
/* 输入归一化                                                           */
/* ------------------------------------------------------------------ */

function normalizeAuthInput(input) {
  const raw = input && typeof input === 'object' ? input : {};
  const provider = normalizeProvider(raw.provider);
  const baseUrl = resolveBaseUrl(provider, raw.baseUrl);
  const model = resolveModel(provider, raw.model);
  const mode = AUTH_MODES.includes(raw.mode) ? raw.mode : 'standard';
  const apiKey = typeof raw.apiKey === 'string' ? raw.apiKey : '';

  const optionInput = raw.options && typeof raw.options === 'object' ? raw.options : {};
  const options = {
    timeoutMs: clamp(toFiniteNumber(optionInput.timeoutMs, DEFAULT_TIMEOUT_MS), 500, 300000),
    signal: optionInput.signal && typeof optionInput.signal === 'object' ? optionInput.signal : null,
    maxRequests: clamp(
      Math.floor(toFiniteNumber(optionInput.maxRequests, DEFAULT_MAX_REQUESTS)),
      0,
      200
    ),
    concurrency: 1, // 契约：默认串行，避免触发风控
    longContext: optionInput.longContext === true
  };

  // 注入的 transport 优先（engine / UI / 测试都必须能离线注入）。
  // 没有注入时：只有在提供了 API Key 的情况下才回落到 globalThis.fetch，
  // 避免「没 key 也没 transport」的调用在测试/Node 环境里发出无意义的网络请求。
  let transport = typeof raw.transport === 'function' ? raw.transport : null;
  if (!transport && apiKey && typeof globalThis.fetch === 'function') {
    transport = globalThis.fetch.bind(globalThis);
  }

  return {
    provider,
    baseUrl,
    model,
    mode,
    apiKey,
    options,
    transport,
    modelInfo: lookupModel(provider, model),
    input: raw
  };
}

/* ------------------------------------------------------------------ */
/* 上下文与请求执行                                                      */
/* ------------------------------------------------------------------ */

function budgetExceededError(max) {
  const error = new Error(`已达到本次请求硬上限（maxRequests=${max}），为避免继续扣费已停止发请求。`);
  error.name = 'BudgetExceededError';
  error.code = 'request_budget_exhausted';
  return error;
}

/** 请求头脱敏：exchange 里永远不保留完整 key。 */
function maskRequestHeaders(headers) {
  const out = {};
  if (!headers || typeof headers !== 'object') return out;
  for (const [name, value] of Object.entries(headers)) {
    const key = String(name).toLowerCase();
    if (key === 'authorization' || key === 'x-api-key' || key === 'x-goog-api-key') out[key] = '••••';
    else out[key] = Array.isArray(value) ? value.join(', ') : String(value);
  }
  return out;
}

function classifyAbort(error, timedOut) {
  const name = String(error?.name || '');
  const message = error?.message ? String(error.message) : String(error ?? '未知错误');
  if (timedOut) return { kind: 'timeout', message: `请求超时：${message}` };
  if (/abort/i.test(name) || /aborted/i.test(message)) return { kind: 'aborted', message };
  return { kind: 'network', message };
}

function createContext(normalized) {
  const { provider, baseUrl, model, mode, modelInfo, apiKey, options, transport } = normalized;

  const ctx = {
    provider,
    baseUrl,
    model,
    mode,
    modelInfo,
    apiKey,
    hasKey: Boolean(apiKey),
    options,
    transport,
    exchanges: [],
    budget: { max: options.maxRequests, used: 0 },
    cost: {
      requests: 0,
      promptTokens: 0,
      completionTokens: 0,
      note: COST_NOTE
    },
    warnings: [],
    passiveDetectors: [],
    fatal: null,
    authState: {},
    startedAt: Date.now(),

    /** 追加一条去重后的 warning。 */
    note(message) {
      const text = safeText(message);
      if (text && !ctx.warnings.includes(text)) ctx.warnings.push(text);
    },

    /** 取某用途的最后一次请求。 */
    lastExchange(purpose) {
      const target = safeText(purpose);
      for (let i = ctx.exchanges.length - 1; i >= 0; i -= 1) {
        if (ctx.exchanges[i].purpose === target) return ctx.exchanges[i];
      }
      return null;
    },

    /** 取某用途的全部请求。 */
    exchangesOf(purpose) {
      const target = safeText(purpose);
      return ctx.exchanges.filter((exchange) => exchange.purpose === target);
    },

    /**
     * 发一次请求。**唯一**可能抛出的异常是 BudgetExceededError
     * （由 runner 转换成 `status: 'skip'`，reason: `request_budget_exhausted`）。
     */
    async request(spec = {}) {
      const startedAt = Date.now();
      const purpose = safeText(spec.purpose) || 'chat';
      const exchange = {
        id: `${purpose}#${ctx.budget.used + 1}`,
        purpose,
        request: {
          method: safeText(spec.method) || 'POST',
          url: safeText(spec.url),
          headers: maskRequestHeaders(spec.headers),
          body: spec.body && typeof spec.body === 'object' ? spec.body : null,
          startedAt
        },
        response: null,
        error: null,
        meta: {
          purpose,
          model: safeText(spec.model) || model,
          stream: spec.stream === true,
          paid: true
        },
        durationMs: 0
      };

      if (typeof ctx.transport !== 'function') {
        exchange.error = {
          kind: 'network',
          message: '当前环境没有可用的 transport（需要注入与 fetch 同签名的函数）。'
        };
        exchange.durationMs = Date.now() - startedAt;
        ctx.exchanges.push(exchange);
        ctx.dispatchToPassive(exchange);
        return exchange;
      }

      // 硬上限：用尽了就抛预算异常，runner 会把它转成 skip（不是 error）
      if (ctx.budget.used >= ctx.budget.max) throw budgetExceededError(ctx.budget.max);
      ctx.budget.used += 1;
      ctx.cost.requests = ctx.budget.used;
      exchange.id = `${purpose}#${ctx.budget.used}`;

      const timeoutMs = clamp(
        toFiniteNumber(spec.timeoutMs, ctx.options.timeoutMs),
        300,
        300000
      );
      const init = { method: exchange.request.method, headers: { ...(spec.headers || {}) } };
      if (spec.body != null) init.body = typeof spec.body === 'string' ? spec.body : JSON.stringify(spec.body);

      const state = { timedOut: false };
      let controller = null;
      let timer = null;
      let onExternalAbort = null;
      const externalSignal = ctx.options.signal;
      if (typeof AbortController === 'function') {
        controller = new AbortController();
        init.signal = controller.signal;
        if (externalSignal && externalSignal.aborted) {
          try {
            controller.abort();
          } catch {
            /* ignore */
          }
        } else if (externalSignal && typeof externalSignal.addEventListener === 'function') {
          onExternalAbort = () => {
            try {
              controller.abort();
            } catch {
              /* ignore */
            }
          };
          externalSignal.addEventListener('abort', onExternalAbort, { once: true });
        }
      }

      try {
        const pending = (() => {
          try {
            return Promise.resolve(ctx.transport(exchange.request.url, init));
          } catch (error) {
            return Promise.reject(error);
          }
        })();
        const timeoutPromise = new Promise((_, reject) => {
          timer = setTimeout(() => {
            state.timedOut = true;
            try {
              controller?.abort();
            } catch {
              /* ignore */
            }
            const error = new Error(`请求在 ${timeoutMs}ms 内未完成`);
            error.name = 'TimeoutError';
            reject(error);
          }, timeoutMs);
        });
        const res = await Promise.race([pending, timeoutPromise]);
        exchange.response = await readTransportResponse(res);
        const usage = exchange.response?.bodyJson
          ? extractUsage(exchange.response.bodyJson, provider)
          : null;
        if (usage) {
          if (typeof usage.promptTokens === 'number') ctx.cost.promptTokens += usage.promptTokens;
          if (typeof usage.completionTokens === 'number') ctx.cost.completionTokens += usage.completionTokens;
        }
      } catch (error) {
        exchange.error = classifyAbort(error, state.timedOut);
      } finally {
        if (timer) clearTimeout(timer);
        if (onExternalAbort && externalSignal && typeof externalSignal.removeEventListener === 'function') {
          try {
            externalSignal.removeEventListener('abort', onExternalAbort);
          } catch {
            /* ignore */
          }
        }
      }

      exchange.durationMs = Date.now() - startedAt;
      ctx.exchanges.push(exchange);
      ctx.cost.requests = ctx.budget.used;
      ctx.dispatchToPassive(exchange);
      return exchange;
    },

    dispatchToPassive(exchange) {
      for (const detector of ctx.passiveDetectors) {
        try {
          detector.observe(ctx, exchange);
        } catch (error) {
          ctx.note(`被动检测器「${detector.name}」观察失败：${error?.message || String(error)}`);
        }
      }
    }
  };

  return ctx;
}

/* ------------------------------------------------------------------ */
/* 结果汇总与报告                                                       */
/* ------------------------------------------------------------------ */

function skipResult(detector, reason, message, extraDetails = {}) {
  return buildResult(detector, {
    status: 'skip',
    score: 0,
    reason,
    details: { ...extraDetails, reason, message }
  });
}

function collectCriticalIssues(results) {
  const out = [];
  for (const result of results) {
    if (!result) continue;
    for (const issue of result.criticalIssues || []) {
      out.push({
        detector: result.name,
        code: safeText(issue.code) || 'unknown',
        message: safeText(issue.message) || '未提供说明',
        evidence: issue.evidence !== undefined ? issue.evidence : { note: '未提供证据' }
      });
    }
  }
  return out;
}

function buildWarnings(ctx, results, runError) {
  const warnings = [];
  const push = (text) => {
    if (text && !warnings.includes(text)) warnings.push(text);
  };

  if (!ctx.apiKey) {
    push('未提供 API Key：所有需要鉴权的请求预计会失败，真伪结论可能为「检测无效」。');
  }

  for (const result of results) {
    if (!result || result.status !== 'skip') continue;
    const message = safeText(result.details?.message);
    if (result.reason === 'model_capability_missing') {
      push(`已跳过「${result.displayName}」：${message || '当前模型不支持该能力。'}`);
    } else if (result.reason === 'unknown_model') {
      push(`已跳过「${result.displayName}」：${message || '模型不在内置能力表中。'}`);
    } else if (result.reason === 'no_baseline') {
      push(`「${result.displayName}」已跳过：缺少官方基线（skip 不计入总分）。`);
    }
  }

  if (results.some((result) => result?.reason === 'request_budget_exhausted')) {
    push(`已达到本次请求硬上限（maxRequests=${ctx.budget.max}），剩余检测器已跳过以避免继续扣费。`);
  }

  const errorCount = results.filter((result) => result?.status === 'error').length;
  if (errorCount > 0) {
    push(`${errorCount} 个检测器因网络 / 上游错误未能完成（error 不进入加权分母，不影响总分）。`);
  }

  if (runError) {
    push(
      `上游返回致命错误（${runError.code}）：${runError.message}。本次真伪检测判为「检测无效」，不代表该站质量差，建议换 Key 或换模型重试。`
    );
  }

  const measured = results.some((result) => result && (result.status === 'pass' || result.status === 'fail'));
  if (!runError && !measured) {
    push('没有任何检测器得到有效测量，真伪结论为「检测无效」（不是低分）。');
  }

  if (ctx.options.longContext) {
    push('本次实现不会发送长上下文探针（契约 §6.7 第 3 条），longContext 选项已被忽略。');
  }

  return warnings;
}

async function runInner(normalized, startedAt) {
  const ctx = createContext(normalized);
  // 被动检测器先注册，才能观察到后续所有主动请求的响应
  ctx.passiveDetectors = AUTH_DETECTORS.filter((detector) => detector.kind === 'passive');

  const results = new Array(AUTH_DETECTORS.length).fill(null);
  const pendingPassive = [];

  for (let index = 0; index < AUTH_DETECTORS.length; index += 1) {
    const detector = AUTH_DETECTORS[index];

    // 1) 档位过滤
    if (!detector.modes.includes(normalized.mode)) {
      results[index] = skipResult(
        detector,
        'mode_not_selected',
        `当前档位（${normalized.mode}）不运行该检测器，需要 ${detector.modes.join(' / ')} 档。`
      );
      continue;
    }

    // 2) 协议过滤
    if (Array.isArray(detector.provider) && detector.provider.length > 0 && !detector.provider.includes(normalized.provider)) {
      results[index] = skipResult(
        detector,
        'provider_not_applicable',
        `该检测器仅适用于 ${detector.provider.join(' / ')} 协议，当前协议为 ${normalized.provider}。`
      );
      continue;
    }

    // 3) 模型能力 / 前置条件过滤
    let applies = true;
    try {
      applies = typeof detector.appliesTo === 'function' ? detector.appliesTo(ctx) !== false : true;
    } catch (error) {
      applies = false;
    }
    if (!applies) {
      let reason = 'not_applicable';
      let message = '当前条件下无法执行该检测器，已跳过（skip 不计入加权分母）。';
      try {
        reason = safeText(detector.skipReason?.(ctx)) || reason;
        message = safeText(detector.skipMessage?.(ctx)) || message;
      } catch {
        /* ignore */
      }
      results[index] = skipResult(detector, reason, message);
      continue;
    }

    // 4) 被动检测器：先登记，等主动检测跑完再 finalize
    if (detector.kind === 'passive') {
      pendingPassive.push({ detector, index });
      continue;
    }

    // 5) 已经命中致命错误 / 预算耗尽 → 剩余检测器 skip
    if (ctx.fatal) {
      results[index] = skipResult(
        detector,
        'fatal_run_error',
        `上游返回致命错误（${ctx.fatal.code}），检测已终止，该检测器未执行。`
      );
      continue;
    }
    if (ctx.budget.used >= ctx.budget.max) {
      results[index] = skipResult(
        detector,
        'request_budget_exhausted',
        `已达到请求硬上限（maxRequests=${ctx.budget.max}），为避免继续扣费已跳过。`
      );
      continue;
    }

    // 6) 执行主动检测器（异常一律兜底）
    const detectorStartedAt = Date.now();
    let raw;
    try {
      raw = await detector.run(ctx);
    } catch (error) {
      if (error && error.code === 'request_budget_exhausted') {
        raw = {
          status: 'skip',
          score: 0,
          reason: 'request_budget_exhausted',
          details: {
            reason: 'request_budget_exhausted',
            message: `执行过程中达到请求硬上限（maxRequests=${ctx.budget.max}），该检测器提前停止。`
          }
        };
      } else {
        raw = {
          status: 'error',
          score: 0,
          error: `检测器内部异常：${error?.message || String(error)}`,
          details: { reason: 'detector_exception' }
        };
      }
    }
    const result = buildResult(detector, {
      ...(raw && typeof raw === 'object' ? raw : {}),
      durationMs:
        raw && typeof raw.durationMs === 'number'
          ? raw.durationMs
          : Date.now() - detectorStartedAt
    });
    results[index] = result;

    const fatal = fatalRunError([result]);
    if (fatal && !ctx.fatal) ctx.fatal = fatal;
  }

  // 7) 被动检测器收尾（不额外发请求，零成本）
  for (const { detector, index } of pendingPassive) {
    const detectorStartedAt = Date.now();
    let raw;
    try {
      raw = detector.finalize(ctx);
    } catch (error) {
      raw = {
        status: 'error',
        score: 0,
        error: `被动检测器内部异常：${error?.message || String(error)}`,
        details: { reason: 'detector_exception' }
      };
    }
    results[index] = buildResult(detector, {
      ...(raw && typeof raw === 'object' ? raw : {}),
      durationMs:
        raw && typeof raw.durationMs === 'number'
          ? raw.durationMs
          : Date.now() - detectorStartedAt
    });
    const fatal = fatalRunError([results[index]]);
    if (fatal && !ctx.fatal) ctx.fatal = fatal;
  }

  const score = computeTotal(results);
  const runError = ctx.fatal || fatalRunError(results);
  const verdict = runError ? 'invalid' : effectiveVerdict(score, results);
  const criticalIssues = collectCriticalIssues(results);
  const warnings = buildWarnings(ctx, results, runError);

  const finishedAt = Date.now();
  ctx.cost.requests = ctx.budget.used;

  return {
    schema: REPORT_SCHEMA,
    provider: normalized.provider,
    model: normalized.model,
    mode: normalized.mode,
    score,
    verdict,
    summaryText: summaryText(verdict, score),
    detectors: results,
    criticalIssues,
    runError: runError || null,
    cost: { ...ctx.cost },
    warnings,
    startedAt,
    finishedAt,
    durationMs: finishedAt - startedAt
  };
}

/** 内部错误兜底报告：保证 runAuthenticity 永不抛异常。 */
function fallbackReport(normalized, startedAt, error) {
  const finishedAt = Date.now();
  return {
    schema: REPORT_SCHEMA,
    provider: normalized?.provider || 'openai',
    model: normalized?.model ?? null,
    mode: normalized?.mode || 'standard',
    score: 0,
    verdict: 'invalid',
    summaryText: '检测无效',
    detectors: [],
    criticalIssues: [],
    runError: {
      code: 'internal_error',
      message: `真伪检测内部错误：${error?.message || String(error)}`
    },
    cost: {
      requests: 0,
      promptTokens: 0,
      completionTokens: 0,
      note: '内部错误，未完成任何计费请求。'
    },
    warnings: ['真伪检测内部错误，已降级为「检测无效」。'],
    startedAt,
    finishedAt,
    durationMs: finishedAt - startedAt
  };
}

/** 递归脱敏：报告中任何位置出现完整 key 都替换为 maskApiKey() 形式。 */
export function scrubSecrets(value, apiKey, depth = 0) {
  const key = typeof apiKey === 'string' ? apiKey : '';
  if (!key) return value;
  if (depth > 12) return value;
  if (typeof value === 'string') {
    if (!value.includes(key)) return value;
    const masked = maskApiKey(key);
    let text = value.split(key).join(masked);
    const encoded = encodeURIComponent(key);
    if (encoded !== key && text.includes(encoded)) text = text.split(encoded).join(masked);
    return text;
  }
  if (Array.isArray(value)) return value.map((item) => scrubSecrets(item, key, depth + 1));
  if (value && typeof value === 'object') {
    const out = {};
    for (const [name, item] of Object.entries(value)) out[name] = scrubSecrets(item, key, depth + 1);
    return out;
  }
  return value;
}

/**
 * 执行一次上游真伪检测（契约 §6.6）。**绝不抛异常**。
 *
 * @param {{
 *   provider?: 'openai'|'anthropic'|'gemini',
 *   baseUrl?: string,
 *   apiKey?: string,
 *   model?: string,
 *   mode?: 'quick'|'standard'|'full',
 *   transport?: Function,
 *   options?: { timeoutMs?: number, signal?: object|null, maxRequests?: number, concurrency?: number, longContext?: boolean }
 * }} input
 * @returns {Promise<object>} 契约 §6.6 的 authenticity 报告
 */
export async function runAuthenticity(input = {}) {
  const startedAt = Date.now();
  let normalized;
  try {
    normalized = normalizeAuthInput(input);
  } catch (error) {
    return fallbackReport({ provider: 'openai', model: null, mode: 'standard' }, startedAt, error);
  }
  try {
    const report = await runInner(normalized, startedAt);
    return scrubSecrets(report, normalized.apiKey);
  } catch (error) {
    return scrubSecrets(fallbackReport(normalized, startedAt, error), normalized.apiKey);
  }
}

/**
 * 发出请求前的费用预估（契约 §6.6）。UI 必须在用户确认后才真正执行检测。
 *
 * @param {{provider?:string, model?:string, mode?:'quick'|'standard'|'full'}} input
 * @returns {{requests:number, promptTokens:number, completionTokens:number, note:string,
 *            breakdown:Array<{name:string, requests:number}>}}
 */
export function estimateCost(input = {}) {
  const raw = input && typeof input === 'object' ? input : {};
  const provider = normalizeProvider(raw.provider);
  const model = resolveModel(provider, raw.model);
  const mode = AUTH_MODES.includes(raw.mode) ? raw.mode : 'standard';
  const ctxLike = {
    provider,
    model,
    mode,
    modelInfo: lookupModel(provider, model)
  };

  let requests = 0;
  let promptTokens = 0;
  let completionTokens = 0;
  const breakdown = [];
  for (const detector of detectorsForMode(mode)) {
    let count = 0;
    try {
      const plan = REQUEST_PLAN[detector.name];
      count = typeof plan === 'function' ? plan(ctxLike) : 0;
    } catch {
      count = 0;
    }
    if (!count || count <= 0) continue;
    const perRequest = TOKEN_PLAN[detector.name] || { prompt: 60, completion: 80 };
    requests += count;
    promptTokens += count * perRequest.prompt;
    completionTokens += count * perRequest.completion;
    breakdown.push({ name: detector.name, requests: count });
  }

  const unknownModel = !ctxLike.modelInfo;
  const noteParts = [
    `档位「${mode}」预计发出 ${requests} 个可能计费的 chat 请求（串行执行，避免触发风控）。`,
    '本实现的请求数刻意低于契约 §6.4 备注的经验量级（standard 约 10–14 / full 约 14–20）：' +
      '每个检测器只发必要的采样请求（model_consistency 固定 3 次、stream_integrity 固定 2 条路径），' +
      '不为凑请求数发重复请求，以降低用户扣费；estimateCost 与 runner 实际请求数、cost.requests 始终一致。',
    'token 数为粗略上界估算：thinking 档按 budget 2000 估算，实际可能更高；最终费用取决于服务商单价与缓存命中。',
    '本次不会发送长上下文探针。'
  ];
  if (unknownModel) {
    noteParts.push('该模型不在内置能力表中，部分能力类检测（thinking / 工具）会 skip，实际请求数可能更少。');
  }
  if (provider === 'anthropic' && ctxLike.modelInfo?.thinking) {
    noteParts.push('包含一次 thinking 检测：max_tokens=16000，模型实际思考 token 会计费。');
  }

  return {
    requests,
    promptTokens,
    completionTokens,
    note: noteParts.join(' '),
    breakdown
  };
}

/** 供 UI 构建模型下拉：等价于 models.suggestModels，但补上默认模型兜底。 */
export function getSuggestedModels(provider) {
  const list = suggestModels(provider);
  if (list.length > 0) return list;
  const providerId = normalizeProvider(provider);
  return [{ id: DEFAULT_MODELS[providerId], label: DEFAULT_MODELS[providerId], thinking: null, supportsTools: true, contextWindow: 0 }];
}

export { AUTH_DETECTORS };

export default runAuthenticity;
