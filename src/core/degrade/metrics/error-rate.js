/** 指标 9/13：错误响应占比（契约 §11，权重 1.2）。 */
import { isNum, strOr } from '../util.js';
import { ensureContext, rateMetric } from './util.js';

export const id = 'error_rate';
export const label = '错误响应占比';
export const unit = '%';
export const weight = 1.2;
export const worseDirection = 'up';
export const critical = false;
export const definition =
  'HTTP 状态非 2xx 或带错误码的响应占比。上升说明上游在报错 / 限流 / 超时；只统计「能判定成功与否」的记录，不把缺失状态当成成功。';

const eligible = (record) =>
  isNum(record.status) || Boolean(strOr(record.errorCode, ''));
const hit = (record) =>
  (isNum(record.status) && record.status >= 400) || Boolean(strOr(record.errorCode, ''));

export function compute(input) {
  return rateMetric(ensureContext(input), { eligible, hit });
}

export default { id, label, unit, weight, worseDirection, critical, definition, compute };
