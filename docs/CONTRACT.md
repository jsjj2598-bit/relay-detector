# 接口契约（FROZEN v1）

本文件是所有模块之间的**唯一权威接口定义**。任何一方需要改动契约，必须先通知 Lead，
由 Lead 更新本文件并把版本号升到 v2，禁止单方面改动。

项目目标：在浏览器（GitHub Pages 纯静态）与本地 Node 代理两种模式下，
判断一个 API 基址是**官方直连**还是**第三方中转站（API 中转 / one-api / new-api / 各类反代）**，
并输出带证据链的多层指纹评分报告。

支持协议：OpenAI 兼容 `/v1`、Anthropic `/v1/messages`、Google Gemini `generateContent`。

---

## 0. 目录与写入范围

| 路径 | 归属 | 说明 |
| --- | --- | --- |
| `docs/CONTRACT.md`, `docs/RESEARCH.md` | 契约由 Lead 冻结；RESEARCH 由 researcher 写 | — |
| `src/core/constants.js`, `src/core/score.js` | **Lead（冻结，他人只读）** | 常量表、评分数学 |
| `src/core/*.js`（其余）, `src/core/rules/**`, `src/core/signatures.js`, `src/providers/**` | engine | 探测编排 + 规则 |
| `index.html`, `src/styles/**`, `src/ui/**` | ui | 页面与渲染 |
| `proxy/**`, `README.md`, `.github/workflows/**`, `LICENSE`, `.gitignore` | infra | 本地代理、文档、CI |
| `test/**` | verifier | 测试与验收脚本 |
| `package.json` | Lead（冻结） | 脚本入口 |

---

## 1. 数据形状

### 1.1 ProbeResult（`src/core/probes.js` 产出）

```js
/** @typedef {Object} ProbeResult */
{
  id: 'openai.models',            // ProbeSpec.id，全局唯一
  provider: 'openai',             // 'openai' | 'anthropic' | 'gemini'
  kind: 'models' | 'chat' | 'error' | 'root' | 'tls',
  request: {
    method: 'GET',
    url: 'https://example.com/v1/models',
    headersSent: { authorization: '<redacted>' }, // 密钥必须脱敏为 '<redacted>'
    bodySent: null | object,      // 同样脱敏
    startedAt: 1699999999999,
    durationMs: 123
  },
  response: null | {
    status: 401,
    headers: { 'content-type': 'application/json', ... }, // key 一律小写
    bodyText: '{"error":{...}}',
    bodyJson: null | object,      // 解析失败为 null
    contentType: 'application/json'
  },
  error: null | {
    kind: 'network' | 'cors' | 'timeout' | 'http' | 'aborted',
    message: 'Failed to fetch'
  },
  meta: {}                        // 规则可读的附加信息（如 tls 证书信息）
}
```

约束：
- **绝不**把 `apiKey` 原文放进 ProbeResult。请求头里 `authorization` / `x-api-key` / `x-goog-api-key`
  的值统一替换为 `'<redacted>'`（保留前 6 位 + `…` 可选，但不得可逆）。
- `response.headers` 的键必须小写化。
- `bodyText` 截断到 20000 字符以内，超出部分丢弃并置 `meta.bodyTruncated = true`。

### 1.2 TLS 信息（仅代理模式）

代理模式多跑一条 `kind: 'tls'` 探测，结果放在 `response`（无正文）：

```js
{
  id: 'tls.peer', provider: 'openai', kind: 'tls',
  request: { method: 'GET', url: '...', headersSent: {}, bodySent: null, startedAt: 0, durationMs: 0 },
  response: { status: 0, headers: {}, bodyText: '', bodyJson: null, contentType: '' },
  error: null,
  meta: {
    tls: {
      authorized: true,
      issuer: { CN: 'Cloudflare Inc ECC CA-3', O: 'Cloudflare, Inc.', C: 'US' },
      subject: { CN: 'example.com' },
      altNames: ['example.com', '*.example.com'],
      validFrom: 'Jan  1 00:00:00 2026 GMT',
      validTo: '...',
      protocol: 'TLSv1.3',
      cipher: 'TLS_AES_128_GCM_SHA256',
      fingerprint256: 'AA:BB:...',
      selfSigned: false,
      daysRemaining: 60
    }
  }
}
```

### 1.3 Signal（规则产出）

```js
/** @typedef {Object} Signal */
{
  id: 'headers.cf_ray',            // 全局唯一，命名空间.规则名
  category: 'url' | 'tls' | 'headers' | 'error' | 'models' | 'payload' | 'behavior' | 'signature',
  verdict: 'relay' | 'official' | 'neutral',
  weight: 60,                      // 0..100，该特征成立时的指示强度
  confidence: 0.9,                 // 0..1，该特征被正确观测/解读的可信度
  title: '响应头出现 Cloudflare 特征',
  detail: '检测到 cf-ray / server: cloudflare，说明站点经 CDN 反代。',
  evidence: { 'server': 'cloudflare', 'cf-ray': '8f...' },  // 任何可序列化值
  source: 'rules/headers.js'       // 可选，便于排错
}
```

