/**
 * 协议适配工具（真伪检测专用，契约 v2 §6.4）。
 *
 * 只负责「怎么按 OpenAI / Anthropic / Gemini 协议发一个 chat 请求、怎么解析响应」，
 * 不含检测逻辑，也不做网络 I/O（真正的请求与超时由 runner 的 ctx.request 完成）。
 *
 * 约束：
 *  - 纯逻辑、无 DOM 依赖，Node / 浏览器均可 import；
 *  - 任何解析函数对畸形输入都必须安全返回空值，绝不抛异常。
 */
import { joinTextBlocks, pickTextContent, safeText, toFiniteNumber } from './base.js';
import { classifyFatalText } from './scorer.js';

export const PROVIDERS = ['openai', 'anthropic', 'gemini'];

export const PROVIDER_LABELS = {
  openai: 'OpenAI / 兼容 /v1',
  anthropic: 'Anthropic Claude',
  gemini: 'Google Gemini'
};

export const DEFAULT_BASE_URLS = {
  openai: 'https://api.openai.com/v1',
  anthropic: 'https://api.anthropic.com',
  gemini: 'https://generativelanguage.googleapis.com'
};

export const DEFAULT_MODELS = {
  openai: 'gpt-4o',
  anthropic: 'claude-sonnet-4-5',
  gemini: 'gemini-2.5-flash'
};

const ANTHROPIC_VERSION = '2023-06-01';

/** 归一化协议名；未知回落到 openai（与 engine.pickProvider 默认一致）。 */
export function normalizeProvider(provider) {
  const key = safeText(provider).trim().toLowerCase();
  if (key === 'claude') return 'anthropic';
  if (key === 'google') return 'gemini';
  return PROVIDERS.includes(key) ? key : 'openai';
}

/** 解析基址：去尾斜杠；空值用协议默认基址。 */
export function resolveBaseUrl(provider, baseUrl) {
  const providerId = normalizeProvider(provider);
  const raw = safeText(baseUrl).trim();
  const value = raw || DEFAULT_BASE_URLS[providerId];
  return value.replace(/\/+$/, '');
}

/** 解析模型名：空值用协议默认模型。 */
export function resolveModel(provider, model) {
  const providerId = normalizeProvider(provider);
  const value = safeText(model).trim();
  return value || DEFAULT_MODELS[providerId];
}

/**
 * 取 API 根路径（含版本段）：
 *  - openai: `.../v1`
 *  - anthropic: `.../v1`
 *  - gemini: `.../v1beta`
 * 用户已带版本段时原样保留。
 */
export function apiRoot(provider, baseUrl) {
  const providerId = normalizeProvider(provider);
  const base = resolveBaseUrl(providerId, baseUrl);
  const version = providerId === 'gemini' ? 'v1beta' : 'v1';
  if (new RegExp(`/${version}$`, 'i').test(base)) return base;
  // 用户可能填了 .../v1 或 .../v1beta（协议填错时也容忍）
  if (/\/(v1|v1beta)$/i.test(base)) return base;
  return `${base}/${version}`;
}

/** 构造 chat 端点 URL。 */
export function chatUrl(provider, baseUrl, model, stream = false) {
  const providerId = normalizeProvider(provider);
  const root = apiRoot(providerId, baseUrl);
  if (providerId === 'openai') return `${root}/chat/completions`;
  if (providerId === 'anthropic') return `${root}/messages`;
  const modelId = encodeURIComponent(safeText(model) || DEFAULT_MODELS.gemini);
  const method = stream ? 'streamGenerateContent' : 'generateContent';
  const suffix = stream ? '?alt=sse' : '';
  return `${root}/models/${modelId}:${method}${suffix}`;
}

/** 构造鉴权 / 内容类型请求头（不会把 key 写进 URL）。 */
export function buildHeaders(provider, apiKey, options = {}) {
  const providerId = normalizeProvider(provider);
  const key = safeText(apiKey).trim();
  const headers = {
    accept: options.stream === true ? 'text/event-stream' : 'application/json',
    'content-type': 'application/json'
  };
  if (!key) return headers;
  if (providerId === 'openai') headers.authorization = `Bearer ${key}`;
  else if (providerId === 'anthropic') {
    headers['x-api-key'] = key;
    headers['anthropic-version'] = ANTHROPIC_VERSION;
  } else if (providerId === 'gemini') headers['x-goog-api-key'] = key;
  return headers;
}

