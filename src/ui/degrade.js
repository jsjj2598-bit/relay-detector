/**
 * src/ui/degrade.js —— 「降智诊断」前端控制器（契约 v3 §9 / §13）。
 *
 * 职责：
 *   - 页面内 tab 切换（「连接方式 & 上游真伪」 / 「降智诊断」），不打乱 v1/v2 布局；
 *   - 拖拽 / 文件选择 → 用 **FileReader 只在浏览器内存里**读取文本；
 *   - 调用 parseLogFiles() 展示逐文件解析反馈与总计；
 *   - 调用 analyzeDegradation() 并用 degrade-report.js 渲染报告；
 *   - 一键清空内存中的日志文本、解析记录与报告。
 *
 * 隐私红线（契约 §9）：
 *   - **零网络请求**：本文件不调用 fetch / XHR / WebSocket，不上传、不写 localStorage；
 *   - 日志文本与解析记录只保存在页面内存（模块级变量），清空按钮会丢弃它们；
 *   - 文件名只用于界面展示，不进入导出的报告 JSON。
 */

import { h, chip, statCard, formatPercent } from './components.js';
import {
  loadDegradeModule,
  getDegradeStatus,
  parseLogFilesSafe,
  analyzeDegradationSafe,
  formatLabel,
  getSupportedFormats,
  describeDegradeError
} from './degrade-api.js';
import {
  renderDegradeEmpty,
  renderDegradeLoading,
  renderDegradeError,
  renderDegradeReport,
  DEFAULT_MIN_RECORDS,
  DEFAULT_MIN_SPAN_MS
} from './degrade-report.js';

const MAX_FILES = 20;
const MAX_FILE_BYTES = 64 * 1024 * 1024;
const MAX_RECORDS = 200000;

/** 选中的文件（只含内存文本；清空时丢弃）。 */
let entries = [];
/** 解析得到的规范化记录（内存）。 */
let records = [];
/** parseLogFiles 的返回值。 */
let parseResult = null;
let parseError = null;
/** 最近一次分析报告。 */
let report = null;
let analyzing = false;
let parseToken = 0;
let degradeStatusSnapshot = getDegradeStatus();
let fileSequence = 0;

const el = (id) => document.getElementById(id);

function textSpan(className, text) {
  const span = document.createElement('span');
  span.className = className;
  span.textContent = text;
  return span;
}

function formatBytes(bytes) {
  const value = typeof bytes === 'number' && Number.isFinite(bytes) ? bytes : 0;
  if (value < 1024) return `${value} B`;
  if (value < 1024 * 1024) return `${(value / 1024).toFixed(1)} KB`;
  return `${(value / (1024 * 1024)).toFixed(1)} MB`;
}

function formatDateTime(ts) {
  if (typeof ts !== 'number' || !Number.isFinite(ts)) return '—';
  try {
    return new Date(ts).toLocaleString('zh-CN', { hour12: false });
  } catch {
    return '—';
  }
}

/* ------------------------------------------------------------------ *
 * Tab 切换
 * ------------------------------------------------------------------ */

function safeLocation() {
  try {
    if (typeof window !== 'undefined' && window.location) return window.location;
  } catch {
    // 忽略
  }
  return null;
}

function activateView(view) {
  const target = view === 'degrade' ? 'degrade' : 'detect';
  const tabs = Array.from(document.querySelectorAll('[data-view-tab]'));
  for (const tab of tabs) {
    const active = tab.getAttribute('data-view-tab') === target;
    tab.classList.toggle('is-active', active);
    tab.setAttribute('aria-selected', active ? 'true' : 'false');
    tab.tabIndex = active ? 0 : -1;
  }
  const detectView = el('detect-view');
  const degradeView = el('degrade-view');
  if (detectView) detectView.classList.toggle('hidden', target !== 'detect');
  if (degradeView) degradeView.classList.toggle('hidden', target !== 'degrade');
}

