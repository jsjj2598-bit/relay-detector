# 上游真伪检测引擎（`src/core/auth/**`）实现笔记

> 归属：auth-engine。契约依据：`docs/CONTRACT.md` §5–§8（FROZEN v2）。
> 设计动机：`docs/LEARNINGS-FROM-VERIDROP.md`。
> 本文件记录每个检测器的算法、阈值来源、自测场景与已知局限；不是契约的替代。

---

## 1. 公开 API（契约 §6.6，冻结）

```js
import { runAuthenticity, estimateCost, AUTH_MODES } from './src/core/auth/index.js';

const report = await runAuthenticity({
  provider: 'openai' | 'anthropic' | 'gemini',
  baseUrl: 'https://relay.example.com/v1',
  apiKey: 'sk-...',
  model: 'claude-sonnet-4-5',
  mode: 'quick' | 'standard' | 'full',
  transport,                       // 与 fetch 同签名；不传则用 globalThis.fetch
  options: { timeoutMs, signal, maxRequests, concurrency, longContext }
});

const cost = estimateCost({ provider, model, mode });
// → { requests, promptTokens, completionTokens, note, breakdown }
```

- `runAuthenticity` **绝不抛异常**：内部错误降级为 `verdict: 'invalid'` 的报告（`runError.code: 'internal_error'`）。
- `AUTH_MODES = ['quick', 'standard', 'full']`（冻结数组）。
- 额外便利导出（不改变契约）：`AUTH_MODE_LABELS`、`AUTH_DETECTORS`、`getSuggestedModels`、
  `maskApiKey`、`computeTotal`、`lookupModel`、`suggestModels`、`AUTH_DETECTORS_BY_NAME` 等。

报告形状（契约 §6.6）：

```js
{
  schema: 1, provider, model, mode,
  score: 0..100, verdict, summaryText,
  detectors: [DetectorResult × 10],
  criticalIssues: [{ detector, code, message, evidence }],
  runError: null | { code, message },
  cost: { requests, promptTokens, completionTokens, note },
  warnings: [string],
  startedAt, finishedAt, durationMs
}
```

**报告里永远只有 `detectors[]` 十项**（包括因档位 / 协议 / 模型能力 / 预算而 `skip` 的项，
skip 原因写在 `reason` 与 `details.message`），便于 UI 解释「为什么没测这一项」。

---

## 2. 文件结构

| 文件 | 职责 |
| --- | --- |
| `index.js` | 契约 §6.6 公开导出（`runAuthenticity` / `estimateCost` / `AUTH_MODES`） |
| `scorer.js` | 契约 §6.3 全部函数 + `classifyFatalText`（致命错误文本识别） |
| `models.js` | `MODEL_REGISTRY` / `lookupModel`（日期后缀前缀匹配）/ `suggestModels` |
| `baselines.js` | 官方基线表（**默认故意为空**：无基线时 `token_parity` skip） |
| `base.js` | `ActiveDetector` / `PassiveDetector` / `maskApiKey` / `joinTextBlocks` / `pickTextContent` 等 |
| `protocol.js` | 三协议请求构造、响应/usage/工具调用/thinking/SSE 解析（无 I/O） |
| `runner.js` | 档位编排、`maxRequests` 硬上限、串行、超时/Abort、异常兜底、被动分发、cost 统计 |
| `detectors/*.js` | 契约 §6.4 的 10 个检测器 |

纯逻辑模块均可在 Node 下 `import`，不触碰 `document` / `window`。

### 2.1 检测器直连 API（离线单测用）

每个检测器文件同时导出**单例**（`export const xxx`）与**默认导出**，并可从
`AUTH_DETECTORS_BY_NAME` 取到。主动检测器可单独运行：

```js
import { AUTH_DETECTORS_BY_NAME } from '../src/core/auth/index.js';
import { lookupModel } from '../src/core/auth/models.js';

const detector = AUTH_DETECTORS_BY_NAME.thinking_signature;
const result = await detector.run({
  provider: 'anthropic',
  baseUrl: 'https://x/v1',
  apiKey: 'sk-test',
  model: 'claude-opus-4-1',
  modelInfo: lookupModel('anthropic', 'claude-opus-4-1'),
  transport,          // 或提供 runner 风格的 ctx.request(spec)
});
```

