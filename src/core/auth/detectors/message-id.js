/**
 * `message_id`（契约 v2 §6.4）—— 被动检测器，权重 5，standard+，仅 Anthropic。
 *
 * 复用其他检测器已经发出的 Anthropic `/v1/messages` 响应，检查官方协议里
 * 那些「中转站很容易漏掉」的元数据（见 LEARNINGS §2.6）：
 *  - `id` 是否为 `msg_` 前缀（官方格式；Kimi/中转包装常返回 UUID 或自增 id）；
 *  - `type === 'message'`、`role === 'assistant'`；
 *  - `model` 是否含 `claude`（上游掉包时可能回显别的模型名）；
 *  - 工具调用块的 id 是否为 `toolu_` / `srvtoolu_` 前缀。
 *
 * 权重只有 5：这些字段伪造成本低，只能作为很弱的辅助证据。
 */
import { PassiveDetector, buildResult, safeText, stateFor } from '../base.js';

const isObject = (value) => Boolean(value) && typeof value === 'object';

const WEIGHTS = {
  message_id: 40,
  type: 15,
  role: 15,
  model: 20,
  tool_use_id: 10
};

/**
 * 检查一条 Anthropic message 响应。
 *
 * @param {object} state 累积状态
 * @param {object} payload 响应 JSON
 * @param {string} purpose 请求用途
 */
function observePayload(state, payload, purpose) {
  if (!isObject(payload)) return;
  const isMessage =
    payload.type === 'message' || (Array.isArray(payload.content) && payload.role === 'assistant');
  if (!isMessage) return;

  // 主干信息以「第一条 message 响应」为准（不同用途的提示词不影响 id 格式）
  if (!state.primary) {
    state.primary = {
      id: safeText(payload.id),
      type: safeText(payload.type),
      role: safeText(payload.role),
      model: safeText(payload.model),
      purpose
    };
  }
  // 工具调用块可能出现在别的请求里（capability_tools），全部收集
  const content = Array.isArray(payload.content) ? payload.content : [];
  for (const block of content) {
    if (!isObject(block)) continue;
    if (block.type === 'tool_use') {
      state.toolUseIds.push(safeText(block.id));
    } else if (block.type === 'server_tool_use') {
      state.toolUseIds.push(safeText(block.id));
    }
  }
}

export class MessageIdDetector extends PassiveDetector {
  constructor() {
    super({
      name: 'message_id',
      displayName: '消息 ID 与前缀格式',
      weight: 5,
      modes: ['standard', 'full'],
      provider: ['anthropic'],
      critical: false,
      description: '检查 Anthropic 响应 id 的 msg_ 前缀、type/role/model 字段与 toolu_ 工具调用前缀。'
    });
  }

  observe(ctx, exchange) {
    try {
      const state = stateFor(ctx, this.name, () => ({ primary: null, toolUseIds: [], observed: 0 }));
      const response = exchange?.response;
      if (!response || !response.bodyJson) return;
      const status = Number(response.status) || 0;
      if (status >= 400) return;
      observePayload(state, response.bodyJson, safeText(exchange?.purpose));
      state.observed += 1;
    } catch {
      /* 被动观察失败不影响主流程 */
    }
  }

  finalize(ctx) {
    const state = stateFor(ctx, this.name, () => ({ primary: null, toolUseIds: [], observed: 0 }));
    if (!state.primary) {
      return buildResult(this, {
        status: 'skip',
        score: 0,
        reason: 'no_exchange',
        details: {
          reason: 'no_exchange',
          message: '本次没有可复用的 Anthropic message 响应，已跳过（skip 不计入加权分母）。'
        }
      });
    }

    const primary = state.primary;
    const messageIdOk = /^msg_[A-Za-z0-9_-]{6,}$/.test(primary.id);
    const typeOk = primary.type === 'message';
    const roleOk = primary.role === 'assistant';
    const modelOk = /claude/i.test(primary.model);
    const checks = [
      {
        id: 'message_id_prefix',
        weight: WEIGHTS.message_id,
        ok: messageIdOk,
        detail: messageIdOk ? 'id 符合 msg_ 前缀格式。' : `id 不符合官方 msg_ 前缀格式（实际 "${primary.id.slice(0, 64)}"），中转包装常自行生成 id。`,
        evidence: { id: primary.id.slice(0, 96) }
      },
      {
        id: 'type_message',
        weight: WEIGHTS.type,
        ok: typeOk,
        detail: typeOk ? 'type 为 "message"。' : `type 不为 "message"（实际 "${primary.type}"）。`,
        evidence: { type: primary.type }
      },
      {
        id: 'role_assistant',
        weight: WEIGHTS.role,
        ok: roleOk,
        detail: roleOk ? 'role 为 "assistant"。' : `role 不为 "assistant"（实际 "${primary.role}"）。`,
        evidence: { role: primary.role }
      },
      {
        id: 'model_contains_claude',
        weight: WEIGHTS.model,
        ok: modelOk,
        detail: modelOk ? 'model 字段含 claude。' : `model 字段不含 claude（实际 "${primary.model}"）。`,
        evidence: { model: primary.model }
      }
    ];

    // 只有确实出现过工具调用时才检查 toolu_ 前缀，避免无 tool_use 的普通响应被无端扣分
    if (state.toolUseIds.length > 0) {
      const prefixOk = state.toolUseIds.every(
        (id) => /^toolu_[A-Za-z0-9_-]{4,}$/.test(id) || /^srvtoolu_[A-Za-z0-9_-]{4,}$/.test(id)
      );
      checks.push({
        id: 'tool_use_id_prefix',
        weight: WEIGHTS.tool_use_id,
        ok: prefixOk,
        detail: prefixOk ? '工具调用 id 符合 toolu_ / srvtoolu_ 前缀。' : '工具调用 id 缺少 toolu_ 前缀，中转层可能重写了工具调用结构。',
        evidence: { ids: state.toolUseIds.slice(0, 10) }
      });
    }

    const applicableWeight = checks.reduce((sum, item) => sum + item.weight, 0);
    const passedWeight = checks.filter((item) => item.ok).reduce((sum, item) => sum + item.weight, 0);
    const score = Math.round((passedWeight / Math.max(1, applicableWeight)) * 100);

    return buildResult(this, {
      status: score >= 70 ? 'pass' : 'fail',
      score,
      details: {
        subChecks: checks,
        observedResponses: state.observed,
        primaryPurpose: primary.purpose,
        primary: {
          id: primary.id.slice(0, 96),
          type: primary.type,
          role: primary.role,
          model: primary.model
        },
        toolUseIds: state.toolUseIds.slice(0, 10)
      }
    });
  }

  /** 直接调用时的兼容入口：扫描 ctx.exchanges 后 finalize。 */
  async run(ctx) {
    const exchanges = Array.isArray(ctx?.exchanges) ? ctx.exchanges : [];
    for (const exchange of exchanges) this.observe(ctx, exchange);
    return this.finalize(ctx);
  }
}

export const messageId = new MessageIdDetector();
export default messageId;
