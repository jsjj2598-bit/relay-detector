/**
 * 用量 / 账单 CSV 解析器（契约 v3 §10.2）。
 *
 * 现实里的「用量导出」格式极不统一，这里走**字段容错**路线：
 *  - 自动识别分隔符（逗号 / 制表符 / 分号）；
 *  - 自动剥离 BOM、兼容 CRLF / LF；
 *  - 表头支持英文（`timestamp,model,prompt_tokens,...`）、中英混排与纯中文
 *    （`时间,模型,输入,输出`）、以及 OpenAI usage dashboard 的 `n_*_tokens_total` 列；
 *  - 数字容忍千分位逗号、空值、`-`、`N/A`（一律视为缺失，不伪造 0）。
 *
 * 解析器只产出「半成品字段」，由 `normalize.js#createRecord` 统一成 LogRecord。
 */

/** 表单字段 → 表头别名（比较前都会经过 normalizeHeaderKey）。 */
const HEADER_ALIASES = [
  [
    'timestamp',
    [
      'timestamp', 'time', 'ts', 'date', 'datetime', 'createdat', 'created_at',
      'aggregation_timestamp', 'start_time', 'starttime',
      '时间', '日期', '时间戳', '创建时间', '开始时间'
    ]
  ],
  [
    'model',
    [
      'model', 'response_model', 'responsemodel', 'model_name', 'modelname',
      'model_slug', 'modelslug', 'snapshot', '模型', '模型名称', '响应模型', '实际模型'
    ]
  ],
  [
    'requestModel',
    ['request_model', 'requestmodel', 'requested_model', 'requestedmodel', 'model_requested', '请求模型', '指定模型']
  ],
  [
    'promptTokens',
    [
      'prompt_tokens', 'prompt', 'input_tokens', 'input', 'prompt_token_count',
      'input_token_count', 'n_context_tokens_total', 'context_tokens', 'prompttokens',
      '输入', '输入tokens', '输入token', '输入token数', '提示词tokens'
    ]
  ],
  [
    'completionTokens',
    [
      'completion_tokens', 'completion', 'output_tokens', 'output', 'completion_token_count',
      'output_token_count', 'candidates_token_count', 'n_generated_tokens_total',
      'generated_tokens', 'completiontokens',
      '输出', '输出tokens', '输出token', '输出token数'
    ]
  ],
  [
    'cacheReadTokens',
    [
      'cache_read_tokens', 'cache_read', 'cached_tokens', 'cache_read_input_tokens',
      'prompt_cache_hit_tokens', 'cache_hit_tokens', 'cachereadtokens',
      '缓存读取', '缓存命中tokens', '缓存命中'
    ]
  ],
  [
    'cacheWriteTokens',
    [
      'cache_creation_tokens', 'cache_write_tokens', 'cache_creation_input_tokens',
      'cache_write', 'cachecreationtokens', '缓存写入', '缓存创建tokens'
    ]
  ],
  [
    'thinkingTokens',
    [
      'thinking_tokens', 'reasoning_tokens', 'thoughts_token_count', 'thinking', 'reasoning',
      'thinkingtokens', 'reasoningtokens', '思考tokens', '推理tokens', '思考token'
    ]
  ],
  [
    'finishReason',
    ['finish_reason', 'stop_reason', 'finishreason', '结束原因', '停止原因']
  ],
  [
    'latencyMs',
    [
      'latency_ms', 'latency', 'duration_ms', 'duration', 'elapsed_ms',
      'response_time_ms', 'response_time', 'latencyms',
      '延迟', '耗时', '延迟ms', '响应时间'
    ]
  ],
  [
    'status',
    ['status', 'status_code', 'statuscode', 'http_status', 'http_status_code', '状态', '状态码', 'http状态']
  ],
  [
    'errorCode',
    ['error_code', 'errorcode', 'error', '错误', '错误码', '异常']
  ],
  [
    'sessionId',
    ['session_id', 'sessionid', 'conversation_id', 'conversationid', 'request_id', 'requestid', '会话id', '会话']
  ]
];

/** 别名（已归一化）→ 字段名。 */
const HEADER_LOOKUP = (() => {
  const map = new Map();
  for (const [field, aliases] of HEADER_ALIASES) {
    for (const alias of aliases) {
      const key = normalizeHeaderKey(alias);
      if (key && !map.has(key)) map.set(key, field);
    }
  }
  return map;
})();

/** 表头 cell 归一化：去 BOM / 引号 / 空白 / 分隔符差异，小写。 */
export function normalizeHeaderKey(value) {
  return String(value == null ? '' : value)
    .replace(/^\uFEFF/, '')
    .trim()
    .replace(/^"|"$/g, '')
    .toLowerCase()
    .replace(/[\s_\-./\\()（）:：]+/g, '');
}

/** 检测分隔符：逗号 / 制表符 / 分号中计数最多者；没有则 null。 */
export function detectDelimiter(line) {
  const text = String(line == null ? '' : line);
  const counts = {
    ',': (text.match(/,/g) || []).length,
    '\t': (text.match(/\t/g) || []).length,
    ';': (text.match(/;/g) || []).length
  };
  let best = null;
  let bestCount = 0;
  for (const [delimiter, count] of Object.entries(counts)) {
    if (count > bestCount) {
      best = delimiter;
      bestCount = count;
    }
  }
  return bestCount > 0 ? best : null;
}