- 有 `ctx.request(spec)` 时走 runner 的预算/超时/被动分发；
- 没有时退化为直接调用 `ctx.transport`（无预算、无超时，**仅供离线测试**）。
- 被动检测器：`observe(ctx, exchange)` + `finalize(ctx)`；也可直接 `run(ctx)`（会扫描 `ctx.exchanges`）。
- `exchange` 形状：`{ purpose, request, response: { status, headers, bodyText, bodyJson }, error, meta, durationMs }`。

`test/helpers` 中已有 auth-test 构造的 fixture；本实现的自测脚本（未入库）与其独立。

---

## 3. 评分器语义（契约 §6.2 / §6.3）

### 3.1 `skip` / `error` 不进入加权分母（v2 最重要修正）

```
total = Σ(score × weight) / Σ(weight)   // 只统计 status ∉ {skip, error}
```

- 「一条 100 分 + 三条 skip」→ **100**（不是 25）。
- 分母为 0（全 skip / 全 error / 空）→ `computeTotal` 返回 0，但 `effectiveVerdict` 返回
  **`invalid`**，而不是 `failed`。
- `skip` / `error` 的 `score` 恒为 0（runner 统一归一化，保证契约 §6.2 形状）。

### 3.2 阈值

`verdictFor(score)`：`>=85 excellent` / `>=70 passed` / `>=50 marginal` / `<50 failed`。

### 3.3 critical 一票降级

`hasCriticalIssues(results)`：任意检测器 `criticalIssues` 非空即 true。
`effectiveVerdict`：`excellent` / `passed` 一律封顶为 **`marginal`**；`marginal` / `failed` 保持不变。
分数仍按加权平均计算（critical 与分数解耦），所以可能出现「分数 85+、结论 marginal」。

当前会产生 critical 的检测器（契约 v2.1）：

| 来源 | critical code | 触发条件 |
| --- | --- | --- |
| `cross_vendor_leak` | `cross_vendor_*` | 响应里出现跨厂商字段（如 OpenAI 形状出现 `claude_cache_creation_5_m_tokens` / `usage_source: anthropic`） |
| `thinking_signature` | `missing_thinking_signature` | `status: 'fail'` 且 `score <= 30`：**完全拿不到** Claude 服务端 thinking 签名（无 thinking 块=0 / 有块无签名=30）。签名过短（70）只扣分、不 critical；`skip`（模型不支持 thinking）绝不 critical。见 §4.4 / §9 |

### 3.4 「检测无效」不是「未达标」

`fatalRunError(results)` 命中条件：
1. 检测器显式给出 `details.fatal = { code: 'insufficient_quota' | 'model_unavailable', message }`；
2. 或错误文本匹配余额不足 / `insufficient_quota` / `model_not_found` / `not_found_error` /
   `no available channel` / 「无可用渠道」/「余额不足」等语义。

命中后整份报告 `verdict: 'invalid'`、`summaryText: '检测无效'`、`runError = { code, message }`，
**绝不输出低分**——否则用户会误以为「这个站质量差」，实际是 key 余额 / 模型名 / 渠道问题。

普通网络错误、401、500、超时**不会**被当成致命错误（只算 `status: 'error'`，不进入分母）。

---

## 4. 十个检测器：算法、阈值来源、局限

权重 / 档位 / critical 严格按契约 §6.4 冻结；以下只解释实现细节。

### 4.1 `protocol_shape`（active，20，quick+，全协议）

- **做法**：发一条最低成本 chat（`max_tokens: 16`，`temperature: 0`），按协议检查关键结构。
- OpenAI：`object === 'chat.completion'`、`id` 非空、`choices` 非空、`message.role === 'assistant'`、
  `finish_reason ∈ {stop,length,tool_calls,content_filter,function_call}`、`usage` 三个数字键。
- Anthropic：`type === 'message'`、`id` 以 `msg_` 开头、`role === 'assistant'`、`content` 非空、
  `stop_reason ∈ {end_turn,max_tokens,stop_sequence,tool_use,pause_turn,refusal}`、`usage` 两个数字键。