硬性要求：
- `verdict: 'official'` 只允许用于**官方独有**的正向证据（白名单域名、官方 TLS 签发者、
  官方错误报文字段组合等），不得用「没看到中转特征」当作 official 证据。
- 每条 Signal 必须给出 `evidence`，报告中会原样展示。
- 同一 `id` 在一次检测中最多出现一次。

### 1.4 DetectionReport（`detect()` 返回值）

```js
/** @typedef {Object} DetectionReport */
{
  schema: 1,
  target: {
    input: 'https://x.com/v1',
    baseUrl: 'https://x.com/v1',     // 规范化后的基址（无尾斜杠）
    host: 'x.com',
    provider: 'openai',              // 'openai' | 'anthropic' | 'gemini'
    providerSource: 'explicit' | 'auto',
    matchedOfficialHost: null | 'api.openai.com'
  },
  mode: 'browser' | 'proxy',
  score: 78,                         // 0..100，越高越可能是中转站
  officialScore: 22,                 // 100 - score
  evidenceStrength: 0.61,            // 0..1，见 score.js
  verdict: 'relay' | 'likely-relay' | 'inconclusive' | 'likely-official' | 'official',
  signals: [/* Signal，按贡献从大到小排序 */],
  byCategory: { url: [...], tls: [...], headers: [...], error: [...], models: [...], payload: [...], behavior: [...], signature: [...] },
  probes: [/* ProbeResult */],
  capabilities: {
    canReadHeaders: true,            // 浏览器模式恒为 true，但被 CORS 过滤后的头不完整
    tlsAvailable: false,             // 仅代理模式 true
    corsBlocked: false,              // 至少一条探测因 CORS 失败
    networkReachable: true,
    costIncurred: false              // 是否发送了会产生费用的 chat 请求
  },
  notes: ['浏览器模式受 CORS 限制，部分响应头与 TLS 证书不可见。'],
  startedAt: 1699999999999,
  finishedAt: 1700000000123,
  durationMs: 124
}
```

---

## 2. 公开 API

### 2.1 `src/core/engine.js`（engine 提供）

```js
import { detect, normalizeBaseUrl, pickProvider } from './src/core/engine.js';

const report = await detect({
  baseUrl: 'https://api.example.com/v1',
  apiKey: 'sk-xxx',                 // 可选
  provider: 'auto',                 // 'auto' | 'openai' | 'anthropic' | 'gemini'
  mode: 'browser',                  // 'browser' | 'proxy'
  transport: fetch,                 // 见 2.2；browser 模式传 globalThis.fetch.bind(...)
  options: {
    timeoutMs: 12000,
    allowPaidProbes: false,         // true 才允许发 chat/completions 等可能计费的请求
    maxModelsListed: 5000,
    proxyUrl: 'http://127.0.0.1:8787', // 仅 proxy 模式
    signal: null                    // AbortSignal，可选
  }
});
```

- `detect()` **不得抛异常**：任何失败都表现为 `probes[].error` 且 `notes` 说明。
- `allowPaidProbes === false` 时，允许发出的探测只有：`GET /v1/models`、`GET /v1/models/{id}`（可选）、
  以及一次**必然失败**的鉴权探测（无 key 或伪造 key）来读取错误报文。禁止发送任何可能正常计费的 chat 请求。
- `normalizeBaseUrl(input, provider)` 纯函数：补协议、去尾斜杠、识别是否已含 `/v1`，返回 `{ baseUrl, host, hadV1 }`。
- `pickProvider(baseUrl, hint)` 纯函数：返回 `'openai' | 'anthropic' | 'gemini'`。

### 2.2 transport

transport 是一个**与 `fetch` 同签名**的函数：`transport(url, init) -> Promise<Response>`。

- browser 模式：`globalThis.fetch`（跨域被 CORS 拦截）。
- proxy 模式：engine 内部包装成 `fetch(proxyUrl + '/proxy?url=' + encodeURIComponent(url), ...)`，
  或由 UI 传入 `createProxyTransport(proxyUrl)`（engine 导出该辅助函数）。

### 2.3 provider 接口（`src/providers/*.js`，engine 提供）

```js
export const openaiProvider = {
  id: 'openai',
  label: 'OpenAI / 兼容',
  defaultBaseUrl: 'https://api.openai.com/v1',
  matches(baseUrl, hint) { return true; },   // 纯函数
  buildProbes(ctx) { return [ /* ProbeSpec */ ]; },
  rules: [ /* (ctx) => Signal[] */ ]
};
```

`ProbeSpec`：

```js
{
  id: 'openai.models',
  kind: 'models',
  method: 'GET',
  url: 'https://x.com/v1/models',
  headers: { accept: 'application/json' },
  body: null,                       // 对象则 JSON.stringify 并带 content-type
  expectStatus: 'any',
  requiresKey: true,
  paid: false
}
```

`ctx`（传给 `buildProbes` 与所有规则函数）：

```js
{
  target: { baseUrl, host, provider, input },   // 同 report.target 的子集
  options: { ... },                             // 同 detect 的 options 归一化后
  mode: 'browser' | 'proxy',
  probes: ProbeResult[],                        // 已完成的全部探测
  get(id): ProbeResult | null,
  json(id): object | null,                      // 便捷取 bodyJson
  text(id): string | null
}
```

