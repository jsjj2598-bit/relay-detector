# ENGINE-NOTES —— 检测引擎设计、规则依据与置信度取值理由

归属：engine（`src/core/engine.js`、`src/core/probes.js`、`src/core/rules/**`、`src/core/signatures.js`、`src/providers/**`）。
契约：`docs/CONTRACT.md` FROZEN v1（含 Lead 的 v1.1 / v1.2 / v1.3 向后兼容修订）。
只读依赖：`src/core/constants.js`、`src/core/score.js`（本文只说明如何**使用**它们，绝不改动）。

> **最重要的一条**：`constants.CALIBRATION` 实测表明官方 `api.anthropic.com` 本身就在 Cloudflare 后、
> 证书由 Google Trust Services 签发；受限网络下匿名请求还会拿到 `403 Request not allowed`。
> 因此「Cloudflare / 公共 CA / 非官方域名 / 通用 Server 头 / 边缘防护拦截」在本实现里**一律中性**，
> 绝不作为中转证据。把官方直连误判成中转是本项目最大的失败模式。

---

## 1. 导出清单

### 1.1 `src/core/engine.js`

| 导出 | 说明 |
| --- | --- |
| `detect(input)` | 主入口，**绝不抛异常**；失败体现为 `probes[].error` + `notes`。 |
| `normalizeBaseUrl(input, provider)` | 纯函数：补协议（无协议默认 `https://`，本机地址用 `http://`）、去尾斜杠、识别 `/v1`、丢弃 query/hash。 |
| `pickProvider(baseUrl, hint)` | 纯函数：`'openai' \| 'anthropic' \| 'gemini'`。 |
| `runRules(ctx, provider)` | 执行 `provider.rules` + `COMMON_RULES`，按 id 去重（保留第一个）。 |
| `createProxyTransport(proxyUrl, {fetchImpl})` | 返回与 fetch 同签名的 transport，包装成 `proxyUrl/proxy?url=<encoded>`，附带 `x-relay-detector-hop: 1`。 |
| `PROVIDERS` | `{ openai, anthropic, gemini }` 三个协议适配器。 |
| `DEFAULT_OPTIONS` / `DEFAULT_PROXY_URL` / `DETECTOR_VERSION` | 默认值。 |
| `normalizeOptions(raw)` | options 归一化与 clamp（timeoutMs 500..120000、maxModelsListed 1..100000）。 |
| `findMatchedOfficialHost(host)` | 供 `report.target.matchedOfficialHost` 使用。 |
| `joinPath` | 路径拼接（自动避免 `/v1`、`/v1beta` 重复）。 |
| `default` | `= detect`。 |

### 1.2 `src/core/probes.js`

`DEFAULT_TIMEOUT_MS`、`MAX_BODY_TEXT`(20000)、`MAX_RAW_BYTES`(2MiB)、`COMMON_PROBE_IDS`、
`joinPath`、`hostOf`、`portOf`、`isSecretHeaderName`、`redactHeaders`、`redactUrl`、`redactBody`、
`normalizeResponseHeaders`、`normalizeTlsInfo`、`classifyTransportError`、
`runProbe(spec, env)`、`runProbes(specs, env)`、`buildTlsProbeSpec(...)`、`buildUnknownPathProbeSpec(...)`。

### 1.3 `src/core/rules/index.js`

`COMMON_RULES`（45 条通用规则）、`default`，以及
`URL_RULES` / `TLS_RULES` / `HEADERS_RULES` / `ERROR_RULES` / `MODELS_RULES` / `PAYLOAD_RULES` / `BEHAVIOR_RULES` / `SIGNATURE_RULES`；
另导出辅助 `officialHeaderHits`、`detectEdgeProtection`、`findRecognizedErrorShape`、`familyOfModel`。

### 1.4 `src/core/signatures.js`

`RELAY_SOFTWARE_SIGNATURES`（re-export constants）、`SIGNATURE_DISCLAIMER`、`isFlatGatewayEnvelope`、
`SIGNATURE_IDS_OWNED_BY_OTHER_RULES`、`GATEWAY_BRANDING_REGEX`、`EXTRA_GATEWAY_SIGNATURES`、
`KNOWN_GATEWAY_SIGNATURES`、`SIGNATURE_IDS`。

### 1.5 `src/providers/*.js`

