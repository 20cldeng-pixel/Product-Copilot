import { randomUUID } from "node:crypto";
import type { ProductBuildBatch, ProductBuildResult } from "../../shared/product-build";
import type { ProductWorkflowSnapshot } from "../../shared/product-workflow";
import { ProductWorkflowService, ProductWorkflowStore } from "./product-workflow-service";
import { productArtifactDigest } from "./product-verification-runner";
import { productBuildRuntime } from "./product-build-runtime";

type Builder = (root: string, runId: string, prompt: string, signal: AbortSignal) => Promise<ProductBuildResult>;
const BUILD_BATCH_SIZE = 2;

function nextBuildBatch(state: ProductWorkflowSnapshot): ProductBuildBatch {
  const requirements = state.draft.requirements.filter((item) => item.priority === "P0");
  const chunks = Array.from({ length: Math.ceil(requirements.length / BUILD_BATCH_SIZE) }, (_, index) =>
    requirements.slice(index * BUILD_BATCH_SIZE, (index + 1) * BUILD_BATCH_SIZE).map((item) => item.id));
  const attempted = new Set(state.runs.filter((run) => run.kind === "build"
    && run.scopeDigest === state.approvals.scope?.contentDigest
    && run.prototypeDigest === state.prototype?.contentDigest
    && run.executionStatus === "completed"
    && run.build?.batch?.kind === "requirements")
    .flatMap((run) => run.build?.batch?.requirementIds ?? []));
  const index = chunks.findIndex((ids) => ids.some((id) => !attempted.has(id)));
  if (index >= 0) return { kind: "requirements", index: index + 1, total: chunks.length, requirementIds: chunks[index]! };
  return { kind: "integration", requirementIds: requirements.map((item) => item.id) };
}

export class ProductBuildService {
  private readonly pending = new Map<string, Promise<void>>();
  private readonly errors = new Map<string, string>();
  constructor(
    private readonly resolve: (id: string) => string | undefined,
    private readonly workflow: ProductWorkflowService,
    private readonly builder: Builder,
    private readonly isBusy: (root: string) => boolean,
    private readonly store = new ProductWorkflowStore(),
  ) {}

  get(projectId: string): ProductWorkflowSnapshot {
    let state = this.workflow.get(projectId);
    const lost = state.runs.filter((run) => run.kind === "build" && ["running", "queued"].includes(run.executionStatus)
      && productBuildRuntime.get(projectId)?.runId !== run.id);
    if (lost.length) state = this.store.transact(projectId, randomUUID(), state.revision, "recover_build", null, (current) => {
      for (const run of current.runs) if (lost.some((entry) => entry.id === run.id)) {
        run.executionStatus = "interrupted";
        run.verificationStatus = "not_run";
        if (run.build) run.build.finishedAt = new Date().toISOString();
      }
    }).snapshot;
    const error = this.errors.get(projectId);
    if (error) throw new Error(`开发结果保存失败，尚未解除占用：${error}`);
    return state;
  }

  start(projectId: string, revision: number, commandId: string) {
    this.workflow.get(projectId);
    const root = this.resolve(projectId);
    if (!root) throw new Error("项目不存在");
    const started = this.store.transact(projectId, commandId, revision, "start_product_build", null, (state) => {
      if (!this.workflow.isDevelopmentCurrent(projectId)) throw new Error("请先确认当前范围和原型");
      if (productBuildRuntime.get(projectId) || this.isBusy(root)) throw new Error("当前项目仍有 Agent 或开发任务，请等待结束");
      if (state.runs.some((run) => ["running", "queued"].includes(run.executionStatus))) throw new Error("项目已有待执行任务，请刷新核对状态");
      const runId = randomUUID();
      const batch = nextBuildBatch(state);
      state.runs.push({
        id: runId, kind: "build", scopeDigest: state.approvals.scope!.contentDigest, prototypeDigest: state.prototype!.contentDigest,
        executionStatus: "running", verificationStatus: "not_run", createdAt: new Date().toISOString(),
        build: { startedAt: new Date().toISOString(), artifactBefore: productArtifactDigest(root), batch },
      });
    });
    if (started.replayed) return started;
    const run = started.snapshot.runs.at(-1)!;
    const controller = productBuildRuntime.acquire(projectId, run.id);
    const prompt = this.prompt(started.snapshot, run.build?.batch ?? nextBuildBatch(started.snapshot));
    const execution = this.execute(projectId, root, run.id, prompt, controller.signal);
    this.pending.set(projectId, execution);
    void execution.finally(() => this.pending.delete(projectId));
    return started;
  }

