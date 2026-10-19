#!/usr/bin/env node
/**
 * 合成日志生成器（Lead 所有）。
 *
 * 为什么需要它：
 *   1. 让你**不用真实日志**也能先把「降智诊断」整条链路跑通、验证 UI；
 *   2. 作为验收脚本的固定输入（可复现，不依赖任何外部文件）；
 *   3. 演示我们支持的四种日志格式长什么样，方便你对照自己的日志。
 *
 * 用法：
 *   node tools/gen-sample-logs.mjs                 # 生成到 ./samples/
 *   node tools/gen-sample-logs.mjs --out D:\tmp\logs
 *   node tools/gen-sample-logs.mjs --scenario degraded
 *
 * 生成内容（stable 与 degraded 各一套）：
 *   claude-code-<scenario>.jsonl   Claude Code 会话日志（~/.claude/projects 目录下的 jsonl）
 *   api-log-<scenario>.jsonl       OpenAI/Anthropic 形状的 API 请求响应日志
 *   usage-<scenario>.csv           中转站用量/账单导出
 *   chatgpt-export-<scenario>.json ChatGPT 官方 conversations.json 导出
 */

import fs from 'node:fs';
import path from 'node:path';

const argv = process.argv.slice(2);
const argOf = (flag, fallback) => {
  const i = argv.indexOf(flag);
  return i >= 0 && argv[i + 1] ? argv[i + 1] : fallback;
};

const OUT_DIR = path.resolve(argOf('--out', 'samples'));
const ONLY = argOf('--scenario', 'both'); // both | stable | degraded
const N_DAYS = 14;
const PER_DAY = 12;
const START = Date.parse('2026-09-20T00:00:00Z'); // 固定起点，保证可复现
const DAY_MS = 86400e3;