`openaiProvider`、`anthropicProvider`、`geminiProvider`（各含 `id/label/defaultBaseUrl/matches/buildProbes/rules`，
另可选实现 `buildFollowUpProbes`）。

### 1.6 `src/core/rules/util.js`

`mkSignal`（统一 clamp / 前缀 / evidence 兜底）、`eachProbe`、`firstProbe`、`headersOf`、`jsonOf`、`textOf`、
`combinedText`、`findHeader`、`modelIdsFrom`、`normalizeModelId`、`isObject`、`safeStringify`、`CATEGORY_PREFIX`。

---

## 2. 探测编排（安全约束）

`allowPaidProbes === false`（默认）时，实际发出的探测只有免费/必然失败的三类：

| probe id | 方法/路径 | 鉴权 | 条件 | 计费 |
| --- | --- | --- | --- | --- |
| `openai.models` | `GET {base}/v1/models` | `Authorization: Bearer` | 总是 | 否 |
| `openai.auth_error` | `GET {base}/v1/models` | 匿名 | 仅当用户提供了 key | 否 |
| `openai.models_detail` | `GET {base}/v1/models/{id}` | Bearer | 模型列表解析出 id 时（后续探测） | 否 |
| `common.not_found` | `GET {随机不存在路径}` | 匿名 | 总是 | 否 |
| `anthropic.models` | `GET {base}/v1/models` | `x-api-key` + `anthropic-version: 2023-06-01` | 总是 | 否 |
| `anthropic.auth_error` | 同上，匿名 | — | 仅当有 key | 否 |
| `gemini.models` | `GET {base}/v1beta/models` | `x-goog-api-key` | 总是 | 否 |
| `gemini.auth_error` | 同上，匿名 | — | 仅当有 key | 否 |
| `tls.peer` | `GET {proxyUrl}/inspect?host=&port=` | — | 仅 `mode === 'proxy'` | 否 |

仅在 `allowPaidProbes === true` 时追加：`openai.chat`（`POST /v1/chat/completions`，`max_tokens: 1`）、
`anthropic.messages`（`POST /v1/messages`，`max_tokens: 1`）、`gemini.generate`（`POST ...:generateContent`）。
这三条的 `ProbeResult.meta.paid = true`，并驱动 `capabilities.costIncurred`。

其它安全行为：

- 密钥只存在于探测执行的 `env.apiKey`；`ProbeResult` 中 `authorization` / `x-api-key` / `x-goog-api-key` 一律 `<redacted>`，
  URL 查询串里的 `key/token/secret/...` 也会被脱敏（`report.target.input` 同样脱敏）。
- `bodyText` 截断到 20000 字符并置 `meta.bodyTruncated`；`bodyJson` 用完整正文（上限 2 MiB）解析，保证结构规则不受截断影响。
- 超时（默认 12s，每个探测独立 deadline）+ 外部 `AbortSignal` 联动；错误归类为 `network | cors | timeout | http | aborted`。
- 顺序执行探测，避免对远端造成并发压力。

---

## 3. 规则总表（id / 方向 / weight / confidence）

`contribution = weight × confidence × CATEGORY_WEIGHTS[category]`（见 `score.js`）。

### 3.1 url（类别权重 1.0）—— 承重结构

| id | verdict | w | c | 依据与为什么不能更高 |
| --- | --- | --- | --- | --- |
| `url.official_host` | official | 70 | 0.92 | 精确命中 `OFFICIAL_HOSTS.openai/anthropic/gemini` 白名单。域名身份是唯一能证明「直连官方」而非「代理转发到官方上游」的证据，故权重最高；扣 0.08 是因为域名可被企业 DNS 劫持/本地 hosts 欺骗。 |
| `url.official_pattern` | official | 58 | 0.8 | 命中 `OFFICIAL_HOST_PATTERNS`（Azure OpenAI / Azure AI / Google 托管域）。属于正规厂商托管端点，但「Azure 定制域」与「自建反代用 azure 风格域名」在域名上不可区分，故低于精确白名单。 |
| `url.vendor_host` | official | 55 | 0.7 | 命中 `OFFICIAL_HOSTS.other_vendors`（deepseek/moonshot/x.ai/…）。它是正规厂商自有端点，**不是**官方 OpenAI 直连，也不是灰产中转；用于让 `urlIdentityConfirmed` 成立并避免被误判成中转。 |
| `url.aggregator_host` | neutral | 22 | 0.7 | 命中 `AGGREGATOR_HOSTS`（openrouter.ai）。本质是多上游代理，性质上不是官方直连也不是灰产中转，故中性，方向交给其它证据。 |
| `url.nonofficial_host` | neutral | 25 | 0.85 | 未命中任何白名单/模式。**非官方域名本身不足以定性为中转**（可能是 Azure 定制域、自建、聚合、企业定制域），这是契约 1.3 与质量红线 2 的硬性要求。 |
| `url.ip_host` | relay | 42 | 0.7 | 使用 IP 字面量。官方 API 一律使用固定域名；直接连 IP 常见于自建反代/内网网关，但也可能是企业内网合法入口。 |
| `url.http_scheme` | relay | 32 | 0.85 | 明文 HTTP（排除 localhost）。官方强制 HTTPS，明文说明未配置 TLS 的自建/内网网关。 |
| `url.nonstandard_port` | relay | 18 | 0.6 | 非 80/443 端口。常见于自建网关，但企业内网合法部署也用非标端口，指示力弱。 |
| `url.localhost_host` | neutral | 15 | 0.7 | 目标是环回地址，通常是你自己运行的本地代理，无法据此判断上游身份。 |

