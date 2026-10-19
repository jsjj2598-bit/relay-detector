# v3「降智诊断」引擎独立复核报告

> 复核者：auth-engine（read-only 复核角色；本文件是唯一写入物）
> 复核对象：`src/core/degrade/**`、`docs/DEGRADE-NOTES.md`（degrade-core 交付）
> 契约依据：`docs/CONTRACT.md` §9–§14（FROZEN v3 / v3.1）
> 复核日期：2026-10-19　环境：Windows / Node v24，全程离线，无任何真实日志
>
> 复核方法：**不信任实现**。独立编写合成日志 / 伪造 MetricResult，用契约公式手工重算，
> 逐条与实现结果比对；白盒阅读 30 个源码文件；复跑 lead 的验收脚本与全量测试。
> 复核 harness 全部写在 `%TEMP%`（不入库），见 §6。

---

## 0. 结论摘要

| 等级 | 数量 | 说明 |
| --- | --- | --- |
| **阻断** | **0** | 核心语义（隐私 / insufficient 不进分母 / 样本不足 / 判定矩阵 / 13 指标 / 解析识别）全部通过；`npm test` 226/226、`node tools/acceptance-degrade.mjs` 30/30 均通过 |
| 建议 | 4 | ① score 舍入与 verdict 判定不一致（边界可见矛盾）② `maxRecords` 截断无 warning/`skipped` 计数且丢弃最近数据 ③ 变化点候选窗口 20%–80% 会漏判「仅最近 <20% 退化」④ 主力格式 Claude Code 无 `requestModel` → 模型替换指标恒 insufficient |
| 吹毛求疵 | 4 | ① `scoreDegradation` 2 参调用时 evidenceStrength 与报告不一致 ② `parseLogFiles` thenable hack ③ 格式识别置信度边界 ④ 大日志分析耗时 |

**总体判断：可以交付。** 4 条「建议」不改变契约核心语义、不影响默认路径结论；前 3 条建议修复成本低、收益明确，建议本轮收尾前处理（至少补 warning / 文档说明）。

> **第二轮更新（2026-10-19）**：S1 / S2 / S3 已由 degrade-core 修复并经本复核脚本验证通过；
> S4 已写入 `DEGRADE-NOTES §9.11` 并在报告 `notes` 中给出提示；N1 已文档化，N2/N3/N4 未修（非阻断）。
> 第二轮结果与残留边界见 **§7**。全量回归 `npm test` **237/237**、acceptance **30/30**。

---

## 1. 复核范围与方法（可复现）

| 手段 | 内容 |
| --- | --- |
| 独立 harness | `%TEMP%\degrade-review.mjs`：171 项断言，覆盖 API 形状、四解析器 + 伪装扩展名、脏数据、隐私标记、判定矩阵、insufficient 分母手工重算、时间戳 null、series 降采样、静态检查。**171/171 PASS** |
| 验收复刻 | `%TEMP%\degrade-accept-check.mjs`：用 lead 的 `tools/gen-sample-logs.mjs` 生成 stable/degraded 两套日志，复刻 acceptance 全部检查并**加严**到契约 §14.3（必须含 `truncation_spike` + `thinking_collapse`）。**ALL PASS** |
| 阈值边界 | `%TEMP%\degrade-boundary-check.mjs`：评分 60/30 阈值、evidence 0.35 闸门、critical 阈值（15%/5 倍、10%、>50%→≈0）、parse limits、series 覆盖区间 |
| 额外检查 | `%TEMP%\degrade-extra-check.mjs`（LogRecord 字段完整性 / 50k·200k 性能 / minRecords）、`%TEMP%\degrade-misc-check.mjs`（2 参 scoreDegradation / 变化点窗口）、`%TEMP%\degrade-seg-repro.mjs`（变化点平局复现） |
| 官方入口 | `npm test` → **226/226 pass**；`node tools/acceptance-degrade.mjs` → **30/30 pass, 0 fail**（lead 已修复此前 Windows `await import(path.join(...))` 的 ESM 报错，现用 `pathToFileURL`，复核时已复跑通过） |
| 白盒 | 通读 30 个源文件（parsers / metrics / normalize / segment / findings / scorer / scrub / index / constants / util）+ `docs/DEGRADE-NOTES.md` |

---

## 2. 契约 §9–§14 逐条验证结果

### 2.1 隐私红线（§9，最高优先级）—— ✅ 通过