/**
 * 构造 chat 请求体。
 *
 * @param {string} provider
 * @param {string} model
 * @param {{prompt?:string, messages?:Array<{role:string,content:string}>, maxTokens?:number,
 *          temperature?:number|null, stream?:boolean, patch?:object}} [options]
 */
export function chatBody(provider, model, options = {}) {
  const providerId = normalizeProvider(provider);
  const maxTokens = Math.max(1, Math.round(toFiniteNumber(options.maxTokens, 256)));
  const temperature =
    typeof options.temperature === 'number' && Number.isFinite(options.temperature)
      ? options.temperature
      : null;
  const messages =
    Array.isArray(options.messages) && options.messages.length > 0
      ? options.messages
      : [{ role: 'user', content: safeText(options.prompt) || 'ping' }];
  let body;
  if (providerId === 'openai') {
    body = { model, messages, max_tokens: maxTokens };
    if (temperature != null) body.temperature = temperature;
    if (options.stream === true) body.stream = true;
  } else if (providerId === 'anthropic') {
    body = { model, max_tokens: maxTokens, messages };
    if (temperature != null) body.temperature = temperature;
    if (options.stream === true) body.stream = true;
  } else {
    body = {
      contents: messages.map((message) => ({
        role: message.role === 'assistant' ? 'model' : 'user',
        parts: [{ text: String(message.content ?? '') }]
      })),
      generationConfig: { maxOutputTokens: maxTokens }
    };
    if (temperature != null) body.generationConfig.temperature = temperature;
  }
  if (options.patch && typeof options.patch === 'object') body = { ...body, ...options.patch };
  return body;
}

/**
 * 构造一个完整的请求描述，交给 `ctx.request()` 执行。
 *
 * @param {{provider:string, baseUrl:string, model:string, apiKey:string}} ctx
 * @param {{purpose:string, prompt?:string, maxTokens?:number, temperature?:number|null,
 *          stream?:boolean, patch?:object, timeoutMs?:number}} options
 */
export function buildChatRequest(ctx, options = {}) {
  const provider = normalizeProvider(options.provider || ctx?.provider);
  const model = safeText(options.model || ctx?.model) || DEFAULT_MODELS[provider];
  const stream = options.stream === true;
  const body = chatBody(provider, model, {
    prompt: options.prompt,
    messages: options.messages,
    maxTokens: options.maxTokens,
    temperature: options.temperature,
    stream,
    patch: options.patch
  });
  return {
    purpose: safeText(options.purpose) || 'chat',
    provider,
    model,
    method: 'POST',
    url: chatUrl(provider, ctx?.baseUrl, model, stream),
    headers: buildHeaders(provider, ctx?.apiKey, { stream }),
    body,
    stream,
    timeoutMs: options.timeoutMs
  };
}

/* ------------------------------------------------------------------ */
/* 响应解析                                                             */
/* ------------------------------------------------------------------ */

/** 响应是否成功（2xx 且拿到 JSON）。 */
export function isSuccess(exchange) {
  const response = exchange?.response;
  if (!response) return false;
  const status = Number(response.status) || 0;
  return status >= 200 && status < 300 && Boolean(response.bodyJson) && typeof response.bodyJson === 'object';
}

/** 取响应 JSON。 */
export function bodyJsonOf(exchange) {
  const body = exchange?.response?.bodyJson;
  return body && typeof body === 'object' ? body : null;
}

/** 取响应文本（安全截断由 runner 负责）。 */
export function bodyTextOf(exchange) {
  return safeText(exchange?.response?.bodyText);
}

/** 异常响应的可读摘要（用于 DetectorResult.error / details）。 */
export function errorPreview(exchange, max = 600) {
  const response = exchange?.response;
  const text = safeText(response?.bodyText);
  const trimmed = text.trim();
  if (!trimmed) return '';
  return trimmed.length > max ? `${trimmed.slice(0, max)}…` : trimmed;
}

