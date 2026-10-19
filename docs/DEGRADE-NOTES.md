# 降智诊断引擎（`src/core/degrade/**`）实现笔记

> 归属：degrade-core。契约依据：`docs/CONTRACT.md` §9–§14（FROZEN v3 / v3.1）。
> 本文件记录解析器口径、13 个指标的定义与阈值来源、评分语义、自测场景与已知局限；
> **不是契约的替代**，两者冲突时以契约与测试为准。

---

## 0. 定位声明（必须与 UI 保持一致）

这不是 IQ 测试，也不是「能力测量」。它从**用户自己的使用日志**里提取**可观测的行为变化**
（输出变短、token 膨胀、被截断、thinking 消失、模型字段漂移、错误率上升、延迟恶化…），
做**前后期对比**，结论是「统计上存在/不存在系统性变化的迹象」，**不是**「模型一定变笨了」。
输出变短也可能是任务分布变化、系统提示词变化或缓存策略变化。

---

## 1. 公开 API（契约 §10.2 / §10.3，FROZEN）

```js
import {
  parseLogFiles,        // async（本实现同时兼容忘记 await 的同步调用，见 §3.1）
  analyzeDegradation,   // sync，绝不抛异常
  scoreDegradation,     // 契约 §12 纯函数
  DEGRADATION_METRICS,  // 13 个指标定义（id / label / unit / weight / worseDirection / critical / definition / compute）
  SUPPORTED_FORMATS     // ['claude-code','api-log','usage-csv','chatgpt-export','codex-rollout']
} from './src/core/degrade/index.js';

const parsed = await parseLogFiles({
  files: [{ name: file.name, text }],          // 浏览器端由 FileReader 读成 {name,text}
  limits: { maxFiles: 20, maxBytesPerFile: 64 * 1024 * 1024, maxRecords: 200000 }
});
// → { records, files:[{name,format,confidence,total,parsed,skipped,error}], warnings, stats:{lines,bytes,timeRange,models} }

const report = analyzeDegradation({
  records: parsed.records,
  options: { minRecords: 20, minSpanMs: 0, segment: 'auto' } // segment: 'auto' | 'early-recent'
});
// → DegradationReport（契约 §10.3）
```

额外便利导出（不影响契约）：`detectFormat` / `parseWithFormat` / `segmentRecords` /
`scrubRaw` / `assertScrubbed` / `METRIC_IDS` / `METRICS_BY_ID` / `FORMAT_LABELS` / `SUMMARY_TEXT`。

**永不抛异常**：
- `parseLogFiles`：单文件失败写 `files[].error` 后继续；整体异常返回空结果 + warning；
- `analyzeDegradation`：空 / 垃圾 / 内部异常一律返回合法的 `insufficient` 报告；
- 单个指标 `compute` 抛异常只让该指标 `status: 'insufficient'`，不影响其它 12 个。

---

## 2. 文件结构

| 文件 | 职责 |
| --- | --- |
| `index.js` | 契约 §10.2 解析入口 + §10.3 分析入口 + 报告组装 / 隐私剥离 |
| `constants.js` | 冻结常量（指标权重、critical 阈值、评分阈值、上限、噪声死区） |
| `util.js` | 纯工具（数字/中位数/饱和函数/字节数/短标签） |
| `normalize.js` | 半成品字段 → 契约 §10.1 LogRecord（时间戳单位容错、模型名归一、provider 推断） |
| `scrub.js` | `scrubRaw()` 递归剥离 + `findScrubViolations()` / `assertScrubbed()` 独立断言 |
| `segment.js` | 前后期切分 + 变化点探测（采样评估，避免 O(n²)） |
| `findings.js` | 指标 → 契约 §10.5 Finding（critical 阈值严格按 §11） |
| `scorer.js` | 契约 §12 `scoreDegradation` + `badnessOf` / `isUsableMetric` |
| `parsers/*.js` | 五种格式解析器 + 内容打分式自动识别（`detect.js`）+ 注册表 |
| `metrics/*.js` | 13 个指标（一指标一文件）+ `util.js` + `index.js` 注册表 |
| `parsers/codex-rollout.js` | v3.1 新增：Codex CLI `~/.codex/sessions/**/rollout-*.jsonl` |

