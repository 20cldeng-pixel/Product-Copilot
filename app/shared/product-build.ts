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

export interface ProductBuildRecord {
  startedAt: string;
  finishedAt?: string;
  stopRequested?: boolean;
  artifactBefore?: string;
  artifactAfter?: string;
  result?: ProductBuildResult;
}