- Gemini：`candidates` 非空、`content.parts` 非空、`finishReason` 存在、`usageMetadata` 三个数字键。
- **评分**：`100 × 通过项 / 总项`，`>= 70` 为 `pass`。
- **阈值来源**：官方协议文档的必填字段（保守省略了 system_fingerprint 等可选字段）。
- **局限**：结构可被中转站照抄，因此只是弱证据；权重仅 20。

### 4.2 `cross_vendor_leak`（passive，20，**critical**，quick+，全协议）

- **做法**：复用其他主动检测器的成功响应，递归扫描 JSON 叶子（上限 1500 节点 / 深度 6）。
- OpenAI 协议下检出 Anthropic / Gemini 痕迹：
  - `claude_*` / `anthropic_*` / `input_tokens` / `output_tokens` /
    `cache_creation_input_tokens` / `cache_read_input_tokens` / `claude_cache_creation_5_m_tokens`；
  - `usageMetadata` / `promptTokenCount` / `candidatesTokenCount` / `totalTokenCount` / `candidates`；
  - `usage_source` / `provider` / `vendor` / `upstream` 字段值指向其他厂商；
  - 形状错位（如 OpenAI 协议返回 `type: 'message'`）。
- Anthropic / Gemini 协议做对称检查（如 Anthropic 响应出现 `choices` / `prompt_tokens`）。
- **评分**：检出即 `status: 'fail'`、`score: 0`、`criticalIssues[]`（每个泄漏一条，含 path/field/value）。
  未检出且至少观察到一个成功响应 → `pass`、100 分；没有可复用响应 → `skip`（`no_exchange`，不扣分）。
- **关键防误报**：只看成功响应（status < 400）；只看「像模型响应」的 JSON（含 `choices` / `content` /
  `candidates` / `usage`），**不扫描 `/v1/models` 列表**——聚合站的模型列表合法包含 `claude-*`。
- **阈值来源**：LEARNINGS §2.5（Veridrop 将跨厂商字段列为 critical）。

### 4.3 `model_consistency`（active，15，quick+，全协议）

- **做法**：同一提示词、`temperature: 0` 连发 3 次（`max_tokens: 64`）。
- 检查 1：响应 `model` 回显与请求模型一致（允许日期 / `-latest` / `vendor/` 前缀差异；
  但 `gpt-4o` vs `gpt-4o-mini` 判为不一致）。
- 检查 2：`completion_tokens` 的变异系数 `CV = 总体标准差 / 均值`
  - `CV ≤ 0.15` 稳定；`CV > 0.4` 异常（疑似轮换模型 / 截断输出）。
- 检查 3：3 次响应 `id` 应互不相同（相同 = 疑似重放缓存响应）。
- **评分**：model 回显不符 → **0 分**（硬证据）；一致则基础 60，CV 稳定 +40 / 一般 +10 /
  无法计算 +20；id 重复再 −20。
- **阈值来源**：`temperature=0` 的确定性假设；0.15 / 0.4 为工程经验值（宁可保守，避免误伤）。
- **局限**：部分上游温度 0 仍有轻微随机性；`completion_tokens` 缺失时 CV 项不计分而是 +20 中性分。
  若请求中途失败但已有 ≥1 个样本，按可用样本评分并在 `details.note` 说明。

### 4.4 `thinking_signature`（active，**25**，standard+，仅 Anthropic）

Claude 服务端 thinking 签名 = 本引擎的最强单点证据（LEARNINGS §2.4）。

- **适用**：`provider === 'anthropic'` 且 `lookupModel('anthropic', model).thinking` 为真；
  模型不支持（如 `claude-3-5-haiku-20241022`）或不在能力表 → `skip`，**不进入分母**。
- **请求（源码级踩坑点，逐条落实）**：
  - 必须**非流式**（`stream: false`）：`stream:true + adaptive + summarized` 会静默丢 thinking 块；
  - extended 模型：`thinking: { type: 'enabled', budget_tokens: 2000 }`，且**不传** `temperature`；
  - adaptive 模型（能力表 `adaptive: true`，如 `claude-sonnet-4-5`）：
    `thinking: { type: 'adaptive', display: 'summarized' }` + **顶层** `output_config: { effort: 'high' }`
    （放进 `thinking` 里会 400）；
  - `max_tokens: 16000`（太小模型会为了塞下而跳过思考）；
  - 探针：多步欧几里得 `gcd(2378, 1547)`，刻意避开官方文档的 1071/462。
