# 本地代理（proxy/server.mjs）

浏览器模式有两个**硬限制**：跨域请求被 CORS 过滤后读不到完整响应头，而且浏览器
JavaScript **无法读取 TLS 证书**。本代理在**你自己的机器上**补上这两块能力，让检测报告
多出 `headers.*` 与 `tls.*` 两类证据。

> 契约依据：`docs/CONTRACT.md` 2.7（本地代理接口）与 1.2（TLS 信息结构）。

---

## 快速开始

```bash
node proxy/server.mjs
# 或 npm start / npm run proxy
```

默认监听 `http://127.0.0.1:8787`，只绑定环回地址，局域网内其他机器访问不到。

```bash
curl http://127.0.0.1:8787/health
curl "http://127.0.0.1:8787/inspect?host=api.anthropic.com&port=443"
curl "http://127.0.0.1:8787/proxy?url=https%3A%2F%2Fapi.anthropic.com%2Fv1%2Fmodels"
```

启动后也可以直接用浏览器打开 <http://127.0.0.1:8787/>：代理会静态托管仓库根目录
（等价 GitHub Pages），页面里选「本地代理」模式即可。

### 命令行参数

| 参数 | 默认值 | 说明 |
| --- | --- | --- |
| `--host <addr>` | `127.0.0.1` | 监听地址。改成非环回地址会打印警告 |
| `--port <n>` | `8787` | 监听端口 |
| `--allow-private` | 关闭 | **放宽**私网/环回/链路本地限制，仅用于调试（见下） |
| `--max-request-bytes <n>` | `1048576`（1 MiB） | 请求体上限，超出返回 `413` |
| `--max-response-bytes <n>` | `2097152`（2 MiB） | 响应体上限，超出直接截断并打标 |
| `--timeout <ms>` | `30000` | 一次请求（含全部重定向跳）的总超时 |
| `--max-concurrency <n>` | `8` | `/proxy` 与 `/inspect` 的并发上限，超出返回 `503` |
| `--max-redirects <n>` | `5` | 最多跟随的重定向跳数 |
| `-h, --help` | — | 帮助 |

---

## 路由

### `GET /` 静态托管

托管仓库根目录，带路径穿越防护：编码后的 `..`、点文件/点目录（`.git`、`.env`、`.github` 等）
一律拒绝；所有响应都在 `ROOT` 目录边界内解析。找不到文件时返回带提示的 404 页面。

### `GET|POST /proxy?url=<encoded>`

透传请求并**原样回显上游真实响应头**，同时附加：

| 响应头 | 含义 |
| --- | --- |
| `x-relay-detector-proxy: 1` | 标记该响应经过本代理（所有 `/proxy` 响应都有，含错误响应） |
| `x-relay-detector-hop: <n>` | 实际跟随的重定向跳数（`0` 表示直连命中） |
| `x-relay-detector-final-url` | 最终命中的 URL |
| `x-relay-detector-redirects` | 重定向链（JSON + URL 编码），仅在发生跳转时出现 |
| `x-relay-detector-redirect-limit: 1` | 达到跳数上限，原样回传 3xx |
| `x-relay-detector-location` | 3xx 时上游原始 `Location`（`location` 本身被改写回代理路径） |
| `x-relay-detector-truncated: 1` | 响应体超过上限被截断（此时不再保留 `content-encoding`） |
| `x-relay-detector-tls-authorized: 0/1` | 上游证书校验结果 |
| `x-relay-detector-stream-error: 1` | 上游流在中途出错 |

行为说明：

- `follow=0` 可关闭重定向跟随，直接把 3xx 回传给调用方。
- 回传的 3xx 会把 `Location` 改写为 `/proxy?url=<原目标>`，这样调用方即使自行跟随，
  也仍然会经过代理并再次接受逐跳校验；原始地址保留在 `x-relay-detector-location`。
- 转发时会剔除逐跳头（`connection` / `transfer-encoding` / `upgrade` 等）、浏览器安全头
  （`sec-*`）、`origin` / `referer`，并由目标 URL 重算 `Host`。
