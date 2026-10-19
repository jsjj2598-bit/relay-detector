/**
 * src/ui/authenticity.js —— 「上游真伪」轴（契约 v2）的渲染。
 *
 * 这是与 v1「连接方式」轴**完全并列、互不合并**的第二张卡片：
 *   - 连接轴回答：我连的是官方还是第三方？
 *   - 真伪轴回答：第三方上游给我的**是不是真模型**？
 *
 * 视觉红线（契约 7.3 / LEARNINGS 2.3）：
 *   - `runError`（检测无效）必须是**灰色中性横幅**，并且**不显示低分**，
 *     还要提示换 Key / 换模型；它不是「未达标」。
 *   - `criticalIssues` 是醒目的**红色**横幅，置顶。
 *   - `skip`（跳过）与 `error`（出错）在视觉上必须与 `fail`（未通过）区分：
 *     skip 是灰蓝色「跳过（不计分）」，error 是琥珀色「出错（不计分）」，
 *     fail 才是红色「未通过」。
 *   - 所有来自检测结果的文本一律 textContent 写入，防 XSS。
 */

import {
  h,
  chip,
  detailsBlock,
  codeBlock,
  kvTable,
  statCard,
  scoreRing,
  num,
  clamp,
  stringify
} from './components.js';
import {
  interpretAxes,
  authModeLabel,
  isPassingAuthVerdict
} from './form-state.js';

/** 真伪轴结论 → 中文标签（契约 6.3 summaryText 的兜底）。 */
export const AUTH_VERDICT_LABELS = {
  excellent: '优秀',
  passed: '通过',
  marginal: '基本合格',
  failed: '未达标',
  invalid: '检测无效'
};

/** 真伪轴结论 → 视觉色调。invalid 刻意用 neutral（灰色），绝不与 failed 的红色混同。 */
export const AUTH_VERDICT_TONES = {
  excellent: 'success',
  passed: 'success',
  marginal: 'warn',
  failed: 'danger',
  invalid: 'neutral'
};

/** 检测器状态 → 中文标签。 */
export const DETECTOR_STATUS_LABELS = {
  pass: '通过',
  fail: '未通过',
  skip: '跳过（不计分）',
  error: '出错（不计分）'
};

/** 检测器状态 → chip 色调。skip 与 error 刻意不同，且都不同于 fail。 */
const DETECTOR_STATUS_TONES = {
  pass: 'success',
  fail: 'danger',
  skip: 'info',
  error: 'warn'
};

const DETECTOR_STATUS_VALUES = ['pass', 'fail', 'skip', 'error'];