纯逻辑模块均可在 Node 下直接 `import`，不触碰 `document` / `window` / `FileReader`。

---

## 3. 解析层口径

### 3.1 `parseLogFiles` 的「同步 + 可 await」兼容

契约 §10.2 把入口声明为 `async`，所以必须支持 `await parseLogFiles(...)`。
但契约测试 / 调用方也可能忘记 `await` 而直接读 `result.records`。
实现返回一个**既携带结果字段、又可被 await 的 thenable**（`then` 为不可枚举属性）：
同步调用拿到 `{records, files, warnings, stats}`；`await` 调用拿到同一份数据的普通对象。
两种方式都不会拿到 Promise 内部的空字段，也不改变契约语义。

### 3.2 LogRecord 归一化（契约 §10.1）

- **时间戳**：支持 ms / 秒 / 微秒 / 纳秒数字、13 位 ms、10 位秒、8 位 `YYYYMMDD`、
  ISO 8601、`YYYY-MM-DD HH:mm:ss`（无时区按 UTC）、`YYYY/MM/DD`、`YYYY年M月D日 H:m:s`。
  **无法可靠识别时为 `null`，绝不伪造**；`null` 记录不参与时间切分（只在 `coverage.untimed` 体现）。
- **模型名**：响应侧 `model` / 请求侧 `requestModel` 分别保留；判断「是否同一模型」时用
  `normalizeModelName()` 去掉厂商前缀（`anthropic/`、`bedrock.`）、`@20241022`、`-20241022`、
  `-2024-08-06`、`-latest` / `-preview`、大小写 / `_` / `.` 差异。
  因此 `claude-sonnet-4-5` 与 `claude-sonnet-4-5-20250929` 视为同一模型，
  而 `claude-sonnet-4-5` 与 `claude-3-5-haiku-20241022` 视为不同模型。
- **provider**：显式字段优先，其次模型名 / 响应 id 指纹（`msg_` → anthropic、`chatcmpl-` → openai）。
- **finish_reason**：截断类统一成 `length` / `max_tokens`，其它保留小写。
- **status**：只接受 100–599，其它 `null`（不把缺失当成功）。
- **文本上限**：`promptText` ≤ 4000 字符、`completionText` ≤ 8000 字符（只进内存，报告前剥离）。
- **`raw` 字段**：契约要求「仅内存」。实现为**不可枚举属性**：正常读取 `record.raw` 可用，
  但即使有人误把 records 直接 `JSON.stringify`，也不会带出日志原文（纵深防御）。
- **两个内部提示位**（非契约 §10.1 字段、不可枚举、不进报告）：
  - `completionObserved`：是否真的观测到完成内容（区分「空回答」与「日志没记文本」）；
  - `hasThinking`：Codex 等没有 thinking token 字段的格式，用「该轮是否有 reasoning 项」提示。

### 3.3 五种格式解析器

通用策略：每行 / 每行记录**字段容错**；只产出 assistant / usage 记录；
user / system / 工具调用 / 元数据行计入 `files[].skipped`（`parsed + skipped = total`）。