### 3.2 tls（类别权重 1.25，仅代理模式）

| id | verdict | w | c | 依据 |
| --- | --- | --- | --- | --- |
| `tls.cloudflare_issuer` | neutral | 20 | 0.9 | Cloudflare 签发的证书。**校准事实**：官方 api.anthropic.com 亦如此 ⇒ 中性。 |
| `tls.official_issuer` | official | 26 | constants 值（GTS 0.9） | 只有 `OFFICIAL_TLS_ISSUERS` 中 confidence ≥ 0.8 的签发者（Google Trust Services）才产出 official；DigiCert（0.6）只按公共 CA 中性处理。公共 CA 同时服务中转站，故权重低。 |
| `tls.public_ca` | neutral | 20 | 0.85 | Let's Encrypt / Amazon / Sectigo / ZeroSSL 等公共 CA ⇒ 中性（与 Cloudflare 互斥，避免重复）。 |
| `tls.self_signed` | relay | 48 | 0.8 | 自签名证书。公开 API 不会使用自签名；自建网关默认配置常见。 |
| `tls.not_authorized` | relay | 30 | 0.55 | 证书链未通过信任验证。可能是未知 CA/配置错误，也可能是读取方式导致，置信度中等。要求 `authorized === false` **显式**为假；读取失败时干脆不产出 `meta.tls`。 |
| `tls.altname_mismatch` | relay | 40 | 0.75 | SAN 不包含目标域名 ⇒ 证书并非为目标域名签发（共享反代网关特征）。 |
| `tls.short_validity` | relay | 22 | 0.55 | 剩余有效期 ≤ 3 天。自动化短期证书常见于自建网关，官方会提前续期，但偶发续期窗口也会命中。 |
| `tls.unavailable` | neutral | 0 | 0.9 | 代理模式 TLS 探测失败（如 `/inspect` 不可用）。weight 0：只记录事实，不影响评分。 |

### 3.3 headers（类别权重 0.85）

| id | verdict | w | c | 依据 |
| --- | --- | --- | --- | --- |
| `headers.cf_ray` | neutral | 20 | 0.9 | `cf-ray` / `server: cloudflare`。CDN 特征，官方同样位于 CF 后 ⇒ 中性。 |
| `headers.neutral_edge` | neutral | 18 | 0.85 | Akamai / Fastly / CloudFront / Vercel / Netlify 等公共边缘 ⇒ 中性。 |
| `headers.<官方特征头>` | official | 取自 constants | 取自 constants（0.5~0.65） | `openai-version` 34/0.55、`openai-processing-ms` 26/0.5、`openai-organization` 22/0.5、`x-request-id`(req_+32hex) 30/0.5、`request-id`(Anthropic) 26/0.6、`anthropic-ratelimit-*` 34/0.65 与 30/0.65。**反向代理会原样透传这些头**，只能证明上游是真的，不能证明直连；因此它是 official 方向的弱证据，并会被 `score.js` 的域名身份闸门降级。 |
| `headers.gateway_server` | relay | 12 | 0.4 | 直接暴露 nginx / OpenResty / uvicorn / Express 等通用 Server 头。官方也可能在 CDN 之后使用同类软件，权重与置信度都刻意压低，单独命中只会落在 inconclusive。 |
| `headers.official_markers_absent` | neutral | 10 | 0.5 | 「缺少官方头」不是证据（无 key、CORS 过滤、CDN 改写都会导致缺失），明确标为中性。 |
| `headers.wildcard_cors` | relay | 14 | 0.4 | `Access-Control-Allow-Origin: *`。面向浏览器开放的网关常见，但部分官方公开接口也开启 ⇒ 指示力很弱。 |

