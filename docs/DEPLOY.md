# 上线与分发指南（让「广大用户」能用）

本文件回答一个问题：**测试通过了，怎么把它变成别人也能用的服务？**

先说结论，避免最常见的误解：

> **部署一个静态页面 ≠ 广大的用户就能用。**
> 纯静态站能上线（5 分钟），但「普通用户打开就能检测」还差一环 —— **浏览器的 CORS 限制**。
> 这一环怎么补，决定了你选哪条分发路线（见第 2 节）。

---

## 0. 先做决策：四条分发通道

| 通道 | 用户门槛 | CORS 限制 | 能否读 TLS | 是否经手用户 Key | 成本 | 适合 |
| --- | --- | --- | --- | --- | --- | --- |
| **A. 纯静态站**（GitHub Pages / Cloudflare Pages） | 零安装，点开即用 | **受限**，取决于目标站是否允许跨域 | 否 | 否（Key 只在浏览器） | 免费 | 快速上线、给懂行的人用 |
| **B. 浏览器扩展**（Chrome / Edge MV3） | 装一次扩展 | **绕开**（`host_permissions` 不受 CORS 约束） | 否 | 否（Key 只在本地） | 免费 | **面向广大用户的最佳零后端方案** |
| **C. 本地代理 + 代理托管页面** | 要装 Node.js | 绕开 | **是** | 否（只到 127.0.0.1） | 免费 | 进阶用户、需要证书证据 |
| **D. 云端探测 API** | 零安装 | 绕开 | 是 | **是**（Key 会经过你的服务器） | 服务器/流量 | 想要「开箱即用」的商业化服务 |

**推荐路线（已按实际实现与实测更新）**：

1. **本周：双托管上线静态站** —— GitHub Pages（海外优先）+ Cloudflare Pages（国内可访问镜像），
   同一份产物、零成本，拿第一批反馈。见第 1 节。
2. **同步发布桌面端**（**已实现并实测通过**）—— 这是「广大用户真正可用」的关键：
   桌面端在本机进程发请求，**完全绕过 CORS**，还能读完整响应头与 TLS 证书。
   两种形态：零依赖启动器（`desktop/launch.cmd`，只需 Node）与 Electron 应用（原生窗口，可打包）。
   见第 2 节。
3. **可选：浏览器扩展** —— 零后端也能绕 CORS，但只覆盖「在用浏览器」的场景，且要过扩展商店审核。
4. **最后才考虑：云端探测 API**。它会引入 Key 托管责任、SSRF 滥用风险、服务器成本与合规问题。
   在没想清楚第 3 节红线之前**不要做**。

---

## 1. 阶段 A：5 分钟上线静态站

### 1.1 推到 GitHub

```bash
cd "C:\Users\27385\新建文件夹\relay-detector"
git remote add origin https://github.com/<你的用户名>/relay-detector.git
git branch -M main
git push -u origin main
```

### 1.2 打开 Pages

仓库 → **Settings → Pages → Build and deployment → Source** 选 **GitHub Actions**。

推送到 `main` 后，`.github/workflows/pages.yml` 会先跑 `npm test`（177 项），
通过后自动部署；失败则**不会**上线坏版本 —— 这是免费的发布门禁。

### 1.3 验证线上版本

```bash
curl -sI https://<你的用户名>.github.io/relay-detector/ | head -5
curl -s  https://<你的用户名>.github.io/relay-detector/ | grep -o '<title>.*</title>'
```

浏览器打开，确认页面能渲染、控制台无报错。

### 1.4 自定义域名（可选）

- 仓库 Settings → Pages → Custom domain 填域名（如 `relay.example.com`）。
- DNS 加一条 `CNAME` 指向 `<用户名>.github.io`。
- 勾选 **Enforce HTTPS**（等证书签发通常几分钟）。

> 注意：自定义域名后要同步修改 `index.html` 里的 `og:url` / `canonical`。

### 1.5 双托管：GitHub Pages + Cloudflare Pages（推荐「两者都要」）

`*.github.io` 在国内访问不稳定，所以**同一份产物部署两份**，README 里给两个地址。
两者都是免费、自动 HTTPS、连 Git 仓库自动构建，**仓库不需要改任何代码**。

#### 份 1：GitHub Pages（海外优先）

见 1.1–1.3。部署地址形如 `https://<用户名>.github.io/relay-detector/`。

#### 份 2：Cloudflare Pages（国内可访问性通常更好）

1. 注册 <https://dash.cloudflare.com/> → **Workers & Pages → Create → Pages → Connect to Git**。
2. 授权 GitHub，选中同一个仓库。
3. 构建设置：
   - **Framework preset**：`None`
   - **Build command**：**留空**
   - **Build output directory**：`.`（仓库根目录就是产物）
4. 保存并部署。地址形如 `https://relay-detector.pages.dev`。
5. 可选：在 Pages → Custom domains 绑自己的域名。

#### 份 3（可选）：Vercel

同样「Import Git Repository → Framework: Other → Build Command 留空 → Output Directory `.`」。

#### 部署后必做

