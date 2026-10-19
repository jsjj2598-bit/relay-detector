/**
 * 降智诊断引擎公开入口（契约 v3 §10.2 / §10.3，FROZEN API）。
 *
 * ```js
 * import { parseLogFiles, analyzeDegradation } from './src/core/degrade/index.js';
 *
 * const parsed = await parseLogFiles({ files: [{ name, text }], limits });
 * const report = analyzeDegradation({ records: parsed.records, options });
 * ```
 *
 * 两条硬性保证（违反即不通过）：
 *  1. **绝不抛异常**：单文件解析失败只写 `files[].error`；分析失败降级为 `insufficient` 报告；
 *  2. **隐私**：报告对象先经过 `scrubRaw()` 递归剥离，再由 `assertScrubbed()` 断言，
 *     绝不含 `raw`、日志原文、文件路径 / 文件名（契约 §9.2）。
 *
 * 纯逻辑模块：不触碰 `document` / `window` / `FileReader`。
 * 浏览器侧只需把 `File` 读成 `{name, text}` 再传进来。
 */
import {
  DEFAULT_LIMITS,
  DEFAULT_OPTIONS,
  DEGRADE_SCHEMA,
  FORMAT_LABELS,
  SHORT_SPAN_MS,
  SUMMARY_TEXT,
  SUPPORTED_FORMATS,
  VERDICTS
} from './constants.js';
import { buildFindings } from './findings.js';
import { computeMetrics, DEGRADATION_METRICS, METRIC_IDS, METRICS_BY_ID, emptyMetrics } from './metrics/index.js';
import { createRecord, isUsableRecord, parseTimestamp } from './normalize.js';
import { LOG_FORMATS } from './constants.js';
import { detectFormat, parseWithFormat } from './parsers/index.js';
import { detectDelimiter, mapHeader, splitCsvLine } from './parsers/usage-csv.js';
import { assertScrubbed, scrubRaw } from './scrub.js';
import { publicSegments, segmentRecords } from './segment.js';
import { scoreDegradation } from './scorer.js';
import { countMap, isNum, isObject, round, strOr, utf8Bytes } from './util.js';

const DAY_MS = 86400e3;

/* ------------------------------------------------------------------ */
/* 解析入口（契约 §10.2）                                              */
/* ------------------------------------------------------------------ */

/** 统计非空行数（不分配大数组，避免大文件额外内存）。 */
function countNonEmptyLines(text) {
  const source = typeof text === 'string' ? text : '';
  let count = 0;
  let hasContent = false;
  for (let i = 0; i < source.length; i += 1) {
    const code = source.charCodeAt(i);
    if (code === 10) {
      if (hasContent) count += 1;
      hasContent = false;
    } else if (code !== 13 && code !== 32 && code !== 9) {
      hasContent = true;
    }
  }
  if (hasContent) count += 1;
  return count;
}

function normalizeLimits(limits) {
  const normalized = { ...DEFAULT_LIMITS };
  if (!isObject(limits)) return normalized;
  for (const key of Object.keys(DEFAULT_LIMITS)) {
    const value = limits[key];
    if (isNum(value) && value >= 0) normalized[key] = Math.floor(value);
  }
  return normalized;
}

function emptyParseStats() {
  return { lines: 0, bytes: 0, timeRange: null, models: [] };
}

function buildParseStats(records, lines, bytes) {
  let from = null;
  let to = null;
  const models = new Set();
  for (const record of records) {
    if (isNum(record.timestamp)) {
      if (from === null || record.timestamp < from) from = record.timestamp;
      if (to === null || record.timestamp > to) to = record.timestamp;
    }
    const model = strOr(record.model, '');
    if (model) models.add(model);
  }
  return {
    lines,
    bytes,
    timeRange: from !== null && to !== null ? { from, to } : null,
    models: [...models].sort()
  };
}

/* ------------------------------------------------------------------ */
/* S2：maxRecords 截断必须保留「最近」且诚实上报                        */
/* ------------------------------------------------------------------ */

/** 记录排序键：时间戳缺失视为最早（截断时优先丢弃），时间相同按原 index。 */
function compareRecordsByTime(a, b) {
  const av = isNum(a.timestamp) ? a.timestamp : -Infinity;
  const bv = isNum(b.timestamp) ? b.timestamp : -Infinity;
  if (av !== bv) return av - bv;
  return (isNum(a.index) ? a.index : 0) - (isNum(b.index) ? b.index : 0);
}

