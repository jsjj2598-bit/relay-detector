/**
 * src/ui/form-state.js —— 纯逻辑：检测深度、费用确认门控、两轴组合解读。
 *
 * 这里不触碰 DOM，便于离线测试；app.js 只负责把它的返回值映射到界面。
 *
 * 契约 v2 的核心概念（docs/CONTRACT.md 第 5–7 节）：
 *   轴 1「连接方式」：我连的是官方还是第三方？（v1 的 score / verdict）
 *   轴 2「上游真伪」：第三方上游给我的**是不是真模型**？（v2 的 authenticity）
 * 两根轴正交，**禁止合并成一个分数**。
 */

/** 检测深度取值。 */
export const DEPTH_FINGERPRINT = 'fingerprint';
export const DEPTH_AUTHENTICITY = 'authenticity';
export const DEPTH_FULL = 'full';
export const DEPTH_ORDER = [DEPTH_FINGERPRINT, DEPTH_AUTHENTICITY, DEPTH_FULL];

/**
 * 检测深度三选一（契约 7.1）。
 * @typedef {Object} DepthOption
 * @property {string} value
 * @property {string} label
 * @property {string} description
 * @property {boolean} requiresKey
 * @property {boolean} runsV1
 * @property {string|null} authMode
 */
export const DEPTH_OPTIONS = [
  {
    value: DEPTH_FINGERPRINT,
    label: '指纹（免费 / 无需 Key）',
    description: '只做连接方式检测：域名、响应头、错误报文、模型列表等。默认不发任何可能计费的请求，authenticity 为 null。',
    requiresKey: false,
    runsV1: true,
    authMode: null
  },
  {
    value: DEPTH_AUTHENTICITY,
    label: '真伪（需要 API Key，消耗额度）',
    description: '只做上游真伪检测（standard 档）：约 10–14 个请求，向目标发送真实对话请求，会产生费用。',
    requiresKey: true,
    runsV1: false,
    authMode: 'standard'
  },
  {
    value: DEPTH_FULL,
    label: '完整（指纹 + 真伪 full）',
    description: '连接方式 + 上游真伪（full 档，约 14–20 个请求）。两根轴都展示，并给出一句话组合解读。',
    requiresKey: true,
    runsV1: true,
    authMode: 'full'
  }
];

/** 把任意输入归一成合法深度。 */
export function normalizeDepth(value) {
  return DEPTH_ORDER.includes(value) ? value : DEPTH_FINGERPRINT;
}

/** 取深度选项对象（未知值回退到免费档）。 */
export function depthOption(value) {
  const depth = normalizeDepth(value);
  return DEPTH_OPTIONS.find((item) => item.value === depth) || DEPTH_OPTIONS[0];
}

/** 该深度是否需要 API Key。 */
export function depthRequiresKey(value) {
  return depthOption(value).requiresKey;
}

/** 该深度对应的 v2 档位；免费档返回 null。 */
export function resolveAuthMode(value) {
  return depthOption(value).authMode;
}

/** 该深度是否跑 v1（指纹）检测。 */
export function depthRunsV1(value) {
  return depthOption(value).runsV1;
}

/** 该深度是否跑 v2（真伪）检测。 */
export function depthRunsAuth(value) {
  return Boolean(depthOption(value).authMode);
}

/** 深度的短标签（用于报告 / 历史 / 加载态）。 */
export function depthLabel(value) {
  return depthOption(value).label;
}

/** 档位中文名。 */
export const AUTH_MODE_LABELS = {
  quick: '快速',
  standard: '标准',
  full: '完整'
};

/** 档位中文名（未知值原样返回）。 */
export function authModeLabel(mode) {
  if (!mode) return '未执行';
  return AUTH_MODE_LABELS[mode] || String(mode);
}

/* ------------------------------------------------------------------ *
 * 发请求前的门控
 * ------------------------------------------------------------------ */