- **评分（契约冻结四档）**：
  | 观测 | 分数 | status | critical |
  | --- | --- | --- | --- |
  | 无 `thinking` / `redacted_thinking` 块 | 0 | fail | ✅ `missing_thinking_signature` |
  | 有块但无 `signature` | 30 | fail | ✅ `missing_thinking_signature` |
  | 签名长度 < 50 | 70 | pass | ❌（只扣分） |
  | 签名长度 ≥ 50（实测真实签名 500–2000+） | 100 | pass | ❌ |
- **critical 规则（契约 v2.1）**：`status: 'fail'` 且 `score <= 30` → 额外产出
  `criticalIssues: [{ code: 'missing_thinking_signature', message: '拿不到 Claude 服务端 thinking 签名，上游不是真实 Anthropic 实现（可能是 Kiro/Amazon Q/Bedrock 简化通道或签名被剥离）', evidence: { score, thinkingBlockSeen, signatureReceived, signatureLength } }]`；
  检测器元信息 `critical: true`。**签名过短（70 分）不报 critical**（弱证据，只扣分）；
  **`skip`（模型不支持 thinking / 未知模型）绝不报 critical**（haiku 场景必须保持 skip、不拉低总分）。
- **为什么签名缺失是 critical 而不是普通扣分**：thinking 签名由 Anthropic 服务端私钥产生，
  真实实现开启 thinking 时**必然**返回它；拿不到它说明上游不是真实 Anthropic 实现（模型被掉包），
  属于「结论级」问题，而不是「质量略差」。若只按加权平均，25% 权重的这条证据会被 7 条 100 分的
  廉价结构项淹没（实测冒充场景 73.9 分 → `passed`），因此必须用 critical 一票降级兜住。
  详见 §9 v2.1 变更记录。
- **上游拒绝 thinking 参数**（400 且错误文本涉及 thinking/budget_tokens/output_config/effort/adaptive）
  → 判 `fail`、0 分并报 `missing_thinking_signature` critical：对一个「能力表说它支持 thinking」的模型，
  这是可疑信号，而不是网络错误。其余 HTTP / 传输错误 → `status: 'error'`（不进入分母、不产生 critical）。
- **局限**：只知道「有没有签名」，不能验证签名内容；`redacted_thinking` 按「有块无签名」计 30 分
  （契约只定义四档，保守处理）。

### 4.5 `message_id`（passive，5，standard+，仅 Anthropic）

- **做法**：复用 Anthropic message 响应，检查：
  - `id` 是否 `^msg_[A-Za-z0-9_-]{6,}$`（权重 40）；
  - `type === 'message'`（15）、`role === 'assistant'`（15）、`model` 含 `claude`（20）；
  - 若观察到 `tool_use` / `server_tool_use` 块：id 是否 `toolu_` / `srvtoolu_` 前缀（10，无工具时不适用）。
- **评分**：按「通过权重 / 适用权重」归一化；`>= 70` 为 `pass`。
- **阈值来源**：LEARNINGS §2.6 + 官方 id 格式；权重仅 5（伪造成本低）。

### 4.6 `token_usage`（active，10，standard+，全协议）

- 提示词刻意使用 **ASCII** 英文（中文的字符/token 比受分词器影响大）：
  `Output only the integers from 1 to 20, separated by commas, with no other text.`
- 三项等权（各 1/3，任一失败 → 67 分 → fail）：
  1. **字符/token 比**：`completion 文本长度 / completion_tokens ∈ [1.2, 10]`
     （ASCII 文本通常 3–5 字符/token；中文约 1–2）。`prompt` 的比例作为证据记录但不参与打分，
     避免系统提示词开销导致误杀。
  2. `completion_tokens ≤ max_tokens`（本次请求 `max_tokens: 128`）。
  3. `total = prompt + completion` 自洽；Gemini 额外把 `thoughtsTokenCount` 计入，容差 ±1。