| 检查 | 结果 | 证据 |
| --- | --- | --- |
| 报告序列化后不含日志原文标记串 | ✅ | 用 `SECRET_PROMPT_MARKER_9f3a1c` 写入 prompt/completion 后 `JSON.stringify(report)` 不含该串 |
| 报告不含文件名 / 路径 | ✅ | 文件名 `SECRET_FILE_NAME_b7d2.jsonl` 不出现在报告中（只存在于 §10.2 的 parse 结果 `files[].name`，契约允许） |
| 报告不含 `raw` 字段 | ✅ | `/"raw"\s*:/` 不命中；`scrubRaw` 递归删除 + `assertScrubbed` 独立断言双层防御 |
| 解析期 `raw` 防误泄漏 | ✅ | `raw` / `completionObserved` / `hasThinking` 均为**不可枚举**属性，`JSON.stringify(parsed.records)` 不泄漏原文；`raw` 值仍可在内存读取 |
| 报告不含 promptText/completionText | ✅ | 键名与值双重检查通过 |
| 无网络 / localStorage / DOM I/O | ✅ | 去除注释后静态扫描无 `fetch(` / `XMLHttpRequest` / `WebSocket` / `localStorage` / `document.` / `window.` / `FileReader` |

### 2.2 解析入口与格式识别（§10.2 / §14.1 / §14.2 / §14.7）—— ✅ 通过（除发现 S2）

- 五种格式（含 v3.1 `codex-rollout`）：canonical 扩展名全部识别正确、记录数正确。
- **伪装扩展名**：Claude Code 内容命名为 `.csv` / `.log` / 无扩展名 / `.json` 均识别为 `claude-code`；CSV 内容命名 `.jsonl` 识别为 `usage-csv`；ChatGPT 内容命名 `.txt` 识别为 `chatgpt-export`。`detect.js` 的 `name` 参数不参与判定（内容打分）。
- 脏数据：空行 / 坏 JSON / BOM / CRLF / tab 分隔 / 中文表头均正确跳过或解析，不抛异常；`files[].skipped` 正确计数。
- 单文件失败隔离：`broken.bin` 记 `files[].error`，其它文件照常解析。
- `parseLogFiles` 对 `undefined / null / {} / files:null / files:[null] / text:null` 全部不抛异常。
- `LogRecord` 契约 §10.1 的 22 个字段**全部存在**；`timestamp` 缺失保持 `null`（不伪造）。
- `files[] / warnings / stats{lines,bytes,timeRange,models}` 形状符合 §10.2。
- **发现 S2**：`limits.maxRecords` 截断时 `files[].total/skipped` 少算且**没有 warning**（详见 §3.2）。

### 2.3 分析入口与报告形状（§10.3 / §10.4 / §10.5）—— ✅ 通过

- 报告 `schema/verdict/score/evidenceStrength/summaryText/segments/metrics/findings/criticalIssues/coverage/notes/startedAt/finishedAt` 形状全部合法且可序列化。
- `segments.early/recent = {count, from, to}`、`splitAt: number|null`；`coverage = {records, usable, bySource, byModel, spanDays}`（额外 `untimed` 不改变契约语义）。
- `MetricResult`：13 项齐全、id 顺序与 §11 一致、`status/direction/unit` 枚举合法、`series ≤ 500` 点且**等距覆盖完整时间范围**（2000 条输入 → 500 点，首尾时间覆盖全区间，非简单截断）。
- `Finding`：`id/severity/metric/title/detail/evidence/suggestion` 齐全；`criticalIssues` 恰好是 `findings` 中 `severity==='critical'` 的子集。

### 2.4 13 个指标（§11）—— ✅ 通过

| 检查 | 结果 |
| --- | --- |
| 13 个 id / 顺序 | ✅ 与 §11 表格完全一致 |
| 权重（1.4/1.5/1.3/1.1/1.2/1.0/0.7/0.8/1.2/0.6/0.7/0.9/0.5） | ✅ 逐项一致 |
| `worseDirection`（up/down） | ✅ 逐项与 §11「变差方向」一致（e.g. `output_length` 下降、`error_rate` 上升） |
| `critical` 标记 | ✅ 仅 truncation_rate / model_substitution / thinking_presence 为 true |
| 前后期各 ≥5 样本才 `ok`；不足 → `insufficient` | ✅ 样本闸门生效，insufficient 的 early/recent 为 null（不显示为 0） |
| 反向变化（better）badness = 0 | ✅ 手工构造反向指标 → score=0 |

