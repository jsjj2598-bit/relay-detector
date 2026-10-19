# relay-detector · API 中转站识别器

判断一个 OpenAI 兼容 / Anthropic Claude / Google Gemini 的 API 基址，究竟连的是
**官方直连**、**正规厂商自建端点**，还是**第三方中转站**（one-api / new-api / 各类反代与聚合网关），
并输出带证据链与不确定性的**多层指纹评分报告**。

- 纯静态、无构建步骤：整个页面就是原生 ESM + 原生 CSS，可直接托管到 GitHub Pages。
- 可选的本地 Node 代理（`proxy/server.mjs`）补上浏览器拿不到的两类证据：**完整响应头**与 **TLS 证书**。
- 不硬编码中转站黑名单，只做**特征**判定；每个结论都必须附带 `evidence` 与 `confidence`。
- 所有文案为中文；报告明确展示不确定性，**不声称「100% 确定」**。

> 接口契约：[docs/CONTRACT.md](docs/CONTRACT.md)（FROZEN v1）。所有模块只能按契约连接。

---

## 它回答什么问题

输入形如 `https://api.example.com/v1` 的基址（可选提供 API Key），工具发出**只读**探测
（默认不发送任何会产生费用的对话请求），然后回答：

1. 这个域名是官方域名吗？（`api.openai.com` / `api.anthropic.com` / `generativelanguage.googleapis.com`，以及 Azure OpenAI 等模式）
2. 响应头、错误报文、模型列表、TLS 证书里有没有**已知网关软件**或**聚合转发**的特征？
3. 综合来看，更可能是 `relay` / `likely-relay` / `inconclusive` / `likely-official` / `official`？

它**不**回答「这家服务商是否可信」「是否违反条款」「延迟与价格如何」。它不是安全审计工具，
更不是法律意见。

---

## 判定原理（多层指纹）

证据按类别加权：**只有方向性明确的特征才计分**；中性特征只作为展示与解释，不推动结论。

| 类别 | 典型规则 id | 观察对象 | 方向 | 说明 |
| --- | --- | --- | --- | --- |
| `url` | `url.official_host` | 主机名白名单 / Azure 模式 | official | 命中官方域名才给官方分 |
| `url` | `url.nonstandard_port` | 非 443 端口 + 自建网关迹象 | relay | 「非官方域名」**本身不作为中转证据** |
| `tls` | `tls.self_signed` | 证书自签 / 不受信 | relay | 自签证书是自建网关的常见特征 |
| `tls` | `tls.official_issuer` | 签发者属于官方已知 CA（如 Google Trust Services） | official | 仅作**正向**加分 |
| `tls` | `tls.cloudflare_issuer` | Cloudflare / Let's Encrypt / AWS / DigiCert… | **neutral** | 公共 CA 与 CDN 不代表中转（见下） |
| `headers` | `headers.cf_ray` | `server: cloudflare` / `cf-ray` | **neutral** | **官方 Anthropic 端点本身就在 Cloudflare 后** |
| `headers` | `headers.openai_version_present` | `openai-version: 2020-10-01`、`openai-processing-ms`、`x-request-id: req_…` | official | 官方独有头，中转站一般不会伪造 |
| `error` | `error.openai_shape` | `{"error":{"message","type","param","code"}}` 四字段齐全 | official | 官方错误对象结构 |
| `error` | `error.oneapi_shape` | `{"code":401,"message":"无效的令牌","data":null}` | relay | one-api / new-api 风格扁平业务包装体 |
| `error` | `error.edge_blocked` | `403 {"error":{"type":"forbidden","message":"Request not allowed"}}` | **neutral** | 边缘防护拦截，非 API 自身鉴权，**必须判为无法判定** |
| `models` | `models.oversized_list` | `/v1/models` 混入 `claude-` / `gemini-` / `qwen-` 等多家家族 | relay | 多上游聚合的强特征 |
| `models` | `models.official_overlap_low` | 与官方模型家族重合度极低 | relay | 弱证据，需配合其它类别 |
| `payload` | `payload.system_fingerprint_missing` | 响应载荷缺少官方系统字段 | relay | 弱证据 |
| `behavior` | `behavior.latency_outlier` | 延迟异常，符合「再转发一跳」 | relay | 弱证据，受网络影响大 |
| `signature` | `signature.one_api` | 报文/头部出现已知网关软件指纹 | relay | 集中维护在 `src/core/signatures.js` |

