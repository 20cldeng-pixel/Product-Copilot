import { afterEach, describe, expect, it, vi } from "vitest";
import { executeProductBuildSession, type ProductBuildSession } from "./product-build-runner";
import type { AgentSessionEvent } from "./pi-sdk";

afterEach(() => vi.useRealTimers());

function fixture() {
  let listener: (event: AgentSessionEvent) => void = () => undefined;
  const emit = (event: unknown) => listener(event as AgentSessionEvent);
  const end = (stopReason = "stop", willRetry = false) => emit({ type: "agent_end", willRetry, messages: [{
    role: "assistant", stopReason, errorMessage: stopReason === "error" ? "供应商故障" : undefined,
    content: [{ type: "text", text: "开发说明" }],
  }] });
  const unsubscribe = vi.fn();
  const session = {
    sessionId: "real-sdk-session", subscribe: vi.fn((callback) => { listener = callback; return unsubscribe; }),
    prompt: vi.fn(async () => end()), abort: vi.fn(async () => undefined), dispose: vi.fn(),
  } satisfies ProductBuildSession;
  const controller = new AbortController();
  return { session, emit, end, unsubscribe, controller, execute: () => executeProductBuildSession(async () => session, "approved requirements", controller.signal) };
}

describe("product Builder SDK lifecycle", () => {
  it("waits for the prompt to settle and records a real successful final event", async () => {
    const f = fixture(); let settle!: () => void;
    f.session.prompt.mockImplementationOnce(async () => { f.end(); await new Promise<void>((resolve) => { settle = resolve; }); });
    let ended = false;
    const execution = f.execute().then((result) => { ended = true; return result; });
    await Promise.resolve(); await Promise.resolve();
    expect(ended).toBe(false);
    settle(); const result = await execution;
    expect(result).toMatchObject({ status: "completed", summary: "开发说明", sessionId: "real-sdk-session" });
    expect(f.unsubscribe).toHaveBeenCalledOnce(); expect(f.session.dispose).toHaveBeenCalledOnce();
  });

  it.each(["error", "length", "toolUse"])("does not treat SDK %s termination as completion", async (reason) => {
    const f = fixture(); f.session.prompt.mockImplementationOnce(async () => f.end(reason));
    expect((await f.execute()).status).toBe("failed");
  });

  it("keeps missing final events and rejected prompts failed", async () => {
    const f = fixture(); f.session.prompt.mockImplementationOnce(async () => undefined);
    expect((await f.execute()).status).toBe("failed");
    f.session.prompt.mockRejectedValueOnce(new Error("request failed"));
    expect(await f.execute()).toMatchObject({ status: "failed", error: "Error: request failed" });
  });

  it("ignores retryable end events and records the eventual final outcome", async () => {
    const f = fixture(); f.session.prompt.mockImplementationOnce(async () => { f.end("error", true); f.end("stop"); });
    expect((await f.execute()).status).toBe("completed");
  });

  it("cancel during initialization never starts a prompt and disposes the created session", async () => {
    const f = fixture(); let ready!: (session: ProductBuildSession) => void;
    const execution = executeProductBuildSession(() => new Promise((resolve) => { ready = resolve; }), "scope", f.controller.signal);
    f.controller.abort(); ready(f.session);
    expect((await execution).status).toBe("cancelled");
    expect(f.session.prompt).not.toHaveBeenCalled(); expect(f.session.dispose).toHaveBeenCalledOnce();
  });

  it("cancel does not release the lifecycle before the underlying prompt stops", async () => {
    const f = fixture(); let settle!: () => void;
    f.session.prompt.mockImplementationOnce(async () => new Promise<void>((resolve) => { settle = resolve; }));
    let ended = false;
    const execution = f.execute().then((r) => { ended = true; return r; });
    await Promise.resolve(); f.controller.abort(); await Promise.resolve();
    expect(f.session.abort).toHaveBeenCalledOnce(); expect(ended).toBe(false);
    settle(); expect((await execution).status).toBe("cancelled");
  });

  it("requests abort at the time budget and keeps it separate from successful completion", async () => {
    vi.useFakeTimers(); const f = fixture(); let settle!: () => void;
    f.session.prompt.mockImplementationOnce(async () => new Promise<void>((resolve) => { settle = resolve; }));
    const execution = executeProductBuildSession(async () => f.session, "scope", f.controller.signal, { timeoutMs: 10, maxToolCalls: 80 });
    await Promise.resolve(); await vi.advanceTimersByTimeAsync(11);
    expect(f.session.abort).toHaveBeenCalledOnce(); settle();
    expect(await execution).toMatchObject({ status: "cancelled", error: expect.stringContaining("时间上限") });
  });

  it("counts tool errors and stops after the allowed number of tool calls", async () => {
    const f = fixture(); f.session.prompt.mockImplementationOnce(async () => {
      f.emit({ type: "tool_execution_start" }); f.emit({ type: "tool_execution_end", isError: true });
      f.emit({ type: "tool_execution_start" }); f.end();
    });
    const result = await executeProductBuildSession(async () => f.session, "scope", f.controller.signal, { timeoutMs: 1000, maxToolCalls: 2 });
    expect(result).toMatchObject({ status: "cancelled", toolCalls: 2, toolErrors: 1 });
    expect(f.session.abort).toHaveBeenCalledOnce();
  });
});