| 格式 | 识别要点 | 记录来源 | 关键字段映射 |
| --- | --- | --- | --- |
| `claude-code` | JSONL，`type ∈ {assistant,user,system}` + `message` 结构；有 `sessionId` / `parentUuid` / `cwd` 加分 | `type:'assistant'` 行 | `message.usage.{input_tokens,output_tokens,cache_creation_input_tokens,cache_read_input_tokens}`、`message.model`、`message.stop_reason`、`content[]` 的 `thinking` / `signature` / `text`、顶层 `timestamp` / `durationMs` / `sessionId` |
| `api-log` | JSONL（或整文件响应数组），每行像 API 响应：`usage` / `request+response` / `choices` / `content+stop_reason` / `status` | 「确实发生响应」的行（错误响应也算，用于错误率） | OpenAI Chat（`choices[0].message` / `usage.prompt_tokens`）、OpenAI Responses（`output[]` / `input_tokens` / `*_tokens_details`）、Anthropic（`content[]` / `stop_reason` / `input_tokens`）、Gemini（`candidates[].content.parts` / `usageMetadata.*TokenCount`）、`latency_ms` / `duration_ms` / `status` / `error.code` |
| `usage-csv` | 首个可识别表头（≥2 个已知列）+ 数据行；分隔符自动识别 `,` / `\t` / `;`；剥离 BOM / CRLF；支持中英表头 | 每条数据行 → `kind:'usage'` | `timestamp/model/request_model/prompt_tokens/completion_tokens/cache_read_tokens/cache_creation_input_tokens/thinking_tokens/finish_reason/latency_ms/status/error_code`，中文别名 `时间/模型/请求模型/输入/输出/缓存读取/思考/结束原因/延迟/状态/错误`，OpenAI usage dashboard `n_context_tokens_total` / `n_generated_tokens_total` |
| `chatgpt-export` | 整文件 JSON：会话数组（或 `{conversations:[...]}`），元素含 `mapping` 节点树 | `mapping` 里 `message.author.role === 'assistant'` 的节点 | `content.parts[]`、`metadata.model_slug`、`create_time`（秒）、`metadata.finish_details.type`；**没有 token / requestModel，字段留 null** |
| `codex-rollout` | JSONL，`type` ∈ {`session_meta`,`turn_context`,`event_msg`,`response_item`,`token_usage_record`,`world_state`} 的比例 > 30% | `event_msg.payload.type === 'token_count'` → usage；`response_item.payload.role === 'assistant'` → assistant；`turn_aborted` → 失败记录 | `payload.info.last_token_usage.{input_tokens,output_tokens,reasoning_output_tokens,cached_input_tokens,cache_write_input_tokens}`；`turn_context.payload.model`；`thread_settings.model`；`duration_ms` / `time_to_first_token_ms` |

Codex 专属细节（依据用户真实样例核对）：

- **去重**：`token_usage_record` 与 `event_msg/token_count` 内容重叠，只采用后者；
- **thinking**：`response_item.payload.type === 'reasoning'`（含 `encrypted_content`/`summary`）表示
  该轮有推理；**不设置** `hasThinkingSignature`（它不是 Claude 的签名）；
  usage 记录的 `reasoning_output_tokens` 直接映射到 `thinkingTokens`；
- **无 finish_reason**：一律 `null`，禁止编造 → `truncation_rate` 对该格式自动 `insufficient`；
- **失败信号**：`turn_aborted` → `kind:'assistant'`、`status:499`、`errorCode:'turn_aborted'`、空文本；
- **延迟**：`task_complete.payload.duration_ms`（其次 `time_to_first_token_ms`）→ 记到对应完成记录；
- **占位消息（v3.1 修复）**：`response_item` 的 assistant `content` 只有空白（用户真实样例里 27/41 条
  是单个空格）时**跳过**——它们是 Codex 的 keepalive / 进度占位消息，不携带任何回答信号。
  若计入会被 `empty_rate` 误判成「上游返回空响应」；真正的空响应由 usage 记录
  （`completion_tokens === 0`）或其它格式的 `completionObserved` 记录承载，不会丢失。

### 3.4 格式自动识别（契约 §14.2：不能只看扩展名）

`parsers/detect.js` 对内容打分（0..1），取最高分；低于 0.3 → `unknown`；
同分按 `chatgpt-export > codex-rollout > claude-code > api-log > usage-csv` 优先。
**`name` 参数不参与判定**，所以把 Claude Code JSONL 命名成 `.csv` / `.log` / 无扩展名
仍然识别为 `claude-code`（已自测，见 §8）。

### 3.5 解析上限（契约 §10.2）

| 限制 | 默认值 | 行为 |
| --- | --- | --- |
| `maxFiles` | 20 | 超出部分不处理 + warning |
| `maxBytesPerFile` | 64 MB | 该文件 `error`、跳过，其它文件继续 |
| `maxRecords` | 200000 | 按时间戳**保留最近的 N 条**（不是最早 N 条）；`files[].total` 为真实总条数、`files[].skipped` 为真实丢弃数，并写 warning |

---

## 4. 前后期切分与变化点（`segment.js`）