/**
 * 计算「开始检测」按钮是否可用，以及不可用时的明确原因。
 * 契约 7.2：需要 Key 的档位在发请求前必须展示 estimateCost 并要求用户显式勾选确认。
 *
 * @param {Object} input
 * @param {string} input.depth 检测深度
 * @param {string} input.baseUrl API 基址
 * @param {string} input.apiKey API Key
 * @param {string} input.model 模型
 * @param {boolean} input.loading 是否正在检测
 * @param {boolean} input.authReady 真伪引擎是否就绪
 * @param {boolean} [input.authLoading] 真伪引擎是否仍在加载
 * @param {Error|string|null} [input.authError] 真伪引擎加载错误
 * @param {{ok:boolean, cost?:object, error?:string}|null} input.estimate 费用预估结果
 * @param {boolean} input.costConfirmed 是否已显式勾选费用确认
 * @returns {{disabled:boolean, reason:string, tone:'plain'|'info'|'warn'|'success'}}
 */
export function computeStartState(input = {}) {
  const depth = normalizeDepth(input.depth);
  const option = depthOption(depth);

  if (input.loading) {
    return { disabled: true, reason: '', tone: 'plain' };
  }
  if (!String(input.baseUrl || '').trim()) {
    return { disabled: true, reason: '请先填写 API 基址，例如 https://api.example.com/v1。', tone: 'warn' };
  }
  if (!option.requiresKey) {
    return {
      disabled: false,
      reason: '本档位只发只读探测，不需要 Key，也不产生对话费用。',
      tone: 'success'
    };
  }
  if (!input.authReady) {
    if (input.authLoading) {
      return { disabled: true, reason: '正在加载真伪引擎…（真伪引擎就绪后才能开始该档位）', tone: 'info' };
    }
    const detail = input.authError ? `：${String(input.authError.message || input.authError).split('\n')[0]}` : '';
    return {
      disabled: true,
      reason: `真伪引擎未就绪${detail}。可先切换到「指纹（免费）」档位，页面其余功能不受影响。`,
      tone: 'warn'
    };
  }
  if (!String(input.apiKey || '').trim()) {
    return { disabled: true, reason: '当前检测深度需要 API Key（Key 只存在于浏览器内存与请求头中）。', tone: 'warn' };
  }
  if (!String(input.model || '').trim()) {
    return { disabled: true, reason: '请选择或填写要检测的模型，例如 claude-sonnet-4-5 / gpt-4o。', tone: 'warn' };
  }
  if (!input.estimate || input.estimate.ok !== true) {
    const detail = input.estimate && input.estimate.error ? input.estimate.error : '费用预估不可用';
    return { disabled: true, reason: `无法完成费用预估：${detail}`, tone: 'warn' };
  }
  if (!input.costConfirmed) {
    const requests = input.estimate.cost && Number.isFinite(input.estimate.cost.requests)
      ? input.estimate.cost.requests
      : null;
    const suffix = requests === null ? '' : `（本次约 ${requests} 次真实请求）`;
    return {
      disabled: true,
      reason: `请先勾选上方的「费用确认」${suffix}：该档位会向目标发送真实对话请求，可能消耗账户额度。`,
      tone: 'warn'
    };
  }
  return { disabled: false, reason: '费用已确认，可以开始检测。', tone: 'success' };
}

/* ------------------------------------------------------------------ *
 * 两轴组合解读（契约 7.4）
 * ------------------------------------------------------------------ */

const RELAY_VERDICTS = new Set(['relay', 'likely-relay']);
const OFFICIAL_VERDICTS = new Set(['official', 'likely-official']);

/** 是否是「中转方向」的连接结论。 */
export function isRelayVerdict(verdict) {
  return RELAY_VERDICTS.has(verdict);
}

/** 是否是「官方方向」的连接结论。 */
export function isOfficialVerdict(verdict) {
  return OFFICIAL_VERDICTS.has(verdict);
}

/** 是否是「真伪检测通过」的结果。 */
export function isPassingAuthVerdict(verdict) {
  return verdict === 'excellent' || verdict === 'passed';
}

/**
 * 两轴组合的一句话解读。
 *
 * 典型组合（契约 7.4）：
 *   relay + passed/excellent → 中转站，但上游是真模型 → 可用
 *   relay + failed           → 中转站，且上游疑似被掉包 → 建议更换
 *   relay + marginal         → 中转站，存在可疑迹象 → 谨慎使用
 *   official                 → 官方直连，无需真伪检测
 *   inconclusive + 任意      → 连接方式无法判定，真伪结果单独参考
 *
 * @param {Object} input
 * @param {string|null} input.connectionVerdict 连接轴结论（未检测为 null）
 * @param {boolean} input.connectionAvailable 是否执行了连接轴检测
 * @param {string|null} input.authVerdict 真伪轴结论（未检测 / null 表示未执行）
 * @returns {{tone:'danger'|'warn'|'success'|'neutral'|'info', text:string, hint:string}}
 */
