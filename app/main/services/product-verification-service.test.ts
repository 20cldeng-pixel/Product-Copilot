import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { ProductWorkflowService, ProductWorkflowStore } from "./product-workflow-service";
import { ProductVerificationService } from "./product-verification-service";
import { parseVitestReport, productArtifactDigest, runProductVerification } from "./product-verification-runner";
import { productCriteria } from "../../shared/product-verification";
import type { VerificationReport } from "../../shared/product-verification";

const dirs: string[] = [];
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });
const key = JSON.stringify(["app.test.js", "register"]);
function report(root: string, artifactDigest: string): VerificationReport {
  return { artifactDigest, finishedArtifactDigest: productArtifactDigest(root), exitCode: 0, stdout: "raw output", stderr: "", nodeVersion: "24", vitestVersion: "4",
    cases: [{ key, file: "app.test.js", name: "register", status: "passed", messages: [] }], finishedAt: new Date().toISOString() };
}
function fixture(runner = vi.fn(async (root: string, artifact: string) => report(root, artifact))) {
  const base = mkdtempSync(path.join(tmpdir(), "product-verification-")); dirs.push(base);
  const root = path.join(base, "project"); mkdirSync(root);
  writeFileSync(path.join(root, "app.js"), "export const capacity = 2;");
  const projectId = randomUUID();
  const resolve = (id: string) => id === projectId ? root : undefined;
  const store = new ProductWorkflowStore(path.join(base, "state"));
  const workflow = new ProductWorkflowService(resolve, store);
  workflow.saveDraft(projectId, 0, randomUUID(), {
    brief: { idea: "报名", targetUser: "成员", scenario: "活动", constraints: [] }, research: [], researchStatus: "insufficient_accepted", questions: [],
    requirements: [{ id: "REQ-1", title: "报名", priority: "P0", behavior: "可报名", acceptance: ["增加一人", "刷新后保留"] }],
  });
  workflow.confirmScope(projectId, 1, randomUUID());
  const prototype = path.join(root, "prototype/index.html"); writeFileSync(prototype, "<h1>报名</h1>");
  workflow.submitPrototype(projectId, 2, randomUUID(), prototype);
  workflow.confirmDevelopment(projectId, 3, randomUUID());
  const service = new ProductVerificationService(resolve, workflow, store, runner);
  const revision = () => store.read(projectId).revision;
  const run = (commandId = randomUUID()) => service.run(projectId, revision(), commandId);
  const ids = productCriteria(workflow.get(projectId).draft).map((c) => c.id);
  const approve = () => service.approvePlan(projectId, revision(), randomUUID(), Object.fromEntries(ids.map((id) => [id, [key]])));
  return { root, projectId, store, workflow, service, runner, revision, run, ids, approve, resolve };
}

