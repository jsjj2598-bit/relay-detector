# 本地验证指南

按「从零依赖自证 → 真实端点 → 浏览器目视」的顺序，5 个层次，每层都能独立跑。
**层次 1–3 完全不需要 API Key、不需要联网**，任何人都能复现。

> 环境要求：Node.js **21+**（推荐 24）。本项目**没有任何运行时依赖**，不需要 `npm install`。
> 先确认：`node -v`。

---

## 第 0 层：一键验证（最省事）

```bash
cd relay-detector
npm run verify
```

一次跑完：单元/契约测试 → 真伪轴端到端验收 → 冒充场景冒烟。
全部通过时最后一行会显示 `[exit 0]` 与「验收汇总：x/x 通过」。

想看单项，继续往下。

---

## 第 1 层：单元 + 契约 + 离线回归（不需要联网）

```bash
npm test
```

预期末尾：

```text
ℹ tests 171
ℹ pass 171
ℹ fail 0
ℹ skipped 0
```

这层验证的是「逻辑正确性」：评分数学、连接轴的几个降级闸门、真伪轴的
`skip`/`critical`/`invalid` 三条语义、10 个检测器的判据、密钥脱敏、报告形状。
全部用伪造 transport，**不发任何真实请求**。

> ⚠️ 不要写成 `node --test test/`：Node 24 会把目录参数当模块 require，
> 报 `Cannot find module '.../test'` 且一个测试都不跑。用 `npm test`。

---

## 第 2 层：零依赖端到端自证（不需要 Key，最直观）

内置一个假的 HTTP 中转站，模拟四种真实场景：

```bash
node tools/check.mjs --demo genuine   # 诚实转发真 Claude（thinking 块带服务端签名）
node tools/check.mjs --demo kiro      # 冒充：拿不到 thinking 签名
node tools/check.mjs --demo leak      # GPT 请求被偷偷转给 Claude（usage 泄漏 claude_* 字段）
node tools/check.mjs --demo dead      # 模型渠道不存在
```

**预期结论对照表**（这就是「判定逻辑是否真的生效」的验收标准）：

| 场景 | 轴 2 结论 | 关键证据 |
| --- | --- | --- |
| `genuine` | **优秀 / excellent**，无严重问题 | `thinking_signature` pass 100 |
| `kiro` | **基本合格 / marginal**（**绝不能是 passed**） | `thinking_signature` fail 0 + `criticalIssues` 含 `missing_thinking_signature` |
| `leak` | **基本合格 / marginal** | 2 条 critical（跨厂商字段泄漏），结论被封顶 |
| `dead` | **检测无效 / invalid**（**绝不能是低分 failed**） | `runError.code = model_unavailable` |

> `kiro` 那条是最容易做错的：一个冒充者其它协议字段都可以做得完全正确，
> 只有签名拿不到。如果它被判「通过」，说明 critical 一票降级没生效。

想同时拿到完整 JSON 报告：

```bash
node tools/check.mjs --demo leak --json
```

---

## 第 3 层：真伪轴全链路验收（不需要 Key，用真实 socket）

```bash
node tools/acceptance-auth.mjs
```

预期：`v2 验收汇总：17/17 通过，0 失败`。

与第 2 层的区别：这里走**真实 TCP socket**（本地起一个 `http.Server`），
覆盖「发请求 → 收响应 → 解析 → 检测器 → 评分 → 报告」整条链路，而不是伪造 transport。

---

## 第 4 层：连接轴 + 真实端点（需要联网，不需要 Key）

```bash
node tools/acceptance.mjs            # 离线 fixture 扫描 + 本地假中转站
node tools/acceptance.mjs --live     # 额外验证真实 api.anthropic.com
```

预期：`验收汇总：13/13 通过，0 失败`。

其中最关键的一条是：**真实 `api.anthropic.com` 必须判 `official`，绝不能是 relay**。
它本身就在 Cloudflare 之后、证书由 Google Trust Services 签发 —— 任何把
「用了 Cloudflare」当成中转证据的实现，都会在这一条上翻车。

---

## 第 5 层：本地代理（能读 TLS 证书与完整响应头）

```bash
node proxy/server.mjs        # 保持前台运行，默认 127.0.0.1:8787
```

另开一个终端：