- `segment: 'early-recent'`：按时间排序后**按记录数均分**；
- `segment: 'auto'`（默认）：
  1. 按时间戳排序（时间相同按 `index`）；时间戳 `null` 的记录**不参与切分**；
  2. 采样评估候选切分点：主窗口 20%–80%（步长 5%）+ **边缘窗口**（最近 15% / 10% / 7.5% / 5% vs 其余），
     用 6 个健康特征（`completionTokens` / `latencyMs` / 截断 / thinking / 模型一致 / 错误）
     做全局稳健标准化（中位数 + MAD），得到每条记录的健康分 `z`；
  3. 对每个候选点比较前后期 `z` 中位数之差，取差异最大者；
     **差异度相同时取更接近 50% 的候选**（否则会把切分点推到 20% / 80% / 95% 边界）；
  4. 差异度 < 0.2 视为「没有可识别变化点」，退回按记录数均分（避免稳定数据被切出假变化点）；
  5. 数据量大时先等距采样（≤5000 条）再评估，整体 O(n)。
  边缘窗口用来覆盖最常见的「**最近这段才变笨**」：只退化最近 5%–15% 时，
  主窗口会把它平均掉而漏判（v3.1 修复）。
- 输出 `segments: { early:{count,from,to}, recent:{count,from,to}, splitAt }`，
  `splitAt` 是「近期第一条记录」的时间戳；`notes` 里会说明用了哪种切分。

---

## 5. 13 个指标（契约 §11 冻结 id / 权重）

| # | id | 口径（`definition` 同款） | 变差方向 | 权重 | critical |
| --- | --- | --- | --- | --- | --- |
| 1 | `truncation_rate` | `finish_reason ∈ {length,max_tokens}` 占比 | 上升 | 1.4 | >15% 且较早期翻 5 倍 |
| 2 | `model_substitution` | 响应 `model` 与请求 `requestModel` 不一致占比（模型名归一后比较） | 上升 | 1.5 | >10% |
| 3 | `thinking_presence` | 含 thinking 块 / 思考 token 的记录占比 | 下降 | 1.3 | 早期 >50% 且近期 ≈0（实现取 ≤5%） |
| 4 | `thinking_share` | thinking tokens / 输出 tokens（缺字段时按 thinking 文本字符数/4 估算） | 下降 | 1.1 | — |
| 5 | `token_inflation` | 回答字符数 / 输出 token 的中位数 | 下降 | 1.2 | 降幅 >40% 记 warning |
| 6 | `output_length` | 输出 token 中位数 | 下降 | 1.0 | — |
| 7 | `completion_ratio` | 输出 token / 输入 token 中位数 | 下降 | 0.7 | — |
| 8 | `latency_median` | 端到端延迟中位数 | 上升 | 0.8 | — |
| 9 | `error_rate` | 非成功响应（status≥400 / errorCode）占比 | 上升 | 1.2 | — |
| 10 | `refusal_rate` | 命中拒答话术的回答占比 | 上升 | 0.6 | — |
| 11 | `repetition_rate` | 回答内部重复 4-gram 平均占比 | 上升 | 0.7 | — |
| 12 | `empty_rate` | 空回答（观测到完成内容、无文本且输出 token 为 0/缺失）占比；纯空白且无 token 的占位消息不进分母 | 上升 | 0.9 | — |
| 13 | `cache_hit_rate` | 缓存读取 token / 输入 token 总量 | 下降 | 0.5 | — |

### 5.1 为什么这些方向算「变差」

- 截断率、延迟、错误率、拒答、重复、空回答**上升**：直接对应「回答被打断 / 变慢 / 出错 /
  不敢答 / 车轱辘话 / 空响应」——用户在日志里能直接感知的质量下降。
- 输出长度、输出/输入比、thinking 出现率与占比、字符/token 比、缓存命中**下降**：
  回答变短、推理消失、同样文字被算更多 token、缓存失效，都是「变廉价 / 被替换」的典型痕迹。
- 注意：这些都只是**行为相关性**，不是因果证明；报告与 UI 必须同时展示免责声明。

### 5.2 样本闸门与「不冒充 0 分」

- 每个指标要求**早期/近期各有 ≥5 个有效样本**才 `status:'ok'`；
  否则 `status:'insufficient'`，**不进入评分分母**，也不把缺失值展示成 0（契约 §11 末注 / §12）。
