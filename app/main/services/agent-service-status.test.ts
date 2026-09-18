import { describe, expect, it, vi } from "vitest";
import { AgentService } from "./agent-service";
import type { Store } from "./store";

/**
 * 会话运行状态（远程快照 status 的唯一来源）。
 *
 * 旧实现把状态存在 ActiveChat.status 字段上，而全项目没有任何赋值点更新它——
 * 快照里的 status 恒为 "idle"，手机重开会话永远判「空闲」（打不断、显示不出运行中）。
 * 现改为按 activePromptSessions 实时推导，这里锁住推导口径。
 */

vi.mock("electron", () => ({
  app: { isPackaged: false, getPath: () => "/tmp" },
  BrowserWindow: { getAllWindows: () => [] },
}));

/** 只注入会话/运行态两个私有表——被测的就是它们与 status 的推导关系 */
function serviceWithChat(sessionId: string): {
  service: AgentService;
  chats: Map<string, { chatId: string; sessionId: string }>;
  running: Set<string>;
} {
  const service = new AgentService({} as unknown as Store);
  const internals = service as unknown as {
    activeChats: Map<string, { chatId: string; sessionId: string }>;
    activePromptSessions: Set<string>;
  };
  internals.activeChats.set("chat-1", { chatId: "chat-1", sessionId });
  return { service, chats: internals.activeChats, running: internals.activePromptSessions };
}

describe("AgentService 会话运行状态", () => {
  it("无活跃会话 → idle", () => {
    const service = new AgentService({} as unknown as Store);
    expect(service.isSessionRunning("session-1")).toBe(false);
    expect(service.getChatStatus("session-1")).toBe("idle");
  });

  it("会话活跃但当前无进行中回合 → idle", () => {
    const { service } = serviceWithChat("session-1");
    expect(service.getChatStatus("session-1")).toBe("idle");
  });

  it("回合进行中 → running（快照据此让手机显示运行中并可打断）", () => {
    const { service, running } = serviceWithChat("session-1");
    running.add("session-1");
    expect(service.isSessionRunning("session-1")).toBe(true);
    expect(service.getChatStatus("session-1")).toBe("running");
  });

  it("回合结束后回到 idle", () => {
    const { service, running } = serviceWithChat("session-1");
    running.add("session-1");
    running.delete("session-1");
    expect(service.getChatStatus("session-1")).toBe("idle");
  });

  it("按 Pi 真实 ID 与 EM 临时 ID 双键匹配（新建会话早期前端用临时 ID）", () => {
    const service = new AgentService({} as unknown as Store);
    const internals = service as unknown as {
      activeChats: Map<string, { chatId: string; sessionId: string; tempSessionId?: string }>;
      activePromptSessions: Set<string>;
    };
    internals.activeChats.set("chat-1", { chatId: "chat-1", sessionId: "session-real", tempSessionId: "session-temp" });
    internals.activePromptSessions.add("session-real");
    expect(service.getChatStatus("session-temp")).toBe("running");
    expect(service.getChatStatus("session-real")).toBe("running");
  });
});
