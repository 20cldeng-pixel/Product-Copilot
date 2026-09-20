/** 在隔离副本上校准公开 Gather V2 探针；不是原版/改进版 Agent 对照。 */
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const evaluatorRoot = fileURLToPath(new URL('../../', import.meta.url));
const gatherRoot = path.resolve(process.argv[2] ?? '');
const output = process.argv[3] && path.resolve(process.argv[3]);
if (!process.argv[2] || !output) {
  throw new Error('用法：node evaluation/gather/calibrate-v2.mjs <Gather路径> <新报告路径>');
}
const sha = (bytes) => createHash('sha256').update(bytes).digest('hex');
const git = (cwd, ...args) => execFileSync('git', args, { cwd, encoding: 'utf8' }).trim();
assert.equal(git(gatherRoot, 'status', '--porcelain'), '', 'Gather 工作树应先冻结');
const currentHead = git(gatherRoot, 'rev-parse', 'HEAD');
const v1Head = '4b1aa611c1b5a9888987a617da526f693513b09c';
git(gatherRoot, 'cat-file', '-e', `${v1Head}^{commit}`);
const temp = await mkdtemp(path.join(evaluatorRoot, 'temp', 'tests', 'gather-calibration-'));
const cases = [
  { id: 'correct-v2', revision: currentHead, expected: 'pass' },
  { id: 'unchanged-v1', revision: v1Head, expected: 'fail', witness: ['VC-03', 'VC-07'] },
  {
    id: 'no-duplicate-check', revision: currentHead, expected: 'fail', witness: ['VC-02'],
    mutation: { file: 'app/domain/commands.ts', old: 'if (existingEventIds.includes(input.eventId)) {', next: 'if (false) {' },
  },
  {
    id: 'one-user-per-event', revision: currentHead, expected: 'fail', witness: ['VC-04'],
    mutation: { file: 'app/domain/commands.ts', old: 'if (existingEventIds.includes(input.eventId)) {', next: 'if (existingEventIds.includes(input.eventId) || getEventRegistrationCount(state, input.eventId) > 0) {' },
  },
  {
    id: 'discard-v1-data', revision: currentHead, expected: 'fail', witness: ['VC-07'],
    mutation: { file: 'app/repository/localStorageRepository.ts', old: 'const migratedState = migrateV1State(snapshot.state);', next: 'const migratedState = createInitialState();' },
  },
];
const results = [];
try {
  for (const specimen of cases) {
    const subject = path.join(temp, specimen.id);
    await mkdir(subject);
    const archive = execFileSync('git', ['archive', '--format=tar', specimen.revision], { cwd: gatherRoot });
    execFileSync('tar', ['-xf', '-', '-C', subject], { input: archive });
    let mutationDigest = null;
    if (specimen.mutation) {
      const target = path.join(subject, specimen.mutation.file);
      const before = await readFile(target, 'utf8');
      assert.equal(before.split(specimen.mutation.old).length, 2, `变异锚点必须唯一：${specimen.id}`);
      const after = before.replace(specimen.mutation.old, specimen.mutation.next);
      await writeFile(target, after);
      mutationDigest = sha(after);
    }
    git(subject, 'init', '-q');
    git(subject, 'add', '-A');
    git(subject, '-c', 'user.name=Evaluation', '-c', 'user.email=evaluation@example.invalid', 'commit', '-qm', `Calibrate ${specimen.id}`);
    const reportDir = path.join(temp, `${specimen.id}-report`);
    const run = spawnSync(process.execPath, [path.join(evaluatorRoot, 'evaluation/gather/probe-v2.mjs'), subject, reportDir], {
      cwd: evaluatorRoot, encoding: 'utf8', maxBuffer: 8 * 1024 * 1024,
    });
    if (run.error) throw run.error;
    const report = JSON.parse(await readFile(path.join(reportDir, 'report.json'), 'utf8'));
    const failed = report.checks.filter((entry) => entry.outcome === 'fail').map((entry) => entry.id);
    const inconclusive = report.checks.filter((entry) => entry.outcome === 'inconclusive').map((entry) => entry.id);
    const observed = inconclusive.length ? 'inconclusive' : failed.length ? 'fail' : 'pass';
    assert.equal(observed, specimen.expected, `${specimen.id}: 预期 ${specimen.expected}，得到 ${observed}`);
    assert.equal(run.status, observed === 'pass' ? 0 : 1, `${specimen.id}: 进程退出码不一致`);
    for (const id of specimen.witness ?? []) assert.ok(failed.includes(id), `${specimen.id}: 缺失预期失败见证 ${id}`);
    results.push({
      id: specimen.id, sourceRevision: specimen.revision, specimenHead: report.head,
      mutation: specimen.mutation ? { file: specimen.mutation.file, afterSha256: mutationDigest } : null,
      observed, failed, inconclusive, passed: report.checks.filter((entry) => entry.outcome === 'pass').map((entry) => entry.id),
    });
  }
  const finalReport = {
    generatedAt: new Date().toISOString(), classification: 'public-development-calibration',
    limitation: '探针适配 Gather 内部 API；不能作为原版/改进版公平对照或未见任务证据。',
    gatherRevision: currentHead, v1Revision: v1Head,
    probeSha256: sha(await readFile(path.join(evaluatorRoot, 'evaluation/gather/probe-v2.mjs'))),
    calibratorSha256: sha(await readFile(fileURLToPath(import.meta.url))),
    results,
  };
  await mkdir(path.dirname(output), { recursive: true });
  await writeFile(output, JSON.stringify(finalReport, null, 2) + '\n', { flag: 'wx' });
  console.log(JSON.stringify({ output, results: results.map(({ id, observed, failed }) => ({ id, observed, failed })) }, null, 2));
} finally {
  await rm(temp, { recursive: true, force: true });
}
