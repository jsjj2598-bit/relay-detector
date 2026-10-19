/** 指标 12/13：空回答占比（契约 §11，权重 0.9）。 */
import { isNum, strOr } from '../util.js';
import { ensureContext, rateMetric } from './util.js';

export const id = 'empty_rate';
export const label = '空回答占比';
export const unit = '%';
export const weight = 0.9;
export const worseDirection = 'up';
export const critical = false;
export const definition =
  '既没有文本、输出 token 也为 0（或缺失）的**真实回答**占比。只统计「确实观测到完成内容」的记录：日志里的占位消息 / keepalive / 纯空白且没有 token 记录的条目不进分母，否则会把「日志没记内容」误判成「上游返回空响应」。';

/**
 * 是否进入 empty_rate 的分母。
 *
 * 收紧规则（v3.1 修复占位消息误报）：
 *  - `completionObserved === false`：明确没有观测到完成内容 → 不进分母；
 *  - 文本非空白：有真实回答 → 进分母（用于计算「非空」）；
 *  - 有 token 计数字段：进分母（`0` 才是真实空回答；`>0` 是「有 token 没文本」，两种都算信号）；
 *  - `completionObserved === true` 但「纯空白 + 没有 token 记录」：不携带回答信号
 *    （典型如 Codex 的 keepalive 空格消息、OpenAI tool_calls-only 的 content=null）
 *    → **不进分母**，避免把日志占位符算成上游空响应。
 */
const eligible = (record) => {
  if (record.completionObserved === false) return false;
  const text = strOr(record.completionText, '');
  if (text.trim().length > 0) return true;
  if (isNum(record.completionTokens)) return true;
  return false;
};
const hit = (record) => {
  const text = strOr(record.completionText, '');
  if (text.trim().length > 0) return false;
  return !isNum(record.completionTokens) || record.completionTokens === 0;
};

export function compute(input) {
  return rateMetric(ensureContext(input), { eligible, hit });
}

export default { id, label, unit, weight, worseDirection, critical, definition, compute };
