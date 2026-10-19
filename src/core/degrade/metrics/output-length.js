/** 指标 6/13：输出 token 中位数（契约 §11，权重 1.0）。 */
import { isNum } from '../util.js';
import { ensureContext, medianMetric } from './util.js';

export const id = 'output_length';
export const label = '输出 token 中位数';
export const unit = 'tok';
export const weight = 1.0;
export const worseDirection = 'down';
export const critical = false;
export const definition =
  '每期输出 token 的中位数。中位数明显下降说明回答整体变短；可能是被截断、模型被换成更简短的版本，也可能是任务分布变化。';

export function compute(input) {
  return medianMetric(ensureContext(input), (record) =>
    isNum(record.completionTokens) ? record.completionTokens : null
  );
}

export default { id, label, unit, weight, worseDirection, critical, definition, compute };
