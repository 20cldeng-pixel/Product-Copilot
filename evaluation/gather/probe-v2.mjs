/** 公开合同 VC-01～07 的实际产物探针；页面观察另行完成。 */
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { mkdtemp, mkdir, readFile, writeFile, rm } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { build } from 'esbuild';
const root = process.argv[2] && path.resolve(process.argv[2]);
const output = process.argv[3] && path.resolve(process.argv[3]);
if (!root || !output) throw new Error('用法：node evaluation/gather/probe-v2.mjs <Gather路径> <新的证据目录>');
const repo = fileURLToPath(new URL('../../', import.meta.url));
const sha = (b) => createHash('sha256').update(b).digest('hex');
const git = (...args) => execFileSync('git', args, { cwd: root, encoding: 'utf8' }).trim();
const files = [...new Set(git('ls-files', '--cached', '--others', '--exclude-standard', '-z').split('\0').filter(Boolean))].sort();
const manifest = [];
for (const file of files) manifest.push({ file, sha256: sha(await readFile(path.join(root, file))) });
const baseline = path.join(repo, 'evaluation/gather/v1-baseline-20260920');
const baselineReport = JSON.parse(await readFile(path.join(baseline, 'report.json'), 'utf8'));
const rawF1 = await readFile(path.join(baseline, 'f1-v1-storage.json'), 'utf8');
assert.equal(sha(rawF1), baselineReport.fixture.fileSha256, 'V1 样本不得被改写');
const oldF1 = JSON.parse(rawF1);
const oldF0 = structuredClone(oldF1); oldF0.state.registrationsByUserId = {};
await mkdir(path.join(repo, 'temp/tests'), { recursive: true });
const temp = await mkdtemp(path.join(repo, 'temp/tests/gather-v2-'));
const checks = [];
const check = (id, name, action) => {
  try { const observation = action(); checks.push({ id, name, outcome: 'pass', observation }); }
  catch (cause) { checks.push({ id, name, outcome: cause instanceof assert.AssertionError ? 'fail' : 'inconclusive', error: String(cause) }); }
};
try {
  await build({ stdin: { contents: `export * from ${JSON.stringify(path.join(root, 'app/domain/index.ts'))};\nexport * from ${JSON.stringify(path.join(root, 'app/repository/index.ts'))};`, resolveDir: root }, outfile: path.join(temp, 'subject.mjs'), bundle: true, platform: 'node', format: 'esm', logLevel: 'silent' });
  const app = await import(pathToFileURL(path.join(temp, 'subject.mjs')).href);
  for (const name of ['LocalStorageRepository', 'registerForEvent', 'getEventRoster', 'getEventRegistrationCount']) assert.equal(typeof app[name], 'function', `需核对实际 API 适配：${name}`);
  const storage = (raw) => ({ raw, getItem() { return this.raw; }, setItem(_key, value) { this.raw = value; } });
  const observe = (state) => ({
    counts: ['A1', 'A2', 'A3'].map((id) => app.getEventRegistrationCount(state, id)),
    rosters: ['A1', 'A2', 'A3'].map((id) => [...app.getEventRoster(state, id)].sort()),
  });
  const register = (state, userId, eventId) => app.registerForEvent(state, { userId, eventId });
  const db = storage(JSON.stringify(oldF0));
  const repository = new app.LocalStorageRepository(db);
  let state = repository.load();
  const success = (userId, eventId) => {
    const before = structuredClone(state); const result = register(state, userId, eventId);
    assert.equal(result.ok, true, `${userId}→${eventId} 应成功`); assert.deepEqual(state, before, '输入状态不能被原地修改');
    repository.save(result.state); state = result.state;
  };
  const reject = (subject, userId, eventId, code) => {
    const before = structuredClone(subject); const result = register(subject, userId, eventId);
    assert.equal(result.ok, false); assert.equal(result.error.code, code);
    assert.deepEqual(result.state, before); assert.deepEqual(subject, before);
  };
  check('VC-01', '首次报名仅增加 A1', () => {
    assert.deepEqual(observe(state).counts, [0, 0, 0]); success('U1', 'A1');
    assert.deepEqual(observe(state), { counts: [1, 0, 0], rosters: [['U1'], [], []] }); return observe(state);
  });
  check('VC-02', '同场重复拒绝且无副作用', () => { reject(state, 'U1', 'A1', 'ALREADY_REGISTERED'); return observe(state); });
  check('VC-03', '已报 A1 后仍可报 A2', () => {
    success('U1', 'A2'); assert.deepEqual(observe(state), { counts: [1, 1, 0], rosters: [['U1'], ['U1'], []] }); return observe(state);
  });
  check('VC-04', '多用户独立与容量控制', () => {
    success('U2', 'A1'); reject(state, 'U3', 'A1', 'EVENT_FULL');
    assert.deepEqual(observe(state), { counts: [2, 1, 0], rosters: [['U1', 'U2'], ['U1'], []] }); return observe(state);
  });
  check('VC-06', '同一存储重新加载保持两场关系', () => {
    const loaded = new app.LocalStorageRepository(db).load();
    assert.deepEqual(loaded, state); assert.deepEqual(observe(loaded), { counts: [2, 1, 0], rosters: [['U1', 'U2'], ['U1'], []] }); return observe(loaded);
  });
  check('VC-05-domain', '独立 F2 关闭拒绝', () => {
    const closed = new app.LocalStorageRepository(storage(JSON.stringify(oldF0))).load();
    reject(closed, 'U1', 'A3', 'EVENT_CLOSED'); assert.deepEqual(observe(closed).counts, [0, 0, 0]); return observe(closed);
  });
  check('VC-07', '真实 V1 旧快照升级后保留旧报名并允许跨场', () => {
    const db = storage(rawF1); const r = new app.LocalStorageRepository(db); const migrated = r.load();
    assert.deepEqual(migrated.eventsById, oldF1.state.eventsById); assert.deepEqual(migrated.eventOrder, oldF1.state.eventOrder);
    assert.deepEqual(observe(migrated), { counts: [1, 0, 0], rosters: [['U1'], [], []] });
    reject(migrated, 'U1', 'A1', 'ALREADY_REGISTERED');
    const added = register(migrated, 'U1', 'A2'); assert.equal(added.ok, true); r.save(added.state);
    const loaded = new app.LocalStorageRepository(db).load();
    assert.deepEqual(observe(loaded), { counts: [1, 1, 0], rosters: [['U1'], ['U1'], []] });
    return { before: observe(migrated), afterReload: observe(loaded), storedSchema: JSON.parse(db.raw).schemaVersion, baselineCommit: baselineReport.source.commit };
  });
  for (const file of manifest) assert.equal(sha(await readFile(path.join(root, file.file))), file.sha256, `执行中源码变化：${file.file}`);
  await mkdir(path.dirname(output), { recursive: true }); await mkdir(output);
  const report = { generatedAt: new Date().toISOString(), node: process.version, head: git('rev-parse', 'HEAD'), worktree: git('status', '--porcelain'),
    files: manifest, probeDigest: sha(await readFile(fileURLToPath(import.meta.url))), fixtureDigest: sha(rawF1), checks,
    remaining: ['VC-05 页面展示、VC-08 真实页面状态需单独核验', '本报告不是自动确认的产品计划 Evidence，也不是独立未见评测'] };
  await writeFile(path.join(output, 'report.json'), JSON.stringify(report, null, 2) + '\n');
  console.log(JSON.stringify({ output, checks }, null, 2));
  if (checks.some((entry) => entry.outcome !== 'pass')) process.exitCode = 1;
} finally { await rm(temp, { recursive: true, force: true }); }
