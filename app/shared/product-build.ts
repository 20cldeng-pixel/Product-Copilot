export interface ProductBuildResult {
  status: "completed" | "failed" | "cancelled";
  sessionId?: string;
  model?: string;
  provider?: string;
  summary: string;
  error?: string;
  toolCalls: number;
  toolErrors: number;
}

export interface ProductBuildBatch {
  kind: "requirements" | "repair" | "integration";
  index?: number;
  total?: number;
  requirementIds: string[];
  /** Failed verification that opened this repair cycle. */
  sourceVerificationRunId?: string;
}

export interface ProductBuildRecord {
  startedAt: string;
  finishedAt?: string;
  stopRequested?: boolean;
  artifactBefore?: string;
  artifactAfter?: string;
  /** Execution scope only. A completed batch still requires independent verification. */
  batch?: ProductBuildBatch;
  result?: ProductBuildResult;
}
