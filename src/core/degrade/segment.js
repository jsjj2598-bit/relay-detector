/**
 * 前后期切分与变化点探测（契约 v3 §12 / 任务书第 7 项）。
 *
 * 策略（`segment: 'auto'`，默认）：
 *  1. 按时间戳排序；**时间戳为 null 的记录不参与切分**（契约要求不伪造时间）；
 *  2. 对若干候选切分点（主窗口 20%~80% 步长 5%，外加边缘窗口「最近 5%~15% vs 其余」），
 *     把「归一化健康分」的前后期中位数之差作为差异度，取差异最大者作为变化点；
 *  3. 差异度低于阈值（≈噪声）时退回「按记录数均分」——避免在稳定数据上强行切出假变化点；
 *  4. 数据量大时先等距采样（≤5000 条）再评估，整体复杂度 O(n)，避免 O(n²)。
 *
 * `segment: 'early-recent'` 时直接按记录数半分，不做变化点探测。
 */
import { TRUNCATION_FINISH_REASONS } from './constants.js';
import { hasThinking, hasThinkingInfo, isTimedRecord, isUsableRecord, sameModelFamily } from './normalize.js';
import { clamp, isNum, median, strOr } from './util.js';

/** 候选切分点比例：主窗口 + 边缘窗口（「最近这段变笨」最常见）。 */
const CANDIDATE_MIN = 0.2;
const CANDIDATE_MAX = 0.8;
const CANDIDATE_STEP = 0.05;
/** 边缘窗口候选：最近 15% / 10% / 7.5% / 5% vs 其余。 */
const EDGE_FRACTIONS = [0.85, 0.9, 0.925, 0.95];
/** 变化点评估的最大采样条数（防止大文件把浏览器卡死）。 */
const CHANGE_POINT_MAX_SAMPLE = 5000;
/** 差异度阈值：低于该值认为「没有可识别的变化点」。 */
const CHANGE_POINT_THRESHOLD = 0.2;
/** 每侧最少记录数。 */
const MIN_SIDE = 5;

/** 记录数组按时间排序（稳定排序：时间相同按 index）。 */
function sortByTime(records) {
  return [...records].sort(
    (a, b) => (a.timestamp ?? 0) - (b.timestamp ?? 0) || (a.index ?? 0) - (b.index ?? 0)
  );
}

/** 单条记录的「健康特征」：值 + 方向符号（+1 = 越大越好，-1 = 越大越差）。 */
function featuresOf(record) {
  const features = [];
  if (isNum(record.completionTokens)) features.push(['completionTokens', record.completionTokens, 1]);
  if (isNum(record.latencyMs)) features.push(['latency', record.latencyMs, -1]);
  if (typeof record.finishReason === 'string' && record.finishReason) {
    const truncated = TRUNCATION_FINISH_REASONS.has(record.finishReason.toLowerCase());
    features.push(['truncation', truncated ? 1 : 0, -1]);
  }
  if (hasThinkingInfo(record)) features.push(['thinking', hasThinking(record) ? 1 : 0, 1]);
  if (strOr(record.model, '') && strOr(record.requestModel, '')) {
    features.push(['modelMatch', sameModelFamily(record.model, record.requestModel) === false ? 0 : 1, 1]);
  }
  if (isNum(record.status) || strOr(record.errorCode, '')) {
    const failed = (isNum(record.status) && record.status >= 400) || Boolean(strOr(record.errorCode, ''));
    features.push(['error', failed ? 1 : 0, -1]);
  }
  return features;
}

/**
 * 变化点探测：返回 `{ splitIndex, score }` 或 null（无显著变化）。
 *
 * @param {object[]} timed 已按时间排序的可用记录
 */