1. 把 `index.html` 里 `og:image` / `twitter:image` 的 `./assets/og-cover.png`
   改成**绝对 URL**（社交平台抓取卡片要求绝对地址）。
2. README 顶部给出两个线上地址。
3. 用手机分别打开两个地址各测一次（第 7 节的验收清单）。

> 注意：两份部署的**版本必须一致**。以 GitHub 仓库为唯一真源，
> Cloudflare / Vercel 都设为「Git 推送自动部署」，不要在平台侧手改文件。

---

## 2. 阶段 B：补上 CORS 这一环（关键）

### 2.1 为什么浏览器模式会失败

浏览器直连任意第三方 API 时，**目标站必须主动返回 CORS 头**（`Access-Control-Allow-Origin`），
否则浏览器会在响应到达 JS 之前就拦掉它。实测现状：

| 目标 | 浏览器直连 |
| --- | --- |
| `api.openai.com` | 允许（但 SDK 会警告不要在前端暴露 Key） |
| `api.anthropic.com` | 默认拒绝，需要额外请求头（`anthropic-dangerous-direct-browser-access`） |
| one-api / new-api 类中转站 | **多数允许**（它们常被自己的 Web 前端调用） |
| 自建反代 / 部分 Cloudflare Worker | 取决于配置，不少会拒绝 |

所以：**有相当比例的真实中转站，在纯静态页面上会直接「CORS 失败」**。
报告里会显示 `capabilities.corsBlocked = true`，并给出「改用本地代理 / 扩展」的建议 ——
这是诚实的行为，但对普通用户来说就是「用不了」。

### 2.2 四条补全路线

#### 路线 B-0（已实现，推荐）：桌面端

**这是目前推荐的「广大用户可用」方案，且已在本机实测通过。**
两种形态共用同一套代码与同一个本地代理：

| 形态 | 启动方式 | 用户门槛 |
| --- | --- | --- |
| 零依赖启动器 | 双击 `desktop/launch.cmd`（或 `npm run desktop`） | 只需 Node 21+ |
| Electron 应用 | `cd desktop` → `npm install` → `npm start` | 装一次依赖，可打包成 exe 分发 |

两者做的事一样：在本机起代理 → 打开页面并**预置为「本地代理」模式**。
因此不受 CORS 限制、能读完整响应头与 TLS 证书，API Key 只到 `127.0.0.1`。
详见 [`desktop/README.md`](../desktop/README.md)。

> **本机实测（2026-10-19，Electron 44.9.0）**：应用启动后内部代理监听随机端口，
> `/health` 返回 `2.0.0`；`/inspect?host=api.anthropic.com` 读到真实证书
> （Google Trust Services / WE1）；SSRF 目标返回 403；页面返回 200。
>
> 踩坑记录：若环境里存在 `ELECTRON_RUN_AS_NODE=1`，`electron.exe` 会退化成纯 Node，
> 表现为 `Cannot read properties of undefined (reading 'requestSingleInstanceLock')`。
> 启动前清掉该变量即可。

#### 路线 B-1：浏览器扩展

Manifest V3 里，只要在 `host_permissions` 声明目标域，扩展的 **service worker 发起的 fetch
不受 CORS 约束**。于是：

- 页面（或扩展自己的 UI）通过 `chrome.runtime.sendMessage` 让后台发请求；
- Key 仍然只在本机，不经过任何服务器；
- 能读到**完整响应头**（比网页模式更多证据）；
- 仍然**读不到 TLS 证书**（需要通道 C 或 D）。

落地要点：

1. `manifest.json`：`"host_permissions": ["http://*/*", "https://*/*"]`，
   `"permissions": ["storage"]`。
2. `background.js`：监听消息 → `fetch(targetUrl, init)` → 把 `status / headers / bodyText` 回传。
3. 前端把 `detect()` 的 `transport` 换成「`chrome.runtime.sendMessage` 包装层」即可，
   **引擎代码一行都不用改**（这正是当初把 transport 做成可注入的目的）。
4. 扩展审核注意：`<all_urls>` 权限会触发人工审核，README 里要写清用途；
   也可以改成「用户手动授权当前站点」的 optional permissions。

#### 路线 B-2：本地代理（已有）

```bash
node proxy/server.mjs
```

然后页面走「本地代理」模式。能力最全（能读 TLS），但要求用户装 Node.js ——
这已经筛掉了绝大部分普通用户。

#### 路线 B-3：云端无状态探测 API（谨慎）

在自己服务器上放一个「代发一次 HTTP 请求」的端点。**必须**满足第 3 节的红线，
否则你会拥有一个公开的 SSRF 跳板。

一条经验法则：**只让云端做「不需要 Key 的指纹轴」**。
真伪轴需要用户 Key，一旦经过你的服务器，你就成了「经手 API Key 的第三方」，
要承担信任、日志、泄露、法律与成本责任，收益却只是省掉一次安装。

---

## 3. 如果要做云端探测 API：不可妥协的红线