`src/core/engine.js` 导出 `runRules(ctx, provider)`，依次执行 `provider.rules` 与通用规则集
（`src/core/rules/index.js` 的 `COMMON_RULES`），去重（同 id 保留第一个），并把结果交给 `score.js`。

### 2.4 `src/core/score.js`（Lead 提供，冻结）

```js
export function scoreSignals(signals, categoryWeights?) -> {
  score, officialScore, evidenceStrength, verdict,
  relayPoints, officialPoints, neutralPoints, directionalPoints,
  flags: { hasDirectionalEvidence, urlIdentityConfirmed, officialDowngraded, upstreamLooksGenuine },
  breakdown: { [category]: { relay: n, official: n } }
}
export function verdictFromScore(score, evidenceStrength, hasDirectionalEvidence?) -> verdict
export const VERDICT_LABELS, VERDICT_TONES      // UI 直接用
```

判定阈值（`verdictFromScore`）：

| 条件 | verdict |
| --- | --- |
| `hasDirectionalEvidence === false` | `inconclusive`（**硬闸门**，优先级最高） |
| `evidenceStrength < 0.40` | `inconclusive` |
| `score >= 70` | `relay` |
| `58 <= score < 70` | `likely-relay` |
| `42 <= score < 58` | `inconclusive` |
| `30 <= score < 42` | `likely-official` |
| `score < 30` | `official` |

**降级闸门（`scoreSignals` 内部，`REQUIRE_URL_EVIDENCE_FOR_OFFICIAL`）**：
若不存在 `category === 'url'` 且 `verdict === 'official'` 的信号（即域名身份未被确认为官方/正规端点），
则 `official` 与 `likely-official` 一律降级为 `inconclusive`，并在 `flags.officialDowngraded` 置 true。

**绝对量闸门（`scoreSignals` 内部，`MIN_DIRECTIONAL_POINTS = 15`）**：
`score` 是**比例制**（`relayPoints / (relayPoints + officialPoints)`），零官方证据时任何一条 relay 信号都会打满 100 分。
因此方向结论还要求方向分**绝对量**达到 15，否则降级为 `inconclusive` 并置 `flags.insufficientDirectionalPoints = true`。
（复现：`[relay(14,0.4,'headers'), neutral(100,0.85,'url')]` → relayPoints 仅 4.76、`score=100`、`evidenceStrength=0.4307`，
若无此闸门会判成「高度确信是中转站」。）

> 理由：`openai-version` / `openai-processing-ms` / `openai-organization` 这类官方响应头在**反向代理**下会被
> 原样透传。一个转发到真实 `api.openai.com` 的中转站会返回完全真实的官方头与官方错误报文。
> 「响应头像官方」只能证明**上游是真的**，不能证明**你连的是官方**。唯一能证明直连的是域名身份。
> 降级后的 `flags.upstreamLooksGenuine === true` 表示：上游确实是真实官方实现，但域名身份未确认，
> 很可能经由代理访问 —— UI 应当把这一情形解释清楚。

> **v1.1 修正（Lead，2026-10-19）**：新增 `hasDirectionalEvidence` 闸门与 `directionalPoints` 字段。
> 原因：中立证据会抬高 `evidenceStrength`，若没有任何方向证据，`score=0` 会落到 `official`，
> 把「什么方向都没看出来」误报成「官方直连」。而 `api.anthropic.com` 实测本身就在 Cloudflare 后，
> 这类场景极常见，必须保守判为 `inconclusive`。这是 verifier 发现并回归测试覆盖的缺陷。
>
> **v1.2 修正（Lead，2026-10-19）**：新增 `flags` 与域名身份降级闸门，见上。
> 原因：反向代理透传官方响应头会导致「上游为真 ⇒ 判定直连」的漏判。

### 2.5 `src/core/constants.js`（Lead 提供，冻结）

导出：`OFFICIAL_HOSTS`、`OFFICIAL_HOST_PATTERNS`、`OFFICIAL_TLS_ISSUERS`、`OFFICIAL_MODEL_PREFIXES`、
`CATEGORY_WEIGHTS`、`CATEGORY_LABELS`、`PROVIDER_LABELS`、`VERSION`。

engine 与 UI 都只能**读取**，不得修改。

### 2.6 UI 内部接口（ui 提供，engine 不依赖）

- `index.html` → `<script type="module" src="./src/ui/app.js"></script>`
  （**允许带缓存失效查询串**，如 `./src/ui/app.js?v=2.2.0`。
  GitHub Pages 对 HTML/JS 统一发 `Cache-Control: max-age=600`，页面与脚本可能一旧一新，
  导致「新加的 tab 点了没反应」；入口脚本带版本号可强制换新，配合 `index.html` 里的启动自检横幅兜底。）
- `src/ui/render.js` 导出 `renderReport(container, report)`、`renderError(container, message)`
- `src/ui/app.js` 只通过 `detect()` 与 `renderReport()` 连接引擎，不 import 任何 `rules/**`。

### 2.7 本地代理接口（infra 提供）

`node proxy/server.mjs`（默认 `127.0.0.1:8787`）提供：

