/**
 * 降智诊断（契约 v3）冻结常量。
 *
 * 所有阈值都来自 `docs/CONTRACT.md` §11 / §12 / §14；除契约明确冻结的数值外，
 * 这里还包含少量**实现口径常量**（噪声死区、文本截断长度、降采样点数），
 * 它们不改变契约语义，只用于让统计结论更稳健，详见 `docs/DEGRADE-NOTES.md`。
 */

/** 报告 schema 版本（契约 §10.3）。 */
export const DEGRADE_SCHEMA = 1;

/** 五种日志格式 id（同时用作 LogRecord.source）。 */
export const LOG_FORMATS = [
  'claude-code',
  'api-log',
  'usage-csv',
  'chatgpt-export',
  'codex-rollout'
];

/** 公开的 SUPPORTED_FORMATS（index.js 再导出，保持字符串数组最易消费）。 */
export const SUPPORTED_FORMATS = [...LOG_FORMATS];

/** 格式 id → 中文展示名。 */
export const FORMAT_LABELS = {
  'claude-code': 'Claude Code 会话日志（JSONL）',
  'api-log': '通用 API 请求/响应日志（JSONL）',
  'usage-csv': '用量 / 账单 CSV',
  'chatgpt-export': 'ChatGPT 官方导出（conversations.json）',
  'codex-rollout': 'Codex CLI 会话日志（rollout JSONL）',
  unknown: '未识别格式',
  generic: '通用记录'
};

/** 解析上限默认值（契约 §10.2）。 */
export const DEFAULT_LIMITS = {
  maxFiles: 20,
  maxBytesPerFile: 64 * 1024 * 1024,
  maxRecords: 200000
};

/** 分析选项默认值（契约 §10.3 v3.1：minSpanMs 不再用于卡结论，只写提示）。 */
export const DEFAULT_OPTIONS = {
  minRecords: 20,
  minSpanMs: 0,
  segment: 'auto'
};

/** 时间跨度的「置信度提示」阈值：低于 6 小时只写 notes，不改变 verdict。 */
export const SHORT_SPAN_MS = 6 * 3600e3;

/** 合法 verdict（契约 §10.3）。 */
export const VERDICTS = ['stable', 'suspicious', 'likely-degraded', 'insufficient'];

/** verdict → summaryText（契约 §10.3，字符串冻结）。 */
export const SUMMARY_TEXT = {
  stable: '未见系统性退化',
  suspicious: '存在可疑变化',
  'likely-degraded': '多项指标一致退化',
  insufficient: '样本不足，无法判断'
};

/** 合法 verdict 的中文徽章文案（UI 可直接用，非契约字段）。 */
export const VERDICT_LABELS = {
  stable: '未见系统性退化',
  suspicious: '存在可疑变化',
  'likely-degraded': '多项指标一致退化',
  insufficient: '样本不足，无法判断'
};

/** 合法 metric status（契约 §10.4）。 */
export const METRIC_STATUSES = ['ok', 'insufficient'];

/** 合法 direction（契约 §10.4）。 */
export const DIRECTIONS = ['worse', 'better', 'flat'];

/** 合法 finding severity（契约 §10.5）。 */
export const SEVERITIES = ['info', 'warning', 'critical'];

/* ------------------------------------------------------------------ */
/* 契约 §11 / §12 冻结阈值                                             */
/* ------------------------------------------------------------------ */

/** 每个指标每个时期至少需要的样本数（契约 §11）。 */
export const MIN_SAMPLES_PER_SEGMENT = 5;

/** 参与评分的可用指标数下限（契约 §12：可用指标数 < 3 → insufficient）。 */
export const MIN_USABLE_METRICS = 3;

/** evidenceStrength 的饱和常数（契约 §12 v3.1：saturate(可用指标数/4) × saturate(usable/50)）。 */
export const EVIDENCE_HALF_METRICS = 4;
export const EVIDENCE_HALF_RECORDS = 50;

/** evidenceStrength 闸门（契约 §12）。 */
export const EVIDENCE_STRENGTH_MIN = 0.35;

/** 评分判定阈值（契约 §12）。 */
export const SCORE_LIKELY_DEGRADED = 60;
export const SCORE_SUSPICIOUS = 30;

/** 单指标归一化恶化分的分母：变化 50% 记满分（契约 §12）。 */
export const BADNESS_FULL_DELTA = 0.5;

/* ------------------------------------------------------------------ */
/* 实现口径常量（非契约，但会影响 direction / series 的展示）            */
/* ------------------------------------------------------------------ */

