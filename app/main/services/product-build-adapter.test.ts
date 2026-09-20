import { afterEach, describe, expect, it, vi } from "vitest";
import { randomUUID } from "node:crypto";
import { AgentService } from "./agent-service";
import type { Store } from "./store";
import type { AgentSession, AgentSessionEvent } from "./pi-sdk";
import { createPiSession } from "./pi-session";
import { getActiveModel } from "./pi-init";
import { ProductWorkflowService } from "./product-workflow-service";
import { productBuildRuntime } from "./product-build-runtime";
import { permissionService } from "./permission/agent-permission-service";

vi.mock("electron", () => ({ app: { isPackaged: false, getPath: () => "/tmp" }, BrowserWindow: { getAllWindows: () => [] } }));
vi.mock("./pi-session", () => ({ createPiSession: vi.fn(), resumePiSession: vi.fn(), listPiSessions: vi.fn() }));
vi.mock("./pi-init", () => ({ getActiveModel: vi.fn(), resetModelRuntime: vi.fn() }));
const projects: string[] = [];
afterEach(() => {
  vi.restoreAllMocks(); vi.clearAllMocks();
  for (const projectId of projects.splice(0)) {
    const owner = productBuildRuntime.get(projectId);
    if (owner) productBuildRuntime.release(projectId, owner.runId);
  }
});

function fixture() {
  const projectId = randomUUID(); projects.push(projectId);
  const root = "/tmp/product-build-adapter";
  const runId = randomUUID(); const controller = productBuildRuntime.acquire(projectId, runId);
  const store = { getProjects: () => [{ id: projectId, path: root }] } as unknown as Store;
  vi.mocked(getActiveModel).mockResolvedValue({ id: "configured-model", provider: "configured-provider" } as Awaited<ReturnType<typeof getActiveModel>>);
  vi.spyOn(ProductWorkflowService.prototype, "isDevelopmentCurrent").mockReturnValue(true);
  const permission = vi.fn(async () => ({ behavior: "allow" as const }));
  vi.spyOn(permissionService, "createCanUseTool").mockReturnValue(permission);
  let listener: ((event: AgentSessionEvent) => void) | undefined;
  const session = {
    sessionId: "actual-sdk-id", subscribe: vi.fn((callback) => { listener = callback; return () => undefined; }),
    prompt: vi.fn(async () => { listener?.({ type: "agent_end", willRetry: false, messages: [{ role: "assistant", content: [{ type: "text", text: "done" }], stopReason: "stop" }] } as AgentSessionEvent); }),
    abort: vi.fn(async () => undefined), dispose: vi.fn(),
  };
  vi.mocked(createPiSession).mockResolvedValue(session as unknown as AgentSession);
  return { projectId, root, runId, controller, service: new AgentService(store), session, permission };
}

describe("product Builder AgentService adapter", () => {
  it("uses configured model, existing permission wrapper and no delegation tools", async () => {
    const f = fixture();
    const result = await f.service.executeProductBuild(f.root, f.runId, "approved P0", f.controller.signal);
    expect(result).toMatchObject({ status: "completed", sessionId: "actual-sdk-id", model: "configured-model", provider: "configured-provider" });
    const options = vi.mocked(createPiSession).mock.calls[0]![0];
    expect(options.extraTools).toEqual([]);
    expect(options.cwd).toBe(f.root);
    const allowed = await options.canUseTool!("write", { path: "app.ts" }, { signal: f.controller.signal, toolUseID: "tool-1" });
    expect(allowed.behavior).toBe("allow"); expect(f.permission).toHaveBeenCalledOnce();
    expect((await options.canUseTool!("bash", { background: true }, { signal: f.controller.signal, toolUseID: "tool-2" })).behavior).toBe("deny");
    productBuildRuntime.release(f.projectId, f.runId);
    expect((await options.canUseTool!("write", { path: "app.ts" }, { signal: f.controller.signal, toolUseID: "tool-1" })).behavior).toBe("deny");
  });

  it("fails before session creation when there is no configured model", async () => {
    const f = fixture(); vi.mocked(getActiveModel).mockResolvedValue(null);
    expect(await f.service.executeProductBuild(f.root, f.runId, "scope", f.controller.signal)).toMatchObject({ status: "failed", error: expect.stringContaining("未配置模型") });
    expect(createPiSession).not.toHaveBeenCalled();
  });
});
