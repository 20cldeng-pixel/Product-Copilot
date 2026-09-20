import { randomUUID } from "node:crypto";
import { z } from "zod";
import { productCriteria } from "../../shared/product-verification";
import type { VerificationReport } from "../../shared/product-verification";
import type { ProductRun, ProductWorkflowSnapshot } from "../../shared/product-workflow";
import { ProductWorkflowService, ProductWorkflowStore } from "./product-workflow-service";
import { productArtifactDigest, runProductVerification } from "./product-verification-runner";

const bindingsSchema = z.record(z.string().min(1), z.array(z.string().min(1)).max(500));
const manualInputSchema = z.object({
  runId: z.uuid(), criterionId: z.string().min(1), decision: z.enum(["verified", "exception"]),
  reason: z.string().trim().min(1, "请填写实际观察或接受例外的理由").max(4000),
}).strict();

/** 仅由用户 IPC 启动；不暴露给模型的产品工具。 */
export class ProductVerificationService {
  private readonly active = new Set<string>();
  constructor(
    private readonly projectPathForId: (id: string) => string | undefined,
    private readonly workflow: ProductWorkflowService,
    private readonly store = new ProductWorkflowStore(),
    private readonly runner = runProductVerification,
  ) {}

  private root(projectId: string): string {
    this.workflow.get(projectId); // 复用项目归属和目录校验。
    const root = this.projectPathForId(projectId);
    if (!root) throw new Error("项目不存在");
    return root;
  }

  get(projectId: string): ProductWorkflowSnapshot {
    let state = this.workflow.get(projectId);
    if (!state.runs.some((run) => run.kind === "verification")) return { ...state, developmentCurrent: this.workflow.isDevelopmentCurrent(projectId) };
    if (state.runs.some((run) => run.kind === "verification" && run.executionStatus === "running" && !this.active.has(run.id))) {
      state = this.store.transact(projectId, randomUUID(), state.revision, "recover_verification", null, (current) => {
        for (const run of current.runs) {
          if (run.kind === "verification" && run.executionStatus === "running" && !this.active.has(run.id)) {
            run.executionStatus = "interrupted"; run.verificationStatus = "inconclusive";
          }
        }
      }).snapshot;
    }
    let current: string | undefined;
    try { current = productArtifactDigest(this.root(projectId)); } catch { current = undefined; }
    for (const run of state.runs) {
      if (run.kind !== "verification") continue;
      if (run.executionStatus === "running" && !this.active.has(run.id)) {
        run.executionStatus = "interrupted";
        run.verificationStatus = "inconclusive";
      } else if (run.report && (run.report.artifactDigest !== current
        || run.scopeDigest !== state.approvals.scope?.contentDigest
        || (run.plan && JSON.stringify(run.plan) !== JSON.stringify(state.verificationPlan))
        || !this.workflow.isDevelopmentCurrent(projectId))) {
        run.verificationStatus = "stale";
      }
    }
    return { ...state, developmentCurrent: this.workflow.isDevelopmentCurrent(projectId) };
  }

  approvePlan(projectId: string, revision: number, commandId: string, input: unknown) {
    const root = this.root(projectId);
    const bindings = bindingsSchema.parse(input);
    const result = this.store.transact(projectId, commandId, revision, "approve_verification_plan", bindings, (state) => {
      if (state.runs.some((run) => ["queued", "running"].includes(run.executionStatus))) throw new Error("请等待当前开发或验收结束");
      if (!this.workflow.isDevelopmentCurrent(projectId)) throw new Error("请先确认当前开发范围");
      const artifactDigest = productArtifactDigest(root);
      const recent = [...state.runs].reverse().find((run) => run.report?.artifactDigest === artifactDigest
        && run.report.finishedArtifactDigest === artifactDigest);
      if (!recent?.report) throw new Error("请先对当前代码运行测试，收集可关联的用例");
      const criteria = new Set(productCriteria(state.draft).map((criterion) => criterion.id));
      const tests = new Set(recent.report.cases.map((test) => test.key));
      for (const [criterionId, keys] of Object.entries(bindings)) {
        if (!criteria.has(criterionId) || new Set(keys).size !== keys.length || keys.some((key) => !tests.has(key))) {
          throw new Error("验收条件或测试用例已变化，请刷新后重新关联");
        }
      }
      state.verificationPlan = { scopeDigest: state.approvals.scope!.contentDigest, artifactDigest, bindings, approvedAt: new Date().toISOString() };
    });
    return { ...result, snapshot: this.get(projectId) };
  }

