/** 对真实 V1 执行公开固定案例，冻结旧数据；不接触用户浏览器或产品批准。 */
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { mkdtemp, mkdir, readFile, writeFile, rm } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { build } from 'esbuild';

const root = path.resolve(process.argv[2] ?? '');
const output = process.argv[3] && path.resolve(process.argv[3]);
if (!process.argv[2] || !output) throw new Error('用法：node evaluation/gather/probe-v1.mjs <Gather路径> <新的证据目录>');
const repo = fileURLToPath(new URL('../../', import.meta.url));
const sha = (bytes) => createHash('sha256').update(bytes).digest('hex');
const git = (...args) => execFileSync('git', args, { cwd: root, encoding: 'utf8' }).trim();
assert.equal(git('status', '--porcelain'), '', '冻结 V1 时工作树必须干净');
const commit = git('rev-parse', 'HEAD');
const files = git('ls-files', '-z').split('\0').filter(Boolean).sort();
const sourceHash = createHash('sha256');
const manifest = [];
for (const file of files) {
  const bytes = await readFile(path.join(root, file));
  sourceHash.update(JSON.stringify([file, bytes.length])); sourceHash.update(bytes);
  manifest.push({ file, sha256: sha(bytes) });
}
const sourceDigest = sourceHash.digest('hex');
await mkdir(path.join(repo, 'temp/tests'), { recursive: true });
const temp = await mkdtemp(path.join(repo, 'temp/tests/gather-v1-'));
const checks = [];
let serializedF1;
try {
  await build({ stdin: { contents: `export * from ${JSON.stringify(path.join(root, 'app/domain/index.ts'))};\nexport * from ${JSON.stringify(path.join(root, 'app/repository/index.ts'))};`, resolveDir: root }, outfile: path.join(temp, 'v1.mjs'), bundle: true, platform: 'node', format: 'esm', logLevel: 'silent' });
  const app = await import(pathToFileURL(path.join(temp, 'v1.mjs')).href);
  assert.equal(app.CURRENT_SCHEMA_VERSION, 1, '本探针只冻结 V1');
  const store = () => {
    const data = new Map();
    return { getItem: (key) => data.get(key) ?? null, setItem: (key, value) => data.set(key, value) };
  };
  const empty = () => ({ ...app.createInitialState(), registrationsByUserId: {} });
  const counts = (state) => ['A1', 'A2', 'A3'].map((id) => app.getEventRegistrationCount(state, id));
  const register = (state, userId, eventId) => app.registerForEvent(state, { userId, eventId });
  const check = (id, name, action) => {
    action(); checks.push({ id, name, outcome: 'pass', method: 'actual-v1-domain-and-repository' });
  };
  let state = empty();
  check('BVT-01-data', '活动列表数据、开放状态和容量', () => {
    assert.deepEqual(app.selectEvents(state).map(({ id, capacity, open }) => ({ id, capacity, open })), [
      { id: 'A1', capacity: 2, open: true }, { id: 'A2', capacity: 2, open: true }, { id: 'A3', capacity: 2, open: false },
    ]);
  });
  check('BVT-02', '首次报名只增加 A1', () => {
    const result = register(state, 'U1', 'A1'); assert.equal(result.ok, true); state = result.state;
    assert.deepEqual(counts(state), [1, 0, 0]); assert.equal(app.selectRegistrationRecord(state, 'U1').eventId, 'A1');
  });
  const f1storage = store();
  new app.LocalStorageRepository(f1storage).save(state);
  serializedF1 = f1storage.getItem(app.DEFAULT_STORAGE_KEY);
  assert.equal(typeof serializedF1, 'string');
  check('BVT-03', '同场重复拒绝且无副作用', () => {
    const before = structuredClone(state); const result = register(state, 'U1', 'A1');
    assert.equal(result.ok, false); assert.equal(result.error.code, 'ALREADY_REGISTERED'); assert.deepEqual(result.state, before);
  });
  check('BVT-04', 'V1 跨场报名拒绝', () => {
    const before = structuredClone(state); const result = register(state, 'U1', 'A2');
    assert.equal(result.ok, false); assert.equal(result.error.code, 'ALREADY_REGISTERED'); assert.deepEqual(result.state, before);
  });
  check('BVT-05', '多用户独立且满额拒绝无副作用', () => {
    const success = register(state, 'U2', 'A1'); assert.equal(success.ok, true); state = success.state;
    assert.deepEqual(counts(state), [2, 0, 0]);
    const before = structuredClone(state); const full = register(state, 'U3', 'A1');
    assert.equal(full.ok, false); assert.equal(full.error.code, 'EVENT_FULL'); assert.deepEqual(full.state, before);
  });
  check('BVT-06-persistence', '重新建立 Repository 保留人数和用户关系', () => {
    const storage = store(); new app.LocalStorageRepository(storage).save(state);
    const loaded = new app.LocalStorageRepository(storage).load();
    assert.deepEqual(loaded, state); assert.deepEqual(counts(loaded), [2, 0, 0]);
    assert.equal(app.selectRegistrationRecord(loaded, 'U1').eventId, 'A1');
  });
  check('BVT-07', '关闭活动拒绝且无副作用', () => {
    const initial = empty(); const before = structuredClone(initial); const result = register(initial, 'U1', 'A3');
    assert.equal(result.ok, false); assert.equal(result.error.code, 'EVENT_CLOSED'); assert.deepEqual(result.state, before);
  });
  check('F1-roundtrip', 'V1 序列化的旧报名可重新读取', () => {
    const loaded = new app.LocalStorageRepository(f1storage).load();
    assert.deepEqual(counts(loaded), [1, 0, 0]); assert.equal(app.selectRegistrationRecord(loaded, 'U1').eventId, 'A1');
    assert.equal(f1storage.getItem(app.DEFAULT_STORAGE_KEY), serializedF1);
  });
  // 保持 V2 的跨场成功断言不变，用真实 V1 校准其能否发现旧规则。
  const loaded = new app.LocalStorageRepository(f1storage).load();
  const cross = register(loaded, 'U1', 'A2');
  let calibration;
  try {
    assert.equal(cross.ok, true, 'VC-03: U1 报名 A1 后仍可报名 A2');
    assert.deepEqual(counts(cross.state), [1, 1, 0]);
    calibration = { id: 'VC-03-on-V1', outcome: 'unexpected-pass' };
  } catch (error) {
    if (!(error instanceof assert.AssertionError)) throw error;
    calibration = { id: 'VC-03-on-V1', outcome: 'expected-fail', observed: cross.ok ? counts(cross.state) : cross.error, assertion: error.message };
  }
  assert.equal(calibration.outcome, 'expected-fail', '旧规则必须被 V2 跨场条件识别');
  assert.equal(git('status', '--porcelain'), '', '探针不得修改 V1 工作树');
  assert.equal(git('rev-parse', 'HEAD'), commit);
  for (const entry of manifest) assert.equal(sha(await readFile(path.join(root, entry.file))), entry.sha256, `探针期间源码变化：${entry.file}`);
  // mkdir 不使用 recursive，避免意外覆盖先前证据。
  await mkdir(path.dirname(output), { recursive: true });
  await mkdir(output);
  await writeFile(path.join(output, 'f1-v1-storage.json'), serializedF1 + '\n');
  const report = {
    generatedAt: new Date().toISOString(), node: process.version, source: { commit, sourceDigest, digestMethod: 'sorted git tracked file path + byte length + content sha256', files: manifest },
    probeDigest: sha(await readFile(fileURLToPath(import.meta.url))),
    fixture: { file: 'f1-v1-storage.json', serializedSha256: sha(serializedF1), fileSha256: sha(serializedF1 + '\n'), storageKey: app.DEFAULT_STORAGE_KEY,
      origin: 'F0 synthetic fixed events -> actual V1 register U1/A1 -> actual V1 Repository.save; no user localStorage access' },
    checks, calibration,
    remaining: ['BVT-01 页面展示未在本探针验证', 'BVT-06 浏览器刷新与身份显示未在本探针验证', 'VC-05 展示及 VC-08 页面行为尚未验证', '正确 V2、漏掉去重与清空旧数据的校准样本尚未验证', '本报告不是产品计划正式 Evidence，也不是独立未见评测'],
  };
  await writeFile(path.join(output, 'report.json'), JSON.stringify(report, null, 2) + '\n');
  console.log(JSON.stringify({ output, commit, checksPassed: checks.length, calibration, fixtureSha256: report.fixture.serializedSha256 }, null, 2));
} finally {
  await rm(temp, { recursive: true, force: true });
}
