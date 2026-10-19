# 支持的日志格式

「降智诊断」不联网、不上传，只在你浏览器内存里解析。本文件说明它能读懂哪些格式、
提取哪些字段，以及**怎么把你的真实日志脱敏后交给我加一条精确解析分支**。

---

## 1. 五种内置格式（内容自动识别，不看扩展名）

### 1.1 Claude Code 会话日志（`.jsonl`）

路径通常是 `~/.claude/projects/<项目路径编码>/<session-id>.jsonl`，每行一个 JSON 对象。

```jsonl
{"type":"assistant","timestamp":"2026-09-20T00:11:02.000Z","durationMs":2620,
 "sessionId":"sess-1","message":{"model":"claude-sonnet-4-5-20250929",
 "content":[{"type":"thinking","thinking":"…","signature":"EqQ…"},{"type":"text","text":"…"}],
 "stop_reason":"end_turn",
 "usage":{"input_tokens":331,"output_tokens":700,"cache_read_input_tokens":132}}}
```

提取：`timestamp` → 时间；`message.model` → 实际模型；`message.stop_reason` → 截断判断；
`message.usage.*` → token；`content[]` 里 `type=thinking` → thinking 占比与签名是否存在；
`durationMs` → 延迟。

> `type: "user"` 的行会被忽略（只关心模型输出侧）。
>
> ⚠️ **已知限制**：Claude Code 日志**只记录响应侧模型**，没有「请求时指定的模型」。
> 因此 `model_substitution`（模型替换检测）对这个格式会恒为「数据不足」。
> 想检测「请求 Opus 却返回便宜型号」，请改用 **API 请求/响应日志** 或 **账单 CSV**（它们同时有请求模型与响应模型）。

### 1.2 通用 API 请求/响应日志（`.jsonl`）

你自己包一层日志也行，只要每行是下面任一形状：

```jsonl
{"timestamp":"…","request":{"model":"claude-sonnet-4-5","messages":[{"role":"user","content":"…"}]},
 "response":{"model":"claude-sonnet-4-5-20250929","stop_reason":"max_tokens",
 "usage":{"input_tokens":331,"output_tokens":700}},"latency_ms":2620,"status":200}
```

兼容：
- OpenAI 形状 `usage.prompt_tokens` / `usage.completion_tokens`
- Anthropic 形状 `usage.input_tokens` / `usage.output_tokens`
- 扁平形状（`model`、`prompt_tokens` 直接在最外层）
- `{request, response}` 包装

### 1.3 中转站用量 / 账单 CSV（`.csv` / `.tsv`）

支持英文表头与中文表头，能处理 BOM 与 CRLF：

```csv
timestamp,model,request_model,prompt_tokens,completion_tokens,cache_read_tokens,finish_reason,latency_ms,status
2026-09-20T00:11:00.000Z,claude-sonnet-4-5-20250929,claude-sonnet-4-5,331,700,132,end_turn,2620,200
```

中文表头示例：`时间,模型,输入,输出,缓存命中,结束原因,延迟,状态`。

> 账单 CSV 通常没有响应正文与 thinking 信息，所以 **thinking / 拒答 / 重复率** 这几项会自动
> 标为「数据不足」并**不参与评分**（不会因此误判为退化）。

### 1.4 ChatGPT 官方导出（`conversations.json`）

Settings → Data controls → Export data，解压后的 `conversations.json`（一个数组）。
解析器会遍历 `mapping` 节点树，取 `message.author.role === 'assistant'` 的文本与
`metadata.model_slug`。

> 这个格式**没有** token 用量与 stop_reason，所以能用的指标主要是
> 输出长度、拒答率、重复率、空回答率；token 类指标会自动 insufficient。

### 1.5 Codex CLI 会话日志（rollout `.jsonl`）

路径通常是 `~/.codex/sessions/<年>/<月>/<日>/rollout-<时间>-<session-id>.jsonl`。
每行是一个事件，用 `type` 区分：

| `type` | 作用 | 我们取什么 |
| --- | --- | --- |
| `session_meta` | 会话元信息 | `session_id`、`model_provider` |
| `turn_context` | 每轮开始 | `payload.model` → **请求模型** |
| `event_msg` / `payload.type=token_count` | 每轮 token 用量 | `info.last_token_usage.*` → 输入/输出/**推理 token**/缓存命中 |
| `event_msg` / `payload.type=turn_aborted` | 本轮被中止 | → 计入**错误率** |
| `response_item` / `role=assistant` | 助手输出 | `content[].type=output_text` 的文本 → 输出长度/重复率 |
| `response_item` / `type=reasoning` | 加密推理 | 存在即视为「该时段有思考」 |

