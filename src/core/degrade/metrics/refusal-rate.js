/** 指标 10/13：拒答率（契约 §11，权重 0.6）。 */
import { strOr } from '../util.js';
import { ensureContext, rateMetric } from './util.js';

export const id = 'refusal_rate';
export const label = '拒答率';
export const unit = '%';
export const weight = 0.6;
export const worseDirection = 'up';
export const critical = false;
export const definition =
  '回答文本命中「拒答话术」的占比（如 "I can\'t help with that" / "作为一个 AI，我无法…"）。拒答率上升可能是模型被换成了对齐更严的版本，也可能是任务内容变化。';

/**
 * 拒答话术（中英文常见表达）。
 * 只匹配「明确拒绝」的句式，避免把正常的 "I can't believe…" 之类误判：
 *  - 英文：I can't / I cannot / I'm unable + help/assist/provide/comply 等；
 *  - 英文：I'm sorry, but … / as an AI … / I apologize；
 *  - 中文：抱歉，我无法… / 我无法帮助… / 作为AI…
 */
const REFUSAL_PATTERNS = [
  /\b(?:i\s*(?:'m|am)\s+(?:sorry|unable|not\s+able))\b[^.\n]{0,80}\b(?:help|assist|provide|comply|answer|do\s+that)\b/i,
  /\b(?:i\s*(?:can(?:not|'t)|won't|will\s+not))\s+(?:help|assist|provide|comply|answer|do\s+that|fulfill)/i,
  /\b(?:as\s+an\s+ai|i\s+apologi[sz]e)\b/i,
  /抱歉[，,]?\s*(?:我|我们)?\s*(?:无法|不能|不可以|不便)/,
  /我(?:无法|不能|不可以)(?:帮助|协助|提供|回答|完成|满足)/,
  /作为(?:一个)?\s*(?:AI|人工智能|语言模型)/i,
  /(?:无法|不能)提供(?:此类|这类|该|相关)/
];

const eligible = (record) => typeof record.completionText === 'string' && record.completionText.trim().length > 0;
const hit = (record) => {
  const text = strOr(record.completionText, '');
  if (!text) return false;
  return REFUSAL_PATTERNS.some((pattern) => pattern.test(text));
};

export function compute(input) {
  return rateMetric(ensureContext(input), { eligible, hit });
}

export default { id, label, unit, weight, worseDirection, critical, definition, compute };
