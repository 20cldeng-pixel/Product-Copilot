import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, mkdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { ProductChangeService } from "./product-change-service";
import { ProductWorkflowService, ProductWorkflowStore } from "./product-workflow-service";
import { ProductBuildService } from "./product-build-service";
import { ProductVerificationService } from "./product-verification-service";
import { productArtifactDigest } from "./product-verification-runner";
import { productDraftDiff } from "../../shared/product-change";
import type { ProductDraft } from "../../shared/product-workflow";
import { renderProductPrd } from "../../shared/product-prd";

const dirs: string[] = [];
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });
function fixture() {
  const dir = mkdtempSync(path.join(tmpdir(), "product-change-")); dirs.push(dir);
  const root = path.join(dir, "project"); mkdirSync(root);
  writeFileSync(path.join(root, "registration.ts"), "v1");
  const projectId = randomUUID();
  const resolve = (id: string) => id === projectId ? root : undefined;
  const store = new ProductWorkflowStore(path.join(dir, "state"));
  const workflow = new ProductWorkflowService(resolve, store);
  const draft: ProductDraft = {
    brief: { idea: "报名", targetUser: "成员", scenario: "活动", constraints: ["全局只能报一次"] },
    research: [], researchStatus: "insufficient_accepted", questions: [{ id: "Q1", text: "报名限制？", blocking: true, resolution: "全局一次" }],
    requirements: [{ id: "R1", title: "报名限制", priority: "P0", behavior: "全局只能报一次", acceptance: ["跨场拒绝"] }],
  };
  workflow.saveDraft(projectId, 0, randomUUID(), draft); workflow.confirmScope(projectId, 1, randomUUID());
  const prototype = path.join(root, "prototype/index.html"); writeFileSync(prototype, "V1");
  workflow.submitPrototype(projectId, 2, randomUUID(), prototype); workflow.confirmDevelopment(projectId, 3, randomUUID());
  const busy = vi.fn(() => false);
  const service = new ProductChangeService(resolve, workflow, busy, store);
  const nextDraft = structuredClone(draft);
  nextDraft.brief.constraints = ["每人每场一次"];
  nextDraft.questions[0].resolution = "每人每场一次，跨场可报名";
  nextDraft.requirements[0].behavior = "每人每场一次，跨场可报名";
  nextDraft.requirements[0].acceptance = ["同场拒绝", "跨场成功"];
  const input = { target: "改为每人每场一次", preserve: ["保留已有报名、容量、人数和刷新持久化"], nextDraft,
    impact: [{ area: "报名校验和旧数据", reason: "需要调整重复检查，需核对存储迁移", files: ["registration.ts"] }] };
  const revision = () => store.read(projectId).revision;
  const save = () => service.save(projectId, revision(), randomUUID(), input);
  const confirm = (id: string) => service.confirm(projectId, revision(), randomUUID(), id);
  return { dir, root, projectId, resolve, store, workflow, draft, nextDraft, input, service, busy, revision, save, confirm, prototype };
}

