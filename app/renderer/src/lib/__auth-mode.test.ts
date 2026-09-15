/**
 * 「只显示供应商真正支持的认证方式」的判据守卫。
 *
 * 背景（2026-09-15 实测）：设置页对**任何**支持账号登录的供应商都两档全渲染，且默认落在
 * 「API Key」——选中 OpenAI Codex（引擎里它只声明了 oauth、没有 apiKey）会看到一个 `sk-...`
 * 输入框，填了也没用，保存还会把 `authType: "api_key"` 写进配置。
 */
import { describe, expect, it } from "vitest";
import { authModeView } from "./auth-mode";

describe("认证方式档位", () => {
  it("两种都支持：给分段，并尊重用户选择", () => {
    const cap = { supportsOAuth: true, supportsApiKey: true };
    expect(authModeView(cap, "oauth")).toEqual({ showSegment: true, effectiveAuthType: "oauth" });
    expect(authModeView(cap, "api_key")).toEqual({ showSegment: true, effectiveAuthType: "api_key" });
  });

  it("只支持账号登录（OpenAI Codex）：不给分段，强制 oauth——表单里残留的 api_key 必须被覆盖", () => {
    const cap = { supportsOAuth: true, supportsApiKey: false };
    expect(authModeView(cap, "api_key")).toEqual({ showSegment: false, effectiveAuthType: "oauth" });
    expect(authModeView(cap, "oauth")).toEqual({ showSegment: false, effectiveAuthType: "oauth" });
  });

  it("只支持 API Key（OpenAI / DeepSeek 等）：不给分段，也不进账号登录界面", () => {
    const cap = { supportsOAuth: false, supportsApiKey: true };
    expect(authModeView(cap, "oauth")).toEqual({ showSegment: false, effectiveAuthType: "api_key" });
    expect(authModeView(cap, "api_key")).toEqual({ showSegment: false, effectiveAuthType: "api_key" });
  });

  it("两者都不支持（异常数据）：退化为 API Key 档，不渲染分段", () => {
    expect(authModeView({ supportsOAuth: false, supportsApiKey: false }, "oauth"))
      .toEqual({ showSegment: false, effectiveAuthType: "api_key" });
  });
});
