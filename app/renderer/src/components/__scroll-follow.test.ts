import { describe, expect, it } from "vitest";
import { followDecision, USER_INPUT_WINDOW_MS } from "./chat-utils";

/**
 * 流式贴底跟随的判定（对齐聊天页 ChatPanel）。
 *
 * 两个方向的回归都在这里锚住：
 * ① 「跟不住」：程序性贴底/内容变高引起的 scroll（无用户输入）**不得**改状态——
 *    否则贴底后内容又长高、事件到达时 dist 已 >8px，会被当成「用户滚离底部」把跟随锁死
 *    （现象：思考流式输出头几秒跟得住，之后视口不再贴底）。
 * ② 「锁死滚不动」：用户输入后的变化**必须**被判成用户滚动——
 *    曾额外加过「自己贴底 120ms 内的 scroll 不参与判定」的守卫，流式时每帧都在贴底，
 *    那道窗口几乎永远命中，把用户的滚动一起吞掉（现象：强制锁底、往上滚不动）。
 */
describe("followDecision", () => {
  const input = (over: Partial<Parameters<typeof followDecision>[0]>) => ({
    distFromBottom: 0,
    msSinceUserInput: 10_000,
    ...over,
  });

  it("程序性滚动（无用户输入）→ 不改变状态（①：跟随不会被自己锁死）", () => {
    expect(followDecision(input({ distFromBottom: 300 }))).toBeUndefined();
    expect(followDecision(input({ distFromBottom: 300, msSinceUserInput: USER_INPUT_WINDOW_MS + 1 }))).toBeUndefined();
  });

  it("用户滚离底部 → 停止跟随（②：必须让用户滚得动）", () => {
    expect(followDecision(input({ distFromBottom: 300, msSinceUserInput: 200 }))).toBe(false);
  });

  it("用户滚回底部 → 恢复跟随", () => {
    expect(followDecision(input({ distFromBottom: 2, msSinceUserInput: 200 }))).toBe(true);
    expect(followDecision(input({ distFromBottom: 7, msSinceUserInput: 1 }))).toBe(true);
  });

  it("贴着底线的噪声（刚好 8px）按离开处理", () => {
    expect(followDecision(input({ distFromBottom: 8, msSinceUserInput: 200 }))).toBe(false);
  });
});
