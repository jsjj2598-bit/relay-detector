/**
 * src/ui/components.js —— 可复用小组件（原生 DOM，无框架、无构建步骤）。
 *
 * 设计约束：
 * - 只读 src/core 的冻结模块（constants.js / score.js），绝不 import 规则目录或任何 provider 实现。
 * - 所有外部数据（evidence、探测正文、错误消息、目标返回内容）一律通过 textContent 写入，
 *   不使用内联字符串拼 HTML，避免被检测端点返回的内容造成 XSS。
 * - 百分比展示统一走 formatPercent()，上限 99%，避免任何暗示确定性的满值措辞。
 */

import { CATEGORY_LABELS } from '../core/constants.js';
import { VERDICT_LABELS, VERDICT_TONES, contributionOf } from '../core/score.js';

const SVG_NS = 'http://www.w3.org/2000/svg';

/** 信号方向的中文说明（relay = 指向中转，official = 指向官方，neutral = 中性）。 */
export const DIRECTION_LABELS = {
  relay: '指向中转',
  official: '指向官方',
  neutral: '中性证据'
};

/** 判定 → 视觉色调（与 score.js 的 VERDICT_TONES 对齐）。 */
export function toneOfVerdict(verdict) {
  return VERDICT_TONES[verdict] || 'neutral';
}

/** 数值兜底：非有限数一律当作缺省值。 */
export function num(v, fallback = 0) {
  return typeof v === 'number' && Number.isFinite(v) ? v : fallback;
}

export function clamp(v, lo, hi) {
  return Math.min(hi, Math.max(lo, v));
}

/**
 * 把 0..1 的比例格式化成百分数文本。
 * 上限固定为 99%：本项目不允许出现任何暗示「确定性」的满值措辞。
 */
export function formatPercent(value01) {
  const v = clamp(num(value01, 0), 0, 1);
  return `${Math.min(99, Math.round(v * 100))}%`;
}

/** 安全序列化任意可序列化值（循环引用、函数等一律降级为 String）。 */
export function stringify(value) {
  if (value === undefined) return '(无)';
  if (value === null) return 'null';
  try {
    const text = JSON.stringify(value, null, 2);
    return text === undefined ? String(value) : text;
  } catch {
    try {
      return String(value);
    } catch {
      return '(无法序列化)';
    }
  }
}

/** 创建元素：h('div', {class:'x', text:'你好', onclick:fn}, child1, child2)。 */
export function h(tag, attrs, ...children) {
  const node = document.createElement(tag);
  if (attrs && typeof attrs === 'object') {
    for (const [key, value] of Object.entries(attrs)) {
      if (value === null || value === undefined || value === false) continue;
      if (key === 'class') node.className = String(value);
      else if (key === 'text') node.textContent = String(value);
      else if (key === 'dataset') Object.assign(node.dataset, value);
      else if (key === 'style' && value && typeof value === 'object') Object.assign(node.style, value);
      else if (key.startsWith('on') && typeof value === 'function') {
        node.addEventListener(key.slice(2).toLowerCase(), value);
      } else if (value === true) node.setAttribute(key, '');
      else node.setAttribute(key, String(value));
    }
  }
  appendChildren(node, children);
  return node;
}

/** 创建 SVG 元素（与 h 同风格，但走 SVG 命名空间）。 */
function svgEl(tag, attrs, ...children) {
  const node = document.createElementNS(SVG_NS, tag);
  if (attrs && typeof attrs === 'object') {
    for (const [key, value] of Object.entries(attrs)) {
      if (value === null || value === undefined || value === false) continue;
      node.setAttribute(key, String(value));
    }
  }
  appendChildren(node, children);
  return node;
}

function appendChildren(node, children) {
  for (const child of children.flat(Infinity)) {
    if (child === null || child === undefined || child === false) continue;
    node.append(child instanceof Node ? child : document.createTextNode(String(child)));
  }
}

/** 小标签 / 胶囊。 */
export function chip(text, opts = {}) {
  const { tone = 'plain', mono = false, title = null } = opts;
  return h('span', {
    class: `chip chip-${tone}${mono ? ' mono' : ''}`,
    title: title || undefined,
    text: String(text)
  });
}

/** 数据键值表。rows: [[label, value], ...]，value 可以是字符串或 Node。 */
export function kvTable(rows, opts = {}) {
  const { caption = null } = opts;
  const table = h('table', { class: 'kv-table' },
    h('tbody', {}, rows
      .filter((row) => Array.isArray(row) && row.length >= 2)
      .map(([label, value]) => h('tr', {},
        h('th', { scope: 'row', text: String(label) }),
        h('td', {}, value instanceof Node ? value : h('span', { text: value === null || value === undefined || value === '' ? '—' : String(value) }))
      )))
  );
  if (!caption) return table;
  return h('div', { class: 'kv-wrap' }, h('p', { class: 'kv-caption', text: caption }), table);
}