| 路由 | 说明 |
| --- | --- |
| `GET /` | 静态托管仓库根目录（等价 GitHub Pages） |
| `GET /proxy?url=<encoded>` | 透传 GET，返回真实响应头（含 CORS 放宽），`x-relay-detector-proxy: 1` |
| `POST /proxy?url=<encoded>` | 透传 POST（body 原样），同上 |
| `GET /inspect?host=<host>&port=443` | 返回 1.2 定义的 `meta.tls` 对象（`tls.connect` 读取 peer certificate） |
| `GET /health` | `{ ok: true, version }` |

代理必须：只允许 `http/https`、拒绝 `file:`/内网地址（除非 `--allow-private`）、限制响应体大小、
带超时，并回显 `x-relay-detector-hop` 便于确认经过代理。

---

## 3. 规则命名空间约定

| category | 允许的 id 前缀 | 例子 |
| --- | --- | --- |
| url | `url.` | `url.official_host`、`url.nonstandard_port` |
| tls | `tls.` | `tls.cloudflare_issuer`、`tls.self_signed` |
| headers | `headers.` | `headers.cf_ray`、`headers.openai_version_present` |
| error | `error.` | `error.openai_shape`、`error.oneapi_shape` |
| models | `models.` | `models.official_overlap_low`、`models.oversized_list` |
| payload | `payload.` | `payload.system_fingerprint_missing` |
| behavior | `behavior.` | `behavior.latency_outlier` |
| signature | `signature.` | `signature.one_api` |

`src/core/signatures.js` 里集中维护已知中转软件指纹（one-api / new-api / veloera / 各类反代），
每条都带 `confidence` 与**「非确定性证据」**说明。

---

## 4. 质量红线

1. 不得声称「100% 确定」。报告必须展示证据与不确定性。
2. 不硬编码任何真实中转站域名黑名单（不可维护且易误伤）；只做**特征**判定。
3. 不在浏览器端持久化 API Key，除非用户显式勾选；默认不落盘。
4. 所有模块必须能在 Node 20+ 下被 `import`（纯逻辑部分不得直接触碰 `document`），
   以便 `test/**` 无需浏览器即可跑通。
5. 中文 UI 文案；代码注释中文为主。
6. **测试命令**：`npm test`，即 `node --test "test/**/*.test.mjs"`。
   ⚠️ 不要写成 `node --test test/` —— Node 24 的测试运行器会把「目录位置参数」当作模块去 require，
   直接报 `Cannot find module '.../test'` 而一个测试都不跑（已实测复现）。
   CI 与 README 必须使用本文件规定的命令。

---

# 契约 v2 · 上游真伪检测（authenticity）

> 背景与设计依据见 `docs/LEARNINGS-FROM-VERIDROP.md`。v2 是**纯增量**：
> v1 的 `score/verdict`（连接方式轴）语义不变，新增独立的「上游真伪」轴。
> 两个轴必须分开呈现，禁止合并成一个分数。

## 5. 概念模型

一次检测有两根正交的轴：

| 轴 | 字段 | 回答的问题 | 取值 |
| --- | --- | --- | --- |
| 连接轴（v1） | `report.score` / `report.verdict` | 我连的是官方还是第三方？ | `official` / `likely-official` / `inconclusive` / `likely-relay` / `relay` |
| 真伪轴（v2） | `report.authenticity.score` / `.verdict` | 第三方上游给我的**是不是真模型**？ | `excellent` / `passed` / `marginal` / `failed` / `invalid` |

典型组合：`relay + passed` = 诚实中转（可用）；`relay + failed` = 模型被掉包（立刻换）；
`official` 时真伪轴应为 `skip`（无意义）。

## 6. 检测器框架（`src/core/auth/**`）

### 6.1 Detector 形状

```js
/** @typedef {Object} Detector */
{
  name: 'thinking_signature',       // 全局唯一，snake_case
  displayName: '思维签名验证',
  weight: 25,                        // 0..100，参与加权平均
  modes: ['standard', 'full'],       // 允许运行的档位
  provider: ['anthropic'],           // 适用的协议；空数组 = 全协议
  critical: false,                   // 是否会产出 critical 级问题
  appliesTo(ctx): boolean,           // 模型能力是否支持（如模型不支持 thinking 就 false）
  kind: 'active' | 'passive',

  // active：自己发请求
  async run(ctx): Promise<DetectorResult>,
  // passive：复用他人请求，零额外成本
  observe(ctx, exchange): void,
  finalize(ctx): DetectorResult
}
```

### 6.2 DetectorResult

```js
{
  name, displayName, weight,
  status: 'pass' | 'fail' | 'skip' | 'error',
  score: 0,                 // status === 'skip' 时必须为 0，且**不计入分母**
  details: { subChecks: [...], ... },   // 一律可序列化，报告原样展示
  error: null | string,
  durationMs: 0,
  criticalIssues: [ { code, message, evidence } ]   // 可选
}
```

**硬性语义**（这是 v2 最重要的规则）：

1. `skip` 与 `error` **不进入**加权分母。`skip` 表示「本来就无法测」（模型不支持 / 档位没选），
   `error` 表示「测了但网络/上游报错」。两者都**不得**被当作 0 分拉低总分。