> 表中的 id 是契约（`docs/CONTRACT.md` 第 3 节）约定的命名空间示例；实际规则 id、权重与
> `confidence` 取值理由由 engine 在 `docs/ENGINE-NOTES.md` 中逐条说明，以实际实现为准。

评分数学由 `src/core/score.js` 提供（冻结）：

| 条件 | 判定 |
| --- | --- |
| 证据强度 `evidenceStrength < 0.40` | `inconclusive`（**证据不足，不下结论**） |
| `score >= 70` | `relay` |
| `58 <= score < 70` | `likely-relay` |
| `42 <= score < 58` | `inconclusive` |
| `30 <= score < 42` | `likely-official` |
| `score < 30` | `official` |

分数是**启发式**的，不是概率。`evidenceStrength` 单独展示，便于看出结论到底有多虚。

### 关键设计结论：「响应头像官方」只证明上游是真的，不证明你连的是官方

官方头（`openai-version`、`openai-processing-ms`、`openai-organization`、`x-request-id` 等）
在反向代理下会被**原样透传**：中转站把你的请求转发给官方，官方返回什么头，中转站就回传什么头。
所以「响应头长得像官方」只能说明**它的上游确实是官方实现**，不能说明**你连的就是官方**。

因此本项目以**域名身份**作为直连判定的核心依据，并在 `src/core/score.js` 里实现了
**域名身份降级闸门**：当一次检测中没有任何 `category: 'url'` 的 official 信号时，
即使分数落在 `official` / `likely-official` 区间，也一律降级为 `inconclusive`。
报告里的 `flags.urlIdentityConfirmed`、`flags.officialDowngraded`、`flags.upstreamLooksGenuine`
会如实标出「上游看起来是真的，但域名身份未确认 ⇒ 很可能正在经由代理访问」。

### 关键校准：Cloudflare / 公共 CA ≠ 中转站

这是本项目最重要的一条结论，写在 `src/core/constants.js` 的 `CALIBRATION` 里，并有实测支撑：

> **`api.anthropic.com` 官方端点本身就位于 Cloudflare 之后（`server: cloudflare`），
> 并且证书由 Google Trust Services（WE1）签发，而不是 Anthropic 自签。**

本机实测（`node proxy/server.mjs` + `GET /inspect?host=api.anthropic.com`，2026-10-19）：

```text
issuer:  { C: 'US', O: 'Google Trust Services', CN: 'WE1' }
subject: { CN: 'api.anthropic.com' }
protocol: TLSv1.3   cipher: TLS_AES_256_GCM_SHA384   selfSigned: false   daysRemaining: 63
server: cloudflare  cf-ray: …-LAX
403 {"error":{"type":"forbidden","message":"Request not allowed"}}   ← 边缘防护，不是鉴权响应
```

因此：

- 「用了 Cloudflare」「证书是公共 CA 签发」「域名不是官方域名」**三条都不能单独作为中转证据**，
  它们最多是中性观察项。
- 把官方直连误判成中转站，是本项目**最大的失败模式**。宁可输出 `inconclusive`，不要输出错误的 `relay`。
- 已知中转软件指纹（one-api 的 `"type":"one_api_error"`、扁平 `{"code":401,…,"data":null}`、
  中文网关提示语、`upstream_error` 等）才是方向性明确的 relay 证据，且每条都附带
  「非确定性证据」说明与 `confidence`。

---

## 局限性（必读）

1. **浏览器模式受 CORS 限制**：跨域请求默认拿不到完整响应头；`cf-ray`、`openai-version`、
   `anthropic-ratelimit-*` 这类头经常被过滤，甚至完全读不到。预检失败时请求根本不发出。
2. **浏览器无法读取 TLS 证书**：JavaScript 没有访问 peer certificate 的能力，
   所以 `tls.*` 规则在浏览器模式下恒为空。要看证书必须用本地代理。
3. **「响应头像官方」≠ 官方直连**：官方响应头（`openai-version` / `openai-processing-ms` /
   `openai-organization` 等）在反向代理下会被**原样透传**，它只能证明上游是官方实现，
   不能证明你连的是官方。本项目以**域名身份**作为直连判定的核心依据，并靠 `src/core/score.js`
   的**域名身份降级闸门**兜底：没有 `category: 'url'` 的 official 信号时，
   `official` / `likely-official` 一律降级为 `inconclusive`（详见上一节设计结论）。