function isPlainObject(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function asString(value, fallback = '') {
  return typeof value === 'string' ? value : fallback;
}

function formatDuration(ms) {
  const value = num(ms, 0);
  if (value <= 0) return '—';
  if (value < 1000) return `${Math.round(value)} ms`;
  return `${(value / 1000).toFixed(1)} 秒`;
}

/** 按分数推导真伪结论（报告缺 verdict 时的兜底）。 */
export function authVerdictFromScore(score) {
  const value = clamp(num(score, 0), 0, 100);
  if (value >= 85) return 'excellent';
  if (value >= 70) return 'passed';
  if (value >= 50) return 'marginal';
  return 'failed';
}

/** 把任意 verdict 归一为合法真伪结论。 */
export function normalizeAuthVerdict(verdict, score) {
  if (Object.prototype.hasOwnProperty.call(AUTH_VERDICT_LABELS, verdict)) return verdict;
  return authVerdictFromScore(score);
}

/** 检测器状态归一：缺失时按 error / score 推断。 */
function normalizeDetectorStatus(raw) {
  if (raw && DETECTOR_STATUS_VALUES.includes(raw.status)) return raw.status;
  if (raw && (typeof raw.error === 'string' && raw.error.trim())) return 'error';
  return num(raw && raw.score, 0) >= 70 ? 'pass' : 'fail';
}

/** skip / error 的原因提取（契约 7.3：两者都必须显示原因）。 */
function extractDetectorReason(raw, status) {
  if (!isPlainObject(raw)) return '';
  if (typeof raw.error === 'string' && raw.error.trim()) return raw.error.trim();
  if (typeof raw.reason === 'string' && raw.reason.trim()) return raw.reason.trim();

  const details = isPlainObject(raw.details) ? raw.details : null;
  if (details) {
    // auth-engine 的 details 里通常同时有 reason（机器码，如 mode_not_selected）与 message（中文说明）。
    // 优先展示中文 message，并在后面附上机器码，便于排查。
    const message = ['message', 'detail', 'note', 'error'].reduce((found, key) => {
      if (found) return found;
      const value = details[key];
      return typeof value === 'string' && value.trim() ? value.trim() : '';
    }, '');
    const code = ['reason', 'skipReason', 'skip_reason'].reduce((found, key) => {
      if (found) return found;
      const value = details[key];
      return typeof value === 'string' && value.trim() ? value.trim() : '';
    }, '');
    if (message) {
      const suffix = code && code !== message && code.length <= 40 ? `（${code}）` : '';
      return `${message}${suffix}`;
    }
    if (code) return code;
    if (Array.isArray(details.subChecks)) {
      for (const item of details.subChecks) {
        if (!isPlainObject(item)) continue;
        for (const key of ['reason', 'message', 'skipReason', 'error']) {
          const value = item[key];
          if (typeof value === 'string' && value.trim()) return value.trim();
        }
      }
    }
  }

  if (status === 'skip') return '该检测器不适用于当前模型或档位（skip 不扣分）。';
  if (status === 'error') return '检测器执行出错（error 不计入分母，不代表上游有问题）。';
  return '';
}

/** 单个检测器结果归一。 */
export function normalizeDetector(raw, index = 0) {
  const source = isPlainObject(raw) ? raw : {};
  const score = clamp(num(source.score, 0), 0, 100);
  const status = normalizeDetectorStatus(source);
  const name = asString(source.name, `detector_${index + 1}`) || `detector_${index + 1}`;
  const details = isPlainObject(source.details) ? source.details : null;
  return {
    name,
    displayName: asString(source.displayName, name) || name,
    weight: clamp(num(source.weight, 0), 0, 100),
    status,
    score,
    durationMs: num(source.durationMs, 0),
    reason: extractDetectorReason(source, status),
    details,
    subChecks: details && Array.isArray(details.subChecks) ? details.subChecks : [],
    criticalIssues: Array.isArray(source.criticalIssues) ? source.criticalIssues.filter(isPlainObject) : []
  };
}

/** 单条严重问题归一（契约 6.6：{detector, code, message, evidence}）。 */
function normalizeCriticalIssue(raw, index) {
  const source = isPlainObject(raw) ? raw : {};
  return {
    detector: asString(source.detector, '') || `issue_${index + 1}`,
    code: asString(source.code, '') || 'critical_issue',
    message: asString(source.message, '') || '检测到严重问题（报告未提供说明）。',
    evidence: source.evidence === undefined ? null : source.evidence
  };
}

/**
 * 归一化 report.authenticity。缺失 / null / 非对象一律返回 null。
 * 与 v1 完全向后兼容：调用方拿到 null 时按「未执行真伪检测」渲染。
 */
export function normalizeAuthenticity(raw) {
  if (!isPlainObject(raw)) return null;

  const score = clamp(num(raw.score, 0), 0, 100);
  const runError = isPlainObject(raw.runError)
    ? {
        code: asString(raw.runError.code, 'unknown_error') || 'unknown_error',
        message: asString(raw.runError.message, '') || '上游返回了未知错误，检测未能完成。'
      }
    : null;

  // 有 runError 时必须显示「检测无效」，且绝不显示低分。
  const verdict = runError ? 'invalid' : normalizeAuthVerdict(raw.verdict, score);

  const detectors = Array.isArray(raw.detectors) ? raw.detectors.map(normalizeDetector) : [];
  const criticalIssues = Array.isArray(raw.criticalIssues)
    ? raw.criticalIssues.filter(isPlainObject).map(normalizeCriticalIssue)
    : [];

  // 检测器自带的 criticalIssues 也汇总进来（契约 6.2 DetectorResult 允许该字段）。
  for (const detector of detectors) {
    for (const issue of detector.criticalIssues) {
      criticalIssues.push(normalizeCriticalIssue({ detector: detector.name, ...issue }));
    }
  }

  const warnings = Array.isArray(raw.warnings)
    ? raw.warnings.filter((item) => typeof item === 'string' && item.trim()).map((item) => item.trim())
    : [];

  const cost = isPlainObject(raw.cost)
    ? {
        requests: num(raw.cost.requests, 0),
        promptTokens: num(raw.cost.promptTokens, 0),
        completionTokens: num(raw.cost.completionTokens, 0),
        note: asString(raw.cost.note, '')
      }
    : null;

  const allSkipped = detectors.length > 0 && detectors.every((item) => item.status === 'skip');
  const effectiveSkip = detectors.filter((item) => item.status === 'skip').length;
  const effectiveError = detectors.filter((item) => item.status === 'error').length;

  return {
    schema: num(raw.schema, 1),
    provider: asString(raw.provider, ''),
    model: asString(raw.model, ''),
    mode: asString(raw.mode, ''),
    score,
    verdict,
    summaryText: asString(raw.summaryText, '') || AUTH_VERDICT_LABELS[verdict] || '检测无效',
    detectors,
    criticalIssues,
    runError,
    cost,
    warnings,
    allSkipped,
    skipCount: effectiveSkip,
    errorCount: effectiveError,
    durationMs: num(raw.durationMs, 0)
  };
}

/** 真伪评分环的色调。 */
function authRingTone(verdict) {
  if (verdict === 'excellent' || verdict === 'passed') return 'success';
  if (verdict === 'marginal') return 'warn';
  if (verdict === 'failed') return 'danger';
  return 'neutral';
}

/** 轴标题（两个轴都用「轴 N」编号，强调并列关系）。 */
function axisHeader() {
  return h('header', { class: 'auth-axis-head' },
    h('div', { class: 'axis-head-main' },
      h('span', { class: 'axis-index', text: '轴 2' }),
      h('h3', { class: 'axis-title', id: 'auth-axis-title', text: '上游真伪：第三方上游给我的是不是真模型？' })
    ),
    h('p', { class: 'axis-sub', text: '与「连接方式」轴正交、并列展示；这里只回答上游真假，绝不与连接轴合并成一个总分。' })
  );
}

/** 两轴组合解读横幅。 */
function renderCombo(combo) {
  const tone = combo && combo.tone ? combo.tone : 'neutral';
  return h('div', { class: `axis-combo tone-${tone}` },
    h('p', { class: 'axis-combo-label', text: '两轴组合解读' }),
    h('p', { class: 'axis-combo-text', text: combo ? combo.text : '暂无组合解读。' }),
    combo && combo.hint ? h('p', { class: 'axis-combo-hint', text: combo.hint }) : null
  );
}

/** 严重问题红色横幅（置顶）。 */
function renderCriticalBanner(issues) {
  if (!Array.isArray(issues) || !issues.length) return null;
  return h('section', { class: 'auth-banner auth-banner-critical', role: 'alert', 'aria-label': '严重问题' },
    h('h4', { class: 'auth-banner-title', text: `🚨 严重问题：${issues.length} 项（critical 一票降级）` }),
    h('p', { class: 'auth-banner-text', text: '出现以下严重问题时，即使总分较高，真伪结论也会被封顶为「基本合格」或更低。' }),
    h('ul', { class: 'auth-issue-list' }, issues.map((issue) => h('li', { class: 'auth-issue' },
      h('div', { class: 'chip-row' },
        chip(issue.code, { tone: 'danger', mono: true, title: '严重问题 code' }),
        chip(issue.detector, { tone: 'plain', mono: true, title: '上报该问题的检测器' })
      ),
      h('p', { class: 'auth-issue-message', text: issue.message }),
      issue.evidence === null
        ? null
        : detailsBlock('问题证据（原样展示）', codeBlock(stringify(issue.evidence), { maxHeight: '12rem' }))
    )))
  );
}

/** 「检测无效」灰色横幅：绝不显示低分，也不是「未达标」。 */
function renderInvalidBanner(auth) {
  const runError = auth.runError;
  const title = runError
    ? '⚠️ 检测无效（不是低分，也不是「未达标」）'
    : auth.allSkipped
      ? '⚠️ 检测无效：所有检测器均被跳过（skip 不扣分，也不给分）'
      : '⚠️ 检测无效：没有检测器产生有效分数';
  const message = runError
    ? runError.message
    : `本次共 ${auth.detectors.length} 个检测器，其中 ${auth.skipCount} 个被跳过、${auth.errorCount} 个出错，没有任何有效分数。`;

  const suggestions = runError
    ? [
        '换一个可用的 API Key：余额不足、额度受限、Key 失效都会导致整份检测无效。',
        '换模型：出现 model_not_found / 无可用渠道时，改用模型下拉里的官方模型 ID 重试。',
        '确认目标允许跨域，或改用本地代理模式；网络失败同样会让检测无效。'
      ]
    : auth.errorCount > 0
      ? [
          '检测器执行出错（error）通常来自网络失败、被 CORS 拦截、上游 5xx 或超时，不代表上游是假模型。',
          '确认目标可达、允许跨域，或改用本地代理模式后重试。',
          '也可以换一个模型或换一个更小的档位，让更多检测器能跑起来。'
        ]
      : [
          '当前模型可能不支持这些检测能力（例如不支持 thinking / 工具调用）。',
          '请求预算可能已用尽（maxRequests 硬上限）；可换更小的档位或减少并发。',
          '换一个官方模型 ID 重新检测，通常能让更多检测器运行起来。'
        ];

  return h('section', { class: 'auth-banner auth-banner-invalid', role: 'status' },
    h('h4', { class: 'auth-banner-title', text: title }),
    h('p', { class: 'auth-banner-text', text: message }),
    runError
      ? h('div', { class: 'chip-row' },
          chip(`错误码：${runError.code}`, { tone: 'neutral', mono: true }),
          chip('检测无效 ≠ 未达标', { tone: 'neutral', title: '检测无效说明这次没测成，不代表上游是假模型。' })
        )
      : null,
    h('ul', { class: 'auth-banner-list' }, suggestions.map((text) => h('li', { text }))),
    h('p', { class: 'auth-banner-note', text: '修复后请重新检测。此横幅为中性灰色：它只说明「这次没有测成」，不代表上游有问题，也不会给出误导性的低分。' })
  );
}

/** 警告（黄色）列表。 */
function renderWarnings(warnings) {
  if (!Array.isArray(warnings) || !warnings.length) return null;
  return h('section', { class: 'auth-warnings', role: 'note' },
    h('h4', { class: 'auth-warnings-title', text: `⚠️ 警告（${warnings.length} 项）` }),
    h('ul', { class: 'auth-warnings-list' }, warnings.map((text) => h('li', { text })))
  );
}

/** 子项（subChecks）结构化展示 + 原始 JSON。 */
function renderSubChecks(detector) {
  const subChecks = Array.isArray(detector.subChecks) ? detector.subChecks : [];
  if (!subChecks.length) return null;

  const items = subChecks.map((raw, index) => {
    const item = isPlainObject(raw) ? raw : { value: raw };
    const title = asString(item.name, '') || asString(item.label, '') || asString(item.id, '') || asString(item.check, '') || `子项 ${index + 1}`;
    const statusRaw = normalizeDetectorStatus(item);
    const statusKnown = DETECTOR_STATUS_VALUES.includes(item.status);
    const status = statusKnown ? item.status : statusRaw;
    const scoreText = typeof item.score === 'number' ? `${Math.round(item.score)} 分` : '';
    let detail = '';
    for (const key of ['detail', 'message', 'reason', 'description', 'expected']) {
      if (typeof item[key] === 'string' && item[key].trim()) {
        detail = item[key].trim();
        break;
      }
    }

    return h('li', { class: 'subcheck-item' },
      h('div', { class: 'subcheck-head' },
        h('span', { class: 'subcheck-name', text: title }),
        h('div', { class: 'chip-row' },
          statusKnown ? chip(DETECTOR_STATUS_LABELS[status], { tone: DETECTOR_STATUS_TONES[status] || 'neutral' }) : null,
          scoreText ? chip(scoreText, { tone: 'plain', mono: true }) : null
        )
      ),
      detail ? h('p', { class: 'subcheck-detail', text: detail }) : null
    );
  });

  return detailsBlock(`子项明细（subChecks，共 ${subChecks.length} 项）`,
    h('ul', { class: 'subcheck-list' }, items),
    detailsBlock('原始 JSON（原样展示）', codeBlock(stringify(subChecks), { maxHeight: '16rem' }))
  );
}

/** 状态 chip：skip / error / fail 三者视觉区分。 */
function statusChip(detector) {
  const status = detector.status;
  const label = DETECTOR_STATUS_LABELS[status] || String(status);
  const titleMap = {
    pass: '该检测器通过（得分 ≥ 70）。',
    fail: '该检测器未通过：得分低于 70，会计入加权分母。',
    skip: '该检测器被跳过：skipped 不进入加权分母，不会被当作 0 分拉低总分。',
    error: '该检测器执行出错：error 不进入加权分母，也不代表上游有问题。'
  };
  const node = chip(label, { tone: DETECTOR_STATUS_TONES[status] || 'neutral', title: titleMap[status] || '' });
  node.classList.add('detector-status', `status-${status}`);
  return node;
}

/** 检测器表格（name / displayName / status / score / weight / 耗时 / 原因）。 */
function renderDetectorTable(detectors) {
  if (!Array.isArray(detectors) || !detectors.length) return null;
  const rows = detectors.map((detector) => h('tr', { class: `detector-row status-${detector.status}` },
    h('td', { class: 'detector-name-cell' },
      h('div', { class: 'detector-display-name', text: detector.displayName }),
      h('div', { class: 'detector-raw-name mono', text: detector.name })
    ),
    h('td', {}, statusChip(detector)),
    h('td', { class: 'detector-num' }, detector.status === 'skip' || detector.status === 'error'
      ? h('span', { class: 'detector-score-muted', text: '—（不计分）' })
      : h('span', { text: `${Math.round(detector.score)} 分` })),
    h('td', { class: 'detector-num' }, String(detector.weight)),
    h('td', { class: 'detector-num' }, formatDuration(detector.durationMs)),
    h('td', { class: 'detector-reason-cell' },
      detector.reason
        ? h('span', { class: `detector-reason reason-${detector.status}`, text: detector.reason })
        : h('span', { class: 'detector-score-muted', text: '—' })
    )
  ));

  return h('div', { class: 'detector-table-wrap' },
    h('h4', { class: 'section-subtitle', text: `检测器明细（${detectors.length} 项）` }),
    h('div', { class: 'table-scroll' },
      h('table', { class: 'detector-table' },
        h('caption', { class: 'sr-only', text: '上游真伪检测器状态表' }),
        h('thead', {},
          h('tr', {},
            h('th', { scope: 'col', text: '检测器' }),
            h('th', { scope: 'col', text: '状态' }),
            h('th', { scope: 'col', text: '分数' }),
            h('th', { scope: 'col', text: '权重' }),
            h('th', { scope: 'col', text: '耗时' }),
            h('th', { scope: 'col', text: '说明 / skip 原因' })
          )
        ),
        h('tbody', {}, rows)
      )
    ),
    h('p', { class: 'hint', text: 'skip 与 error 都不进入加权分母，因此不会被当成 0 分拉低总分；只有 fail（未通过）才计入分母。' })
  );
}

/** 费用统计。 */
function renderCost(cost) {
  if (!cost) return null;
  return detailsBlock(`本次真伪检测的请求与 token 统计（约 ${cost.requests} 次请求）`,
    kvTable([
      ['请求数', `${cost.requests} 次`],
      ['输入 token（预估 / 实际）', String(cost.promptTokens)],
      ['输出 token（预估 / 实际）', String(cost.completionTokens)],
      ['备注', cost.note || '—']
    ], { caption: '费用与用量' })
  );
}

/** 真伪轴摘要区：评分环 + 关键数字。 */
function renderAuthSummary(auth) {
  const ring = h('div', { class: 'auth-ring-wrap' },
    h('div', { class: 'auth-score-ring' },
      scoreRing(auth.score, {
        caption: '真伪评分（越高越可信）',
        tone: authRingTone(auth.verdict),
        ariaLabel: `真伪评分 ${auth.score} / 100，结论：${auth.summaryText}`
      })
    )
  );

  const stats = h('div', { class: 'stat-grid auth-stat-grid' },
    statCard('真伪结论', auth.summaryText, `score ${auth.score} / 100（阈值：85 优秀 / 70 通过 / 50 基本合格）`),
    statCard('检测档位', authModeLabel(auth.mode), `报告 schema ${auth.schema}`),
    statCard('检测模型', auth.model || '—', `协议族：${auth.provider || '—'}`),
    statCard('检测器', `${auth.detectors.length} 项（跳过 ${auth.skipCount} · 出错 ${auth.errorCount}）`, '跳过与出错都不计入分母'),
    statCard('严重问题', `${auth.criticalIssues.length} 项`, auth.criticalIssues.length ? 'critical 会触发一票降级' : '未发现 critical 级问题'),
    statCard('耗时', formatDuration(auth.durationMs), '含所有检测器串行执行时间')
  );

  return h('div', { class: 'auth-summary' }, ring, stats);
}

/**
 * 对外渲染入口
 * ------------------------------------------------------------------ */

/**
 * 渲染「上游真伪」卡片。
 *
 * @param {object|null|undefined} raw report.authenticity
 * @param {object} [opts]
 * @param {string|null} [opts.connectionVerdict] 连接轴结论
 * @param {boolean} [opts.connectionAvailable] 是否执行了连接轴检测
 * @param {string} [opts.whenMissing] authenticity 为 null 时的说明
 * @returns {Element}
 */
export function renderAuthenticityCard(raw, opts = {}) {
  const auth = normalizeAuthenticity(raw);
  const connectionAvailable = opts.connectionAvailable !== false;
  const connectionVerdict = typeof opts.connectionVerdict === 'string' ? opts.connectionVerdict : null;

  const combo = interpretAxes({
    connectionVerdict,
    connectionAvailable,
    authVerdict: auth ? auth.verdict : null
  });

  const children = [axisHeader()];

  // critical 红色横幅：契约要求「醒目、置顶」，因此放在两轴解读之前。
  const critical = auth ? renderCriticalBanner(auth.criticalIssues) : null;
  if (critical) children.push(critical);

  children.push(renderCombo(combo));

  if (!auth) {
    const reason = typeof opts.whenMissing === 'string' && opts.whenMissing
      ? opts.whenMissing
      : '本次检测选择了「指纹（免费）」档位，只判断连接方式，未执行上游真伪检测。';
    children.push(h('div', { class: 'state-card empty-state small auth-empty' },
      h('div', { class: 'state-icon', 'aria-hidden': 'true', text: '🧪' }),
      h('h4', { class: 'state-title', text: '本次未执行真伪检测' }),
      h('p', { class: 'state-text', text: reason }),
      h('ul', { class: 'hint-list' },
        h('li', { text: '要知道上游是不是真模型，请选择「真伪」或「完整」档位（需要 API Key，会消耗额度）。' }),
        h('li', { text: '发请求前会展示请求数与 token 预估，并要求你显式勾选确认。' }),
        h('li', { text: '连接轴与真伪轴互不替代：中转站也可能诚实转发真模型。' })
      )
    ));
    return h('section', { class: 'auth-card axis-card axis-authenticity', 'aria-labelledby': 'auth-axis-title' }, children);
  }

  // 2) runError / 全 skip → 「检测无效」灰色横幅；正常结果 → 评分环 + summaryText + 关键数字。
  const invalid = auth.verdict === 'invalid';
  if (invalid) {
    children.push(renderInvalidBanner(auth));
  } else {
    children.push(renderAuthSummary(auth));
  }

  // 3) warnings 黄色提示
  const warnings = renderWarnings(auth.warnings);
  if (warnings) children.push(warnings);

  // 4) 检测器表格（invalid 时也展示，便于看到 skip / error 原因）
  const table = renderDetectorTable(auth.detectors);
  if (table) children.push(table);

  // 5) subChecks 折叠明细
  const subChecksBlocks = auth.detectors
    .map((detector) => {
      const block = renderSubChecks(detector);
      if (!block) return null;
      return h('div', { class: 'subchecks-wrap' },
        h('h5', { class: 'subchecks-title', text: `${detector.displayName}（${detector.name}）` }),
        block
      );
    })
    .filter(Boolean);
  if (subChecksBlocks.length) {
    children.push(detailsBlock(`子项明细（subChecks，共 ${subChecksBlocks.length} 个检测器有明细）`, ...subChecksBlocks));
  }

  // 6) 费用与用量
  const cost = renderCost(auth.cost);
  if (cost) children.push(cost);

  // 7) 真伪轴的不确定性声明（绝不暗示确定性）
  children.push(h('p', { class: 'hint auth-footnote', text: '真伪评分同样是概率性判断：它只能提高「上游像真模型」的置信度，不能给出形式化证明。请结合售价、延迟、账单主体等外部信息综合判断。' }));

  return h('section', {
    class: `auth-card axis-card axis-authenticity tone-${AUTH_VERDICT_TONES[auth.verdict] || 'neutral'}`,
    'aria-labelledby': 'auth-axis-title'
  }, children);
}

/** 纯文本摘要（用于「复制结论摘要」）。 */
export function authenticityToText(raw, opts = {}) {
  const auth = normalizeAuthenticity(raw);
  if (!auth) {
    return '上游真伪（轴 2）：本次未执行真伪检测（仅指纹档位）。';
  }
  const lines = [];
  lines.push('上游真伪（轴 2，与连接方式轴并列、不合并）：');
  lines.push(`结论：${auth.summaryText}（score=${auth.score}/100）· 档位：${authModeLabel(auth.mode)} · 模型：${auth.model || '—'}`);
  lines.push(`检测器：${auth.detectors.length} 项（通过 ${auth.detectors.filter((d) => d.status === 'pass').length} · 未通过 ${auth.detectors.filter((d) => d.status === 'fail').length} · 跳过 ${auth.skipCount} · 出错 ${auth.errorCount}）`);
  if (auth.criticalIssues.length) {
    lines.push(`严重问题（critical）：${auth.criticalIssues.length} 项`);
    for (const issue of auth.criticalIssues) {
      lines.push(`- [${issue.detector}/${issue.code}] ${issue.message}`);
    }
  }
  if (auth.runError) {
    lines.push(`检测无效（不是未达标）：[${auth.runError.code}] ${auth.runError.message}`);
    lines.push('修复建议：换一个可用的 API Key，或换模型后重新检测。');
  }
  for (const detector of auth.detectors) {
    lines.push(`- ${detector.displayName}（${detector.name}）：${DETECTOR_STATUS_LABELS[detector.status]} · score=${detector.score} · weight=${detector.weight} · ${formatDuration(detector.durationMs)}${detector.reason ? `\n  ${detector.reason}` : ''}`);
  }
  if (auth.warnings.length) {
    lines.push('警告：');
    for (const warning of auth.warnings) lines.push(`- ${warning}`);
  }
  if (auth.cost) {
    lines.push(`用量：请求 ${auth.cost.requests} 次 · 输入 token ${auth.cost.promptTokens} · 输出 token ${auth.cost.completionTokens}`);
  }
  if (opts.comboText) {
    lines.push('');
    lines.push(`两轴组合解读：${opts.comboText}`);
  }
  lines.push('');
  lines.push('注意：真伪评分是概率性判断，不是形式化证明，也不能替代外部交叉验证。');
  return lines.join('\n');
}