- 每个指标的 `samples` 是该指标自己的分母（不是全部记录数），例如 `truncation_rate`
  只统计有 `finish_reason` 的记录；`chatgpt-export` 没有 token 字段，token 类指标自然 `insufficient`。
- `series` 为 `[{t,v}]`：记录数 ≤500 时每记录一点；>500 时等分 500 桶取中位数（rate 指标取均值），
  因此永远 ≤500 点（契约 §10.4）。`t` 缺失时为 `null`。

### 5.3 噪声死区（实现口径，非契约）

纯比例/中位数指标在小样本下会有大幅相对波动，为避免把噪声判成趋势，`direction` 加两层死区：

1. **绝对死区**（`constants.METRIC_MIN_DELTA`）：如 `truncation_rate` 变化 ≤2pp 记 flat、
   `output_length` ≤5 tok 记 flat、`latency_median` ≤50ms 记 flat；
2. **相对死区**：`|deltaPct| < 5%` 记 flat。

`deltaPct` 本身仍按契约展示（不是 0），只是 `direction` 不被噪声拉动；
`badness` 只在 `direction === 'worse'` 时计入评分。

对「早期为 0」的指标（如截断率从无到有）：`deltaPct = null`（相对变化无定义），
`badness` 用绝对变化量 `|recent-early| / 0.5` 兜底；critical 判定用绝对阈值，不依赖除法。

### 5.4 `empty_rate` 与「占位消息」（v3.1 修复的假信号）

`empty_rate` 的分母只收**确实观测到完成内容**的记录，规则：

- `completionObserved === false` → 不进分母；
- 文本非空白 → 进分母（用来判「非空」）；
- 有 token 计数字段（`completionTokens` 数值）→ 进分母：
  `0` 是真实空回答；`>0` 是「有 token 没文本」，同样算可疑信号；
- `completionObserved === true` 但「纯空白 + 没有 token 记录」→ **不进分母**。
  这正对应 Codex 的 keepalive 空格消息、OpenAI `tool_calls`-only 响应的 `content: null`：
  它们是日志占位符 / 非文本响应，不是「上游返回空响应」。

同时 Codex 解析器在解析阶段直接跳过纯空白的 assistant 消息（见 §3.3），
避免这些记录污染 `output_length`/`repetition` 等其它指标的分母。

---

## 6. 评分与判定（契约 §12 v3.1）

```js
badness_i = clamp(|deltaPct_i| / 0.5, 0, 1)      // 仅当 direction === 'worse'
score     = 100 × Σ(badness_i × weight_i) / Σ(weight_i)   // 分母只含 status === 'ok'
evidenceStrength = saturate(可用指标数 / 4) × saturate(usable / 50)
saturate(x) = x / (x + 1)
```

- `usable` = 参与分析的记录数（`kind` 为 assistant / usage），**不是**全部解析行；
  `coverage.records` 仍是全部记录。30 条 + 13 指标 → 0.287 < 0.35 判 `insufficient`；
  100 条 + 5 指标 → 0.371 可以出结论（v3.1 修正了「单次会话永远 insufficient」）。
- 判定顺序（冻结）：
  1. `可用指标数 < 3` 或 `usable < minRecords` → `insufficient`
  2. 存在 criticalIssue → `likely-degraded`（无论分数）
  3. `evidenceStrength < 0.35` → `insufficient`
  4. `score >= 60` → `likely-degraded`；`score >= 30` → `suspicious`；否则 `stable`
- `summaryText` 严格使用契约四个字符串；`score` 与 `evidenceStrength` **分开**给出，不合并。
- **先舍入、后判定**（v3.1 修复报告自相矛盾）：判定使用报告里实际展示的
  `round(score, 2)` 与 `round(evidenceStrength, 4)`，保证 `verdict` 与 `report.score`
  永远自洽 —— 不会出现「score=60 但 verdict=suspicious」或「evidenceStrength=0.35 但 insufficient」。
