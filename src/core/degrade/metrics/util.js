/**
 * 指标计算公共工具（契约 v3 §10.4）。
 *
 * 约定：
 *  - 每个指标只能看到「已按时间切分好的前后期记录」（`ctx.early` / `ctx.recent`）；
 *  - `ctx.timed` 是全部按时序排列的可用记录，用于生成折线图 `series`；
 *  - `samples` 是**参与该指标计算**的记录数（不是全部记录）；
 *  - 没有足够样本时 `status: 'insufficient'`，绝不把缺失值当 0 分（契约 §12）。
 *
 * 另外为了兼容「直接对一个记录数组调用指标 compute(records)」的离线测试，
 * `ensureContext` 接受数组并临时按时间中位数切半分。
 */
import { FLAT_RELATIVE_BAND, SERIES_MAX_POINTS } from '../constants.js';
import { isNum, isObject, mean, median, round, sum } from '../util.js';

/** 把传入的 ctx 或裸记录数组归一成 `{early, recent, timed, all}`。 */
export function ensureContext(input) {
  if (Array.isArray(input)) {
    const all = input.filter((record) => isObject(record));
    const timed = all
      .filter((record) => isNum(record.timestamp))
      .sort((a, b) => a.timestamp - b.timestamp || (a.index ?? 0) - (b.index ?? 0));
    const half = Math.floor(timed.length / 2);
    return { early: timed.slice(0, half), recent: timed.slice(half), timed, all };
  }
  if (isObject(input)) {
    const early = Array.isArray(input.early) ? input.early.filter((record) => isObject(record)) : [];
    const recent = Array.isArray(input.recent) ? input.recent.filter((record) => isObject(record)) : [];
    const timed = Array.isArray(input.timed)
      ? input.timed.filter((record) => isObject(record))
      : [...early, ...recent];
    const all = Array.isArray(input.all) ? input.all.filter((record) => isObject(record)) : timed;
    return { early, recent, timed, all };
  }
  return { early: [], recent: [], timed: [], all: [] };
}

/**
 * 生成 series（最多 500 点）。
 * - 记录数 ≤ 500：每个记录一个点（rate 指标就是 0/1）；
 * - 记录数 > 500：按数量均分成 500 个桶，桶内取中位数（rate 指标取均值），
 *   既保持趋势又可读，且绝不会超过契约上限。
 */
export function buildSeries(timed, valueFn, aggregate = 'median') {
  const records = Array.isArray(timed) ? timed : [];
  const n = records.length;
  if (!n) return [];
  if (n <= SERIES_MAX_POINTS) {
    const points = [];
    for (const record of records) {
      const value = valueFn(record);
      if (!isNum(value)) continue;
      points.push({ t: isNum(record.timestamp) ? record.timestamp : null, v: round(value, 6) });
    }
    return points;
  }
  const buckets = SERIES_MAX_POINTS;
  const points = [];
  for (let bucket = 0; bucket < buckets; bucket += 1) {
    const start = Math.floor((bucket * n) / buckets);
    const end = Math.floor(((bucket + 1) * n) / buckets);
    if (end <= start) continue;
    const values = [];
    let t = null;
    for (let i = start; i < end; i += 1) {
      const record = records[i];
      if (t === null && isNum(record.timestamp)) t = record.timestamp;
      const value = valueFn(record);
      if (isNum(value)) values.push(value);
    }
    if (!values.length) continue;
    const value = aggregate === 'mean' ? mean(values) : aggregate === 'sum' ? sum(values) : median(values);
    if (!isNum(value)) continue;
    points.push({ t, v: round(value, 6) });
  }
  return points.slice(0, SERIES_MAX_POINTS);
}

/** 比率类指标：每期「命中数 / 可判定数」。 */
export function rateMetric(ctx, { eligible, hit }) {
  const earlyEligible = ctx.early.filter(eligible);
  const recentEligible = ctx.recent.filter(eligible);
  const early = earlyEligible.length > 0 ? earlyEligible.filter(hit).length / earlyEligible.length : null;
  const recent = recentEligible.length > 0 ? recentEligible.filter(hit).length / recentEligible.length : null;
  return {
    early,
    recent,
    samples: { early: earlyEligible.length, recent: recentEligible.length },
    series: buildSeries(
      ctx.timed,
      (record) => (eligible(record) ? (hit(record) ? 1 : 0) : null),
      'mean'
    )
  };
}