/**
 * 判断一次请求是否失败；失败则返回可直接并入 DetectorResult 的字段。
 *
 * @param {object} exchange
 * @returns {null | {status:'error', score:number, error:string, errorKind?:string, details:object}}
 */
export function failureOf(exchange) {
  if (!exchange || typeof exchange !== 'object') {
    return {
      status: 'error',
      score: 0,
      error: '没有收到请求结果。',
      details: { reason: 'no_exchange' }
    };
  }
  if (exchange.error) {
    const kind = safeText(exchange.error.kind) || 'network';
    const message = safeText(exchange.error.message) || '未知传输错误';
    const fatal = classifyFatalText(message);
    return {
      status: 'error',
      score: 0,
      error: `请求失败（${kind}）：${message}`,
      errorKind: kind,
      details: {
        reason: 'transport_error',
        transportError: { kind, message },
        ...(fatal ? { fatal } : {})
      }
    };
  }
  const response = exchange.response;
  if (!response) {
    return {
      status: 'error',
      score: 0,
      error: '上游没有返回响应。',
      details: { reason: 'no_response' }
    };
  }
  const status = Number(response.status) || 0;
  const bodyJson = response.bodyJson && typeof response.bodyJson === 'object' ? response.bodyJson : null;
  const preview = errorPreview(exchange);

  if (status >= 200 && status < 300) {
    // 流式响应（SSE）不是 JSON，这是正常的：交给 parseStream 解析
    const bodyText = safeText(response.bodyText);
    const looksStreaming =
      exchange.meta?.stream === true ||
      /event-stream/i.test(safeText(response.contentType)) ||
      /^\s*(data:|event:)/.test(bodyText);
    if (looksStreaming) {
      if (bodyText.trim()) return null;
      return {
        status: 'error',
        score: 0,
        error: `HTTP ${status} 流式响应为空。`,
        details: { reason: 'empty_stream', httpStatus: status }
      };
    }
    if (!bodyJson) {
      return {
        status: 'error',
        score: 0,
        error: `HTTP ${status} 但响应不是合法 JSON。`,
        details: { reason: 'invalid_json', httpStatus: status, responsePreview: preview }
      };
    }
    // 有些网关在 200 里返回 { error: ... }
    if (bodyJson.error && !bodyJson.choices && !bodyJson.content && !bodyJson.candidates) {
      const fatal = classifyFatalText(`${preview} ${safeJsonText(bodyJson.error)}`);
      return {
        status: 'error',
        score: 0,
        error: `上游返回错误对象：${preview || safeJsonText(bodyJson.error) || '未知错误'}`,
        details: {
          reason: 'error_payload',
          httpStatus: status,
          responsePreview: preview,
          ...(fatal ? { fatal } : {})
        }
      };
    }
    return null;
  }

  const fatal = classifyFatalText(`${preview} ${safeJsonText(bodyJson)}`);
  return {
    status: 'error',
    score: 0,
    error: `HTTP ${status}${preview ? `：${preview}` : ''}`,
    details: {
      reason: 'http_error',
      httpStatus: status,
      responsePreview: preview,
      ...(fatal ? { fatal } : {})
    }
  };
}

/** 安全 JSON 化（最多 4000 字符）。 */
export function safeJsonText(value, max = 4000) {
  try {
    const text = JSON.stringify(value);
    if (typeof text !== 'string') return '';
    return text.length > max ? text.slice(0, max) : text;
  } catch {
    return '';
  }
}

/* ------------------------------------------------------------------ */
/* usage / 正文 / 模型回显 / 工具调用 / thinking                          */
/* ------------------------------------------------------------------ */

const numeric = (value) => (typeof value === 'number' && Number.isFinite(value) ? value : null);

/**
 * 归一化 usage。
 *
 * @returns {{promptTokens:number|null, completionTokens:number|null, totalTokens:number|null,
 *            cacheReadTokens:number|null, cacheWriteTokens:number|null, thoughtsTokens:number|null,
 *            raw:object|null, vendor:'openai'|'anthropic'|'gemini'|null}}
 */