4. **Cloudflare / 公共 CA / 非官方域名 ≠ 中转站**：见上一节实测校准。这是本项目最容易被误用的地方。
5. **边缘防护响应必须判为「无法判定」**：`403 {"error":{"type":"forbidden","message":"Request not allowed"}}`
   是 CDN/WAF 的拦截，不是 API 自身鉴权，也不是中转证据。
6. **本机网络受限导致的证据缺失**：开发环境实测仅 `api.anthropic.com` 可达，
   `api.openai.com` 与 `generativelanguage.googleapis.com` 不可达；因此部分官方头/证书事实
   是「高置信常识」而非本机实测，`confidence` 取值偏保守（0.5~0.65）。
7. **分数不是概率**：`score` 是加权启发式，类别权重与阈值是人为设定的，跨网络环境可能偏差。
   `evidenceStrength < 0.40` 时一律 `inconclusive`。
8. **模型列表依赖密钥与权限**：没有 Key 时 `/v1/models` 常返回 401/403，能看到的证据有限；
   有 Key 时也未必列出全部模型。所以「模型列表混入多家家族」是强证据，但「没混入」不是清白证明。
9. **聚合平台与灰产中转不同**：`openrouter.ai` 一类平台本质就是多上游代理，是公开的商业模式，
   与「伪装成官方的灰产中转」不是一回事；报告用词会区分，但判断仍可能让使用者不适。
10. **CDN / 共享 IP 不可作为证据**：同一 CDN 上既有官方也有中转站，IP 段、ASN、延迟都不足以定性。
11. **DNS rebinding 等对抗手段**：本代理已用「先解析、再固定 IP」缓解，但攻击者仍可能用
    TLS 层做手脚；本工具也不检测请求内容是否被篡改。
12. **不做请求内容的隐私审计**：代理会把你提供的 Key 原样转发给目标（必须如此才能拿到错误报文），
    请自行确认目标可信。
13. **HTTPS 页面 → `http://127.0.0.1` 可能被混合内容策略拦截**：部分浏览器在 HTTPS 页面上
    会拦截到 `http://127.0.0.1:8787` 的请求。推荐直接用代理自己托管的页面
    （<http://127.0.0.1:8787/>）做检测，或者把页面放在本地 HTTP 服务下。

**结论必须带不确定性一起读。** 报告里的每条信号都可以展开看 `evidence` 原文，
我们鼓励你按证据自己判断，而不是只看那个大徽章。

---

## 快速开始

两种模式，任选其一。页面本身不需要任何构建步骤。

### 方式 A：GitHub Pages（纯浏览器，零安装）

1. Fork / 克隆本仓库。
2. 仓库 Settings → Pages → Build and deployment → Source 选 **GitHub Actions**。
3. 推送到 `main`，`.github/workflows/pages.yml` 会先跑测试再部署仓库根目录。
4. 打开 Pages 地址，填入 API 基址 → 点「开始检测」。

浏览器模式的证据有限（见「局限性」第 1、2 条），报告会明确标注 `capabilities`。

### 方式 B：本地代理（推荐，能读 TLS 与完整响应头）

```bash
git clone <this-repo> && cd relay-detector
node proxy/server.mjs            # 默认 http://127.0.0.1:8787
```

然后二选一：

- 浏览器打开 <http://127.0.0.1:8787/>，模式选「本地代理」，代理地址填 `http://127.0.0.1:8787`；
- 或直接用接口自测：
  ```bash
  curl "http://127.0.0.1:8787/health"
  curl "http://127.0.0.1:8787/inspect?host=api.anthropic.com&port=443"
  curl "http://127.0.0.1:8787/proxy?url=https%3A%2F%2Fapi.anthropic.com%2Fv1%2Fmodels"
  ```

详细路由、响应头语义与参数见 [proxy/README.md](proxy/README.md)。

---

## 本地代理安全说明

代理是在**你自己机器上**运行的、只绑定环回地址的辅助进程。它的设计目标是「不成为新的攻击面」：

- **只允许 `http` / `https`**，`file:` / `gopher:` / `data:` 等一律拒绝。
- **默认拒绝私网 / 环回 / 链路本地 / CGNAT / 组播 / NAT64 目标**：
  `10/8`、`172.16/12`、`192.168/16`、`127/8`、`169.254/16`、`100.64/10`、`0/8`、`224/4` 以上，
  IPv6 的 `::1`、`fc00::/7`、`fe80::/10`、`ff00::/8`、`::ffff:` 映射、`64:ff9b::`、`2002::` 等。
  命中返回 `403 private_target_blocked`，`/inspect` 同样受限（否则它就是个端口扫描器）。
