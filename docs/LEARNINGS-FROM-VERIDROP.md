# 从 Veridrop 学到的（及本项目的取舍）

调研对象：<https://veridrop.app>（AGPL-3.0，源码 <https://github.com/canarybyte/veridrop>）
调研时间：2026-10-19。方法：抓取站点 `/claude` `/openai` `/gemini` `/faq` `/compare/relay-detectors`，
并通过 GitHub API 读取其检测器**源码**（`thinking_signature.py`、`scorer.py`、`integrity.py`、
`message_id.py`、`token_parity.py`、`model_consistency.py`、`detectors_base.py`）。

> 说明：Veridrop 的站点文案与源码是**外部参考材料**，只作为设计参考，本项目未复制其代码。
> 本项目为独立实现（JavaScript / 浏览器端），思路公开可查，实现细节自研。

---

## 1. 最重要的认知差距：两个不同的正交问题

| 问题 | 我在 v1 的回答 | Veridrop 的回答 |
| --- | --- | --- |
| 我连的是官方还是第三方？ | ✅ 有（域名身份 + 多层指纹） | 不太关心 |
| 第三方上游给的是**真模型**吗？ | ❌ 缺失 | ✅ 核心 |

v1 的盲区：一个中转站完全可能「诚实转发真实 OpenAI」，此时它**是中转站**但**上游是真的**；
另一个中转站可能「用 Kimi 冒充 Claude」，此时它**是中转站**且**上游是假的**。
v1 把两者混成一个分数，用户无法区分「我该换一家」和「这家的模型被掉包了」。

**本次升级**：把报告拆成两个正交轴。

- `connection` 轴（已有）：官方直连 / 中转 / 无法判定
- `authenticity` 轴（新增）：上游真伪评分 0–100 + 严重问题计数

---

## 2. 直接采纳的 6 个机制

### 2.1 `skip ≠ 0 分`（最关键）

Veridrop 的 `compute_total` 只对 `status != "skip"` 的检测器做加权平均：

```
total = Σ(score × weight) / Σ(weight)   # 仅统计未 skip 的检测器
```

v1 的错误：拿不到证据就直接扣分/判低。这会把「模型不支持 thinking」和
「中转站吞掉了 thinking」混为一谈，产生大量假阴性。
**采纳**：新增 `status: 'pass'|'fail'|'skip'|'error'`，`skip` 与 `error` 都不进入分母，
并在报告里显式列出 skip 原因。`error` 比 `skip` 严重，但不代表中转站有问题。

### 2.2 `critical` 一票降级

Veridrop：任意检测器上报 `severity == "critical"` 的问题，verdict 从 `passed` 封顶到 `marginal`
（分数可能仍然很高，因为一条 25% 的致命项会被六条 100% 的廉价结构项淹没）。

**采纳**：`criticalIssues[]` 与分数解耦，`verdict = cap(scoreVerdict, criticalCount > 0)`。

### 2.3 「检测无效」不是「未达标」

Veridrop 的 `fatal_run_error`：上游返回余额不足 / 用量限制 / `model_not_found` / 无可用渠道时，
整份报告标为「检测无效」，而不是给个 35 分让人以为站很烂。

**采纳**：`runError = { code, message }`，命中时 verdict = `invalid`，UI 显示醒目横幅。

### 2.4 Claude thinking signature —— 加密级验真（25% 权重）

这是本次调研**最有价值的单点**：Claude 开启 extended/adaptive thinking 时，
响应 `content[]` 里的 `thinking` / `redacted_thinking` 块会带一个服务端生成的
`signature`（实测长度 500–2000+ 字符）。它由 Anthropic 私钥产生，
Bedrock 简化接口（Kiro / Amazon Q 走的那条路）**不返回**该字段，
因此「有没有签名」是「上游是不是真 Claude」的强证据。

关键实现细节（直接来自其源码，含踩坑记录）：
- **必须用非流式**：`stream:true` + adaptive + summarized 时会静默丢弃 thinking 块，非流式才有 signature。
- `thinking: { type: 'enabled', budget_tokens: 2000 }`；adaptive 模型改用
  `{type:'adaptive', display:'summarized'}` 且 effort 是**独立顶层字段** `output_config.effort`，
  放进 `thinking` 里会 400。
