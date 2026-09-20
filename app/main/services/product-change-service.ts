import { createHash, randomUUID } from "node:crypto";
import { readFileSync, realpathSync, statSync } from "node:fs";
import path from "node:path";
import { z } from "zod";
import { productDraftDiff } from "../../shared/product-change";
import { assertProductScopeReady, draftSchema, ProductWorkflowService, ProductWorkflowStore } from "./product-workflow-service";
import { productArtifactDigest } from "./product-verification-runner";

const text = z.string().trim().min(1).max(12000);
export const productChangeInputSchema = z.object({
  proposalId: z.uuid().optional(), target: text, preserve: z.array(text).min(1).max(100), nextDraft: draftSchema,
  impact: z.array(z.object({ area: text, reason: text, files: z.array(text).max(30) }).strict()).min(1).max(50),
}).strict();
const digest = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex");

export class ProductChangeService {
  constructor(
    private readonly resolve: (id: string) => string | undefined,
    private readonly workflow: ProductWorkflowService,
    private readonly isBusy: (root: string) => boolean = () => false,
    private readonly store = new ProductWorkflowStore(),
  ) {}

  private root(projectId: string): string {
    this.workflow.get(projectId);
    const root = this.resolve(projectId);
    if (!root) throw new Error("项目不存在");
    return realpathSync(root);
  }

  private reference(root: string, requested: string): { path: string; digest: string } {
    const file = realpathSync(path.resolve(root, requested));
    const relative = path.relative(root, file);
    if (relative.startsWith(`..${path.sep}`) || relative === ".." || path.isAbsolute(relative)) throw new Error("影响引用必须在当前项目内");
    const stat = statSync(file);
    if (!stat.isFile() || stat.size > 2 * 1024 * 1024) throw new Error("影响引用需要不超过 2 MiB 的文件");
    return { path: relative.split(path.sep).join("/"), digest: createHash("sha256").update(readFileSync(file)).digest("hex") };
  }

  save(projectId: string, revision: number, commandId: string, input: unknown) {
    const root = this.root(projectId);
    const proposal = productChangeInputSchema.parse(input);
    return this.store.transact(projectId, commandId, revision, "save_product_change", proposal, (state) => {
      if (!state.approvals.scope || state.stage === "draft") throw new Error("尚未确认范围，请直接编辑产品草案");
      if (digest(state.draft) !== state.approvals.scope.contentDigest) throw new Error("当前需求与批准不一致，请先核对状态");
      const existing = proposal.proposalId ? state.proposals.find((entry) => entry.id === proposal.proposalId) : undefined;
      if (proposal.proposalId && !existing) throw new Error("变更提案不存在");
      if (existing && !["draft", "ready"].includes(existing.status)) throw new Error("已结束的提案不能覆盖，请另建提案");
      if (existing?.baseScopeDigest && existing.baseScopeDigest !== state.approvals.scope.contentDigest) throw new Error("提案基础范围已过期，请另建提案");
      if (productDraftDiff(state.draft, proposal.nextDraft).length === 0) throw new Error("目标需求没有变化");
      const impact = proposal.impact.map((item) => ({
        area: item.area, reason: item.reason,
        files: item.files.map((requested) => this.reference(root, requested)),
      }));
      let readinessIssue: string | undefined;
      try { assertProductScopeReady(proposal.nextDraft); }
      catch (cause) { readinessIssue = cause instanceof Error ? cause.message : String(cause); }
      const entry = {
        id: existing?.id ?? randomUUID(), baseRevision: state.revision,
        baseScopeDigest: state.approvals.scope.contentDigest, baseArtifactDigest: productArtifactDigest(root),
        baseDraft: structuredClone(state.draft), baseApprovals: structuredClone(state.approvals),
        target: proposal.target, preserve: proposal.preserve, nextDraft: proposal.nextDraft, impact,
        status: readinessIssue ? "draft" as const : "ready" as const, readinessIssue, updatedAt: new Date().toISOString(),
      };
      if (existing) Object.assign(existing, entry); else state.proposals.push(entry);
    });
  }

  confirm(projectId: string, revision: number, commandId: string, proposalId: string) {
    const root = this.root(projectId);
    z.uuid().parse(proposalId);
    return this.store.transact(projectId, commandId, revision, "confirm_product_change", { proposalId }, (state) => {
      const proposal = state.proposals.find((entry) => entry.id === proposalId);
      if (!proposal?.nextDraft || !["draft", "ready"].includes(proposal.status)) throw new Error("提案尚未准备好或已处理");
      if (state.runs.some((run) => ["running", "queued"].includes(run.executionStatus)) || this.isBusy(root)) throw new Error("请先等待当前任务结束或停止，再确认变更");
      if (proposal.baseScopeDigest !== state.approvals.scope?.contentDigest || digest(state.draft) !== proposal.baseScopeDigest) throw new Error("基础需求已变化，请重新整理提案");
      if (proposal.baseArtifactDigest !== productArtifactDigest(root)) throw new Error("代码或原型已变化，请重新检查影响并保存提案");
      for (const item of proposal.impact ?? []) for (const file of item.files) {
        if (digest(this.reference(root, file.path)) !== digest(file)) throw new Error("引用文件已变化，请重新核对影响");
      }
      assertProductScopeReady(proposal.nextDraft);
      const now = new Date().toISOString();
      proposal.confirmation = { at: now, revision: state.revision + 1, contentDigest: digest({
        base: proposal.baseScopeDigest, artifact: proposal.baseArtifactDigest, target: proposal.target,
        preserve: proposal.preserve, impact: proposal.impact, draft: proposal.nextDraft,
      }) };
      proposal.status = "confirmed";
      state.draft = structuredClone(proposal.nextDraft);
      state.approvals = { scope: { at: now, revision: state.revision + 1, contentDigest: digest(state.draft) } };
      state.prototype = undefined;
      state.verificationPlan = undefined;
      state.stage = "scope_confirmed";
      for (const run of state.runs) run.verificationStatus = "stale";
      for (const other of state.proposals) if (other.id !== proposalId && ["draft", "ready"].includes(other.status)) other.status = "superseded";
    });
  }

  reject(projectId: string, revision: number, commandId: string, proposalId: string) {
    this.root(projectId);
    z.uuid().parse(proposalId);
    return this.store.transact(projectId, commandId, revision, "reject_product_change", { proposalId }, (state) => {
      const proposal = state.proposals.find((entry) => entry.id === proposalId);
      if (!proposal || !["draft", "ready"].includes(proposal.status)) throw new Error("提案不存在或已处理");
      proposal.status = "rejected";
      proposal.updatedAt = new Date().toISOString();
    });
  }
}