describe("product verification evidence", () => {
  it("does not equate successful execution with acceptance and requires a subsequent mapped run", async () => {
    const f = fixture();
    const first = await f.run();
    expect(first.snapshot.runs.at(-1)).toMatchObject({ executionStatus: "completed", verificationStatus: "inconclusive" });
    expect(first.snapshot.evidence).toHaveLength(2);
    f.approve();
    expect(f.service.get(f.projectId).runs.at(-1)?.verificationStatus).toBe("inconclusive");
    const result = await f.run();
    expect(result.snapshot.runs.at(-1)?.verificationStatus).toBe("pass");
    expect(result.snapshot.runs[0].report?.stdout).toBe("raw output");
  });

  it("keeps unmapped criteria inconclusive and rejects unknown or duplicate test keys", async () => {
    const f = fixture(); await f.run();
    expect(() => f.service.approvePlan(f.projectId, f.revision(), randomUUID(), { unknown: [key] })).toThrow("已变化");
    expect(() => f.service.approvePlan(f.projectId, f.revision(), randomUUID(), { [f.ids[0]]: [key, key] })).toThrow("已变化");
    f.service.approvePlan(f.projectId, f.revision(), randomUUID(), { [f.ids[0]]: [key] });
    expect((await f.run()).snapshot.runs.at(-1)?.verificationStatus).toBe("inconclusive");
  });

  it("invalidates a pass when the user changes the approved mapping", async () => {
    const f = fixture(); await f.run(); f.approve(); await f.run();
    const result = f.service.approvePlan(f.projectId, f.revision(), randomUUID(), {});
    expect(result.snapshot.runs.at(-1)?.verificationStatus).toBe("stale");
    expect((await f.run()).snapshot.runs.at(-1)?.verificationStatus).toBe("inconclusive");
  });

  it("refuses running against a changed prototype authorization", async () => {
    const f = fixture();
    writeFileSync(path.join(f.root, "prototype/index.html"), "new prototype");
    await expect(f.run()).rejects.toThrow("确认");
    expect(f.runner).not.toHaveBeenCalled();
  });

  it.each(["failed", "pending", "missing", "exit", "malformed"])("never greens %s checks", async (mode) => {
    const f = fixture(); await f.run(); f.approve();
    f.runner.mockImplementationOnce(async (root, artifact) => {
      const result = report(root, artifact);
      if (mode === "failed" || mode === "pending") result.cases[0].status = mode;
      if (mode === "missing") result.cases = [];
      if (mode === "exit") result.exitCode = 1;
      if (mode === "malformed") { result.problem = "bad JSON"; result.cases = []; }
      return result;
    });
    const result = await f.run();
    expect(result.snapshot.runs.at(-1)?.verificationStatus).toBe(mode === "failed" ? "fail" : "inconclusive");
  });

  it("invalidates uncommitted source edits and rejects manual decisions on stale artifacts", async () => {
    const f = fixture(); await f.run(); f.approve(); const done = await f.run();
    writeFileSync(path.join(f.root, "app.js"), "export const capacity = 3;");
    expect(f.service.get(f.projectId).runs.at(-1)?.verificationStatus).toBe("stale");
    expect(() => f.service.recordManual(f.projectId, f.revision(), randomUUID(), {
      runId: done.snapshot.runs.at(-1)!.id, criterionId: f.ids[0], decision: "verified", reason: "检查了",
    })).toThrow("已变化");
    expect((await f.run()).snapshot.runs.at(-1)?.verificationStatus).toBe("inconclusive");
  });

  it("records manual exceptions without overwriting an automatic failure", async () => {
    const f = fixture(); await f.run(); f.approve();
    f.runner.mockImplementationOnce(async (root, artifact) => { const r = report(root, artifact); r.cases[0].status = "failed"; return r; });
    const done = await f.run();
    const entry = { runId: done.snapshot.runs.at(-1)!.id, criterionId: f.ids[0], decision: "exception", reason: "测试定位有误，暂时接受" };
    const commandId = randomUUID();
    const result = f.service.recordManual(f.projectId, f.revision(), commandId, entry);
    expect(result.snapshot.manualVerifications).toHaveLength(1);
    expect(result.snapshot.runs.at(-1)?.verificationStatus).toBe("fail");
    expect(f.service.recordManual(f.projectId, 0, commandId, entry).replayed).toBe(true);
    expect(() => f.service.recordManual(f.projectId, f.revision(), randomUUID(), { ...entry, reason: " " })).toThrow();
    const retry = await f.run();
    expect(retry.snapshot.runs.at(-1)?.verificationStatus).toBe("inconclusive");
    expect(retry.snapshot.evidence.at(-1)?.observation).toContain("不稳定");
  });

  it("prevents duplicate execution, concurrent runs and changes to bindings during a run", async () => {
    const f = fixture();
    let finish!: (value: VerificationReport) => void;
    f.runner.mockImplementationOnce(() => new Promise((resolve) => { finish = resolve; }));
    const commandId = randomUUID();
    const pending = f.run(commandId);
    expect((await f.service.run(f.projectId, 4, commandId)).replayed).toBe(true);
    await expect(f.run()).rejects.toThrow("已有待执行任务");
    expect(() => f.approve()).toThrow("等待");
    finish(report(f.root, productArtifactDigest(f.root))); await pending;
    expect(f.runner).toHaveBeenCalledTimes(1);
  });

  it("marks edits during execution stale and preserves interrupted runs after reopening", async () => {
    const f = fixture();
    f.runner.mockImplementationOnce(async (root, artifact) => {
      const reopened = new ProductVerificationService(f.resolve, f.workflow, f.store);
      expect(reopened.get(f.projectId).runs.at(-1)?.executionStatus).toBe("interrupted");
      writeFileSync(path.join(root, "app.js"), "changed"); return report(root, artifact);
    });
    expect((await f.run()).snapshot.runs.at(-1)?.verificationStatus).toBe("stale");
  });
});

describe("Vitest runner boundary", () => {
  it("rejects empty, duplicate, external and malformed reports", () => {
    const suite = { name: "/project/app.test.js", status: "passed", assertionResults: [{ fullName: "x", status: "passed", failureMessages: null }] };
    const payload = { success: true, numTotalTests: 1, testResults: [suite] };
    expect(parseVitestReport(JSON.stringify(payload), "/project").cases[0].status).toBe("passed");
    expect(parseVitestReport(JSON.stringify({ ...payload, numTotalTests: 0, testResults: [] }), "/project").problem).toBeTruthy();
    expect(() => parseVitestReport(JSON.stringify({ ...payload, testResults: [suite, suite] }), "/project")).toThrow("不唯一");
    expect(() => parseVitestReport(JSON.stringify({ ...payload, testResults: [{ ...suite, name: "/outside/test.js" }] }), "/project")).toThrow("项目外");
    expect(() => parseVitestReport("{broken", "/project")).toThrow();
  });

  it("detects test edits and additions but excludes generated dependencies and output", () => {
    const f = fixture(); const before = productArtifactDigest(f.root);
    mkdirSync(path.join(f.root, "dist")); writeFileSync(path.join(f.root, "dist/out.js"), "compiled");
    expect(productArtifactDigest(f.root)).toBe(before);
    writeFileSync(path.join(f.root, "new.test.js"), "test");
    expect(productArtifactDigest(f.root)).not.toBe(before);
    symlinkSync(path.join(f.root, "app.js"), path.join(f.root, "link.js"));
    expect(() => productArtifactDigest(f.root)).toThrow("符号链接");
  });

  it("runs a real installed Vitest CLI and captures passing, failing and skipped cases", async () => {
    const f = fixture();
    symlinkSync(path.resolve("node_modules"), path.join(f.root, "node_modules"), "dir");
    writeFileSync(path.join(f.root, "package.json"), JSON.stringify({ type: "module" }));
    writeFileSync(path.join(f.root, "app.test.js"), 'import { it, expect } from "vitest"; it("good", () => expect(1).toBe(1)); it("bad", () => expect(1).toBe(2)); it.skip("skipped", () => {});');
    const result = await runProductVerification(f.root, productArtifactDigest(f.root));
    expect(result.exitCode).toBe(1);
    expect(result.cases.map((test) => test.status).sort(), JSON.stringify(result)).toEqual(["failed", "passed", "pending"]);
    expect(result.rawReport).toContain("assertionResults");
    expect(result.finishedArtifactDigest).toBe(result.artifactDigest);
    expect(readFileSync(path.join(f.root, "app.js"), "utf8")).toContain("capacity");
  }, 20000);
});