### 3.4 error（类别权重 1.3）

| id | verdict | w | c | 依据 |
| --- | --- | --- | --- | --- |
| `error.edge_protection` | neutral | **0** | 0.95 | `403 {"error":{"type":"forbidden","message":"Request not allowed"}}` 或 `cf-mitigated`。这是 CDN/WAF 的边缘拦截，**不是 API 自身鉴权响应**；weight 0 保证它既不抬高证据强度也不影响方向，从而该场景必然 inconclusive。 |
| `error.openai_shape` | official | 30 | 0.55 | `error` 对象同时具备 message/type/param/code 且 type 合法。伪造成本低 + 反向代理透传 ⇒ 弱正向证据。 |
| `error.anthropic_shape` | official | 28 | 0.6 | `{"type":"error","error":{...}}` 包装体。同上。 |
| `error.gemini_shape` | official | 26 | 0.5 | `error.code` 数值 + `error.status`（PERMISSION_DENIED 等）。Google 系网关也会复用该形状。 |
| `error.flat_gateway_envelope` | relay | 52 | 0.6 | 顶层扁平业务体 `{"code":N,"message":"...","data":null}`。**结构化判定**（`isFlatGatewayEnvelope`）：必须排除 `{"error":{...}}` 嵌套体，否则会误伤官方 Gemini 的错误体。自建业务网关也可能用该格式，故置信度中等。 |
| `error.unrecognized_auth_failure` | neutral | 6 | 0.5 | 401/403 但形状既非官方也非已知网关 ⇒ 无法判断方向。 |

> 去重设计：constants 的 `billing_shape` 正则会命中官方 Gemini 的嵌套错误体，因此它被列入
> `SIGNATURE_IDS_OWNED_BY_OTHER_RULES`，由 `error.flat_gateway_envelope` 统一负责，避免同证据双计分。

### 3.5 models（类别权重 0.8）

| id | verdict | w | c | 依据 |
| --- | --- | --- | --- | --- |
| `models.cross_family` | relay | 58 | 0.72 | 单端点同时列出多个厂商家族（openai/anthropic/gemini 三官方家族之外还混入 deepseek/qwen/llama 等），或第三方家族占多数/声明家族完全缺失 ⇒ 多上游聚合。官方端点只列自家家族；但只列单家上游的中转站不会命中，故未命中≠官方。 |
| `models.third_party_present` | relay | 26 | 0.5 | 少量第三方家族混入（阈值以下）。可能是厂商自有的兼容模型，指示力中等。 |
| `models.vendor_own_family` | neutral | 12 | 0.6 | 目标域名是已识别的正规厂商（白名单/Azure 模式），其 `deepseek-*` 等属于自有产品，不构成聚合证据（防误伤 `api.deepseek.com`）。 |
| `models.official_overlap_high` | official | 22 | 0.45 | 列表几乎全部命中声明协议的官方家族。中转站通常直接透传官方模型名 ⇒ 只能算很弱的正向证据。 |
| `models.oversized_list` | relay | 28 | 0.5 | 条目数 ≥ 200 或达到 `maxModelsListed` 解析上限。官方端点很少如此庞大，但聚合与大型厂商都可能超大。 |
| `models.unusable_list` | neutral | 8 | 0.6 | 拿到 `/models` 但解析不出条目 ⇒ 无法形成模型证据。 |
| `models.gemini_resource_names` | official | 20 | 0.5 | 模型名使用 `models/gemini-...` 资源全名（Gemini provider 专属规则）；中转站也可透传该字段。 |

### 3.6 payload（类别权重 1.15）

