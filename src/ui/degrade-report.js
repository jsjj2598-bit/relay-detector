/**
 * src/ui/degrade-report.js —— 「降智诊断」报告渲染（契约 v3 §13）。
 *
 * 设计红线：
 *   1. 隐私（§9）：只渲染计数、比率、中位数、时间戳、模型名、字段名；
 *      **绝不**渲染日志原文或文件名。JSON 导出前递归剥离 `raw`。
 *   2. `score`（退化倾向）与 `evidenceStrength`（证据充分度）**分开展示**，
 *      绝不合并成一个数（与 v2 的连接轴 / 真伪轴同样原则）。
 *   3. 折线图用**原生 SVG 手写**，零第三方图表库；序列 ≤500 点，Y 轴越界值钳制在绘图区内。
 *   4. `insufficient` 不是「退化 0 分」：显示灰色样本不足横幅 + 具体补样建议，不展示误导性低分。
 *   5. 所有来自报告 / 日志的字符串一律 textContent 写入，防 XSS。
 */

import {
  h,
  chip,
  detailsBlock,
  codeBlock,
  kvTable,
  statCard,
  scoreRing,
  meter,
  copyButton,
  formatPercent,
  stringify,
  num,
  clamp
} from './components.js';

/* ------------------------------------------------------------------ *
 * 结论 / 严重度常量
 * ------------------------------------------------------------------ */

/** 降智诊断结论 → 中文标签（契约 10.3 summaryText 的兜底）。 */
export const DEGRADE_VERDICT_LABELS = {
  stable: '未见系统性退化',
  suspicious: '存在可疑变化',
  'likely-degraded': '多项指标一致退化',
  insufficient: '样本不足，无法判断'
};

/** 结论 → 视觉色调：stable 绿 / suspicious 黄 / likely-degraded 红 / insufficient 灰。 */
export const DEGRADE_VERDICT_TONES = {
  stable: 'success',
  suspicious: 'warn',
  'likely-degraded': 'danger',
  insufficient: 'neutral'
};

/** 结论 → 评分环色调。 */
const RING_TONES = {
  stable: 'success',
  suspicious: 'warn',
  'likely-degraded': 'danger',
  insufficient: 'neutral'
};

/** Finding 严重度 → 中文标签 / 色调（critical 红 / warning 黄 / info 灰）。 */
export const SEVERITY_LABELS = { critical: '严重', warning: '警告', info: '提示' };
export const SEVERITY_TONES = { critical: 'danger', warning: 'warn', info: 'neutral' };

const VERDICT_VALUES = ['stable', 'suspicious', 'likely-degraded', 'insufficient'];
const SEVERITY_VALUES = ['critical', 'warning', 'info'];
const DIRECTION_VALUES = ['worse', 'better', 'flat'];

/** 契约默认门槛（用于 insufficient 补样建议）。 */
export const DEFAULT_MIN_RECORDS = 20;
export const DEFAULT_MIN_SPAN_MS = 6 * 3600e3;

/* ------------------------------------------------------------------ *
 * 基础工具
 * ------------------------------------------------------------------ */