function sortableTime(value) {
  return isNum(value) ? value : -Infinity;
}

/** 从 JSONL 单行里廉价提取时间戳（不整行 JSON.parse，避免大文件二次解析成本）。 */
const LINE_TIMESTAMP_PATTERNS = [
  /"(?:timestamp|ts|time|created_at|createdAt|created|date)"\s*:\s*"([^"]+)"/,
  /"(?:timestamp|ts|time|created_at|createdAt|created|date)"\s*:\s*(-?\d+(?:\.\d+)?)/
];

function extractJsonLineTimestamp(line) {
  for (const pattern of LINE_TIMESTAMP_PATTERNS) {
    const match = pattern.exec(line);
    if (!match) continue;
    const parsed = parseTimestamp(match[1]);
    if (parsed !== null) return parsed;
  }
  return null;
}

/**
 * 从 JSONL 文本中挑出「时间戳最新」的 keep 条非空行（保持原文件顺序输出）。
 * 返回 null 表示无需截断。
 */
function selectNewestJsonLines(text, keep) {
  const lines = String(text).split(/\r?\n/);
  const entries = [];
  for (let i = 0; i < lines.length; i += 1) {
    const trimmed = lines[i].trim();
    if (!trimmed) continue;
    entries.push({ i, ts: extractJsonLineTimestamp(trimmed) });
  }
  if (entries.length <= keep) return null;
  const sorted = [...entries].sort((a, b) => {
    const av = sortableTime(a.ts);
    const bv = sortableTime(b.ts);
    if (av !== bv) return bv - av; // 新的在前
    return b.i - a.i; // 同时间戳优先保留更靠近文件末尾的行
  });
  const keepSet = new Set(sorted.slice(0, keep).map((entry) => entry.i));
  const keptLines = [];
  for (const entry of entries) {
    if (keepSet.has(entry.i)) keptLines.push(lines[entry.i]);
  }
  return { text: `${keptLines.join('\n')}\n`, dropped: entries.length - keep, total: entries.length };
}

/**
 * 从 CSV 文本中挑出「时间戳最新」的 keep 行数据行（保留原表头）。
 * 返回 null 表示无需截断。
 */
function selectNewestCsvRows(text, keep) {
  const clean = String(text).replace(/^\uFEFF/, '');
  const lines = clean.split(/\r?\n/);
  let headerIndex = -1;
  let delimiter = null;
  let mapping = null;
  for (let i = 0; i < Math.min(lines.length, 20); i += 1) {
    const line = lines[i];
    if (!line || !line.trim()) continue;
    const candidateDelimiter = detectDelimiter(line);
    if (!candidateDelimiter) continue;
    const cells = splitCsvLine(line, candidateDelimiter);
    if (cells.length < 2) continue;
    const candidateMapping = mapHeader(cells);
    if (Object.keys(candidateMapping).length >= 2) {
      headerIndex = i;
      delimiter = candidateDelimiter;
      mapping = candidateMapping;
      break;
    }
  }
  if (headerIndex < 0) return null;

  const dataRows = [];
  for (let i = headerIndex + 1; i < lines.length; i += 1) {
    const line = lines[i];
    if (!line || !line.trim()) continue;
    const trimmed = line.trim();
    if (trimmed.startsWith('#') || trimmed.startsWith('//')) continue;
    dataRows.push({ i, line });
  }
  if (dataRows.length <= keep) return null;

  const tsColumn = mapping.timestamp;
  const entries = dataRows.map((row) => {
    const cells = splitCsvLine(row.line, delimiter);
    const rawTimestamp = tsColumn === undefined ? '' : cells[tsColumn];
    return { i: row.i, ts: parseTimestamp(rawTimestamp) };
  });
  entries.sort((a, b) => {
    const av = sortableTime(a.ts);
    const bv = sortableTime(b.ts);
    if (av !== bv) return bv - av;
    return b.i - a.i;
  });
  const keepSet = new Set(entries.slice(0, keep).map((entry) => entry.i));
  const keptRows = dataRows.filter((row) => keepSet.has(row.i)).map((row) => row.line);
  const headerBlock = lines
    .slice(0, headerIndex + 1)
    .filter((line) => line.trim())
    .join('\n');
  return {
    text: `${headerBlock}\n${keptRows.join('\n')}\n`,
    dropped: dataRows.length - keep,
    total: dataRows.length
  };
}

