/**
 * 内置能力的**启用判据**守卫（用户 2026-09-15 拍板：不再设开关，填写 key 即启用）。
 *
 * 此前判据是两个条件：「`builtinTools.<能力>` 开关为真 **且** 对应 key 非空」。于是存在
 * **静默失效**——用户填了 key 但没打开开关，界面上看不出任何差别，模型那边工具就是不出现
 * （与"装完依赖不重置沙盒缓存"同类的坑）。现在判据只剩 key 本身：填了即启用、清空即停用。
 *
 * 这里直接把「有 key、没有 builtinTools 字段」钉成必须为真的用例——若哪天有人把开关判据加回来，
 * 这条必红。
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

/** 被测模块读的配置文件内容（每次用例前替换） */
let settings: Record<string, unknown> = {};

// vi.mock 会被提升到 import 之前执行，所以这里用静态导入即可（主进程 tsconfig 不允许顶层 await）
vi.mock("node:fs", () => ({
  existsSync: (): boolean => true,
  readFileSync: (): string => JSON.stringify(settings),
}));
vi.mock("node:os", () => ({ homedir: (): string => "/tmp/fake-home" }));
vi.mock("electron", () => ({ app: { isPackaged: false } }));

import { isToolEnabled } from "./api-clients";

beforeEach(() => { settings = {}; });

describe("内置能力只看 key", () => {
  it("填了 Tavily key 即两项都可用——**配置里根本没有 builtinTools 字段**（旧开关已废弃）", () => {
    settings = { apiKeys: { TAVILY_API_KEY: "tvly-xxx" } };
    expect(isToolEnabled("webSearch")).toBe(true);
    expect(isToolEnabled("webFetch")).toBe(true);
  });

  it("只有旧数据里的开关、没有 key → 仍然不可用（开关不再是生效依据）", () => {
    settings = { builtinTools: { webSearch: true, webFetch: true, vision: true } };
    expect(isToolEnabled("webSearch")).toBe(false);
    expect(isToolEnabled("webFetch")).toBe(false);
    expect(isToolEnabled("vision")).toBe(false);
  });

  it("图片识别同理：有 key 即启用；只写空白不算（否则工具会注册出来、调用时才失败）", () => {
    settings = { apiKeys: { VISION_API_KEY: "sk-x" } };
    expect(isToolEnabled("vision")).toBe(true);

    settings = { apiKeys: { VISION_API_KEY: "   " } };
    expect(isToolEnabled("vision")).toBe(false);
    settings = { apiKeys: {} };
    expect(isToolEnabled("vision")).toBe(false);
  });

  it("搜网与识图互不牵连：只有 Tavily key 时识图仍不可用", () => {
    settings = { apiKeys: { TAVILY_API_KEY: "tvly-xxx" } };
    expect(isToolEnabled("vision")).toBe(false);
  });
});