- **阈值来源**：契约 §6.4 给出的 1.2–10；token 总量口径来自各协议官方文档。
- **局限**：不依赖官方基线（否则基线过期会误报）；只能发现「编造 usage」，不能证明模型身份。

### 4.7 `structured_output`（active，10，standard+，全协议）

- 要求只输出字面量 `{"answer":42,"tag":"ok"}`（`max_tokens: 128`）。
- **评分**（纯函数 `evaluateStructuredOutput`）：
  - 逐字符等于期望字面量 → 100；
  - 合法 JSON、键值正确但含多余空白/顺序差 → 90；
  - 合法且键值正确但被包 ```json 代码块 → 50（fail）；
  - 合法但键值错误 → 30；被包代码块且 JSON 非法 → 20；纯文本非 JSON → 10；空 → 0。
- `>= 70` 为 `pass`（只有真正「裸 JSON 字面量」通过）。
- **阈值来源**：契约 §6.4 的「检查是否被包 ```json 代码块」；分层分数为工程细化。
- **局限**：模型可以遵守格式但仍是假模型，权重仅 10。

### 4.8 `capability_tools`（active，10，standard+，全协议）

- 发一次真实 `add_numbers(2378, 1547)` 工具调用请求（各协议 tools/tool_choice/functionDeclarations 适配）。
- 检查：是否出现结构化工具调用、工具名是否 `add_numbers`、参数是否 `(2378,1547)`（可交换）、
  id 是否带官方前缀（Anthropic `toolu_`；OpenAI 非空 `call_` 风格；Gemini 允许无 id）。
- **评分**：按适用权重（present 40 / name 30 / arguments 20 / id 10）归一化；`>= 70` pass。
- **适用**：`lookupModel` 为 null → `skip`（`unknown_model`）；`supportsTools === false` → `skip`（不扣分）。
- **阈值来源**：LEARNINGS §4 第 5 条「无法区分模型不支持与中转站不支持」。
- **局限**：不支持工具调用的真模型也可能失败——能力表已尽量排除，但自定义模型会被 skip 而非判负。

### 4.9 `stream_integrity`（active，10，**full 档**，全协议）

- 同一提示词分别走非流式 / 流式（`max_tokens: 128`，`temperature: 0`），SSE 解析三协议。
- 三项等权（34/33/33，任一失败 → 67 分 fail）：
  1. 正文相似度 `≥ 85`（去空白/标点后的字符二元组 Dice 系数）；
  2. `input_tokens` 差值 `≤ max(3, 20%)`；
  3. `output_tokens` 差值 `≤ max(3, 20%)`。
- usage 缺失时对应项不适用、不参与归一（在 `details.usageCompared` 标注）。
- 流式请求被拒绝（非 401/403、非致命、非传输错误）→ 直接 `fail` 0 分：
  真实官方实现必然支持流式。
- **阈值来源**：契约 §6.4 的 85 / max(3,20%)；三项等权是为了「任一不一致都判失败」。
- **局限**：`temperature=0` 下两条路径仍可能有轻微文本差异（阈值 85 已留余量）。

### 4.10 `token_parity`（active，10，**full 档**，全协议）

- 与内置官方基线比较 `prompt_tokens` / `completion_tokens` 偏差：
  `diff ≤ tolerance` → 100；`≤ 2×tolerance+2` → 60；否则 20。
- **默认没有基线**（`baselines.js` 的 `BASELINES` 故意为空）：
  无基线 → `skip`（`reason: 'no_baseline'`），**不进入分母、不扣分**（契约 §6.4）。
  理由：硬编码基线会随模型/分词器/提示词版本过期，制造假阳性（LEARNINGS §3）。
- **局限**：当前默认永远不会实际运行；需要可信渠道实测基线后填入 `BASELINES` 才启用。

---

## 5. 运行器行为（契约 §6.7）