/** 代码 / 原文块，可选复制按钮。 */
export function codeBlock(text, opts = {}) {
  const { maxHeight = null, copy = true, label = '原文' } = opts;
  const content = text === null || text === undefined || text === '' ? '(空)' : String(text);
  const pre = h('pre', { class: 'code-pre', tabindex: '0', 'aria-label': label, text: content });
  if (maxHeight) pre.style.maxHeight = maxHeight;
  const children = [];
  if (copy) children.push(h('div', { class: 'code-bar no-print' }, copyButton(content, { label: '复制' })));
  children.push(pre);
  return h('div', { class: 'code-block' }, children);
}

/** 折叠面板：detailsBlock('标题', child1, child2)。 */
export function detailsBlock(summaryText, ...children) {
  return h('details', { class: 'collapse' },
    h('summary', {}, h('span', { class: 'collapse-title', text: String(summaryText) })),
    h('div', { class: 'collapse-body' }, children)
  );
}

/**
 * 复制按钮。getText 可以是字符串，也可以是返回字符串 / Promise<string> 的函数。
 * 剪贴板不可用时（file:// 或旧浏览器）降级为 execCommand，仍失败则提示手动选择。
 */
export function copyButton(getText, opts = {}) {
  const { label = '复制', doneText = '已复制', failText = '复制失败，请手动选择', class: extraClass = '' } = opts;
  const btn = h('button', {
    type: 'button',
    class: `btn btn-ghost btn-sm ${extraClass}`.trim()
  }, label);

  let timer = null;
  const flash = (message, back) => {
    btn.textContent = message;
    btn.disabled = true;
    if (timer) clearTimeout(timer);
    timer = setTimeout(() => {
      btn.textContent = back;
      btn.disabled = false;
    }, 1600);
  };

  btn.addEventListener('click', async () => {
    let text = '';
    try {
      text = typeof getText === 'function' ? await getText() : String(getText ?? '');
    } catch {
      text = '';
    }
    const ok = await writeClipboard(text);
    if (ok) flash(doneText, label);
    else flash(failText, label);
  });

  return btn;
}

/** 尝试写剪贴板，返回是否成功。 */
export async function writeClipboard(text) {
  const value = String(text ?? '');
  try {
    if (navigator.clipboard && navigator.clipboard.writeText) {
      await navigator.clipboard.writeText(value);
      return true;
    }
  } catch {
    // 继续走降级方案（非安全上下文 / 权限被拒）
  }
  try {
    const area = document.createElement('textarea');
    area.value = value;
    area.setAttribute('readonly', '');
    area.setAttribute('aria-hidden', 'true');
    area.style.position = 'fixed';
    area.style.top = '-1000px';
    area.style.opacity = '0';
    document.body.append(area);
    area.select();
    const ok = document.execCommand ? document.execCommand('copy') : false;
    area.remove();
    return Boolean(ok);
  } catch {
    return false;
  }
}

/** 判定徽章（大号 / 中号 / 小号）。 */
export function verdictBadge(verdict, opts = {}) {
  const { size = 'md' } = opts;
  const tone = toneOfVerdict(verdict);
  const label = VERDICT_LABELS[verdict] || VERDICT_LABELS.inconclusive;
  return h('span', {
    class: `verdict-badge tone-${tone} size-${size}`,
    role: 'status',
    'aria-label': `判定结果：${label}`
  },
    h('span', { class: 'verdict-dot', 'aria-hidden': 'true' }),
    h('span', { class: 'verdict-text', text: label })
  );
}

/** 分数决定环的颜色语境。 */
function ringTone(score) {
  const s = num(score, 0);
  if (s >= 70) return 'danger';
  if (s >= 58) return 'warn';
  if (s >= 42) return 'neutral';
  if (s >= 30) return 'info';
  return 'success';
}

/**
 * 评分环：中间数字为 score（越高越像中转站）。
 * 注意：score 是「方向性证据的比例」，不等于确定性。
 */
