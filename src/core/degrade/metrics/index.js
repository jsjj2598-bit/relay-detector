/**
 * 13 个降智指标注册表（契约 v3 §11，顺序与冻结表格一致）。
 *
 * 每个指标模块导出 `{ id, label, unit, weight, worseDirection, critical, definition, compute }`，
 * 这里把它们组装成 `DEGRADATION_METRICS`，并统一做两件事：
 *  1. `computeMetrics(ctx)`：逐个指标计算（单个指标抛异常只降级为 `insufficient`，不影响其它）；
 *  2. `finalizeMetric()`：套上契约 §10.4 的 MetricResult 形状 + 样本闸门 + 方向判定。
 */
import { METRIC_MIN_DELTA, MIN_SAMPLES_PER_SEGMENT, SERIES_MAX_POINTS } from '../constants.js';
import { isNum, isObject, round } from '../util.js';
import { deltaPctOf, directionOf, ensureContext } from './util.js';

import * as truncationRate from './truncation-rate.js';
import * as modelSubstitution from './model-substitution.js';
import * as thinkingPresence from './thinking-presence.js';
import * as thinkingShare from './thinking-share.js';
import * as tokenInflation from './token-inflation.js';
import * as outputLength from './output-length.js';
import * as completionRatio from './completion-ratio.js';
import * as latencyMedian from './latency-median.js';
import * as errorRate from './error-rate.js';
import * as refusalRate from './refusal-rate.js';
import * as repetitionRate from './repetition-rate.js';
import * as emptyRate from './empty-rate.js';
import * as cacheHitRate from './cache-hit-rate.js';

const MODULES = [
  truncationRate,
  modelSubstitution,
  thinkingPresence,
  thinkingShare,
  tokenInflation,
  outputLength,
  completionRatio,
  latencyMedian,
  errorRate,
  refusalRate,
  repetitionRate,
  emptyRate,
  cacheHitRate
];

/** 契约 §11 的 13 个指标（顺序冻结）。 */
export const DEGRADATION_METRICS = MODULES.map((module) => ({
  id: module.id,
  label: module.label,
  unit: module.unit,
  weight: module.weight,
  worseDirection: module.worseDirection,
  critical: module.critical === true,
  definition: module.definition,
  compute: module.compute,
  minDelta: METRIC_MIN_DELTA[module.id] ?? 0
}));

export const METRIC_IDS = DEGRADATION_METRICS.map((metric) => metric.id);

export const METRICS_BY_ID = Object.fromEntries(DEGRADATION_METRICS.map((metric) => [metric.id, metric]));

const EMPTY_SAMPLES = () => ({ early: 0, recent: 0 });

/** 清理 series：只保留 `{t:number|null, v:number}`，且不超过契约上限。 */
function sanitizeSeries(series) {
  const list = Array.isArray(series) ? series : [];
  const points = [];
  for (const point of list) {
    if (points.length >= SERIES_MAX_POINTS) break;
    if (!isObject(point) || !isNum(point.v)) continue;
    points.push({ t: isNum(point.t) ? point.t : null, v: round(point.v, 6) });
  }
  return points;
}

/**
 * 生成一条 MetricResult（契约 §10.4）。
 *
 * 样本闸门：早期/近期都需要 ≥ `MIN_SAMPLES_PER_SEGMENT`(5) 个样本，
 * 否则 `status: 'insufficient'` —— 这类指标**不进入评分分母**，
 * 也不会在报告里被显示成 0（契约 §11 末注 / §12）。
 */
export function finalizeMetric(metric, raw = {}) {
  const source = isObject(raw) ? raw : {};
  const early = isNum(source.early) ? round(source.early, 6) : null;
  const recent = isNum(source.recent) ? round(source.recent, 6) : null;
  const rawSamples = isObject(source.samples) ? source.samples : {};
  const samples = {
    early: isNum(rawSamples.early) && rawSamples.early > 0 ? Math.round(rawSamples.early) : 0,
    recent: isNum(rawSamples.recent) && rawSamples.recent > 0 ? Math.round(rawSamples.recent) : 0
  };
  const deltaPct = deltaPctOf(early, recent);
  const enoughSamples =
    samples.early >= MIN_SAMPLES_PER_SEGMENT && samples.recent >= MIN_SAMPLES_PER_SEGMENT;
  const status = early !== null && recent !== null && enoughSamples ? 'ok' : 'insufficient';
  const direction = directionOf(metric, early, recent, deltaPct);
  return {
    id: metric.id,
    label: metric.label,
    unit: metric.unit,
    status,
    early,
    recent,
    deltaPct: deltaPct === null ? null : round(deltaPct, 4),
    direction,
    samples,
    series: sanitizeSeries(source.series),
    definition: metric.definition
  };
}

/**
 * 计算全部 13 个指标。
 *
 * @param {object|object[]} input `{early, recent, timed, all}` 或裸记录数组
 * @returns {object[]} 契约 §10.4 的 MetricResult[]
 */
export function computeMetrics(input) {
  const ctx = ensureContext(input);
  return DEGRADATION_METRICS.map((metric) => {
    try {
      return finalizeMetric(metric, metric.compute(ctx));
    } catch {
      // 单个指标失败绝不影响整份报告：降级为 insufficient（不进分母）。
      return finalizeMetric(metric, { early: null, recent: null, samples: EMPTY_SAMPLES(), series: [] });
    }
  });
}

/** 全部指标不可用时的一组空 MetricResult（内部错误兜底用）。 */
export function emptyMetrics() {
  return DEGRADATION_METRICS.map((metric) =>
    finalizeMetric(metric, { early: null, recent: null, samples: EMPTY_SAMPLES(), series: [] })
  );
}

export default { DEGRADATION_METRICS, METRIC_IDS, METRICS_BY_ID, computeMetrics, finalizeMetric, emptyMetrics };