function initViewTabs() {
  const tabs = Array.from(document.querySelectorAll('[data-view-tab]'));
  if (!tabs.length) return;

  for (const tab of tabs) {
    tab.addEventListener('click', () => activateView(tab.getAttribute('data-view-tab')));
    tab.addEventListener('keydown', (event) => {
      if (event.key !== 'ArrowLeft' && event.key !== 'ArrowRight') return;
      event.preventDefault();
      const index = tabs.indexOf(tab);
      const nextIndex = event.key === 'ArrowRight'
        ? (index + 1) % tabs.length
        : (index - 1 + tabs.length) % tabs.length;
      const next = tabs[nextIndex];
      if (next) {
        activateView(next.getAttribute('data-view-tab'));
        next.focus();
      }
    });
  }

  let initial = 'detect';
  const location = safeLocation();
  if (location) {
    try {
      const params = new URLSearchParams(location.search || '');
      if (params.get('tab') === 'degrade') initial = 'degrade';
    } catch {
      // 忽略
    }
    const hash = String(location.hash || '').toLowerCase();
    if (hash === '#degrade' || hash === '#degrade-panel') initial = 'degrade';
  }
  activateView(initial);
}

/* ------------------------------------------------------------------ *
 * 文件读取（FileReader，纯内存）
 * ------------------------------------------------------------------ */

function getFileReaderCtor() {
  try {
    if (typeof FileReader === 'function') return FileReader;
  } catch {
    // 继续
  }
  try {
    if (typeof window !== 'undefined' && typeof window.FileReader === 'function') return window.FileReader;
  } catch {
    // 忽略
  }
  return null;
}

function readFileText(file) {
  return new Promise((resolve, reject) => {
    const Reader = getFileReaderCtor();
    if (!Reader) {
      if (file && typeof file.text === 'function') {
        file.text().then(resolve, reject);
        return;
      }
      reject(new Error('当前环境不支持 FileReader，无法读取本地文件。'));
      return;
    }
    let reader;
    try {
      reader = new Reader();
    } catch (error) {
      reject(error);
      return;
    }
    reader.onload = () => {
      const result = reader.result;
      resolve(typeof result === 'string' ? result : String(result === null || result === undefined ? '' : result));
    };
    reader.onerror = () => reject(new Error('FileReader 读取失败（文件可能已被移动或无权限）。'));
    reader.onabort = () => reject(new Error('文件读取已取消。'));
    try {
      reader.readAsText(file, 'utf-8');
    } catch (error) {
      reject(error);
    }
  });
}

function setReason(message, tone = 'warn') {
  const node = el('degrade-reason');
  if (!node) return;
  node.textContent = message || '';
  node.className = `start-reason tone-${tone}`;
  node.classList.toggle('hidden', !message);
}

async function handleFileList(fileList) {
  const incoming = Array.from(fileList || []);
  if (!incoming.length) return;

  const remaining = Math.max(0, MAX_FILES - entries.length);
  if (!remaining) {
    setReason(`最多支持 ${MAX_FILES} 个文件；请先清空或减少文件数量。`, 'warn');
    return;
  }

  const accepted = incoming.slice(0, remaining);
  const dropped = incoming.length - accepted.length;
  const newEntries = [];
  for (const file of accepted) {
    const entry = {
      id: `f${++fileSequence}`,
      name: file && typeof file.name === 'string' ? file.name : `日志文件 ${fileSequence}`,
      size: file && typeof file.size === 'number' ? file.size : 0,
      status: 'reading',
      text: '',
      error: null,
      parse: null
    };
    entries.push(entry);
    newEntries.push({ entry, file });
  }

  renderFileList();
  renderParseSummary();
  updateAnalyzeState();

  await Promise.all(newEntries.map(async ({ entry, file }) => {
    if (entry.size > MAX_FILE_BYTES) {
      entry.status = 'error';
      entry.error = `文件过大（${formatBytes(entry.size)}），单文件上限 ${formatBytes(MAX_FILE_BYTES)}。`;
      return;
    }
    try {
      const text = await readFileText(file);
      if (typeof text === 'string' && text.length > MAX_FILE_BYTES) {
        entry.status = 'error';
        entry.error = `文件文本过大（${formatBytes(text.length)}），单文件上限 ${formatBytes(MAX_FILE_BYTES)}。`;
        return;
      }
      entry.text = text;
      entry.status = 'ready';
    } catch (error) {
      entry.status = 'error';
      entry.error = error && error.message ? error.message : String(error);
    }
  }));

  if (dropped > 0) {
    setReason(`已忽略 ${dropped} 个文件：最多同时保留 ${MAX_FILES} 个文件。`, 'warn');
  } else {
    setReason('');
  }

  renderFileList();
  await parseAll();
}