1. **SSRF 防护**：只允许 `http/https`；拒绝私网/环回/链路本地/CGNAT；
   **DNS 解析后再校验并固定 IP**（防 rebinding）；重定向**逐跳**重新校验。
   —— 现成的实现可以直接看 `proxy/server.mjs`，把它的校验函数抄到服务端。
2. **不落 Key**：请求头里的 `authorization` / `x-api-key` / `x-goog-api-key` 不写日志、不写盘、
   不进数据库；返回给前端前做递归脱敏。
3. **限流与配额**：按 IP + 按目标域限流；单请求超时、响应体上限、并发上限。
4. **不缓存他人 Key 的响应**：指纹轴可以按「域名 + 路径」短时缓存（不含 Key 的请求），
   真伪轴响应一律不缓存。
5. **可滥用性告知**：`robots.txt`、复用条款、明确「只检测你有权访问的端点」。
6. **不要把 `/proxy` 暴露成开放代理**：加签名/白名单，或者干脆只允许固定几个官方域名的指纹采集。

---

## 4. 公开发布清单（在宣布「可以用了」之前）

- [ ] `README.md` 有：截图/GIF、一句话定位、**局限性章节**、快速开始、免责声明、许可。
- [ ] `LICENSE`（已有 MIT）。
- [ ] `.github/ISSUE_TEMPLATE/`（已有 bug 模板）；建议补「误判反馈」模板，
      要求附 `--json` 报告（**提醒用户先删 Key**）。
- [ ] `SECURITY.md`：说明如何私下报告安全问题、以及「本工具会被用于扫描」的边界。
- [ ] **截图 / OG 图**：`assets/og-cover.png`（1200×630），供群聊/论坛分享时显示卡片。
- [ ] `robots.txt`：允许索引（这类工具靠搜索与分享传播）。
- [ ] `CHANGELOG.md`：至少记录 v1 → v2 → v2.1 的语义变更（`skip`/`critical`/`invalid`）。
- [ ] 版本号与 `src/core/constants.js` 的 `VERSION` 保持一致（`/health` 会返回它）。
- [ ] 跑一次 `npm run verify`，确认上线门禁是绿的。

---

## 5. 合规与风险（重要，别跳过）

- **不要替用户保存 Key，也不要做成「填 Key 换积分」的服务。**
- **不要托管他人的检测报告**。报告里可以含目标域名与内部字段，公开托管会引来投诉与误伤。
  本项目目前是「本地报告 + 导出 JSON」，这是刻意的。
- **明确使用边界**：只检测你有权访问的端点。批量扫描他人站点可能违反目标站条款，
  在某些司法辖区也可能有法律风险。README 与页面都要写。
- **不要背书/抹黑具体商家**。本项目只输出特征与证据，不做商户评级，
  也**不**建立「红黑榜」——那需要可信的持续数据与申诉机制，否则就是诽谤风险。
- **Key 的传输**：浏览器模式下 Key 直接发往目标站（必须如此）；本地代理模式下只经过 `127.0.0.1`。
  云端方案会让 Key 经过你的服务器 —— 这条要在 UI 上明示，并让用户显式同意。
- **中国大陆访问**：静态站可能需要镜像；不要让用户为了用工具而必须翻墙。

---

## 6. 上线之后：维护什么

| 会过期的东西 | 多久会坏 | 处理方式 |
| --- | --- | --- |
| `src/core/auth/models.js` 的模型表（新模型、上下文窗口、thinking 支持） | 每次官方发新模型 | 提 PR 更新；`lookupModel` 对未知模型返回 `null` 并 `skip`，因此**不会误判**，只会少测一些 |
| `constants.js` 的 `CALIBRATION`（官方端点指纹） | 官方换 CDN/CA 时 | 有 `node tools/fingerprint-official.mjs` 可一键重采 |
| 中转软件指纹（one-api / new-api 版本行为） | 上游升级时 | 指纹库在 `src/core/signatures.js`，按 issue 补充 |
| 官方基线（`token_parity` 用） | 一直过期 | 目前**故意为空**，无基线就 `skip` 不扣分 |

建议加一个**定时 CI**（每天跑一次 `node tools/acceptance.mjs --live`），
一旦官方端点行为变化就开 issue —— 这比等用户报 bug 早得多。

---

## 7. 上线后的验收（用「陌生用户」视角走一遍）

1. 用**手机**打开线上地址：页面能滚动、表单能输入、按钮可点。
2. 用一个**没有 CORS 的中转站**地址实测：报告应显示 `corsBlocked` 并给出替代方案，
   **不能**白屏或卡住。
3. 用一个**不存在的域名**：应显示友好错误，而不是崩溃。
4. 选「真伪」档：不勾费用确认时按钮必须是灰的。
5. 打开 DevTools → Network：确认**没有**任何请求发往你的服务器（纯前端应零外联）。
6. 打开 DevTools → Application → Local Storage：确认没有 Key（除非手动勾选保存）。
7. 分享链接到群里：确认 OG 卡片标题/描述/图片正常。

---

## 8. 一句话总结

**先上线静态站（5 分钟），再用浏览器扩展解决 CORS（这才是「广大用户能用」的关键），
云端 API 放到最后且只用它做无 Key 的指纹轴。**