```jsonl
{"timestamp":"…","type":"event_msg","payload":{"type":"token_count",
 "info":{"last_token_usage":{"input_tokens":331,"cached_input_tokens":132,
 "output_tokens":700,"reasoning_output_tokens":84,"total_tokens":1031}},
 "thread_settings":{"model":"gpt-6-astra"},"duration_ms":2620,"time_to_first_token_ms":420}}
```

**这个格式的重要限制**：它**没有 `finish_reason`**（没有截断标记），也**没有响应侧模型名**。
因此：

- `truncation_rate`（截断率）会自动「数据不足」、**不参与评分**；
- `model_substitution`（模型替换）同样不可用；
- 但 `thinking_*`（用 `reasoning_output_tokens`）、`cache_hit_rate`、`latency`、`error_rate`
  这几项质量很高 —— 对「Codex 变笨了」这类问题，**推理 token 是否归零**往往是最直接的线索。

---

## 2. 最小可用字段

如果你的日志格式很特殊，**只要凑齐这 4 个字段**就能用到大部分指标：

| 字段 | 作用 |
| --- | --- |
| `timestamp` | 前后期切分（缺失则只能做整体统计） |
| `model`（响应里实际模型） | 模型替换检测 |
| `completion_tokens` | 输出长度、token 膨胀、completion ratio |
| `finish_reason` | 截断率 |

有 `thinking` 与 `latency` 更好，没有只是少几项指标，不影响其余判定。

---

## 3. 自动识别规则

**内容优先，扩展名只作为弱提示**：

1. 先按行尝试 JSON 解析；失败则尝试 CSV/TSV。
2. JSON 行里出现 `message.usage` + `type: 'assistant'` → Claude Code。
3. JSON 行的 `type` 落在 {`session_meta`,`turn_context`,`event_msg`,`response_item`,`token_usage_record`} → Codex rollout。
4. 出现 `request`/`response` 包装，或 `usage.prompt_tokens`/`usage.input_tokens` → API 日志。
5. 整个文件是数组且元素含 `mapping` → ChatGPT 导出。
6. 首行是表头且含 `token` 中间列 → 用量 CSV。

所以把 `claude-code.jsonl` 改名成 `.csv` 或去掉扩展名，仍然会被正确识别。

---

## 4. 把你自己的日志给我（加精确解析分支）

我目前是按**已知公开格式**写的解析器。如果你手头的日志字段不一样，请这样脱敏后给我一份：

### 脱敏清单（务必）

- 删除/替换所有 `content`、`text`、`messages`、`prompt`、`system` 里的**正文**；
- 删除路径、用户名、邮箱、组织 ID、API Key（`sk-` 开头一律删）；
- 保留：**字段名**、`timestamp`、`model`、`usage` 数值、`finish_reason`、`status`、`latency`、
  以及 `content[]` 里每个块的 **`type`**（只要类型名，不要内容）。

### 最小示例（这种就够我写解析器了）

```json
{"type":"assistant","timestamp":"2026-01-01T00:00:00Z",
 "message":{"model":"<model>","content":[{"type":"thinking"},{"type":"text"}],
 "stop_reason":"end_turn","usage":{"input_tokens":1,"output_tokens":2}}}
```

把文件放到任意路径（例如 `C:\Users\27385\新建文件夹\samples\`），把**路径**发我即可。
若日志很大，给 **前 3 行 + 1 行异常样本** 就足够。

---

## 5. 自己加一种格式（开发者）

在 `src/core/degrade/parsers/` 下新增一个文件，导出：

```js
export const format = 'my-format';
export function detect(text) { /* 0..1 置信度 */ }
export function parse(text, { file }) { /* → LogRecord[]（可先用 normalize 工具） */ }
```

然后在 `parsers/detect.js` 的候选列表里登记即可。要求：

- `parse` **不得抛异常**（内部 try/catch，坏行记 `skipped`）；
- 输出的记录必须符合契约 `docs/CONTRACT.md` §10.1；
- **不得**把原始行塞进报告可见字段（`raw` 只供内存使用，报告序列化前会被剥离）。

---

## 6. 隐私

- 文件用 `FileReader` 读成字符串后**只在内存中处理**，没有任何网络请求。
- 报告里只有计数、比率、中位数、模型名、字段名；**没有日志原文，也没有文件名**。
- 页面提供「清空日志」按钮，随时释放内存中的内容。
- 生成的 `samples/` 是**合成假数据**（`npm run logs:gen`），可以随便分享。
