import { afterEach, describe, expect, it } from "vitest";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { ProductWorkflowService, ProductWorkflowStore } from "./product-workflow-service";
import type { ProductDraft } from "../../shared/product-workflow";

const dirs: string[] = [];
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });

function fixture() {
  const base = mkdtempSync(join(tmpdir(), "easymint-product-"));
  dirs.push(base);
  const projectId = randomUUID();
  const project = join(base, "project");
  mkdirSync(project);
  const storeDir = join(base, "private-state");
  const service = new ProductWorkflowService(
    (id) => id === projectId ? project : undefined,
    new ProductWorkflowStore(storeDir),
  );
  return { base, projectId, project, storeDir, service };
}

const validDraft: ProductDraft = {
  brief: { idea: "活动报名", targetUser: "社群成员", scenario: "查看并报名活动", constraints: ["本地模拟身份"] },
  research: [{ id: "source-1", subject: "同类工具", sourceUrl: "https://example.com/", fact: "公开展示报名按钮", inference: "可能需要清晰的报名状态" }],
  researchStatus: "complete",
  requirements: [{ id: "REQ-1", title: "报名", priority: "P0", behavior: "开放活动可报名", acceptance: ["成功后人数加一"] }],
  questions: [{ id: "Q-1", text: "每人可报名几次？", blocking: true, resolution: "首版全局限报一次" }],
};