| id | verdict | w | c | 依据 |
| --- | --- | --- | --- | --- |
| `payload.paid_probe_skipped` | neutral | 0 | 1 | 默认未开启付费探测的说明性信号，weight 0。 |
| `payload.api_path_html` | neutral | 30 | 0.5 | API 路径返回 HTML。**这只证明「该路径不是 API 端点」**（错误域名/静态托管/部署未完成），与「是否中转」无因果关系 ⇒ 中性（verifier 发现的误判已修正）。 |
| `payload.cn_service_text` | relay | 22 | 0.35 | 成功响应出现中文计费/服务话术。官方成功响应一律英文 JSON，但低置信度（可能来自示例/文档）。 |
| `payload.non_json_response` | neutral | 8 | 0.6 | API 路径返回既非 JSON 也非 HTML 的正文 ⇒ 无法判断方向。 |
| `payload.openai_chat_shape` | official | 28 | 0.5 | 仅付费探测时：`object: "chat.completion"` + id + choices（openai provider 规则）。代理会透传 ⇒ 弱证据。 |
| `payload.openai_chat_metadata_missing` | relay | 45 | 0.6 | HTTP 200 但缺 object/id/choices ⇒ 中间层改写响应结构。 |
| `payload.openai_usage_missing` | relay | 20 | 0.4 | chat.completion 缺 `usage`。流式/兼容实现也可能省略。 |
| `payload.anthropic_message_shape` | official | 26 | 0.55 | `type: "message"` + content 数组（anthropic provider 规则）。 |
| `payload.anthropic_message_metadata_missing` | relay | 40 | 0.55 | HTTP 200 缺 `type: "message"`/content ⇒ 中间层改写。 |
| `payload.gemini_candidate_shape` | official | 26 | 0.5 | `candidates` 数组（常伴 `usageMetadata`）。 |

### 3.7 behavior（类别权重 0.5，整体低权重）

| id | verdict | w | c | 依据 |
| --- | --- | --- | --- | --- |
| `behavior.unknown_path_200` | neutral | 40 | 0.6 | 随机未知路径返回 200 ⇒ 存在兜底/首页路由。只说明该路径不是 API 端点（静态托管、SPA 回退、部署未完成）⇒ 中性（已修正）。 |
| `behavior.unknown_path_html` | neutral | 30 | 0.5 | 未知路径返回 HTML 错误页 ⇒ 同上，中性（已修正）。 |
| `behavior.unknown_path_official_404` | official | 18 | 0.45 | 未知路径返回官方风格结构化 404；伪造成本低 + 可透传 ⇒ 极弱正向证据。 |
| `behavior.cors_ambiguous` | neutral | 5 | 0.5 | 浏览器 `TypeError: Failed to fetch` 无法区分 CORS 与网络故障，必须标注不确定性。 |
| `behavior.unreachable` | neutral | 10 | 0.7 | 所有目标探测均无响应 ⇒ 无方向证据。 |
| `behavior.latency_outlier` | relay | 12 | 0.25 | `/models` 单次耗时 > 5s。网络/地理影响极大，也可能因二次转发上游造成，置信度极低。 |
| `behavior.uniform_gateway_envelope` | relay | 24 | 0.5 | 多个不同路径都返回同一种扁平网关包装体（≥2 条）⇒ 前端网关统一兜底。与 `error.flat_gateway_envelope` 是同一事实的不同侧面（该侧强调「所有路径一致」），故权重刻意压低。 |

### 3.8 signature（类别权重 1.4，最高）

来自 `constants.RELAY_SOFTWARE_SIGNATURES`（原 weight/confidence 原样采用）：

| id | w | c | 说明 |
| --- | --- | --- | --- |
| `signature.one_api_error_type` | 62 | 0.75 | `"type": "one_api_error"`，官方不会出现该取值。 |
| `signature.new_api_error_type` | 62 | 0.75 | `"type": "new_api_error"`。 |
| `signature.upstream_error_type` | 55 | 0.65 | `"type": "upstream_error"` ⇒ 请求被转发到另一上游。 |
| `signature.fastapi_detail` | 50 | 0.55 | `{"detail":"Not authenticated"}`（FastAPI 默认异常结构）。 |
| `signature.cn_error_message` | 45 | 0.6 | 错误信息为「无效的令牌/额度/分组/渠道/上游」等中文网关惯用词。 |
| `signature.insufficient_balance` | 40 | 0.55 | 「余额/额度不足」⇒ 存在计费转售方。 |

engine 补充指纹（`EXTRA_GATEWAY_SIGNATURES`）：

