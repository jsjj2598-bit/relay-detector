/**
 * 降智倾向评分与判定（契约 v3 §12，FROZEN）。
 *
 *  1. 单指标恶化分：`badness = clamp(|deltaPct| / 0.5, 0, 1)`，只取变差方向；
 *     `deltaPct` 为 null（早期为 0）时用绝对变化量兜底，避免除零。
 *  2. `score = 100 × Σ(badness × weight) / Σ(weight)`，
 *     **分母只统计 status === 'ok' 的指标** —— insufficient 不进分母（与 v2 skip 同源）。
 *  3. `evidenceStrength = saturate(可用指标数 / 4) × saturate(usable / 50)`（契约 v3.1），
 *     `usable` 是参与分析的记录数（kind 为 assistant / usage）。
 *  4. 判定顺序严格按契约表格：指标/记录不足 → critical 一票 → 证据强度闸门 → 60 / 30 阈值。
 */
import {
  BADNESS_FULL_DELTA,
  EVIDENCE_HALF_METRICS,
  EVIDENCE_HALF_RECORDS,
  EVIDENCE_STRENGTH_MIN,
  MIN_SAMPLES_PER_SEGMENT,
  MIN_USABLE_METRICS,
  SCORE_LIKELY_DEGRADED,
  SCORE_SUSPICIOUS,
  SUMMARY_TEXT
} from './constants.js';
import { DEGRADATION_METRICS, METRICS_BY_ID } from './metrics/index.js';
import { deltaPctOf, directionOf } from './metrics/util.js';
import { isNum, isObject, round, saturate } from './util.js';

const WEIGHT_BY_ID = Object.fromEntries(DEGRADATION_METRICS.map((metric) => [metric.id, metric.weight]));

function samplesSatisfied(metric) {
  const samples = isObject(metric.samples) ? metric.samples : null;
  if (!samples) return true; // 直接调用（手工构造指标）时不做二次卡口
  const earlyOk = !isNum(samples.early) || samples.early >= MIN_SAMPLES_PER_SEGMENT;
  const recentOk = !isNum(samples.recent) || samples.recent >= MIN_SAMPLES_PER_SEGMENT;
  return earlyOk && recentOk;
}

/** 指标是否可参与评分：status ok + 前后期都有值 + 样本满足。 */
export function isUsableMetric(metric) {
  if (!isObject(metric)) return false;
  if (metric.status !== 'ok') return false;
  if (!isNum(metric.early) || !isNum(metric.recent)) return false;
  return samplesSatisfied(metric);
}

/**
 * 单指标归一化恶化分（契约 §12）。
 * 返回 0..1；方向不是 worse 时恒为 0（反向变化只在报告里展示，不参与评分）。
 */
export function badnessOf(metric) {
  if (!isObject(metric)) return 0;
  const early = metric.early;
  const recent = metric.recent;
  if (!isNum(early) || !isNum(recent)) return 0;
  const definition = METRICS_BY_ID[metric.id] || {};
  const worseDirection =
    metric.worseDirection === 'down' || metric.worseDirection === 'up'
      ? metric.worseDirection
      : definition.worseDirection === 'down'
        ? 'down'
        : 'up';
  const deltaPct = isNum(metric.deltaPct) ? metric.deltaPct : deltaPctOf(early, recent);
  const direction =
    metric.direction === 'worse' || metric.direction === 'better' || metric.direction === 'flat'
      ? metric.direction
      : directionOf({ worseDirection, minDelta: definition.minDelta }, early, recent, deltaPct);
  if (direction !== 'worse') return 0;
  const magnitude = isNum(deltaPct) ? Math.abs(deltaPct) : Math.abs(recent - early);
  return Math.min(1, Math.max(0, magnitude / BADNESS_FULL_DELTA));
}

/** 当调用方没给记录数时，用可用指标的样本量近似总记录数（仅供直接调用 scoreDegradation）。 */
function inferUsableRecords(metrics) {
  let max = 0;
  for (const metric of metrics) {
    if (!isObject(metric.samples)) continue;
    const early = isNum(metric.samples.early) ? metric.samples.early : 0;
    const recent = isNum(metric.samples.recent) ? metric.samples.recent : 0;
    if (early + recent > max) max = early + recent;
  }
  return max;
}

/**
 * 契约 §12 的评分与判定（纯函数）。
 *
 * @param {object[]} metrics MetricResult[]
 * @param {object[]} findings Finding[]
 * @param {{records?: number, usableRecords?: number, minRecords?: number}} [context]
 *   额外上下文（不改变契约签名）：分析入口会传入真实可用记录数与 minRecords；
 *   直接调用时可省略，此时用指标样本量近似 records。
 * @returns {{score: number, evidenceStrength: number, verdict: string, summaryText: string}}
 */
export function scoreDegradation(metrics, findings, context = {}) {
  const list = (Array.isArray(metrics) ? metrics : []).filter(isObject);
  const findingList = (Array.isArray(findings) ? findings : []).filter(isObject);
  const usable = list.filter(isUsableMetric);

  let weighted = 0;
  let totalWeight = 0;
  for (const metric of usable) {
    const weight = isNum(metric.weight)
      ? metric.weight
      : isNum(WEIGHT_BY_ID[metric.id])
        ? WEIGHT_BY_ID[metric.id]
        : 1;
    if (!(weight > 0)) continue;
    weighted += badnessOf(metric) * weight;
    totalWeight += weight;
  }
  const score = totalWeight > 0 ? (100 * weighted) / totalWeight : 0;

  const usableCount = usable.length;
  const usableRecords =
    isNum(context.usableRecords) && context.usableRecords >= 0
      ? context.usableRecords
      : isNum(context.records) && context.records >= 0
        ? context.records
        : inferUsableRecords(list);
  const minRecords = isNum(context.minRecords) && context.minRecords >= 0 ? context.minRecords : 20;
  const evidenceStrength =
    saturate(usableCount / EVIDENCE_HALF_METRICS) * saturate(usableRecords / EVIDENCE_HALF_RECORDS);

  // 先按「报告里实际展示的数值」舍入，再用它做判定 —— 保证报告自洽：
  // 不会出现「score=60 但 verdict=suspicious」「evidenceStrength=0.35 但 insufficient」。
  const finalScore = round(score, 2) ?? 0;
  const finalEvidenceStrength = round(evidenceStrength, 4) ?? 0;

  const criticalCount = findingList.filter((finding) => finding.severity === 'critical').length;

  let verdict;
  if (usableCount < MIN_USABLE_METRICS || usableRecords < minRecords) {
    verdict = 'insufficient';
  } else if (criticalCount > 0) {
    verdict = 'likely-degraded'; // critical 一票，无论分数
  } else if (finalEvidenceStrength < EVIDENCE_STRENGTH_MIN) {
    verdict = 'insufficient';
  } else if (finalScore >= SCORE_LIKELY_DEGRADED) {
    verdict = 'likely-degraded';
  } else if (finalScore >= SCORE_SUSPICIOUS) {
    verdict = 'suspicious';
  } else {
    verdict = 'stable';
  }

  return {
    score: finalScore,
    evidenceStrength: finalEvidenceStrength,
    verdict,
    summaryText: SUMMARY_TEXT[verdict]
  };
}

export default { scoreDegradation, badnessOf, isUsableMetric };