export function extractUsage(payload, provider = '') {
  const providerId = normalizeProvider(provider);
  const empty = {
    promptTokens: null,
    completionTokens: null,
    totalTokens: null,
    cacheReadTokens: null,
    cacheWriteTokens: null,
    thoughtsTokens: null,
    raw: null,
    vendor: null
  };
  if (!payload || typeof payload !== 'object') return empty;

  if (providerId === 'anthropic') {
    const usage = payload.usage && typeof payload.usage === 'object' ? payload.usage : null;
    if (!usage) return empty;
    const promptTokens = numeric(usage.input_tokens);
    const completionTokens = numeric(usage.output_tokens);
    const totalTokens =
      promptTokens != null && completionTokens != null ? promptTokens + completionTokens : numeric(usage.total_tokens);
    return {
      promptTokens,
      completionTokens,
      totalTokens,
      cacheReadTokens: numeric(usage.cache_read_input_tokens),
      cacheWriteTokens: numeric(usage.cache_creation_input_tokens),
      thoughtsTokens: null,
      raw: usage,
      vendor: 'anthropic'
    };
  }

  if (providerId === 'gemini') {
    const usage =
      (payload.usageMetadata && typeof payload.usageMetadata === 'object' ? payload.usageMetadata : null) ||
      (payload.usage && typeof payload.usage === 'object' ? payload.usage : null);
    if (!usage) return empty;
    const promptTokens = numeric(usage.promptTokenCount) ?? numeric(usage.input_tokens);
    const completionTokens = numeric(usage.candidatesTokenCount) ?? numeric(usage.output_tokens);
    const thoughtsTokens = numeric(usage.thoughtsTokenCount) ?? numeric(usage.thoughts_tokens);
    const totalTokens = numeric(usage.totalTokenCount) ?? numeric(usage.total_tokens);
    return {
      promptTokens,
      completionTokens,
      totalTokens,
      cacheReadTokens: numeric(usage.cachedContentTokenCount),
      cacheWriteTokens: null,
      thoughtsTokens,
      raw: usage,
      vendor: 'gemini'
    };
  }

  const usage = payload.usage && typeof payload.usage === 'object' ? payload.usage : null;
  if (!usage) return empty;
  const promptTokens = numeric(usage.prompt_tokens);
  const completionTokens = numeric(usage.completion_tokens);
  const totalTokens = numeric(usage.total_tokens);
  return {
    promptTokens,
    completionTokens,
    totalTokens,
    cacheReadTokens: numeric(usage.prompt_tokens_details?.cached_tokens),
    cacheWriteTokens: null,
    thoughtsTokens: numeric(usage.completion_tokens_details?.reasoning_tokens),
    raw: usage,
    vendor: 'openai'
  };
}

/** 提取助手正文文本。 */
export function extractAssistantText(payload, provider = '') {
  return pickTextContent(payload, normalizeProvider(provider));
}

/** 提取 stop / finish reason。 */
export function extractStopReason(payload, provider = '') {
  if (!payload || typeof payload !== 'object') return null;
  const providerId = normalizeProvider(provider);
  if (providerId === 'openai') {
    const choice = Array.isArray(payload.choices) ? payload.choices[0] : null;
    return safeText(choice?.finish_reason) || null;
  }
  if (providerId === 'anthropic') return safeText(payload.stop_reason) || null;
  const candidate = Array.isArray(payload.candidates) ? payload.candidates[0] : null;
  return safeText(candidate?.finishReason) || null;
}

/** 提取响应里的 model 回显。 */
export function extractModelEcho(payload) {
  if (!payload || typeof payload !== 'object') return '';
  if (typeof payload.model === 'string') return payload.model;
  if (typeof payload.modelVersion === 'string') return payload.modelVersion;
  return '';
}