| 机制 | 实现 |
| --- | --- |
| 档位 | `quick` 前 3 项 / `standard` 前 8 项 / `full` 10 项；不选的检测器在报告里 `skip`（`reason: 'mode_not_selected'`） |
| `maxRequests` 硬上限 | 每次请求前检查；命中时抛内部 `BudgetExceededError`，runner 转 `skip`（`reason: 'request_budget_exhausted'`），**不会**转成 error |
| 串行 | `concurrency` 恒为 1（避免触发风控） |
| 超时 | 每请求 `options.timeoutMs`（默认 60000，clamp 500–300000），`AbortController` + `Promise.race` |
| 外部取消 | `options.signal` 透传到每个请求，取消记为 `error.kind: 'aborted'` |
| 异常兜底 | 检测器 `run`/`finalize` 抛错 → `status: 'error'`，不中断整体 |
| 致命错误短路 | 某个检测器返回 `details.fatal` / 致命文本 → 剩余主动检测器 `skip`（`reason: 'fatal_run_error'`），省费用 |
| 被动分发 | 请求完成后立即调用所有 `PassiveDetector.observe(ctx, exchange)`（异常吞掉并记 warning） |
| cost | `requests` 为实际发出的请求数；`promptTokens` / `completionTokens` 累加各响应 usage |
| key 安全 | 请求头在 exchange 中替换为 `••••`；返回报告前对全部字符串做 `scrubSecrets`（含 URL 编码形式） |
| 长上下文 | **不发**；`longContext: true` 只产生一条 warning |
| 模型能力 | `lookupModel` 为 null → 依赖能力的检测器 `skip`，并在 `warnings` 里解释原因 |

`estimateCost` 的请求数来自与 runner 相同的 `REQUEST_PLAN`（quick=4，standard=7–8，full=9–10），
token 数为粗略上界（thinking 档按 budget 2000 估算），仅供 UI 在**发请求前**要求用户确认。

> **请求数取舍（契约 v2.1 §6.4 已按实测冻结）**：契约 v2.1 明确记录
> `quick = 4`、`standard = 7（OpenAI/Gemini）/ 8（Anthropic，含 thinking 探针）`、
> `full = 9 / 10`，并注明「刻意比早期估算更低（减少用户扣费），是实现取舍而非漏实现」。
> 本实现坚持「每个检测器只发它真正需要的采样请求」：`model_consistency` 固定 3 次、
> `stream_integrity` 固定 2 条路径、其余主动检测器各 1 次；不发重复请求凑数。
> `estimateCost().requests`、runner 实际发出数、报告 `cost.requests` 三者**始终自洽**。
> 该说明同时写入了 `estimateCost().note`，UI 会在费用确认处原样展示给用户。

---

## 6. 安全红线（契约 §6.7）

1. API key 只存在于内存与请求头：不写 localStorage / 不写日志 / 不进报告。
2. `maskApiKey` 保留前 4 + 后 4（`sk-a••••cdef`），长度 ≤ 8 时全遮。
3. 报告返回前递归 `scrubSecrets`：任何位置（含错误信息、证据、URL）出现完整 key 都替换为脱敏形式。
4. 主动请求只发 chat completions / messages / generateContent，且受 `maxRequests` 硬限制；
   档位越高请求越多，UI 必须先展示 `estimateCost()` 并要求显式确认。

---

## 7. 离线自测记录

自测脚本为临时文件（`%TEMP%\auth-engine-selftest.mjs`，**不入库**），全部通过注入 transport 完成，
无任何网络请求。共 **149 项断言**（v2.1 新增 21 项），覆盖：