- 请求头的原文照常上行（API Key 必须真的送到上游才可能拿到错误报文），但**绝不写日志、绝不落盘**。

### `GET /inspect?host=<host>&port=443`

用 `node:tls` 连接对端并读取 peer certificate，返回契约 1.2 的 `meta.tls` 字段。
响应同时给出**顶层字段**和嵌套的 `tls` 对象，两种取法都可以：

```json
{
  "ok": true,
  "host": "api.anthropic.com",
  "port": 443,
  "resolvedAddress": "…",
  "authorized": true,
  "authorizationError": null,
  "issuer": { "C": "US", "O": "Google Trust Services", "CN": "WE1" },
  "subject": { "CN": "api.anthropic.com" },
  "altNames": ["api.anthropic.com"],
  "validFrom": "Sep 21 18:15:27 2026 GMT",
  "validTo": "Dec 20 19:15:03 2026 GMT",
  "protocol": "TLSv1.3",
  "cipher": "TLS_AES_256_GCM_SHA384",
  "fingerprint256": "BF:92:…",
  "selfSigned": false,
  "daysRemaining": 63,
  "chain": [{ "subject": {}, "issuer": {}, "altNames": [], "validFrom": "…", "validTo": "…", "fingerprint256": "…" }],
  "tls": { "…与上面 tls 字段完全相同…" }
}
```

`authorized` 来自 `rejectUnauthorized: false` 的连接，因此**自签 / 过期证书也能拿到证书内容**
（这正是我们需要观测的对象），证书是否可信由 `authorized` 与 `authorizationError` 表达。

### `GET /health`

```json
{ "ok": true, "version": "1.0.0" }
```

`version` 优先取冻结的 `src/core/constants.js` 里的 `VERSION`；源码不可用时回退 `1.0.0`。

### 方法与 405

| 路由 | 允许的方法 | 其它方法 |
| --- | --- | --- |
| `/health`、`/inspect` | `GET`、`HEAD` | `405`（带 `Allow: GET, HEAD`） |
| `/proxy` | `GET`、`POST`、`HEAD` | `405`（带 `Allow: GET, POST, HEAD`） |
| 静态 `/…` | `GET`、`HEAD` | `405`（带 `Allow: GET, HEAD`） |
| 任意路由 | `OPTIONS` | `204` 预检，无副作用 |

只读路由只接受 GET/HEAD（契约 2.7 只声明 `GET /health` 与 `GET /inspect`）；
`/proxy` 按契约声明接受 GET/POST，`PUT` / `PATCH` / `DELETE` 一律 `405`。

### CORS

所有响应带 `Access-Control-Allow-Origin: *`、`Access-Control-Expose-Headers: *`，
并对 `OPTIONS` 预检返回 `204`。预检的 `Access-Control-Allow-Headers` 会**回显**
`Access-Control-Request-Headers`——因为 `Authorization` 不能被 `*` 通配。

---

## 安全说明（红线，逐条实现）

