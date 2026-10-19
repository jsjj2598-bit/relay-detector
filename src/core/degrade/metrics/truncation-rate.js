/** 指标 1/13：截断率（契约 §11，权重 1.4，critical 项）。 */
import { TRUNCATION_FINISH_REASONS } from '../constants.js';
import { strOr } from '../util.js';
import { ensureContext, rateMetric } from './util.js';

export const id = 'truncation_rate';
export const label = '截断率（finish_reason=length）';
export const unit = '%';
export const weight = 1.4;
export const worseDirection = 'up';
export const critical = true;
export const definition =
  'finish_reason 为 length / max_tokens 的响应占比。截断率上升说明回答被长度上限强行掐断，可能是 max_tokens 被改小或模型被换成输出上限更低的版本。';

const eligible = (record) => Boolean(strOr(record.finishReason, ''));
const hit = (record) => TRUNCATION_FINISH_REASONS.has(strOr(record.finishReason, '').toLowerCase());

export function compute(input) {
  return rateMetric(ensureContext(input), { eligible, hit });
}

export default { id, label, unit, weight, worseDirection, critical, definition, compute };
