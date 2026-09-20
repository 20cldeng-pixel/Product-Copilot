import type { ProductDraft } from "./product-workflow";

export interface Criterion { id: string; requirementId: string; title: string; text: string }
export function productCriteria(draft: ProductDraft): Criterion[] {
  return draft.requirements.filter((r) => r.priority === "P0").flatMap((r) =>
    r.acceptance.map((text, index) => ({ id: JSON.stringify([r.id, index]), requirementId: r.id, title: r.title, text })));
}

export interface TestCaseResult {
  key: string;
  file: string;
  name: string;
  status: "passed" | "failed" | "pending";
  messages: string[];
}
export interface VerificationReport {
  artifactDigest: string;
  finishedArtifactDigest: string;
  exitCode: number | null;
  problem?: string;
  stdout: string;
  stderr: string;
  rawReport?: string;
  cases: TestCaseResult[];
  finishedAt: string;
  nodeVersion: string;
  vitestVersion: string;
}
export interface VerificationPlan {
  scopeDigest: string;
  artifactDigest: string;
  bindings: Record<string, string[]>;
  approvedAt: string;
}
export interface ManualVerification {
  id: string; runId: string; criterionId: string;
  decision: "verified" | "exception";
  reason: string; artifactDigest: string; observedAt: string;
}