- `minSpanMs` 默认 0（v3.1）：时间跨度不再卡结论；跨度 < 6 小时只写 `notes`
  「趋势判断置信度较低」。`insufficient` 时 `notes` 会给出「还缺多少条 / 可用指标数 / 证据强度」
  的具体建议（UI §13.5 直接展示）。

### 6.1 Findings（契约 §10.5）

- critical 严格按 §11：`truncation_spike`（>15% 且翻 5 倍）、`model_substitution`（>10%）、
  `thinking_collapse`（早期 >50% 且近期 ≤5%）；
- warning / info 覆盖其余「明显变差」的指标：输出长度下降、token 膨胀、thinking 占比下降、
  延迟上升、错误率上升、拒答率上升、重复度上升、空回答上升、缓存命中下降；
- 生成 condition 统一要求 `metric.status === 'ok'`；detail 只用计数 / 比例 / 中位数 / 模型名，
  **绝不包含日志原文或文件路径**（契约 §9.2）。

---

## 7. 隐私实现（契约 §9.2，最高优先级）

三层防御：

1. **解析期**：日志原文只存在内存 `LogRecord.promptText/completionText` 与不可枚举 `raw` 上；
   文本有长度上限；
2. **报告组装后**：`scrubRaw(report)` 深拷贝并递归删除敏感键
   （`raw / rawLine / rawText / promptText / completionText / text / filePath / fileName / filename / path / lines`）；
3. **断言**：`assertScrubbed(report)` 独立遍历（不依赖剥离函数）检查敏感键，
   失败则内部捕获并降级为 `insufficient` 报告 —— 对外永不抛异常，也永不泄漏。

报告允许出现的只有：计数、比率、中位数、时间戳、模型名、指标 id/文案、finding 文案。
`parseLogFiles` 的 `files[].name` 是契约 §10.2 明确要求给 UI 展示的**解析结果**字段，
不会进入 `DegradationReport`。

---

## 8. 自测（离线合成日志 + 真实样例 + 验收）

自测脚本写在 `%TEMP%`（未入库），以下为实际运行结果。

### 8.1 五种格式解析与伪装扩展名

| 文件 | 自动识别 | 记录数 | 说明 |
| --- | --- | --- | --- |
| `claude-code-stable.jsonl`（336 行，user+assistant） | `claude-code` | 168 | 跳过 168 行非 assistant 消息 |
| `api-log-stable.jsonl`（168 行） | `api-log` | 168 | 0 跳过 |
| `usage-stable.csv`（BOM + CRLF，168 行数据） | `usage-csv` | 168 | 0 跳过 |
| `chatgpt-export-stable.json`（6 会话 × 4 轮） | `chatgpt-export` | 24 | 只取 assistant 节点 |
| `codex-rollout-stable.jsonl` | `codex-rollout` | 336 | 168 usage + 168 assistant |

伪装扩展名：同一份 Claude Code 内容命名为 `weird.csv` / `weird.log` / `noext` / `data.json`，
全部仍识别为 `claude-code` ✅。

### 8.2 三种结论场景

| 场景 | 结果 |
| --- | --- |
| 稳定（5 个格式合并，864 条可用记录） | `verdict=stable`、`score≈2.3`、`evidenceStrength≈0.72`、0 critical |
| 退化（合并） | `verdict=likely-degraded`、`score≈61.2`、critical = `truncation_spike` / `model_substitution` / `thinking_collapse`（截断率 0.3%→22.9%、模型替换 0.2%→48.8%、thinking 66.7%→0） |
| 样本不足（5 条） | `verdict=insufficient`、`score=0`、`notes` 含「还缺 N 条 / 可用指标不足」建议；**不是 stable，也不是「退化 0 分」** |

其余评分语义单测：1 个满分恶化指标 + 12 个 `insufficient` → `score=100`（不是被 13 摊薄）；
`deltaPct` 反向变化 → badness=0；只有一条 `model_substitution` critical → `likely-degraded`；
「只有 token 类指标可用 + 中等恶化」（200 条）→ `suspicious`。

### 8.3 脏数据 / 上限 / 鲁棒性