2. 全部检测器都 `skip` 时，`verdict = 'invalid'`（不是 0 分）。
3. `status: 'pass'` 的判定阈值：`score >= 70`。
4. 检测器 `run()` **绝不能抛异常**：runner 会兜住并转成 `status: 'error'`。

### 6.3 评分（`src/core/auth/scorer.js`）

```js
export function computeTotal(results) -> number
// 仅统计 status !== 'skip' && status !== 'error' 的结果：
//   total = Σ(score × weight) / Σ(weight)   （分母为 0 时返回 0）

export function verdictFor(score) -> 'excellent' | 'passed' | 'marginal' | 'failed'
// score >= 85 → excellent；>= 70 → passed；>= 50 → marginal；< 50 → failed

export function hasCriticalIssues(results) -> boolean
export function effectiveVerdict(score, results) -> verdict
// critical 一票否决：base === 'passed' 时封顶为 'marginal'（excellent 同理降到 marginal）

export function fatalRunError(results) -> null | { code, message }
// 命中上游余额/额度/model_not_found/无可用渠道时返回：
//   code: 'insufficient_quota' | 'model_unavailable'
// 命中时整份报告 verdict = 'invalid'，禁止输出低分误导用户

export function summaryText(verdict, score) -> string
// excellent → '优秀'；passed → '通过'；marginal → '基本合格'；
// failed → '未达标'；invalid → '检测无效'
```

### 6.4 检测器清单与权重（冻结）

| name | 协议 | kind | 权重 | critical | 档位 | 说明 |
| --- | --- | --- | --- | --- | --- | --- |
| `protocol_shape` | 全部 | active | 20 | 否 | quick+ | 响应结构是否符合官方协议（id/object/choices/stop_reason/usage 键） |
| `cross_vendor_leak` | 全部 | passive | 20 | **是** | quick+ | 跨厂商字段泄漏（OpenAI 响应出现 `claude_*`/`input_tokens` 等） |
| `model_consistency` | 全部 | active | 15 | 否 | quick+ | 响应 `model` 字段回显 + 3 次 temp=0 的 completion_tokens 变异系数 CV |
| `thinking_signature` | anthropic | active | 25 | **是（仅缺失签名时）** | standard+ | Claude thinking 服务端签名（无 thinking 块=0，有块无签名=30，签名过短=70，正常=100）。`score <= 30` 时报 `missing_thinking_signature` critical；`skip` 时**绝不**报 critical |
| `message_id` | anthropic | passive | 5 | 否 | standard+ | `msg_` / `toolu_` / `srvtoolu_` 前缀、`type`、`role`、`model` 含 claude |
| `token_usage` | 全部 | active | 10 | 否 | standard+ | usage 自洽性：字符/token 比 1.2–10、completion 未超 max_tokens、total 自洽 |
| `structured_output` | 全部 | active | 10 | 否 | standard+ | 要求返回精确 JSON 字面量，检查是否被包 ```json 代码块 |
| `capability_tools` | 全部 | active | 10 | 否 | standard+ | tool call / function calling 是否真实生效（返回 tool_calls 结构） |
| `stream_integrity` | 全部 | active | 10 | 否 | full | 流式 vs 非流式：文本相似度 ≥ 85、input_tokens 差 ≤ max(3, 20%)、output_tokens 接近 |
| `token_parity` | 全部 | active | 10 | 否 | full | 与内置官方基线对齐（无基线则 `skip`，不扣分） |

> 权重**不需要**在单协议内求和为 100，`computeTotal` 用的是加权平均（分母自适应）。
> 但同一档位内应保持相对比例合理。
>
> **实际请求数（以 `estimateCost()` 的输出为准，已实测核对）**：
> `quick` = 4 个请求；`standard` = 7（OpenAI/Gemini）/ 8（Anthropic，含 thinking 探针）个；
> `full` = 9 / 10 个。**刻意比早期估算更低**（减少用户扣费），
> 这是实现上的取舍而非漏实现，`estimateCost` 与实际 `cost.requests` 必须保持一致。

### 6.5 模型能力表（`src/core/auth/models.js`）

```js
export const MODEL_REGISTRY = {
  anthropic: [
    { id: 'claude-sonnet-4-5',   thinking: 'extended', supportsTools: true, contextWindow: 200000 },
    { id: 'claude-opus-4-1',     thinking: 'extended', ... },
    { id: 'claude-3-5-haiku-20241022', thinking: null, ... }   // 不支持 thinking → 该检测器 skip
  ],
  openai: [ { id: 'gpt-4o', ... } ],
  gemini: [ { id: 'gemini-2.5-flash', ... } ]
};
export function lookupModel(provider, model) -> ModelInfo | null   // 支持前缀匹配（带日期后缀的模型）
export function suggestModels(provider) -> ModelInfo[]
```

`lookupModel` 匹配不到时必须返回 `null`（而不是抛错），并使依赖模型能力的检测器 `skip`。

### 6.6 公开 API（`src/core/auth/index.js`）

```js
import { runAuthenticity, estimateCost, AUTH_MODES } from '../core/auth/index.js';