### 2.5 判定与评分（§12，v3.1）—— ✅ 通过（除发现 S1 的舍入边界）

- `badness = clamp(|deltaPct|/0.5, 0, 1)` 仅在 `direction==='worse'` 时计分；早期为 0 时用绝对变化量兜底（文档化）。
- **分母只统计 `status==='ok'`**：手工重算一致 —— 例：1 个满分恶化指标 + 12 个 `insufficient` → `score = 100`（不是被 13 摊薄成 7.7）；「3 ok + 10 insufficient」场景 `score=59.46` 与只按 ok 权重的手算值完全相等，且不等于把 insufficient 计入分母的 17.05。
- `evidenceStrength = saturate(ok/4) × saturate(usable/50)`（v3.1）：实测 `13 ok / 280 usable → 0.6488` 与公式一致；边界 `usable=223 → 0.3501`（可出结论）、`usable=222 → 0.3498`（insufficient），精确符合 0.35 闸门。
- 判定顺序：`<3 可用指标 / usable < minRecords` → insufficient；critical 一票 → likely-degraded；`e<0.35` → insufficient；60/30 阈值。**顺序与优先级实测正确**（critical 优先于 evidence 闸门；指标数不足优先于 critical）。
- 样本不足：5 条 → `verdict=insufficient`、`summaryText=样本不足，无法判断`、score=0，**不是 stable、不是「退化 0 分」**。
- 空 / 垃圾输入（`undefined/{}/records:null/records:[]/[null,42,'x',{}]`）→ 合法 insufficient 报告，不抛异常。
- **发现 S1**：score 先判 verdict、后舍入展示，边界可能出现「报告 score=60.00 但 verdict=suspicious」的自相矛盾（详见 §3.1）。

### 2.6 critical 阈值边界（§11 / §14.3）—— ✅ 通过

| 场景 | 结果 |
| --- | --- |
| 截断率 15.1% 且 5.03 倍 | ✅ critical（`truncation_spike`） |
| 截断率恰好 15.0% | ✅ 不 critical（`>15%` 开区间，符合契约） |
| 截断率 15.1% 但仅 3 倍 | ✅ 不 critical（需同时满足 5 倍） |
| 早期 0 → 近期 16% | ✅ critical（从无到有，ratio=∞） |
| 模型替换恰好 10.0% / 10.1% | ✅ 不 critical / critical（`>10%` 开区间） |
| thinking 早期恰好 50% → 0 | ✅ 不 critical（`>50%` 开区间） |
| thinking 50.1% → 5% / → 5.1% | ✅ critical / 不 critical（实现取「≈0 = ≤5%」，文档化） |

退化场景端到端（gen-sample-logs）：`verdict=likely-degraded, score≈61.22, critical={truncation_spike, model_substitution, thinking_collapse}`；稳定场景 `verdict=stable, score≈2.31, 0 critical`；关键回归全部命中。**契约 §14.3 的 `truncation_spike` / `thinking_collapse` 要求满足。**

### 2.7 时间戳缺失（§10.1 / §14）—— ✅ 通过

- 全部 `timestamp: null` 的 240 条记录：不抛异常、`verdict=insufficient`、`coverage.records=240`、`coverage.untimed=240`、`segments.splitAt=null`、metric `series` 不伪造时间。
- 时间戳字符串（ISO / 秒 / 毫秒 / 中文日期等）归一化正确；无时区按 UTC 处理。

### 2.8 测试契约（§14）—— ✅ 与建议一并说明

- §14.1 四格式 fixture、§14.2 伪装扩展名、§14.3 退化场景、§14.4 稳定场景、§14.5 样本不足、§14.6 隐私、§14.7 失败隔离/不抛异常、§14.8 insufficient 不进分母：**均实测通过**。
- `npm test` 226/226；`tools/acceptance-degrade.mjs` 30/30（lead 修复 Windows import 后复核通过）。

---

## 3. 发现详情（按严重度）

### 3.1 建议 S1：score 舍入晚于 verdict 判定，报告可能自相矛盾

