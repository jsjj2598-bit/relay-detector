/**
 * 上游真伪检测公开 API（契约 v2 §6.6，FROZEN）。
 *
 * 对外只暴露这三个契约冻结的名字：
 *   - `runAuthenticity(input)` → 契约 §6.6 的 authenticity 报告（**绝不抛异常**）
 *   - `estimateCost({ provider, model, mode })` → `{ requests, promptTokens, completionTokens, note }`
 *   - `AUTH_MODES` → `['quick', 'standard', 'full']`
 *
 * 其余导出都是便利别名 / UI 辅助，不改变契约签名。
 *
 * 两根轴不在这里合并：本模块只负责「上游真伪」轴；「连接方式」轴由
 * `src/core/engine.js` 的 `detect()` 负责，二者在报告里并列呈现（契约 §5 / §7）。
 */
export {
  runAuthenticity,
  estimateCost,
  AUTH_MODES,
  AUTH_MODE_LABELS,
  getSuggestedModels,
  AUTH_DETECTORS,
  DEFAULT_MAX_REQUESTS,
  DEFAULT_TIMEOUT_MS,
  scrubSecrets
} from './runner.js';

export { maskApiKey, joinTextBlocks, pickTextContent } from './base.js';

export {
  computeTotal,
  verdictFor,
  hasCriticalIssues,
  effectiveVerdict,
  fatalRunError,
  summaryText,
  classifyFatalText,
  AUTH_VERDICT_THRESHOLDS,
  FATAL_CODES
} from './scorer.js';

export {
  MODEL_REGISTRY,
  DEFAULT_MODELS,
  lookupModel,
  suggestModels,
  defaultModelFor,
  normalizeProviderId
} from './models.js';

export { BASELINES, BASELINES_VERSION, getBaseline, hasBaseline } from './baselines.js';

export {
  AUTH_DETECTORS_BY_NAME,
  MODE_DETECTOR_RANGE,
  detectorsForMode,
  protocolShape,
  crossVendorLeak,
  modelConsistency,
  thinkingSignature,
  messageId,
  tokenUsage,
  structuredOutput,
  capabilityTools,
  streamIntegrity,
  tokenParity
} from './detectors/index.js';

export { runAuthenticity as default } from './runner.js';