const auth = await runAuthenticity({
  provider: 'anthropic',            // 'openai' | 'anthropic' | 'gemini'
  baseUrl: 'https://relay.example.com/v1',
  apiKey: 'sk-...',
  model: 'claude-sonnet-4-5',
  mode: 'standard',                 // 'quick' | 'standard' | 'full'
  transport,                        // 与 fetch 同签名；proxy 模式由 engine 注入
  options: {
    timeoutMs: 60000,
    signal: null,
    maxRequests: 24,                // 硬上限，防止失控扣费
    concurrency: 1                  // 默认串行，避免触发风控
  }
});
```

返回值：

```js
{
  schema: 1,
  provider, model, mode,
  score: 0..100,
  verdict: 'excellent' | 'passed' | 'marginal' | 'failed' | 'invalid',
  summaryText: '优秀' | '通过' | '基本合格' | '未达标' | '检测无效',
  detectors: [DetectorResult],
  criticalIssues: [{ detector, code, message, evidence }],
  runError: null | { code, message },
  cost: { requests, promptTokens, completionTokens, note },
  warnings: [string],               // 如「该模型不支持 thinking，已跳过签名验证」
  startedAt, finishedAt, durationMs
}
```

`estimateCost({ provider, model, mode }) -> { requests, promptTokens, completionTokens, note }`
必须在**发请求前**给 UI 用于展示预估费用。

### 6.7 安全红线（v2 追加）

1. API key 只存在于内存与请求头；**禁止**写 localStorage / 写日志 / 进 report。
   报告中的 key 一律 `maskApiKey()`：保留前 4 + 后 4，中间替换为 `••••`。
2. `maxRequests` 是硬上限，命中后剩余检测器 `skip`（reason: `request_budget_exhausted`）。
3. 默认**不**发长上下文探针（`full` 档也不发，需用户另行显式开启 `longContext: true`）。
4. 所有请求必须带超时与 `AbortSignal`。

---

## 7. UI 契约（v2 追加）

`report.authenticity` 可能为 `null`（未做真伪检测）。UI 必须：

1. 在表单增加「检测深度」三选一：
   - `指纹（免费，无需 Key）` → 只做 v1，`authenticity = null`
   - `真伪（需要 API Key，消耗额度）` → v2 standard 档
   - `完整（指纹 + 真伪 full）`
2. 选择需要 Key 的档位时，**发请求前**展示 `estimateCost()` 的请求数与 token 预估，并要求用户显式勾选确认。
3. 报告区新增独立的「上游真伪」卡片：评分环、`summaryText`、检测器表格（name / 状态 / 分数 / 权重 / skip 原因 / subChecks 折叠）、
   `criticalIssues` 红色横幅、`runError` 时显示「检测无效」而非低分。
4. 连接轴与真伪轴必须**并列展示**，禁止合并。典型组合要给出一句话解读，例如
   「中转站，但上游为真模型 → 可用」/「中转站，且上游疑似被掉包 → 建议更换」。

---

## 8. 测试契约（v2 追加）

`test/**` 必须覆盖：

1. `scorer`：加权平均、`skip`/`error` 不进分母、全 skip → `invalid`、critical 一票降级、`fatalRunError` 两种 code。
2. 每个检测器的**离线单测**：用伪造的 exchange/fetch 响应构造，不联网。
3. 关键回归（必须有）：
   - thinking 签名缺失 → `thinking_signature` 得 0 分且 `status: 'fail'`（Kiro/Amazon Q 场景）
   - **v2.1**：签名缺失（`score <= 30`）必须产出 `missing_thinking_signature` critical，
     且 `verdict` 由 `passed` 封顶为 `marginal`；签名过短（70 分）**不产** critical；
     `skip`（模型不支持 thinking）**绝不产** critical 且不拉低总分
   - 签名存在且长度正常 → 100 分
   - 模型不支持 thinking → `status: 'skip'`，**总分不得被拉低**
   - OpenAI 响应里出现 `claude_cache_creation_5_m_tokens` → `cross_vendor_leak` 报 critical，`verdict` 被封顶
   - 上游返回 `insufficient_quota` → `verdict: 'invalid'`，不得显示为低分
4. `runAuthenticity` 在 transport 全部失败时**不抛异常**，返回 `verdict: 'invalid'`。
5. key 脱敏：报告中不出现完整 key。

---

# 契约 v3 · 降智诊断（基于使用日志）

> **定位声明（必须写进 UI 与文档）**：这不是 IQ 测试，也不是「能力测量」。
> 它从**用户自己的使用日志**里提取**可观测的退化信号**（输出变短、token 膨胀、被截断、
> thinking 消失、模型字段漂移、错误率上升、延迟恶化…），并做**前后期对比**。
> 结论是「统计上存在/不存在系统性变化的迹象」，**不是**「模型一定变笨了」。

## 9. 隐私红线（最高优先级）

1. **日志绝不出浏览器**：用 File API 在内存中读取与解析，**零网络请求**。
   禁止上传、禁止发往任何服务器、禁止写入 localStorage（除用户显式勾选的「仅保存汇总」）。
2. 报告里**不得包含日志原文**。只允许包含：计数、比率、中位数、时间戳、模型名、字段名。
   `raw` 字段只存在于解析期的内存对象，**序列化报告前必须剥离**。
3. 页面必须有常驻提示：「日志只在你的浏览器内存中解析，不会上传到任何地方」。
4. 解析完成后，UI 必须提供一键清空内存中日志内容的入口。

## 10. 数据形状

### 10.1 LogRecord（解析后的规范化记录）

```js
/** @typedef {Object} LogRecord */
{
  index: number,
  timestamp: number | null,        // ms epoch；缺失为 null
  provider: 'anthropic' | 'openai' | 'google' | 'unknown',
  model: string | null,            // 响应里实际返回的模型
  requestModel: string | null,     // 请求时指定的模型
  sessionId: string | null,
  source: 'claude-code' | 'codex-rollout' | 'api-log' | 'usage-csv' | 'chatgpt-export' | 'generic',
  kind: 'assistant' | 'usage' | 'user' | 'system',
  promptText: string,              // 缺失为 ''
  completionText: string,          // 缺失为 ''
  promptTokens: number | null,
  completionTokens: number | null,
  cacheReadTokens: number | null,
  cacheWriteTokens: number | null,
  thinkingTokens: number | null,
  thinkingChars: number | null,
  hasThinkingSignature: boolean | null,
  finishReason: string | null,     // 'stop' | 'end_turn' | 'length' | 'max_tokens' | …
  status: number | null,           // HTTP 状态；无则 null
  errorCode: string | null,
  latencyMs: number | null,
  raw: object                      // ⚠️ 仅内存；进报告前必须删除
}
```

### 10.2 解析入口（`src/core/degrade/index.js`）

```js
export async function parseLogFiles({ files, limits }) -> ParseResult
// files: Array<{ name: string, text: string }>   // 浏览器端由 FileReader 读出文本后传入
// limits: { maxFiles?: 20, maxBytesPerFile?: 64*1024*1024, maxRecords?: 200000 }
// 返回：
{
  records: LogRecord[],
  files: [{ name, format, confidence, total, parsed, skipped, error }],
  warnings: string[],       // 如「跳过 12 行无法解析的 JSON」
  stats: { lines, bytes, timeRange: { from, to } | null, models: string[] }
}
```

**绝不抛异常**：单文件解析失败记入 `files[].error` 并继续处理其它文件。

### 10.3 分析入口

```js
export function analyzeDegradation({ records, options }) -> DegradationReport
// options: { minRecords?: 20, minSpanMs?: 0, segment?: 'auto' | 'early-recent' }
//   minSpanMs 默认 0：不按时间跨度卡结论（否则「单次会话」永远无法出结论）；
//   但跨度 < 6 小时时必须在 notes 里提示「时间跨度较短，趋势判断置信度低」。
```

```js
{
  schema: 1,
  verdict: 'stable' | 'suspicious' | 'likely-degraded' | 'insufficient',
  score: 0..100,                 // 退化倾向（越高越可疑）
  evidenceStrength: 0..1,        // 证据充分度（样本量 + 指标可用性），与 score 分离
  summaryText: '未见系统性退化' | '存在可疑变化' | '多项指标一致退化' | '样本不足，无法判断',
  segments: {
    early: { count, from, to },
    recent: { count, from, to },
    splitAt: number | null       // 探测到的变化点时间戳
  },
  metrics: [MetricResult],
  findings: [Finding],
  criticalIssues: [Finding],     // findings 中 severity === 'critical' 的子集
  coverage: { records, usable, bySource, byModel, spanDays },
  notes: string[],
  startedAt, finishedAt
}
```

### 10.4 MetricResult

```js
{
  id: 'truncation_rate',
  label: '截断率（finish_reason=length）',
  unit: '%' | 'ms' | 'tok' | 'ratio',
  status: 'ok' | 'insufficient',      // insufficient 不参与评分，也不显示为 0
  early: number | null,
  recent: number | null,
  deltaPct: number | null,            // (recent - early) / |early|
  direction: 'worse' | 'better' | 'flat',
  samples: { early: number, recent: number },
  series: [{ t: number|null, v: number }],   // 供折线图；最多 500 点（降采样）
  definition: string                  // 一句话口径说明，UI 原样展示
}
```

### 10.5 Finding

```js
{
  id: 'truncation_spike',
  severity: 'info' | 'warning' | 'critical',
  metric: 'truncation_rate',
  title: '截断率显著上升',
  detail: '近期 24% 的响应因达到长度上限被截断，早期仅 1.2%。',
  evidence: { early: 0.012, recent: 0.24, deltaPct: 19 },
  suggestion: '检查是否被中转站改小了 max_tokens，或模型被换成输出上限更低的版本。'
}
```

## 11. 指标清单（冻结 id）

| id | 含义 | 「变差」的方向 | 权重 | critical |
| --- | --- | --- | --- | --- |
| `truncation_rate` | `finish_reason ∈ {length,max_tokens}` 占比 | 上升 | 1.4 | 是（>15% 且较早期翻 5 倍） |
| `model_substitution` | 响应 `model` 与请求 `requestModel` 不一致的占比 | 上升 | 1.5 | 是（>10%） |
| `thinking_presence` | 含 thinking 块/思考 token 的记录占比 | 下降 | 1.3 | 是（早期 >50% 且近期 ≈0） |
| `thinking_share` | thinking tokens / 总输出 tokens | 下降 | 1.1 | 否 |
| `token_inflation` | 字符数 / 输出 token（越低越像 token 被多算） | 下降 | 1.2 | 否（降幅 >40% 记 warning） |
| `output_length` | 输出 token 中位数 | 下降 | 1.0 | 否 |
| `completion_ratio` | 输出 token / 输入 token | 下降 | 0.7 | 否 |
| `latency_median` | 端到端延迟中位数 | 上升 | 0.8 | 否 |
| `error_rate` | 非成功响应占比 | 上升 | 1.2 | 否 |
| `refusal_rate` | 拒答型回答占比 | 上升 | 0.6 | 否 |
| `repetition_rate` | 重复 n-gram 占比 | 上升 | 0.7 | 否 |
| `empty_rate` | 空回答占比 | 上升 | 0.9 | 否 |
| `cache_hit_rate` | 缓存命中占比 | 下降 | 0.5 | 否 |

> 指标只有 `status: 'ok'` 且早期/近期各有 ≥ 5 个样本时才参与评分。
> 全部指标都不可用 → `verdict: 'insufficient'`。

## 12. 判定与评分（冻结）

```js
export function scoreDegradation(metrics, findings) -> {
  score, evidenceStrength, verdict, summaryText
}
```

- 单指标归一化恶化分：`badness = clamp(deltaPct / 0.5, 0, 1)`（变化 50% 记满分），
  仅取「变差方向」的变化；反向变化记 0 但保留在报告中展示。
- `score = 100 × Σ(badness_i × weight_i) / Σ(weight_i)`，
  **分母只统计可用指标**（`status: 'ok'`）—— 与 v2 的 `skip` 语义一致，不可用不进分母。
- `evidenceStrength = saturate(可用指标数 / 4) × saturate(usable / 50)`，
  饱和函数 `saturate(x) = x / (x + 1)`，`usable` = 参与分析的记录数（`kind` 为 assistant/usage）。

> **为什么是 /4 与 /50（v3.1 修正）**：早期写成 `saturate(可用指标/8) × saturate(总记录/200)`，
> 由于 `saturate(13/8)` 上限只有 0.619，要过 0.35 闸门需要 ~261 条记录 ——
> 这会让**单次会话**（典型 40–150 条可用记录）永远判成「样本不足」，属于设计缺陷。
> 新参数下：100 条可用记录 + 5 个可用指标 → `0.556 × 0.667 = 0.371`，可以出结论；
> 30 条 + 13 指标 → `0.287`，仍判 `insufficient`（合理）。
- 判定：

| 条件 | verdict |
| --- | --- |
| 可用指标数 < 3 或 可用记录 < `minRecords` | `insufficient` |
| 存在 criticalIssue | `likely-degraded`（无论分数） |
| `evidenceStrength < 0.35` | `insufficient` |
| `score >= 60` | `likely-degraded` |
| `score >= 30` | `suspicious` |
| 其它 | `stable` |

## 13. UI 契约（v3）

新增独立的「降智诊断」区块（与连接轴、真伪轴并列，**不混入** `detect()` 的报告）：

1. 拖拽 / 选择文件（支持多个 `.jsonl` / `.json` / `.csv` / `.log`）；显示每个文件的
   自动识别格式、解析条数、跳过行数与错误。
2. 常驻隐私提示：「日志只在你的浏览器内存中解析，不会上传」+「分析完成后清空」按钮。
3. 分析结果：verdict 徽章、`score`、`evidenceStrength`、前后期时间范围与变化点、
   指标表格（early / recent / delta / 方向 / 样本数）、指标折线图（SVG，降采样到 ≤500 点）、
   findings 列表（critical 红 / warning 黄 / info 灰，含 suggestion）、JSON 导出。
4. **必须展示的免责声明**：日志只能反映「可观测行为的变化」，无法证明模型智力下降；
   输出长度下降也可能是任务分布变化、系统提示词变化或缓存策略变化。
5. 样本不足时显示 `insufficient` 与「还需要多少条 / 多长时间跨度」的具体建议。

## 14. 测试契约（v3）

必须覆盖（全部离线，用内置合成日志）：

1. **五个**解析器各一组 fixture：Claude Code JSONL、**Codex rollout JSONL**、通用 API 日志 JSONL、
   用量 CSV、ChatGPT 导出 JSON。
2. 格式**自动识别**：把同一份日志分别伪装成不同扩展名，仍应识别为正确格式。
3. **退化场景**：构造「早期正常、近期截断率 24% + 输出变短 + thinking 消失」的合成日志 →
   `verdict === 'likely-degraded'`，且 findings 含 `truncation_spike` / `thinking_collapse`。
4. **稳定场景**：构造指标前后无变化的日志 → `verdict === 'stable'`、无 critical。
5. **样本不足**：5 条记录 → `insufficient`，且 `score` 不得被当成「退化 0 分」展示。
6. **隐私**：`JSON.stringify(report)` 中不得出现日志原文片段（用唯一标记串搜索）与完整文件路径。
7. 单文件解析失败不影响其它文件；`parseLogFiles` 与 `analyzeDegradation` **绝不抛异常**。
8. `status: 'insufficient'` 的指标**不进分母**（与 v2 的 `skip` 语义一致）。