| id | w | c | 说明 |
| --- | --- | --- | --- |
| `signature.one_api_brand_header` | 60 | 0.7 | 响应头 `x-one-api-*`。 |
| `signature.new_api_brand_header` | 60 | 0.7 | 响应头 `x-new-api-*`。 |
| `signature.gateway_brand_header` | 40 | 0.45 | `x-(relay\|gateway\|proxy\|forward)-*`，用负向断言排除本工具自己的 `x-relay-detector-*`。也可能是运维自加追踪头。 |
| `signature.gateway_branding_text` | 42 | 0.55 | 正文出现 one-api/new-api/veloera 品牌串（HTML 页面时跳过，交由下一条）。 |
| `signature.html_gateway_title` | 48 | 0.6 | HTML `<title>` 含网关字样 ⇒ 该路径由自建网关网页路由处理。 |
| `signature.gateway_balance_field` | 38 | 0.5 | 正文出现 `"balance"/"quota"/"group"/"channel"/"upstream"` 字段 ⇒ 计费转售层。 |

`billing_shape`（constants 原 w=48 / c=0.6）**不在此列**，见 §3.4 的去重说明。

---

## 4. 与 score.js 的三个闸门协同

1. **方向证据硬闸门**（v1.1）：无任何 relay/official 信号时 `verdict` 强制 `inconclusive`。
   这使我们可以放心把 CDN / 公共 CA / 非官方域名 / 边缘拦截 / 「不是 API 端点」写成中性而不担心被误判为官方。
2. **域名身份闸门**（v1.2）：没有 `category === 'url' && verdict === 'official'` 的信号时，
   `official`/`likely-official` 一律降级为 `inconclusive`，并置 `flags.officialDowngraded`、
   `flags.upstreamLooksGenuine`（官方证据 ≥ 25 分时）。
   因此「转发到真实 api.openai.com 的中转站」（透传官方头与官方错误体）会被判为
   inconclusive + upstreamLooksGenuine，而不会被误判为官方直连。
3. **方向分绝对量闸门**（v1.3）：`relayPoints` / `officialPoints` 小于 `MIN_DIRECTIONAL_POINTS`(15) 时，
   relay / likely-relay / official / likely-official 一律降级为 `inconclusive`，
   `flags.insufficientDirectionalPoints = true`。
   这是对「score 是比例制」的必要补丁：唯一一条极弱方向证据会被放大成 100 分，
   绝对量闸门保证这类证据不会单独形成结论。引擎的规则权重因此可以保持保守。

引擎把 `score.js` 的 `flags`（v1.3 起共 5 个字段：`hasDirectionalEvidence`、`urlIdentityConfirmed`、
`officialDowngraded`、`insufficientDirectionalPoints`、`upstreamLooksGenuine`）、`breakdown`、`points`
原样透传到 `DetectionReport`（契约未强制，向后兼容），供 UI 解释「上游为真但身份未确认 / 方向证据过弱」。

---

## 5. 关键回归场景（已离线自测 + verifier 测试覆盖）

| 场景 | 期望 | 实测 |
| --- | --- | --- |
| `https://api.openai.com/v1` + 官方 401 体 + `openai-version` | 不判 relay | `official`（score 0，strength 0.72） ✅ |
| 非官方域名 + `{"code":401,"message":"无效的令牌","data":null}` + `server: nginx` | relay 方向 | `relay`（score 100，strength 0.71） ✅ |
| 非官方域名 + CF 403 `Request not allowed` + `cf-ray` | inconclusive | `inconclusive`（strength 0.25，无方向证据） ✅ |
| 官方域名 `api.anthropic.com` + CF 403 | 不判 relay | `official`（url.official_host 命中的正向证据） ✅ |
| 聚合型 `/v1/models`（gpt + claude + gemini + qwen + deepseek + llama） | relay 方向 | `relay`（score 100，strength 0.51） ✅ |
| 非官方域名 + 全路径 nginx HTML 欢迎页 | inconclusive | `inconclusive`（score 100 但 strength 0.36 < 0.40，且 relayPoints < 15 命中绝对量闸门） ✅ |
| 非官方域名 + 透传官方头/官方错误体（付费探测开启） | inconclusive + upstreamLooksGenuine | `inconclusive`，`flags.upstreamLooksGenuine = true` ✅ |
| 网络失败 / transport 抛错 / transport 返回垃圾 | 不抛异常，inconclusive | ✅ |
| 密钥脱敏（header + URL 查询串 + `target.input`） | 无泄漏 | ✅ |
| 正文 > 20000 字符 | 截断 + `meta.bodyTruncated` | ✅（含流式 body） |

