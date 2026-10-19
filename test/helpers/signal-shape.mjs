/**
 * Signal 形状校验器（契约 1.3 / §3）——供各测试文件共享。
 * 只读源码、不修改源码。
 */
import assert from 'node:assert/strict';

/** 契约 1.3：Signal.verdict 只有三种。 */
export const SIGNAL_VERDICTS = ['relay', 'official', 'neutral'];

/** 契约 1.3 的类别集合。 */
export const CATEGORIES = ['url', 'tls', 'headers', 'error', 'models', 'payload', 'behavior', 'signature'];

/** 契约 §3 的 id 命名空间前缀。 */
export const CATEGORY_PREFIX = {
  url: 'url.',
  tls: 'tls.',
  headers: 'headers.',
  error: 'error.',
  models: 'models.',
  payload: 'payload.',
  behavior: 'behavior.',
  signature: 'signature.'
};

export function assertSignalValid(s, label) {
  assert.ok(s && typeof s === 'object', `${label}: Signal 必须是对象`);
  assert.equal(typeof s.id, 'string', `${label}: id 必须是字符串`);
  assert.ok(s.id.length > 0, `${label}: id 不得为空`);
  assert.ok(CATEGORIES.includes(s.category), `${label}: 非法 category "${s.category}"`);
  assert.ok(
    s.id.startsWith(CATEGORY_PREFIX[s.category]),
    `${label}: id "${s.id}" 前缀与 category "${s.category}" 不匹配（契约 §3）`
  );
  assert.ok(
    SIGNAL_VERDICTS.includes(s.verdict),
    `${label}: 非法 Signal.verdict "${s.verdict}"（契约 1.3 只允许 relay/official/neutral）`
  );
  assert.equal(typeof s.weight, 'number', `${label}: weight 必须是数字`);
  assert.ok(s.weight >= 0 && s.weight <= 100, `${label}: weight 越界 ${s.weight}`);
  assert.equal(typeof s.confidence, 'number', `${label}: confidence 必须是数字`);
  assert.ok(s.confidence >= 0 && s.confidence <= 1, `${label}: confidence 越界 ${s.confidence}`);
  assert.equal(typeof s.title, 'string', `${label}: title 必须是字符串`);
  assert.equal(typeof s.detail, 'string', `${label}: detail 必须是字符串`);
  assert.ok('evidence' in s && s.evidence !== undefined && s.evidence !== null, `${label}: 必须有 evidence`);
  assert.doesNotThrow(() => JSON.stringify(s.evidence), `${label}: evidence 必须可序列化`);
}

/** 校验一组信号并返回它们。 */
export function assertSignalsValid(signals, label) {
  assert.ok(Array.isArray(signals), `${label}: 必须是数组`);
  for (const s of signals) assertSignalValid(s, `${label}/${s && s.id}`);
  return signals;
}