export function detectChangePoint(timed) {
  const n = Array.isArray(timed) ? timed.length : 0;
  if (n < 20) return null;

  const stride = Math.max(1, Math.ceil(n / CHANGE_POINT_MAX_SAMPLE));
  const sample = [];
  for (let i = 0; i < n; i += stride) sample.push({ record: timed[i], origIndex: i });
  const m = sample.length;
  if (m < 20) return null;

  // 1) 每个特征的全局中位数与稳健尺度（MAD；全相同则跳过该特征）
  const featureStats = [];
  for (const key of ['completionTokens', 'latency', 'truncation', 'thinking', 'modelMatch', 'error']) {
    const pairs = sample
      .map(({ record }) => featuresOf(record).find((feature) => feature[0] === key))
      .filter(Boolean);
    if (pairs.length < Math.min(20, Math.floor(m * 0.2))) continue;
    const values = pairs.map((pair) => pair[1]);
    const center = median(values);
    const mad = median(values.map((value) => Math.abs(value - center)));
    let scale = isNum(mad) ? mad : 0;
    if (!(scale > 0)) {
      const min = Math.min(...values);
      const max = Math.max(...values);
      scale = max > min ? (max - min) / 4 : 0;
    }
    if (!(scale > 0)) continue;
    featureStats.push({ key, center, scale, sign: pairs[0][2] });
  }
  if (featureStats.length === 0) return null;

  // 2) 每条采样记录 → 归一化健康分 z（越大越好）
  const z = sample.map(({ record }) => {
    const features = featuresOf(record);
    let total = 0;
    let count = 0;
    for (const stat of featureStats) {
      const feature = features.find((item) => item[0] === stat.key);
      if (!feature) continue;
      const normalized = stat.sign * ((feature[1] - stat.center) / stat.scale);
      total += clamp(normalized, -4, 4);
      count += 1;
    }
    return count > 0 ? total / count : 0;
  });

  // 3) 候选切分点：比较前后期 z 中位数之差
  //    主窗口 20%~80% 适合「中途开始退化」；
  //    边缘窗口（最近 15% / 10% / 7.5% / 5% vs 其余）覆盖最常见的「最近这段变笨」。
  const minSide = Math.max(MIN_SIDE, Math.floor(m * 0.15));
  const edgeMinSide = Math.max(MIN_SIDE, Math.floor(m * 0.01));
  const candidates = [];
  for (let fraction = CANDIDATE_MIN; fraction <= CANDIDATE_MAX + 1e-9; fraction += CANDIDATE_STEP) {
    candidates.push({ k: Math.round(m * fraction), minRecent: minSide });
  }
  for (const fraction of EDGE_FRACTIONS) {
    candidates.push({ k: Math.round(m * fraction), minRecent: edgeMinSide });
  }

  let best = null;
  for (const candidate of candidates) {
    const k = candidate.k;
    if (k < minSide || m - k < candidate.minRecent) continue;
    const earlyMedian = median(z.slice(0, k));
    const recentMedian = median(z.slice(k));
    if (!isNum(earlyMedian) || !isNum(recentMedian)) continue;
    const diff = Math.abs(earlyMedian - recentMedian);
    // 差异度相同时取更接近正中间（50%）的候选，避免把切分点推到 20% / 80% / 95% 的边界。
    const better =
      !best ||
      diff > best.diff + 1e-9 ||
      (Math.abs(diff - best.diff) <= 1e-9 && Math.abs(k - m / 2) < Math.abs(best.k - m / 2));
    if (better) best = { diff, k };
  }
  if (!best || best.diff < CHANGE_POINT_THRESHOLD) return null;
  const samplePoint = sample[Math.min(best.k, m - 1)];
  const splitIndex = clamp(samplePoint ? samplePoint.origIndex : Math.floor(n / 2), MIN_SIDE, n - MIN_SIDE);
  return { splitIndex, score: best.diff };
}

/**
 * 切分记录。
 *
 * @param {object[]} records 全部解析记录（内部会自己筛 usable / timed）
 * @param {{segment?: 'auto'|'early-recent'}} [options]
 * @returns {{
 *   early: object[], recent: object[], timed: object[],
 *   splitIndex: number, splitAt: number|null,
 *   method: 'change-point'|'half'|'none'|'single', untimedCount: number
 * }}
 */
export function segmentRecords(records, options = {}) {
  const list = (Array.isArray(records) ? records : []).filter(isUsableRecord);
  const timed = sortByTime(list.filter(isTimedRecord));
  const untimedCount = list.length - timed.length;
  const n = timed.length;
  const mode = options && options.segment === 'early-recent' ? 'early-recent' : 'auto';

  if (n === 0) {
    return { early: [], recent: [], timed: [], splitIndex: 0, splitAt: null, method: 'none', untimedCount };
  }
  if (n === 1) {
    return {
      early: [timed[0]],
      recent: [],
      timed,
      splitIndex: 1,
      splitAt: null,
      method: 'single',
      untimedCount
    };
  }

  let splitIndex = Math.floor(n / 2);
  let method = 'half';
  if (mode === 'auto') {
    const changePoint = detectChangePoint(timed);
    if (changePoint) {
      splitIndex = changePoint.splitIndex;
      method = 'change-point';
    }
  }
  splitIndex = clamp(splitIndex, 1, n - 1);
  const splitAt = isNum(timed[splitIndex]?.timestamp) ? timed[splitIndex].timestamp : null;
  return {
    early: timed.slice(0, splitIndex),
    recent: timed.slice(splitIndex),
    timed,
    splitIndex,
    splitAt,
    method,
    untimedCount
  };
}

/** 报告里的 `segments` 形状（契约 §10.3）。 */
export function publicSegments(segment) {
  const rangeOf = (records) => ({
    count: records.length,
    from: records.length > 0 ? records[0].timestamp ?? null : null,
    to: records.length > 0 ? records[records.length - 1].timestamp ?? null : null
  });
  return {
    early: rangeOf(segment.early),
    recent: rangeOf(segment.recent),
    splitAt: isNum(segment.splitAt) ? segment.splitAt : null
  };
}

export default { segmentRecords, detectChangePoint, publicSegments };
