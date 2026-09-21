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
  kind: "requirements" | "integration";
  index?: number;
  total?: number;
  requirementIds: string[];
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
