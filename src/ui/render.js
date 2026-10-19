/**
 * src/ui/render.js —— 报告渲染。
 *
 * 对外接口（契约 2.6）：
 *   renderReport(container, report)   // report 为 engine.detect() 的 DetectionReport
 *   renderError(container, message)   // 错误态，绝不抛异常
 *
 * 另外导出空态 / 加载态 / 纯文本摘要，供 app.js 的状态机使用。
 *
 * 渲染原则：
 * - 报告必须**显式呈现不确定性**：展示 score 的同时展示 evidenceStrength，
 *   每条信号展示 weight / confidence / evidence 原文，并给出「不是确定性结论」的说明。
 * - 不出现任何暗示确定性的满值措辞；百分数上限 99%（见 components.formatPercent）。
 * - 所有来自外部的文本走 textContent，不拼 HTML。
 */

import { CATEGORY_LABELS, PROVIDER_LABELS, CALIBRATION, VERSION } from '../core/constants.js';
import {
  VERDICT_LABELS,
  VERDICT_TONES,
  contributionOf,
  sortSignalsByContribution,
  CATEGORY_WEIGHTS
} from '../core/score.js';
import {
  h,
  chip,
  kvTable,
  codeBlock,
  copyButton,
  detailsBlock,
  verdictBadge,
  scoreRing,
  meter,
  statCard,
  signalCard,
  formatPercent,
  stringify,
  num,
  clamp
} from './components.js';
import {
  normalizeAuthenticity,
  renderAuthenticityCard,
  authenticityToText
} from './authenticity.js';
import { interpretAxes, depthRunsAuth, depthLabel } from './form-state.js';

/** 类别展示顺序（信号分组）。 */
export const CATEGORY_ORDER = ['url', 'tls', 'headers', 'error', 'models', 'payload', 'behavior', 'signature', 'other'];

/** 判定 → 色调兜底。 */
function toneOf(verdict) {
  return VERDICT_TONES[verdict] || 'neutral';
}

/** 把 engine 的返回值归一化，任何字段缺失都不影响渲染。 */
export function normalizeReport(report) {
  const r = report && typeof report === 'object' ? report : {};
  const target = r.target && typeof r.target === 'object' ? r.target : {};
  const score = clamp(num(r.score, 0), 0, 100);
  const evidenceStrength = clamp(num(r.evidenceStrength, 0), 0, 1);
  const verdict = Object.prototype.hasOwnProperty.call(VERDICT_LABELS, r.verdict) ? r.verdict : 'inconclusive';
  const signals = Array.isArray(r.signals) ? r.signals.filter((s) => s && typeof s === 'object') : [];

  return {
    schema: num(r.schema, 1),
    /**
     * 轴 1 是否可用：v2 的「真伪」档位只跑 v2，会在报告里显式写 `connection: null`，
     * 此时连接轴整体显示为「未检测」，绝不伪造 v1 分数。
     */
    connectionAvailable: r.connection !== null,
    /** 轴 2：report.authenticity。缺失 / null 时按「未执行真伪检测」渲染（向后兼容）。 */
    authenticity: normalizeAuthenticity(r.authenticity),
    target: {
      input: typeof target.input === 'string' ? target.input : '',
      baseUrl: typeof target.baseUrl === 'string' ? target.baseUrl : '',
      host: typeof target.host === 'string' ? target.host : '',
      provider: typeof target.provider === 'string' ? target.provider : '',
      providerSource: typeof target.providerSource === 'string' ? target.providerSource : '',
      matchedOfficialHost: typeof target.matchedOfficialHost === 'string' ? target.matchedOfficialHost : null
    },
    mode: r.mode === 'proxy' ? 'proxy' : 'browser',
    score,
    officialScore: clamp(num(r.officialScore, 100 - score), 0, 100),
    evidenceStrength,
    verdict,
    signals,
    byCategory: r.byCategory && typeof r.byCategory === 'object' ? r.byCategory : {},
    probes: Array.isArray(r.probes) ? r.probes.filter((p) => p && typeof p === 'object') : [],
    capabilities: r.capabilities && typeof r.capabilities === 'object' ? r.capabilities : {},
    /** flags 不在契约 1.4 的强制字段中：engine 透传时才有，必须防御性读取。 */
    flags: r.flags && typeof r.flags === 'object'
      ? {
          hasDirectionalEvidence: Boolean(r.flags.hasDirectionalEvidence),
          urlIdentityConfirmed: Boolean(r.flags.urlIdentityConfirmed),
          officialDowngraded: Boolean(r.flags.officialDowngraded),
          upstreamLooksGenuine: Boolean(r.flags.upstreamLooksGenuine)
        }
      : null,
    notes: Array.isArray(r.notes) ? r.notes.filter((n) => typeof n === 'string' && n.trim()) : [],
    startedAt: num(r.startedAt, 0),
    finishedAt: num(r.finishedAt, 0),
    durationMs: num(r.durationMs, 0)
  };
}

