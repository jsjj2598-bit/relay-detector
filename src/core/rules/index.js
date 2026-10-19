/**
 * 通用规则集（engine 所有）。
 *
 * runRules(ctx, provider) 会依次执行 provider.rules 与本文件的 COMMON_RULES，
 * 并按 Signal.id 去重（同 id 保留第一个）。
 *
 * 规则都是纯函数 `(ctx) => Signal[] | Signal | null`，不触碰 DOM，可在 Node 下运行。
 */
import { URL_RULES } from './url.js';
import { TLS_RULES } from './tls.js';
import { HEADERS_RULES } from './headers.js';
import { ERROR_RULES } from './error.js';
import { MODELS_RULES } from './models.js';
import { PAYLOAD_RULES } from './payload.js';
import { BEHAVIOR_RULES } from './behavior.js';
import { SIGNATURE_RULES } from './signature.js';

export { URL_RULES, TLS_RULES, HEADERS_RULES, ERROR_RULES, MODELS_RULES, PAYLOAD_RULES, BEHAVIOR_RULES, SIGNATURE_RULES };
export { officialHeaderHits } from './headers.js';
export { detectEdgeProtection, findRecognizedErrorShape } from './error.js';
export { familyOfModel } from './models.js';

export const COMMON_RULES = [
  ...URL_RULES,
  ...TLS_RULES,
  ...HEADERS_RULES,
  ...ERROR_RULES,
  ...MODELS_RULES,
  ...PAYLOAD_RULES,
  ...BEHAVIOR_RULES,
  ...SIGNATURE_RULES,
];

export default COMMON_RULES;
