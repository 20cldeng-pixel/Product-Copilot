/**
 * 「联网能力」只有一个 Key 字段、没有任何开关 —— 两处（引导页 / 设置页）同源。
 *
 * 背景（用户 2026-09-15 两次拍板）：
 * 1. 搜索与抓取用的是**同一个 Tavily Key**，但设置页曾拆成两行、每行一个同 keyId 的输入框 ——
 *    写的是同一处存储，用户不知道该填哪个。
 * 2. 随后取消开关：**填写 key 即启用、清空即停用**。此前"开关 on + key 非空"两个条件会造出
 *    "填了 key 却没开开关"的静默失效 —— 界面上看不出差别，模型那边工具就是不出现。
 *
 * 只断言静态结构，不跑 effect（node 环境，无 jsdom）：设置值由 effect 异步加载，本测试不依赖它。
 */
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

globalThis.window = {
  electronAPI: { platform: "darwin", settings: { get: async () => ({}), set: async () => {} } },
} as never;

vi.mock("../../stores/settings-store", () => {
  const state = {
    defaultProjectDir: "~/EasyMintProject",
    contextThreshold: 75,
    setDefaultProjectDir: (): void => { /* 测试不触发 */ },
    setContextThreshold: (): void => { /* 测试不触发 */ },
  };
  return { useSettingsStore: (sel?: (s: typeof state) => unknown) => (sel ? sel(state) : state) };
});
vi.mock("../ui/ConfirmDialog", () => ({ confirmDialog: async (): Promise<boolean> => true }));

const { ProvidersTab } = await import("./ProvidersTab");
const { TavilyKeySection } = await import("./TavilyKeySection");

const countOf = (html: string, needle: string): number => html.split(needle).length - 1;

describe("联网能力：一个 Key、没有开关", () => {
  it("设置页：Tavily Key 字段恰好 1 个，且没有任何能力开关", () => {
    const html = renderToStaticMarkup(createElement(ProvidersTab));
    expect(countOf(html, "Tavily API Key"), "同一个 Tavily Key 出现了多个输入框——搜索与抓取应共用一个字段").toBe(1);
    expect(countOf(html, 'role="switch"'), "不该再有能力开关：填写 key 即启用").toBe(0);
    // 图片识别同样是「填 key 即启用」，它的 key 字段照常在
    expect(countOf(html, "VISION_API_KEY")).toBe(1);
  });

  it("引导页：同一份字段（一个 Key、无开关）", () => {
    const html = renderToStaticMarkup(createElement(TavilyKeySection));
    expect(countOf(html, "Tavily API Key")).toBe(1);
    expect(countOf(html, 'role="switch"')).toBe(0);
  });
});
