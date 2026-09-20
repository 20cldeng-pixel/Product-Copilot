import type { AgentSessionEvent } from "./pi-sdk";
import type { ProductBuildResult } from "../../shared/product-build";

export interface ProductBuildSession {
  sessionId: string;
  subscribe(listener: (event: AgentSessionEvent) => void): () => void;
  prompt(text: string): Promise<void>;
  abort(): Promise<void>;
  dispose(): void;
}

/** 只接受实际 SDK 终态；回合正常结束不等价于业务验收成功。 */
export async function executeProductBuildSession(
  create: () => Promise<ProductBuildSession>, prompt: string, signal: AbortSignal,
  limits = { timeoutMs: 600000, maxToolCalls: 80 },
): Promise<ProductBuildResult> {
  let session: ProductBuildSession | undefined;
  let unsubscribe: (() => void) | undefined;
  let final: { stopReason?: string; errorMessage?: string; text: string } | undefined;
  let toolCalls = 0;
  let toolErrors = 0;
  let stopReason: string | undefined;
  let abortError: string | undefined;
  let aborting: Promise<void> | undefined;
  const stop = (reason: string) => {
    stopReason ??= reason;
    if (session && !aborting) aborting = session.abort().catch((cause) => { abortError = String(cause); });
  };
  const onAbort = () => stop("用户已停止开发");
  signal.addEventListener("abort", onAbort, { once: true });
  const timer = setTimeout(() => stop("达到开发时间上限（10 分钟）"), limits.timeoutMs);
  let result: ProductBuildResult;
  try {
    if (signal.aborted) stop("用户已停止开发");
    if (!stopReason) session = await create();
    if (stopReason || signal.aborted) {
      stop(stopReason ?? "用户已停止开发");
      result = { status: "cancelled", summary: "", error: stopReason, toolCalls, toolErrors };
    } else {
      const active = session!;
      unsubscribe = active.subscribe((event) => {
        if (event.type === "agent_start") final = undefined;
        if (event.type === "tool_execution_start") {
          toolCalls++;
          if (toolCalls >= limits.maxToolCalls) stop("达到工具调用上限（80 次）");
        }
        if (event.type === "tool_execution_end" && event.isError) toolErrors++;
        if (event.type === "agent_end" && !event.willRetry) {
          const message = [...event.messages].reverse().find((item) => item.role === "assistant");
          if (message?.role === "assistant") final = {
            stopReason: message.stopReason, errorMessage: message.errorMessage,
            text: message.content.filter((block) => block.type === "text").map((block) => block.text).join("\n").slice(0, 12000),
          };
        }
      });
      await active.prompt(prompt);
      const end = final as { stopReason?: string; errorMessage?: string; text: string } | undefined;
      result = {
        status: stopReason || signal.aborted || end?.stopReason === "aborted" ? "cancelled" : end?.stopReason === "stop" ? "completed" : "failed",
        summary: end?.text ?? "", toolCalls, toolErrors,
        error: stopReason ?? (end?.stopReason === "stop" ? undefined : end?.errorMessage ?? "模型未正常结束本轮开发，请检查会话记录"),
      };
    }
  } catch (cause) {
    result = { status: stopReason || signal.aborted ? "cancelled" : "failed", summary: "",
      error: stopReason ?? String(cause), toolCalls, toolErrors };
  } finally {
    clearTimeout(timer);
    signal.removeEventListener("abort", onAbort);
    await aborting;
    unsubscribe?.();
    session?.dispose();
  }
  if (abortError) { result.status = "failed"; result.error = `停止执行失败：${abortError}`; }
  result.sessionId = session?.sessionId;
  return result;
}
