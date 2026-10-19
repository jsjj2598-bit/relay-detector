/**
 * 解析器注册表（契约 v3 §10.2）。
 *
 * 每个解析器模块都导出 `parse(text, {startIndex, maxRecords})`：
 * 返回 `{ records, total, skipped, warnings }`。解析器内部**不抛异常**，
 * 这里再兜一层 try/catch，保证单个文件的失败绝不会影响其它文件。
 *
 * 新增真实日志格式时只需要：
 *  1. 新建 `parsers/<format>.js`；
 *  2. 在 `PARSERS` 里注册；
 *  3. 在 `detect.js` 里加一条 `sniff*` 打分函数。
 */
import * as claudeCode from './claude-code-jsonl.js';
import * as apiLog from './api-log-jsonl.js';
import * as usageCsv from './usage-csv.js';
import * as chatgptExport from './chatgpt-export.js';
import * as codexRollout from './codex-rollout.js';
import { detectFormat } from './detect.js';

export const PARSERS = {
  'claude-code': claudeCode,
  'api-log': apiLog,
  'usage-csv': usageCsv,
  'chatgpt-export': chatgptExport,
  'codex-rollout': codexRollout
};

const EMPTY_RESULT = () => ({ records: [], total: 0, skipped: 0, warnings: [] });

/**
 * 按指定格式解析一个文件的文本；任何异常都降级为 error 字段。
 *
 * @param {string} format
 * @param {string} text
 * @param {{startIndex?: number, maxRecords?: number}} [options]
 * @returns {{records: object[], total: number, skipped: number, warnings: string[], error?: string}}
 */
export function parseWithFormat(format, text, options = {}) {
  const parser = PARSERS[format];
  if (!parser || typeof parser.parse !== 'function') {
    return { ...EMPTY_RESULT(), error: `暂不支持的日志格式：${format || 'unknown'}` };
  }
  try {
    const result = parser.parse(text, options);
    if (!result || typeof result !== 'object') {
      return { ...EMPTY_RESULT(), error: '解析器返回了非法结果。' };
    }
    return {
      records: Array.isArray(result.records) ? result.records : [],
      total: Number.isFinite(result.total) ? result.total : 0,
      skipped: Number.isFinite(result.skipped) ? result.skipped : 0,
      warnings: Array.isArray(result.warnings) ? result.warnings.filter((w) => typeof w === 'string') : []
    };
  } catch (error) {
    return {
      ...EMPTY_RESULT(),
      error: `解析失败：${error && error.message ? String(error.message).slice(0, 200) : '未知错误'}`
    };
  }
}

export { detectFormat };
export default { PARSERS, parseWithFormat, detectFormat };
