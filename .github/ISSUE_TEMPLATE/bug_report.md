---
name: Bug 报告
about: 反馈检测结果异常、代理报错或页面问题
title: '[bug] '
labels: bug
assignees: ''
---

<!--
⚠️ 请不要粘贴真实 API Key、Cookie 或任何凭据。
   报告中只保留域名与状态码即可（例如：api.example.com + 403）。
   脱敏示例：Authorization: Bearer sk-abc…<redacted>
-->

## 问题类型

- [ ] 误判：官方直连被判成中转（**最高优先级**，请务必附完整证据）
- [ ] 误判：中转被判成官方
- [ ] 结论为「无法判定」，但你认为证据充分
- [ ] 页面渲染 / 交互问题
- [ ] 本地代理报错或行为异常
- [ ] 其它

## 环境

| 项 | 值 |
| --- | --- |
| 运行方式 | GitHub Pages / 本地 `node proxy/server.mjs` / 其它 |
| 检测模式 | 浏览器直连 / 本地代理 |
| 协议 | 自动 / OpenAI / Anthropic / Gemini |
| Node 版本（如用代理） | `node --version` |
| 浏览器与版本 | |

## 复现步骤

1.
2.
3.

## 目标信息（**请脱敏**）

- 基址：`https://` 后请只保留域名，例如 `https://api.example.com/v1`
- 是否提供 API Key：（是/否；**不要贴出 Key**）
- 是否开启「允许付费探测」：（是/否）

## 期望结果 vs 实际结果

- 期望：
- 实际：

## 证据（可折叠）

<details>
<summary>检测报告 JSON / 代理响应头 / 截图</summary>

```json

```

</details>

## 可选：本地代理自检输出

```text
$ curl "http://127.0.0.1:8787/health"
$ curl "http://127.0.0.1:8787/inspect?host=<你的域名>&port=443"
```
