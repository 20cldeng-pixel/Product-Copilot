import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { ProductWorkflowService, ProductWorkflowStore } from "./product-workflow-service";
import { ProductBuildService } from "./product-build-service";
import { productBuildRuntime } from "./product-build-runtime";
import { ProductVerificationService } from "./product-verification-service";
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
function fixture() {
  const dir = mkdtempSync(path.join(tmpdir(), "product-build-"));
  const root = path.join(dir, "project"); mkdirSync(root);
  const projectId = randomUUID(); fixtures.push({ dir, projectId });
  const resolve = (id: string) => id === projectId ? root : undefined;
  const store = new ProductWorkflowStore(path.join(dir, "state"));
  const workflow = new ProductWorkflowService(resolve, store);
  workflow.saveDraft(projectId, 0, randomUUID(), {
    brief: { idea: "报名", targetUser: "成员", scenario: "活动", constraints: [] }, research: [], researchStatus: "insufficient_accepted", questions: [],
    requirements: [
      { id: "R1", title: "报名", priority: "P0", behavior: "可以报名", acceptance: ["人数增加"] },
      { id: "R2", title: "未来付费", priority: "P2", behavior: "P2 不应进入本次开发", acceptance: [] },
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