- 混入坏 JSON、空行、BOM、CRLF、10 万字符非法单行：不抛异常，好行保留，坏行计入 `skipped`；
- 单文件完全无法识别 / 解析失败：`files[].error` 记录，其它文件照常解析；
- `maxFiles` / `maxBytesPerFile` / `maxRecords` 均生效（超限文件 `error`、超限记录截断 + warning）；
- 空输入 / `null` / 字符串 / `[null,42,'x',{}]` → 合法 `insufficient` 报告，不抛异常；
- 时间戳 `null` 记录：计入 `coverage.records`、不进前后期切分（`coverage.untimed` 体现），
  报告的 `segments` 只含带时间戳记录；
- **占位消息假信号回归**：构造 40 轮 Codex 日志（其中 10 条 assistant 消息的 `content` 是单个空格 `" "`），
  解析后这些占位消息被跳过，`empty_rate` 为 **0 / 0（flat）**，不产生任何 empty 相关 finding；
  同时「有 token 但无文本」的记录仍会被算作空回答（没有被放宽语义）；
- 50,000 条记录完整分析约 **1.0 s**（本机），所有 `series` ≤500 点。

### 8.4 真实 Codex rollout 样例（只读，未入库）

用户提供的 `~/.codex/sessions/2026/10/13/rollout-*.jsonl`（365 行 / 2.7 MB / 单会话）：

- 识别 `codex-rollout`（confidence 1.0），解析出 **67 条可用记录**
  （48 条 usage + 19 条 assistant）；跳过 298 行（元数据 / 工具调用 / 重复的 `token_usage_record` /
  **27 条纯空白的 keepalive 占位 assistant 消息**）；
- `thinkingTokens` 非空记录 48 条；`finishReason` 全部为 `null`（该格式无此字段）；
- 模型 `gpt-6-astra`，`requestModel` 同为 `gpt-6-astra`；
- **`empty_rate` = 0 / 0（flat，early 0 / recent 0），不再触发 `empty_rate_spike` warning**；
  修复前它被 27 条空格占位消息抬到 23.9%→50%（假信号）；
- 报告 `verdict=suspicious`、`score≈46.0`、`evidenceStrength≈0.364`（单会话 0.8 小时；
  findings 为 `thinking_share_drop` / `output_length_drop` / `completion_ratio_drop`，
  其中 thinking 占比 8.4%→2.9%、输出 token 中位数 232.5→137 属于该会话内的真实变化，
  `notes` 已提示「时间跨度较短，趋势判断置信度低」，故保留为 warning 而非 critical）；
- 隐私断言：`JSON.stringify(report)` 不含文件路径、文件名、`"raw"`、对话原文片段（抽样 30 字符验证）；
  `coverage.bySource` 中的 `codex-rollout` 是格式 id，不是文件名。

### 8.5 复核修复回归（S1 / S2 / S3）

针对独立复核（auth-engine）提出的三条建议，修复后实测：

- **S1 舍入自洽**：构造 badness=0.6 的 3 个指标 → `score=60` 且 `verdict=likely-degraded`；
  badness=0.3 → `score=30` 且 `verdict=suspicious`（修复前会出现 `score=60 / suspicious`）。
  判定与 `report.score` 永远一致。
- **S2 大日志保留最近**：300,000 行 Claude Code JSONL + `limits.maxRecords=1000` →
  保留**时间最新**的 1000 条（首条 = 第 299,000 条的时间戳）、`files[].total=300000`、
  `files[].parsed=1000`、`files[].skipped=299000`、`warnings` 明确写「已按时间戳保留最新 1000 条，
  丢弃 299000 条较早记录」，耗时约 1.0s；行序乱序（时间戳乱排）时同样按时间戳取最新
  （`test/degrade-parsers.test.mjs` 的 S2 关键回归已覆盖）。
- **S3 边缘窗口变化点**：1,000 条记录里只有**最后 50 条**退化 →
  `verdict=likely-degraded`，变化点落在后段（early/recent ≈ 925/75），
  `truncation_spike` critical（近期截断率 16% vs 早期 0），不再误判 `stable`。
  稳定场景仍为 `stable`（差异度 < 0.2 时退回均分）。

### 8.6 回归与验收

