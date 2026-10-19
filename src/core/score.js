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

/**
 * 「官方直连」必须由域名身份支撑。
 *
 * 理由（重要，来自设计评审）：`openai-version` / `openai-processing-ms` / `openai-organization`
 * 这类官方响应头在**反向代理**场景下会被原样透传。一个转发到真实 api.openai.com 的中转站，
 * 会返回完全真实的官方响应头与官方错误报文。因此「响应头像官方」只能证明**上游是真的**，
 * 不能证明**你连的是官方**。
 *
 * 唯一能证明「你连的是官方」的证据是域名身份本身（category === 'url' 的 official 信号）。
 * 没有它时，最多只能说 inconclusive —— 而这恰恰是有价值的结论：
 * 「响应确实来自真实上游，但你并非直连，很可能经由代理访问」。
 */
export const REQUIRE_URL_EVIDENCE_FOR_OFFICIAL = true;

/**
 * 方向判定的**绝对证据量下限**（不是比例）。
 *
 * 理由（重要，来自 verifier 的设计评审）：`score` 是**比例制** —— relayPoints / (relayPoints + officialPoints)。
 * 当没有任何官方方向证据时，只要有**一条**极弱的 relay 信号，score 就会是 100。
 * 例如 `[relay(14,0.4,'headers'), neutral(100,0.85,'url')]`：relayPoints 仅 4.76，
 * 但 score=100，而中立证据把 evidenceStrength 抬到 0.4307 → 判定「高度确信是中转站」。
 * 这会把「只是看到 `server: nginx`」放大成最高置信结论，属于严重假阳性。
 *
 * 因此：只有方向分**绝对量**达到该下限，才允许给出该方向的结论；否则降级为 inconclusive。
 * 取值依据：一条中量级以上的独立证据大约在 15~25 分（如 error.openai_shape、models.cross_family），
 * 而纯弱信号如 headers.gateway_server ≈ 4 分、url.nonstandard_port ≈ 11 分 —— 这些单独出现不足以定性。
 */
export const MIN_DIRECTIONAL_POINTS = 15;

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
  // 方向比例：只由有方向的证据决定。完全没有方向证据时保持 0
  const raw = directional > 0 ? relayPoints / directional : 0;
  const score = Math.round(clamp(raw * 100, 0, 100));

  // 证据强度：方向证据占主导，中立证据最多贡献 30% 的有效量。
  // 注意：中立证据只能说明「我们确实观测到了东西」，不能说明方向，
  // 因此它**绝不能**把一条无方向证据的检测推成 official/relay —— 由 verdictFromScore
  // 的 hasDirectionalEvidence 闸门兜住（见下方注释）。
  const effectiveTotal = directional + neutralPoints * 0.3;
  const evidenceStrength = clamp(effectiveTotal / (effectiveTotal + EVIDENCE_HALF), 0, 1);

  const hasDirectionalEvidence = directional > 0;
  // 域名身份是否被确认为官方/正规厂商端点（契约 2.5 的 OFFICIAL_HOSTS / OFFICIAL_HOST_PATTERNS）
  const urlIdentityConfirmed = list.some((s) => s.category === 'url' && s.verdict === 'official');

  let verdict = verdictFromScore(score, evidenceStrength, hasDirectionalEvidence);

  // 降级闸门：没有域名身份证据时，不允许给出任何「官方直连」方向的结论。
  // 这是为了防住「反向代理透传官方响应头」这一漏判路径。
  const officialDowngraded =
    REQUIRE_URL_EVIDENCE_FOR_OFFICIAL &&
    !urlIdentityConfirmed &&
    (verdict === 'official' || verdict === 'likely-official');
  if (officialDowngraded) verdict = 'inconclusive';

  // 绝对量闸门：比例制 score 会把「唯一的、极弱的方向证据」放大成 100 分，
  // 必须再用方向分的绝对量兜一次，见 MIN_DIRECTIONAL_POINTS 的说明。
  const weakRelayDirection =
    (verdict === 'relay' || verdict === 'likely-relay') && relayPoints < MIN_DIRECTIONAL_POINTS;
  const weakOfficialDirection =
    (verdict === 'official' || verdict === 'likely-official') && officialPoints < MIN_DIRECTIONAL_POINTS;
  const insufficientDirectionalPoints = weakRelayDirection || weakOfficialDirection;
  if (insufficientDirectionalPoints) verdict = 'inconclusive';

  return {
    score,
    officialScore: 100 - score,
    evidenceStrength: Number(evidenceStrength.toFixed(4)),
    verdict,
    relayPoints: Number(relayPoints.toFixed(2)),
    officialPoints: Number(officialPoints.toFixed(2)),
    neutralPoints: Number(neutralPoints.toFixed(2)),
    directionalPoints: Number(directional.toFixed(2)),
    flags: {
      hasDirectionalEvidence,
      urlIdentityConfirmed,
      officialDowngraded,
      insufficientDirectionalPoints,
      /** 上游看起来是真的官方实现（官方证据显著），但域名身份未确认 ⇒ 很可能经由代理访问。 */
      upstreamLooksGenuine: officialDowngraded && officialPoints >= 25
    },
    breakdown
  };
}

/**
 * 由分数与证据强度推导判定。
 *
 * @param {number} score 0..100，越高越像中转
 * @param {number} evidenceStrength 0..1
 * @param {boolean} [hasDirectionalEvidence=true] 是否存在任何**有方向**的证据（relay 或 official）。
 *   这是关键闸门：当中立证据（CDN 头、公共 CA、边缘拦截响应等）占主导而没有任何方向证据时，
 *   neutral 贡献仍会抬高 evidenceStrength；若不拦截，score=0 会一路落到 `official`，
 *   把「什么方向都没看出来」误报成「官方直连」。实测中 api.anthropic.com 本身就在 Cloudflare 后，
 *   因此这类场景非常常见，必须保守判为 inconclusive。
 * @returns {'relay'|'likely-relay'|'inconclusive'|'likely-official'|'official'}
 */
export function verdictFromScore(score, evidenceStrength, hasDirectionalEvidence = true) {
  const s = clamp(num(score), 0, 100);
  const e = clamp(num(evidenceStrength), 0, 1);
  if (!hasDirectionalEvidence) return 'inconclusive';
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
