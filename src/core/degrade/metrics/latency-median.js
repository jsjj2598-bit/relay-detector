/** 指标 8/13：端到端延迟中位数（契约 §11，权重 0.8）。 */
import { isNum } from '../util.js';
import { ensureContext, medianMetric } from './util.js';

export const id = 'latency_median';
export const label = '延迟中位数';
export const unit = 'ms';
export const weight = 0.8;
export const worseDirection = 'up';
export const critical = false;
export const definition =
  '每期端到端延迟（请求发出到响应结束）的中位数。中位数明显上升可能是上游拥塞、被加了排队 / 限流，也可能是模型被换成了更慢的实现。';

export function compute(input) {
  return medianMetric(ensureContext(input), (record) =>
    isNum(record.latencyMs) && record.latencyMs >= 0 ? record.latencyMs : null
  );
}

export default { id, label, unit, weight, worseDirection, critical, definition, compute };
