/**
 * 常量与校准事实（冻结模块，Lead 所有）。engine / ui 只读。
 *
 * ⚠️ 校准原则：
 * 本文件里的每一条「事实」都必须带 confidence 或在 note 里说明来源，
 * 因为中转站识别最大的风险不是漏判，而是**把官方直连误判成中转站**。
 *
 * 关键实测事实（见 CALIBRATION）：
 *   api.anthropic.com 本身就位于 Cloudflare 之后（server: cloudflare），
 *   且证书由 Google Trust Services 签发。
 *   ⇒ 因此「有 Cloudflare / 非自签证书」绝不能作为中转站证据。
 */

export const VERSION = '2.2.0';

/** 本次校准事实的采集时间与方式。 */
export const CALIBRATION = {
  measuredAt: '2026-10-19',
  method: 'tools/fingerprint-official.mjs（匿名 GET + TLS peer certificate 读取，不消耗额度）',
  reachable: ['api.anthropic.com'],
  unreachable: ['api.openai.com', 'generativelanguage.googleapis.com'], // 本机网络受限，未能实测
  findings: [
    {
      host: 'api.anthropic.com',
      note: '官方端点位于 Cloudflare 后，server: cloudflare；证书链 api.anthropic.com ← Google Trust Services WE1 ← GTS Root R4。',
      implication: 'CDN 与公共 CA 证书均为中性证据，不得计入 relay。'
    },
    {
      host: 'api.anthropic.com',
      note: '受限网络下匿名请求得到 403 {"error":{"type":"forbidden","message":"Request not allowed"}}（边缘防护拦截，非 API 自身鉴权响应）。',
      implication: '此类响应必须判为「无法判定」，不得当作中转特征。'
    }
  ]
};

/**
 * 官方 / 正规厂商端点主机名。
 * 用于 url 规则：命中即官方直连；未命中只能判定「非官方域名」，本身不足以定性为中转站。
 */
export const OFFICIAL_HOSTS = {
  openai: ['api.openai.com'],
  anthropic: ['api.anthropic.com'],
  gemini: ['generativelanguage.googleapis.com'],
  /** 正规厂商的 OpenAI 兼容端点：不是「官方 OpenAI」，但也不是中转站。 */
  other_vendors: [
    'api.deepseek.com',
    'api.moonshot.cn',
    'api.siliconflow.cn',
    'dashscope.aliyuncs.com',
    'open.bigmodel.cn',
    'api.minimax.chat',
    'ark.cn-beijing.volces.com',
    'api.x.ai',
    'api.mistral.ai',
    'api.groq.com',
    'api.together.xyz',
    'api.perplexity.ai',
    'api.cerebras.ai',
    'api.fireworks.ai',
    'api.novita.ai',
    'api.hyperbolic.xyz',
    // 聚合平台：本质即「多上游代理」，判定为代理但非灰产中转
    'openrouter.ai'
  ]
};

/** 正规厂商中「聚合/代理」性质的主机，判定时用中性偏 relay 的语气描述。 */
export const AGGREGATOR_HOSTS = ['openrouter.ai'];

/** 已知会用到的 Azure OpenAI 域名模式。 */
export const OFFICIAL_HOST_PATTERNS = [
  { pattern: /^[a-z0-9-]+\.openai\.azure\.com$/i, label: 'Azure OpenAI', provider: 'openai' },
  { pattern: /^[a-z0-9-]+\.services\.ai\.azure\.com$/i, label: 'Azure AI Services', provider: 'openai' },
  { pattern: /^generativelanguage\.googleapis\.com$/i, label: 'Google Generative Language', provider: 'gemini' },
  { pattern: /^[a-z0-9-]+\.googleusercontent\.com$/i, label: 'Google 托管端点', provider: 'gemini' }
];

/**
 * 官方证书签发者（实测 / 高置信）。
 * 注意：只用于「官方正向加分」，绝不用于「非该签发者 ⇒ 中转」的反向推理。
 */
export const OFFICIAL_TLS_ISSUERS = [
  {
    match: /google trust services/i,
    label: 'Google Trust Services',
    confidence: 0.9,
    note: '实测 api.anthropic.com 使用该签发者；Google 系官方端点常见。'
  },
  { match: /digicert/i, label: 'DigiCert', confidence: 0.6, note: '常见公共 CA，官方与中转都可能使用，指示力弱。' }
];

