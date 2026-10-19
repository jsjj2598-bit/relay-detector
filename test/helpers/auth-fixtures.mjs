/**
 * v2 真伪检测（src/core/auth/**）离线测试基础设施。
 *
 * 提供与 `fetch` 同签名的**伪造 transport**：不联网、可脚本化、可断言请求。
 * 供 auth-detectors.test.mjs / auth-runner.test.mjs 共用。
 *
 * 本文件只读源码、不修改源码。
 */

/* ------------------------------------------------------------------ */
/* Response 构造器                                                       */
/* ------------------------------------------------------------------ */

/** 构造 JSON 响应（与真实 fetch 相同的 Response 对象）。 */
export function jsonResponse(body, { status = 200, headers = {} } = {}) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json', ...headers }
  });
}

/** 构造 Anthropic Messages 的非流式响应（默认合法形状）。 */
export function anthropicMessage(overrides = {}) {
  return {
    id: 'msg_01ABCDEFGHIJKLMNOPQRSTUV',
    type: 'message',
    role: 'assistant',
    model: 'claude-sonnet-4-5',
    content: [{ type: 'text', text: '1547' }],
    stop_reason: 'end_turn',
    stop_sequence: null,
    usage: { input_tokens: 42, output_tokens: 5 },
    ...overrides
  };
}

/** 构造一条 Anthropic thinking 块（默认签名长度正常）。 */
export function thinkingBlock({ type = 'thinking', thinking = '先把两个数相除，然后递归求余……', signature = 'EqQBCkgIBRABGAIiQL' + 'x'.repeat(120) } = {}) {
  return { type, thinking, signature };
}

/** 构造 OpenAI Chat Completions 非流式响应（默认合法形状）。 */
export function openaiCompletion(overrides = {}) {
  return {
    id: 'chatcmpl-ABCdef0123456789',
    object: 'chat.completion',
    created: 1700000000,
    model: 'gpt-4o',
    choices: [
      {
        index: 0,
        message: { role: 'assistant', content: '349' },
        finish_reason: 'stop',
        logprobs: null
      }
    ],
    usage: { prompt_tokens: 40, completion_tokens: 4, total_tokens: 44 },
    ...overrides
  };
}

/** 构造 Gemini generateContent 响应（默认合法形状）。 */
export function geminiCandidate(overrides = {}) {
  return {
    candidates: [
      {
        content: { role: 'model', parts: [{ text: '349' }] },
        finishReason: 'STOP',
        index: 0
      }
    ],
    usageMetadata: { promptTokenCount: 40, candidatesTokenCount: 4, totalTokenCount: 44 },
    modelVersion: 'gemini-2.5-flash',
    ...overrides
  };
}

/** 构造 SSE 流式响应体（Anthropic / OpenAI 共用 `data: JSON` 行格式）。 */
export function sseResponse(chunks, { status = 200, headers = {} } = {}) {
  const lines = [];
  for (const evt of chunks) {
    if (typeof evt === 'string') {
      lines.push(evt);
      continue;
    }
    if (evt.event) lines.push(`event: ${evt.event}`);
    lines.push(`data: ${JSON.stringify(evt.data ?? evt)}`);
    lines.push('');
  }
  lines.push('data: [DONE]');
  lines.push('');
  return new Response(lines.join('\n'), {
    status,
    headers: { 'content-type': 'text/event-stream', ...headers }
  });
}

/** 有用的错误响应体（OpenAI 风格 / Anthropic 风格 / 聚合站风格）。 */
export const ERROR_BODIES = {
  insufficientQuota: {
    error: { message: 'You exceeded your current quota, please check your plan and billing details.', type: 'insufficient_quota', code: 'insufficient_quota' }
  },
  modelNotFound: {
    error: { message: 'The model `claude-sonnet-4-5` does not exist or you do not have access to it.', type: 'not_found_error', code: 'model_not_found' }
  },
  noChannel: {
    error: { message: '当前分组上游负载已饱和，无可用渠道', type: 'new_api_error', code: 'no_available_channel' }
  },
  invalidKey: {
    error: { message: 'invalid x-api-key', type: 'authentication_error' }
  },
  insufficientQuotaAnthropic: {
    type: 'error',
    error: { type: 'rate_limit_error', message: 'Your credit balance is too low to access the Anthropic API.' }
  }
};

/* ------------------------------------------------------------------ */
/* 可脚本化 transport                                                     */
/* ------------------------------------------------------------------ */

/**
 * 创建一个与 fetch 同签名的伪造 transport。
 *
 * handler 可以是：
 *  - 一个函数 `(ctx) => Response | {route: Response} | Promise<Response>`
 *    ctx = { url, method, headers, body, bodyJson, rawBody, call, calls }
 *  - 一个数组：按调用顺序 dispatch（用完后重复最后一项）
 *  - 一个普通对象：`{ default: Response|fn, routes: [{ match, respond }] }`
 *
 * @returns {Function & {calls: Array<object>}}
 */
export function createAuthTransport(handler) {
  const calls = [];

  async function dispatch(ctx) {
    if (typeof handler === 'function') return handler(ctx);
    if (Array.isArray(handler)) {
      const h = handler[Math.min(ctx.call, handler.length - 1)];
      return typeof h === 'function' ? h(ctx) : h;
    }
    if (handler && typeof handler === 'object') {
      for (const route of handler.routes || []) {
        const ok = typeof route.match === 'function' ? route.match(ctx) : true;
        if (ok) return typeof route.respond === 'function' ? route.respond(ctx) : route.respond;
      }
      const d = handler.default;
      return typeof d === 'function' ? d(ctx) : d;
    }
    return jsonResponse({ ok: true });
  }

  const transport = async (url, init = {}) => {
    const rawBody = init?.body;
    let bodyJson = null;
    let bodyText = '';
    if (typeof rawBody === 'string') {
      bodyText = rawBody;
      try {
        bodyJson = JSON.parse(rawBody);
      } catch {
        bodyJson = null;
      }
    }
    const ctx = {
      url: String(url),
      method: String(init?.method ?? 'GET').toUpperCase(),
      headers: init?.headers ?? {},
      body: rawBody ?? null,
      bodyJson,
      bodyText,
      signal: init?.signal ?? null,
      call: calls.length,
      calls
    };
    calls.push({ url: ctx.url, method: ctx.method, headers: ctx.headers, body: ctx.body, bodyJson, call: ctx.call });

    const out = await dispatch(ctx);
    if (out instanceof Response) return out;
    // 允许 handler 直接返回 body 对象（自动包成 200 JSON）
    if (out && typeof out === 'object' && typeof out.status === 'number' && out.headers) {
      return new Response(out.bodyText ?? '', out);
    }
    return jsonResponse(out ?? { ok: true });
  };

  transport.calls = calls;
  /** 只看 POST 调用（真正的 chat 请求）。 */
  transport.postCalls = () => calls.filter((c) => c.method === 'POST');
  transport.reset = () => calls.splice(0, calls.length);
  return transport;
}

/** 永远抛出网络错误的 transport。 */
export function throwingTransport(message = 'fetch failed') {
  const calls = [];
  const transport = async (url, init = {}) => {
    calls.push({ url: String(url), method: String(init?.method ?? 'GET').toUpperCase(), body: init?.body ?? null });
    throw new TypeError(message);
  };
  transport.calls = calls;
  return transport;
}

/** 断言报告对象里不含某个密钥原文。 */
export function assertNoSecret(value, secret, label = '报告') {
  const blob = JSON.stringify(value);
  if (blob.includes(secret)) {
    throw new Error(`${label} 中出现了完整 API key 原文：${secret}`);
  }
}
