/** 指标 13/13：缓存命中率（契约 §11，权重 0.5）。 */
import { isNum } from '../util.js';
import { aggregateRatioMetric, ensureContext } from './util.js';

export const id = 'cache_hit_rate';
export const label = '缓存命中率';
export const unit = '%';
export const weight = 0.5;
export const worseDirection = 'down';
export const critical = false;
export const definition =
  '缓存读取 token 占输入 token 总量（输入 + 缓存读 + 缓存写）的比例。命中率下降意味着前缀缓存失效，会同时推高成本与延迟。';

const eligible = (record) =>
  isNum(record.cacheReadTokens) && (isNum(record.promptTokens) || isNum(record.cacheWriteTokens));

export function compute(input) {
  return aggregateRatioMetric(ensureContext(input), {
    eligible,
    numeratorOf: (record) => record.cacheReadTokens || 0,
    denominatorOf: (record) =>
      (isNum(record.promptTokens) ? record.promptTokens : 0) +
      (isNum(record.cacheReadTokens) ? record.cacheReadTokens : 0) +
      (isNum(record.cacheWriteTokens) ? record.cacheWriteTokens : 0)
  });
}

export default { id, label, unit, weight, worseDirection, critical, definition, compute };
