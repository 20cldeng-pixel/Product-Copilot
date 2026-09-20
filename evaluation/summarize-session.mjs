/** Summarize an already frozen EasyMint/Pi JSONL; never infer business success. */
import { readFile, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { pathToFileURL } from 'node:url';

export function summarizeSession(rows) {
  const messages = rows.filter((row) => row.type === 'message' && row.message).map((row) => ({ ...row.message, recordedAt: row.timestamp }));
  const assistants = messages.filter((message) => message.role === 'assistant');
  const tools = messages.filter((message) => message.role === 'toolResult');
  const fields = ['input', 'output', 'cacheRead', 'cacheWrite', 'reasoning', 'totalTokens'];
  const totals = Object.fromEntries(fields.map((field) => {
    const values = assistants.map((message) => message.usage?.[field]);
    const known = values.filter((value) => typeof value === 'number' && Number.isFinite(value) && value >= 0);
    return [field, { knownSubtotal: known.length ? known.reduce((sum, value) => sum + value, 0) : null, knownMessages: known.length, missingMessages: values.length - known.length }];
  }));
  const costs = assistants.map((message) => message.usage?.cost?.total).filter((value) => typeof value === 'number' && Number.isFinite(value) && value >= 0);
  const last = assistants.at(-1);
  const text = (message) => (message?.content ?? []).filter((part) => part.type === 'text').map((part) => part.text).join('\n');
  const times = messages.map((message) => Date.parse(message.recordedAt)).filter(Number.isFinite);
  return {
    assistantMessages: assistants.length, userMessages: messages.filter((message) => message.role === 'user').length,
    toolResults: tools.length, toolErrors: tools.filter((message) => message.isError === true).length,
    toolErrorStatusUnknown: tools.filter((message) => typeof message.isError !== 'boolean').length,
    tokenFields: totals,
    sdkEstimatedCost: { knownSubtotal: costs.length ? costs.reduce((sum, value) => sum + value, 0) : null, knownMessages: costs.length, missingMessages: assistants.length - costs.length },
    billedCost: null,
    observedMessageSpanMs: times.length > 1 ? Math.max(...times) - Math.min(...times) : null,
    lastStopReason: last?.stopReason ?? null, finalAssistantText: text(last),
    declaredPass: null, actualPass: null,
    limits: ['Includes only this JSONL; delegated sessions must be summarized separately.', 'Token fields overlap; do not add reasoning or cached tokens to totalTokens.', 'SDK cost is an estimate, not a bill.', 'Message span excludes time before first and after last recorded message; not human work time.', 'Final stop reason is not business acceptance.'],
  };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const [input, output] = process.argv.slice(2);
  if (!input || !output) throw new Error('Usage: node evaluation/summarize-session.mjs <frozen.jsonl> <new-summary.json>');
  const raw = await readFile(input);
  const rows = raw.toString('utf8').split('\n').filter((line) => line.trim()).map((line) => JSON.parse(line));
  const result = { sourceSha256: createHash('sha256').update(raw).digest('hex'), ...summarizeSession(rows) };
  await writeFile(output, JSON.stringify(result, null, 2) + '\n', { flag: 'wx' });
  console.log(output);
}
