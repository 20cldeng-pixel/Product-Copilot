import type { Criterion, ManualVerification, VerificationPlan, VerificationReport } from "./product-verification";
import type { ProductBuildRecord } from "./product-build";

/** Product Copilot 的正式状态。聊天记录与导出的 PRD 只是它的视图。 */
export type ProductStage = "draft" | "scope_confirmed" | "prototype_ready" | "development_authorized";
export type ResearchStatus = "pending" | "complete" | "insufficient_accepted";

export interface ProductBrief {
  idea: string;
  targetUser: string;
  scenario: string;
  constraints: string[];
}

export interface ResearchSource {
  id: string;
  subject: string;
  sourceUrl?: string;
  materialRef?: string;
  observedAt?: string;
  fact: string;
  inference: string;
}

export interface ProductRequirement {
  id: string;
  title: string;
  priority: "P0" | "P1" | "P2";
  behavior: string;
  acceptance: string[];
}

export interface ProductQuestion {
  id: string;
  text: string;
  blocking: boolean;
  resolution?: string;
}

export interface ProductDraft {
  brief: ProductBrief;
  research: ResearchSource[];
  researchStatus: ResearchStatus;
  requirements: ProductRequirement[];
  questions: ProductQuestion[];
}

export interface ProductApproval {
  at: string;
  contentDigest: string;
  revision: number;
}

export interface ProductPrototype {
  filePath: string;
  contentDigest: string;
  scopeDigest: string;
}

export interface ProductRun {
  id: string;
  scopeDigest: string;
  prototypeDigest: string;
  executionStatus: "queued" | "running" | "completed" | "failed" | "interrupted" | "cancelled";
  verificationStatus: "not_run" | "pass" | "fail" | "inconclusive" | "stale";
  createdAt: string;
  kind?: "verification" | "build";
  build?: ProductBuildRecord;
  criteria?: Criterion[];
  plan?: VerificationPlan;
  report?: VerificationReport;
}

/** 下一阶段的变更与验收结果也归入同一份项目状态。 */
export interface ProductChangeProposal {
  id: string;
  baseRevision: number;
  target: string;
  preserve: string[];
  status: "draft" | "ready" | "confirmed" | "rejected" | "superseded";
}

export interface ProductEvidence {
  id: string;
  runId: string;
  criterionId: string;
  artifactDigest: string;
  outcome: "pass" | "fail" | "inconclusive";
  observedAt: string;
  method?: "vitest";
  testKeys?: string[];
  observation?: string;
}

export interface ProductWorkflowSnapshot {
  schemaVersion: 1;
  projectId: string;
  revision: number;
  stage: ProductStage;
  draft: ProductDraft;
  approvals: { scope?: ProductApproval; development?: ProductApproval };
  prototype?: ProductPrototype;
  proposals: ProductChangeProposal[];
  runs: ProductRun[];
  evidence: ProductEvidence[];
  verificationPlan?: VerificationPlan;
  manualVerifications?: ManualVerification[];
  updatedAt: string;
}
