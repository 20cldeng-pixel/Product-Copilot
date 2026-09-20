import { createHash, randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, realpathSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import path from "node:path";
import { z } from "zod";
import { DATA_DIR } from "./store";
import { criterionSchema, manualVerificationSchema, verificationPlanSchema, verificationReportSchema } from "./product-verification-schema";
import type {
  ProductDraft, ProductRun, ProductWorkflowSnapshot,
} from "../../shared/product-workflow";

const id = z.string().uuid();
const text = z.string().trim().min(1);
export const draftSchema = z.object({
  brief: z.object({
    idea: z.string(), targetUser: z.string(), scenario: z.string(), constraints: z.array(z.string()),
  }).strict(),
  research: z.array(z.object({
    id: text, subject: z.string(),
    sourceUrl: z.url().refine((value) => /^https?:\/\//i.test(value), "仅支持 HTTP(S) 来源").optional(),
    materialRef: text.optional(), observedAt: z.iso.datetime().optional(),
    fact: z.string(), inference: z.string(),
  }).strict()),
  researchStatus: z.enum(["pending", "complete", "insufficient_accepted"]),
  requirements: z.array(z.object({
    id: text, title: z.string(), priority: z.enum(["P0", "P1", "P2"]),
    behavior: z.string(), acceptance: z.array(z.string()),
  }).strict()),
  questions: z.array(z.object({ id: text, text: z.string(), blocking: z.boolean(), resolution: z.string().optional() }).strict()),
}).strict();

export function assertProductScopeReady(draft: ProductDraft): void {
  if (!draft.brief.idea.trim() || !draft.brief.targetUser.trim() || !draft.brief.scenario.trim()) {
    throw new Error("请先填写想法、目标用户和使用场景");
  }
  if (draft.researchStatus === "pending") throw new Error("竞品调研尚未完成或说明资料不足");
  if (draft.researchStatus === "complete" && (draft.research.length === 0 || draft.research.some((item) => !item.sourceUrl && !item.materialRef))) {
    throw new Error("调研缺少可追溯来源");
  }
  if (draft.research.some((item) => !item.subject.trim() || !item.fact.trim())) throw new Error("调研来源仍有未填完的名称或事实");
  if (draft.requirements.some((item) => !item.title.trim() || !item.behavior.trim() || item.acceptance.some((criterion) => !criterion.trim()))) {
    throw new Error("需求标题、行为或验收条件仍未填完");
  }
  if (draft.questions.some((item) => !item.text.trim())) throw new Error("待回答问题尚未填写");
  for (const items of [draft.research, draft.requirements, draft.questions]) {
    if (new Set(items.map((item) => item.id)).size !== items.length) throw new Error("来源、需求或问题 ID 重复");
  }
  if (draft.questions.some((q) => q.blocking && !q.resolution?.trim())) throw new Error("仍有未解决的关键问题");
  if (!draft.requirements.some((r) => r.priority === "P0" && r.acceptance.some((criterion) => criterion.trim()))) {
    throw new Error("至少需要一项具有验收条件的首版需求");
  }
  if (draft.requirements.some((r) => r.priority === "P0" && r.acceptance.length === 0)) {
    throw new Error("每项首版必做需求都需要验收条件");
  }
}

const approvalSchema = z.object({ at: z.iso.datetime(), contentDigest: text, revision: z.number().int().nonnegative() }).strict();
const snapshotSchema = z.object({
  schemaVersion: z.literal(1), projectId: id, revision: z.number().int().nonnegative(),
  stage: z.enum(["draft", "scope_confirmed", "prototype_ready", "development_authorized"]),
  draft: draftSchema,
  approvals: z.object({ scope: approvalSchema.optional(), development: approvalSchema.optional() }).strict(),
  prototype: z.object({ filePath: text, contentDigest: text, scopeDigest: text }).strict().optional(),
  proposals: z.array(z.object({
    id: text, baseRevision: z.number().int().nonnegative(), target: text,
    preserve: z.array(text), status: z.enum(["draft", "ready", "confirmed", "rejected", "superseded"]),
    readinessIssue: text.optional(),
    baseScopeDigest: text.optional(), baseArtifactDigest: text.optional(), baseDraft: draftSchema.optional(), nextDraft: draftSchema.optional(),
    baseApprovals: z.object({ scope: approvalSchema.optional(), development: approvalSchema.optional() }).strict().optional(),
    impact: z.array(z.object({ area: text, reason: text, files: z.array(z.object({ path: text, digest: text }).strict()) }).strict()).optional(),
    updatedAt: z.iso.datetime().optional(), confirmation: approvalSchema.optional(),
  }).strict()),
  runs: z.array(z.object({
    id, scopeDigest: text, prototypeDigest: text,
    executionStatus: z.enum(["queued", "running", "completed", "failed", "interrupted", "cancelled"]),
    verificationStatus: z.enum(["not_run", "pass", "fail", "inconclusive", "stale"]),
    createdAt: z.iso.datetime(),
    kind: z.enum(["verification", "build"]).optional(), criteria: z.array(criterionSchema).optional(),
    build: z.object({
      startedAt: z.iso.datetime(), finishedAt: z.iso.datetime().optional(), stopRequested: z.boolean().optional(),
      artifactBefore: text.optional(), artifactAfter: text.optional(),
      result: z.object({
        status: z.enum(["completed", "failed", "cancelled"]), sessionId: text.optional(), model: text.optional(), provider: text.optional(),
        summary: z.string(), error: z.string().optional(), toolCalls: z.number().int().nonnegative(), toolErrors: z.number().int().nonnegative(),
      }).strict().optional(),
    }).strict().optional(),
    plan: verificationPlanSchema.optional(), report: verificationReportSchema.optional(),
  }).strict()),
  evidence: z.array(z.object({
    id: text, runId: id, criterionId: text, artifactDigest: text,
    outcome: z.enum(["pass", "fail", "inconclusive"]), observedAt: z.iso.datetime(),
    method: z.literal("vitest").optional(), testKeys: z.array(text).optional(), observation: z.string().optional(),
  }).strict()),
  verificationPlan: verificationPlanSchema.optional(),
  manualVerifications: z.array(manualVerificationSchema).optional(),
  updatedAt: z.iso.datetime(),
}).strict();

type Snapshot = ProductWorkflowSnapshot;
type CommandReceipt = { commandId: string; digest: string; appliedRevision: number };
type StoredState = { snapshot: Snapshot; commands: CommandReceipt[] };

function digest(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

function blank(projectId: string): Snapshot {
  return {
    schemaVersion: 1, projectId, revision: 0, stage: "draft",
    draft: {
      brief: { idea: "", targetUser: "", scenario: "", constraints: [] },
      research: [], researchStatus: "pending", requirements: [], questions: [],
    },
    approvals: {}, prototype: undefined, proposals: [], runs: [], evidence: [],
    updatedAt: new Date().toISOString(),
  };
}

/** 单主进程中的同步事务；跨窗口请求在同一事件循环中串行落盘。 */
export class ProductWorkflowStore {
  constructor(private readonly dataDir = path.join(DATA_DIR, "product-workflows")) {}

  exists(projectId: string): boolean {
    return existsSync(this.file(projectId));
  }

  private file(projectId: string): string {
    id.parse(projectId);
    return path.join(this.dataDir, `${projectId}.json`);
  }

  private readStored(projectId: string): StoredState {
    const file = this.file(projectId);
    if (!existsSync(file)) return { snapshot: blank(projectId), commands: [] };
    // 损坏状态应明确报错，不能静默初始化并丢失用户的批准记录。
    const raw = JSON.parse(readFileSync(file, "utf8")) as unknown;
    const parsed = z.object({
      snapshot: snapshotSchema,
      commands: z.array(z.object({ commandId: id, digest: text, appliedRevision: z.number().int().positive() }).strict()),
    }).strict().parse(raw);
    if (parsed.snapshot.projectId !== projectId) throw new Error("产品状态归属与项目不匹配");
    return parsed as StoredState;
  }

  read(projectId: string): Snapshot {
    return this.readStored(projectId).snapshot;
  }

  transact(
    projectId: string, commandId: string, expectedRevision: number,
    action: string, payload: unknown, update: (snapshot: Snapshot) => void,
  ): { snapshot: Snapshot; replayed: boolean; appliedRevision: number } {
    id.parse(commandId);
    if (!Number.isInteger(expectedRevision) || expectedRevision < 0) throw new Error("无效状态版本");
    const stored = this.readStored(projectId);
    const commandDigest = digest({ action, payload });
    const prior = stored.commands.find((entry) => entry.commandId === commandId);
    if (prior) {
      if (prior.digest !== commandDigest) throw new Error("命令 ID 已被不同内容使用");
      return { snapshot: stored.snapshot, replayed: true, appliedRevision: prior.appliedRevision };
    }
    if (stored.snapshot.revision !== expectedRevision) throw new Error("状态版本已变化，请刷新后重试");

    update(stored.snapshot);
    stored.snapshot.revision += 1;
    stored.snapshot.updatedAt = new Date().toISOString();
    stored.commands.push({ commandId, digest: commandDigest, appliedRevision: stored.snapshot.revision });
    snapshotSchema.parse(stored.snapshot);
    mkdirSync(this.dataDir, { recursive: true });
    const file = this.file(projectId);
    const temporary = `${file}.${randomUUID()}.tmp`;
    try {
      writeFileSync(temporary, JSON.stringify(stored, null, 2), { encoding: "utf8", mode: 0o600 });
      renameSync(temporary, file);
    } finally {
      if (existsSync(temporary)) unlinkSync(temporary);
    }
    return { snapshot: stored.snapshot, replayed: false, appliedRevision: stored.snapshot.revision };
  }
}

export type ProductCommandResult = ReturnType<ProductWorkflowStore["transact"]>;

/** 宿主服务负责批准及执行资格；Mint 只能提供草案内容。 */
export class ProductWorkflowService {
  constructor(
    private readonly projectPathForId: (projectId: string) => string | undefined,
    private readonly store = new ProductWorkflowStore(),
  ) {}

  private projectPath(projectId: string): string {
    id.parse(projectId);
    const projectPath = this.projectPathForId(projectId);
    if (!projectPath || !existsSync(projectPath)) throw new Error("项目不存在或目录不可用");
    return realpathSync(projectPath);
  }

  private prototypeRoot(projectRoot: string): string {
    const root = realpathSync(path.join(projectRoot, "prototype"));
    if (!root.startsWith(projectRoot + path.sep)) throw new Error("原型目录不属于当前项目");
    return root;
  }

  private prototypeFile(projectRoot: string, filePath: string): string {
    const artifact = realpathSync(filePath);
    if (!artifact.startsWith(this.prototypeRoot(projectRoot) + path.sep)) {
      throw new Error("原型文件必须位于当前项目的 prototype 目录");
    }
    return artifact;
  }

  get(projectId: string): Snapshot {
    this.projectPath(projectId);
    return this.store.read(projectId);
  }

  isActive(projectId: string): boolean {
    this.projectPath(projectId);
    return this.store.exists(projectId);
  }

  activate(projectId: string, expectedRevision: number, commandId: string): ProductCommandResult {
    this.projectPath(projectId);
    return this.store.transact(projectId, commandId, expectedRevision, "activate", null, (snapshot) => {
      if (snapshot.revision !== 0 || snapshot.stage !== "draft") throw new Error("产品流程已启用");
    });
  }

  isDevelopmentCurrent(projectId: string): boolean {
    const projectRoot = this.projectPath(projectId);
    const state = this.store.read(projectId);
    if (state.stage !== "development_authorized" || !state.approvals.scope || !state.approvals.development || !state.prototype) return false;
    try {
      if (digest(state.draft) !== state.approvals.scope.contentDigest) return false;
      const file = this.prototypeFile(projectRoot, state.prototype.filePath);
      const currentDigest = createHash("sha256").update(readFileSync(file)).digest("hex");
      return currentDigest === state.prototype.contentDigest
        && state.prototype.scopeDigest === state.approvals.scope.contentDigest
        && state.approvals.development.contentDigest === digest({
          scope: state.approvals.scope.contentDigest, prototype: currentDigest,
        });
    } catch { return false; }
  }

  saveDraft(projectId: string, expectedRevision: number, commandId: string, input: ProductDraft): ProductCommandResult {
    this.projectPath(projectId);
    const draft = draftSchema.parse(input) as ProductDraft;
    return this.store.transact(projectId, commandId, expectedRevision, "save_draft", draft, (snapshot) => {
      if (snapshot.stage !== "draft") throw new Error("已确认范围需要通过变更提案调整");
      snapshot.draft = draft;
    });
  }

  confirmScope(projectId: string, expectedRevision: number, commandId: string): ProductCommandResult {
    const projectRoot = this.projectPath(projectId);
    const result = this.store.transact(projectId, commandId, expectedRevision, "confirm_scope", null, (snapshot) => {
      if (snapshot.stage !== "draft") throw new Error("当前阶段不能确认首版范围");
      const { draft } = snapshot;
      assertProductScopeReady(draft);
      snapshot.approvals.scope = {
        at: new Date().toISOString(), contentDigest: digest(draft), revision: snapshot.revision + 1,
      };
      snapshot.stage = "scope_confirmed";
    });
    // 原型是获批后的唯一预开发写入区。目录由宿主准备，Agent 无需 shell 建目录。
    mkdirSync(path.join(projectRoot, "prototype"), { recursive: true });
    return result;
  }

  submitPrototype(projectId: string, expectedRevision: number, commandId: string, filePath: string): ProductCommandResult {
    const projectRoot = this.projectPath(projectId);
    return this.store.transact(projectId, commandId, expectedRevision, "submit_prototype", { filePath }, (snapshot) => {
      if (snapshot.runs.some((run) => run.kind === "build" && ["queued", "running"].includes(run.executionStatus))) {
        throw new Error("请先等待当前开发结束或停止后再登记原型");
      }
      if (snapshot.stage !== "scope_confirmed" && snapshot.stage !== "prototype_ready" && snapshot.stage !== "development_authorized") {
        throw new Error("请先确认首版范围");
      }
      if (!snapshot.approvals.scope) throw new Error("缺少范围批准记录");
      const artifact = this.prototypeFile(projectRoot, filePath);
      const contentDigest = createHash("sha256").update(readFileSync(artifact)).digest("hex");
      snapshot.prototype = { filePath: artifact, contentDigest, scopeDigest: snapshot.approvals.scope.contentDigest };
      snapshot.approvals.development = undefined;
      snapshot.stage = "prototype_ready";
    });
  }

  confirmDevelopment(projectId: string, expectedRevision: number, commandId: string): ProductCommandResult {
    const projectRoot = this.projectPath(projectId);
    return this.store.transact(projectId, commandId, expectedRevision, "confirm_development", null, (snapshot) => {
      if (snapshot.stage !== "prototype_ready" || !snapshot.prototype || !snapshot.approvals.scope) {
        throw new Error("原型或范围尚未准备好");
      }
      if (digest(snapshot.draft) !== snapshot.approvals.scope.contentDigest) throw new Error("首版范围已变化，请重新确认");
      const file = this.prototypeFile(projectRoot, snapshot.prototype.filePath);
      const currentDigest = createHash("sha256").update(readFileSync(file)).digest("hex");
      if (currentDigest !== snapshot.prototype.contentDigest) throw new Error("原型已变化，请重新提交");
      if (snapshot.prototype.scopeDigest !== snapshot.approvals.scope.contentDigest) throw new Error("原型与范围版本不一致");
      snapshot.approvals.development = {
        at: new Date().toISOString(),
        contentDigest: digest({ scope: snapshot.approvals.scope.contentDigest, prototype: currentDigest }),
        revision: snapshot.revision + 1,
      };
      snapshot.stage = "development_authorized";
    });
  }

  /** 为后续 Builder 调度预留；当前不会从 UI 自动触发执行。 */
  startRun(projectId: string, expectedRevision: number, commandId: string): ProductCommandResult {
    this.projectPath(projectId);
    return this.store.transact(projectId, commandId, expectedRevision, "start_run", null, (snapshot) => {
      if (snapshot.stage !== "development_authorized" || !snapshot.approvals.scope || !snapshot.approvals.development || !snapshot.prototype) {
        throw new Error("开发尚未获得当前版本授权");
      }
      if (!this.isDevelopmentCurrent(projectId)) throw new Error("开发批准已失效，请重新核对原型");
      if (snapshot.runs.some((run) => run.executionStatus === "queued" || run.executionStatus === "running")) {
        throw new Error("项目已有待执行任务");
      }
      const run: ProductRun = {
        id: randomUUID(), scopeDigest: snapshot.approvals.scope.contentDigest,
        prototypeDigest: snapshot.prototype.contentDigest,
        executionStatus: "queued", verificationStatus: "not_run", createdAt: new Date().toISOString(),
      };
      snapshot.runs.push(run);
    });
  }
}