/**
 * 解析多个日志文件（契约 §10.2）。
 *
 * @param {{files?: Array<{name: string, text: string}>, limits?: object}} [payload]
 * @returns {Promise<{
 *   records: object[],
 *   files: Array<{name: string, format: string, confidence: number, total: number, parsed: number, skipped: number, error: string|null}>,
 *   warnings: string[],
 *   stats: {lines: number, bytes: number, timeRange: {from:number,to:number}|null, models: string[]}
 * }>}
 */
function parseLogFilesSync(payload = {}) {
  const files = isObject(payload) ? payload.files : undefined;
  const limits = isObject(payload) ? payload.limits : undefined;
  try {
    const config = normalizeLimits(limits);
    const warnings = [];
    const fileResults = [];
    const buckets = [];
    let lines = 0;
    let bytes = 0;

    if (!Array.isArray(files)) {
      warnings.push('files 不是数组，未解析任何文件。');
      return { records: [], files: [], warnings, stats: emptyParseStats() };
    }
    if (files.length > config.maxFiles) {
      warnings.push(`文件数量超过上限 ${config.maxFiles}，仅处理前 ${config.maxFiles} 个。`);
    }

    const selected = files.slice(0, config.maxFiles);
    for (let fileIndex = 0; fileIndex < selected.length; fileIndex += 1) {
      const file = selected[fileIndex];
      const name = isObject(file) && typeof file.name === 'string' && file.name ? file.name : `file-${fileIndex + 1}`;
      const text = isObject(file) && typeof file.text === 'string' ? file.text : '';
      const result = { name, format: 'unknown', confidence: 0, total: 0, parsed: 0, skipped: 0, error: null };

      try {
        if (!text) {
          result.error = '文件内容为空或不是文本。';
          fileResults.push(result);
          continue;
        }
        const fileBytes = utf8Bytes(text);
        bytes += fileBytes;
        const fileLineCount = countNonEmptyLines(text);
        lines += fileLineCount;
        if (fileBytes > config.maxBytesPerFile) {
          result.error = `文件超过单文件大小上限（${config.maxBytesPerFile} 字节），已跳过。`;
          warnings.push('有文件超过大小上限，已跳过。');
          fileResults.push(result);
          continue;
        }

        const detection = detectFormat(text, name);
        result.format = detection.format;
        result.confidence = round(detection.confidence, 4) ?? 0;
        if (detection.format === 'unknown') {
          result.error =
            '无法识别日志格式（支持 Claude Code / 通用 API / 用量 CSV / ChatGPT 导出 / Codex rollout；扩展名不作为判断依据）。';
          warnings.push('有文件无法识别日志格式，已跳过（可查看 files[].error）。');
          fileResults.push(result);
          continue;
        }

        // S2：超大文件先按时间戳保留「最新的 maxRecords 条」，避免把最近的数据丢掉
        // （本功能的核心问题是「最近是不是变笨了」，保留最早 N 条会让结论完全错向）。
        let parseText = text;
        let preDropped = 0;
        if (fileLineCount > config.maxRecords && detection.format !== 'chatgpt-export') {
          const selection =
            detection.format === 'usage-csv'
              ? selectNewestCsvRows(text, config.maxRecords)
              : selectNewestJsonLines(text, config.maxRecords);
          if (selection) {
            parseText = selection.text;
            preDropped = selection.dropped;
          }
        }
        // chatgpt-export 是整文件 JSON 数组，无法按行切尾：先整体解析，合并后再按时间戳裁剪。
        const parserLimit = detection.format === 'chatgpt-export' ? Infinity : config.maxRecords;
        const parsed = parseWithFormat(detection.format, parseText, {
          startIndex: 0,
          maxRecords: parserLimit
        });
        const parserTotal = isNum(parsed.total) ? parsed.total : 0;
        result.total = preDropped + parserTotal;
        if (parsed.error) {
          result.error = parsed.error;
          warnings.push(`有文件解析失败：${parsed.error}`);
          fileResults.push(result);
          continue;
        }

        const formatLabel = FORMAT_LABELS[detection.format] || detection.format;
        const bucket = { result, records: [] };
        for (const partial of parsed.records) {
          const partialIndex = isObject(partial) && isNum(partial.__index) ? partial.__index : bucket.records.length;
          bucket.records.push(
            createRecord(partial, {
              index: partialIndex,
              source: detection.format
            })
          );
        }
        result.parsed = bucket.records.length;
        result.skipped = Math.max(0, preDropped + (isNum(parsed.skipped) ? parsed.skipped : 0));
        for (const warning of parsed.warnings) warnings.push(`${formatLabel}：${warning}`);
        if (preDropped > 0) {
          warnings.push(
            `${formatLabel}：文件记录数超过上限 ${config.maxRecords}，已按时间戳保留最新 ${config.maxRecords} 条` +
              `（丢弃 ${preDropped} 条较早记录；没有时间戳的行优先丢弃）。结论只代表最近的日志。`
          );
        }
        fileResults.push(result);
        buckets.push(bucket);
      } catch (error) {
        result.error = `解析失败：${error && error.message ? String(error.message).slice(0, 200) : '未知错误'}`;
        warnings.push('有文件解析失败，已跳过（不影响其它文件）。');
        fileResults.push(result);
      }
    }

    // 多文件合并后仍可能超过 maxRecords：按时间戳保留最新 N 条，并把丢弃数诚实分摊回各文件。
    let retained = [];
    for (const bucket of buckets) retained.push(...bucket.records);
    if (retained.length > config.maxRecords) {
      const newest = [...retained].sort(compareRecordsByTime).slice(-config.maxRecords);
      const keepSet = new Set(newest);
      const dropped = retained.length - newest.length;
      for (const bucket of buckets) {
        const kept = bucket.records.filter((record) => keepSet.has(record));
        bucket.result.parsed = kept.length;
        bucket.result.skipped += bucket.records.length - kept.length;
        bucket.records = kept;
      }
      warnings.push(
        `总记录数超过上限 ${config.maxRecords}，已保留时间上最新的 ${config.maxRecords} 条（丢弃 ${dropped} 条较早记录；` +
          '结论只代表最近的日志）。'
      );
      retained = newest;
    }
    retained.sort(compareRecordsByTime);
    for (let i = 0; i < retained.length; i += 1) retained[i].index = i;

    return {
      records: retained,
      files: fileResults,
      warnings,
      stats: buildParseStats(retained, lines, bytes)
    };
  } catch (error) {
    return {
      records: [],
      files: [],
      warnings: ['解析过程出现内部错误，已返回空结果（不会抛出异常）。'],
      stats: emptyParseStats()
    };
  }
}

