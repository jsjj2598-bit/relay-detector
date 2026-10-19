/** 指标 2/13：模型替换率（契约 §11，权重 1.5，critical 项）。 */
import { sameModelFamily } from '../normalize.js';
import { ensureContext, rateMetric } from './util.js';

export const id = 'model_substitution';
export const label = '模型替换率（响应 model ≠ 请求 model）';
export const unit = '%';
export const weight = 1.5;
export const worseDirection = 'up';
export const critical = true;
export const definition =
  '响应里实际返回的 model 与请求时指定的 requestModel 不一致的占比（忽略日期快照 / latest 别名）。上升说明上游可能把请求偷偷路由到更便宜的模型。';

const eligible = (record) =>
  typeof record.model === 'string' &&
  record.model !== '' &&
  typeof record.requestModel === 'string' &&
  record.requestModel !== '';
const hit = (record) => sameModelFamily(record.model, record.requestModel) === false;

export function compute(input) {
  return rateMetric(ensureContext(input), { eligible, hit });
}

export default { id, label, unit, weight, worseDirection, critical, definition, compute };
