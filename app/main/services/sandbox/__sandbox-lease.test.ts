import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { createExecutionContext } from "../permission/execution-context";

/**
 * 沙盒命令收尾租约（spec.release）的守卫。
 *
 * 背景：Linux 上 bwrap 为「不存在的受保护路径」做 --ro-bind 时会在宿主创建 0 字节占位文件当挂载点，
 * srt 为此提供 cleanupAfterCommand()，并要求「每条沙盒命令结束后调用一次」。EM 的四条执行路径
 * （前台 bash / 后台 shell / shell:exec / install_dependency）本来就都在命令结束时调 spec.release()，
 * 但 wrapForSandbox 此前没给它赋值 → 清理链路空转。本文件钉住两件事：
 *   ① spec.release 必须存在（漏赋值就会退化成"调 undefined"）
 *   ② 同一租约只清理一次（多减 srt 的 activeSandboxCount 会提前删掉并发沙盒的挂载点 → deny 失效）
 *
 * mock 掉 srt，所以本机（macOS，跑不了真沙盒）也能跑，且不需要 bwrap。
 * 顶层 await 在 main 的 tsconfig 下不被允许（TS1378），故用静态 import + vi.hoisted（对齐 __paths.test.ts）。
 */
const { cleanupCalls } = vi.hoisted(() => ({ cleanupCalls: [] as string[] }));
vi.mock("@anthropic-ai/sandbox-runtime", () => ({
  SandboxManager: {
    wrapWithSandbox: async (command: string) => command,
    cleanupAfterCommand: () => { cleanupCalls.push("cleanup"); },
    reset: async () => { /* 测试不需要 */ },
  },
}));

import { sandboxLeaseInternals, wrapForSandbox } from "./manager";

// 租约只属于**沙盒路径**，而沙盒现在只在「只读模式」下启用（见 manager.isSandboxEnabledForMode）——
// 本文件因此用 restricted 档跑；标准/完全访问走原生执行，没有租约（见 __full-mode-native.test.ts）。
const context = () => createExecutionContext(path.join(process.cwd(), "temp", "lease-test"), "readonly");

describe("沙盒收尾租约", () => {
  it("wrapForSandbox 必须给出 release —— 否则四条执行路径都在调 undefined", async () => {
    const spec = await wrapForSandbox("echo hi", { context: context() });
    expect(typeof spec.release).toBe("function");
  });

  it("调用 release 会真的触发 srt 的 cleanupAfterCommand", async () => {
    const spec = await wrapForSandbox("echo hi", { context: context() });
    const before = cleanupCalls.length;
    await spec.release?.();
    expect(cleanupCalls.length).toBe(before + 1);
  });

  it("release 幂等：调三次也只清理一次（多减计数会让并发沙盒的 deny 规则提前失效）", async () => {
    const spec = await wrapForSandbox("echo hi", { context: context() });
    const before = cleanupCalls.length;
    await spec.release?.();
    await spec.release?.();
    await spec.release?.();
    expect(cleanupCalls.length).toBe(before + 1);
  });

  it("每次 wrap 各自一份租约（互不影响）：两个 spec 各清一次", async () => {
    const a = await wrapForSandbox("echo a", { context: context() });
    const b = await wrapForSandbox("echo b", { context: context() });
    expect(a.release).not.toBe(b.release);
    const before = cleanupCalls.length;
    await a.release?.();
    await b.release?.();
    expect(cleanupCalls.length).toBe(before + 2);
  });

  it("清理本身抛错不影响命令结果（占位文件残留只是脏，不该让命令失败）", async () => {
    const lease = sandboxLeaseInternals.createOnceLease(() => { throw new Error("cleanup boom"); });
    await expect(lease()).resolves.toBeUndefined();
    // 抛错了也算"已释放"，不会无限重试
    let calls = 0;
    const lease2 = sandboxLeaseInternals.createOnceLease(() => { calls += 1; });
    await lease2();
    await lease2();
    expect(calls).toBe(1);
  });
});