- **位置**：`src/core/degrade/scorer.js:110`（原始 score）、`:132`/`:134`（用**未舍入** score 判阈值）、`:141`（返回 `round(score, 2)`）。
- **现象**：`scoreDegradation` 可能返回 `{ score: 60, verdict: 'suspicious' }` 或 `{ score: 30, verdict: 'stable' }`。UI 显示「60 分 → 存在可疑变化」，而契约 §12 规定 `score >= 60 → likely-degraded`、`>= 30 → suspicious`。
- **最小复现**（`%TEMP%\degrade-boundary-check.mjs`，纯函数，无需日志）：
  ```js
  // 3 个 ok 指标同向同 badness b，权重 1.4/1.5/1.3 → score = 100*b
  const scoreDegradation = (await import('./src/core/degrade/index.js')).scoreDegradation;
  const mk = (id) => ({ id, status:'ok', early:0.2, recent:0.2*(1+0.6*0.5), deltaPct:0.3,
                        direction:'worse', samples:{early:5,recent:5}, series:[], definition:'x' });
  scoreDegradation([mk('truncation_rate'), mk('model_substitution'), mk('thinking_presence')], [], { usableRecords: 600 });
  // 实际: { score: 60, evidenceStrength: 0.3956, verdict: 'suspicious' }
  // 期望: score=60 时 verdict=likely-degraded（或返回未舍入 score 如 59.999...，保持自洽）
  ```
  因为满足证据闸门（`e≈0.3956 > 0.35`、3 个 ok 指标、600 usable），verdict 本应只看 60/30 阈值。
- **修复建议**：先算 `const finalScore = round(score, 2)`，用 `finalScore` 判 verdict，再返回 `finalScore`；并在 auth-test 加 60.00 / 30.00 两个边界断言（当前测试没有覆盖「展示值」与 verdict 的一致性）。
- **影响**：仅在原始分极度接近 60/30 时出现（浮点尾差），但一旦出现是**用户可见的自相矛盾**；修复成本 ~2 行。

### 3.2 建议 S2：`limits.maxRecords` 截断时静默丢记录（无 warning、`skipped=0`），且保留的是最早数据

- **位置**：`src/core/degrade/index.js:161-200`（`remaining` 计算、`unparsedFromParser`、warning 分支）；解析器提前 `break`：`parsers/claude-code-jsonl.js:154`、`parsers/api-log-jsonl.js:410/430`、`parsers/usage-csv.js:269`、`parsers/chatgpt-export.js:129`、`parsers/codex-rollout.js:269`。
- **现象**：50 行 api-log + `limits.maxRecords: 10` 时：
  ```
  records.length = 10（正确停在上限）
  files[0] = { total: 10, parsed: 10, skipped: 0 }   // 实际文件有 50 行
  warnings = []                                      // 没有任何「达到上限」提示
  ```
  原因：解析器在 `records.length >= maxRecords` 时直接 `break`，未继续扫描统计剩余行；`parseLogFiles` 的 `unparsedFromParser = parsed.records.length - added` 恒为 0，warning 分支永远不会触发。
- **与文档不符**：`docs/DEGRADE-NOTES.md` §3.5 / §8.3 声称「达到后停止追加记录 + warning；超限记录截断 + warning」，实际静默。
- **产品风险**：解析器保留的是**最早** N 条记录 → 当日志超过上限（默认 20 万）时，**最近的记录可能整段被丢弃**，而「近期是否退化」恰恰是核心结论；用户只看到「跳过 0 行」，会误以为数据完整。默认上限下不常见，但真实大日志（多会话）可能触发。
- **修复建议**（二选一）：
  1. 解析器不提前 `break`，继续扫描但不再 `push`，把剩余行计入 `skipped`（大文件有成本，可只在 `maxRecords` 命中后对剩余行做廉价计数）；
  2. `parseLogFiles` 用 `countNonEmptyLines(text)`（已有）减去 `added` 得到每文件实际丢弃行数，写入 `files[].skipped` 并 `warnings.push('达到记录数上限 …，最近/后续 {n} 行未纳入')`；
  并在 `DEGRADE-NOTES` 与 §10.2 文档中写清「截断保留的是最早记录，建议提高上限或分文件」。
- **复现**：`%TEMP%\degrade-boundary-check.mjs` 的「parse limits」段。

### 3.3 建议 S3：变化点候选窗口 20%–80%，「仅最近 <20% 退化」会漏判

