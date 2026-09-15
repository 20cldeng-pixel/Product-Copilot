/**
 * 「认证方式」该显示哪几档 —— 纯函数，便于单测（表单只负责渲染）。
 *
 * 规则：**只显示该供应商真正支持的接入方式**。
 * - 两种都支持（Anthropic / xAI / Kimi Coding / GitHub Copilot / OpenRouter）→ 给分段，用户自选；
 * - 只支持账号登录（OpenAI Codex）→ 不给分段，直接按账号登录渲染。
 *   此前分段照常两档全渲染、且默认落在「API Key」，于是给一个**填了也没用**的密钥输入框
 *   （该 provider 的 auth 声明里根本没有 apiKey），保存还会把 `authType: "api_key"` 写进去；
 * - 只支持 API Key（OpenAI / DeepSeek / 智谱等）→ 整段不出现（沿用原行为）。
 *
 * 注意 `effectiveAuthType` 必须**覆盖表单里的旧选择**：切换预设不会重置表单内状态，
 * 从一个支持账号登录的供应商切到只能账号登录的（或反之）时，旧选择会残留。
 */

import type { ProviderAuthType } from "@shared/provider-auth";

export interface AuthCapability {
  /** SDK 声明支持账号登录 */
  supportsOAuth: boolean;
  /** SDK 声明支持 API Key */
  supportsApiKey: boolean;
}

export interface AuthModeView {
  /** 是否渲染「认证方式」分段：两种都支持才有得选 */
  showSegment: boolean;
  /** 实际生效的档位 */
  effectiveAuthType: ProviderAuthType;
}

export function authModeView(capability: AuthCapability, chosen: ProviderAuthType): AuthModeView {
  if (capability.supportsOAuth && capability.supportsApiKey) {
    return { showSegment: true, effectiveAuthType: chosen };
  }
  if (capability.supportsOAuth) return { showSegment: false, effectiveAuthType: "oauth" };
  return { showSegment: false, effectiveAuthType: "api_key" };
}