/** 中位数类指标：对一个数值字段取中位数。 */
export function medianMetric(ctx, pickFn) {
  const earlyValues = ctx.early.map(pickFn).filter(isNum);
  const recentValues = ctx.recent.map(pickFn).filter(isNum);
  return {
    early: median(earlyValues),
    recent: median(recentValues),
    samples: { early: earlyValues.length, recent: recentValues.length },
    series: buildSeries(ctx.timed, pickFn, 'median')
  };
}

/** 中位数比率类指标：每条记录先算比值，再取中位数。 */
export function medianRatioMetric(ctx, { eligible, ratioOf }) {
  const valueOf = (record) => (eligible(record) ? ratioOf(record) : null);
  const earlyValues = ctx.early.map(valueOf).filter(isNum);
  const recentValues = ctx.recent.map(valueOf).filter(isNum);
  return {
    early: median(earlyValues),
    recent: median(recentValues),
    samples: { early: earlyValues.length, recent: recentValues.length },
    series: buildSeries(ctx.timed, valueOf, 'median')
  };
}

/** 聚合比率类指标：先分别求和再相除（用于「缓存命中 / 总输入」这类口径）。 */
export function aggregateRatioMetric(ctx, { eligible, numeratorOf, denominatorOf }) {
  const computeOne = (records) => {
    const eligibleRecords = records.filter(eligible);
    let numerator = 0;
    let denominator = 0;
    for (const record of eligibleRecords) {
      numerator += numeratorOf(record) || 0;
      denominator += denominatorOf(record) || 0;
    }
    if (eligibleRecords.length === 0) return { value: null, samples: 0 };
    if (!(denominator > 0)) return { value: null, samples: eligibleRecords.length };
    return { value: numerator / denominator, samples: eligibleRecords.length };
  };
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
        const denominator = denominatorOf(record);
        if (!isNum(denominator) || denominator <= 0) return null;
        return (numeratorOf(record) || 0) / denominator;
      },
      'median'
    )
  };
}

/** `(recent - early) / |early|`；早期为 0 且近期非 0 时返回 null（相对变化无定义）。 */
export function deltaPctOf(early, recent) {
  if (!isNum(early) || !isNum(recent)) return null;
  if (early === 0) return recent === 0 ? 0 : null;
  return (recent - early) / Math.abs(early);
}

/**
 * 方向判定（契约 §10.4：'worse' | 'better' | 'flat'）。
 *
 * 两层死区，避免把统计噪声当趋势：
 *  1. 绝对死区：|recent-early| <= metric.minDelta 一律 flat；
 *  2. 相对死区：|deltaPct| < 5% 一律 flat。
 * 只有越过死区、且朝「变差方向」（`worseDirection`）变化时才记 `worse`。
 */
export function directionOf(metric, early, recent, deltaPct) {
  if (!isNum(early) || !isNum(recent)) return 'flat';
  const absDelta = Math.abs(recent - early);
  const minDelta = isNum(metric && metric.minDelta) ? metric.minDelta : 0;
  if (absDelta <= minDelta) return 'flat';
  const worseDirection = metric && metric.worseDirection === 'down' ? 'down' : 'up';
  if (deltaPct === null || early === 0) {
    if (recent === early) return 'flat';
    const increasing = recent > early;
    return worseDirection === 'up'
      ? increasing
        ? 'worse'
        : 'better'
      : increasing
        ? 'better'
        : 'worse';
  }
  if (Math.abs(deltaPct) < FLAT_RELATIVE_BAND) return 'flat';
  const increasing = deltaPct > 0;
  return worseDirection === 'up'
    ? increasing
      ? 'worse'
      : 'better'
    : increasing
      ? 'better'
      : 'worse';
}

/** 记录里是否有可观测的完成文本（用于空回答 / 重复度等指标的分母判定）。 */
export function hasObservedCompletion(record) {
  if (!isObject(record)) return false;
  if (record.completionObserved === true) return true;
  if (isNum(record.completionTokens)) return true;
  return typeof record.completionText === 'string' && record.completionText.length > 0;
}

export default {
  ensureContext,
  buildSeries,
  rateMetric,
  medianMetric,
  medianRatioMetric,
  aggregateRatioMetric,
  deltaPctOf,
  directionOf,
  hasObservedCompletion
};
