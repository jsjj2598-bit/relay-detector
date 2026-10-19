/**
 * 由指标生成 Finding（契约 v3 §10.5 / §11 的 critical 阈值 / §14.3）。
 *
 * 设计原则：
 *  - **只使用指标的统计量**（early / recent / deltaPct / samples）生成文案，
 *    detail 里绝不出现日志原文、文件路径；只允许出现数字与模型名（契约 §9.2）；
 *  - critical 严格按契约 §11 表格的阈值：截断率 >15% 且翻 5 倍、模型替换 >10%、
 *    thinking 从 >50% 掉到 ≈0；critical 会让整份报告一票判 `likely-degraded`；
 *  - warning / info 覆盖其余「变差方向且幅度明显」的指标，供用户定位原因。
 */
import {
  CRITICAL_MODEL_SUB_MIN_RATE,
  CRITICAL_THINKING_EARLY_MIN,
  CRITICAL_THINKING_RECENT_MAX,
  CRITICAL_TRUNCATION_MIN_RATE,
  CRITICAL_TRUNCATION_RATIO
} from './constants.js';
import { sameModelFamily } from './normalize.js';
import { isNum, pctText, round, sanitizeLabel, strOr } from './util.js';

function metricsById(metrics) {
  const map = {};
  for (const metric of Array.isArray(metrics) ? metrics : []) {
    if (metric && typeof metric.id === 'string') map[metric.id] = metric;
  }
  return map;
}

function evidenceOf(metric) {
  return {
    early: metric.early,
    recent: metric.recent,
    deltaPct: metric.deltaPct
  };
}

/** 只在指标 status === 'ok' 且前后期都有值时生成 finding（不可用指标不产生噪声）。 */
function usableMetric(map, id) {
  const metric = map[id];
  if (!metric || metric.status !== 'ok') return null;
  if (!isNum(metric.early) || !isNum(metric.recent)) return null;
  return metric;
}

/** 从近期记录里找一个「请求模型 ≠ 响应模型」的例子（只输出模型名，不含原文）。 */
function pickSubstitutionExample(context) {
  const recent = context && Array.isArray(context.recent) ? context.recent : [];
  for (const record of recent) {
    const request = strOr(record.requestModel, '');
    const response = strOr(record.model, '');
    if (!request || !response) continue;
    if (sameModelFamily(response, request) !== false) continue;
    return {
      request: sanitizeLabel(request, 64),
      response: sanitizeLabel(response, 64)
    };
  }
  return null;
}

/** 相对降幅（负数）→ 百分比文案。 */
function dropText(deltaPct) {
  if (!isNum(deltaPct)) return '无法计算';
  return `降幅 ${pctText(Math.abs(deltaPct))}`;
}

/**
 * 生成全部 findings（critical → warning → info）。
 *
 * @param {object[]} metrics MetricResult[]
 * @param {{early?: object[], recent?: object[]}} [context] 用于补充模型名示例
 * @returns {object[]} Finding[]
 */
