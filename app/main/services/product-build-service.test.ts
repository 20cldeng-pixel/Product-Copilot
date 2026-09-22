import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { ProductWorkflowService, ProductWorkflowStore } from "./product-workflow-service";
import { ProductBuildService } from "./product-build-service";
import { productBuildRuntime } from "./product-build-runtime";
import { ProductVerificationService } from "./product-verification-service";
import { executeForeground } from "./background-shell/tool";
import type { ProductBuildResult } from "../../shared/product-build";

const fixtures: Array<{ dir: string; projectId: string }> = [];
afterEach(() => {
  for (const { dir, projectId } of fixtures.splice(0)) {
    const run = productBuildRuntime.get(projectId);
    if (run) { run.controller.abort(); productBuildRuntime.release(projectId, run.runId); }
    rmSync(dir, { recursive: true, force: true });
  }
});
const complete: ProductBuildResult = { status: "completed", sessionId: "sdk-session", summary: "implemented", toolCalls: 2, toolErrors: 0 };
function fixture(p0Count = 1) {
  const dir = mkdtempSync(path.join(tmpdir(), "product-build-"));
  const root = path.join(dir, "project"); mkdirSync(root);
  const projectId = randomUUID(); fixtures.push({ dir, projectId });
  const resolve = (id: string) => id === projectId ? root : undefined;
  const store = new ProductWorkflowStore(path.join(dir, "state"));
  const workflow = new ProductWorkflowService(resolve, store);
  workflow.saveDraft(projectId, 0, randomUUID(), {
    brief: { idea: "报名", targetUser: "成员", scenario: "活动", constraints: [] }, research: [], researchStatus: "insufficient_accepted", questions: [],
    requirements: [
      ...Array.from({ length: p0Count }, (_, index) => ({
        id: `R${index + 1}`, title: `需求 ${index + 1}`, priority: "P0" as const,
        behavior: `实现行为 ${index + 1}`, acceptance: [`验收 ${index + 1}`],
      })),
      { id: "R-FUTURE", title: "未来付费", priority: "P2", behavior: "P2 不应进入本次开发", acceptance: [] },
    ],
  });
  workflow.confirmScope(projectId, 1, randomUUID());
  const prototype = path.join(root, "prototype/index.html"); writeFileSync(prototype, "prototype");
  workflow.submitPrototype(projectId, 2, randomUUID(), prototype);
  workflow.confirmDevelopment(projectId, 3, randomUUID());
  const builder = vi.fn(async (_root: string, _runId: string, _prompt: string, _signal: AbortSignal): Promise<ProductBuildResult> => complete);
  const busy = vi.fn(() => false);
  const service = new ProductBuildService(resolve, workflow, builder, busy, store);
  const revision = () => store.read(projectId).revision;
  const start = () => service.start(projectId, revision(), randomUUID());
  return { dir, root, projectId, resolve, store, workflow, builder, busy, service, revision, start, prototype };
}