/** 去掉 `-latest` / 日期后缀 / vendor 前缀，便于比较模型回显。 */
export function normalizeModelName(value) {
  let id = safeText(value).trim().toLowerCase();
  if (!id) return '';
  id = id.replace(/^[^/]+\//, '');
  id = id.replace(/:[a-z0-9_-]+$/i, '');
  id = id.replace(/-(latest|preview|stable)$/i, '');
  id = id.replace(/-(?:\d{8}|\d{4}-\d{2}-\d{2})$/i, '');
  return id;
}

/**
 * 判断响应的 model 是否与请求一致。
 * 允许上游回显带日期后缀的完整版本号（如 `claude-sonnet-4-5-20250929`）。
 */
export function modelEchoMatches(requested, echoed) {
  const req = normalizeModelName(requested);
  const got = normalizeModelName(echoed);
  if (!req || !got) return false;
  if (req === got) return true;
  if (got === `${req}-latest`) return true;
  // 允许 `vendor/model` 形式
  return got.endsWith(`/${req}`) || req.endsWith(`/${got}`);
}

/**
 * 提取工具调用（tool / function calling）。
 *
 * @returns {{found:boolean, valid:boolean, calls:Array<{id:string, name:string,
 *            argumentsText:string, args:object|null, provider:string}>}}
 */
export function extractToolCalls(payload, provider = '') {
  const providerId = normalizeProvider(provider);
  const result = { found: false, valid: false, calls: [] };
  if (!payload || typeof payload !== 'object') return result;

  if (providerId === 'openai') {
    const choice = Array.isArray(payload.choices) ? payload.choices[0] : null;
    const message = choice?.message && typeof choice.message === 'object' ? choice.message : null;
    const toolCalls = Array.isArray(message?.tool_calls) ? message.tool_calls : [];
    if (toolCalls.length > 0) {
      result.found = true;
      for (const call of toolCalls) {
        const fn = call?.function && typeof call.function === 'object' ? call.function : {};
        const argumentsText = safeText(fn.arguments);
        let args = null;
        try {
          args = JSON.parse(argumentsText);
        } catch {
          args = null;
        }
        result.calls.push({
          id: safeText(call?.id),
          name: safeText(fn.name),
          argumentsText,
          args: args && typeof args === 'object' ? args : null,
          provider: 'openai'
        });
      }
      result.valid = result.calls.some((call) => Boolean(call.name) && call.args !== null);
      return result;
    }
    // 旧式 function_call
    const legacy = message?.function_call;
    if (legacy && typeof legacy === 'object') {
      result.found = true;
      const argumentsText = safeText(legacy.arguments);
      let args = null;
      try {
        args = JSON.parse(argumentsText);
      } catch {
        args = null;
      }
      result.calls.push({
        id: '',
        name: safeText(legacy.name),
        argumentsText,
        args: args && typeof args === 'object' ? args : null,
        provider: 'openai'
      });
      result.valid = result.calls.some((call) => Boolean(call.name) && call.args !== null);
    }
    return result;
  }

  if (providerId === 'anthropic') {
    const content = Array.isArray(payload.content) ? payload.content : [];
    const blocks = content.filter((block) => block && typeof block === 'object' && block.type === 'tool_use');
    if (blocks.length > 0) {
      result.found = true;
      for (const block of blocks) {
        result.calls.push({
          id: safeText(block.id),
          name: safeText(block.name),
          argumentsText: safeJsonText(block.input),
          args: block.input && typeof block.input === 'object' ? block.input : null,
          provider: 'anthropic'
        });
      }
      result.valid = result.calls.some((call) => Boolean(call.name) && call.args !== null);
    }
    return result;
  }

  const candidate = Array.isArray(payload.candidates) ? payload.candidates[0] : null;
  const parts = candidate?.content?.parts;
  const functionCalls = Array.isArray(parts)
    ? parts.map((part) => part?.functionCall).filter((call) => call && typeof call === 'object')
    : [];
  if (functionCalls.length > 0) {
    result.found = true;
    for (const call of functionCalls) {
      result.calls.push({
        id: safeText(call.id),
        name: safeText(call.name),
        argumentsText: safeJsonText(call.args),
        args: call.args && typeof call.args === 'object' ? call.args : null,
        provider: 'gemini'
      });
    }
    result.valid = result.calls.some((call) => Boolean(call.name) && call.args !== null);
  }
  return result;
}

/**
 * 提取 thinking / redacted_thinking 块（Claude 加密级验真，见 LEARNINGS §2.4）。
 *
 * @returns {{blocks:Array<object>, thinkingText:string, signatures:string[], redactedCount:number}}
 */
export function extractThinking(payload) {
  const content = Array.isArray(payload?.content) ? payload.content : [];
  const blocks = content.filter(
    (block) => block && typeof block === 'object' && (block.type === 'thinking' || block.type === 'redacted_thinking')
  );
  const thinkingText = blocks
    .filter((block) => block.type === 'thinking' && typeof block.thinking === 'string')
    .map((block) => block.thinking)
    .join('');
  const signatures = blocks
    .filter((block) => block.type === 'thinking' && typeof block.signature === 'string' && block.signature)
    .map((block) => block.signature);
  const redactedCount = blocks.filter((block) => block.type === 'redacted_thinking').length;
  return { blocks, thinkingText, signatures, redactedCount };
}

/* ------------------------------------------------------------------ */
/* 响应读取 / 请求执行                                                   */
/* ------------------------------------------------------------------ */

/** bodyText 在 exchange 里保留的上限（报告体积与可读性折中）。 */
export const MAX_EXCHANGE_BODY_TEXT = 20000;

/** 兼容 Headers 实例 / Map / 普通对象，统一为小写键的普通对象。 */
export function normalizeHeaders(raw) {
  const out = {};
  const put = (name, value) => {
    out[String(name).toLowerCase()] = Array.isArray(value) ? value.join(', ') : String(value);
  };
  if (!raw) return out;
  if (typeof raw.forEach === 'function') {
    raw.forEach((value, name) => put(name, value));
    return out;
  }
  if (typeof raw.entries === 'function') {
    for (const [name, value] of raw.entries()) put(name, value);
    return out;
  }
  if (typeof raw === 'object') {
    for (const [name, value] of Object.entries(raw)) put(name, value);
  }
  return out;
}

/**
 * 把 transport 返回的 Response / 伪造对象读成统一的 exchange.response。
 * 兼容 fetch Response、`{ status, headers, text() }`、`{ status, bodyText, bodyJson }`。
 *
 * @param {unknown} res
 * @returns {Promise<{status:number, headers:object, bodyText:string, bodyJson:object|null,
 *                    contentType:string, truncated:boolean, rawLength:number}>}
 */
export async function readTransportResponse(res) {
  const headers = normalizeHeaders(res?.headers);
  let text = '';
  try {
    if (res && typeof res.text === 'function') {
      const value = await res.text();
      text = typeof value === 'string' ? value : String(value ?? '');
    } else if (typeof res?.bodyText === 'string') {
      text = res.bodyText;
    } else if (res?.bodyJson !== undefined && res.bodyJson !== null) {
      text = safeJsonText(res.bodyJson, 200000);
    } else if (res?.body && typeof res.body.getReader === 'function') {
      const reader = res.body.getReader();
      const chunks = [];
      try {
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          chunks.push(value instanceof Uint8Array ? value : new Uint8Array(value));
        }
      } finally {
        try {
          reader.releaseLock?.();
        } catch {
          /* ignore */
        }
      }
      const merged = new Uint8Array(chunks.reduce((sum, chunk) => sum + chunk.byteLength, 0));
      let offset = 0;
      for (const chunk of chunks) {
        merged.set(chunk, offset);
        offset += chunk.byteLength;
      }
      text = new TextDecoder('utf-8').decode(merged);
    }
  } catch {
    text = '';
  }

  let bodyJson = null;
  if (text) {
    try {
      bodyJson = JSON.parse(text);
    } catch {
      bodyJson = null;
    }
  }
  if ((!bodyJson || typeof bodyJson !== 'object') && res?.bodyJson && typeof res.bodyJson === 'object') {
    bodyJson = res.bodyJson;
  }
  const truncated = text.length > MAX_EXCHANGE_BODY_TEXT;
  const status = typeof res?.status === 'number' && Number.isFinite(res.status) ? res.status : 0;
  return {
    status,
    headers,
    bodyText: truncated ? text.slice(0, MAX_EXCHANGE_BODY_TEXT) : text,
    bodyJson: bodyJson && typeof bodyJson === 'object' ? bodyJson : null,
    contentType: headers['content-type'] || '',
    truncated,
    rawLength: text.length
  };
}