/* ------------------------------------------------------------------ *
 * 解析
 * ------------------------------------------------------------------ */

async function parseAll() {
  const token = ++parseToken;
  const readyEntries = entries.filter((entry) => entry.status === 'ready');
  const status = degradeStatusSnapshot || getDegradeStatus();

  if (!readyEntries.length) {
    records = [];
    parseResult = null;
    parseError = null;
    renderFileList();
    renderParseSummary();
    updateAnalyzeState();
    return;
  }

  if (!status.ready) {
    parseResult = null;
    parseError = '降智诊断引擎未就绪：暂时无法解析日志。';
    for (const entry of readyEntries) entry.parse = { error: parseError };
    renderFileList();
    renderParseSummary();
    updateAnalyzeState();
    return;
  }

  const response = await parseLogFilesSafe({
    files: readyEntries.map((entry) => ({ name: entry.name, text: entry.text })),
    limits: { maxFiles: MAX_FILES, maxBytesPerFile: MAX_FILE_BYTES, maxRecords: MAX_RECORDS }
  });

  // 期间用户可能又添加 / 清空了文件：丢弃过期结果。
  if (token !== parseToken) return;

  if (!response.ok) {
    parseResult = null;
    parseError = response.error || '解析失败。';
    for (const entry of readyEntries) entry.parse = { error: parseError };
    records = [];
    renderFileList();
    renderParseSummary();
    updateAnalyzeState();
    return;
  }

  parseError = null;
  parseResult = response.result;
  records = Array.isArray(response.result.records) ? response.result.records : [];
  const fileInfos = Array.isArray(response.result.files) ? response.result.files : [];
  readyEntries.forEach((entry, index) => {
    const byName = fileInfos.find((info) => info && info.name === entry.name);
    entry.parse = byName || fileInfos[index] || null;
  });

  renderFileList();
  renderParseSummary();
  updateAnalyzeState();
}

/* ------------------------------------------------------------------ *
 * 渲染：逐文件解析反馈 / 解析总计
 * ------------------------------------------------------------------ */

function parseCountsText(info) {
  if (!info || typeof info !== 'object') return '';
  const total = Number.isFinite(info.total) ? info.total : null;
  const parsed = Number.isFinite(info.parsed) ? info.parsed : null;
  const skipped = Number.isFinite(info.skipped) ? info.skipped : null;
  const parts = [];
  if (total !== null) parts.push(`总行数 ${total}`);
  if (parsed !== null) parts.push(`解析 ${parsed}`);
  if (skipped !== null) parts.push(`跳过 ${skipped}`);
  return parts.join(' · ');
}

function confidenceText(confidence) {
  if (typeof confidence !== 'number' || !Number.isFinite(confidence)) return '';
  if (confidence >= 0 && confidence <= 1) return `识别置信度 ${formatPercent(confidence)}`;
  return `识别置信度 ${Math.round(confidence)}`;
}

