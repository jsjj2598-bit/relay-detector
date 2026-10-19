/** 指标 4/13：thinking token 占比（契约 §11，权重 1.1）。 */
import { isNum, sum } from '../util.js';
import { buildSeries, ensureContext } from './util.js';

export const id = 'thinking_share';
export const label = 'Thinking token 占比';
export const unit = 'ratio';
export const weight = 1.1;
export const worseDirection = 'down';
export const critical = false;
export const definition =
  '每期的 thinking token 总量 / 输出 token 总量。缺少 thinking token 字段时按「thinking 文本字符数 / 4」估算（会标注为估算口径）。占比下降说明模型的推理过程在被压缩或消失。';

/** 优先使用真实 thinking token；缺失时按字符数 / 4 估算（粗口径，仅用于趋势）。 */
function estimatedThinkingTokens(record) {
  if (isNum(record.thinkingTokens) && record.thinkingTokens >= 0) return record.thinkingTokens;
  if (isNum(record.thinkingChars) && record.thinkingChars >= 0) return record.thinkingChars / 4;
  return null;
}

const eligible = (record) =>
  isNum(estimatedThinkingTokens(record)) && isNum(record.completionTokens) && record.completionTokens > 0;

function computeOne(records) {
  const eligibleRecords = records.filter(eligible);
  if (!eligibleRecords.length) return { value: null, samples: 0 };
  const thinking = sum(eligibleRecords.map((record) => estimatedThinkingTokens(record)));
  const completion = sum(eligibleRecords.map((record) => record.completionTokens));
  if (!(completion > 0)) return { value: null, samples: eligibleRecords.length };
  return { value: thinking / completion, samples: eligibleRecords.length };
}

export function compute(input) {
  const ctx = ensureContext(input);
  const early = computeOne(ctx.early);
  const recent = computeOne(ctx.recent);
  return {
    early: early.value,
    recent: recent.value,
    samples: { early: early.samples, recent: recent.samples },
    series: buildSeries(
      ctx.timed,
      (record) => {
        if (!eligible(record)) return null;
        return estimatedThinkingTokens(record) / record.completionTokens;
      },
      'median'
    )
  };
}

export default { id, label, unit, weight, worseDirection, critical, definition, compute };
