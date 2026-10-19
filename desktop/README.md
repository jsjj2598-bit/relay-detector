# 桌面端

同一个检测器，两种「桌面」形态。核心价值都一样：**请求由本机发出**，
因此不受浏览器 CORS 限制、能读完整响应头、能读 TLS 证书。

| 形态 | 需要什么 | 启动方式 | 适合 |
| --- | --- | --- | --- |
| **零依赖启动器** | 只需 Node.js 21+ | 双击 `launch.cmd`，或 `node desktop/launch.mjs` | 立刻可用、不想装 Electron |
| **Electron 应用** | Node + `npm install`（约 300 MB） | `cd desktop` → `npm install` → `npm start` | 想要原生窗口、可打包成安装包分发 |

两者都复用仓库里已有的 `proxy/server.mjs`，**没有第二套探测逻辑**。

---

## 一、零依赖启动器（推荐先用这个）

双击 `desktop/launch.cmd`，或：

```bash
node desktop/launch.mjs
```

它会：

1. 在 `127.0.0.1` 上起本地代理（默认自动挑空闲端口，也可 `--port 8899`）；
2. 打开系统默认浏览器，并**预置为「本地代理」模式**；
3. 打印页面地址、健康检查与 TLS 检查的 URL；
4. 按 `Ctrl+C` 退出。

```bash
node desktop/launch.mjs --no-open      # 只起服务，不打开浏览器
node desktop/launch.mjs --port 8899    # 指定端口
```

> 若浏览器被拦：直接手动访问终端里打印的 `http://127.0.0.1:<端口>/`。

---

## 二、Electron 应用（原生窗口）

```bash
cd desktop
npm install        # 只装 electron 这一个开发依赖，约 300 MB
npm start
```

`main.mjs` 做的事很少，刻意如此：

- 在**进程内**调用 `proxy/server.mjs` 的 `createServer()`（端口用 0 让系统分配，避免和用户已开的 8787 冲突）；
- 开一个 `BrowserWindow` 加载 `http://127.0.0.1:<端口>/?mode=proxy&proxyUrl=...`；
- `contextIsolation: true`、`nodeIntegration: false`、`sandbox: true` —— 页面拿不到任何 Node 能力；
- 外链一律交给系统浏览器打开，不在应用内导航；
- 单实例锁：重复启动只聚焦已有窗口；
- 关闭窗口即退出，并关闭本地代理。

### 打包成可分发的安装包

```bash
cd desktop
npx electron-packager . 中转站检测器 --platform=win32 --arch=x64 --out=dist --overwrite
```

产物在 `desktop/dist/中转站检测器-win32-x64/`，双击其中的 `.exe` 即可运行。
想要安装向导（`.exe` / `.msi`）或 macOS `.dmg`，改用 `electron-builder`：

```bash
npm i -D electron-builder
npx electron-builder --win --x64
```

> **注意：开发环境里我没有真正跑过打包**（本机无图形会话，且打包要下载额外工具链）。
> 上面两条命令是标准用法，代码层面不需要改动。首次打包若报错，多半是网络或签名工具问题。

---

## 三、为什么桌面端比网页准

| 能力 | 网页模式 | 桌面端 |
| --- | --- | --- |
| 跨域请求 | 受 CORS 限制，相当一部分中转站直接失败 | 不受限（本机进程发请求） |
| 完整响应头 | 被 CORS 过滤 | 完整可读（`openai-version`、`anthropic-ratelimit-*` 等） |
| TLS 证书 | 读不到 | 可读签发者 / SAN / 有效期 / 是否自签 |
| API Key 去向 | 只到目标站 | 只到 `127.0.0.1` 与目标站 |

因此桌面端能拿到 `tls.*` 与 `headers.*` 两类关键证据，
连接轴的判定会明显更稳。

---

## 四、安全说明

- 本地代理只绑定 `127.0.0.1`，默认拒绝私网/环回/链路本地/CGNAT 目标（防 SSRF），
  并对重定向逐跳校验。详见 [`../proxy/README.md`](../proxy/README.md)。
- API Key 不写盘、不进日志，报告里一律脱敏。
- **不要把本地代理改绑到 `0.0.0.0`**：那等于向局域网开放一个 SSRF 跳板。