/**
 * 执行一次请求。
 *
 * 正常路径由 runner 提供的 `ctx.request(spec)` 完成（预算、串行、超时、Abort、被动分发）。
 * 若检测器被单独用于离线单测（ctx 没有 request），这里提供最小兜底：
 * 直接调用 `ctx.transport`，不扣预算、不做超时控制 —— **仅供测试**。
 *
 * @param {object} ctx
 * @param {object} spec buildChatRequest 的返回值
 * @returns {Promise<object>} exchange
 */
export async function performRequest(ctx, spec) {
  if (ctx && typeof ctx.request === 'function') return ctx.request(spec);
  const transport = ctx?.transport;
  const startedAt = Date.now();
  const exchange = {
    purpose: safeText(spec?.purpose) || 'chat',
    request: {
      method: safeText(spec?.method) || 'POST',
      url: safeText(spec?.url),
      headers: {},
      body: spec?.body ?? null,
      startedAt
    },
    response: null,
    error: null,
    meta: {
      purpose: safeText(spec?.purpose) || 'chat',
      fallback: true,
      stream: spec?.stream === true
    },
    durationMs: 0
  };
  if (typeof transport !== 'function') {
    exchange.error = {
      kind: 'network',
      message: 'ctx 缺少 request() 且没有可用的 transport，无法发起请求。'
    };
    return exchange;
  }
  try {
    const init = { method: exchange.request.method, headers: spec?.headers || {} };
    if (spec?.body != null) init.body = JSON.stringify(spec.body);
    const res = await transport(exchange.request.url, init);
    exchange.response = await readTransportResponse(res);
  } catch (error) {
    const name = safeText(error?.name);
    exchange.error = {
      kind: /abort/i.test(name) ? 'aborted' : /timeout|timedout/i.test(`${name} ${error?.message || ''}`) ? 'timeout' : 'network',
      message: error?.message ? String(error.message) : String(error ?? '未知错误')
    };
  }
  exchange.durationMs = Date.now() - startedAt;
  return exchange;
}

