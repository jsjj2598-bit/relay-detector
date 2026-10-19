/** 指标 5/13：字符数 / 输出 token（契约 §11，权重 1.2；降幅 >40% 记 warning）。 */
import { isNum } from '../util.js';
import { ensureContext, medianRatioMetric } from './util.js';

export const id = 'token_inflation';
export const label = '字符数 / 输出 token';
export const unit = 'ratio';
export const weight = 1.2;
export const worseDirection = 'down';
export const critical = false;
export const definition =
  '回答文本的字符数 ÷ 输出 token 数的中位数。这个比值下降通常意味着「同样的文字被算成了更多 token」（token 被多计 / 计费膨胀），也可能只是文本语言或格式变化。';

const eligible = (record) =>
  typeof record.completionText === 'string' &&
  record.completionText.length > 0 &&
  isNum(record.completionTokens) &&
  record.completionTokens > 0;

export function compute(input) {
  return medianRatioMetric(ensureContext(input), {
    eligible,
    ratioOf: (record) => record.completionText.length / record.completionTokens
  });
}

export default { id, label, unit, weight, worseDirection, critical, definition, compute };