- **防 DNS 绕过**：先解析全部 A/AAAA 记录，任一落在非公网段即整体拒绝；连接时把 `lookup`
  固定到已校验的 IP，消除「校验后 DNS 再变」的窗口。
- **重定向逐跳校验**：手动跟随每一跳并重新执行协议与地址校验，302 指向内网或 `file:` 都会被拦。
- **资源上限**：请求体默认 1 MiB（超出 `413`）、响应体默认 2 MiB（超出截断并打标）、
  单跳与总超时、并发上限（超出 `503`）。
- **密钥零落盘**：代理不写任何文件；日志里 `authorization` / `x-api-key` / `x-goog-api-key` /
  `cookie` 只留前 6 位与长度标记，URL 中的 `api_key` / `token` 等替换为 `<redacted>`。
- **`--allow-private` 是危险的调试开关**：打开后可以访问内网（含云元数据端点），
  仅在你明确要检测内网网关时临时使用。**不要**与 `--host 0.0.0.0` 同时使用。
- **证书不校验**（`rejectUnauthorized: false`）：为了观测自签/过期证书而刻意如此，
  证书是否可信通过 `authorized` / `authorizationError` 暴露。仅用于可信本机链路。

> 把本代理暴露到公网等于开放一个 SSRF 跳板，并且会把使用者的 API Key 转发到任意地址。
> 请不要这样做。

---

## 目录结构

```text
.
├─ index.html                 页面骨架（原生 ESM，无构建）
├─ src/
│  ├─ core/
│  │  ├─ constants.js         常量与校准事实（冻结，只读）
│  │  ├─ score.js             评分数学与判定阈值（冻结，只读）
│  │  ├─ engine.js            detect() 探测编排
│  │  ├─ probes.js            ProbeSpec 执行器（脱敏 / 截断 / 超时）
│  │  ├─ signatures.js        已知网关软件指纹
│  │  └─ rules/               通用规则（url / tls / headers / error / models / payload / behavior / signature）
│  ├─ providers/              openai.js / anthropic.js / gemini.js
│  ├─ ui/                     app.js / render.js / components.js
│  └─ styles/main.css
├─ proxy/
│  ├─ server.mjs              本地代理（契约 2.7）
│  └─ README.md               代理接口与安全说明
├─ test/                      Node 内置测试 + 伪造响应 fixture
├─ tools/fingerprint-official.mjs  官方端点指纹采集脚本（只读、匿名、不消耗额度）
├─ docs/CONTRACT.md           接口契约（FROZEN v1）
└─ .github/workflows/pages.yml 测试 + GitHub Pages 部署
```

## 开发与测试

```bash
npm test                 # 单元测试 + 契约一致性 + 伪造 fixture 回归（无需联网）
                         # = node --test "test/**/*.test.mjs"
node proxy/server.mjs    # 本地起代理并托管页面
node tools/fingerprint-official.mjs --json   # 重新采集官方端点指纹（匿名，不消耗额度）
```

> ⚠️ **不要写成 `node --test test/`**：Node 24 会把目录位置参数当作模块去 require，
> 报 `Error: Cannot find module '.../test'` 并以 exit 1 结束，**一个测试都不会跑**。
> 正确写法是 `npm test`（即 `node --test "test/**/*.test.mjs"`，glob 展开需要 Node 21+）。

CI（`.github/workflows/pages.yml`）在部署前先跑 `npm test`；若仓库里没有测试文件会优雅跳过。

**不使用任何运行时依赖**：只有 Node 内置模块与浏览器原生 API。`package.json` 里没有 `dependencies`。

## 免责声明

- 本工具只做**特征推断**，输出是启发式判断，**不是事实认定**，也不构成对任何服务商的指控或背书。
- 请仅对你**有权访问**的端点使用本工具；不要用它扫描或攻击他人系统。
- API Key 由使用者自行提供与保管。代理会把 Key 转发给目标端点，请确认目标是你要检测的对象。
- 因使用本工具产生的任何直接或间接后果（包括误判、额度消耗、账号风险、合规问题），
  作者与贡献者不承担责任。
- 本项目与 OpenAI、Anthropic、Google 或任何中转/网关软件项目均无隶属或关联关系。

## 许可

[MIT](LICENSE) © 2026 relay-detector contributors