/** 相对变化死区：|deltaPct| < 5% 视为 flat。 */
export const FLAT_RELATIVE_BAND = 0.05;

/** series 降采样上限（契约 §10.4：最多 500 点）。 */
export const SERIES_MAX_POINTS = 500;

/** 解析期保留的文本上限（只进内存、绝不进报告；见 docs/DEGRADE-NOTES.md）。 */
export const MAX_PROMPT_TEXT = 4000;
export const MAX_COMPLETION_TEXT = 8000;

/** 单行 / 单个 JSON 文本解析上限，防止恶意超大单行拖垮浏览器。 */
export const MAX_LINE_CHARS = 2 * 1024 * 1024;

/** 格式识别的置信度阈值：低于该值视为 unknown（绝不按扩展名猜）。 */
export const FORMAT_CONFIDENCE_MIN = 0.3;

/* ------------------------------------------------------------------ */
/* 契约 §11 的 critical 判定阈值                                       */
/* ------------------------------------------------------------------ */

/** 截断率：近期 > 15% 且较早期翻 5 倍 → critical。 */
export const CRITICAL_TRUNCATION_MIN_RATE = 0.15;
export const CRITICAL_TRUNCATION_RATIO = 5;

/** 模型替换：近期 > 10% → critical。 */
export const CRITICAL_MODEL_SUB_MIN_RATE = 0.1;

/** thinking 消失：早期 > 50% 且近期 ≈ 0（实现口径：≤5%，含切分点附近的少量残留）→ critical。 */
export const CRITICAL_THINKING_EARLY_MIN = 0.5;
export const CRITICAL_THINKING_RECENT_MAX = 0.05;

/** finish_reason 中代表「被长度截断」的取值（已小写化）。 */
export const TRUNCATION_FINISH_REASONS = new Set([
  'length',
  'max_tokens',
  'max-tokens',
  'maxtokens',
  'max_output_tokens',
  'maxoutputtokens'
]);

/** 每类指标参与「变差方向」判断的绝对变化死区（统一量纲下视为噪声）。 */
export const METRIC_MIN_DELTA = {
  truncation_rate: 0.02,
  model_substitution: 0.02,
  thinking_presence: 0.05,
  thinking_share: 0.002,
  token_inflation: 0.01,
  output_length: 5,
  completion_ratio: 0.03,
  latency_median: 50,
  error_rate: 0.02,
  refusal_rate: 0.02,
  repetition_rate: 0.005,
  empty_rate: 0.02,
  cache_hit_rate: 0.02
};

/** 隐私剥离时从对象里递归删除的键名（契约 §9.2）。 */
export const SCRUB_KEYS = new Set([
  'raw',
  'rawLine',
  'rawLines',
  'rawRecord',
  'rawText',
  'rawBody',
  'promptText',
  'completionText',
  'text',
  'filePath',
  'fileName',
  'filename',
  'path',
  'lines'
]);

export default {
  DEGRADE_SCHEMA,
  LOG_FORMATS,
  SUPPORTED_FORMATS,
  FORMAT_LABELS,
  DEFAULT_LIMITS,
  DEFAULT_OPTIONS,
  VERDICTS,
  SUMMARY_TEXT,
  VERDICT_LABELS,
  METRIC_STATUSES,
  DIRECTIONS,
  SEVERITIES,
  MIN_SAMPLES_PER_SEGMENT,
  MIN_USABLE_METRICS,
  EVIDENCE_HALF_METRICS,
  EVIDENCE_HALF_RECORDS,
  EVIDENCE_STRENGTH_MIN,
  SHORT_SPAN_MS,
  SCORE_LIKELY_DEGRADED,
  SCORE_SUSPICIOUS,
  BADNESS_FULL_DELTA,
  FLAT_RELATIVE_BAND,
  SERIES_MAX_POINTS,
  MAX_PROMPT_TEXT,
  MAX_COMPLETION_TEXT,
  MAX_LINE_CHARS,
  FORMAT_CONFIDENCE_MIN,
  CRITICAL_TRUNCATION_MIN_RATE,
  CRITICAL_TRUNCATION_RATIO,
  CRITICAL_MODEL_SUB_MIN_RATE,
  CRITICAL_THINKING_EARLY_MIN,
  CRITICAL_THINKING_RECENT_MAX,
  TRUNCATION_FINISH_REASONS,
  METRIC_MIN_DELTA,
  SCRUB_KEYS
};
