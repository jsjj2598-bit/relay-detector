/**
 * 检测器注册表（契约 v2 §6.4，顺序与表格一致）。
 *
 * `AUTH_DETECTORS` 的顺序即报告里 `detectors[]` 的顺序，也是 runner 的执行顺序：
 *   quick    → 前 3 项（protocol_shape / cross_vendor_leak / model_consistency）
 *   standard → 前 8 项
 *   full     → 全部 10 项
 */
import { protocolShape } from './protocol-shape.js';
import { crossVendorLeak } from './cross-vendor-leak.js';
import { modelConsistency } from './model-consistency.js';
import { thinkingSignature } from './thinking-signature.js';
import { messageId } from './message-id.js';
import { tokenUsage } from './token-usage.js';
import { structuredOutput } from './structured-output.js';
import { capabilityTools } from './capability-tools.js';
import { streamIntegrity } from './stream-integrity.js';
import { tokenParity } from './token-parity.js';

export {
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
};

/** 契约 §6.4 冻结的检测器顺序。 */
export const AUTH_DETECTORS = Object.freeze([
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
]);

/** name → detector 映射（排错 / UI 使用）。 */
export const AUTH_DETECTORS_BY_NAME = Object.freeze(
  Object.fromEntries(AUTH_DETECTORS.map((detector) => [detector.name, detector]))
);

/** 各档位包含的检测器序号（0-based，含端点）。 */
export const MODE_DETECTOR_RANGE = Object.freeze({
  quick: 3,
  standard: 8,
  full: 10
});

/** 某档位会执行的检测器列表（不含因模型能力 / 协议而 skip 的）。 */
export function detectorsForMode(mode) {
  const count = MODE_DETECTOR_RANGE[mode] ?? MODE_DETECTOR_RANGE.standard;
  return AUTH_DETECTORS.slice(0, count);
}

export default {
  AUTH_DETECTORS,
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
};