describe("Product Builder lifecycle service", () => {
  it("freezes approved scope, captures the actual artifact and never writes acceptance pass", async () => {
    const f = fixture(); f.builder.mockImplementationOnce(async (root) => {
      writeFileSync(path.join(root, "app.ts"), "export const built = true"); return complete;
    });
    const started = f.start(); expect(started.snapshot.runs.at(-1)?.executionStatus).toBe("running");
    await f.service.waitForIdle(f.projectId);
    const run = f.service.get(f.projectId).runs.at(-1)!;
    expect(run).toMatchObject({ executionStatus: "completed", verificationStatus: "not_run", scopeDigest: started.snapshot.approvals.scope?.contentDigest });
    expect(run.build?.artifactAfter).not.toBe(run.build?.artifactBefore);
    expect(f.builder.mock.calls[0]?.[2]).not.toContain("未来付费");
    expect(f.service.get(f.projectId).evidence).toEqual([]);
    expect(productBuildRuntime.get(f.projectId)).toBeUndefined();
  });

  it("runs approved P0 requirements in bounded batches and records the exact execution scope", async () => {
    const f = fixture(5);
    for (const expected of [
      { index: 1, ids: ["R1", "R2"] },
      { index: 2, ids: ["R3", "R4"] },
      { index: 3, ids: ["R5"] },
    ]) {
      f.start(); await f.service.waitForIdle(f.projectId);
      const run = f.service.get(f.projectId).runs.at(-1)!;
      expect(run.build?.batch).toEqual({ kind: "requirements", index: expected.index, total: 3, requirementIds: expected.ids });
      const prompt = f.builder.mock.calls.at(-1)?.[2] ?? "";
      for (const id of expected.ids) expect(prompt).toContain(`\"id\":\"${id}\"`);
      const nextId = `R${expected.index * 2 + 1}`;
      if (expected.index < 3) expect(prompt).not.toContain(`\"id\":\"${nextId}\"`);
    }
    f.start(); await f.service.waitForIdle(f.projectId);
    expect(f.service.get(f.projectId).runs.at(-1)?.build?.batch).toEqual({
      kind: "integration", requirementIds: ["R1", "R2", "R3", "R4", "R5"],
    });
    expect(() => f.start()).toThrow("开发或修复批次已完成");
    expect(f.builder).toHaveBeenCalledTimes(4);
  });

  it("reopens only failed requirements, reintegrates, and then requires verification again", async () => {
    const f = fixture(3);
    for (let index = 0; index < 3; index += 1) { f.start(); await f.service.waitForIdle(f.projectId); }
    const verificationId = randomUUID();
    f.store.transact(f.projectId, randomUUID(), f.revision(), "failed_verification", null, (state) => {
      state.runs.push({
        id: verificationId, kind: "verification", scopeDigest: state.approvals.scope!.contentDigest,
        prototypeDigest: state.prototype!.contentDigest, executionStatus: "completed", verificationStatus: "fail",
        createdAt: new Date().toISOString(), criteria: [
          { id: "C1", requirementId: "R1", title: "需求 1", text: "验收 1" },
          { id: "C3", requirementId: "R3", title: "需求 3", text: "验收 3" },
        ],
      });
      state.evidence.push(
        { id: randomUUID(), runId: verificationId, criterionId: "C1", artifactDigest: "failed", outcome: "fail", observedAt: new Date().toISOString(), observation: "R1 failed" },
        { id: randomUUID(), runId: verificationId, criterionId: "C3", artifactDigest: "failed", outcome: "fail", observedAt: new Date().toISOString(), observation: "R3 failed" },
      );
    });

    f.start(); await f.service.waitForIdle(f.projectId);
    const repair = f.service.get(f.projectId).runs.at(-1)!;
    expect(repair.build?.batch).toEqual({ kind: "repair", index: 1, total: 1,
      requirementIds: ["R1", "R3"], sourceVerificationRunId: verificationId });
    expect(f.builder.mock.calls.at(-1)?.[2]).toContain("R1 failed");
    expect(f.builder.mock.calls.at(-1)?.[2]).not.toContain('"id":"R2"');

    f.start(); await f.service.waitForIdle(f.projectId);
    expect(f.service.get(f.projectId).runs.at(-1)?.build?.batch).toEqual({
      kind: "integration", requirementIds: ["R1", "R2", "R3"], sourceVerificationRunId: verificationId,
    });
    expect(() => f.start()).toThrow("开发或修复批次已完成");
  });

  it("retries integration when its previous run did not complete", async () => {
    const f = fixture(1);
    f.start(); await f.service.waitForIdle(f.projectId);
    f.builder.mockResolvedValueOnce({ ...complete, status: "failed", error: "integration failed" });
    f.start(); await f.service.waitForIdle(f.projectId);
    expect(f.service.get(f.projectId).runs.at(-1)?.build?.batch?.kind).toBe("integration");
    expect(f.service.get(f.projectId).runs.at(-1)?.executionStatus).toBe("failed");
    f.start(); await f.service.waitForIdle(f.projectId);
    expect(f.service.get(f.projectId).runs.at(-1)?.build?.batch?.kind).toBe("integration");
    expect(f.service.get(f.projectId).runs.at(-1)?.executionStatus).toBe("completed");
  });

  it("retries the same requirement batch after cancellation", async () => {
    const f = fixture(3);
    f.builder.mockResolvedValueOnce({ ...complete, status: "cancelled", summary: "stopped" });
    f.start(); await f.service.waitForIdle(f.projectId);
    expect(f.service.get(f.projectId).runs.at(-1)?.build?.batch?.requirementIds).toEqual(["R1", "R2"]);
    f.start(); await f.service.waitForIdle(f.projectId);
    expect(f.service.get(f.projectId).runs.at(-1)?.build?.batch?.requirementIds).toEqual(["R1", "R2"]);
  });

  it("deduplicates double clicks, rejects concurrent builds and blocks verification", async () => {
    const f = fixture(); let finish!: (r: ProductBuildResult) => void;
    f.builder.mockImplementationOnce(() => new Promise((resolve) => { finish = resolve; }));
    const command = randomUUID();
    f.service.start(f.projectId, 4, command);
    expect(f.service.start(f.projectId, 4, command).replayed).toBe(true);
    expect(() => f.start()).toThrow("仍有 Agent");
    expect(() => f.workflow.submitPrototype(f.projectId, f.revision(), randomUUID(), f.prototype)).toThrow("当前开发");
    const verifier = new ProductVerificationService(f.resolve, f.workflow, f.store);
    await expect(verifier.run(f.projectId, f.revision(), randomUUID())).rejects.toThrow("已有待执行任务");
    expect(() => verifier.approvePlan(f.projectId, f.revision(), randomUUID(), {})).toThrow("等待");
    expect(() => verifier.recordManual(f.projectId, f.revision(), randomUUID(), {
      runId: f.store.read(f.projectId).runs.at(-1)!.id, criterionId: "criterion", decision: "verified", reason: "observed",
    })).toThrow("等待");
    expect(f.builder).toHaveBeenCalledOnce(); finish(complete); await f.service.waitForIdle(f.projectId);
  });

  it("keeps cancellation pending until the builder actually exits", async () => {
    const f = fixture(); let finish!: (r: ProductBuildResult) => void;
    f.builder.mockImplementationOnce(() => new Promise((resolve) => { finish = resolve; }));
    const started = f.start(); const runId = started.snapshot.runs.at(-1)!.id;
    const result = f.service.stop(f.projectId, f.revision(), randomUUID(), runId);
    expect(result.snapshot.runs.at(-1)?.build?.stopRequested).toBe(true);
    expect(result.snapshot.runs.at(-1)?.executionStatus).toBe("running");
    expect(f.builder.mock.calls[0]?.[3].aborted).toBe(true);
    expect(() => f.start()).toThrow();
    finish(complete); await f.service.waitForIdle(f.projectId);
    expect(f.service.get(f.projectId).runs.at(-1)?.executionStatus).toBe("cancelled");
  });

  it("preserves files written before cancellation and records their final digest", async () => {
    const f = fixture();
    f.builder.mockImplementationOnce(async (root, _runId, _prompt, signal) => {
      writeFileSync(path.join(root, "written-before-stop.ts"), "export const kept = true\n");
      await new Promise<void>((resolve) => signal.addEventListener("abort", () => resolve(), { once: true }));
      return { ...complete, summary: "stopped after writing" };
    });
    const started = f.start(); const runId = started.snapshot.runs.at(-1)!.id;
    await vi.waitFor(() => expect(f.builder).toHaveBeenCalledOnce());
    const before = started.snapshot.runs.at(-1)?.build?.artifactBefore;
    f.service.stop(f.projectId, f.revision(), randomUUID(), runId);
    await f.service.waitForIdle(f.projectId);

    expect(readFileSync(path.join(f.root, "written-before-stop.ts"), "utf8")).toContain("kept = true");
    const run = f.service.get(f.projectId).runs.at(-1)!;
    expect(run.executionStatus).toBe("cancelled");
    expect(run.verificationStatus).toBe("not_run");
    expect(run.build?.artifactAfter).toBeTruthy();
    expect(run.build?.artifactAfter).not.toBe(before);
  });

  it.skipIf(process.platform === "win32")("propagates product stop into a real foreground shell process", async () => {
    const f = fixture();
    f.builder.mockImplementationOnce(async (root, _runId, _prompt, signal) => {
      await executeForeground(
        { command: "touch shell-write-kept; sleep 30; touch shell-write-after-stop", env: { ...process.env } },
        root,
        signal,
      );
      return { ...complete, summary: "real shell stopped" };
    });

    const started = f.start();
    const runId = started.snapshot.runs.at(-1)!.id;
    await vi.waitFor(() => expect(readFileSync(path.join(f.root, "shell-write-kept"), "utf8")).toBe(""), {
      timeout: 5_000,
      interval: 25,
    });
    f.service.stop(f.projectId, f.revision(), randomUUID(), runId);
    await f.service.waitForIdle(f.projectId);

    expect(f.service.get(f.projectId).runs.at(-1)).toMatchObject({
      executionStatus: "cancelled",
      verificationStatus: "not_run",
      build: { result: { status: "cancelled" } },
    });
    expect(readFileSync(path.join(f.root, "shell-write-kept"), "utf8")).toBe("");
    expect(() => readFileSync(path.join(f.root, "shell-write-after-stop"), "utf8")).toThrow();
  }, 15_000);

  it("rejects stale approval and occupied projects before any model request", () => {
    const f = fixture(); f.busy.mockReturnValue(true); expect(() => f.start()).toThrow("仍有 Agent");
    f.busy.mockReturnValue(false); writeFileSync(f.prototype, "changed"); expect(() => f.start()).toThrow("确认");
    expect(f.builder).not.toHaveBeenCalled();
  });

  it("records initialization errors, preserves artifacts and allows an explicit new run", async () => {
    const f = fixture(); f.builder.mockRejectedValueOnce(new Error("no model"));
    f.start(); await f.service.waitForIdle(f.projectId);
    expect(f.service.get(f.projectId).runs.at(-1)).toMatchObject({ executionStatus: "failed", verificationStatus: "not_run" });
    f.start(); await f.service.waitForIdle(f.projectId);
    expect(f.service.get(f.projectId).runs).toHaveLength(2);
  });

  it("recovers orphaned runs without automatically running them again", () => {
    const f = fixture();
    f.store.transact(f.projectId, randomUUID(), f.revision(), "fixture", null, (state) => {
      state.runs.push({ id: randomUUID(), kind: "build", scopeDigest: "scope", prototypeDigest: "prototype", executionStatus: "running", verificationStatus: "not_run", createdAt: new Date().toISOString(), build: { startedAt: new Date().toISOString() } });
    });
    const recovered = f.service.get(f.projectId);
    expect(recovered.runs[0].executionStatus).toBe("interrupted");
    expect(f.builder).not.toHaveBeenCalled();
    expect(f.service.get(f.projectId).revision).toBe(recovered.revision);
  });

  it("keeps orphaned artifacts and allows an explicit retry after recovery", async () => {
    const f = fixture();
    const orphanId = randomUUID();
    writeFileSync(path.join(f.root, "partial-from-interrupted-run.ts"), "export const partial = true\n");
    f.store.transact(f.projectId, randomUUID(), f.revision(), "fixture_interrupted_process", null, (state) => {
      state.runs.push({
        id: orphanId, kind: "build", scopeDigest: state.approvals.scope!.contentDigest,
        prototypeDigest: state.prototype!.contentDigest, executionStatus: "running",
        verificationStatus: "not_run", createdAt: new Date().toISOString(),
        build: { startedAt: new Date().toISOString(), artifactBefore: "before-crash" },
      });
    });

    const restarted = new ProductBuildService(f.resolve, f.workflow, f.builder, f.busy, f.store);
    const recovered = restarted.get(f.projectId);
    expect(recovered.runs.find((run) => run.id === orphanId)).toMatchObject({
      executionStatus: "interrupted", verificationStatus: "not_run",
    });
    expect(readFileSync(path.join(f.root, "partial-from-interrupted-run.ts"), "utf8")).toContain("partial = true");
    restarted.start(f.projectId, recovered.revision, randomUUID());
    await restarted.waitForIdle(f.projectId);
    expect(restarted.get(f.projectId).runs.map((run) => run.executionStatus)).toEqual(["interrupted", "completed"]);
  });

  it("does not recover a still running build when another service reads the project", async () => {
    const f = fixture(); let finish!: (r: ProductBuildResult) => void;
    f.builder.mockImplementationOnce(() => new Promise((resolve) => { finish = resolve; }));
    f.start();
    const other = new ProductBuildService(f.resolve, f.workflow, f.builder, f.busy, f.store);
    expect(other.get(f.projectId).runs.at(-1)?.executionStatus).toBe("running");
    finish(complete); await f.service.waitForIdle(f.projectId);
  });

  it("retains the lock and reports an error when the final result cannot be persisted", async () => {
    const f = fixture(); let finish!: (r: ProductBuildResult) => void;
    f.builder.mockImplementationOnce(() => new Promise((resolve) => { finish = resolve; }));
    f.start();
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const write = vi.spyOn(f.store, "transact").mockImplementation(() => { throw new Error("disk full"); });
    finish(complete); await f.service.waitForIdle(f.projectId);
    expect(productBuildRuntime.get(f.projectId)).toBeDefined();
    expect(() => f.service.get(f.projectId)).toThrow("保存失败");
    write.mockRestore(); consoleError.mockRestore();
  });
});
