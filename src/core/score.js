/**
 * 评分与判定（冻结模块，Lead 所有）。
 *
 * 设计目标：可解释、可测试、不会因为「没有任何证据」而误判成官方直连。
 *
 * 术语：
 * - 每条 Signal 的贡献 contribution = weight * confidence
 *   weight ∈ [0,100] 表示「该特征成立时的指示强度」
 *   confidence ∈ [0,1] 表示「该特征被正确观测/解读的可信度」
 * - relayPoints   = Σ 所有 verdict === 'relay'   的贡献
 * - officialPoints= Σ 所有 verdict === 'official' 的贡献
 * - 中立信号只计入 neutralPoints，不影响方向，但会略微提升 evidenceStrength
 */

/** 类别权重：某类证据整体更可信时给更高系数。 */
export const CATEGORY_WEIGHTS = {
  url: 1.0,
  tls: 1.25,
  headers: 0.85,
  error: 1.3,
  models: 0.8,
  payload: 1.15,
  behavior: 0.5,
  signature: 1.4
};

/** 判定阈值（见 docs/CONTRACT.md 2.4）。 */
export const VERDICT_THRESHOLDS = {
  evidenceStrengthMin: 0.4,
  relay: 70,
  likelyRelay: 58,
  likelyOfficial: 42,
  official: 30
};

/** 证据强度饱和常数：evidenceStrength = total / (total + EVIDENCE_HALF) */
export const EVIDENCE_HALF = 40;

export const VERDICT_LABELS = {
  relay: '高度确信是中转站',
  'likely-relay': '疑似中转站',
  inconclusive: '证据不足 / 无法判定',
  'likely-official': '疑似官方直连',
  official: '官方直连特征明显'
};

export const VERDICT_TONES = {
  relay: 'danger',
  'likely-relay': 'warn',
  inconclusive: 'neutral',
  'likely-official': 'info',
  official: 'success'
};

const clamp = (n, lo, hi) => Math.min(hi, Math.max(lo, n));

/** 安全取数：非有限数一律当作缺省值。 */
const num = (v, fallback = 0) => (typeof v === 'number' && Number.isFinite(v) ? v : fallback);

/**
 * 计算单条信号的贡献值。
 * @param {{weight?:number, confidence?:number, category?:string}} signal
 * @param {Record<string, number>} categoryWeights
 */
export function contributionOf(signal, categoryWeights = CATEGORY_WEIGHTS) {
  if (!signal || typeof signal !== 'object') return 0;
  const w = clamp(num(signal.weight), 0, 100);
  const c = clamp(num(signal.confidence, 1), 0, 1);
  const cw = num(categoryWeights[signal.category], 1);
  return w * c * cw;
}

/**
 * 汇总所有信号，得到分数与判定。
 * @param {Array<object>} signals
 * @param {Record<string, number>} [categoryWeights]
 */
export function scoreSignals(signals, categoryWeights = CATEGORY_WEIGHTS) {
  const list = Array.isArray(signals) ? signals.filter((s) => s && typeof s === 'object') : [];

  let relayPoints = 0;
  let officialPoints = 0;
  let neutralPoints = 0;
  /** @type {Record<string, {relay:number, official:number, neutral:number}>} */
  const breakdown = {};

  for (const s of list) {
    const cat = typeof s.category === 'string' ? s.category : 'other';
    if (!breakdown[cat]) breakdown[cat] = { relay: 0, official: 0, neutral: 0 };
    const pts = contributionOf(s, categoryWeights);
    if (s.verdict === 'relay') {
      relayPoints += pts;
      breakdown[cat].relay += pts;
    } else if (s.verdict === 'official') {
      officialPoints += pts;
      breakdown[cat].official += pts;
    } else {
      neutralPoints += pts;
      breakdown[cat].neutral += pts;
    }
  }

  const directional = relayPoints + officialPoints;
  // 方向比例：只由有方向的证据决定。完全没有方向证据时保持 0（→ 配合低证据强度判为 inconclusive）
  const raw = directional > 0 ? relayPoints / directional : 0;
  const score = Math.round(clamp(raw * 100, 0, 100));

  // 证据强度：方向证据占主导，中立证据最多贡献 30% 的有效量
  const effectiveTotal = directional + neutralPoints * 0.3;
  const evidenceStrength = clamp(effectiveTotal / (effectiveTotal + EVIDENCE_HALF), 0, 1);

  const verdict = verdictFromScore(score, evidenceStrength);

  return {
    score,
    officialScore: 100 - score,
    evidenceStrength: Number(evidenceStrength.toFixed(4)),
    verdict,
    relayPoints: Number(relayPoints.toFixed(2)),
    officialPoints: Number(officialPoints.toFixed(2)),
    neutralPoints: Number(neutralPoints.toFixed(2)),
    breakdown
  };
}

/**
 * 由分数与证据强度推导判定。
 * @param {number} score 0..100
 * @param {number} evidenceStrength 0..1
 * @returns {'relay'|'likely-relay'|'inconclusive'|'likely-official'|'official'}
 */
export function verdictFromScore(score, evidenceStrength) {
  const s = clamp(num(score), 0, 100);
  const e = clamp(num(evidenceStrength), 0, 1);
  if (e < VERDICT_THRESHOLDS.evidenceStrengthMin) return 'inconclusive';
  if (s >= VERDICT_THRESHOLDS.relay) return 'relay';
  if (s >= VERDICT_THRESHOLDS.likelyRelay) return 'likely-relay';
  if (s >= VERDICT_THRESHOLDS.likelyOfficial) return 'inconclusive';
  if (s >= VERDICT_THRESHOLDS.official) return 'likely-official';
  return 'official';
}

/** 按贡献从大到小排序（报告展示顺序）。 */
export function sortSignalsByContribution(signals, categoryWeights = CATEGORY_WEIGHTS) {
  return [...(Array.isArray(signals) ? signals : [])]
    .map((s, i) => ({ s, i, c: contributionOf(s, categoryWeights) }))
    .sort((a, b) => (b.c - a.c) || (a.i - b.i))
    .map((x) => x.s);
}