export function scoreRing(score, opts = {}) {
  const { size = 152, stroke = 13, evidenceStrength = 0 } = opts;
  const value = clamp(num(score, 0), 0, 100);
  const ratio = value / 100;
  const radius = (size - stroke) / 2;
  const circumference = 2 * Math.PI * radius;
  const dash = (circumference * ratio).toFixed(2);
  const rest = circumference.toFixed(2);

  const svg = svgEl('svg', {
    viewBox: `0 0 ${size} ${size}`,
    width: size,
    height: size,
    role: 'img',
    'aria-label': `中转倾向指数 ${value} / 100，证据强度 ${formatPercent(evidenceStrength)}`
  },
    svgEl('circle', {
      cx: size / 2, cy: size / 2, r: radius, fill: 'none',
      class: 'ring-track', 'stroke-width': stroke
    }),
    svgEl('circle', {
      cx: size / 2, cy: size / 2, r: radius, fill: 'none',
      class: 'ring-value', 'stroke-width': stroke, 'stroke-linecap': 'round',
      'stroke-dasharray': `${dash} ${rest}`,
      transform: `rotate(-90 ${size / 2} ${size / 2})`
    })
  );

  return h('div', { class: `score-ring tone-${ringTone(value)}` },
    svg,
    h('div', { class: 'ring-center' },
      h('div', { class: 'ring-number', text: String(value) }),
      h('div', { class: 'ring-unit', text: '/ 100' })
    ),
    h('p', { class: 'ring-caption', text: '中转倾向指数' })
  );
}

/** 进度条（用于证据强度等 0..1 或 0..max 的量）。 */
export function meter(label, displayValue, ratio, opts = {}) {
  const { tone = 'neutral', hint = null } = opts;
  const width = `${(clamp(num(ratio, 0), 0, 1) * 100).toFixed(1)}%`;
  return h('div', { class: 'meter' },
    h('div', { class: 'meter-head' },
      h('span', { class: 'meter-label', text: String(label) }),
      h('span', { class: 'meter-value', text: String(displayValue) })
    ),
    h('div', {
      class: 'meter-track',
      role: 'progressbar',
      'aria-label': String(label),
      'aria-valuenow': String(displayValue),
      'aria-valuemin': '0',
      'aria-valuemax': '100'
    }, h('div', { class: `meter-fill tone-${tone}`, style: { width } })),
    hint ? h('p', { class: 'meter-hint', text: String(hint) }) : null
  );
}

/** 摘要数字卡。 */
export function statCard(label, value, hint) {
  return h('div', { class: 'stat-card' },
    h('div', { class: 'stat-label', text: String(label) }),
    h('div', { class: 'stat-value', text: String(value) }),
    hint ? h('div', { class: 'stat-hint', text: String(hint) }) : null
  );
}

/**
 * 单条信号卡片。
 * 契约 1.3：必须展示 weight / confidence / evidence 原文。
 */
export function signalCard(signal) {
  const s = signal && typeof signal === 'object' ? signal : {};
  const verdict = s.verdict === 'relay' || s.verdict === 'official' ? s.verdict : 'neutral';
  const tone = verdict === 'relay' ? 'danger' : verdict === 'official' ? 'success' : 'neutral';
  const contribution = contributionOf(s);
  const categoryLabel = CATEGORY_LABELS[s.category] || s.category || '未分类';

  return h('article', { class: `signal-card tone-${tone}` },
    h('div', { class: 'signal-head' },
      h('h4', { class: 'signal-title', text: String(s.title || s.id || '未命名特征') }),
      chip(DIRECTION_LABELS[verdict], { tone })
    ),
    s.detail ? h('p', { class: 'signal-detail', text: String(s.detail) }) : null,
    h('div', { class: 'chip-row' },
      chip(`权重 ${num(s.weight, 0)}`, { title: 'weight：该特征成立时的指示强度，0–100。' }),
      chip(`置信度 ${formatPercent(num(s.confidence, 0))}`, {
        title: 'confidence：该特征被正确观测或解读的可信度，0–1。注意它不是结论的确定性。'
      }),
      chip(`贡献值 ${contribution.toFixed(1)}`, {
        title: '贡献值 = weight × confidence × 类别权重，由冻结的 score.js 计算。'
      }),
      chip(categoryLabel, { tone: 'plain' }),
      chip(String(s.id || '—'), { mono: true, title: '规则 id（命名空间.规则名）' })
    ),
    h('div', { class: 'signal-evidence' },
      h('div', { class: 'signal-evidence-head', text: '证据原文（原样展示，未做改写）' }),
      codeBlock(stringify(s.evidence), { maxHeight: '12rem', label: '证据原文' })
    ),
    s.source ? h('p', { class: 'signal-source', text: `规则来源：${String(s.source)}` }) : null
  );
}