/* ------------------------------------------------------------------ */
/* 流式解析                                                             */
/* ------------------------------------------------------------------ */

/**
 * 解析 SSE 文本为帧数组。同时兼容 `data:` 单行 / 多行与 `[DONE]`。
 *
 * @param {string} text
 * @returns {Array<{data:string, json:object|null}>}
 */
export function parseSseFrames(text) {
  const frames = [];
  const raw = safeText(text);
  if (!raw) return frames;
  const lines = raw.split(/\r?\n/);
  let dataLines = [];
  const flush = () => {
    if (dataLines.length === 0) return;
    const data = dataLines.join('\n').trim();
    dataLines = [];
    if (!data || data === '[DONE]') return;
    let json = null;
    try {
      json = JSON.parse(data);
    } catch {
      json = null;
    }
    frames.push({ data, json });
  };
  for (const line of lines) {
    if (line.startsWith('data:')) dataLines.push(line.slice(5).replace(/^\s+/, ''));
    else if (line.trim() === '') flush();
    // event: / id: / retry: 等字段对文本与 usage 解析无影响，忽略
  }
  flush();
  return frames;
}

/**
 * 解析流式响应，产出累积文本与 usage。
 * 兼容三种协议，以及「假流式」（网关忽略 stream、直接返回完整 JSON）的情况。
 *
 * @param {string} text SSE 文本
 * @param {string} provider
 * @returns {{text:string, usage:object|null, frameCount:number, sawDone:boolean, jsonFallback:object|null}}
 */
