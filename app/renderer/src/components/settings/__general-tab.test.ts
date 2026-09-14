/**
 * 「重新检测」的口径守卫（用户拍板：与其限制按钮出现，不如统一）。
 *
 * 背景（两个真实缺陷，2026-09-15）：
 * 1. 设置页同屏出现过两个同文案按钮，且刷新范围不同——标题栏那个只刷 Git/Node/CodeGraph，
 *    面板那个刷系统组件并重置沙盒失败缓存，用户无从分辨。
 * 2. 我一度用"面板判断 `refreshKey === undefined` 决定是否渲染自己的按钮"来消除重复，
 *    而外层传入的初值恰好也是 `undefined` → 首帧又冒出第二个按钮（哨兵值与初值撞车）。
 *
 * 现在的口径：**按钮只有一处定义（EnvRetestButton），动作只有一个（EnvPanelHandle.retest）**，
 * 面板自身永不渲染刷新按钮，"同屏两个"在结构上不可能再出现。下面把这条不变量钉住。
 */
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

// GeneralTab 的 CodegraphRow 在**渲染期**就读 window.electronAPI.platform（node 环境没有 window）
globalThis.window = { electronAPI: { platform: "darwin" } } as never;

// 只 mock 这两个：settings-store（否则要把 zustand 与 @shared 别名一起拖进来）与确认弹窗
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
const { EnvRetestButton } = await import("../env/EnvRetestButton");

const countOf = (html: string, needle: string): number => html.split(needle).length - 1;

describe("「重新检测」全项目只有一处", () => {
  it("设置页整页渲染后按钮计数恰好为 1", () => {
    const html = renderToStaticMarkup(createElement(GeneralTab));
    expect(countOf(html, "重新检测"), "设置页出现了两个「重新检测」按钮").toBe(1);
    expect(html).toContain("环境检测"); // 确认面板/区块确实渲染了，不是"因为没有面板才只剩一个"
  });

  it("面板自身永不渲染刷新按钮（两种形态都不渲染）——这条不变量挡住整类重复", () => {
    expect(countOf(renderToStaticMarkup(createElement(EnvPanel, { variant: "settings" })), "重新检测")).toBe(0);
    expect(countOf(renderToStaticMarkup(createElement(EnvPanel, { variant: "onboarding" })), "重新检测")).toBe(0);
  });

  it("共用按钮：点下去 = 宿主自己的范围 + 面板重探（顺序固定）", () => {
    const retest = vi.fn();
    const before = vi.fn();
    const el = EnvRetestButton({
      panel: { current: { retest } },
      onBeforeRetest: before,
    }) as unknown as { props: { onClick: () => void } };

    el.props.onClick();
    expect(before).toHaveBeenCalledTimes(1);
    expect(retest).toHaveBeenCalledTimes(1);
    expect(before.mock.invocationCallOrder[0]!).toBeLessThan(retest.mock.invocationCallOrder[0]!);
  });

  it("宿主没给额外范围时（引导流程）也能单独用", () => {
    const retest = vi.fn();
    const el = EnvRetestButton({ panel: { current: { retest } } }) as unknown as { props: { onClick: () => void } };
    el.props.onClick();
    expect(retest).toHaveBeenCalledTimes(1);
  });
});
