/** 指标 11/13：重复 n-gram 占比（契约 §11，权重 0.7）。 */
import { isNum, mean, round } from '../util.js';
import { buildSeries, ensureContext } from './util.js';

export const id = 'repetition_rate';
export const label = '重复 n-gram 占比';
export const unit = '%';
export const weight = 0.7;
export const worseDirection = 'up';
export const critical = false;
export const definition =
  '每条回答内部重复 4 字符 n-gram 的平均占比（1 - 唯一 n-gram 数 / 总 n-gram 数）。占比上升说明回答开始车轱辘话、局部退化；过短回答不参与计算。';

const NGRAM_SIZE = 4;
const MIN_TEXT_LENGTH = 16;

/** 单条回答的重复度；文本过短返回 null（不参与分母）。 */
export function repetitionOf(text) {
  const normalized = String(text == null ? '' : text).replace(/\s+/g, ' ').trim();
  if (normalized.length < MIN_TEXT_LENGTH) return null;
  const total = normalized.length - NGRAM_SIZE + 1;
  if (total < 8) return null;
  const seen = new Set();
  let unique = 0;
  for (let i = 0; i < total; i += 1) {
    const gram = normalized.slice(i, i + NGRAM_SIZE);
    if (seen.has(gram)) continue;
    seen.add(gram);
    unique += 1;
  }
  return 1 - unique / total;
}

function computeOne(records) {
  const values = [];
  for (const record of records) {
    const value = repetitionOf(record.completionText);
    if (isNum(value)) values.push(value);
  }
  if (!values.length) return { value: null, samples: 0 };
  return { value: mean(values), samples: values.length };
}

export function compute(input) {
  const ctx = ensureContext(input);
  const early = computeOne(ctx.early);
  const recent = computeOne(ctx.recent);
  return {
    early: early.value,
    recent: recent.value,
    samples: { early: early.samples, recent: recent.samples },
    series: buildSeries(ctx.timed, (record) => repetitionOf(record.completionText), 'median')
  };
}

export default { id, label, unit, weight, worseDirection, critical, definition, compute };