```bash
# 1) 健康检查
curl "http://127.0.0.1:8787/health"
# 期望：{"ok":true,"version":"2.0.0"}

# 2) 读取真实 TLS 证书（这是浏览器模式拿不到的）
curl "http://127.0.0.1:8787/inspect?host=api.anthropic.com&port=443"
# 期望：issuer.O = "Google Trust Services"，issuer.CN = "WE1"，
#       altNames 含 api.anthropic.com，protocol TLSv1.3，selfSigned=false

# 3) SSRF 防护必须真的生效
curl -o /dev/null -w "%{http_code}\n" "http://127.0.0.1:8787/proxy?url=http%3A%2F%2F169.254.169.254%2F"
# 期望：403（云元数据端点被拒）
curl -o /dev/null -w "%{http_code}\n" "http://127.0.0.1:8787/proxy?url=file%3A%2F%2F%2Fetc%2Fpasswd"
# 期望：400（非 http/https 协议被拒）
```

---

## 第 6 层：浏览器目视（页面本身）

浏览器打开 **<http://127.0.0.1:8787/>**（用代理自己托管，避免混合内容问题）。

逐项检查：

1. 页面无控制台报错；顶部有「检测深度」三选一。
2. 选「**指纹（免费）**」→ 填 `https://api.anthropic.com` → 检测 → 应显示**连接轴**结果，
   且「上游真伪」卡片显示「未检测」。
3. 选「**真伪（需要 API Key）**」→ 出现模型下拉与费用预估；
   **不勾选费用确认时「开始检测」必须是灰的**，勾选后才可用。
4. 选「完整」→ 两轴并列显示，且**没有任何地方把两根轴合成一个总分**。
5. 输入一个不存在的域名 → 应显示友好的错误态，**不白屏**。
6. 开发工具 → Application → Local Storage：确认**没有** `apiKey` 之类的键（除非你手动勾选保存）。

> 这一层只能人工看。自动化侧我用 DOM-shim 覆盖了 155 项断言（结构、文案、XSS、
> 降级、两轴组合解读），但**渲染观感**必须人眼确认。

---

## 第 7 层：验你自己的中转站（会产生真实费用）

```bash
# 只做连接方式（免费、不发对话请求）
node tools/check.mjs --base-url https://api.example.com/v1

# 完整检测（连接轴 + 真伪轴），会产生 token 费用
node tools/check.mjs \
  --base-url https://api.example.com/v1 \
  --api-key sk-your-key \
  --model claude-sonnet-4-5 \
  --depth full

# 走本地代理（能读 TLS）
node tools/check.mjs --base-url https://api.example.com/v1 \
  --api-key sk-your-key --model gpt-4o --depth full --proxy
```

费用预估：`quick` 4 个请求 / `standard` 7–8 个 / `full` 9–10 个。
**建议先用小额 Key 跑 `--depth fingerprint` 确认连通性，再跑 `authenticity`。**

加 `--json` 输出完整报告，便于存档或提交 issue。

---

## 常见问题

| 现象 | 原因与处理 |
| --- | --- |
| `Cannot find module '.../test'` | 用了 `node --test test/`。改用 `npm test` |
| `EADDRINUSE :8787` | 端口被占用。`node proxy/server.mjs --port 8788`，并同步页面里的代理地址 |
| 浏览器里请求全部失败，控制台报 CORS | 浏览器模式的固有限制。用本地代理模式，或直接打开 <http://127.0.0.1:8787/> |
| HTTPS 页面连不上 `http://127.0.0.1` | 混合内容拦截。改用代理托管的页面 |
| 真伪检测显示「检测无效」 | 不是站点差，而是 Key 无权限/余额不足/该模型无渠道。换 Key 或换模型 |
| `thinking_signature` 显示「跳过」 | 该模型不支持 thinking（如 haiku 系列），这是正常跳过，**不计入分母、不拉低分数** |
| 所有检测器都「跳过」 | 说明没有一个能测（模型不支持 + 网络失败等），结论为「检测无效」，不是 0 分 |

---

## 这些验证分别证明了什么

| 层次 | 证明的是 | 不能证明 |
| --- | --- | --- |
| 1 单元/契约 | 判定逻辑与契约一致 | 真实网络下是否成立 |
| 2–3 端到端自证 | 整条链路在真实 HTTP 上成立 | 真实服务商的行为 |
| 4 真实端点 | 官方端点不会被误判成中转 | 中转站一定能被识别出来 |
| 5 代理 | 证书读取与 SSRF 防护真的生效 | 页面渲染观感 |
| 6 浏览器 | 交互与视觉可用 | 判定准确性（靠 1–4） |
| 7 你的中转站 | 该站此刻的实际表现 | 长期稳定性（单次快照） |