- **位置**：`src/core/degrade/segment.js:17-20`（`CANDIDATE_MIN=0.2`、`CANDIDATE_MAX=0.8`）、`:106-122`（取 max |median(z) diff|，低于 0.2 退回半分）。
- **现象**：构造 1000 条记录、**只有最后 50 条（5%）退化**（截断率 25%、输出变短、thinking 消失、延迟升高）：
  ```
  verdict = stable, score = 2.54, critical = []
  segments.early.count = 500, recent.count = 500（未探测到变化点 → 退回按记录数均分）
  强制 options.segment='early-recent' 同样 stable
  ```
  原因：候选切分最大只到 80%，且变化点差异度阈值 0.2 在「近期只占 5%」时被稀释；退回均分后近期段仍以正常记录为主。
- **影响**：这是**产品语义**问题而非契约硬性要求（§14.3 fixture 是 50/50，能通过）；但真实用户常见「长期历史 + 最近一周变差」，如果周记录占比 <20%，可能漏判。属启发式算法的已知边界，建议：
  1. 候选范围放宽到 10%–90%（配合每侧 ≥5 样本与最小分位数）；
  2. 无显著变化点时，不用 50/50，而用「最近 20%–30% vs 其余」作为默认前后期（更符合用户对「近期」的直觉）；
  3. 至少把该限制写进 `DEGRADE-NOTES §9.6`（当前只写「样本很少 / 多种来源混合时可能切不准」，没写「近期占比 <20% 会系统性漏判」）。
- **复现**：`%TEMP%\degrade-misc-check.mjs` 的 `N) change at last 5%`。

### 3.4 建议 S4：Claude Code（主力格式）不记录 `requestModel` → 模型替换指标恒 `insufficient`

- **位置**：`parsers/claude-code-jsonl.js:102`（`requestModel` 仅取 `message.requestModel`，Claude Code 日志通常没有该字段）；`normalize.createRecord` 原样保留 null。
- **现象**：真实 Claude Code JSONL 解析出的 assistant 记录 `requestModel: null` → `model_substitution` 的 eligible 条件（response model 与 request model 都存在）永不满足 → 该指标恒 `insufficient`、不参与评分；`model_substitution` critical（权重 1.5、模型替换 >10%）对 Claude Code 用户完全失效。
- **验证**：`record sample`（`%TEMP%\degrade-extra-check.mjs`）显示 `requestModel: null`；`model_substitution` 在 Claude Code 单格式场景 `samples={early:0,recent:0}`。
- **建议**：会话内请求模型通常是固定的，可从「同一 session 中早/晚记录的主导响应模型」推断 requestModel，或在 UI/文档明确说明「Claude Code 日志不支持模型替换检测，需 API 日志/账单 CSV 才能覆盖」。后者成本为零，建议至少先做文档 + UI 提示。

### 3.5 吹毛求疵

| # | 内容 | 位置 |
| --- | --- | --- |
| N1 | `scoreDegradation(metrics, findings)` 2 参直接调用时用指标 samples 近似 `usable`，与 `analyzeDegradation` 报告值可能不同（实测 untimed 场景 0.5098 vs 0.6952）。契约公开签名是 2 参；建议在 `DEGRADE-NOTES` 明确「报告值需传第 3 参 context」，或把 usable 放进 metrics 元数据 | `scorer.js:72-121` |
| N2 | `parseLogFiles` 返回「结果对象 + 不可枚举 then」的 thenable，以兼容忘记 `await` 的调用；两种调用均可用（已实测），但偏离 `async` 语义。建议 Lead 修 contract test 的 await 后改回纯 async | `index.js:225-247` |
| N3 | 格式识别置信度边界：1 条有效行 + 2 条坏行 → confidence≈0.3 恰好卡在阈值 → unknown（0 records）。低置信度时可考虑「仍用最高分解析器尝试 + warning」，提高真实日志容错 | `parsers/detect.js:180/240` |
| N4 | 性能：50k 记录完整分析 ~1.6s、200k ~6.2s（Node 本机；浏览器主线程会卡顿）。契约允许 200k 上限，建议 UI 显示进度/分片或 Worker | `index.js`/`metrics/index.js` |

> 说明：静态检查里 `document`/`window`/`FileReader` 的命中**仅出现在文件头注释**（「不触碰 …」），去除注释后无任何真实 DOM / 网络 / storage 调用 —— 非缺陷，已排除。

---

## 4. 已确认「无问题」的关键项（不必再查）