  stop(projectId: string, revision: number, commandId: string, runId: string) {
    this.workflow.get(projectId);
    const result = this.store.transact(projectId, commandId, revision, "stop_product_build", { runId }, (state) => {
      const run = state.runs.find((item) => item.id === runId && item.kind === "build");
      if (!run?.build) throw new Error("开发任务不存在");
      if (run.executionStatus !== "running") return;
      if (productBuildRuntime.get(projectId)?.runId !== runId) throw new Error("执行已中断，请刷新状态");
      run.build.stopRequested = true;
    });
    // 重放停止请求也安全；只有当前 runId 的执行器能收到中止。
    const owner = productBuildRuntime.get(projectId);
    if (owner?.runId === runId) owner.controller.abort();
    return result;
  }

  private prompt(state: ProductWorkflowSnapshot, batch: ProductBuildBatch): string {
    const change = [...state.proposals].reverse().find((entry) => entry.status === "confirmed"
      && entry.confirmation?.revision === state.approvals.scope?.revision);
    const requirements = state.draft.requirements.filter((item) => item.priority === "P0"
      && batch.requirementIds.includes(item.id));
    const batchInstruction = batch.kind === "requirements"
      ? `本轮是需求开发批次 ${batch.index}/${batch.total}，只实现列出的需求 ID。允许补必要的共享脚手架，但不要提前实现其他 P0。`
      : "全部需求批次都已有一次正常结束的开发回合。本轮只做集成检查并修复仍缺失的 P0、接口不一致和回归，不扩展范围。";
    return [
      "按用户已经批准的范围和原型执行一次开发。先检查现有代码，只补齐 P0 缺口，保留已有功能与数据。",
      batchInstruction,
      "不自行增加 P1/P2，不改原型或需求成功标准。遇到范围歧义或不可行项停止并说明。",
      "本轮只有基础编码工具，没有委派或用户问答工具。只用前台有限命令，不启动常驻服务，不使用后台进程，不推送或部署。",
      "完成后说明实际改动、实际检查、未完成项；不能把自己声明完成当成业务验收通过。限 10 分钟、80 次工具调用。",
      JSON.stringify({ brief: state.draft.brief, buildBatch: batch, requirements,
        decisions: state.draft.questions.map((q) => ({ question: q.text, resolution: q.resolution })), prototype: state.prototype,
        change: change ? { target: change.target, preserve: change.preserve, impact: change.impact } : undefined }),
    ].join("\n\n");
  }

  private async execute(projectId: string, root: string, runId: string, prompt: string, signal: AbortSignal): Promise<void> {
    let result: ProductBuildResult;
    try { result = await this.builder(root, runId, prompt, signal); }
    catch (cause) { result = { status: signal.aborted ? "cancelled" : "failed", summary: "", error: String(cause), toolCalls: 0, toolErrors: 0 }; }
    if (signal.aborted && result.status === "completed") result = { ...result, status: "cancelled", error: "用户已停止开发" };
    let artifactAfter: string | undefined;
    try { artifactAfter = productArtifactDigest(root); }
    catch (cause) { result = { ...result, status: "failed", error: `${result.error ?? ""} 无法记录开发产物：${String(cause)}` }; }
    try {
      const state = this.store.read(projectId);
      this.store.transact(projectId, randomUUID(), state.revision, "finish_product_build", { runId }, (current) => {
        const run = current.runs.find((entry) => entry.id === runId);
        if (!run?.build || run.executionStatus !== "running") throw new Error("开发状态已变化，不能覆盖现有结果");
        run.executionStatus = result.status;
        run.verificationStatus = "not_run";
        run.build = { ...run.build, finishedAt: new Date().toISOString(), artifactAfter, result };
      });
      this.errors.delete(projectId);
      productBuildRuntime.release(projectId, runId);
    } catch (cause) {
      this.errors.set(projectId, String(cause));
      console.error("[product-build] 保存运行结果失败", cause);
    }
  }

  /** 供应用关闭和宿主测试等待资源收尾，不把中止请求当成已停止。 */
  async waitForIdle(projectId: string): Promise<void> { await this.pending.get(projectId); }
}