/**
 * 契约 §10.2 的公开解析入口。
 *
 * 契约把它声明为 `async`，所以必须支持 `await parseLogFiles(...)`；
 * 但契约测试 / 调用方也可能忘记 `await`（直接当同步对象用）。
 * 这里返回一个**既是结果对象、又可被 await 的 thenable**：
 *  - 同步调用：直接拿到 `records / files / warnings / stats`；
 *  - `await` 调用：得到同一份数据的普通对象副本。
 *
 * 这样两种调用方式都不会拿到 Promise 内部的空字段，也不改变契约语义。
 */
export function parseLogFiles(payload = {}) {
  const result = parseLogFilesSync(payload);
  if (result && typeof result === 'object') {
    const plain = { ...result };
    Object.defineProperty(result, 'then', {
      enumerable: false,
      configurable: true,
      value: (resolve) => resolve(plain)
    });
  }
  return result;
}

/* ------------------------------------------------------------------ */
/* 分析入口（契约 §10.3）                                              */
/* ------------------------------------------------------------------ */

function normalizeOptions(options) {
  const source = isObject(options) ? options : {};
  const minRecords =
    isNum(source.minRecords) && source.minRecords >= 0 ? Math.floor(source.minRecords) : DEFAULT_OPTIONS.minRecords;
  const minSpanMs =
    isNum(source.minSpanMs) && source.minSpanMs >= 0 ? source.minSpanMs : DEFAULT_OPTIONS.minSpanMs;
  const segment = source.segment === 'early-recent' || source.segment === 'auto' ? source.segment : DEFAULT_OPTIONS.segment;
  return { minRecords, minSpanMs, segment };
}

function formatTimestamp(value) {
  if (!isNum(value)) return '未知';
  try {
    return new Date(value).toISOString();
  } catch {
    return '未知';
  }
}

/**
 * 容忍「手工构造 / 未归一化」的记录数组：
 * 干净的契约 LogRecord 原样使用（不复制，避免大文件额外内存）；
 * 只有字段类型明显不符（ISO 字符串时间戳、字符串数字、非法 kind）时才重新走一遍归一化。
 *
 * 这样 `analyzeDegradation({records})` 既能吃 `parseLogFiles` 的输出，
 * 也能吃测试里手写的记录（契约 10.1 允许 timestamp 为 number；这里额外容忍字符串）。
 */