describe("ProductWorkflowService", () => {
  it("requires criteria for every P0 requirement, not just one of them", () => {
    const { projectId, service } = fixture();
    const draft = structuredClone(validDraft);
    draft.requirements.push({ id: "REQ-2", title: "持久化", priority: "P0", behavior: "刷新保留", acceptance: [] });
    service.saveDraft(projectId, 0, randomUUID(), draft);
    expect(() => service.confirmScope(projectId, 1, randomUUID())).toThrow("每项首版必做需求");
  });
  it("activates the planning guard only after an explicit persisted command", () => {
    const { projectId, storeDir, service } = fixture();
    expect(service.get(projectId).revision).toBe(0);
    expect(() => readFileSync(join(storeDir, `${projectId}.json`))).toThrow();
    const commandId = randomUUID();
    expect(service.activate(projectId, 0, commandId).snapshot.revision).toBe(1);
    expect(service.activate(projectId, 0, commandId).replayed).toBe(true);
    expect(() => service.activate(projectId, 1, randomUUID())).toThrow("已启用");
  });

  it("binds scope, prototype and run to approved versions without turning queued work into a pass", () => {
    const { projectId, project, service } = fixture();
    expect(service.get(projectId).stage).toBe("draft");
    expect(service.saveDraft(projectId, 0, randomUUID(), validDraft).snapshot.revision).toBe(1);
    expect(service.confirmScope(projectId, 1, randomUUID()).snapshot.stage).toBe("scope_confirmed");
    expect(() => service.saveDraft(projectId, 2, randomUUID(), validDraft)).toThrow("变更提案");
    const prototype = join(project, "prototype", "index.html");
    writeFileSync(prototype, "<h1>报名</h1>");
    expect(service.submitPrototype(projectId, 2, randomUUID(), prototype).snapshot.stage).toBe("prototype_ready");
    expect(service.confirmDevelopment(projectId, 3, randomUUID()).snapshot.stage).toBe("development_authorized");
    const commandId = randomUUID();
    const started = service.startRun(projectId, 4, commandId);
    expect(started.snapshot.runs).toHaveLength(1);
    expect(started.snapshot.runs[0]).toMatchObject({ executionStatus: "queued", verificationStatus: "not_run" });
    const retry = service.startRun(projectId, 4, commandId);
    expect(retry.replayed).toBe(true);
    expect(retry.appliedRevision).toBe(5);
    expect(retry.snapshot.runs).toHaveLength(1);
    expect(() => service.startRun(projectId, 4, randomUUID())).toThrow("状态版本已变化");
    expect(() => service.startRun(projectId, 5, randomUUID())).toThrow("已有待执行任务");
  });

  it("rejects blocking questions, missing research, missing criteria and unauthorized execution", () => {
    const { projectId, service } = fixture();
    expect(() => service.startRun(projectId, 0, randomUUID())).toThrow("尚未获得");
    const draft = structuredClone(validDraft);
    draft.questions[0].resolution = "";
    service.saveDraft(projectId, 0, randomUUID(), draft);
    expect(() => service.confirmScope(projectId, 1, randomUUID())).toThrow("关键问题");
    draft.questions[0].resolution = "已明确";
    draft.researchStatus = "pending";
    service.saveDraft(projectId, 1, randomUUID(), draft);
    expect(() => service.confirmScope(projectId, 2, randomUUID())).toThrow("竞品调研");
    draft.researchStatus = "complete";
    draft.research = [];
    service.saveDraft(projectId, 2, randomUUID(), draft);
    expect(() => service.confirmScope(projectId, 3, randomUUID())).toThrow("缺少可追溯来源");
    draft.researchStatus = "insufficient_accepted";
    draft.requirements[0].acceptance = [];
    service.saveDraft(projectId, 3, randomUUID(), draft);
    expect(() => service.confirmScope(projectId, 4, randomUUID())).toThrow("验收条件");
  });

  it("invalidates changed prototypes and refuses paths outside the project", () => {
    const { base, projectId, project, service } = fixture();
    service.saveDraft(projectId, 0, randomUUID(), validDraft);
    service.confirmScope(projectId, 1, randomUUID());
    const external = join(base, "external.html");
    writeFileSync(external, "outside");
    expect(() => service.submitPrototype(projectId, 2, randomUUID(), external)).toThrow("prototype 目录");
    const misplaced = join(project, "prototype.html");
    writeFileSync(misplaced, "inside project but outside prototype");
    expect(() => service.submitPrototype(projectId, 2, randomUUID(), misplaced)).toThrow("prototype 目录");
    const prototype = join(project, "prototype", "index.html");
    writeFileSync(prototype, "first");
    const submitCommandId = randomUUID();
    service.submitPrototype(projectId, 2, submitCommandId, prototype);
    writeFileSync(prototype, "changed after submission");
    expect(service.submitPrototype(projectId, 2, submitCommandId, prototype).replayed).toBe(true);
    expect(() => service.confirmDevelopment(projectId, 3, randomUUID())).toThrow("已变化");
    expect(service.get(projectId).revision).toBe(3);
  });

  it("revokes development eligibility when the approved prototype changes", () => {
    const { projectId, project, service } = fixture();
    service.saveDraft(projectId, 0, randomUUID(), validDraft);
    service.confirmScope(projectId, 1, randomUUID());
    const prototype = join(project, "prototype", "index.html");
    writeFileSync(prototype, "v1");
    service.submitPrototype(projectId, 2, randomUUID(), prototype);
    service.confirmDevelopment(projectId, 3, randomUUID());
    expect(service.isDevelopmentCurrent(projectId)).toBe(true);
    writeFileSync(prototype, "v2 without approval");
    expect(service.isDevelopmentCurrent(projectId)).toBe(false);
    expect(() => service.startRun(projectId, 4, randomUUID())).toThrow("已失效");
    expect(service.submitPrototype(projectId, 4, randomUUID(), prototype).snapshot.stage).toBe("prototype_ready");
    expect(service.confirmDevelopment(projectId, 5, randomUUID()).snapshot.stage).toBe("development_authorized");
    expect(service.isDevelopmentCurrent(projectId)).toBe(true);
  });

  it("revokes development eligibility if persisted requirements change after approval", () => {
    const { projectId, project, storeDir, service } = fixture();
    service.saveDraft(projectId, 0, randomUUID(), validDraft);
    service.confirmScope(projectId, 1, randomUUID());
    const prototype = join(project, "prototype", "index.html");
    writeFileSync(prototype, "v1");
    service.submitPrototype(projectId, 2, randomUUID(), prototype);
    service.confirmDevelopment(projectId, 3, randomUUID());
    const stateFile = join(storeDir, `${projectId}.json`);
    const stored = JSON.parse(readFileSync(stateFile, "utf8")) as { snapshot: { draft: ProductDraft } };
    stored.snapshot.draft.requirements[0].behavior = "悄悄改变后的行为";
    writeFileSync(stateFile, JSON.stringify(stored));
    expect(service.isDevelopmentCurrent(projectId)).toBe(false);
    expect(() => service.startRun(projectId, 4, randomUUID())).toThrow("已失效");
  });

  it("does not replace malformed persisted approvals with an empty project", () => {
    const { projectId, storeDir, service } = fixture();
    service.saveDraft(projectId, 0, randomUUID(), validDraft);
    const file = join(storeDir, `${projectId}.json`);
    writeFileSync(file, "{broken");
    expect(() => service.get(projectId)).toThrow();
    expect(readFileSync(file, "utf8")).toBe("{broken");
  });

  it("requires a traceable URL or user material before research is marked complete", () => {
    const { projectId, service } = fixture();
    const draft = structuredClone(validDraft);
    draft.research[0].sourceUrl = undefined;
    service.saveDraft(projectId, 0, randomUUID(), draft);
    expect(() => service.confirmScope(projectId, 1, randomUUID())).toThrow("可追溯来源");
    draft.research[0].materialRef = "用户提供的竞品访谈记录";
    service.saveDraft(projectId, 1, randomUUID(), draft);
    expect(service.confirmScope(projectId, 2, randomUUID()).snapshot.stage).toBe("scope_confirmed");
  });

  it("saves incomplete editor drafts but requires complete, unambiguous records before confirmation", () => {
    const { projectId, service } = fixture();
    const draft = structuredClone(validDraft);
    draft.research.push({ id: "new-source", subject: "", materialRef: "待整理材料", fact: "", inference: "" });
    draft.requirements.push({ id: "new-requirement", title: "", behavior: "", priority: "P1", acceptance: [] });
    draft.questions.push({ id: "new-question", text: "", blocking: false });
    expect(service.saveDraft(projectId, 0, randomUUID(), draft).snapshot.revision).toBe(1);
    expect(() => service.confirmScope(projectId, 1, randomUUID())).toThrow("调研来源仍有未填完");
    draft.research.pop();
    draft.requirements.pop();
    draft.questions.pop();
    draft.requirements.push({ ...draft.requirements[0] });
    service.saveDraft(projectId, 1, randomUUID(), draft);
    expect(() => service.confirmScope(projectId, 2, randomUUID())).toThrow("ID 重复");
  });
});