/** 公共 CA：既不指向官方也不指向中转，属于中性。 */
export const NEUTRAL_TLS_ISSUERS = [
  { match: /cloudflare/i, label: 'Cloudflare, Inc.' },
  { match: /let'?s encrypt/i, label: "Let's Encrypt" },
  { match: /google trust services/i, label: 'Google Trust Services' },
  { match: /amazon/i, label: 'Amazon' },
  { match: /sectigo/i, label: 'Sectigo' },
  { match: /zerossl/i, label: 'ZeroSSL' },
  { match: /buypass/i, label: 'Buypass' }
];

/** 公共 CDN / 边缘服务：中性，不代表中转。 */
export const NEUTRAL_EDGE_MARKERS = [
  { match: /cloudflare/i, label: 'Cloudflare' },
  { match: /akamai/i, label: 'Akamai' },
  { match: /fastly/i, label: 'Fastly' },
  { match: /amazon ?s3|cloudfront/i, label: 'AWS CloudFront' },
  { match: /vercel/i, label: 'Vercel' },
  { match: /netlify/i, label: 'Netlify' }
];

/**
 * 官方响应头标记（正向证据，带 confidence）。
 * confidence 偏保守：OpenAI 端点为高置信常识但本机未能实测。
 */
export const OFFICIAL_HEADER_MARKERS = {
  openai: [
    {
      header: 'openai-version',
      expect: /^\d{4}-\d{2}-\d{2}$/,
      weight: 34,
      confidence: 0.55,
      note: 'OpenAI 官方长期返回 openai-version: 2020-10-01；中转站一般不伪造该头。'
    },
    {
      header: 'openai-processing-ms',
      expect: /^\d+$/,
      weight: 26,
      confidence: 0.5,
      note: '官方处理耗时头，中转站通常缺失。'
    },
    {
      header: 'openai-organization',
      expect: /.+/,
      weight: 22,
      confidence: 0.5,
      note: '官方组织标识头。'
    },
    {
      header: 'x-request-id',
      expect: /^req_[0-9a-f]{32}$/i,
      weight: 30,
      confidence: 0.5,
      note: '官方 request id 形如 req_ + 32 位十六进制；中转站常自行生成或缺失。'
    }
  ],
  anthropic: [
    {
      header: 'request-id',
      expect: /^req_[A-Za-z0-9]+$/,
      weight: 26,
      confidence: 0.6,
      note: 'Anthropic 官方 request-id 形如 req_xxx。'
    },
    {
      header: 'anthropic-ratelimit-requests-limit',
      expect: /^\d+$/,
      weight: 34,
      confidence: 0.65,
      note: 'Anthropic 官方限流头，仅在带密钥请求时出现；伪造成本高。'
    },
    {
      header: 'anthropic-ratelimit-tokens-limit',
      expect: /^\d+$/,
      weight: 30,
      confidence: 0.65,
      note: 'Anthropic 官方 token 限流头。'
    }
  ],
  gemini: []
};

/**
 * 官方模型家族前缀（参考集合，非穷举）。
 * 仅用于计算「模型列表与官方家族的重合度」，不用于定性。
 */
export const OFFICIAL_MODEL_PREFIXES = {
  openai: [
    'gpt-5', 'gpt-4.1', 'gpt-4o', 'gpt-4-turbo', 'gpt-4-0', 'gpt-4', 'gpt-3.5-turbo',
    'chatgpt-4o', 'o1', 'o3', 'o4-mini', 'codex-mini', 'computer-use-preview',
    'text-embedding-3', 'text-embedding-ada', 'text-moderation',
    'dall-e', 'gpt-image-1', 'whisper-1', 'tts-1', 'gpt-audio', 'gpt-realtime', 'sora'
  ],
  anthropic: [
    'claude-opus-4', 'claude-sonnet-4', 'claude-haiku-4', 'claude-3-7-sonnet',
    'claude-3-5-sonnet', 'claude-3-5-haiku', 'claude-3-opus', 'claude-3-sonnet', 'claude-3-haiku'
  ],
  gemini: [
    'gemini-2.5', 'gemini-2.0', 'gemini-1.5', 'gemini-pro', 'gemini-flash', 'gemini-exp',
    'text-embedding-004', 'embedding-001', 'aqa', 'imagen', 'veo', 'learnlm'
  ]
};

/**
 * 国产 / 第三方模型家族前缀。出现在「自称 OpenAI 官方」的端点上时，是强中转证据（多上游聚合）。
 */
export const THIRD_PARTY_MODEL_PREFIXES = [
  'deepseek', 'qwen', 'qwen2', 'glm', 'chatglm', 'moonshot', 'kimi', 'ernie', 'hunyuan',
  'doubao', 'skylark', 'abab', 'minimax', 'step-', 'yi-', 'spark', 'baichuan', 'internlm',
  'llama', 'mistral', 'mixtral', 'gemma', 'phi-', 'command-r', 'grok', 'sonar', 'pplx',
  'claude', 'gemini', 'gpt-', 'o1', 'o3', 'o4-'
];

/** JSON 结构指纹：官方错误对象必须同时出现的键。 */
export const OPENAI_ERROR_SHAPE = {
  required: ['message', 'type', 'param', 'code'],
  types: ['invalid_request_error', 'authentication_error', 'rate_limit_error', 'server_error', 'insufficient_quota', 'not_found_error', 'permission_error', 'api_error', 'tokens', 'requests']
};

/** 已知中转/网关软件的错误报文特征（非确定性证据，均带 note）。 */
export const RELAY_SOFTWARE_SIGNATURES = [
  {
    id: 'one_api_error_type',
    software: 'one-api',
    match: /"type"\s*:\s*"one_api_error"/i,
    weight: 62,
    confidence: 0.75,
    note: 'one-api 系列在错误体中使用 type: "one_api_error"；官方 API 不会出现该取值。'
  },
  {
    id: 'new_api_error_type',
    software: 'new-api',
    match: /"type"\s*:\s*"new_api_error"/i,
    weight: 62,
    confidence: 0.75,
    note: 'new-api 系列的同类标记。'
  },
  {
    id: 'billing_shape',
    software: 'one-api / new-api',
    match: /"data"\s*:\s*null\s*,\s*"message"|"code"\s*:\s*\d{3}\s*,\s*"message"/,
    weight: 48,
    confidence: 0.6,
    note: '形如 {"code":401,"message":"...","data":null} 的扁平业务包装体，是常见中转网关返回格式，官方 API 不使用。'
  },
  {
    id: 'upstream_error_type',
    software: '聚合网关',
    match: /"type"\s*:\s*"upstream_error"/i,
    weight: 55,
    confidence: 0.65,
    note: '上游错误类型，说明请求被转发到另一上游，官方 API 不会返回。'
  },
  {
    id: 'fastapi_detail',
    software: 'FastAPI 反向代理（自建网关）',
    match: /^\s*\{\s*"detail"\s*:\s*("Not authenticated"|"Invalid token"|"Unauthorized")/i,
    weight: 50,
    confidence: 0.55,
    note: 'FastAPI 默认 HTTPException 结构，说明前面是自建 Python 网关而非官方边缘。'
  },
  {
    id: 'cn_error_message',
    software: '中文网关',
    match: /"message"\s*:\s*"[^"]*(无效的令牌|令牌|额度|分组|渠道|上游|余额不足|请求过于频繁|无权限|参数错误)[^"]*"/,
    weight: 45,
    confidence: 0.6,
    note: '错误信息为中文网关惯用词，官方 API 一律英文。'
  },
  {
    id: 'insufficient_balance',
    software: '中转站',
    match: /(insufficient|not enough)\s+(user\s+)?(quota|balance|credit)|余额不足|额度不足|欠费/i,
    weight: 40,
    confidence: 0.55,
    note: '「余额/额度」概念说明前面存在计费转售方，官方只报 quota/rate limit。'
  }
];

/** nginx / 通用 Web 服务器的默认页面与头，说明未知路径未被 API 处理。 */
export const GENERIC_SERVER_MARKERS = [
  { match: /^nginx/i, label: 'nginx' },
  { match: /^openresty/i, label: 'OpenResty' },
  { match: /^apache/i, label: 'Apache' },
  { match: /^caddy/i, label: 'Caddy' },
  { match: /^werkzeug|^gunicorn|^uvicorn/i, label: 'Python WSGI/ASGI' },
  { match: /^express/i, label: 'Express' },
  { match: /^cloudflare$/i, label: 'Cloudflare' }
];

/** UI 用类别中文名。 */
export const CATEGORY_LABELS = {
  url: '域名与路径',
  tls: 'TLS 证书',
  headers: '响应头',
  error: '错误报文',
  models: '模型列表',
  payload: '响应载荷',
  behavior: '行为特征',
  signature: '已知网关指纹',
  other: '其他'
};

export const PROVIDER_LABELS = {
  openai: 'OpenAI / 兼容 /v1',
  anthropic: 'Anthropic Claude',
  gemini: 'Google Gemini'
};

export const PROVIDER_DEFAULT_BASE_URL = {
  openai: 'https://api.openai.com/v1',
  anthropic: 'https://api.anthropic.com',
  gemini: 'https://generativelanguage.googleapis.com'
};

export { CATEGORY_WEIGHTS } from './score.js';
