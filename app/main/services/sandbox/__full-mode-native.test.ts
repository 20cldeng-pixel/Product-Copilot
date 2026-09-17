import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { createExecutionContext } from "../permission/execution-context";

/**
 * 完全访问 = 不进沙盒（2026-09-16 用户拍板）的守卫。
 *
 * 为什么必须绕过沙盒而不是"放宽 profile"：srt 的 mac seatbelt profile 是 deny-default 白名单，
 * 进程/信号、Apple Events、Mach IPC 全在名单外 —— 完全访问下依然杀不掉别的命令启动的进程、
 * `open` 打不开浏览器。更硬的一条：**Chromium 只要身处任何 seatbelt 沙盒内就起不来**
 * （子进程 apply 自己的沙盒时 `sandbox initialization failed: Operation not permitted`，
 * 实测三组对照：裸跑崩 / `(allow default)` 沙盒跑普通命令正常 / 加 `--no-sandbox` 后正常），
 * 所以 Playwright 在沙盒里恒不可用，"套一层宽松沙盒"也救不了。
 *
 * 本文件钉住：
 *   ① full 模式不调 srt（wrapWithSandbox / initialize 都不碰）→ 命令原样执行
 *   ② full 模式没有租约（没有 seatbelt/bwrap 就没有 ghost 占位文件要清）
 *   ③ standard 模式仍然进沙盒（防止"顺手把沙盒关掉"这类回退）
 *
 * mock 掉 srt，所以本机（macOS，跑不了真沙盒）能跑。
 */
const { wrapCalls, initCalls } = vi.hoisted(() => ({
  wrapCalls: [] as string[],
  initCalls: [] as unknown[],
}));
vi.mock("@anthropic-ai/sandbox-runtime", () => ({
  SandboxManager: {
    initialize: async (cfg: unknown) => { initCalls.push(cfg); },
    wrapWithSandbox: async (command: string) => { wrapCalls.push(command); return `SANDBOXED(${command})`; },
    cleanupAfterCommand: () => { /* 本文件只关心"有没有进沙盒" */ },
    reset: async () => { /* 测试不需要 */ },
  },
}));

import { ensureSandbox, isSandboxBypassed, isSandboxBypassedForMode, isSandboxEnabledForMode, wrapForSandbox } from "./manager";

const WS = path.join(process.cwd(), "temp", "full-mode-native-test");
const full = () => createExecutionContext(WS, "full");
const standard = () => createExecutionContext(WS, "standard");

describe("完全访问不进沙盒", () => {
  it("命令原样执行：不调 srt 的 wrapWithSandbox，也不出现 sandbox-exec", async () => {
    const before = wrapCalls.length;
    const spec = await wrapForSandbox("npm run dev", { context: full() });
    expect(wrapCalls.length).toBe(before);
    expect(spec.kind).toBe("shell");
    if (spec.kind !== "shell") throw new Error("非 Windows 应返回 shell 形态");
    expect(spec.command).toBe("npm run dev");
    expect(spec.command).not.toContain("sandbox-exec");
  });

  it("没有收尾租约（没有沙盒就没有占位文件要清）", async () => {
    const spec = await wrapForSandbox("echo hi", { context: full() });
    expect(spec.release).toBeUndefined();
  });

  it("用宿主环境执行，不做标准模式的 HOME/PATH 运行区重定向", async () => {
    const spec = await wrapForSandbox("echo hi", { context: full() });
    expect(spec.env.HOME).toBe(process.env.HOME);
  });

  it("沙盒未启用时 ensureSandbox 不初始化 srt（不会因初始化失败而 fail-closed 拒绝命令）", async () => {
    const before = initCalls.length;
    expect((await ensureSandbox(WS, "full")).ok).toBe(true);
    expect((await ensureSandbox(WS, "standard")).ok).toBe(true);
    expect(initCalls.length).toBe(before);
  });

  it("受限模式走沙盒：wrapWithSandbox 被调用、带租约、且会初始化 srt", async () => {
    const beforeWrap = wrapCalls.length;
    const spec = await wrapForSandbox("echo hi", { context: createExecutionContext(WS, "restricted") });
    expect(wrapCalls.length).toBe(beforeWrap + 1);
    expect(typeof spec.release).toBe("function");
    if (spec.kind !== "shell") throw new Error("非 Windows 应返回 shell 形态");
    expect(spec.command).toContain("SANDBOXED");

    const beforeInit = initCalls.length;
    await ensureSandbox(WS, "restricted");
    expect(initCalls.length).toBe(beforeInit + 1);
  });

  it("标准模式默认也原生执行；只有打开回退开关才进沙盒（沙盒分支没被删）", async () => {
    const before = wrapCalls.length;
    const native = await wrapForSandbox("echo hi", { context: standard() });
    expect(wrapCalls.length).toBe(before);
    expect(native.release).toBeUndefined();

    process.env.EASYMINT_SANDBOX_ENABLED = "1";
    try {
      const sandboxed = await wrapForSandbox("echo hi", { context: standard() });
      expect(wrapCalls.length).toBe(before + 1);
      expect(typeof sandboxed.release).toBe("function");
      if (sandboxed.kind !== "shell") throw new Error("非 Windows 应返回 shell 形态");
      expect(sandboxed.command).toContain("SANDBOXED");
    } finally {
      delete process.env.EASYMINT_SANDBOX_ENABLED;
    }
  });

  it("isSandboxEnabledForMode：只有受限模式默认开；标准档可用环境变量应急打开；完全访问永远不套", () => {
    expect(isSandboxEnabledForMode("restricted")).toBe(true);
    expect(isSandboxBypassedForMode("restricted")).toBe(false);
    expect(isSandboxBypassedForMode("standard")).toBe(true);
    expect(isSandboxBypassedForMode("full")).toBe(true);
    process.env.EASYMINT_SANDBOX_ENABLED = "1";
    try {
      expect(isSandboxEnabledForMode("standard")).toBe(true);
      expect(isSandboxEnabledForMode("full")).toBe(false);
      expect(isSandboxBypassedForMode("standard")).toBe(isSandboxBypassed());
      expect(isSandboxBypassedForMode("full")).toBe(true);
    } finally {
      delete process.env.EASYMINT_SANDBOX_ENABLED;
    }
  });
});