| 场景 | 结果 |
| --- | --- |
| 公开 API / 10 检测器名称、权重、顺序、kind、critical | ✅ 与契约 §6.4（v2.1）逐项一致；`thinking_signature.critical === true` |
| 正常 Anthropic 上游（full 档） | ✅ `excellent`（97.6），thinking 100 且无 critical，token_parity skip |
| thinking 请求参数（sonnet-4-5 adaptive / opus-4-1 enabled） | ✅ 顶层 `output_config.effort`、非流式、`max_tokens=16000`、无 `temperature`、探针 GCD(2378,1547) |
| thinking 四档：无块 / 无签名 / 签名<50 / 正常 | ✅ 0/30/70/100，status 分别为 fail/fail/pass/pass |
| **v2.1** thinking 缺失签名 critical | ✅ 无块(0)与无签名(30) 各 1 条 `missing_thinking_signature`，报告级封顶 `marginal`；短签名(70)/正常(100) 无 critical、verdict 不降级 |
| 模型不支持 thinking（claude-3-5-haiku-20241022） | ✅ `skip`（model_capability_missing），**不产 critical**，总分 = 未 skip 项加权平均（96.67），verdict `excellent` |
| 跨厂商泄漏（`claude_*` / `input_tokens` / `usage_source: anthropic`） | ✅ `fail` + criticalIssues；full 档分数 78.9 仍被 verdict 封顶为 `marginal` |
| **v2.1** `node tools/check.mjs --demo` 四场景 | ✅ genuine → `excellent`(0 critical) / kiro → `marginal`(1) / leak → `marginal`(2) / dead → `invalid`(0) |
| 干净 OpenAI 响应 | ✅ `cross_vendor_leak` pass，quick 档 100 分 |
| 余额不足 `insufficient_quota` | ✅ `verdict: invalid`，`runError.code: insufficient_quota` |
| `model_not_found` / 「无可用渠道」 | ✅ `verdict: invalid`，`runError.code: model_unavailable` |
| transport 全部抛错 | ✅ 不抛异常，`verdict: invalid`，`runError: null`（普通网络错误不误判为无效） |
| `maxRequests=0` → 全 skip | ✅ `verdict: invalid`，10 项全 skip，未发请求 |
| `maxRequests=2` 硬上限 | ✅ 实际请求数 2；超出项 `skip` + `reason: request_budget_exhausted` |
| key 脱敏 | ✅ 报告 JSON 不含完整 key；`maskApiKey` 前 4 + 后 4；鉴权头不在报告里 |
| 流式文本不一致 / input_tokens 差 10 倍 / 完全一致 | ✅ fail / fail / pass |
| estimateCost 形状与请求数 | ✅ quick=4，standard > quick；未知模型 note 解释 skip |
| Gemini / OpenAI 三协议冒烟 | ✅ 不崩溃，形状合法 |
| 检测器直连 run()（离线单测路径） | ✅ 返回合法 DetectorResult |
| 模型能力表（日期后缀前缀匹配、未知模型 null） | ✅ |

同时 `npm test`（v1 + contract v2.1 + auth-scorer/auth-detectors/auth-runner）**177 项全绿，0 fail 0 skip**，无回归。

---

## 8. 已知局限与后续工作

1. **token_parity 默认永远 skip**：这是刻意的（宁可不测也不伪造基线）。需要可信的官方实测基线
   才能启用；基线格式见 `baselines.js` 注释。
2. **thinking 签名只覆盖 Anthropic**：OpenAI 的 reasoning token / Gemini 的 thoughts 都不能作为
   「加密级」证据，本版本没有对应检测器（契约 §6.4 也未要求）。
3. **识别「模型是否被换成同厂商低配版」能力有限**：例如 `gpt-4o` 被换成 `gpt-4o-mini`，
   仅靠 `model_consistency` 的回显与长度稳定性不足以稳定识别。
4. **`model_consistency` 的 CV 假设**：依赖 `temperature=0` 的确定性；部分上游即使温度 0 也有随机性，
   阈值 0.15 / 0.4 是保守工程值，可能漏判轻微波动。
5. **HTTP 错误语义因中转站而异**：`fatalRunError` 依赖错误文本/类型特征；
   如果某个中转站用极不规范的错误报文，可能无法识别为「检测无效」，但也不会误判为「站差」——
   此时表现为 `status: 'error'`（不进入分母）。
6. **不做「身份问句」**：模型可以被人为注入 system prompt 冒充身份，因此本引擎不用「你是谁」
   作为判据（与 LEARNINGS §5 一致）。
7. **`redacted_thinking` 按「有块无签名」计 30 分**：契约只定义四档；如果未来确认 redacted 块
   也应视为强证据，需要 Lead 更新契约后再调整。
8. **并发恒为 1**：为了降低风控风险牺牲了速度；`concurrency` 选项被忽略（是契约默认值）。
9. **请求数按成本取舍压缩**：standard 7–8 / full 9–10。契约 v2.1 §6.4 已把该实测值写入冻结表，
   并注明「刻意比早期估算更低（减少用户扣费），是实现取舍而非漏实现」；
   `estimateCost().requests` / 实际请求数 / `cost.requests` 三者自洽。详见 §5 的说明。