function renderFileList() {
  const container = el('degrade-file-list');
  if (!container) return;
  if (!entries.length) {
    container.replaceChildren();
    return;
  }

  const items = entries.map((entry) => {
    const statusChip = entry.status === 'reading'
      ? chip('读取中…', { tone: 'info' })
      : entry.status === 'error'
        ? chip('读取失败', { tone: 'danger' })
        : entry.parse && entry.parse.error
          ? chip('解析失败', { tone: 'danger' })
          : entry.parse
            ? chip(formatLabel(entry.parse.format), { tone: 'success' })
            : chip('等待解析', { tone: 'plain' });

    const metaParts = [formatBytes(entry.size)];
    const counts = entry.parse ? parseCountsText(entry.parse) : '';
    if (counts) metaParts.push(counts);
    const confidence = entry.parse ? confidenceText(entry.parse.confidence) : '';
    if (confidence) metaParts.push(confidence);

    const errorText = entry.error
      || (entry.parse && entry.parse.error ? String(entry.parse.error) : '');

    return h('li', { class: `degrade-file ${entry.status === 'error' ? 'is-error' : ''}` },
      h('div', { class: 'degrade-file-main' },
        textSpan('degrade-file-name mono', entry.name),
        statusChip
      ),
      h('div', { class: 'degrade-file-meta' }, textSpan('degrade-file-meta-text', metaParts.join(' · '))),
      errorText ? h('p', { class: 'degrade-file-error', text: errorText }) : null
    );
  });

  container.replaceChildren(h('ul', { class: 'degrade-file-items' }, items));
}

function renderParseSummary() {
  const container = el('degrade-parse-summary');
  if (!container) return;

  if (parseError) {
    container.replaceChildren(
      h('p', { class: 'cost-error', text: `解析失败：${parseError}` }),
      h('p', { class: 'hint', text: '请检查文件内容是否为受支持的日志格式；也可以只保留部分文件后重试。' })
    );
    return;
  }

  if (!parseResult) {
    const reading = entries.some((entry) => entry.status === 'reading');
    const ready = entries.some((entry) => entry.status === 'ready');
    if (entries.length && !reading && !ready) {
      container.replaceChildren(
        h('p', { class: 'cost-error', text: '没有可用的日志文件：所有文件都读取失败。' }),
        h('p', { class: 'hint', text: `请检查文件大小（单文件上限 ${formatBytes(MAX_FILE_BYTES)}、最多 ${MAX_FILES} 个文件）或重新选择。` })
      );
      return;
    }
    const formats = getSupportedFormats().map((format) => format.label).join(' / ');
    container.replaceChildren(h('p', { class: 'empty-note', text: entries.length
      ? '正在读取 / 解析日志…'
      : `还没有选择日志文件。支持 ${formats} 等格式，也可直接拖入无扩展名的日志。` }));
    return;
  }

  const stats = parseResult.stats && typeof parseResult.stats === 'object' ? parseResult.stats : {};
  const warnings = Array.isArray(parseResult.warnings) ? parseResult.warnings.filter((item) => typeof item === 'string' && item.trim()) : [];
  const skippedTotal = entries.reduce((sum, entry) => {
    const skipped = entry.parse && Number.isFinite(entry.parse.skipped) ? entry.parse.skipped : 0;
    return sum + skipped;
  }, 0);
  const timeRange = stats.timeRange && typeof stats.timeRange === 'object' ? stats.timeRange : null;
  const models = Array.isArray(stats.models) ? stats.models.filter((model) => typeof model === 'string' && model) : [];

  const nodes = [
    h('div', { class: 'stat-grid degrade-parse-stats' },
      statCard('解析记录', String(records.length), `来自 ${entries.filter((entry) => entry.status === 'ready').length} 个文件`),
      statCard('跳过行数', String(skippedTotal), '无法解析或空行'),
      statCard('时间范围', timeRange ? `${formatDateTime(timeRange.from)} → ${formatDateTime(timeRange.to)}` : '—', '无时间戳记录不参与前后期切分'),
      statCard('涉及模型', models.length ? models.slice(0, 4).join('、') : '—', models.length > 4 ? `共 ${models.length} 个模型` : '来自日志中的 model 字段')
    )
  ];

  if (warnings.length) {
    nodes.push(h('ul', { class: 'hint-list degrade-warnings' }, warnings.map((text) => h('li', { text }))));
  }

  container.replaceChildren(h('div', { class: 'degrade-parse-box' }, nodes));
}