describe("version-bound requirement changes", () => {
  it("keeps proposals separate from approved requirements until user confirmation", () => {
    const f = fixture(); const saved = f.save();
    expect(saved.snapshot.draft).toEqual(f.draft);
    expect(f.workflow.isDevelopmentCurrent(f.projectId)).toBe(true);
    const proposal = saved.snapshot.proposals[0];
    expect(proposal).toMatchObject({ status: "ready", baseDraft: f.draft, nextDraft: f.nextDraft });
    expect(proposal.impact?.[0].files[0].digest).toHaveLength(64);
    expect(productDraftDiff(f.draft, f.nextDraft).map((entry) => entry.label)).toEqual(["产品约束", "需求 R1：报名限制", "问题与已采纳答案"]);
  });

  it("confirms a new scope, archives approval and invalidates old evidence without deleting facts", async () => {
    const f = fixture(); const runId = randomUUID(); const artifactDigest = productArtifactDigest(f.root);
    f.store.transact(f.projectId, randomUUID(), f.revision(), "seed_evidence", null, (state) => {
      state.runs.push({ id: runId, kind: "verification", scopeDigest: state.approvals.scope!.contentDigest, prototypeDigest: state.prototype!.contentDigest, executionStatus: "completed", verificationStatus: "pass", createdAt: new Date().toISOString() });
      state.evidence.push({ id: "evidence", runId, criterionId: "R1", artifactDigest, outcome: "pass", observedAt: new Date().toISOString() });
      state.manualVerifications = [{ id: randomUUID(), runId, criterionId: "R1", artifactDigest, decision: "verified", reason: "人工观察", observedAt: new Date().toISOString() }];
      state.verificationPlan = { scopeDigest: state.approvals.scope!.contentDigest, artifactDigest, bindings: {}, approvedAt: new Date().toISOString() };
    });
    const proposal = f.save().snapshot.proposals[0];
    const result = f.confirm(proposal.id).snapshot;
    expect(result.stage).toBe("scope_confirmed"); expect(result.draft).toEqual(f.nextDraft);
    expect(result.approvals.development).toBeUndefined(); expect(result.prototype).toBeUndefined(); expect(result.verificationPlan).toBeUndefined();
    expect(result.proposals[0].baseApprovals?.development).toBeDefined();
    expect(result.runs[0].verificationStatus).toBe("stale"); expect(result.evidence[0].outcome).toBe("pass"); expect(result.manualVerifications).toHaveLength(1);
    expect(f.workflow.isDevelopmentCurrent(f.projectId)).toBe(false);
    expect(renderProductPrd(result)).toContain("跨场成功"); expect(renderProductPrd(result)).not.toContain("全局只能报一次");
    const verifier = new ProductVerificationService(f.resolve, f.workflow, f.store);
    await expect(verifier.run(f.projectId, f.revision(), randomUUID())).rejects.toThrow("确认");
  });

  it("passes the confirmed preservation contract to Builder after new prototype approval", async () => {
    const f = fixture(); const p = f.save().snapshot.proposals[0]; f.confirm(p.id);
    writeFileSync(f.prototype, "V2 prototype"); f.workflow.submitPrototype(f.projectId, f.revision(), randomUUID(), f.prototype);
    f.workflow.confirmDevelopment(f.projectId, f.revision(), randomUUID());
    const builder = vi.fn(async () => ({ status: "completed" as const, summary: "done", toolCalls: 1, toolErrors: 0 }));
    const captured: string[] = [];
    const build = new ProductBuildService(f.resolve, f.workflow, async (_root, _id, prompt) => { captured.push(prompt); return builder(); }, () => false, f.store);
    build.start(f.projectId, f.revision(), randomUUID()); await build.waitForIdle(f.projectId);
    expect(captured[0]).toContain("保留已有报名、容量、人数和刷新持久化");
    expect(captured[0]).toContain("跨场成功"); expect(f.store.read(f.projectId).runs.at(-1)?.verificationStatus).toBe("not_run");
  });

  it("rejects source changes until the impact has been reviewed and saved again", () => {
    const f = fixture(); const p = f.save().snapshot.proposals[0];
    writeFileSync(path.join(f.root, "registration.ts"), "edited after proposal");
    expect(() => f.confirm(p.id)).toThrow("代码或原型已变化");
    f.service.save(f.projectId, f.revision(), randomUUID(), { ...f.input, proposalId: p.id });
    expect(f.confirm(p.id).snapshot.proposals[0].status).toBe("confirmed");
  });

  it("rechecks explicitly referenced files even in snapshot-excluded directories", () => {
    const f = fixture(); mkdirSync(path.join(f.root, "temp")); const file = path.join(f.root, "temp/reference.ts"); writeFileSync(file, "before");
    f.input.impact[0].files = ["temp/reference.ts"];
    const p = f.save().snapshot.proposals[0]; writeFileSync(file, "after");
    expect(() => f.confirm(p.id)).toThrow("引用文件已变化");
  });

  it("allows saving while development runs but refuses confirmation or late reuse", () => {
    const f = fixture();
    f.store.transact(f.projectId, randomUUID(), f.revision(), "running", null, (state) => {
      state.runs.push({ id: randomUUID(), executionStatus: "running", verificationStatus: "not_run", scopeDigest: "scope", prototypeDigest: "proto", createdAt: new Date().toISOString() });
    });
    const p = f.save().snapshot.proposals[0]; expect(() => f.confirm(p.id)).toThrow("等待");
    f.store.transact(f.projectId, randomUUID(), f.revision(), "finish", null, (state) => { state.runs[0].executionStatus = "completed"; });
    f.busy.mockReturnValue(true); expect(() => f.confirm(p.id)).toThrow("等待");
    f.busy.mockReturnValue(false); f.confirm(p.id);
    expect(() => f.confirm(p.id)).toThrow("已处理");
  });

  it("requires complete target criteria and preserves the current scope on failure", () => {
    const f = fixture(); f.input.nextDraft.requirements[0].acceptance = [];
    const p = f.save().snapshot.proposals[0]; expect(p.status).toBe("draft");
    expect(p.readinessIssue).toContain("验收条件");
    expect(f.workflow.get(f.projectId).proposals[0].readinessIssue).toBe(p.readinessIssue);
    expect(() => f.confirm(p.id)).toThrow("验收条件"); expect(f.workflow.get(f.projectId).draft).toEqual(f.draft);
    f.input.nextDraft.requirements[0].acceptance = ["同一用户可以报名不同活动"];
    const updated = f.service.save(f.projectId, f.revision(), randomUUID(), { ...f.input, proposalId: p.id }).snapshot.proposals[0];
    expect(updated.status).toBe("ready");
    expect(f.workflow.get(f.projectId).proposals[0].readinessIssue).toBeUndefined();
  });

  it("deduplicates save/confirmation and supersedes competing proposals", () => {
    const f = fixture(); const command = randomUUID();
    const p = f.service.save(f.projectId, 4, command, f.input).snapshot.proposals[0];
    expect(f.service.save(f.projectId, 4, command, f.input).replayed).toBe(true);
    const second = f.save().snapshot.proposals.at(-1)!;
    const confirmCommand = randomUUID(); const revision = f.revision();
    const done = f.service.confirm(f.projectId, revision, confirmCommand, p.id);
    expect(f.service.confirm(f.projectId, revision, confirmCommand, p.id).replayed).toBe(true);
    expect(done.snapshot.proposals.find((entry) => entry.id === second.id)?.status).toBe("superseded");
    expect(() => f.confirm(second.id)).toThrow("已处理");
    expect(() => f.service.save(f.projectId, f.revision(), randomUUID(), { ...f.input, proposalId: p.id })).toThrow("已结束");
  });

  it("rejects without changing requirements or approvals", () => {
    const f = fixture(); const p = f.save().snapshot.proposals[0]; const previous = f.workflow.get(f.projectId);
    const rejected = f.service.reject(f.projectId, f.revision(), randomUUID(), p.id).snapshot;
    expect(rejected.draft).toEqual(previous.draft); expect(rejected.approvals).toEqual(previous.approvals);
    expect(rejected.proposals[0].status).toBe("rejected"); expect(() => f.confirm(p.id)).toThrow("已处理");
  });

  it("refuses missing and escaping file references, stale revisions and fake approval fields", () => {
    const f = fixture(); const outside = path.join(f.dir, "outside.ts"); writeFileSync(outside, "outside");
    f.input.impact[0].files = [outside]; expect(() => f.save()).toThrow("项目内");
    symlinkSync(outside, path.join(f.root, "linked.ts")); f.input.impact[0].files = ["linked.ts"]; expect(() => f.save()).toThrow("项目内");
    f.input.impact[0].files = ["missing.ts"]; expect(() => f.save()).toThrow();
    expect(() => f.service.save(f.projectId, f.revision(), randomUUID(), { ...f.input, status: "confirmed" })).toThrow();
    expect(() => f.service.save(f.projectId, 0, randomUUID(), f.input)).toThrow("状态版本");
  });
});