- `max_tokens` 要给足（16000）：太小模型会为了塞下而直接跳过思考。
- 探针题用「多步欧几里得 GCD」而非简单乘法，避免中转站对固定题面特判；
  且刻意不用官方文档里的 1071/462 例子。
- 评分：无 thinking 块 = 0；有块无签名 = 30；签名 < 50 字符 = 70；正常 = 100。

**采纳**：实现 `thinking_signature` 检测器（仅 Claude，权重 25，standard/full 档）。

### 2.5 跨厂商字段泄漏（critical）

OpenAI 协议只该有 `prompt_tokens / completion_tokens / total_tokens`。
如果中转站把请求偷偷转给 Claude 再包装成 OpenAI 格式，响应里常会漏出
`claude_*`、`usage_source: anthropic`、Anthropic 命名（`input_tokens` / `output_tokens`）等痕迹。
Veridrop 将其列为 critical。

**采纳**：实现 `cross_vendor_leak` 被动检测器（权重 20，critical）。
双向检测：OpenAI 形状里出现 Anthropic/Google 痕迹；Claude 形状里出现 OpenAI/Google 痕迹。

### 2.6 被动检测器（零额外 token 成本）

`PassiveDetector.observe(req, resp)` 复用其他检测器已经发出的请求，不发新请求。
`message_id` 就是这样检查 `msg_` / `toolu_` / `srvtoolu_` 前缀、`type`、`role`、`model` 字段的。

**采纳**：`message_id`（Claude，权重 5，passive）与 `cross_vendor_leak` 都设为被动检测器。

---

## 3. 部分采纳 / 调整后采纳

| Veridrop 做法 | 我的调整 | 原因 |
| --- | --- | --- |
| 官方基线 JSON（`data/baselines/*.json`），token 逐字段对齐 ±1/±2 | 采纳思路，但做成**可选内置基线**且默认只做「自一致性」检查 | 基线会随模型/分词器更新而过期，硬编码会制造假阳性；本项目无后端无法持续更新基线 |
| 长上下文探针 32k→100k→500k→950k，10%/50%/90% 埋点召回 | 采纳**算法与埋点设计**，做成可选「深度档」，并在 UI 明确预估费用 | 单次 $3.32–$14.82，对个人用户必须显式确认 |
| 检测档位 quick/standard/full | 采纳 | 成本与时间可预期 |
| 报告永久 URL + JPG 分享 | **不采纳**（改为本地 JSON 导出 + 复制摘要 + 打印 PDF） | 纯静态站无后端，无法托管报告；且上传报告会泄露被测站信息 |
| 红黑榜 / 历史趋势 / 站长授权持续探测 | **不采纳** | 需要后端与数据库；本项目定位是「本地可审计的单次检测」 |
| API key 服务端短期持有（密文入队） | **不采纳**，改为「key 只在浏览器内存/单次请求中存在」 | 纯前端反而更安全：key 从不经过第三方服务器 |
| 注册 / 付费榜 / 联盟 | 不涉及 | 本项目不商业化 |

---

## 4. 本次暴露出的、v1 真实存在的问题（与 Veridrop 无关也要修）

1. **付费探测开关语义混乱**：`allowPaidProbes` 是布尔值，但「发一次 chat 请求」与「发 12 次含 thinking 的请求」成本差 100 倍。改为 `mode: fingerprint | authenticity | full` + 显式费用预估。
2. **缺少 `skip` 语义**：拿不到证据即低分，假阴性高。
3. **`inconclusive` 与「检测无效」混在一起**：key 失效/余额不足时用户会误以为站很差。
4. **模型选择缺失**：v1 只探测端点不探测具体模型，而真伪判定**必须**绑定具体模型（thinking 是否支持、上下文窗口各不相同）。
5. **无法区分「模型不支持」与「中转站不支持」**：需要 `applies_to(model)` 前置过滤。

---

## 5. 明确不学的东西

- 不做「身份问句」（「你是谁」）当主判据 —— 其源码把 identity 权重压到 5%，理由正确：中转站可注入 system prompt。本项目同样只把行为/身份类信号当极弱辅助。
- 不声称「100% 确定」。thinking signature 也只是「强证据」，不是形式化证明。