/* ------------------------------------------------------------------ *
 * 分析 / 清空
 * ------------------------------------------------------------------ */

function updateDegradeStatus() {
  const status = degradeStatusSnapshot || getDegradeStatus();
  const node = el('degrade-status');
  if (!node) return;
  if (status.ready) {
    node.textContent = '降智诊断引擎已就绪 · 纯本地解析（零网络请求）';
    node.className = 'chip chip-success';
    node.title = '';
  } else if (status.loading) {
    node.textContent = '正在加载降智诊断引擎…';
    node.className = 'chip chip-plain';
    node.title = '';
  } else {
    node.textContent = '降智诊断引擎未就绪（暂时无法解析日志）';
    node.className = 'chip chip-warn';
    node.title = status.error ? describeDegradeError(status.error) : '';
  }
}

function updateAnalyzeState() {
  const button = el('degrade-analyze-btn');
  const status = degradeStatusSnapshot || getDegradeStatus();
  const readyCount = entries.filter((entry) => entry.status === 'ready').length;
  const readingCount = entries.filter((entry) => entry.status === 'reading').length;

  let disabled = false;
  let reason = '';
  let tone = 'warn';

  if (analyzing) {
    disabled = true;
    reason = '正在本地分析日志…';
    tone = 'info';
  } else if (!status.ready) {
    disabled = true;
    reason = '降智诊断引擎未就绪：连接方式 / 上游真伪检测不受影响；引擎就绪后即可分析日志。';
    tone = 'warn';
  } else if (!entries.length) {
    disabled = true;
    reason = '请先拖入或选择日志文件（支持 .jsonl / .json / .csv / .tsv / .log / 无扩展名；格式按内容自动识别）。';
    tone = 'warn';
  } else if (readingCount > 0 && !readyCount) {
    disabled = true;
    reason = '正在读取文件…';
    tone = 'info';
  } else if (!readyCount) {
    disabled = true;
    reason = '没有可用的日志文件（读取失败）。请检查文件后重试。';
    tone = 'warn';
  } else if (!records.length) {
    disabled = true;
    reason = parseError ? `解析失败：${parseError}` : '解析后没有任何有效记录：请检查文件内容或格式。';
    tone = 'warn';
  }

  if (button) {
    button.disabled = disabled;
    button.textContent = analyzing ? '分析中…' : '开始分析';
    if (reason) button.title = reason;
    else button.removeAttribute('title');
  }
  if (!analyzing) setReason(reason, tone);
}

async function analyze() {
  if (analyzing) return;
  const status = degradeStatusSnapshot || getDegradeStatus();
  const resultEl = el('degrade-result');
  const button = el('degrade-analyze-btn');

  if (!status.ready) {
    renderDegradeError(resultEl, '降智诊断引擎模块（src/core/degrade/index.js）尚未就绪，暂时无法分析日志。页面其余功能不受影响。', {
      title: '降智诊断引擎未就绪',
      hints: [
        '日志仍然只在你的浏览器内存中，不会上传到任何地方。',
        '引擎就绪后重新点击「开始分析」即可；也可以先使用页面上方的连接方式 / 上游真伪检测。'
      ]
    });
    setReason('降智诊断引擎未就绪。', 'warn');
    return;
  }

  if (!records.length) {
    renderDegradeEmpty(resultEl, '还没有解析到任何记录：请先添加日志文件并等待解析完成。');
    setReason('还没有可分析的记录。', 'warn');
    return;
  }

  analyzing = true;
  updateAnalyzeState();
  renderDegradeLoading(resultEl, { records: records.length });
  await new Promise((resolve) => setTimeout(resolve, 0));

  const response = await analyzeDegradationSafe({
    records,
    options: {
      minRecords: DEFAULT_MIN_RECORDS,
      minSpanMs: DEFAULT_MIN_SPAN_MS,
      segment: 'auto'
    }
  });

  analyzing = false;
  updateAnalyzeState();

  if (!response.ok) {
    renderDegradeError(resultEl, `降智诊断未能完成：${response.error}`, {
      title: '分析失败',
      hints: [
        '这通常是日志内容缺失关键字段（时间戳 / token 用量）导致的，可以换一份更完整的日志重试。',
        '单文件解析失败不会影响其它文件；页面其余功能不受影响。'
      ]
    });
    return;
  }

  report = response.result;
  renderDegradeReport(resultEl, report);
  setReason('分析完成：结果只基于你本机的日志，不会上传。', 'success');
}