1. **隐私三层防御有效**：`raw` 不可枚举 + `scrubRaw` 递归剥离 + `assertScrubbed` 独立断言；唯一标记串 / 文件名 / `raw` 均不出现在 `JSON.stringify(report)`。
2. **`insufficient` 不进分母**：手工重算一致（1 满分 + 12 insufficient → 100；3 ok + 10 insufficient → 精准等于仅 ok 权重平均，而非把 13 项一起平均）。
3. **样本不足 ≠ 退化 0 分**：5 条记录 → `insufficient` + `样本不足，无法判断` + 建议文案；空 / 垃圾输入同样。
4. **13 指标 id/权重/方向/critical 与 §11 完全一致**。
5. **判定矩阵与优先级**（含 critical 一票、evidence 0.35 边界、60/30 阈值、<3 指标、<minRecords）与 §12 一致（S1 舍入边界除外）。
6. **critical 阈值边界**（>15% 且 5 倍、>10%、>50%→≤5%）逐项通过。
7. **伪装扩展名** 6 种全部正确；`detect.js` 的 `name` 不参与判定。
8. **时间戳 null** 不伪造、不计入时间切分、计入 coverage/untimed。
9. **series ≤500 点**且等距覆盖全时间范围（不是截断前 500 条）。
10. **单文件失败隔离**、**parse/analyze 永不抛异常**、**`maxFiles`/`maxBytesPerFile` 生效**（`maxRecords` 见 S2）。
11. **`npm test` 226/226**、**`tools/acceptance-degrade.mjs` 30/30**（Windows 路径问题已由 lead 修复，复核时复跑通过）。

---

## 5. 建议处理顺序

| 顺序 | 项 | owner | 预计成本 |
| --- | --- | --- | --- |
| 1 | S2：maxRecords warning + `files[].skipped` 计数（至少别静默丢数据） | degrade-core | 小 |
| 2 | S1：score 先舍入再判 verdict（+ 2 条边界单测） | degrade-core | 极小 |
| 3 | S4：Claude Code 不支持模型替换的说明（文档/UI 提示） | degrade-core（文档）/ auth-ui（提示） | 极小 |
| 4 | S3：放宽变化点候选窗口或改「最近 20–30% vs 其余」；文档补局限 | degrade-core | 中 |
| 5 | N1–N4 | degrade-core / ui | 视排期 |

> 未发现需要阻断交付的问题；上述建议均可在 v3 收尾阶段处理，或至少写入 `DEGRADE-NOTES §9 已知局限`。

---

## 6. 复跑方式（复核脚本在 `%TEMP%`，未入库）

```
node %TEMP%\degrade-review.mjs         # 171 项黑盒/白盒复核
node %TEMP%\degrade-accept-check.mjs   # 验收复刻（含 §14.3 加严）
node %TEMP%\degrade-boundary-check.mjs # 评分/critical/limits 边界（S1/S2 会 FAIL，即发现）
node %TEMP%\degrade-extra-check.mjs    # LogRecord 字段 / 性能 / minRecords
node %TEMP%\degrade-misc-check.mjs     # 2 参 scoreDegradation / 变化点窗口（S3）
node tools/acceptance-degrade.mjs      # lead 验收脚本（30/30）
npm test                               # 全量回归（226/226）
```

> 这些临时脚本不属于交付物；如需长期保留，建议 Lead 决定是否把其中关键断言（S1 边界、S2 limits、S3 近期占比、隐私标记）转交 auth-test 纳入 `test/**`。

---

## 7. 第二轮复核：S1–S4 修复验证（2026-10-19）

degrade-core 按 §3 建议完成修复后，我用独立脚本重新验证（`%TEMP%\degrade-recheck-v2.mjs`、`%TEMP%\degrade-trim-check.mjs`）。**结论：S1/S2/S3/S4 修复均验证通过，无新增缺陷；仅留 1 条文档级残留建议。**

### 7.1 回归基线

| 入口 | 结果 |
| --- | --- |
| `npm test` | **237/237 pass，0 fail，0 skip** |
| `node tools/acceptance-degrade.mjs` | **30/30 pass** |
| `%TEMP%\degrade-review.mjs`（原 171 项独立复核） | **171/171 PASS**（无需改动） |
| `%TEMP%\degrade-boundary-check.mjs` | **ALL PASS**（S1、S2 原失败项已转绿） |
| `%TEMP%\degrade-recheck-v2.mjs`（新增 S1–S4 定向验证） | **ALL PASS**（45 项） |

### 7.2 S1（score 舍入后再判 verdict）—— ✅ 修复验证通过