/** 时长格式化。 */
function formatDuration(ms) {
  const value = num(ms, 0);
  if (value < 1000) return `${value} ms`;
  return `${(value / 1000).toFixed(1)} 秒`;
}

/** 时间戳格式化（本地时间，失败则显示 —）。 */
function formatTime(ts) {
  const value = num(ts, 0);
  if (!value) return '—';
  try {
    return new Date(value).toLocaleString('zh-CN', { hour12: false });
  } catch {
    return '—';
  }
}

/* ------------------------------------------------------------------ *
 * 状态视图：空态 / 加载态 / 错误态
 * ------------------------------------------------------------------ */

export function renderEmpty(container, message = '填写上方表单后点击「开始检测」。') {
  if (!container) return;
  container.replaceChildren(
    h('div', { class: 'state-card empty-state' },
      h('div', { class: 'state-icon', 'aria-hidden': 'true', text: '🧭' }),
      h('h3', { class: 'state-title', text: '等待检测' }),
      h('p', { class: 'state-text', text: message })
    )
  );
}

export function renderLoading(container, info = {}) {
  if (!container) return;
  const target = typeof info.baseUrl === 'string' ? info.baseUrl : '';
  const depth = typeof info.depth === 'string' ? info.depth : 'fingerprint';
  const runsAuth = depthRunsAuth(depth);
  const requests = num(info.authRequests, 0);

  const hints = runsAuth
    ? [
        `检测深度：${depthLabel(depth)}。真伪检测会串行发送约 ${requests > 0 ? requests : '十来个'} 个真实请求，可能产生费用，请留意目标账户账单。`,
        '真伪检测可能持续数十秒；「检测无效」与「未达标」会在报告中完全分开呈现。'
      ]
    : [
        '本档位只发出只读探测（模型列表 / 必然失败的鉴权探测），不会发送可能计费的对话请求。',
        '若目标不允许跨域，探测可能被 CORS 拦截，这不代表目标不可用。'
      ];

  container.replaceChildren(
    h('div', { class: 'state-card loading-state' },
      h('div', { class: 'spinner', 'aria-hidden': 'true' }),
      h('h3', { class: 'state-title', text: runsAuth ? '正在探测（含真伪检测，需要一点时间）…' : '正在探测…' }),
      h('p', { class: 'state-text', text: target ? `目标：${target}` : '正在读取目标端点的公开特征。' }),
      h('ul', { class: 'hint-list' }, hints.map((text) => h('li', { text })))
    )
  );
}

/**
 * 错误态。绝不抛异常，且文案友好（断网 / CORS / 引擎未就绪均有对应提示）。
 * @param {Element} container
 * @param {string} message 主要错误说明
 * @param {{title?:string, detail?:string, retry?:Function, hints?:string[]}} [opts]
 */
