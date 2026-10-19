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