- `badness=0.6×3` → `{score:60, verdict:'likely-degraded'}`；`0.3×3` → `{score:30, verdict:'suspicious'}`；
  边界 `59.99 → suspicious`、`29.99 → stable` 均正确。
- 额外检查：**evidenceStrength 先 `round(4)` 再与 0.35 比较**是否存在「raw<0.35 但舍入后放过」的整数组合
  （暴力枚举 ok 3–13 × usable 20–5000）→ **不存在**，无隐藏边界问题。

### 7.3 S2（maxRecords 保留最新 + 计数/warning）—— ✅ 修复验证通过

| 用例 | 结果 |
| --- | --- |
| 300k 行 + `maxRecords:1000`（显式放宽 `maxBytesPerFile`） | `parsed=1000, total=300000, skipped=299000`，warning 明确「按时间戳保留最新 1000 条（丢弃 299000 条较早记录）」，保留最新记录；耗时 ~1.5s |
| 乱序输入 1000 行 + `maxRecords:50` | 按时间戳取最新 50 条，`skipped=950` |
| 多文件（2×600 行）+ `maxRecords:1000` | 全局取最新 1000 条，`skipped` 分摊合计 200（A 文件 200 / B 文件 0） |
| 含无时间戳行 + 上限 | 优先保留 timed 最新记录，warning 说明「没有时间戳的行优先丢弃」 |
| CSV 120 行 + `maxRecords:10` | 保留最新 10 行，`total=120 / skipped=110`，warning |
| ChatGPT 导出 24 条 + `maxRecords:5` | 保留最新 5 条，`total=24 / skipped=19`，warning |
| 小文件（5 条）回归 | 不裁剪、`skipped=0`、无 warning |
| 默认 `maxBytesPerFile=64MB` | 超大文件仍被跳过（契约默认行为，**故意保留**；`files[].error` 明确原因，非缺陷） |

### 7.4 S3（变化点边缘窗口）—— ✅ 修复验证通过（含残留边界）

- 「1000 条、仅最后 5% 退化」→ `likely-degraded`（split≈925/75，`truncation_spike` critical）；
- 稳定 1000 条 → `stable`、0 critical；稳定 + ±10% 噪声 → 仍 `stable`、0 critical（新增边缘窗口未引入误报）。
- **残留边界（建议写入文档，不阻断）**：候选窗口最小 5%，因此
  - 仅最后 **3%** 退化 → `suspicious`（45.73 分，无 critical）；
  - 仅最后 **≤2%** 退化 → `stable`（漏判）。
  这是启发式算法的固有边界（真实日志若「3 年历史 + 最近 3 天变差」且记录量巨大，占比可能 <5%）；建议在
  `DEGRADE-NOTES §9` 明确写出「近期退化占比 <5% 时可能漏判，可通过截取最近 N 天日志再分析」。

### 7.5 S4 / N1 / N2–N4

- **S4** ✅：Claude Code 单格式分析时 `model_substitution=insufficient`，报告 `notes` 出现
  「Claude Code 日志不记录请求模型…要检测模型替换，请同时上传 API 日志或账单 CSV」。
- **N1** ✅ 已文档化（`scorer.js` JSDoc / `DEGRADE-NOTES §6` 说明第 3 参 context；实测报告值与 2 参直接调用值可不同，属已知设计）。
- **N2**（parseLogFiles thenable）仍保留：`await` 与同步两种调用均正常（复核已实测），非阻断。
- **N3/N4** 未动（识别置信度边界、200k 记录耗时），非阻断。

### 7.6 第二轮结论

**S1–S4 全部验证通过，可以交付**。唯一残留建议（§7.4「<5% 近期占比可能漏判」）已被 degrade-core
采纳并写入 `docs/DEGRADE-NOTES.md §9 第 6 条`（含「只截取最近 N 天日志（或先按时间过滤）再分析，
让退化区间在样本中占比 ≥5%」的操作建议）；`DEGRADE-NOTES §8.6` 的回归/验收基线也已更新为本轮实际结果
（`npm test` 237 项全绿、`acceptance-degrade.mjs` 30/30、两轮独立复核 + 171 项 harness + boundary 结论）。

**至此复核建议全部关闭，无待办；task-8 已 complete，本复核报告收尾。** 原报告 §3 的 S1/S2/S3/S4
条目保留为历史记录（修复前状态），以本 §7 为准。