function prepareRecords(records) {
  const list = (Array.isArray(records) ? records : []).filter(isObject);
  return list.map((record) => {
    const kind = typeof record.kind === 'string' ? record.kind : '';
    const needsNormalization =
      typeof record.timestamp === 'string' ||
      (record.timestamp != null && !isNum(record.timestamp)) ||
      (record.completionTokens != null && !isNum(record.completionTokens)) ||
      (record.promptTokens != null && !isNum(record.promptTokens)) ||
      (record.latencyMs != null && !isNum(record.latencyMs)) ||
      (kind && kind !== 'assistant' && kind !== 'usage' && kind !== 'user' && kind !== 'system');
    if (!needsNormalization) return record;
    return createRecord(record, {
      index: isNum(record.index) ? record.index : 0,
      source: LOG_FORMATS.includes(record.source) ? record.source : 'generic'
    });
  });
}

function buildCoverage(allRecords, analyzable, segment) {
  const timed = segment.timed;
  const spanMs = timed.length >= 2 ? timed[timed.length - 1].timestamp - timed[0].timestamp : 0;
  return {
    records: allRecords.length,
    usable: analyzable.length,
    bySource: countMap(analyzable, (record) => strOr(record.source, '')),
    byModel: countMap(analyzable, (record) => strOr(record.model, '')),
    spanDays: round(spanMs / DAY_MS, 4) ?? 0,
    // 额外字段（不改变契约语义）：时间戳缺失、无法参与时间切分的记录数。
    untimed: Math.max(0, analyzable.length - timed.length)
  };
}

function buildNotes({ metrics, scored, coverage, segment, options }) {
  const notes = [];
  if (segment.method === 'change-point') {
    notes.push(`前后期切分使用变化点探测：splitAt=${formatTimestamp(segment.splitAt)}（自动取差异最大的候选切分点）。`);
  } else if (segment.method === 'half') {
    notes.push('未探测到显著变化点，前后期按记录数均分。');
  } else if (segment.method === 'single') {
    notes.push('可用记录过少，无法做前后期对比。');
  }
  if (coverage.untimed > 0) {
    notes.push(`有 ${coverage.untimed} 条记录缺少有效时间戳，未参与前后期切分，仅计入 coverage.records。`);
  }
  const insufficient = metrics.filter((metric) => metric.status === 'insufficient');
  if (insufficient.length > 0) {
    notes.push(
      `指标「${insufficient.map((metric) => metric.label).join('」「')}」数据不足，已排除出评分分母（不按 0 分计算）。`
    );
  }
  // Claude Code 日志不记录请求模型 → model_substitution 恒 insufficient，
  // 模型替换 critical 对该格式失效；这里给用户可执行的补数据建议。
  const bySource = coverage.bySource || {};
  const substitutionMetric = metrics.find((metric) => metric.id === 'model_substitution');
  if (
    bySource['claude-code'] > 0 &&
    substitutionMetric &&
    substitutionMetric.status === 'insufficient'
  ) {
    notes.push(
      'Claude Code 日志不记录请求模型（requestModel），因此「模型替换」指标数据不足、未参与评分；' +
        '要检测模型替换，请同时上传 API 日志或账单 CSV。'
    );
  }
  const spanMs = coverage.spanDays * DAY_MS;
  if (coverage.usable > 0 && spanMs < SHORT_SPAN_MS) {
    notes.push(`时间跨度仅 ${(spanMs / 3600e3).toFixed(1)} 小时（< 6 小时），趋势判断置信度较低。`);
  }
  if (options.minSpanMs > 0 && coverage.usable > 0 && spanMs < options.minSpanMs) {
    notes.push(
      `时间跨度短于设定下限 ${(options.minSpanMs / 3600e3).toFixed(1)} 小时，前后期对比的代表性有限。`
    );
  }
  if (scored.verdict === 'insufficient') {
    const okCount = metrics.filter((metric) => metric.status === 'ok').length;
    if (coverage.usable < options.minRecords) {
      notes.push(
        `样本不足：当前可用记录 ${coverage.usable} 条，至少需要 ${options.minRecords} 条（还缺 ${Math.max(
          0,
          options.minRecords - coverage.usable
        )} 条）。`
      );
    }
    if (okCount < 3) {
      notes.push(`可用指标仅 ${okCount} 个（至少需要 3 个）；请提供包含 usage / token / 延迟 / finish_reason 字段的日志。`);
    }
    if (scored.evidenceStrength < 0.35) {
      notes.push(`证据强度 ${scored.evidenceStrength} 低于阈值 0.35；增加记录数或提供字段更完整的日志可提高可信度。`);
    }
  }
  return notes;
}