function clearLogs() {
  const input = el('degrade-file-input');
  if (input) {
    try {
      input.value = '';
    } catch {
      // 忽略
    }
  }
  // 丢弃内存中的文件文本、解析记录与报告（不写任何存储）。
  for (const entry of entries) {
    entry.text = '';
  }
  entries = [];
  records = [];
  parseResult = null;
  parseError = null;
  report = null;
  analyzing = false;
  parseToken += 1;

  renderFileList();
  renderParseSummary();
  updateAnalyzeState();
  const resultEl = el('degrade-result');
  if (resultEl) {
    renderDegradeEmpty(resultEl, '日志已从内存中清空：文件文本、解析结果与诊断报告均已丢弃，不会上传也不会落盘。');
  }
  setReason('已清空内存中的日志文本、解析结果与诊断报告。', 'success');
}

/* ------------------------------------------------------------------ *
 * 初始化
 * ------------------------------------------------------------------ */

function initDropzone() {
  const zone = el('degrade-dropzone');
  const input = el('degrade-file-input');
  if (!zone || !input) return;

  zone.addEventListener('click', () => {
    input.click();
  });
  zone.addEventListener('keydown', (event) => {
    if (event.key === 'Enter' || event.key === ' ' || event.key === 'Spacebar') {
      event.preventDefault();
      input.click();
    }
  });
  input.addEventListener('change', () => {
    handleFileList(input.files);
    try {
      input.value = '';
    } catch {
      // 忽略
    }
  });

  for (const type of ['dragenter', 'dragover']) {
    zone.addEventListener(type, (event) => {
      event.preventDefault();
      if (event.dataTransfer) event.dataTransfer.dropEffect = 'copy';
      zone.classList.add('is-dragover');
    });
  }
  for (const type of ['dragleave', 'dragend']) {
    zone.addEventListener(type, () => zone.classList.remove('is-dragover'));
  }
  zone.addEventListener('drop', (event) => {
    event.preventDefault();
    zone.classList.remove('is-dragover');
    const transfer = event.dataTransfer;
    if (transfer && transfer.files) handleFileList(transfer.files);
  });
}

function initButtons() {
  const analyzeButton = el('degrade-analyze-btn');
  const clearButton = el('degrade-clear-btn');
  if (analyzeButton) analyzeButton.addEventListener('click', () => { analyze(); });
  // 「一键清空」：不做二次确认，立刻丢弃内存中的日志文本、解析结果与报告（契约 §9.4）。
  if (clearButton) clearButton.addEventListener('click', () => { clearLogs(); });
}

/**
 * 初始化降智诊断区块。由 app.js 在页面初始化时调用。
 * 即使核心模块缺失 / 有语法错，本函数也不会抛异常。
 */
export function initDegrade() {
  const panel = el('degrade-panel');
  if (!panel) return;

  initViewTabs();
  initDropzone();
  initButtons();

  const resultEl = el('degrade-result');
  renderDegradeEmpty(resultEl, '拖入或选择日志文件后点击「开始分析」。所有解析与统计都在你的浏览器内存中完成。');
  renderFileList();
  renderParseSummary();
  updateDegradeStatus();
  updateAnalyzeState();

  loadDegradeModule().then((result) => {
    degradeStatusSnapshot = getDegradeStatus();
    updateDegradeStatus();
    updateAnalyzeState();
    if (result.ok && entries.some((entry) => entry.status === 'ready')) {
      parseAll();
    }
  });
}
