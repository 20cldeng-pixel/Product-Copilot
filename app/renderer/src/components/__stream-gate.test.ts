import { describe, expect, it } from "vitest";
import { acceptStreamEvent } from "./chat-utils";

/**
 * 门卫的回归锚点（2026-09-16）。
 *
 * 原实现把「本面板的会话 id」读成订阅时闭包里的 props（onStream 订阅 effect 依赖数组是 `[]`，
 * 只订阅一次）→ 面板若在**挂载后才拿到 sessionId**（新建项目流程：消息由弹窗发送，本面板没有
 * sendMessage 结果可绑 chatId），闭包里的 existingSid 永久是 undefined，属于它的流事件被整批丢弃，
 * 聊天区永久空白。抽成纯函数后这里把「必须按实时会话 id 认领」钉死。
 */
const S = "01a0a86f-7253-7076-a4d2-8fecb2d6d135";

describe("acceptStreamEvent", () => {
  it("面板挂载后才拿到 sessionId：属于它的事件必须放行（本条的回归点）", () => {
    expect(acceptStreamEvent({ currentChatId: null, ownSessionId: S, eventSessionId: S })).toBe(true);
  });

  it("会话未知（临时 __new_* 面板）→ 拒绝一切，防跨窗口串流", () => {
    expect(acceptStreamEvent({ currentChatId: null, ownSessionId: undefined, eventSessionId: S })).toBe(false);
  });

  it("别的会话的事件不认领", () => {
    expect(acceptStreamEvent({ currentChatId: null, ownSessionId: S, eventSessionId: "other" })).toBe(false);
    expect(acceptStreamEvent({ currentChatId: null, ownSessionId: S })).toBe(false);
  });

  it("已绑 chatId：按 runId/chatId 精确过滤", () => {
    const base = { currentChatId: "c1", ownSessionId: S };
    expect(acceptStreamEvent({ ...base, eventRunId: "c1" })).toBe(true);
    expect(acceptStreamEvent({ ...base, eventChatId: "c1" })).toBe(true);
    expect(acceptStreamEvent({ ...base, eventRunId: "c2" })).toBe(false);
    expect(acceptStreamEvent({ ...base, eventChatId: "c2" })).toBe(false);
    // 既无 runId 也无 chatId 的裸事件：绑了 chat 之后不认（宁可丢也不跨窗口串流）
    expect(acceptStreamEvent({ ...base, eventSessionId: S })).toBe(false);
  });
});
