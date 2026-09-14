import type { ExecutionContext } from "../permission/execution-context";

export type WindowsSandboxWorkerRequest =
  | { type: "initialize"; requestId: string; context: ExecutionContext }
  | { type: "wrap"; requestId: string; command: string; shell: "bash" | "powershell"; gitBashPath?: string; commandId: string }
  | { type: "release"; requestId: string; leaseId: string }
  | { type: "shutdown"; requestId: string; force?: boolean };

export type WindowsSandboxWorkerResponse =
  | { type: "ready"; requestId: string }
  | { type: "wrapped"; requestId: string; argv: string[]; env: NodeJS.ProcessEnv }
  | { type: "released"; requestId: string }
  | { type: "stopped"; requestId: string }
  | { type: "error"; requestId: string; message: string };
