/** 指标 3/13：thinking 出现率（契约 §11，权重 1.3，critical 项）。 */
import { hasThinking, hasThinkingInfo } from '../normalize.js';
import { ensureContext, rateMetric } from './util.js';

export const id = 'thinking_presence';
export const label = 'Thinking 出现率';
export const unit = '%';
export const weight = 1.3;
export const worseDirection = 'down';
export const critical = true;
export const definition =
  '带有 thinking 内容块或思考 token 的记录占比（只看「能观测到 thinking」的记录）。出现率从早期 >50% 掉到近期 ≈0，说明模型可能被换成了不带推理的版本，或推理能力被关闭。';

const eligible = (record) => hasThinkingInfo(record);
const hit = (record) => hasThinking(record);

export function compute(input) {
  return rateMetric(ensureContext(input), { eligible, hit });
}

export default { id, label, unit, weight, worseDirection, critical, definition, compute };