/** 确定性 PRNG（mulberry32），保证每次生成完全一致。 */
function rng(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const pick = (r, arr) => arr[Math.floor(r() * arr.length) % arr.length];

const PROMPTS = [
  '帮我写一个把 JSONL 按天分组的 Node 脚本，并给出单元测试。',
  '解释一下 TCP 三次握手，用一句话概括每个阶段的目的。',
  '这段代码为什么会内存泄漏？请指出具体行并给出修复。',
  '把下面的英文技术文档翻译成中文，保持术语准确。',
  '设计一个支持断点续传的文件上传接口，给出关键数据结构。',
  '分析这个 SQL 为什么慢，并给出索引建议。'
];

const ANSWERS = [
  '好的，先看数据结构：按 `timestamp` 的日期部分做分组键，用 `Map` 累积，最后输出对象。下面是完整实现与测试用例……',
  '三次握手：SYN 发起连接并同步初始序号；SYN-ACK 确认对端序号并回传自身序号；ACK 完成双向确认。',
  '问题在 `setInterval` 里持有 `this` 且没有清理引用，导致监听器无法被回收。在第 42 行附近，改为 `clearInterval` 并在卸载时清理即可。',
  '译文：……（此处为一段约 300 字的技术译文，术语按行业惯例保留英文原词）',
  '关键结构：`{uploadId, totalChunks, uploadedBitMap, chunkSize}`；接口分 `init / chunk / complete` 三个阶段，服务端按位图判断缺失块……',
  '慢在 `WHERE created_at > ?` 上做了函数运算导致索引失效；建议改为范围比较，并对 `(user_id, created_at)` 建联合索引。'
];

/** 每一条日志的公共元数据。 */
function baseRecord(dayIndex, i) {
  const ts = START + dayIndex * DAY_MS + (i * 37 + 11) * 60000;
  const prompt = pick(rng(dayIndex * 100 + i), PROMPTS);
  const answer = pick(rng(dayIndex * 100 + i + 7), ANSWERS);
  return { ts, prompt, answer };
}

/** 生成一条记录的指标取值：stable 前后一致，degraded 后 30% 开始恶化。 */
function shape(scenario, dayIndex, r) {
  const degraded = scenario === 'degraded' && dayIndex >= Math.floor(N_DAYS * 0.7);
  if (!degraded) {
    return {
      promptTokens: 300 + Math.floor(r() * 120),
      completionTokens: 700 + Math.floor(r() * 260),
      thinkingTokens: 400 + Math.floor(r() * 200),
      hasThinking: true,
      truncated: r() < 0.01,
      latencyMs: 2200 + Math.floor(r() * 900),
      model: 'claude-sonnet-4-5-20250929',
      requestModel: 'claude-sonnet-4-5',
      ok: true
    };
  }
  return {
    promptTokens: 300 + Math.floor(r() * 120),
    completionTokens: 260 + Math.floor(r() * 110), // 输出明显变短
    thinkingTokens: 0, // thinking 消失
    hasThinking: false,
    truncated: r() < 0.26, // 截断率飙升
    latencyMs: 5200 + Math.floor(r() * 2600),
    model: 'claude-3-5-haiku-20241022', // 被换成更便宜的型号
    requestModel: 'claude-sonnet-4-5',
    ok: true
  };
}

/* ------------------------------------------------------------ Claude Code JSONL */

function genClaudeCode(scenario) {
  const lines = [];
  let uuid = 0;
  for (let d = 0; d < N_DAYS; d += 1) {
    for (let i = 0; i < PER_DAY; i += 1) {
      const r = rng(d * 1000 + i);
      const { ts, prompt, answer } = baseRecord(d, i);
      const s = shape(scenario, d, r);
      const pad = String(++uuid).padStart(4, '0');
      lines.push(
        JSON.stringify({
          type: 'user',
          uuid: `user-${pad}`,
          parentUuid: null,
          sessionId: `sess-${d}-${i % 3}`,
          timestamp: new Date(ts).toISOString(),
          cwd: '/home/user/project',
          version: '1.0.32',
          message: { role: 'user', content: prompt }
        })
      );
      const content = [];
      if (s.hasThinking) {
        content.push({
          type: 'thinking',
          thinking: '需要先确认数据结构，再考虑边界条件与测试覆盖……',
          signature: 'EqQBCkgIBRABGAIiQ'.padEnd(160, 'x')
        });
      }
      content.push({ type: 'text', text: answer });
      lines.push(
        JSON.stringify({
          type: 'assistant',
          uuid: `asst-${pad}`,
          parentUuid: `user-${pad}`,
          sessionId: `sess-${d}-${i % 3}`,
          timestamp: new Date(ts + s.latencyMs).toISOString(),
          durationMs: s.latencyMs,
          costUSD: 0.012,
          message: {
            id: `msg_01${pad}`,
            type: 'message',
            role: 'assistant',
            model: s.model,
            content,
            stop_reason: s.truncated ? 'max_tokens' : 'end_turn',
            usage: {
              input_tokens: s.promptTokens,
              output_tokens: s.completionTokens,
              cache_creation_input_tokens: 0,
              cache_read_input_tokens: Math.floor(s.promptTokens * 0.4)
            }
          }
        })
      );
    }
  }
  return lines.join('\n') + '\n';
}

/* -------------------------------------------------------------------- API 日志 */

function genApiLog(scenario) {
  const lines = [];
  for (let d = 0; d < N_DAYS; d += 1) {
    for (let i = 0; i < PER_DAY; i += 1) {
      const r = rng(d * 2000 + i);
      const { ts, prompt, answer } = baseRecord(d, i);
      const s = shape(scenario, d, r);
      lines.push(
        JSON.stringify({
          timestamp: new Date(ts).toISOString(),
          provider: 'anthropic',
          request: {
            model: s.requestModel,
            messages: [{ role: 'user', content: prompt }],
            max_tokens: 1024
          },
          response: {
            id: `msg_${d}${i}`,
            model: s.model,
            content: [{ type: 'text', text: answer }],
            stop_reason: s.truncated ? 'max_tokens' : 'end_turn',
            usage: {
              input_tokens: s.promptTokens,
              output_tokens: s.completionTokens
            }
          },
          latency_ms: s.latencyMs,
          status: 200
        })
      );
    }
  }
  return lines.join('\n') + '\n';
}

/* ----------------------------------------------------------------- 用量 CSV */

function genUsageCsv(scenario) {
  const rows = ['timestamp,model,request_model,prompt_tokens,completion_tokens,cache_read_tokens,finish_reason,latency_ms,status'];
  for (let d = 0; d < N_DAYS; d += 1) {
    for (let i = 0; i < PER_DAY; i += 1) {
      const r = rng(d * 3000 + i);
      const { ts } = baseRecord(d, i);
      const s = shape(scenario, d, r);
      rows.push(
        [
          new Date(ts).toISOString(),
          s.model,
          s.requestModel,
          s.promptTokens,
          s.completionTokens,
          Math.floor(s.promptTokens * 0.4),
          s.truncated ? 'max_tokens' : 'end_turn',
          s.latencyMs,
          200
        ].join(',')
      );
    }
  }
  return '\uFEFF' + rows.join('\r\n') + '\r\n'; // 带 BOM + CRLF，顺便测解析鲁棒性
}

/* ------------------------------------------------------------- ChatGPT 导出 */

function genChatgptExport(scenario) {
  const conversations = [];
  for (let d = 0; d < Math.min(N_DAYS, 6); d += 1) {
    const mapping = {};
    let prevId = null;
    for (let i = 0; i < 4; i += 1) {
      const r = rng(d * 4000 + i);
      const { ts, prompt, answer } = baseRecord(d, i);
      const s = shape(scenario, d, r);
      const userNode = `n${d}-${i}-u`;
      const asstNode = `n${d}-${i}-a`;
      mapping[userNode] = {
        id: userNode,
        message: { author: { role: 'user' }, content: { content_type: 'text', parts: [prompt] }, create_time: ts / 1000 },
        parent: prevId,
        children: [asstNode]
      };
      mapping[asstNode] = {
        id: asstNode,
        message: {
          author: { role: 'assistant' },
          content: { content_type: 'text', parts: [answer] },
          create_time: (ts + s.latencyMs) / 1000,
          metadata: { model_slug: s.model }
        },
        parent: userNode,
        children: []
      };
      prevId = asstNode;
    }
    conversations.push({
      title: `会话 ${d + 1}`,
      create_time: (START + d * DAY_MS) / 1000,
      update_time: (START + d * DAY_MS + 3600e3) / 1000,
      mapping,
      current_node: prevId
    });
  }
  return JSON.stringify(conversations, null, 2);
}

/* ------------------------------------------------------- Codex rollout JSONL */

/**
 * Codex CLI rollout 格式（每行一个事件，`type` 区分）。
 * 结构与用户提供的真实样例一致：
 *   session_meta / turn_context / event_msg(token_count) / response_item(assistant)
 */
function genCodexRollout(scenario) {
  const lines = [];
  const sessionId = '01a134ff-0000-0000-0000-000000000000';
  const MODEL = 'gpt-6-astra';

  lines.push(
    JSON.stringify({
      timestamp: new Date(START).toISOString(),
      ordinal: 0,
      type: 'session_meta',
      payload: {
        session_id: sessionId,
        id: sessionId,
        model_provider: 'openai',
        base_instructions: { text: '<redacted>', provenance: { model: MODEL } }
      }
    })
  );

  let threadInput = 0;
  let threadOutput = 0;
  for (let d = 0; d < N_DAYS; d += 1) {
    for (let i = 0; i < PER_DAY; i += 1) {
      const r = rng(d * 5000 + i);
      const { ts, answer } = baseRecord(d, i);
      const s = shape(scenario, d, r);
      const degraded = scenario === 'degraded' && d >= Math.floor(N_DAYS * 0.7);

      // turn_context：记录本轮请求的模型
      lines.push(
        JSON.stringify({
          timestamp: new Date(ts).toISOString(),
          type: 'turn_context',
          payload: { timezone: 'Asia/Shanghai', model: MODEL, realtime_active: false }
        })
      );

      const inputTokens = s.promptTokens;
      const outputTokens = degraded ? Math.round(s.completionTokens * 0.38) : s.completionTokens;
      // Codex 的「思考 token」：degraded 场景里直接归零
      const reasoningTokens = degraded ? 0 : Math.round(outputTokens * 0.12);
      threadInput += inputTokens;
      threadOutput += outputTokens;

      lines.push(
        JSON.stringify({
          timestamp: new Date(ts + s.latencyMs).toISOString(),
          type: 'event_msg',
          payload: {
            type: 'token_count',
            thread_id: sessionId,
            info: {
              total_token_usage: {
                input_tokens: threadInput,
                cached_input_tokens: Math.floor(threadInput * 0.4),
                cache_write_input_tokens: 0,
                output_tokens: threadOutput,
                reasoning_output_tokens: reasoningTokens,
                total_tokens: threadInput + threadOutput
              },
              last_token_usage: {
                input_tokens: inputTokens,
                cached_input_tokens: Math.floor(inputTokens * 0.4),
                cache_write_input_tokens: 0,
                output_tokens: outputTokens,
                reasoning_output_tokens: reasoningTokens,
                total_tokens: inputTokens + outputTokens
              },
              model_context_window: 400000
            },
            thread_settings: { model: MODEL },
            duration_ms: s.latencyMs,
            time_to_first_token_ms: degraded ? 3200 : 420
          }
        })
      );

      // 失败信号：degraded 场景里每 10 轮出现一次 turn_aborted
      if (degraded && i % 10 === 3) {
        lines.push(
          JSON.stringify({
            timestamp: new Date(ts + 60000).toISOString(),
            type: 'event_msg',
            payload: { type: 'turn_aborted', thread_id: sessionId, reason: 'context_limit' }
          })
        );
      }

      // 助手文本
      lines.push(
        JSON.stringify({
          timestamp: new Date(ts + s.latencyMs + 50).toISOString(),
          type: 'response_item',
          payload: {
            type: 'message',
            role: 'assistant',
            content: [{ type: 'output_text', text: degraded ? answer.slice(0, 60) : answer }]
          }
        })
      );
      // 推理项（加密内容，仅有占位；用于判定「该时段有思考」）
      if (!degraded) {
        lines.push(
          JSON.stringify({
            timestamp: new Date(ts + 100).toISOString(),
            type: 'response_item',
            payload: { type: 'reasoning', summary: [], encrypted_content: '<encrypted>' }
          })
        );
      }
    }
  }
  return lines.join('\n') + '\n';
}

/* ----------------------------------------------------------------------- main */

const GENERATORS = {
  'claude-code': { file: 'claude-code', run: genClaudeCode },
  'codex-rollout': { file: 'codex-rollout', run: genCodexRollout },
  'api-log': { file: 'api-log', run: genApiLog },
  'usage-csv': { file: 'usage', run: genUsageCsv },
  'chatgpt-export': { file: 'chatgpt-export', run: genChatgptExport }
};

const scenarios = ONLY === 'both' ? ['stable', 'degraded'] : [ONLY];
if (!scenarios.every((s) => s === 'stable' || s === 'degraded')) {
  console.error('--scenario 只能是 stable / degraded / both');
  process.exitCode = 2;
} else {
  fs.mkdirSync(OUT_DIR, { recursive: true });
  for (const scenario of scenarios) {
    for (const [kind, gen] of Object.entries(GENERATORS)) {
      const ext = kind === 'usage-csv' ? 'csv' : kind === 'chatgpt-export' ? 'json' : 'jsonl';
      const out = path.join(OUT_DIR, `${gen.file}-${scenario}.${ext}`);
      fs.writeFileSync(out, gen.run(scenario), 'utf8');
      console.log(`  ${scenario.padEnd(9)} ${String(fs.statSync(out).size).padStart(9)} B  ${path.relative(process.cwd(), out)}`);
    }
  }
  console.log(`\n已生成到 ${OUT_DIR}`);
  console.log('stable  = 前后指标一致（应判「未见系统性退化」）');
  console.log('degraded= 最后 30% 时段截断率↑ / 输出变短 / thinking 消失 / 模型被替换（应判「多项指标一致退化」）');
  console.log('\n你可以直接把这些文件拖进页面的「降智诊断」区，或跑：node tools/acceptance-degrade.mjs');
}