/** 拆分一行 CSV（支持双引号包裹与 `""` 转义）。 */
export function splitCsvLine(line, delimiter) {
  const text = String(line == null ? '' : line);
  const cells = [];
  let cell = '';
  let inQuotes = false;
  for (let i = 0; i < text.length; i += 1) {
    const ch = text[i];
    if (inQuotes) {
      if (ch === '"') {
        if (text[i + 1] === '"') {
          cell += '"';
          i += 1;
        } else {
          inQuotes = false;
        }
      } else {
        cell += ch;
      }
    } else if (ch === '"') {
      inQuotes = true;
    } else if (ch === delimiter) {
      cells.push(cell);
      cell = '';
    } else {
      cell += ch;
    }
  }
  cells.push(cell);
  return cells.map((value) => value.trim());
}

/** 把表头 cell 数组映射成 `{ field: columnIndex }`（同名字段取第一列）。 */
export function mapHeader(headerCells) {
  const mapping = {};
  const cells = Array.isArray(headerCells) ? headerCells : [];
  for (let i = 0; i < cells.length; i += 1) {
    const field = HEADER_LOOKUP.get(normalizeHeaderKey(cells[i]));
    if (!field) continue;
    if (!(field in mapping)) mapping[field] = i;
  }
  return mapping;
}

/** 在文件开头若干行里定位表头，返回 `{ headerIndex, delimiter, mapping }` 或 null。 */
function findHeader(lines) {
  const limit = Math.min(lines.length, 12);
  for (let i = 0; i < limit; i += 1) {
    const line = lines[i];
    if (!line || !line.trim()) continue;
    const delimiter = detectDelimiter(line);
    if (!delimiter) continue;
    const cells = splitCsvLine(line, delimiter);
    if (cells.length < 2) continue;
    const mapping = mapHeader(cells);
    if (Object.keys(mapping).length >= 2) return { headerIndex: i, delimiter, mapping };
  }
  return null;
}

/**
 * 解析 CSV 文本。
 *
 * @param {string} text
 * @param {{startIndex?: number, maxRecords?: number}} [options]
 * @returns {{records: object[], total: number, skipped: number, warnings: string[]}}
 */
export function parse(text, options = {}) {
  const source = typeof text === 'string' ? text : '';
  const startIndex = Number.isFinite(options.startIndex) ? options.startIndex : 0;
  const maxRecords = Number.isFinite(options.maxRecords) ? options.maxRecords : Infinity;

  const clean = source.replace(/^\uFEFF/, '');
  const lines = clean.split(/\r?\n/);
  const header = findHeader(lines);
  if (!header) {
    return {
      records: [],
      total: 0,
      skipped: 0,
      warnings: ['未识别到可用的 CSV 表头（至少需要 2 个已知列，如 timestamp / model / prompt_tokens）。']
    };
  }

  const { headerIndex, delimiter, mapping } = header;
  const records = [];
  const warnings = [];
  let total = 0;
  let nonDataRows = 0;

  for (let i = headerIndex + 1; i < lines.length; i += 1) {
    const line = lines[i];
    if (!line || !line.trim()) continue;
    const trimmed = line.trim();
    if (trimmed.startsWith('#') || trimmed.startsWith('//')) continue; // 注释行不计入 total
    total += 1;

    const cells = splitCsvLine(line, delimiter);
    const get = (field) => {
      const column = mapping[field];
      if (column === undefined) return '';
      return cells[column] === undefined ? '' : cells[column];
    };

    const hasAny = ['timestamp', 'model', 'requestModel', 'promptTokens', 'completionTokens']
      .some((field) => String(get(field)).trim() !== '');
    if (!hasAny) {
      nonDataRows += 1; // 空行 / 汇总合计行
      continue;
    }

    records.push({
      timestamp: get('timestamp'),
      model: get('model'),
      requestModel: get('requestModel'),
      promptTokens: get('promptTokens'),
      completionTokens: get('completionTokens'),
      cacheReadTokens: get('cacheReadTokens'),
      cacheWriteTokens: get('cacheWriteTokens'),
      thinkingTokens: get('thinkingTokens'),
      finishReason: get('finishReason'),
      latencyMs: get('latencyMs'),
      status: get('status'),
      errorCode: get('errorCode'),
      sessionId: get('sessionId'),
      kind: 'usage',
      source: 'usage-csv'
    });
    if (records.length >= maxRecords) break;
  }

  const skipped = Math.max(0, total - records.length);
  if (nonDataRows > 0) warnings.push(`跳过 ${nonDataRows} 行空行 / 汇总行。`);
  if (skipped > nonDataRows) warnings.push(`跳过 ${skipped - nonDataRows} 行无法解析的 CSV 记录。`);
  if (records.length === 0) warnings.push('CSV 中没有解析到任何用量记录。');

  return {
    records: records.map((record, offset) => ({ ...record, __index: startIndex + offset })),
    total,
    skipped,
    warnings
  };
}
