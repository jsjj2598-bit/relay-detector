/** 指标 7/13：输出 / 输入 token 比（契约 §11，权重 0.7）。 */
import { isNum } from '../util.js';
import { ensureContext, medianRatioMetric } from './util.js';

export const id = 'completion_ratio';
export const label = '输出 / 输入 token 比';
export const unit = 'ratio';
export const weight = 0.7;
export const worseDirection = 'down';
export const critical = false;
export const definition =
  '输出 token ÷ 输入 token 的中位数。同样的输入下回答越来越短，会让该比值下降；系统提示词变长也会拉低它，因此只能作为辅助信号。';

const eligible = (record) =>
  isNum(record.promptTokens) && record.promptTokens > 0 && isNum(record.completionTokens);

export function compute(input) {
  return medianRatioMetric(ensureContext(input), {
    eligible,
    ratioOf: (record) => record.completionTokens / record.promptTokens
  });
}

export default { id, label, unit, weight, worseDirection, critical, definition, compute };