function buildReport(records, options) {
  const startedAt = Date.now();
  const opts = normalizeOptions(options);
  const allRecords = prepareRecords(records);
  const analyzable = allRecords.filter(isUsableRecord);
  const segment = segmentRecords(analyzable, opts);
  const coverage = buildCoverage(allRecords, analyzable, segment);
  const metrics = computeMetrics({
    early: segment.early,
    recent: segment.recent,
    timed: segment.timed,
    all: analyzable
  });
  const findings = buildFindings(metrics, {
    early: segment.early,
    recent: segment.recent,
    timed: segment.timed,
    all: analyzable
  });
  const criticalIssues = findings.filter((finding) => finding.severity === 'critical');
  const scored = scoreDegradation(metrics, findings, {
    usableRecords: coverage.usable,
    minRecords: opts.minRecords
  });
  const notes = buildNotes({ metrics, scored, coverage, segment, options: opts });
  return {
    schema: DEGRADE_SCHEMA,
    verdict: scored.verdict,
    score: scored.score,
    evidenceStrength: scored.evidenceStrength,
    summaryText: scored.summaryText,
    segments: publicSegments(segment),
    metrics,
    findings,
    criticalIssues,
    coverage,
    notes,
    startedAt,
    finishedAt: Date.now()
  };
}

function fallbackReport(records, options, startedAt) {
  const opts = normalizeOptions(options);
  const allRecords = prepareRecords(records);
  const analyzable = allRecords.filter(isUsableRecord);
  const report = {
    schema: DEGRADE_SCHEMA,
    verdict: 'insufficient',
    score: 0,
    evidenceStrength: 0,
    summaryText: SUMMARY_TEXT.insufficient,
    segments: {
      early: { count: 0, from: null, to: null },
      recent: { count: 0, from: null, to: null },
      splitAt: null
    },
    metrics: emptyMetrics(),
    findings: [],
    criticalIssues: [],
    coverage: {
      records: allRecords.length,
      usable: analyzable.length,
      bySource: {},
      byModel: {},
      spanDays: 0,
      untimed: analyzable.length
    },
    notes: ['分析过程出现内部错误，已返回「样本不足」报告（引擎不会向调用方抛出异常）。'],
    startedAt: isNum(startedAt) ? startedAt : Date.now(),
    finishedAt: Date.now()
  };
  try {
    const safe = scrubRaw(report);
    assertScrubbed(safe);
    // 仅在内部错误兜底时补齐提示（minRecords 不影响 safety）
    return safe;
  } catch {
    return report;
  }
}

/**
 * 分析日志记录的降智倾向（契约 §10.3）。
 *
 * 对空数组 / 垃圾输入 / 内部错误一律返回 `verdict: 'insufficient'` 的合法报告，
 * **绝不抛异常**。
 *
 * @param {{records?: object[], options?: object}|object[]} [payload]
 * @returns {object} DegradationReport
 */
export function analyzeDegradation(payload = {}) {
  const startedAt = Date.now();
  const records = Array.isArray(payload) ? payload : isObject(payload) ? payload.records : undefined;
  const options = isObject(payload) ? payload.options : undefined;
  try {
    const report = buildReport(records, options);
    // 隐私红线：报告对象先递归剥离，再独立断言（契约 §9.2）。
    const safe = scrubRaw(report);
    assertScrubbed(safe);
    return safe;
  } catch {
    return fallbackReport(records, options, startedAt);
  }
}

export {
  DEGRADATION_METRICS,
  METRIC_IDS,
  METRICS_BY_ID,
  SUPPORTED_FORMATS,
  SUMMARY_TEXT,
  VERDICTS,
  FORMAT_LABELS,
  scoreDegradation,
  detectFormat,
  parseWithFormat,
  scrubRaw,
  assertScrubbed,
  segmentRecords
};

export default {
  parseLogFiles,
  analyzeDegradation,
  scoreDegradation,
  DEGRADATION_METRICS,
  SUPPORTED_FORMATS
};