---

## 6. 已知局限（含置信度取值理由）

1. **未联网取证**：本机网络受限（`api.openai.com`、`generativelanguage.googleapis.com` 不可达，
   web_search/fetch 密钥失效）。所有官方特征都来自 `constants.CALIBRATION` 与常识，未独立复测；
   因此官方头类信号 confidence 一律 ≤ 0.65，TLS 官方签发者也只给 0.9（而非 1）。
   唯一实测可达的 `api.anthropic.com` 事实（Cloudflare + GTS + 403 边缘拦截）已作为硬约束写入规则。
2. **`score` 是方向比例**：只要存在方向证据且没有对手，弱 relay 也会把 score 打满 100。
   因此我们把「非 API 端点」「CDN/公共 CA」「边缘拦截」「非官方域名」全部置为中性，
   并把 `headers.gateway_server`、`behavior.latency_outlier` 等压到极低权重；
   最终安全性依赖 `evidenceStrength < 0.40` 与两个闸门。**新增规则时必须同时评估对 strength 的影响。**
3. **浏览器模式**：无法读取 TLS；响应头会被 CORS 过滤（缺失≠没有）；`Failed to fetch` 无法区分
   CORS 与网络故障（记为 `error.kind='cors'` 并在 `behavior.cors_ambiguous` 标注）；HTTPS 页面直连
   `http://127.0.0.1:8787` 可能被混合内容策略阻止 —— 浏览器代理模式建议通过代理自身托管的页面
   （`http://127.0.0.1:8787/`）访问，使页面与代理同源。
4. **代理模式 TLS**：`tls.peer` 走本地代理 `/inspect`，反映「代理→目标」的对端证书；
   若代理不可用或返回不可用数据，我们**不产出** `meta.tls`（避免把「读取失败」误当「证书未授权」），
   改为 `tls.unavailable`（weight 0）。直连 `globalThis.fetch` 用于访问代理端点；
   若页面是 HTTPS 而代理是 HTTP，同样受混合内容限制。
5. **无法覆盖的情形**：
   - 关闭品牌特征、改写响应结构、伪造官方头的成熟中转站（可对抗所有 signature/headers 规则）。
   - 反向代理（透传官方一切）与官方直连的区别**只能**由域名身份决定，工具无法读取 DNS/网络路径。
   - Azure 定制域、企业自建合法网关、聚合平台与灰产中转在特征上高度重叠（例如自建网关同样使用
     `{"code","message","data"}` 扁平体、自签名证书、非标端口），只能给出嫌疑而非证明。
   - 计费/转售性质的判断依赖响应中的余额/额度字段，很多网关在错误路径上不暴露。
6. **行为类证据**：延迟、未知路径兜底、CORS 全部受网络与部署形态影响，权重与置信度都很低；
   不要单独依赖它们下结论。
7. **Gemini 未实测**：官方 Gemini 端点不可达，`/v1beta/models` 结构与错误形状来自公开协议知识
   （confidence 0.5~0.6）；`models.gemini_resource_names` 只作弱正向证据。
8. **`api.anthropic.com` 受限网络下的默认结果**：匿名探测会拿到边缘防护 403，此时引擎判
   inconclusive 并在 `notes` 明确指出「建议使用本地代理或带密钥重试」；这不是缺陷，而是校准后的正确行为。

---

## 7. 自测方式（不联网、不写 test/）

引擎自测通过 `node --input-type=module -e '<内联脚本>'` 使用伪造 transport 完成，
覆盖 §5 全部场景、Signal 形状约束（前缀/weight/confidence/evidence/verdict）、
付费门禁、脱敏、截断、超时/abort、畸形输入不抛异常、`createProxyTransport` 包装。
`test/**` 归 verifier 所有，engine 不写入。

> 环境备注（供 Lead / infra 参考）：本机 Node v24.14.0 下，`npm test`（即 package.json 的 `node --test test/`）正常运行
> 81/81 全绿；但在我这个 pwsh/cmd 会话里**直接**执行 `node --test test/`（目录参数）会报
> `Cannot find module ...\test`，而 `node --test`（默认发现）与 `node --test "test/**/*.test.mjs"` 正常。
> 这是 shell 参数传递差异，`npm test` 与 CI 按 `npm test` 调用即可，无需改动 package.json。