- `npm test`：**226 项全绿**（含 v1 81 项、v2 96 项、v3 契约/解析/指标/分析测试）；
- `node tools/acceptance-degrade.mjs`：**30/30 通过**。
  注：该脚本当前在 Windows 下用 `await import(path.join(...))` 直接加载绝对路径，
  会被 Node 当作 `c:` 协议而失败；本地验证时用 `pathToFileURL()` 修正后运行通过，
  已把修正点报给 Lead（不改动 `tools/`）。

---

## 9. 已知局限

1. **日志质量决定一切**：字段缺失（无 usage / 无文本 / 无 requestModel）会让对应指标
   `insufficient`；报告会在 `notes` 里列出哪些指标被排除。
2. **「thinking 是否发生」在不同格式里含义不同**：Claude Code / Anthropic 有内容块与签名；
   `api-log` 纯文本响应无法区分「没开 thinking」与「日志没记」，因此 `thinkingChars` 留 `null`
   （不当作 0）；Codex 用 reasoning 项 / `reasoning_output_tokens`。
3. **`chatgpt-export` 没有 token 与请求模型字段**：token 类指标、模型替换指标会 `insufficient`，
   只能贡献文本类指标（拒答 / 重复 / 空回答 / 输出文本变化）。
4. **`token_inflation` 的方向是统计假设**：字符/token 比下降通常意味着 token 被多计，
   但文本语言、代码块、格式变化也会改变该比值，所以只作 warning、权重 1.2。
5. **缓存口径差异**：Anthropic 的 `input_tokens` 不含 cache，OpenAI 的 `input_tokens`
   通常包含 cached（子集）。`cache_hit_rate` 统一用
   `cacheRead / (input + cacheRead + cacheWrite)`，跨厂商数值不可直接横向比较，只做同期趋势。
6. **变化点探测是启发式的**：用 6 个特征的稳健标准化中位数差，样本很少 / 多种来源混合时
   可能切不准；差异度不足会自动退回按记录数均分，并在 `notes` 说明。候选窗口已覆盖
   「最近 5%–15% 才退化」的边缘情况，但若退化只发生在**极短的末段**（<5%）仍可能漏判。
7. **单会话结论有限**：v3.1 允许单会话（≥50 条可用记录 + ≥5 指标）出结论，但时间跨度短时
   趋势置信度低；报告会显式提示。
8. **报告不含日志原文**是硬约束：所有证据只以数字 / 模型名呈现，无法回溯到具体某条对话；
   需要原始数据请用户自行查看本地日志。
9. **上限与截断**：单文件 64 MB、总记录 20 万、单行 2 MB（解析层防御）。超过 `maxRecords` 时
   按**时间戳保留最新的 N 条**（不是最早 N 条），`files[].total / skipped` 与 `warnings` 诚实
   反映丢弃量；但超大文件会先按行尾/时间戳抽样保留，若文件内时间顺序极度混乱，仍可能丢掉
   少量较新记录（warning 会说明）。
10. **模型名会出现在报告里**（契约允许）：若模型字段本身含敏感信息，需要用户自行脱敏。
11. **Claude Code 日志不记录请求模型（`requestModel`）**：因此 `model_substitution`
    （响应模型 ≠ 请求模型，权重 1.5 的 critical 项）对纯 Claude Code 日志恒为 `insufficient`，
    模型被偷偷替换**无法**从这类日志里检出。要检测模型替换，请同时上传 API 日志或账单 CSV；
    报告 `notes` 在检测到这种组合时会明确提示。

---

## 10. 按真实日志样例扩展的方法

用户后续提供新格式时，按三步加分支（无需改契约）：

1. 新建 `parsers/<format>.js`，导出 `parse(text, { startIndex, maxRecords })`，
   返回 `{ records, total, skipped, warnings }`；每个 record 只填**半成品字段**
   （`timestamp / model / requestModel / promptTokens / completionTokens / ... / raw`），
   由 `normalize.createRecord` 统一归一化；
2. 在 `parsers/index.js` 的 `PARSERS` 注册；
3. 在 `parsers/detect.js` 增加一个 `sniff<Format>()`（内容打分 0..1），并决定同分优先级。

如果新格式只是既有格式的字段变体（例如 CSV 的中文列名、另一种 usage 字段名），
优先在对应解析器的别名表里加一条，不要新增格式。