function isPlainObject(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function asString(value, fallback = '') {
  return typeof value === 'string' ? value : fallback;
}

function finiteOrNull(value) {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function intOr(value, fallback = 0) {
  const n = finiteOrNull(value);
  return n === null ? fallback : Math.round(n);
}

function formatDuration(ms) {
  const value = finiteOrNull(ms);
  if (value === null || value <= 0) return '—';
  if (value < 1000) return `${Math.round(value)} ms`;
  if (value < 60000) return `${(value / 1000).toFixed(1)} 秒`;
  if (value < 3600000) return `${Math.round(value / 60000)} 分钟`;
  return `${(value / 3600000).toFixed(1)} 小时`;
}

function formatDateTime(ts) {
  const value = finiteOrNull(ts);
  if (value === null) return '—';
  try {
    return new Date(value).toLocaleString('zh-CN', { hour12: false });
  } catch {
    return '—';
  }
}

/** 指标值的展示（按 unit 保守格式化；null 表示不可用）。 */
export function formatMetricValue(value, unit) {
  const v = finiteOrNull(value);
  if (v === null) return '—';
  const u = asString(unit, '');
  if (u === '%') {
    // 兼容两种上游约定：比例（0.24）与百分数（24）。只对 |v| ≤ 1 做比例换算。
    const display = Math.abs(v) <= 1 ? v * 100 : v;
    return `${display.toFixed(1)}%`;
  }
  if (u === 'ms') return `${Math.round(v)} ms`;
  if (u === 'tok') return `${Math.round(v)} tok`;
  if (u === 'ratio') return v.toFixed(3);
  if (Number.isInteger(v)) return String(v);
  return v.toFixed(3);
}

/** deltaPct 契约定义为 (recent - early) / |early|，以比例展示成百分比。 */
export function formatDeltaPct(deltaPct) {
  const v = finiteOrNull(deltaPct);
  if (v === null) return '—';
  const pct = v * 100;
  const sign = pct > 0 ? '+' : '';
  if (Math.abs(pct) >= 1000) return `${sign}${Math.round(pct)}%`;
  return `${sign}${pct.toFixed(1)}%`;
}

/** 方向 → 中文徽章文案与箭头。 */
export function directionLabel(direction, deltaPct) {
  const d = DIRECTION_VALUES.includes(direction) ? direction : 'flat';
  const delta = finiteOrNull(deltaPct);
  const arrow = delta === null ? '' : delta > 0 ? ' ▲' : delta < 0 ? ' ▼' : ' ＝';
  if (d === 'worse') return `变差${arrow}`;
  if (d === 'better') return `改善${arrow}`;
  return `持平${arrow}`;
}

function directionTone(direction) {
  if (direction === 'worse') return 'danger';
  if (direction === 'better') return 'success';
  return 'neutral';
}

/* ------------------------------------------------------------------ *
 * 报告归一化（防御性：任何字段缺失都不影响渲染）
 * ------------------------------------------------------------------ */

/** 降采样 / 过滤 series：只保留数值点，最多 500 点，绝不抛错。 */
export function normalizeSeries(rawSeries) {
  if (!Array.isArray(rawSeries)) return [];
  const out = [];
  for (const point of rawSeries) {
    if (!isPlainObject(point)) continue;
    const v = finiteOrNull(point.v);
    if (v === null) continue;
    out.push({ t: finiteOrNull(point.t), v });
    if (out.length >= 500) break;
  }
  return out;
}

function normalizeMetric(raw, index = 0) {
  const source = isPlainObject(raw) ? raw : {};
  const id = asString(source.id, '') || `metric_${index + 1}`;
  const early = finiteOrNull(source.early);
  const recent = finiteOrNull(source.recent);
  const deltaPct = finiteOrNull(source.deltaPct);
  const status = source.status === 'ok' || source.status === 'insufficient'
    ? source.status
    : (early !== null && recent !== null ? 'ok' : 'insufficient');
  let direction = DIRECTION_VALUES.includes(source.direction) ? source.direction : null;
  if (!direction) {
    if (deltaPct === null) direction = 'flat';
    else if (deltaPct > 0) direction = 'worse';
    else if (deltaPct < 0) direction = 'better';
    else direction = 'flat';
  }
  const samplesRaw = isPlainObject(source.samples) ? source.samples : {};
  return {
    id,
    label: asString(source.label, '') || id,
    unit: asString(source.unit, ''),
    weight: num(source.weight, 0),
    status,
    early,
    recent,
    deltaPct,
    direction,
    samples: { early: intOr(samplesRaw.early, 0), recent: intOr(samplesRaw.recent, 0) },
    series: normalizeSeries(source.series),
    definition: asString(source.definition, '')
  };
}

function normalizeFinding(raw, index = 0) {
  const source = isPlainObject(raw) ? raw : {};
  const severity = SEVERITY_VALUES.includes(source.severity) ? source.severity : 'info';
  return {
    id: asString(source.id, '') || `finding_${index + 1}`,
    severity,
    metric: asString(source.metric, ''),
    title: asString(source.title, '') || '发现一处可观测变化',
    detail: asString(source.detail, ''),
    suggestion: asString(source.suggestion, ''),
    evidence: source.evidence === undefined ? null : source.evidence
  };
}

function normalizeSegmentInfo(raw) {
  const source = isPlainObject(raw) ? raw : {};
  return {
    count: intOr(source.count, 0),
    from: finiteOrNull(source.from),
    to: finiteOrNull(source.to)
  };
}

/** coverage.bySource / byModel 可能是对象或数组，统一成 [{name,count}]。 */
export function normalizeBreakdown(raw) {
  if (!raw) return [];
  const out = [];
  if (Array.isArray(raw)) {
    for (const item of raw) {
      if (typeof item === 'string') out.push({ name: item, count: 0 });
      else if (isPlainObject(item)) {
        const name = asString(item.name, '') || asString(item.id, '') || asString(item.model, '')
          || asString(item.source, '') || asString(item.key, '');
        if (name) out.push({ name, count: intOr(item.count ?? item.records ?? item.value, 0) });
      }
    }
    return out;
  }
  if (isPlainObject(raw)) {
    for (const [name, value] of Object.entries(raw)) {
      if (isPlainObject(value)) out.push({ name, count: intOr(value.count ?? value.records ?? value.value, 0) });
      else out.push({ name, count: intOr(value, 0) });
    }
  }
  return out;
}

/** 构造一份「样本不足」兜底报告（用于空/垃圾输入）。 */
function syntheticInsufficientReport(note) {
  const now = Date.now();
  return {
    schema: 1,
    verdict: 'insufficient',
    score: 0,
    evidenceStrength: 0,
    summaryText: DEGRADE_VERDICT_LABELS.insufficient,
    segments: {
      early: { count: 0, from: null, to: null },
      recent: { count: 0, from: null, to: null },
      splitAt: null
    },
    metrics: [],
    findings: [],
    criticalIssues: [],
    coverage: { records: 0, usable: 0, bySource: {}, byModel: {}, spanDays: null },
    notes: [note || '没有可分析的日志记录。'],
    startedAt: now,
    finishedAt: now
  };
}

/**
 * 归一化 DegradationReport（契约 10.3）。永不抛错。
 * @returns {object}
 */
export function normalizeDegradeReport(report) {
  if (!isPlainObject(report)) return syntheticInsufficientReport('报告为空或格式不正确。');

  const verdict = VERDICT_VALUES.includes(report.verdict) ? report.verdict : 'insufficient';
  const metrics = Array.isArray(report.metrics) ? report.metrics.map(normalizeMetric) : [];
  const findings = Array.isArray(report.findings) ? report.findings.map(normalizeFinding) : [];

  const criticalFromFindings = findings.filter((finding) => finding.severity === 'critical');
  const criticalRaw = Array.isArray(report.criticalIssues) ? report.criticalIssues.filter(isPlainObject) : [];
  const criticalIssues = [];
  const seenCritical = new Set();
  for (const raw of [...criticalRaw.map((item, i) => normalizeFinding(item, i)), ...criticalFromFindings]) {
    const key = `${raw.id}|${raw.title}`;
    if (seenCritical.has(key)) continue;
    seenCritical.add(key);
    criticalIssues.push(raw);
  }

  const segmentsRaw = isPlainObject(report.segments) ? report.segments : {};
  const coverageRaw = isPlainObject(report.coverage) ? report.coverage : {};
  const usableMetrics = metrics.filter((metric) => metric.status === 'ok').length;
  const startedAt = finiteOrNull(report.startedAt);
  const finishedAt = finiteOrNull(report.finishedAt);

  return {
    schema: intOr(report.schema, 1),
    verdict,
    score: clamp(num(report.score, 0), 0, 100),
    evidenceStrength: clamp(num(report.evidenceStrength, 0), 0, 1),
    summaryText: asString(report.summaryText, '') || DEGRADE_VERDICT_LABELS[verdict],
    segments: {
      early: normalizeSegmentInfo(segmentsRaw.early),
      recent: normalizeSegmentInfo(segmentsRaw.recent),
      splitAt: finiteOrNull(segmentsRaw.splitAt)
    },
    metrics,
    findings,
    criticalIssues,
    coverage: {
      records: intOr(coverageRaw.records, 0),
      usable: intOr(coverageRaw.usable, 0),
      bySource: normalizeBreakdown(coverageRaw.bySource),
      byModel: normalizeBreakdown(coverageRaw.byModel),
      spanDays: finiteOrNull(coverageRaw.spanDays)
    },
    usableMetrics,
    notes: Array.isArray(report.notes) ? report.notes.filter((note) => typeof note === 'string' && note.trim()) : [],
    startedAt,
    finishedAt,
    durationMs: (startedAt !== null && finishedAt !== null && finishedAt >= startedAt) ? finishedAt - startedAt : 0
  };
}

/** 样本不足时的具体补样建议（契约 §13.5）。 */
export function insufficientAdvice(report) {
  const r = isPlainObject(report) && report.coverage ? report : normalizeDegradeReport(report);
  const usable = r.coverage.usable;
  const total = r.coverage.records;
  const usableMetrics = Array.isArray(r.metrics) ? r.metrics.filter((metric) => metric.status === 'ok').length : 0;
  const spanDays = r.coverage.spanDays;
  const spanMs = spanDays === null ? null : spanDays * 86400e3;

  const advice = [];
  if (usable < DEFAULT_MIN_RECORDS) {
    advice.push(`还需要至少 ${DEFAULT_MIN_RECORDS - usable} 条可用记录（当前可用 ${usable} 条 / 总计 ${total} 条，判定门槛 ${DEFAULT_MIN_RECORDS} 条）。缺少时间戳或 token 字段的记录可能无法参与分析。`);
  }
  if (spanMs === null) {
    advice.push('日志中缺少可用时间戳：请保留 timestamp / create_time 字段，否则无法做前后期切分。');
  } else if (spanMs < DEFAULT_MIN_SPAN_MS) {
    const hours = spanMs / 3600e3;
    advice.push(`时间跨度至少需要 6 小时（当前约 ${hours.toFixed(1)} 小时），否则前后期样本都没有代表性。`);
  }
  if (usableMetrics < 3) {
    advice.push(`可用指标 ${usableMetrics} 个，至少需要 3 个。建议使用包含 token 用量、finish_reason 与延迟的日志格式（Claude Code JSONL / API 日志 / 用量 CSV / Codex rollout 通常覆盖更多指标）。`);
  }
  if (!advice.length) {
    advice.push('样本量略低于判定门槛：建议再积累一段时间的日志（覆盖更多会话与时段）后重新分析。');
  }
  return advice;
}

/* ------------------------------------------------------------------ *
 * 原生 SVG 折线图（零依赖）
 * ------------------------------------------------------------------ */

const SVG_NS = 'http://www.w3.org/2000/svg';
const CHART = { width: 340, height: 120, padLeft: 44, padRight: 10, padTop: 12, padBottom: 24 };

function svgEl(tag, attrs, ...children) {
  const node = document.createElementNS(SVG_NS, tag);
  if (attrs && typeof attrs === 'object') {
    for (const [key, value] of Object.entries(attrs)) {
      if (value === null || value === undefined || value === false) continue;
      node.setAttribute(key, String(value));
    }
  }
  for (const child of children.flat(Infinity)) {
    if (child === null || child === undefined || child === false) continue;
    node.append(child);
  }
  return node;
}

function formatAxisNumber(value) {
  const v = finiteOrNull(value);
  if (v === null) return '—';
  const abs = Math.abs(v);
  if (abs >= 1000000) return `${(v / 1000000).toFixed(1)}M`;
  if (abs >= 1000) return `${(v / 1000).toFixed(1)}k`;
  if (abs >= 100) return String(Math.round(v));
  if (abs >= 1) return v.toFixed(1);
  return v.toFixed(3);
}

function formatAxisTime(ts, spanMs) {
  const value = finiteOrNull(ts);
  if (value === null) return '—';
  try {
    const date = new Date(value);
    const pad = (n) => String(n).padStart(2, '0');
    const span = finiteOrNull(spanMs) || 0;
    if (span > 2 * 86400e3) return `${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
    return `${pad(date.getHours())}:${pad(date.getMinutes())}`;
  } catch {
    return '—';
  }
}

/**
 * 绘制单个指标的折线图（原生 SVG）。
 * - 0 / 1 个可用点时显示占位说明，不抛错；
 * - 数据点最多 500；Y 越界值会被钳制进绘图区；
 * - 有 splitAt 时用「早期 / 近期」两种颜色，并画一条虚线标记变化点。
 *
 * @param {{label?:string, series?:Array<{t:number|null,v:number}>, unit?:string}} metric
 * @param {number|null} splitAt
 * @returns {Element}
 */
export function renderMetricChart(metric, splitAt = null) {
  const points = normalizeSeries(metric && metric.series)
    .filter((point) => Number.isFinite(point.t) && Number.isFinite(point.v))
    .slice(0, 500);

  const box = h('div', { class: 'chart-box' });
  if (points.length < 2) {
    box.append(h('p', { class: 'chart-empty', text: points.length === 0
      ? '该指标没有可绘制的时间序列（时间戳缺失或指标不可用）。'
      : '该指标只有 1 个可用数据点，无法绘制折线（不显示误导性图形）。' }));
    return box;
  }

  let tMin = Infinity;
  let tMax = -Infinity;
  let vMin = Infinity;
  let vMax = -Infinity;
  for (const point of points) {
    if (point.t < tMin) tMin = point.t;
    if (point.t > tMax) tMax = point.t;
    if (point.v < vMin) vMin = point.v;
    if (point.v > vMax) vMax = point.v;
  }
  const spanMs = tMax - tMin || 1;
  const vSpan = vMax - vMin;
  const padV = vSpan === 0 ? Math.max(Math.abs(vMin) * 0.1, 1) : vSpan * 0.08;
  const yLo = vMin - padV;
  const yHi = vMax + padV;
  const ySpan = yHi - yLo || 1;

  const plotWidth = CHART.width - CHART.padLeft - CHART.padRight;
  const plotHeight = CHART.height - CHART.padTop - CHART.padBottom;
  const xOf = (t) => CHART.padLeft + ((t - tMin) / spanMs) * plotWidth;
  const yOf = (v) => {
    const ratio = clamp((v - yLo) / ySpan, 0, 1); // 越界值钳制，保证不画出绘图区
    return CHART.padTop + (1 - ratio) * plotHeight;
  };

  const children = [];
  for (const ratio of [0, 0.5, 1]) {
    const y = CHART.padTop + ratio * plotHeight;
    children.push(svgEl('line', {
      class: 'chart-grid-line',
      x1: CHART.padLeft,
      x2: CHART.width - CHART.padRight,
      y1: y,
      y2: y
    }));
  }

  children.push(
    svgEl('text', { class: 'chart-axis-text', x: CHART.padLeft - 6, y: CHART.padTop + 4, 'text-anchor': 'end' }, formatAxisNumber(yHi)),
    svgEl('text', { class: 'chart-axis-text', x: CHART.padLeft - 6, y: CHART.height - CHART.padBottom, 'text-anchor': 'end' }, formatAxisNumber(yLo)),
    svgEl('text', { class: 'chart-axis-text', x: CHART.padLeft, y: CHART.height - 7, 'text-anchor': 'start' }, formatAxisTime(tMin, spanMs)),
    svgEl('text', { class: 'chart-axis-text', x: CHART.width - CHART.padRight, y: CHART.height - 7, 'text-anchor': 'end' }, formatAxisTime(tMax, spanMs))
  );

  const splitValue = finiteOrNull(splitAt);
  if (splitValue !== null && splitValue > tMin && splitValue < tMax) {
    const x = xOf(splitValue);
    children.push(svgEl('line', {
      class: 'chart-split-line',
      x1: x,
      x2: x,
      y1: CHART.padTop,
      y2: CHART.height - CHART.padBottom
    }));
  }

  const earlyPoints = splitValue === null ? points : points.filter((point) => point.t <= splitValue);
  const recentPoints = splitValue === null ? [] : points.filter((point) => point.t > splitValue);

  const appendSeries = (list, className) => {
    if (!list.length) return;
    const d = list
      .map((point, index) => `${index === 0 ? 'M' : 'L'}${xOf(point.t).toFixed(2)} ${yOf(point.v).toFixed(2)}`)
      .join(' ');
    children.push(svgEl('path', { class: `chart-line ${className}`, d }));
    // 数据点很少时画圆点，便于看清早期/近期分界。
    if (list.length <= 80) {
      for (const point of list) {
        children.push(svgEl('circle', {
          class: `chart-point ${className.replace('line', 'point')}`,
          cx: xOf(point.t).toFixed(2),
          cy: yOf(point.v).toFixed(2),
          r: 2
        }));
      }
    }
  };
  appendSeries(earlyPoints, 'chart-line-early');
  appendSeries(recentPoints, 'chart-line-recent');

  box.append(svgEl('svg', {
    class: 'chart-svg',
    viewBox: `0 0 ${CHART.width} ${CHART.height}`,
    role: 'img',
    'aria-label': `${asString(metric && metric.label, '指标')} 折线图，共 ${points.length} 个数据点`
  }, children));
  return box;
}

function renderChartCard(metric, splitAt) {
  const legend = h('div', { class: 'chart-legend' },
    h('span', { class: 'chart-legend-item' },
      h('span', { class: 'chart-swatch chart-swatch-early', 'aria-hidden': 'true' }),
      h('span', { text: '早期' })
    ),
    h('span', { class: 'chart-legend-item' },
      h('span', { class: 'chart-swatch chart-swatch-recent', 'aria-hidden': 'true' }),
      h('span', { text: '近期' })
    ),
    splitAt !== null ? h('span', { class: 'chart-legend-item chart-legend-split', text: '虚线 = 探测到的变化点' }) : null
  );

  return h('article', { class: 'chart-card' },
    h('div', { class: 'chart-head' },
      h('h4', { class: 'chart-title', text: metric.label }),
      chip(metric.unit || '数值', { tone: 'plain', mono: true })
    ),
    renderMetricChart(metric, splitAt),
    legend
  );
}

/* ------------------------------------------------------------------ *
 * 报告各区块
 * ------------------------------------------------------------------ */

function verdictBadge(verdict) {
  const tone = DEGRADE_VERDICT_TONES[verdict] || 'neutral';
  const label = DEGRADE_VERDICT_LABELS[verdict] || '无法判断';
  return h('span', {
    class: `degrade-verdict-badge tone-${tone}`,
    role: 'status',
    'aria-label': `判定结果：${label}`
  },
    h('span', { class: 'degrade-verdict-dot', 'aria-hidden': 'true' }),
    h('span', { class: 'degrade-verdict-text', text: label })
  );
}

function renderVerdictHead(report) {
  return h('div', { class: 'degrade-verdict-head' },
    h('div', { class: 'degrade-verdict-main' },
      verdictBadge(report.verdict),
      h('p', { class: 'degrade-summary-text', text: report.summaryText }),
      h('p', { class: 'degrade-summary-note', text: '本诊断只比较日志中的可观测行为变化，不是 IQ 测试，也不测量模型能力。' })
    ),
    h('div', { class: 'degrade-meta-chips' },
      chip(`记录 ${report.coverage.records} 条`, { tone: 'plain' }),
      chip(`可用指标 ${report.usableMetrics} 项`, { tone: report.usableMetrics >= 3 ? 'success' : 'warn' }),
      chip(`严重问题 ${report.criticalIssues.length} 项`, { tone: report.criticalIssues.length ? 'danger' : 'plain' }),
      chip(`耗时 ${formatDuration(report.durationMs)}`, { tone: 'plain' })
    )
  );
}

function renderCriticalBanner(report) {
  if (!report.criticalIssues.length) return null;
  return h('section', { class: 'degrade-banner degrade-banner-critical', role: 'alert', 'aria-label': '严重问题' },
    h('h4', { class: 'degrade-banner-title', text: `🚨 严重问题：${report.criticalIssues.length} 项（critical 一票即判「多项指标一致退化」）` }),
    h('ul', { class: 'degrade-banner-list' },
      report.criticalIssues.map((issue) => h('li', {},
        h('strong', { text: issue.title }),
        issue.detail ? h('p', { class: 'degrade-issue-detail', text: issue.detail }) : null,
        issue.suggestion ? h('p', { class: 'degrade-issue-suggestion', text: `建议：${issue.suggestion}` }) : null
      ))
    )
  );
}

function renderInsufficientBanner(report) {
  const advice = insufficientAdvice(report);
  return h('section', { class: 'degrade-banner degrade-banner-insufficient', role: 'status' },
    h('h4', { class: 'degrade-banner-title', text: '⚠️ 样本不足，无法判断（这不是「退化 0 分」）' }),
    h('p', { class: 'degrade-banner-text', text: '当前日志量或可用指标还不足以做可靠的前后期对比，因此不给出退化分数，也不把它当成 0 分。' }),
    h('ul', { class: 'degrade-banner-list' }, advice.map((text) => h('li', { text }))),
    h('p', { class: 'degrade-banner-note', text: `判定门槛：可用记录 ≥ ${DEFAULT_MIN_RECORDS} 条、可用指标 ≥ 3 个，且证据充分度 ≥ 35%；时间跨度不足会降低趋势可信度，但不单独卡结论。` })
  );
}

/** 分数展示：核心可能返回小数（如 2.31），UI 统一保留 1 位小数。 */
function displayScore(score) {
  const v = clamp(num(score, 0), 0, 100);
  return Math.round(v * 10) / 10;
}

function formatScoreText(score) {
  const v = displayScore(score);
  return Number.isInteger(v) ? String(v) : v.toFixed(1);
}

function renderSummary(report) {
  const stats = h('div', { class: 'stat-grid degrade-stat-grid' },
    statCard('记录数', String(report.coverage.records), `可用 ${report.coverage.usable} 条`),
    statCard('可用指标', `${report.usableMetrics} / ${report.metrics.length || '—'}`, '不可用指标不进评分分母'),
    statCard('时间跨度', report.coverage.spanDays === null ? '—' : `${report.coverage.spanDays.toFixed(1)} 天`, '用于前后期切分'),
    statCard('变化点', report.segments.splitAt === null ? '未探测到' : formatDateTime(report.segments.splitAt), '自动切分得到的最大差异点'),
    statCard('严重问题', String(report.criticalIssues.length), 'critical 一票判定'),
    statCard('耗时', formatDuration(report.durationMs), '本地分析，无网络请求')
  );

  const evidenceMeter = meter('证据充分度 evidenceStrength（与 score 分开）', formatPercent(report.evidenceStrength), report.evidenceStrength, {
    tone: report.evidenceStrength < 0.35 ? 'warn' : 'info',
    hint: '由「可用指标数」与「总记录数」共同决定，表示结论的可靠程度，不是退化概率。它和 score 是两个独立的量，绝不合并。'
  });

  const body = [];
  if (report.verdict === 'insufficient') {
    body.push(h('div', { class: 'degrade-score-inapplicable' },
      h('div', { class: 'degrade-score-na-value', text: '—' }),
      h('p', { class: 'degrade-score-na-label', text: '退化倾向评分：不适用（样本不足，不显示低分）' })
    ));
  } else {
    const scoreValue = displayScore(report.score);
    body.push(h('div', { class: 'degrade-score-wrap' },
      h('div', { class: 'degrade-score-ring' },
        scoreRing(scoreValue, {
          caption: '退化倾向评分（越高越可疑）',
          tone: RING_TONES[report.verdict] || 'neutral',
          ariaLabel: `退化倾向评分 ${scoreValue} / 100，结论：${report.summaryText}`
        })
      )
    ));
  }

  body.push(h('div', { class: 'degrade-summary-side' }, evidenceMeter, stats));
  return h('div', { class: 'degrade-summary' }, ...body);
}

function segmentCard(title, segment, extra) {
  return h('div', { class: 'segment-card' },
    h('h4', { class: 'segment-title', text: title }),
    h('p', { class: 'segment-count', text: `${segment.count} 条记录` }),
    h('p', { class: 'segment-range', text: `${formatDateTime(segment.from)} → ${formatDateTime(segment.to)}` }),
    extra ? h('p', { class: 'segment-hint', text: extra }) : null
  );
}

function renderSegments(report) {
  const splitText = report.segments.splitAt === null
    ? '未探测到明显变化点（或数据缺少时间戳）。'
    : `${formatDateTime(report.segments.splitAt)}（按前后中位数差异最大的位置自动切分）`;
  return h('section', { class: 'degrade-section' },
    h('h3', { class: 'section-title', text: '前后期对比与变化点' }),
    h('div', { class: 'segment-grid' },
      segmentCard('早期', report.segments.early, '基线期'),
      h('div', { class: 'segment-card segment-split' },
        h('h4', { class: 'segment-title', text: '探测到的变化点' }),
        h('p', { class: 'segment-count', text: splitText }),
        h('p', { class: 'segment-hint', text: '变化点用于把日志分成前后两段；切分本身是统计推断，不是精确时间。' })
      ),
      segmentCard('近期', report.segments.recent, '对照期')
    )
  );
}

function renderMetricsTable(report) {
  if (!report.metrics.length) {
    return h('section', { class: 'degrade-section' },
      h('h3', { class: 'section-title', text: '指标对比' }),
      h('p', { class: 'empty-note', text: '没有可展示的指标（日志可能缺少时间戳、token 用量或 finish_reason 等字段）。' })
    );
  }

  const rows = report.metrics.map((metric) => h('tr', { class: `metric-row status-${metric.status} direction-${metric.direction}` },
    h('td', { class: 'metric-label-cell' },
      h('div', { class: 'metric-label', text: metric.label }),
      h('div', { class: 'metric-id mono', text: metric.id }),
      metric.definition ? h('div', { class: 'metric-definition', title: metric.definition, text: metric.definition }) : null
    ),
    h('td', { class: 'metric-num' }, formatMetricValue(metric.early, metric.unit)),
    h('td', { class: 'metric-num' }, formatMetricValue(metric.recent, metric.unit)),
    h('td', { class: `metric-delta tone-${directionTone(metric.direction)}` }, metric.status === 'ok' ? formatDeltaPct(metric.deltaPct) : '—'),
    h('td', {}, metric.status === 'ok'
      ? chip(directionLabel(metric.direction, metric.deltaPct), { tone: directionTone(metric.direction) })
      : chip('—', { tone: 'neutral' })),
    h('td', { class: 'metric-num' }, `${metric.samples.early} / ${metric.samples.recent}`),
    h('td', {}, metric.status === 'ok'
      ? chip('参与评分', { tone: 'success' })
      : chip('样本不足（不计分）', { tone: 'neutral', title: 'insufficient 不进入加权分母，也不会被当成 0 分。' }))
  ));

  return h('section', { class: 'degrade-section' },
    h('h3', { class: 'section-title', text: `指标对比（${report.metrics.length} 项，可用 ${report.usableMetrics} 项）` }),
    h('div', { class: 'table-scroll' },
      h('table', { class: 'metric-table' },
        h('caption', { class: 'sr-only', text: '降智诊断指标前后期对比表' }),
        h('thead', {},
          h('tr', {},
            h('th', { scope: 'col', text: '指标' }),
            h('th', { scope: 'col', text: '早期' }),
            h('th', { scope: 'col', text: '近期' }),
            h('th', { scope: 'col', text: '变化' }),
            h('th', { scope: 'col', text: '方向' }),
            h('th', { scope: 'col', text: '样本（早期/近期）' }),
            h('th', { scope: 'col', text: '状态' })
          )
        ),
        h('tbody', {}, rows)
      )
    ),
    h('p', { class: 'hint', text: '「样本不足」的指标不进入加权分母，不会被当成 0 分拉低总分；方向由指标自身的变差方向与绝对变化死区共同判定，delta% 仅供参考，反向变化在表中保留展示但不计为退化。' })
  );
}

function renderCharts(report) {
  const metrics = report.metrics;
  if (!metrics.length) return null;
  const chartable = metrics.filter((metric) => metric.series.some(
    (point) => Number.isFinite(point.t) && Number.isFinite(point.v)
  ));
  if (!chartable.length) {
    return h('section', { class: 'degrade-section' },
      h('h3', { class: 'section-title', text: '指标折线图（原生 SVG）' }),
      h('p', { class: 'empty-note', text: '没有可绘制的时间序列：日志缺少时间戳，或所有指标都不足（样本不足）。指标数值仍可在上方表格查看。' })
    );
  }
  return h('section', { class: 'degrade-section' },
    h('h3', { class: 'section-title', text: `指标折线图（原生 SVG，序列 ≤ 500 点；${chartable.length} / ${metrics.length} 个指标可绘制）` }),
    h('div', { class: 'chart-grid' },
      chartable.map((metric) => renderChartCard(metric, report.segments.splitAt))
    ),
    h('p', { class: 'hint', text: '折线图为原生 SVG 手写，不依赖任何第三方图表库；时间戳缺失的指标不绘制折线。' })
  );
}

function renderFindings(report) {
  if (!report.findings.length) {
    return h('section', { class: 'degrade-section' },
      h('h3', { class: 'section-title', text: '发现（findings）' }),
      h('p', { class: 'empty-note', text: '未产生任何 findings：指标前后没有显著变化，或可用指标太少。' })
    );
  }
  return h('section', { class: 'degrade-section' },
    h('h3', { class: 'section-title', text: `发现（findings，共 ${report.findings.length} 条）` }),
    h('div', { class: 'finding-list' },
      report.findings.map((finding) => h('article', { class: `finding-card severity-${finding.severity}` },
        h('div', { class: 'finding-head' },
          chip(SEVERITY_LABELS[finding.severity] || finding.severity, { tone: SEVERITY_TONES[finding.severity] || 'neutral' }),
          h('h4', { class: 'finding-title', text: finding.title })
        ),
        finding.detail ? h('p', { class: 'finding-detail', text: finding.detail }) : null,
        finding.suggestion ? h('p', { class: 'finding-suggestion', text: `建议：${finding.suggestion}` }) : null,
        finding.evidence === null
          ? null
          : detailsBlock('证据（原样展示，仅含计数 / 比率 / 时间戳等汇总数据）',
              codeBlock(stringify(finding.evidence), { maxHeight: '12rem' }))
      ))
    )
  );
}

function renderBreakdown(label, entries) {
  if (!entries.length) return h('p', { class: 'empty-note', text: `${label}：—` });
  return h('div', { class: 'breakdown-block' },
    h('h5', { class: 'breakdown-title', text: label }),
    h('div', { class: 'chip-row' },
      entries.slice(0, 20).map((entry) => chip(`${entry.name}：${entry.count}`, { tone: 'plain', mono: true }))
    )
  );
}

function renderCoverage(report) {
  return h('section', { class: 'degrade-section' },
    h('h3', { class: 'section-title', text: '样本覆盖与隐私' }),
    h('div', { class: 'coverage-grid' },
      h('div', { class: 'coverage-card' },
        h('h4', { class: 'coverage-title', text: '覆盖率' }),
        kvTable([
          ['总记录', String(report.coverage.records)],
          ['可用记录（含时间戳等）', String(report.coverage.usable)],
          ['涉及模型', String(report.coverage.byModel.length)],
          ['数据来源', String(report.coverage.bySource.length)],
          ['时间跨度', report.coverage.spanDays === null ? '—' : `${report.coverage.spanDays.toFixed(1)} 天`]
        ], { caption: 'coverage' })
      ),
      h('div', { class: 'coverage-card' },
        renderBreakdown('按来源（source）', report.coverage.bySource),
        renderBreakdown('按模型（model）', report.coverage.byModel)
      )
    ),
    h('p', { class: 'hint', text: '报告只包含计数、比率、中位数、时间戳、模型名与字段名，不包含日志原文、提示词内容或文件名。' })
  );
}

function renderNotes(report) {
  if (!report.notes.length) return null;
  return h('section', { class: 'degrade-section' },
    h('h3', { class: 'section-title', text: '分析过程说明' }),
    h('ul', { class: 'notes-list' }, report.notes.map((note) => h('li', { text: note })))
  );
}

function renderDisclaimer() {
  return h('section', { class: 'degrade-disclaimer', role: 'note' },
    h('h3', { class: 'degrade-disclaimer-title', text: '⚠️ 这不是 IQ 测试，也不是能力测量' }),
    h('ul', { class: 'degrade-disclaimer-list' },
      h('li', { text: '日志只能反映「可观测行为的变化」，无法证明模型智力下降；结论是统计迹象，不是确定性结论。' }),
      h('li', { text: '输出长度下降也可能是任务分布变化、系统提示词变化或缓存策略变化，而不一定是模型本身变化。' }),
      h('li', { text: '指标会受流量构成、时段、工具调用比例等混杂因素影响；请结合自己的使用场景与账单记录综合判断。' }),
      h('li', { text: '本工具不做 IQ 测题，也不给模型打能力分；它的价值是帮你发现「值得进一步排查」的变化。' })
    )
  );
}

function renderActions(report) {
  const json = () => exportDegradeJson(report);
  const download = () => {
    try {
      const blob = new Blob([json()], { type: 'application/json' });
      const url = URL.createObjectURL(blob);
      const link = h('a', { href: url, download: 'degrade-report.json' });
      document.body.append(link);
      link.click();
      link.remove();
      setTimeout(() => URL.revokeObjectURL(url), 4000);
    } catch {
      // 极端环境下 Blob 不可用：仍可复制摘要
    }
  };

  return h('div', { class: 'report-actions no-print' },
    copyButton(() => degradeReportToText(report), { label: '复制诊断摘要（纯文本）' }),
    h('button', { type: 'button', class: 'btn btn-ghost', onclick: download }, '下载 degrade-report.json'),
    h('button', { type: 'button', class: 'btn btn-ghost', onclick: () => window.print() }, '打印 / 存为 PDF')
  );
}

/* ------------------------------------------------------------------ *
 * 隐私：序列化前递归剥离 raw
 * ------------------------------------------------------------------ */

/**
 * 递归剥离日志原文 / 原始行 / 文件名等隐私字段（契约 §9.2）。
 * 核心模块在生成报告时已经做过一次剥离；UI 导出前再兜一层，并防御循环引用。
 * 说明：只删除「明确属于日志原文 / 路径」的键，避免误删指标里合法的字段。
 */
const PRIVATE_KEYS = new Set([
  'raw',
  'rawLine',
  'rawLines',
  'rawRecord',
  'rawText',
  'rawBody',
  'promptText',
  'completionText',
  'filePath',
  'fileName',
  'filename'
]);

export function scrubRaw(value) {
  return scrubInner(value, new WeakSet());
}

function scrubInner(value, seen) {
  if (value === null || typeof value !== 'object') return value;
  if (seen.has(value)) return '[circular]';
  seen.add(value);
  if (Array.isArray(value)) return value.map((item) => scrubInner(item, seen));
  const out = {};
  for (const [key, item] of Object.entries(value)) {
    if (PRIVATE_KEYS.has(key)) continue;
    out[key] = scrubInner(item, seen);
  }
  return out;
}

/** 导出报告 JSON（已剥离 raw）。 */
export function exportDegradeJson(report) {
  try {
    return JSON.stringify(scrubRaw(report), null, 2);
  } catch {
    return '{}';
  }
}

/* ------------------------------------------------------------------ *
 * 状态视图
 * ------------------------------------------------------------------ */

export function renderDegradeEmpty(container, message) {
  if (!container) return;
  container.replaceChildren(
    h('div', { class: 'state-card empty-state' },
      h('div', { class: 'state-icon', 'aria-hidden': 'true', text: '📉' }),
      h('h3', { class: 'state-title', text: '等待日志' }),
      h('p', { class: 'state-text', text: message || '在上方拖入或选择日志文件，然后点击「开始分析」。' }),
      h('ul', { class: 'hint-list' },
        h('li', { text: '支持 Claude Code 会话 JSONL、通用 API 日志 JSONL、用量 / 账单 CSV、ChatGPT 导出 conversations.json。' }),
        h('li', { text: '格式按内容自动识别，不依赖扩展名。' }),
        h('li', { text: '日志只在你的浏览器内存中解析，不会上传到任何地方。' })
      )
    )
  );
}

export function renderDegradeLoading(container, info = {}) {
  if (!container) return;
  const records = intOr(info.records, 0);
  container.replaceChildren(
    h('div', { class: 'state-card loading-state' },
      h('div', { class: 'spinner', 'aria-hidden': 'true' }),
      h('h3', { class: 'state-title', text: '正在本地分析日志…' }),
      h('p', { class: 'state-text', text: records > 0 ? `已载入 ${records} 条记录；全部计算在你的浏览器内完成。` : '正在做前后期对比与指标计算。' }),
      h('p', { class: 'state-hint', text: '不需要网络；日志不会离开本机。' })
    )
  );
}

export function renderDegradeError(container, message, opts = {}) {
  if (!container) return;
  const {
    title = '降智诊断未能完成',
    detail = '',
    hints = [
      '日志为空、格式无法识别，或引擎模块尚未就绪时会出现此提示。',
      '支持 .jsonl / .json / .csv / .log，也支持无扩展名文件；格式由内容自动识别。',
      '页面其它功能（连接方式 / 上游真伪检测）不受影响。'
    ]
  } = opts;
  const nodes = [
    h('div', { class: 'state-icon', 'aria-hidden': 'true', text: '⚠️' }),
    h('h3', { class: 'state-title', text: String(title) }),
    h('p', { class: 'state-text', text: String(message || '未知错误') })
  ];
  if (detail) nodes.push(detailsBlock('技术细节（供排错）', codeBlock(String(detail), { maxHeight: '14rem' })));
  if (Array.isArray(hints) && hints.length) {
    nodes.push(h('ul', { class: 'hint-list' }, hints.map((text) => h('li', { text: String(text) }))));
  }
  container.replaceChildren(h('div', { class: 'state-card error-state', role: 'alert' }, nodes));
}

/* ------------------------------------------------------------------ *
 * 主渲染入口
 * ------------------------------------------------------------------ */

/**
 * 渲染完整降智诊断报告。内部整体 try/catch，绝不把页面搞白屏。
 * @param {Element} container
 * @param {object} report DegradationReport（契约 10.3）
 */
export function renderDegradeReport(container, report) {
  if (!container) return;
  try {
    const r = normalizeDegradeReport(report);
    const children = [
      renderVerdictHead(r),
      renderCriticalBanner(r),
      r.verdict === 'insufficient' ? renderInsufficientBanner(r) : null,
      renderSummary(r),
      renderSegments(r),
      renderMetricsTable(r),
      renderCharts(r),
      renderFindings(r),
      renderCoverage(r),
      renderNotes(r),
      renderFeaturesNote(r),
      renderDisclaimer(),
      renderActions(r)
    ].filter(Boolean);
    container.replaceChildren(h('div', { class: 'degrade-report' }, children));
  } catch (error) {
    renderDegradeError(container, '诊断报告渲染失败，已降级为错误提示。报告数据仍可复制。', {
      title: '渲染出错',
      detail: error && error.stack ? String(error.stack) : String(error)
    });
  }
}

/** 「为什么分数与证据强度分开展示」的固定说明。 */
function renderFeaturesNote(report) {
  const scoreText = report.verdict === 'insufficient' ? '样本不足时不评分' : formatScoreText(report.score);
  return h('p', { class: 'hint degrade-score-note', text: `score（${scoreText}）表示退化倾向，evidenceStrength（${formatPercent(report.evidenceStrength)}）表示证据充分度；两者独立展示，不合并成一个数。` });
}

/** 纯文本摘要（复制用；不含日志原文与文件名）。 */
export function degradeReportToText(report) {
  const r = normalizeDegradeReport(report);
  const lines = [];
  lines.push('降智诊断报告（基于使用日志的可观测行为变化；不是 IQ 测试，也不是能力测量）');
  lines.push(`结论：${DEGRADE_VERDICT_LABELS[r.verdict] || r.verdict}（summaryText：${r.summaryText}）`);
  if (r.verdict === 'insufficient') {
    lines.push('退化倾向评分：不适用（样本不足，不显示低分）');
  } else {
    lines.push(`退化倾向评分 score = ${r.score} / 100；证据充分度 evidenceStrength = ${formatPercent(r.evidenceStrength)}（两者分开，不合并）`);
  }
  lines.push(`记录：${r.coverage.records} 条（可用 ${r.coverage.usable} 条）· 可用指标：${r.usableMetrics} / ${r.metrics.length} · 时间跨度：${r.coverage.spanDays === null ? '—' : `${r.coverage.spanDays.toFixed(1)} 天`}`);
  lines.push(`前后期：早期 ${r.segments.early.count} 条（${formatDateTime(r.segments.early.from)} → ${formatDateTime(r.segments.early.to)}）；近期 ${r.segments.recent.count} 条（${formatDateTime(r.segments.recent.from)} → ${formatDateTime(r.segments.recent.to)}）`);
  lines.push(`变化点：${r.segments.splitAt === null ? '未探测到' : formatDateTime(r.segments.splitAt)}`);
  if (r.verdict === 'insufficient') {
    lines.push('补样建议：');
    for (const advice of insufficientAdvice(r)) lines.push(`- ${advice}`);
  }
  if (r.criticalIssues.length) {
    lines.push('');
    lines.push(`严重问题（critical）：${r.criticalIssues.length} 项`);
    for (const issue of r.criticalIssues) lines.push(`- ${issue.title}${issue.detail ? `：${issue.detail}` : ''}`);
  }
  if (r.metrics.length) {
    lines.push('');
    lines.push('指标对比：');
    for (const metric of r.metrics) {
      lines.push(`- ${metric.label}（${metric.id}）：早期 ${formatMetricValue(metric.early, metric.unit)} → 近期 ${formatMetricValue(metric.recent, metric.unit)}，变化 ${formatDeltaPct(metric.deltaPct)}，方向 ${directionLabel(metric.direction, metric.deltaPct)}，样本 ${metric.samples.early}/${metric.samples.recent}，${metric.status === 'ok' ? '参与评分' : '样本不足（不计分）'}`);
    }
  }
  if (r.findings.length) {
    lines.push('');
    lines.push('发现：');
    for (const finding of r.findings) {
      lines.push(`- [${SEVERITY_LABELS[finding.severity] || finding.severity}] ${finding.title}`);
      if (finding.detail) lines.push(`  ${finding.detail}`);
      if (finding.suggestion) lines.push(`  建议：${finding.suggestion}`);
    }
  }
  if (r.notes.length) {
    lines.push('');
    lines.push('过程说明：');
    for (const note of r.notes) lines.push(`- ${note}`);
  }
  lines.push('');
  lines.push('免责声明：日志只能反映「可观测行为的变化」，无法证明模型智力下降；输出长度下降也可能是任务分布、系统提示词或缓存策略变化。结论是统计迹象，不是确定性结论。');
  return lines.join('\n');
}