  async run(projectId: string, revision: number, commandId: string) {
    const root = this.root(projectId);
    const started = this.store.transact(projectId, commandId, revision, "run_verification", null, (state) => {
      if (!this.workflow.isDevelopmentCurrent(projectId)) throw new Error("请先确认当前开发范围与原型");
      if (state.draft.requirements.some((r) => r.priority === "P0" && r.acceptance.length === 0)) {
        throw new Error("首版必做需求缺少验收条件，请先补齐需求");
      }
      for (const old of state.runs) {
        if (old.kind === "verification" && old.executionStatus === "running" && !this.active.has(old.id)) {
          old.executionStatus = "interrupted"; old.verificationStatus = "inconclusive";
        }
      }
      if (state.runs.some((run) => run.executionStatus === "running" || run.executionStatus === "queued")) throw new Error("项目已有待执行任务");
      state.runs.push({
        id: randomUUID(), kind: "verification", scopeDigest: state.approvals.scope!.contentDigest,
        prototypeDigest: state.prototype!.contentDigest, criteria: productCriteria(state.draft), plan: state.verificationPlan,
        executionStatus: "running", verificationStatus: "not_run", createdAt: new Date().toISOString(),
      });
    });
    if (started.replayed) return { ...started, snapshot: this.get(projectId) };
    const run = started.snapshot.runs.at(-1)!;
    this.active.add(run.id);
    let report: VerificationReport;
    try {
      const before = productArtifactDigest(root);
      report = await this.runner(root, before);
    } catch (cause) {
      report = { artifactDigest: "unavailable", finishedArtifactDigest: "unavailable", exitCode: null,
        stdout: "", stderr: "", cases: [], problem: String(cause), finishedAt: new Date().toISOString(), nodeVersion: process.versions.node, vitestVersion: "unknown" };
    }
    try {
      const current = this.store.read(projectId);
      const result = this.store.transact(projectId, randomUUID(), current.revision, "finish_verification", { runId: run.id }, (state) => {
        const target = state.runs.find((entry) => entry.id === run.id)!;
        target.report = report;
        target.executionStatus = report.exitCode === 0 && !report.problem ? "completed" : "failed";
        for (const criterion of target.criteria ?? []) {
          const keys = target.plan?.bindings[criterion.id] ?? [];
          const matching = keys.map((key) => report.cases.find((test) => test.key === key));
          const planCurrent = target.plan?.artifactDigest === report.artifactDigest && target.plan.scopeDigest === target.scopeDigest;
          let outcome: "pass" | "fail" | "inconclusive" = !planCurrent || !keys.length || matching.some((test) => !test) ? "inconclusive"
            : matching.some((test) => test?.status === "failed") ? "fail"
              : report.problem || report.exitCode !== 0 || matching.some((test) => test?.status !== "passed") ? "inconclusive" : "pass";
          const inconsistent = outcome === "pass" && state.evidence.some((old) => old.criterionId === criterion.id
            && old.artifactDigest === report.artifactDigest && old.outcome === "fail"
            && state.runs.find((prior) => prior.id === old.runId)?.scopeDigest === target.scopeDigest
            && JSON.stringify(old.testKeys) === JSON.stringify(keys));
          if (inconsistent) outcome = "inconclusive";
          state.evidence.push({ id: randomUUID(), runId: target.id, criterionId: criterion.id,
            artifactDigest: report.artifactDigest, outcome, observedAt: report.finishedAt, method: "vitest", testKeys: keys,
            observation: inconsistent ? "同一版本曾出现失败，结果不稳定，需核对原因" : !planCurrent ? "尚未确认当前版本的测试关联" : !keys.length ? "未关联验证用例" : report.problem ?? "查看所关联用例的实际结果",
          });
        }
        const results = state.evidence.filter((e) => e.runId === target.id);
        target.verificationStatus = results.some((e) => e.outcome === "fail") ? "fail"
          : results.length > 0 && results.every((e) => e.outcome === "pass") ? "pass" : "inconclusive";
        if (report.artifactDigest !== report.finishedArtifactDigest || target.scopeDigest !== state.approvals.scope?.contentDigest
          || !this.workflow.isDevelopmentCurrent(projectId)) target.verificationStatus = "stale";
      });
      return { ...result, snapshot: this.get(projectId) };
    } finally { this.active.delete(run.id); }
  }

  recordManual(projectId: string, revision: number, commandId: string, input: unknown) {
    const root = this.root(projectId);
    const entry = manualInputSchema.parse(input);
    return this.store.transact(projectId, commandId, revision, "record_manual_verification", entry, (state) => {
      if (state.runs.some((run) => ["queued", "running"].includes(run.executionStatus))) throw new Error("请等待当前开发或验收结束");
      const run: ProductRun | undefined = state.runs.find((item) => item.id === entry.runId);
      if (!run?.report || !run.criteria?.some((c) => c.id === entry.criterionId)) throw new Error("请先运行本条验收");
      const artifactDigest = productArtifactDigest(root);
      if (artifactDigest !== run.report.artifactDigest || artifactDigest !== run.report.finishedArtifactDigest
        || run.scopeDigest !== state.approvals.scope?.contentDigest
        || (run.plan && JSON.stringify(run.plan) !== JSON.stringify(state.verificationPlan))
        || !this.workflow.isDevelopmentCurrent(projectId)) throw new Error("产物或范围已变化，请重新运行后核验");
      state.manualVerifications ??= [];
      state.manualVerifications.push({ ...entry, id: randomUUID(), artifactDigest, observedAt: new Date().toISOString() });
    });
  }
}