---

## 9. v2.1 变更记录

**日期**：2026-10-19　**契约依据**：`docs/CONTRACT.md` v2.1 §6.3 / §6.4 / §8.3（Lead 更新，FROZEN）

### 9.1 背景：端到端验收暴露的真实产品缺陷

`node tools/check.mjs --demo kiro`（模拟 Kiro / Amazon Q 式冒充：拿不到 Claude thinking 签名，
其它协议字段全部正常）在 v2.0 下输出：

```
真伪评分 73.913 / verdict = passed（通过）
检测器：thinking_signature fail 0 w=25，其余 7 项全部 pass 100
```

**问题**：最重要的那条证据（权重 25 的 thinking 签名）被 7 条 100 分的廉价结构项按加权平均
「淹没」了，冒充者被判「通过」。这恰好是 critical 一票降级机制要解决的场景，但
`thinking_signature` 在 v2.0 不产 critical，机制没有生效。

### 9.2 修复（仅 `src/core/auth/detectors/thinking-signature.js`）

1. 检测器元信息 `critical: false` → **`critical: true`**（契约 v2.1 §6.4 表：`是（仅缺失签名时）`）。
2. `status: 'fail'` 且 `score <= 30`（无 thinking 块 = 0 / 有块无签名 = 30）时产出：
   ```js
   criticalIssues: [{
     code: 'missing_thinking_signature',
     message: '拿不到 Claude 服务端 thinking 签名，上游不是真实 Anthropic 实现（可能是 Kiro/Amazon Q/Bedrock 简化通道或签名被剥离）',
     evidence: { score, thinkingBlockSeen, signatureReceived, signatureLength }
   }]
   ```
3. 边界（刻意不扩大打击面）：
   - `score === 70`（签名过短）**不报** critical——弱证据，只扣分；
   - 模型不支持 thinking / 未知模型 → `skip`，**绝不报** critical（haiku 场景保持优秀且总分 100）；
   - 上游拒绝 thinking 参数（对「声明支持 thinking」的模型）→ fail 0 且同样报
     `missing_thinking_signature`（拿不到签名的事实一致），evidence 额外带 `requestRejected`。
4. `effectiveVerdict` 无需改动：criticalIssues 非空即把 `passed` / `excellent` 封顶为 `marginal`。

### 9.3 修复后端到端结果（`node tools/check.mjs --demo <scenario>`，本地假中转站，不联网）

| 场景 | 真伪评分 | verdict | summaryText | criticalIssues | 说明 |
| --- | --- | --- | --- | --- | --- |
| `genuine`（诚实转发、签名正常） | 95.65 | `excellent` | 优秀 | **0** | 不误伤真上游 |
| `kiro`（无 thinking 块冒充） | 73.91 | **`marginal`** | 基本合格 | **1**（`missing_thinking_signature`） | 高分不再能「通过」 |
| `leak`（GPT 请求被转给 Claude，跨厂商泄漏） | 67.06 | `marginal` | 基本合格 | 2（`cross_vendor_*`） | 原有 critical 机制保持 |
| `dead`（模型渠道不存在） | 0 | `invalid` | 检测无效 | 0 | 仍为「检测无效」，不是低分 |

> 注意 `kiro` 的**分数保持 73.91 不变**（critical 与分数解耦），变的只是 verdict 从
> `passed` 封顶为 `marginal`——UI 必须把 criticalIssues 红色横幅置于评分之上，否则用户会困惑。

### 9.4 回归

- auth-test 新增 v2.1 断言（检测器表 `critical: true`、无块/无签名 critical + marginal、
  短签名不 critical 且不降级、skip 不 critical 且总分 100、报告级 criticalIssues 形状）。
- 我的离线自测同步新增「missing_thinking_signature critical / 70 分不 critical / skip 不 critical」
  断言；`npm test` 全量门禁全绿。
- 请求数取舍同步写入契约 v2.1 §6.4（quick=4 / standard 7–8 / full 9–10），
  与 `estimateCost()`、runner 实际请求数、`cost.requests` 三者一致。
