#!/usr/bin/env node
/**
 * v3「降智诊断」端到端验收（Lead 所有）。
 *
 * 不依赖任何真实日志：先用 tools/gen-sample-logs.mjs 生成两套可控日志
 * （stable = 前后一致；degraded = 最后 30% 时段截断率飙升 / 输出变短 / thinking 消失 / 模型被替换），
 * 再验证「解析 → 指标 → 评分 → 报告」整条链路是否给出正确结论。
 *
 * 用法：node tools/acceptance-degrade.mjs
 * 退出码：0 全通过；1 有失败。
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

let failures = 0;
const results = [];
const ok = (name, pass, detail) => {
  results.push({ name, pass });
  if (!pass) failures += 1;
  console.log(`${pass ? 'PASS' : 'FAIL'}  ${name}${detail ? `  — ${detail}` : ''}`);
};

// ------------------------------------------------------------ 生成样本日志

const OUT = path.join(os.tmpdir(), `rd-logs-${process.pid}`);
try {
  execFileSync(process.execPath, [path.join(ROOT, 'tools/gen-sample-logs.mjs'), '--out', OUT], {
    cwd: ROOT,
    stdio: 'pipe'
  });
  console.log(`[准备] 合成日志已生成到 ${OUT}\n`);
} catch (err) {
  console.error('生成样本日志失败：', err?.stderr?.toString() || err?.message || err);
  process.exit(1);
}

const read = (name) => ({ name, text: fs.readFileSync(path.join(OUT, name), 'utf8') });

// ------------------------------------------------------------- 加载被测模块

let degrade;
try {
  // Windows 上动态 import 绝对路径必须转成 file:// URL，否则报 "Received protocol 'c:'"
  degrade = await import(pathToFileURL(path.join(ROOT, 'src/core/degrade/index.js')).href);
} catch (err) {
  console.error('无法加载 src/core/degrade/index.js（引擎可能尚未就绪）：', err?.message || err);
  process.exit(1);
}
const { parseLogFiles, analyzeDegradation } = degrade;
if (typeof parseLogFiles !== 'function' || typeof analyzeDegradation !== 'function') {
  console.error('src/core/degrade/index.js 未导出 parseLogFiles / analyzeDegradation');
  process.exit(1);
}

// ------------------------------------------------------------- 1) 格式识别

console.log('=== 1) 四种格式解析与自动识别（含伪装扩展名）');
const CASES = [
  { file: 'claude-code-stable.jsonl', expect: 'claude-code' },
  { file: 'codex-rollout-stable.jsonl', expect: 'codex-rollout' },
  { file: 'api-log-stable.jsonl', expect: 'api-log' },
  { file: 'usage-stable.csv', expect: 'usage-csv' },
  { file: 'chatgpt-export-stable.json', expect: 'chatgpt-export' }
];
const stableFiles = [];
let stableRecords = [];
for (const c of CASES) {
  const input = read(c.file);
  stableFiles.push(input);
  const parsed = await parseLogFiles({ files: [input], limits: { maxRecords: 200000 } });
  stableRecords = stableRecords.concat(parsed.records);
  const detected = parsed.files?.[0]?.format;
  console.log(`  ${c.file.padEnd(28)} 识别=${String(detected).padEnd(14)} 记录=${parsed.records.length}`);
  ok(`${c.file} 识别为 ${c.expect}`, detected === c.expect, String(detected));
  ok(`${c.file} 解析出记录`, parsed.records.length > 0, `${parsed.records.length} 条`);
}

// Codex rollout 专属：它没有 finish_reason，截断率必须判「数据不足」而不是 0
{
  const parsed = await parseLogFiles({ files: [read('codex-rollout-stable.jsonl')] });
  const codexReport = analyzeDegradation({ records: parsed.records });
  const trunc = codexReport.metrics.find((m) => m.id === 'truncation_rate');
  const thinkingMetric = codexReport.metrics.find((m) => /^thinking_/.test(m.id) && m.status === 'ok');
  console.log(
    `  codex 单独分析: verdict=${codexReport.verdict} usable=${codexReport.coverage?.usable ?? '?'} 可用指标=${codexReport.metrics.filter((m) => m.status === 'ok').length}`
  );
  ok('Codex 日志识别为 codex-rollout', parsed.files?.[0]?.format === 'codex-rollout', String(parsed.files?.[0]?.format));
  ok('Codex 无 finish_reason → 截断率 insufficient', trunc?.status === 'insufficient', String(trunc?.status));
  ok('Codex 的 reasoning token 被纳入思考类指标', Boolean(thinkingMetric), thinkingMetric?.id || '无');
}

// 伪装扩展名：把 Claude Code 内容命名为 .csv
{
  const disguised = { name: 'looks-like-csv.csv', text: read('claude-code-stable.jsonl').text };
  const parsed = await parseLogFiles({ files: [disguised] });
  const fmt = parsed.files?.[0]?.format;
  ok('伪装成 .csv 仍识别为 claude-code', fmt === 'claude-code', String(fmt));
}

// 脏数据：混入坏 JSON / 空行都不应抛异常
{
  const dirty = {
    name: 'dirty.jsonl',
    text: '\n\n{不合法\n' + read('api-log-stable.jsonl').text.split('\n').slice(0, 5).join('\n') + '\n\n'
  };
  let parsed = null;
  let threw = false;
  try {
    parsed = await parseLogFiles({ files: [dirty] });
  } catch {
    threw = true;
  }
  ok('脏数据不抛异常', !threw);
  ok('坏行被跳过但有效行保留', !threw && (parsed?.records?.length || 0) >= 5, `${parsed?.records?.length || 0} 条`);
}

// 单文件失败不影响其它文件
{
  const parsed = await parseLogFiles({
    files: [{ name: 'broken.bin', text: '\u0000\u0001 not a log' }, read('claude-code-stable.jsonl')]
  });
  ok('单文件失败不影响其它文件', (parsed.records?.length || 0) > 0, `${parsed.records?.length || 0} 条`);
}

// ------------------------------------------------------------- 2) 稳定场景

console.log('\n=== 2) 稳定日志 → 应判「未见系统性退化」');
const stableReport = analyzeDegradation({ records: stableRecords });
console.log(`  verdict=${stableReport.verdict} score=${stableReport.score} e=${stableReport.evidenceStrength}`);
console.log(`  可用指标: ${stableReport.metrics.filter((m) => m.status === 'ok').map((m) => m.id).join(', ')}`);
console.log(`  findings: ${stableReport.findings.map((f) => `${f.id}(${f.severity})`).join(', ') || '（无）'}`);
ok('稳定场景 verdict=stable', stableReport.verdict === 'stable', stableReport.verdict);
ok('稳定场景无 critical', (stableReport.criticalIssues?.length || 0) === 0, `${stableReport.criticalIssues?.length || 0} 条`);

// ------------------------------------------------------------ 3) 退化场景

console.log('\n=== 3) 退化日志 → 应判「多项指标一致退化」');
const degradedFiles = [
  read('claude-code-degraded.jsonl'),
  read('codex-rollout-degraded.jsonl'),
  read('api-log-degraded.jsonl'),
  read('usage-degraded.csv'),
  read('chatgpt-export-degraded.json')
];
const degradedParsed = await parseLogFiles({ files: degradedFiles });
const degradedReport = analyzeDegradation({ records: degradedParsed.records });
console.log(`  verdict=${degradedReport.verdict} score=${degradedReport.score} e=${degradedReport.evidenceStrength}`);
console.log(`  critical: ${(degradedReport.criticalIssues || []).map((f) => f.id).join(', ') || '（无）'}`);
for (const m of degradedReport.metrics) {
  if (m.status !== 'ok') continue;
  console.log(`    ${m.id.padEnd(20)} early=${String(m.early).padStart(9)} recent=${String(m.recent).padStart(9)} delta=${m.deltaPct == null ? 'n/a' : m.deltaPct.toFixed(2)} ${m.direction}`);
}
ok('退化场景 verdict=likely-degraded', degradedReport.verdict === 'likely-degraded', degradedReport.verdict);
ok('退化场景有 critical', (degradedReport.criticalIssues?.length || 0) > 0, `${degradedReport.criticalIssues?.length || 0} 条`);
ok(
  '截断率或模型替换被识别',
  degradedReport.findings.some((f) => /truncation|model|thinking/i.test(f.id)),
  degradedReport.findings.map((f) => f.id).join(',')
);
ok('分数明显高于稳定场景', degradedReport.score > stableReport.score + 20, `${degradedReport.score} vs ${stableReport.score}`);

// --------------------------------------------------------- 4) 样本不足场景

console.log('\n=== 4) 样本不足 → 必须是 insufficient，不能是「退化 0 分」');
const few = analyzeDegradation({ records: stableRecords.slice(0, 5) });
console.log(`  verdict=${few.verdict} score=${few.score} e=${few.evidenceStrength}`);
ok('样本不足 verdict=insufficient', few.verdict === 'insufficient', few.verdict);
ok('样本不足不得显示成 stable', few.verdict !== 'stable', few.verdict);

// 空输入 / 垃圾输入不抛异常
{
  let threw = false;
  let r = null;
  try {
    r = analyzeDegradation({ records: [] });
  } catch {
    threw = true;
  }
  ok('空输入不抛异常且 insufficient', !threw && r?.verdict === 'insufficient', `${r?.verdict}`);
  let threw2 = false;
  try {
    analyzeDegradation({ records: [null, 42, 'x', {}] });
  } catch {
    threw2 = true;
  }
  ok('垃圾输入不抛异常', !threw2);
}

// ------------------------------------------------------------- 5) 隐私红线

console.log('\n=== 5) 隐私：报告里不得出现日志原文 / 文件名');
{
  const MARKER = 'SECRET_PROMPT_MARKER_9f3a1c';
  const leakyFile = {
    name: 'leaky.jsonl',
    text: read('api-log-degraded.jsonl')
      .text.split('\n')
      .map((line) => line.replace(/"content":"[^"]*"/g, `"content":"${MARKER}"`))
      .join('\n')
  };
  const parsed = await parseLogFiles({ files: [leakyFile] });
  const report = analyzeDegradation({ records: parsed.records });
  const json = JSON.stringify(report);
  ok('报告不含日志原文标记', !json.includes(MARKER));
  ok('报告不含文件名', !json.includes('leaky.jsonl'));
  ok('报告不含 raw 字段', !json.includes('"raw"'));
}

// ---------------------------------------------------------------------- 汇总

const passed = results.filter((r) => r.pass).length;
console.log(`\n===== 降智诊断验收汇总：${passed}/${results.length} 通过，${failures} 失败 =====`);
try {
  fs.rmSync(OUT, { recursive: true, force: true });
} catch {
  /* ignore */
}
process.exitCode = failures === 0 ? 0 : 1;
