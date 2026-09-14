/**
 * 设置页「环境检测」的按钮唯一性守卫。
 *
 * 背景（真实缺陷，2026-09-15 用户报「重新检测按钮还是两个」）：
 * `EnvPanel` 用 `refreshKey === undefined` 判定「外层是否接管刷新」，而外层 `GeneralTab` 传给它的
 * 初值恰好也是 `undefined` → **面板首帧又渲染出它自己的「重新检测」**，同屏两个（点过标题栏那个
 * 之后才消失，所以现象是"一进来就是两个"）。这是"两个真相源共用一个哨兵值"的典型坑。
 *
 * 这个测试用**整页静态渲染**（react-dom/server，不需要 jsdom）数按钮个数：
 * 计数为 1 才算对，为 2 就是上面那个缺陷复活了。
 */
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

// GeneralTab 的 CodegraphRow 在**渲染期**就读 window.electronAPI.platform（CodegraphRow.tsx 那行），
// node 环境没有 window，补个最小桩即可（渲染期只用得到 platform；其余 API 都在 effect/事件里）
globalThis.window = { electronAPI: { platform: "darwin" } } as never;

// 只 mock 这两个：settings-store（否则要连 zustand 与 @shared 别名一起拖进来）与确认弹窗
vi.mock("../../stores/settings-store", () => {
  const state = {
    sandboxDisabled: false,
    setSandboxDisabled: (): void => { /* 测试不触发 */ },
    defaultProjectDir: "~/EasyMintProject",
    contextThreshold: 75,
    setDefaultProjectDir: (): void => { /* 测试不触发 */ },
    setContextThreshold: (): void => { /* 测试不触发 */ },
  };
  return { useSettingsStore: (sel?: (s: typeof state) => unknown) => (sel ? sel(state) : state) };
});
vi.mock("../ui/ConfirmDialog", () => ({ confirmDialog: async (): Promise<boolean> => true }));

const { GeneralTab } = await import("./GeneralTab");
const { EnvPanel } = await import("../env/EnvPanel");

const countOf = (html: string, needle: string): number => html.split(needle).length - 1;

describe("设置页「环境检测」：同屏只有一个「重新检测」", () => {
  it("整页渲染后按钮计数恰好为 1（2 = 面板与标题栏各渲染了一个）", () => {
    const html = renderToStaticMarkup(createElement(GeneralTab));
    expect(countOf(html, "重新检测"), "设置页出现了两个「重新检测」按钮").toBe(1);
    // 顺带确认面板确实渲染出来了（不是"因为面板没渲染才只剩一个"）
    expect(html).toContain("环境检测");
  });

  it("面板被外层驱动（refreshKey 为数字）时不再自带按钮", () => {
    const html = renderToStaticMarkup(createElement(EnvPanel, { variant: "settings", refreshKey: 0 }));
    expect(countOf(html, "重新检测")).toBe(0);
  });

  it("引导流程没有外层标题栏，面板仍自带「重新检测」", () => {
    const html = renderToStaticMarkup(createElement(EnvPanel, { variant: "onboarding" }));
    expect(countOf(html, "重新检测")).toBe(1);
  });
});