export function parseStream(text, provider = '') {
  const providerId = normalizeProvider(provider);
  const frames = parseSseFrames(text);
  const out = {
    text: '',
    usage: null,
    frameCount: frames.length,
    sawDone: /\[DONE\]/.test(safeText(text)),
    jsonFallback: null
  };
  if (frames.length === 0) {
    // 假流式：整个 body 是一个 JSON
    try {
      const parsed = JSON.parse(safeText(text));
      if (parsed && typeof parsed === 'object') {
        out.jsonFallback = parsed;
        out.text = extractAssistantText(parsed, providerId);
        const usage = extractUsage(parsed, providerId);
        if (usage.vendor) out.usage = usage;
      }
    } catch {
      /* 非 JSON，保持空 */
    }
    return out;
  }

  const texts = [];
  let usage = null;
  for (const frame of frames) {
    const json = frame.json;
    if (!json || typeof json !== 'object') continue;
    if (providerId === 'openai') {
      const choice = Array.isArray(json.choices) ? json.choices[0] : null;
      const delta = choice?.delta && typeof choice.delta === 'object' ? choice.delta : null;
      if (typeof delta?.content === 'string') texts.push(delta.content);
      else if (Array.isArray(delta?.content)) texts.push(joinTextBlocks(delta.content));
      else if (typeof choice?.text === 'string') texts.push(choice.text);
      const frameUsage = extractUsage(json, 'openai');
      if (frameUsage.vendor) usage = frameUsage;
    } else if (providerId === 'anthropic') {
      const type = safeText(json.type);
      if (type === 'content_block_delta') {
        const delta = json.delta && typeof json.delta === 'object' ? json.delta : null;
        if (safeText(delta?.type) === 'text_delta' && typeof delta.text === 'string') texts.push(delta.text);
      } else if (type === 'content_block_start') {
        const block = json.content_block;
        if (block && block.type === 'text' && typeof block.text === 'string') texts.push(block.text);
      } else if (type === 'message_start' && json.message) {
        const usage0 = extractUsage(json.message, 'anthropic');
        if (usage0.vendor) usage = { ...(usage || {}), ...usage0, completionTokens: usage?.completionTokens ?? null };
      } else if (type === 'message_delta') {
        const deltaUsage = json.usage && typeof json.usage === 'object' ? json.usage : null;
        if (deltaUsage) {
          const merged = {
            promptTokens: usage?.promptTokens ?? null,
            completionTokens: numeric(deltaUsage.output_tokens),
            totalTokens:
              usage?.promptTokens != null && numeric(deltaUsage.output_tokens) != null
                ? usage.promptTokens + numeric(deltaUsage.output_tokens)
                : null,
            cacheReadTokens: usage?.cacheReadTokens ?? null,
            cacheWriteTokens: usage?.cacheWriteTokens ?? null,
            thoughtsTokens: null,
            raw: deltaUsage,
            vendor: 'anthropic'
          };
          usage = merged;
        }
      }
    } else {
      const candidate = Array.isArray(json.candidates) ? json.candidates[0] : null;
      const parts = candidate?.content?.parts;
      if (Array.isArray(parts)) texts.push(joinTextBlocks(parts));
      const frameUsage = extractUsage(json, 'gemini');
      if (frameUsage.vendor) usage = frameUsage;
    }
  }
  out.text = texts.join('');
  out.usage = usage;
  return out;
}

export default {
  PROVIDERS,
  PROVIDER_LABELS,
  DEFAULT_BASE_URLS,
  DEFAULT_MODELS,
  normalizeProvider,
  resolveBaseUrl,
  resolveModel,
  apiRoot,
  chatUrl,
  buildHeaders,
  chatBody,
  buildChatRequest,
  isSuccess,
  bodyJsonOf,
  bodyTextOf,
  failureOf,
  extractUsage,
  extractAssistantText,
  extractStopReason,
  extractModelEcho,
  normalizeModelName,
  modelEchoMatches,
  extractToolCalls,
  extractThinking,
  parseSseFrames,
  parseStream,
  normalizeHeaders,
  readTransportResponse,
  performRequest,
  MAX_EXCHANGE_BODY_TEXT
};
