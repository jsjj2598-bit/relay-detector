/**
 * 已知网关 / 中转软件指纹库（engine 所有）。
 *
 * 设计原则：
 * 1. 这里的每一条都是**非确定性证据**：命中只提高嫌疑，不构成证明；未命中也不代表官方。
 * 2. 每条都带 confidence，并说明为什么它不能更高。
 * 3. constants.js 里给出的部分正则偏宽，直接使用会在官方响应上误命中，例如
 *    `billing_shape` 的正则 `"code"\s*:\s*\d{3}\s*,\s*"message"` 会命中官方 Gemini 的嵌套错误体
 *    `{"error":{"code":400,"message":"API key not valid..."}}`。
 *    所以本模块提供结构化守卫，并明确把某些指纹交给更合适的规则（error.flat_gateway_envelope）
 *    去判定，避免同一份证据被重复计分。
 *
 * 同时必须遵守项目最大失败模式的红线：
 * Cloudflare / 公共 CA / 非官方域名 / 通用 Server 头 等一律**不得**作为中转证据，
 * 本文件里也不存在任何以这些为特征的中转指纹。
 */
import { RELAY_SOFTWARE_SIGNATURES } from './constants.js';

/** 原样再导出，便于 UI / 测试读取「已知网关软件」清单。 */
export { RELAY_SOFTWARE_SIGNATURES };

export const SIGNATURE_DISCLAIMER =
  '以下指纹均为非确定性证据：网关软件可被改造、伪装或关闭品牌特征；命中提高嫌疑但不构成证明，未命中也不代表官方直连。';

/**
 * 判断一个 JSON 正文是否是「扁平业务包装体」——即常见中转网关的
 * `{"code":401,"message":"无效的令牌","data":null}` 形式。
 *
 * 关键点：必须排除 `{"error":{...}}` 这类官方包装体，否则会把官方 Gemini 的错误体
 * （`{"error":{"code":400,...}}`）误判成网关扁平体。
 */
export function isFlatGatewayEnvelope(json) {
  if (!json || typeof json !== 'object' || Array.isArray(json)) return false;
  if (json.error && typeof json.error === 'object') return false;
  if (typeof json.code !== 'number') return false;
  if (typeof json.message !== 'string') return false;
  const keys = Object.keys(json);
  const allowed = new Set(['code', 'message', 'data', 'success', 'msg', 'type', 'detail']);
  return keys.length <= 5 && keys.every((k) => allowed.has(k));
}

/**
 * 这些指纹**不由 signature 规则产出**，而是交给更合适的类别处理，
 * 以免同一份证据被两个类别重复计算：
 *   - billing_shape → `error.flat_gateway_envelope`（error 类，结构判定更精确，类别权重更高）
 */
export const SIGNATURE_IDS_OWNED_BY_OTHER_RULES = new Set(['billing_shape']);

/** 网关软件品牌串（用于正文 / HTML 标题）。 */
export const GATEWAY_BRANDING_REGEX = /(one[-_ ]?api|new[-_ ]?api|veloera|velora)/i;

/**
 * engine 补充的指纹（constants.js 之外的）。
 * 统一结构：
 *   { id, software, text?: RegExp, headerName?: RegExp, weight, confidence, note,
 *     requiresHtml?: boolean, skipForHtml?: boolean }
 */
export const EXTRA_GATEWAY_SIGNATURES = [
  {
    id: 'one_api_brand_header',
    software: 'one-api',
    headerName: /^x-one-api-/i,
    weight: 60,
    confidence: 0.7,
    note: '响应头出现 x-one-api-* 前缀，属于软件自证型特征；官方 API 不会使用该前缀。',
  },
  {
    id: 'new_api_brand_header',
    software: 'new-api',
    headerName: /^x-new-api-/i,
    weight: 60,
    confidence: 0.7,
    note: '响应头出现 x-new-api-* 前缀，属于软件自证型特征；官方 API 不会使用该前缀。',
  },
  {
    id: 'gateway_brand_header',
    software: '自建网关',
    // 负向断言排除本工具代理自身添加的 x-relay-detector-* 传输层标记
    headerName: /^x-(?:relay|gateway|proxy|forward)-(?!detector-)/i,
    weight: 40,
    confidence: 0.45,
    note: '通用网关自证头前缀；也可能是运维自行添加的追踪头，故置信度中等。',
  },
  {
    id: 'gateway_branding_text',
    software: 'one-api / new-api / veloera',
    text: GATEWAY_BRANDING_REGEX,
    skipForHtml: true,
    weight: 42,
    confidence: 0.55,
    note: '正文出现网关软件名。可能来自网关的首页/404 文案，也可能来自示例或文档，故置信度中等。',
  },
  {
    id: 'html_gateway_title',
    software: '自建网关网页',
    text: /<title>[^<]*(one[-_ ]?api|new[-_ ]?api|veloera|velora|网关|relay|中转)[^<]*<\/title>/i,
    requiresHtml: true,
    weight: 48,
    confidence: 0.6,
    note: 'API 路径返回带网关字样的 HTML 页面，说明该路径由自建网关的网页路由处理（官方 API 路径不会返回网页）。',
  },
  {
    id: 'gateway_balance_field',
    software: '计费型网关',
    text: /"(balance|quota|remaining_quota|group|channel|upstream|tokens_remaining)"\s*:/i,
    weight: 38,
    confidence: 0.5,
    note: '正文出现「余额/额度/分组/渠道/上游」字段，说明中间存在计费转售层；也可能是网关的管理接口，故置信度中等。',
  },
];

/** 常量表指纹 + engine 补充指纹，统一成一种结构。 */
export const KNOWN_GATEWAY_SIGNATURES = [
  ...RELAY_SOFTWARE_SIGNATURES.map((entry) => ({
    id: entry.id,
    software: entry.software,
    text: entry.match,
    weight: entry.weight,
    confidence: entry.confidence,
    note: entry.note,
    origin: 'constants',
  })),
  ...EXTRA_GATEWAY_SIGNATURES.map((entry) => ({ ...entry, origin: 'engine' })),
];

/** 供测试 / 文档使用：全部指纹 id。 */
export const SIGNATURE_IDS = KNOWN_GATEWAY_SIGNATURES.map((s) => s.id);