export function interpretAxes(input = {}) {
  const connectionAvailable = input.connectionAvailable !== false;
  const connectionVerdict = typeof input.connectionVerdict === 'string' ? input.connectionVerdict : null;
  const authVerdict = typeof input.authVerdict === 'string' ? input.authVerdict : null;

  if (!connectionAvailable) {
    if (authVerdict === 'invalid') {
      return {
        tone: 'neutral',
        text: '真伪检测结果无效 → 本次无法判断上游真假，请换 Key / 换模型重试。',
        hint: '「检测无效」不同于「未达标」：它表示检测过程本身没有跑通（Key 失效、余额不足、模型不存在等），不能据此认为上游有问题。'
      };
    }
    return {
      tone: 'neutral',
      text: '本次未做连接方式检测，真伪结果单独参考。',
      hint: '「真伪」档位只回答上游是不是真模型；如需同时判断官方直连还是中转站，请选择「完整（指纹 + 真伪 full）」档位。'
    };
  }

  if (OFFICIAL_VERDICTS.has(connectionVerdict)) {
    return {
      tone: 'success',
      text: connectionVerdict === 'official' ? '官方直连，无需真伪检测。' : '疑似官方直连，无需真伪检测。',
      hint: '连接的是官方端点时，上游真伪问题基本不存在；真伪轴的分数仅作参考，可忽略。'
    };
  }

  if (authVerdict === 'invalid') {
    return {
      tone: 'neutral',
      text: RELAY_VERDICTS.has(connectionVerdict)
        ? '中转站，但真伪检测结果无效 → 无法判断上游真假，请换 Key / 换模型重试。'
        : '真伪检测结果无效 → 本次无法判断上游真假，请换 Key / 换模型重试。',
      hint: '「检测无效」不同于「未达标」：它表示检测过程本身没有跑通（Key 失效、余额不足、模型不存在等），不能据此认为上游有问题。'
    };
  }

  if (RELAY_VERDICTS.has(connectionVerdict)) {
    if (isPassingAuthVerdict(authVerdict)) {
      return {
        tone: 'success',
        text: '中转站，但上游是真模型 → 可用',
        hint: '连接的是第三方网关，不过上游响应通过了真伪检测。仍建议留意计费、隐私与稳定性，并保留账单证据。'
      };
    }
    if (authVerdict === 'failed') {
      return {
        tone: 'danger',
        text: '中转站，且上游疑似被掉包 → 建议更换',
        hint: '连接的是第三方网关，且上游响应在多个真伪检测器上未达标或出现严重问题。建议停止在该站付费，改用其他渠道。'
      };
    }
    if (authVerdict === 'marginal') {
      return {
        tone: 'warn',
        text: '中转站，存在可疑迹象 → 谨慎使用',
        hint: '连接的是第三方网关，上游真伪检测只达到「基本合格」。不要把重要或高金额任务交给它，并留意是否出现降智、串模型。'
      };
    }
    if (!authVerdict) {
      return {
        tone: 'warn',
        text: '中转站；本次未做真伪检测 → 无法判断上游是否真模型。',
        hint: '免费档位只判断「是不是中转站」。要知道上游有没有被掉包，请选择「真伪」或「完整」档位（需要 API Key，会消耗额度）。'
      };
    }
    return {
      tone: 'neutral',
      text: '中转站；真伪结果无法给出明确解读，请查看下方检测器明细。',
      hint: '真伪轴没有返回可识别的结论值，请把报告 JSON 反馈给维护者。'
    };
  }

  if (connectionVerdict === 'inconclusive') {
    return {
      tone: 'neutral',
      text: '连接方式无法判定，真伪结果单独参考。',
      hint: '浏览器模式受 CORS 限制时经常出现这种情况：连接轴证据不足，但真伪轴仍能独立工作。两者不要互相替代。'
    };
  }

  return {
    tone: 'neutral',
    text: connectionVerdict ? '连接方式结论未知，真伪结果单独参考。' : '尚未获得连接方式结论，真伪结果单独参考。',
    hint: '报告数据可能不完整。'
  };
}