| 红线 | 实现方式 |
| --- | --- |
| 仅 http/https | `/proxy` 与重定向目标都检查协议，其余（`file:`、`gopher:`、`data:`…）返回 `400 unsupported_protocol` |
| 拒绝私网/环回/链路本地 | `10/8`、`172.16/12`、`192.168/16`、`127/8`、`169.254/16`、`0/8`、`100.64/10`、`192.0.0/24`、`198.18/15`、`224/4` 及以上保留段；IPv6：`::1`、`fc00::/7`、`fe80::/10`、`ff00::/8`、`::ffff:` 映射、NAT64 `64:ff9b::`、6to4 `2002::` 等。命中返回 `403 private_target_blocked` |
| 防 DNS 绕过 / rebinding | 先 `dns.lookup({ all: true })` 解析，**任一**地址落在非公网段即整体拒绝；随后把连接 `lookup` 固定到已校验的那个 IP，校验后不会再次解析 |
| 重定向逐跳校验 | 手动跟随重定向，每一跳都重新执行「协议 + 地址 + DNS 固定」校验 —— 302 指向 `169.254.169.254` 或 `file:` 都会被拦下 |
| 请求体 / 响应体上限 | 请求体超过上限立即 `413` 并停止缓冲；响应体超过上限截断 + `x-relay-detector-truncated: 1` |
| 连接与总超时 | 单跳静默/连接超时 `--timeout` 内按剩余时间收紧；总超时覆盖全部跳，超时返回 `504` |
| 并发上限 | `/proxy` 与 `/inspect` 共用计数器，超出返回 `503 busy` |
| 密钥不落盘、日志脱敏 | 代理不写任何文件；`authorization` / `x-api-key` / `x-goog-api-key` / `cookie` / `set-cookie` 只保留前 6 位 + 长度标记；URL 里的 `api_key` / `token` / `key` 等 query 参数替换为 `<redacted>`；请求头干脆不打印 |

实测（本机，2026-10-19）：

```text
$ curl "http://127.0.0.1:8787/proxy?url=http%3A%2F%2F127.0.0.1%3A8787%2Fhealth"
403 {"ok":false,"error":"private_target_blocked","message":"目标 127.0.0.1 解析到非公网地址 127.0.0.1；…"}

$ curl "http://127.0.0.1:8787/proxy?url=file%3A%2F%2F%2FC%3A%2FWindows%2Fwin.ini"
400 {"ok":false,"error":"unsupported_protocol","message":"仅允许 http/https，拒绝 file:"}

$ curl "http://127.0.0.1:8787/inspect?host=169.254.169.254"
403 {"ok":false,"error":"private_target_blocked","message":"…"}
```

### `--allow-private` 的风险

打开后 SSRF 防护被放宽：页面（或任何能访问本代理的进程）可以让代理去请求**内网服务**，
包括云元数据端点。仅在你明确要检测一个内网部署的网关时临时使用，不要长期开启，
更不要把它和 `--host 0.0.0.0` 一起用。

### 已知边界

- **证书不校验**（`rejectUnauthorized: false`）：为了观测自签/过期证书而故意如此。
  这意味着经本代理的流量在理论上可被中间人替换。仅在你信任的本机链路上使用。
- DNS 校验与连接之间用「固定已校验 IP」消除 rebinding 窗口，但**不覆盖 HTTP 代理链**：
  `HTTP_PROXY` / `HTTPS_PROXY` 环境变量在本进程里不生效（我们不使用 `fetch` 转发）。
- `x-relay-detector-*` 头全部暴露给调用方，其中 `x-relay-detector-redirects` 含上游 URL；
  这些 URL 本身可能带 query，代理已把密钥型参数脱敏后才写入链记录。
- 静态托管只服务于本地验证：没有 range 请求、没有 gzip 预压缩、没有强缓存。

---

## 排错

| 现象 | 原因 / 处理 |
| --- | --- |
| `EADDRINUSE` | 端口被占用，换 `--port` |
| `/proxy` 返回 `403 private_target_blocked` | 目标（或它重定向到的地址）不是公网地址；确需访问再加 `--allow-private` |
| `/proxy` 返回 `502 dns_failed` | 本机解析不了该域名（离线 / DNS 受限） |
| `/inspect` 返回 `502 tls_connect_failed` | 目标不可达或不是 TLS 服务 |
| `/proxy` 返回 `504 upstream_timeout` | 目标超时，适当调大 `--timeout` |
| 响应体被截断 | 调整 `--max-response-bytes` |
| 页面里读不到 `x-*` 头 | 确认页面走的是代理模式（`proxyUrl`）；跨域头需要 `Access-Control-Expose-Headers`（已提供 `*`） |
| HTTPS 页面请求 `http://127.0.0.1:8787` 失败 | 部分浏览器会按混合内容拦截；改用代理托管页面 <http://127.0.0.1:8787/> 或本地 HTTP 服务 |