export function renderError(container, message, opts = {}) {
  if (!container) return;
  const {
    title = '检测未能完成',
    detail = '',
    retry = null,
    hints = [
      '本地网络不可达、或目标站点拒绝了跨域请求（CORS）时，浏览器直连会失败。',
      '可在「高级选项」切换到「本地代理」模式，由代理代替浏览器发起请求。',
      '引擎模块尚未就绪时，页面本身仍然可用；稍后重试即可。'
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
  if (typeof retry === 'function') {
    nodes.push(h('div', { class: 'state-actions no-print' },
      h('button', { type: 'button', class: 'btn btn-primary', onclick: retry }, '重试')
    ));
  }

  container.replaceChildren(h('div', { class: 'state-card error-state', role: 'alert' }, nodes));
}

/* ------------------------------------------------------------------ *
 * 报告主体
 * ------------------------------------------------------------------ */

/** 按类别汇总信号贡献值。 */
function contributionTotals(signals) {
  let relay = 0;
  let official = 0;
  let neutral = 0;
  for (const s of signals) {
    const pts = contributionOf(s);
    if (s.verdict === 'relay') relay += pts;
    else if (s.verdict === 'official') official += pts;
    else neutral += pts;
  }
  return { relay, official, neutral, total: relay + official + neutral };
}

/** 把信号按类别分组（以 report.signals 为准；缺失时回退到 byCategory）。 */
function groupSignals(report) {
  const source = report.signals.length
    ? report.signals
    : Object.values(report.byCategory).flat().filter((s) => s && typeof s === 'object');
  const sorted = sortSignalsByContribution(source);
  const groups = new Map();
  for (const signal of sorted) {
    const cat = typeof signal.category === 'string' && signal.category ? signal.category : 'other';
    if (!groups.has(cat)) groups.set(cat, []);
    groups.get(cat).push(signal);
  }
  const known = CATEGORY_ORDER.filter((c) => groups.has(c));
  const extra = [...groups.keys()].filter((c) => !CATEGORY_ORDER.includes(c)).sort();
  return [...known, ...extra].map((cat) => ({ category: cat, signals: groups.get(cat) }));
}

/**
 * flags 提示条（flags 不在契约 1.4 强制字段中，engine 透传 scoreSignals 结果时才有）。
 *
 * 最重要的场景：officialDowngraded + upstreamLooksGenuine ——
 * 响应头 / 错误报文确实像真实官方实现，但域名不是官方端点：
 * 上游是真的，但用户并非直连，很可能正在经中转 / 反代访问。
 */
function renderFlagsNotice(flags) {
  if (!flags || typeof flags !== 'object') return null;

  if (flags.officialDowngraded && flags.upstreamLooksGenuine) {
    return h('section', { class: 'flags-notice tone-warn' },
      h('h3', { class: 'flags-title', text: '⚠️ 上游是真的，但你并非直连' }),
      h('p', { class: 'flags-text', text: '响应头与错误报文看起来确实来自真实官方实现，但请求的域名不是官方端点 —— 说明上游是真的，但你并非直连，很可能正在经由中转 / 反向代理访问。' }),
      h('p', { class: 'flags-hint', text: '官方响应头在反向代理下会被原样透传，因此「响应头像官方」不能证明直连；本项目以域名身份作为直连的核心依据。' })
    );
  }

  if (flags.officialDowngraded) {
    return h('section', { class: 'flags-notice tone-info' },
      h('h3', { class: 'flags-title', text: 'ℹ️ 缺少域名身份证据' }),
      h('p', { class: 'flags-text', text: '响应里有一些官方风格的痕迹，但请求的域名不是官方端点，且缺少足够的域名身份证据，因此无法确认是否为官方直连。' }),
      h('p', { class: 'flags-hint', text: '不要仅凭响应头下结论：官方响应头在反向代理下会被原样透传。' })
    );
  }

  return null;
}

/** 判定摘要区。 */
function renderSummary(report) {  const total = contributionTotals(report.signals);
  const caps = report.capabilities || {};

  const head = h('div', { class: 'report-head' },
    h('div', { class: 'verdict-hero' },
      verdictBadge(report.verdict, { size: 'lg' }),
      h('p', { class: 'verdict-note', text: '这是基于可观测特征的概率性判断，不是确定性结论，也不能作为交易或安全决策的唯一依据。' })
    ),
    scoreRing(report.score, { evidenceStrength: report.evidenceStrength })
  );

  const stats = h('div', { class: 'stat-grid' },
    statCard('score（中转倾向）', `${report.score} / 100`, '越高越像第三方中转站'),
    statCard('officialScore（官方倾向）', `${report.officialScore} / 100`, '与 score 互补'),
    statCard('evidenceStrength（证据强度）', formatPercent(report.evidenceStrength), '低于 40% 时直接判为「无法判定」'),
    statCard('信号数量', String(report.signals.length), '每条信号都带 weight / confidence / 证据'),
    statCard('耗时', formatDuration(report.durationMs), `开始：${formatTime(report.startedAt)}`)
  );

  const strengthTone = report.evidenceStrength < 0.4 ? 'warn' : report.evidenceStrength < 0.7 ? 'info' : 'success';
  const meters = h('div', { class: 'meter-grid' },
    meter('证据强度 evidenceStrength', formatPercent(report.evidenceStrength), report.evidenceStrength, {
      tone: strengthTone,
      hint: '由所有信号的 weight × confidence （乘类别权重）汇总而成；neutral 信号只按 30% 计入。证据强度低意味着特征太少或太弱，此时无论 score 多少都判为「无法判定」。'
    }),
    meter('方向性贡献占比', formatPercent(report.score / 100), report.score / 100, {
      tone: toneOf(report.verdict),
      hint: 'relay 贡献 /（relay 贡献 + official 贡献）。完全没有方向性证据时该值为 0，并配合低证据强度判为「无法判定」。'
    })
  );

  const target = report.target;
  const targetTable = kvTable([
    ['原始输入', target.input],
    ['规范化基址', target.baseUrl],
    ['主机名', target.host],
    ['协议族', PROVIDER_LABELS[target.provider] || target.provider || '—'],
    ['协议来源', target.providerSource === 'explicit' ? '用户显式指定' : target.providerSource === 'auto' ? '自动识别' : '—'],
    ['命中官方主机', target.matchedOfficialHost || '未命中官方白名单'],
    ['检测模式', report.mode === 'proxy' ? '本地代理（可读真实响应头与 TLS）' : '浏览器直连（受 CORS 限制）'],
    ['开始时间', formatTime(report.startedAt)],
    ['报告版本', `schema ${report.schema} · 项目版本 ${VERSION}`]
  ], { caption: '检测目标' });

  const contributionTable = kvTable([
    ['relay 方向贡献', total.relay.toFixed(2)],
    ['official 方向贡献', total.official.toFixed(2)],
    ['neutral 中性贡献', total.neutral.toFixed(2)],
    ['合计', total.total.toFixed(2)]
  ], { caption: '贡献值汇总（weight × confidence × 类别权重）' });

  const capsule = h('div', { class: 'caps-row' },
    capChip('响应头可读', caps.canReadHeaders, '浏览器模式也可能因 CORS 只看到部分响应头'),
    capChip('TLS 证书可读', caps.tlsAvailable, '仅本地代理模式为真'),
    capChip('存在 CORS 拦截', caps.corsBlocked, '被拦截不代表端点异常'),
    capChip('网络可达', caps.networkReachable, '至少一条探测拿到了响应'),
    capChip('产生了计费请求', caps.costIncurred, '默认关闭付费探测时应为否', caps.costIncurred ? 'danger' : 'success')
  );

  const uncertainty = h('section', { class: 'uncertainty' },
    h('h3', { class: 'uncertainty-title', text: '⚠️ 不确定性与误判声明' }),
    h('ul', { class: 'uncertainty-list' },
      h('li', { text: '本报告是概率性判断：score 与 evidenceStrength 都来自可观测特征，特征可能被目标伪造、隐藏或受网络环境影响。' }),
      h('li', { text: '「Cloudflare / CDN / 公共 CA 证书 / 非官方域名」均为中性证据，不能单独作为中转站依据。实测校准：api.anthropic.com 官方端点本身就位于 Cloudflare 之后，且证书由 Google Trust Services 签发。' }),
      h('li', { text: '浏览器模式受 CORS 限制：无法读取全部响应头、无法读取 TLS 证书，且拿不到真实网络层信息，因此证据强度通常偏低。' }),
      h('li', { text: '证据强度不足时（低于 40%），无论分数如何都会显示「证据不足 / 无法判定」；这是刻意的保守设计，避免误伤官方直连。' }),
      h('li', { text: '请在任何重要决策前，用官方文档、账单主体与本地代理模式的完整结果进行交叉验证。' })
    ),
    h('p', { class: 'calibration-note', text: `校准事实采集于 ${CALIBRATION.measuredAt}，方法：${CALIBRATION.method}。` })
  );

  const notes = report.notes.length
    ? h('section', { class: 'notes' },
        h('h3', { class: 'section-title', text: '检测过程说明' }),
        h('ul', { class: 'notes-list' }, report.notes.map((text) => h('li', { text })))
      )
    : null;

  const flagsNotice = renderFlagsNotice(report.flags);

  return h('div', { class: 'report-summary' },
    head, flagsNotice, stats, meters, uncertainty,
    h('div', { class: 'kv-grid' }, targetTable, contributionTable),
    capsule, notes
  );
}

function capChip(label, value, hint, forceTone = null) {
  const on = Boolean(value);
  const tone = forceTone || (on ? 'success' : 'plain');
  return chip(`${label}：${on ? '是' : '否'}`, { tone, title: hint });
}

/** 信号分组区。 */
function renderSignals(report) {
  const groups = groupSignals(report);
  if (!groups.length) {
    return h('section', { class: 'signals' },
      h('h3', { class: 'section-title', text: '指纹信号' }),
      h('div', { class: 'state-card empty-state small' },
        h('p', { class: 'state-text', text: '本次检测没有产生任何信号。没有信号不等于官方直连，而是意味着「证据不足 / 无法判定」。' })
      )
    );
  }

  return h('section', { class: 'signals' },
    h('h3', { class: 'section-title', text: `指纹信号（按类别，共 ${report.signals.length} 条）` }),
    ...groups.map(({ category, signals }) => {
      const totals = contributionTotals(signals);
      return h('section', { class: 'signal-group' },
        h('div', { class: 'signal-group-head' },
          h('h4', { class: 'signal-group-title', text: `${CATEGORY_LABELS[category] || category}` }),
          h('div', { class: 'chip-row' },
            chip(`${signals.length} 条`, { tone: 'plain' }),
            chip(`relay ${totals.relay.toFixed(1)}`, { tone: 'danger', title: '该类别指向中转的贡献值合计' }),
            chip(`official ${totals.official.toFixed(1)}`, { tone: 'success', title: '该类别指向官方的贡献值合计' }),
            chip(`neutral ${totals.neutral.toFixed(1)}`, { tone: 'plain', title: '中性证据贡献值合计' }),
            chip(`类别权重 ×${num(CATEGORY_WEIGHTS[category], 1)}`, { mono: true, title: '冻结的 CATEGORY_WEIGHTS' })
          )
        ),
        h('div', { class: 'signal-list' }, signals.map(signalCard))
      );
    })
  );
}

/** 探测原始数据（折叠）。 */
function renderProbes(report) {
  if (!report.probes.length) return null;
  return detailsBlock(`探测原始数据（${report.probes.length} 条，含脱敏请求头与截断正文）`,
    ...report.probes.map((probe, index) => renderProbe(probe, index))
  );
}

function probeTone(probe) {
  if (probe.error) return 'warn';
  const status = num(probe.response && probe.response.status, 0);
  if (status >= 400) return 'warn';
  if (status >= 200 && status < 300) return 'success';
  return 'plain';
}

function probeStatusText(probe) {
  if (probe.error && probe.error.kind) return `错误：${probe.error.kind}`;
  const status = probe.response ? num(probe.response.status, 0) : null;
  if (status === null) return '无响应';
  return `HTTP ${status}`;
}

function renderProbe(probe, index) {
  const req = probe.request && typeof probe.request === 'object' ? probe.request : {};
  const res = probe.response && typeof probe.response === 'object' ? probe.response : null;
  const meta = probe.meta && typeof probe.meta === 'object' ? probe.meta : null;
  const metaKeys = meta ? Object.keys(meta) : [];

  const body = h('div', { class: 'probe-body' },
    kvTable([
      ['探测编号', probe.id || `probe-${index}`],
      ['协议族', probe.provider || '—'],
      ['探测类型', probe.kind || '—'],
      ['方法', req.method || '—'],
      ['URL', req.url || '—'],
      ['耗时', formatDuration(req.durationMs)],
      ['请求开始', formatTime(req.startedAt)]
    ]),
    h('h5', { class: 'probe-subtitle', text: '发送的请求头（密钥一律脱敏为 <redacted>）' }),
    codeBlock(stringify(req.headersSent || {}), { maxHeight: '12rem' }),
    req.bodySent ? h('div', {}, h('h5', { class: 'probe-subtitle', text: '发送的请求体（已脱敏）' }), codeBlock(stringify(req.bodySent), { maxHeight: '12rem' })) : null
  );

  if (res) {
    body.append(
      h('h5', { class: 'probe-subtitle', text: `响应头（content-type: ${res.contentType || '未知'}）` }),
      codeBlock(stringify(res.headers || {}), { maxHeight: '14rem' }),
      h('h5', { class: 'probe-subtitle', text: '响应正文（按契约截断至 20000 字符以内）' }),
      codeBlock(typeof res.bodyText === 'string' && res.bodyText ? res.bodyText : '(空正文)', { maxHeight: '18rem' })
    );
  }

  if (probe.error) {
    body.append(
      h('div', { class: 'probe-error' },
        h('h5', { class: 'probe-subtitle', text: '探测错误' }),
        kvTable([
          ['类型', probe.error.kind || '—'],
          ['消息', probe.error.message || '—']
        ])
      )
    );
  }

  if (metaKeys.length) {
    body.append(
      h('h5', { class: 'probe-subtitle', text: '附加信息 meta' }),
      codeBlock(stringify(meta), { maxHeight: '14rem' })
    );
  }

  return h('details', { class: 'probe' },
    h('summary', {},
      h('span', { class: 'probe-id', text: probe.id || `probe-${index}` }),
      chip(probeStatusText(probe), { tone: probeTone(probe) })
    ),
    body
  );
}

/** 轴 1：连接方式（v1 报告主体）。 */
function renderConnectionAxis(report) {
  return h('section', {
    class: 'axis-card axis-connection',
    'aria-labelledby': 'connection-axis-title'
  },
    h('header', { class: 'axis-head' },
      h('div', { class: 'axis-head-main' },
        h('span', { class: 'axis-index', text: '轴 1' }),
        h('h3', { class: 'axis-title', id: 'connection-axis-title', text: '连接方式：我连的是官方还是第三方？' })
      ),
      h('p', { class: 'axis-sub', text: '基于域名、TLS、响应头、错误报文、模型列表等连接层特征。与下方「上游真伪」轴并列，禁止合并成一个分数。' })
    ),
    renderSummary(report)
  );
}

/** 轴 1 未检测（「真伪」档位只跑 v2 时）。 */
function renderConnectionUnavailable() {
  return h('section', {
    class: 'axis-card axis-connection axis-unavailable',
    'aria-labelledby': 'connection-axis-title'
  },
    h('header', { class: 'axis-head' },
      h('div', { class: 'axis-head-main' },
        h('span', { class: 'axis-index', text: '轴 1' }),
        h('h3', { class: 'axis-title', id: 'connection-axis-title', text: '连接方式：本次未检测' })
      ),
      h('p', { class: 'axis-sub', text: '你选择了「真伪」档位：只回答「第三方上游给的是不是真模型」，不判断你连的是官方还是中转站。' })
    ),
    h('div', { class: 'state-card empty-state small' },
      h('div', { class: 'state-icon', 'aria-hidden': 'true', text: '🔗' }),
      h('h4', { class: 'state-title', text: '连接方式轴未执行' }),
      h('p', { class: 'state-text', text: '如需同时判断「官方直连 / 中转站」，请选择「完整（指纹 + 真伪 full）」档位重新检测。' }),
      h('p', { class: 'state-hint', text: '免费档位只判断连接方式；真伪档位只判断上游真假。两根轴互不替代。' })
    )
  );
}

/** 导出与复制操作条。 */
function renderActions(report) {
  const json = () => JSON.stringify(report, null, 2);
  const download = () => {
    try {
      const blob = new Blob([json()], { type: 'application/json' });
      const url = URL.createObjectURL(blob);
      const a = h('a', { href: url, download: `relay-report-${report.target.host || 'target'}.json` });
      document.body.append(a);
      a.click();
      a.remove();
      setTimeout(() => URL.revokeObjectURL(url), 4000);
    } catch {
      // 忽略：极端环境下 Blob 不可用时，用户仍可复制 JSON
    }
  };

  return h('div', { class: 'report-actions no-print' },
    copyButton(json, { label: '复制完整报告（JSON）' }),
    copyButton(() => reportToText(report), { label: '复制结论摘要（纯文本）' }),
    h('button', { type: 'button', class: 'btn btn-ghost', onclick: download }, '下载 report.json'),
    h('button', { type: 'button', class: 'btn btn-ghost', onclick: () => window.print() }, '打印 / 存为 PDF')
  );
}

/**
 * 渲染完整报告。
 *
 * 契约 v2 第 7 节：连接轴（轴 1）与真伪轴（轴 2）必须**并列展示、禁止合并**。
 * 因此这里固定先渲染轴 1 卡片，再渲染独立的「上游真伪」卡片；
 * `report.authenticity` 为 null 时真伪卡片显示「本次未执行真伪检测」而不会报错。
 */
export function renderReport(container, report) {
  if (!container) return;
  try {
    const r = normalizeReport(report);
    const connectionAxis = r.connectionAvailable ? renderConnectionAxis(r) : renderConnectionUnavailable();
    const authenticityAxis = renderAuthenticityCard(r.authenticity, {
      connectionVerdict: r.connectionAvailable ? r.verdict : null,
      connectionAvailable: r.connectionAvailable,
      whenMissing: r.connectionAvailable
        ? undefined
        : '本次选择了「真伪」档位：只做上游真伪检测，未执行连接方式检测。'
    });

    const children = [
      h('div', { class: 'axes-intro' },
        h('p', { class: 'axes-intro-text', text: '本报告有两条正交的轴：轴 1 判断「你连的是官方还是第三方」，轴 2 判断「第三方上游给的是不是真模型」。两者分开呈现，不合并成一个分数。' })
      ),
      connectionAxis,
      authenticityAxis,
      renderActions(r),
      r.connectionAvailable ? renderSignals(r) : null,
      r.connectionAvailable ? renderProbes(r) : null
    ].filter(Boolean);
    container.replaceChildren(h('div', { class: 'report' }, children));
  } catch (error) {
    renderError(container, '报告渲染失败，已降级为错误提示。原始报告数据仍然可以复制。', {
      title: '渲染出错',
      detail: error && error.stack ? String(error.stack) : String(error),
      hints: ['这通常说明 detect() 返回的报告形状与契约不一致，请把技术细节反馈给 engine 维护者。']
    });
  }
}

/** 纯文本结论摘要（用于复制 / 粘贴到 issue）。 */
export function reportToText(report) {
  const r = normalizeReport(report);
  const combo = interpretAxes({
    connectionVerdict: r.connectionAvailable ? r.verdict : null,
    connectionAvailable: r.connectionAvailable,
    authVerdict: r.authenticity ? r.authenticity.verdict : null
  });

  const lines = [];
  lines.push('API 中转站检测报告（概率性判断，不构成确定性结论）');
  lines.push(`目标：${r.target.baseUrl || r.target.input || '—'}`);
  lines.push(`协议族：${PROVIDER_LABELS[r.target.provider] || r.target.provider || '—'} · 模式：${r.mode === 'proxy' ? '本地代理' : '浏览器直连'}`);
  lines.push('');
  if (r.connectionAvailable) {
    lines.push('轴 1 · 连接方式（我连的是官方还是第三方）：');
    lines.push(`判定：${VERDICT_LABELS[r.verdict]}（score=${r.score}/100，officialScore=${r.officialScore}/100，evidenceStrength=${formatPercent(r.evidenceStrength)}）`);
    lines.push(`信号数量：${r.signals.length} · 耗时：${formatDuration(r.durationMs)}`);
  } else {
    lines.push('轴 1 · 连接方式：本次未检测（仅执行了真伪检测）。');
  }
  lines.push('');
  lines.push(`两轴组合解读：${combo.text}`);
  lines.push('');
  lines.push(authenticityToText(r.authenticity, { comboText: combo.text }));
  if (r.notes.length) {
    lines.push('');
    lines.push('过程说明：');
    for (const note of r.notes) lines.push(`- ${note}`);
  }
  if (r.signals.length) {
    lines.push('');
    lines.push('信号列表（按贡献从大到小）：');
    for (const s of sortSignalsByContribution(r.signals)) {
      lines.push(`- [${CATEGORY_LABELS[s.category] || s.category || '未分类'} / ${s.verdict || 'neutral'}] ${s.title || s.id || '未命名'}（weight=${num(s.weight, 0)}，confidence=${formatPercent(num(s.confidence, 0))}，贡献=${contributionOf(s).toFixed(1)}）`);
      if (s.detail) lines.push(`  ${s.detail}`);
      lines.push(`  证据：${stringify(s.evidence).replace(/\s+/g, ' ').slice(0, 400)}`);
    }
  }
  lines.push('');
  lines.push('注意：以上为基于可观测特征的概率性判断，特征可能被伪造或受环境干扰；证据强度不足时请视为「无法判定」。');
  return lines.join('\n');
}