export function buildFindings(metrics, context = {}) {
  const map = metricsById(metrics);
  const findings = [];

  /* ------------------------- critical（契约 §11） ------------------------- */

  const truncation = usableMetric(map, 'truncation_rate');
  if (truncation) {
    const ratio = truncation.early > 0 ? truncation.recent / truncation.early : Infinity;
    if (truncation.recent > CRITICAL_TRUNCATION_MIN_RATE && ratio >= CRITICAL_TRUNCATION_RATIO) {
      findings.push({
        id: 'truncation_spike',
        severity: 'critical',
        metric: 'truncation_rate',
        title: '截断率显著上升',
        detail: `近期 ${pctText(truncation.recent)} 的响应因达到长度上限被截断，早期仅 ${pctText(
          truncation.early
        )}（${
          truncation.early > 0 ? `约 ${ratio.toFixed(1)} 倍` : '早期为 0，属于从无到有'
        }）。`,
        evidence: evidenceOf(truncation),
        suggestion: '检查是否被中转站改小了 max_tokens，或模型被换成输出上限更低的版本。'
      });
    }
  }

  const substitution = usableMetric(map, 'model_substitution');
  if (substitution && substitution.recent > CRITICAL_MODEL_SUB_MIN_RATE) {
    const example = pickSubstitutionExample(context);
    const exampleText = example
      ? `例如请求 ${example.request}，实际返回 ${example.response}。`
      : '';
    findings.push({
      id: 'model_substitution',
      severity: 'critical',
      metric: 'model_substitution',
      title: '模型被替换',
      detail: `近期 ${pctText(substitution.recent)} 的响应实际模型与请求模型不一致（早期 ${pctText(
        substitution.early
      )}）。${exampleText}`,
      evidence: evidenceOf(substitution),
      suggestion: '核对请求参数与服务商账单中的实际模型；中转站可能在未告知的情况下把请求路由到更便宜的模型。'
    });
  }

  const thinkingPresence = usableMetric(map, 'thinking_presence');
  if (
    thinkingPresence &&
    thinkingPresence.early > CRITICAL_THINKING_EARLY_MIN &&
    thinkingPresence.recent <= CRITICAL_THINKING_RECENT_MAX
  ) {
    findings.push({
      id: 'thinking_collapse',
      severity: 'critical',
      metric: 'thinking_presence',
      title: 'Thinking 基本消失',
      detail: `含 thinking 的回答占比从早期 ${pctText(thinkingPresence.early)} 降到近期 ${pctText(
        thinkingPresence.recent
      )}，推理过程基本消失。`,
      evidence: evidenceOf(thinkingPresence),
      suggestion: '确认请求参数里的 thinking / reasoning 配置是否被上游忽略，或模型是否被换成了不支持推理的版本。'
    });
  }

  /* --------------------------- warning / info --------------------------- */

  const thinkingShare = usableMetric(map, 'thinking_share');
  if (thinkingShare && isNum(thinkingShare.deltaPct) && thinkingShare.deltaPct <= -0.4) {
    findings.push({
      id: 'thinking_share_drop',
      severity: 'warning',
      metric: 'thinking_share',
      title: 'Thinking token 占比下降',
      detail: `thinking token 占输出 token 的比例从 ${(thinkingShare.early * 100).toFixed(1)}% 降到 ${(
        thinkingShare.recent * 100
      ).toFixed(1)}%（${dropText(thinkingShare.deltaPct)}）。`,
      evidence: evidenceOf(thinkingShare),
      suggestion: '推理预算可能被上游压缩；可对比同一提示词在官方端点的 thinking 长度。'
    });
  }

  const tokenInflation = usableMetric(map, 'token_inflation');
  if (tokenInflation && isNum(tokenInflation.deltaPct) && tokenInflation.deltaPct <= -0.4) {
    findings.push({
      id: 'token_inflation_drop',
      severity: 'warning',
      metric: 'token_inflation',
      title: '字符 / token 比明显下降',
      detail: `回答字符数 / 输出 token 的中位数从 ${Number(tokenInflation.early).toFixed(2)} 降到 ${Number(
        tokenInflation.recent
      ).toFixed(2)}（${dropText(tokenInflation.deltaPct)}），可能存在 token 被多计。`,
      evidence: evidenceOf(tokenInflation),
      suggestion: '用固定提示词分别请求上游与官方端点，对比 usage 中的输出 token 数是否一致。'
    });
  }

  const outputLength = usableMetric(map, 'output_length');
  if (outputLength && isNum(outputLength.deltaPct) && outputLength.deltaPct <= -0.2) {
    findings.push({
      id: 'output_length_drop',
      severity: 'warning',
      metric: 'output_length',
      title: '输出长度明显下降',
      detail: `输出 token 中位数从 ${Math.round(outputLength.early)} 降到 ${Math.round(
        outputLength.recent
      )}（${dropText(outputLength.deltaPct)}）。`,
      evidence: evidenceOf(outputLength),
      suggestion: '回答整体变短可能是被截断、模型被换，也可能是任务分布变化；请结合截断率与模型替换率一起看。'
    });
  }

  const completionRatio = usableMetric(map, 'completion_ratio');
  if (completionRatio && isNum(completionRatio.deltaPct) && completionRatio.deltaPct <= -0.3) {
    findings.push({
      id: 'completion_ratio_drop',
      severity: 'warning',
      metric: 'completion_ratio',
      title: '输出 / 输入 token 比下降',
      detail: `输出 / 输入 token 的中位数从 ${Number(completionRatio.early).toFixed(2)} 降到 ${Number(
        completionRatio.recent
      ).toFixed(2)}（${dropText(completionRatio.deltaPct)}）。`,
      evidence: evidenceOf(completionRatio),
      suggestion: '若提示词长度没有变化，说明同样的输入得到的回答变短了。'
    });
  }

  const latency = usableMetric(map, 'latency_median');
  if (latency && isNum(latency.deltaPct) && latency.deltaPct >= 0.5) {
    findings.push({
      id: 'latency_spike',
      severity: 'warning',
      metric: 'latency_median',
      title: '延迟显著上升',
      detail: `延迟中位数从 ${Math.round(latency.early)} ms 升到 ${Math.round(latency.recent)} ms（+${pctText(
        latency.recent / Math.max(latency.early, 1) - 1
      )}）。`,
      evidence: evidenceOf(latency),
      suggestion: '可能是上游拥塞、被加了排队 / 限流，或模型被换成更慢的实现。'
    });
  }

  const errorRate = usableMetric(map, 'error_rate');
  if (
    errorRate &&
    ((isNum(errorRate.deltaPct) && errorRate.deltaPct >= 0.5) ||
      (errorRate.early === 0 && errorRate.recent >= 0.05))
  ) {
    findings.push({
      id: 'error_rate_spike',
      severity: 'warning',
      metric: 'error_rate',
      title: '错误率上升',
      detail: `非成功响应占比从 ${pctText(errorRate.early)} 升到 ${pctText(errorRate.recent)}。`,
      evidence: evidenceOf(errorRate),
      suggestion: '检查上游是否限流 / 超时 / 返回 5xx；错误响应增多会让其它指标的样本变少。'
    });
  }

  const refusal = usableMetric(map, 'refusal_rate');
  if (
    refusal &&
    refusal.recent >= 0.1 &&
    (!isNum(refusal.deltaPct) || refusal.deltaPct >= 0.5)
  ) {
    findings.push({
      id: 'refusal_spike',
      severity: 'warning',
      metric: 'refusal_rate',
      title: '拒答率上升',
      detail: `拒答型回答占比从 ${pctText(refusal.early)} 升到 ${pctText(refusal.recent)}。`,
      evidence: evidenceOf(refusal),
      suggestion: '可能是模型被换成了对齐更严的版本，也可能是任务内容发生了变化。'
    });
  }

  const repetition = usableMetric(map, 'repetition_rate');
  if (repetition && isNum(repetition.deltaPct) && repetition.deltaPct >= 0.5) {
    findings.push({
      id: 'repetition_spike',
      severity: 'warning',
      metric: 'repetition_rate',
      title: '重复内容增多',
      detail: `回答内部重复 4-gram 的平均占比从 ${pctText(repetition.early)} 升到 ${pctText(
        repetition.recent
      )}。`,
      evidence: evidenceOf(repetition),
      suggestion: '回答开始车轱辘话通常意味着生成质量下降；建议抽样人工检查近期回答。'
    });
  }

  const emptyRate = usableMetric(map, 'empty_rate');
  if (
    emptyRate &&
    ((isNum(emptyRate.deltaPct) && emptyRate.deltaPct >= 0.5) ||
      (emptyRate.early === 0 && emptyRate.recent >= 0.05))
  ) {
    findings.push({
      id: 'empty_rate_spike',
      severity: 'warning',
      metric: 'empty_rate',
      title: '空回答增多',
      detail: `空回答占比从 ${pctText(emptyRate.early)} 升到 ${pctText(emptyRate.recent)}。`,
      evidence: evidenceOf(emptyRate),
      suggestion: '空响应可能是被内容过滤拦截、上游超时或模型被换成了更差的实现。'
    });
  }

  const cache = usableMetric(map, 'cache_hit_rate');
  if (cache && isNum(cache.deltaPct) && cache.deltaPct <= -0.3) {
    findings.push({
      id: 'cache_hit_drop',
      severity: 'info',
      metric: 'cache_hit_rate',
      title: '缓存命中率下降',
      detail: `缓存命中率从 ${pctText(cache.early)} 降到 ${pctText(cache.recent)}（${dropText(
        cache.deltaPct
      )}）。`,
      evidence: evidenceOf(cache),
      suggestion: '缓存前缀可能变了（系统提示词 / 工具定义变化），会推高成本与延迟。'
    });
  }

  return findings;
}

export default { buildFindings };
