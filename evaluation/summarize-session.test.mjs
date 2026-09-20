import { test } from 'node:test';
import assert from 'node:assert/strict';
import { summarizeSession } from './summarize-session.mjs';
const row = (message, timestamp = '2026-09-21T00:00:00Z') => ({ type: 'message', timestamp, message });
test('missing usage remains unknown and does not become a zero-cost success', () => {
  const r = summarizeSession([row({ role: 'assistant', stopReason: 'stop', content: [{ type: 'text', text: 'done' }] })]);
  assert.equal(r.tokenFields.input.knownSubtotal, null);
  assert.equal(r.sdkEstimatedCost.knownSubtotal, null);
  assert.equal(r.declaredPass, null); assert.equal(r.actualPass, null);
});
test('preserves retry usage and partial coverage without double counting reasoning', () => {
  const r = summarizeSession([
    row({ role: 'assistant', stopReason: 'error', usage: { input: 10, output: 4, reasoning: 2, totalTokens: 14, cost: { total: 0.1 } } }),
    row({ role: 'assistant', stopReason: 'stop', usage: { input: 20, output: 5, totalTokens: 25 } }, '2026-09-21T00:00:05Z'),
    row({ role: 'toolResult', isError: true }), row({ role: 'toolResult' }),
  ]);
  assert.equal(r.tokenFields.totalTokens.knownSubtotal, 39);
  assert.equal(r.tokenFields.reasoning.missingMessages, 1);
  assert.equal(r.sdkEstimatedCost.missingMessages, 1);
  assert.equal(r.observedMessageSpanMs, 5000);
  assert.equal(r.toolErrors, 1); assert.equal(r.toolErrorStatusUnknown, 1);
});
test('empty or malformed numeric usage cannot create measured cost', () => {
  const r = summarizeSession([row({ role: 'assistant', usage: { input: -1, output: '2', cost: { total: -3 } } })]);
  assert.equal(r.tokenFields.input.knownSubtotal, null); assert.equal(r.sdkEstimatedCost.knownSubtotal, null);
  assert.equal(summarizeSession([]).observedMessageSpanMs, null);
});
