import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * 执行环境的守卫（2026-09-17，独立评估发现的 A/B 两条缺陷）。
 *
 * 背景：把标准档的 OS 沙盒关掉时，`bash` 的 `execTarget` 曾被初始化成**裸命令字符串**，
 * 只有进 sandboxed 分支才替换成带 env 的规格 ⇒ `resolveSpawn` 落回宿主 `process.env`
 * ⇒ 标准档的运行区隔离（HOME / TMPDIR / 包缓存重定向）**整体失效**。
 * 同时前台执行用 `{ ...process.env, ...opts.env }` 组合环境，而**删键 ≠ 覆盖**，
 * 被 `cleanEnvironment` 过滤掉的 `BASH_ENV` 等会从宿主**回填**。
 *
 * 本文件钉住两条不变量：
 *   ① 组合环境时**绝不**回填宿主 `process.env`（删掉的变量必须保持删除）
 *   ② 执行目标一律携带编译后环境（`wrapForSandbox` 两条分支都带 env；依赖工具的映射不丢 env）
 *
 * 另有一条**在类型层**：`executeForeground` 只接受 `ExecutionTarget`（不再接受裸字符串），
 * `execTarget` 也由它约束 —— 任何"关沙盒顺手传裸命令"的回归都会直接被 `tsc` 拦住。
 */
const { wrapCalls } = vi.hoisted(() => ({ wrapCalls: [] as string[] }));
vi.mock("@anthropic-ai/sandbox-runtime", () => ({
  SandboxManager: {
    initialize: async () => { /* 本文件只关心规格里带不带 env */ },
    wrapWithSandbox: async (command: string) => { wrapCalls.push(command); return `SANDBOXED(${command})`; },
    cleanupAfterCommand: () => { /* 无占位文件 */ },
    reset: async () => { /* 测试不需要 */ },
  },
}));

import { composeExecutionEnvironment } from "./tool";
import { wrapForSandbox } from "../sandbox/manager";
import { createExecutionContext } from "../permission/execution-context";
import { dependencyToolInternals } from "../tools/dependency-tool";

const WS = path.join(process.cwd(), "temp", "execution-env-test");
const HOST_ONLY = "BASH_ENV";

describe("执行环境不被宿主回填（缺陷 B）", () => {
  beforeEach(() => { process.env[HOST_ONLY] = "/host/bash_env"; });
  afterEach(() => { delete process.env[HOST_ONLY]; });

  it("baseEnv 里没有的变量，即使宿主有也不能出现", () => {
    const compiled = { HOME: "/runtime/home", PATH: "/runtime/bin" };
    const env = composeExecutionEnvironment(compiled);
    expect(env[HOST_ONLY]).toBeUndefined();
    expect(env.HOME).toBe("/runtime/home");
    expect(env.PATH).toBe("/runtime/bin");
  });

  it("注入 PI_* 之后仍然不带宿主变量（PI_* 是唯一允许追加的来源）", () => {
    const ctx = {
      model: { provider: "anthropic", id: "claude-x" },
      thinkingLevel: "high",
      sessionManager: { getSessionId: () => "sid-1", getSessionFile: () => "/s.jsonl" },
    };
    const env = composeExecutionEnvironment({ HOME: "/runtime/home" }, ctx);
    expect(env.PI_SESSION_ID).toBe("sid-1");
    expect(env.PI_SESSION_FILE).toBe("/s.jsonl");
    expect(env.PI_PROVIDER).toBe("anthropic");
    expect(env.PI_MODEL).toBe("claude-x");
    expect(env.PI_REASONING_LEVEL).toBe("high");
    expect(env.HOME).toBe("/runtime/home");
    expect(env[HOST_ONLY]).toBeUndefined();
  });

  it("ctx 缺失时只复制 baseEnv，不引入任何宿主变量", () => {
    const env = composeExecutionEnvironment({ HOME: "/runtime/home" });
    expect(env).toEqual({ HOME: "/runtime/home" });
  });
});

describe("执行目标一律携带编译后环境（缺陷 A）", () => {
  it("三档都返回 context.environment（不依赖「是否进沙盒」——甲方案让标准档套沙盒后依然成立）", async () => {
    for (const mode of ["readonly", "standard", "full"] as const) {
      const context = createExecutionContext(WS, mode);
      const spec = await wrapForSandbox("echo hi", { context });
      expect(spec.env, mode).toBe(context.environment);
    }
  });

  it("依赖工具的规格映射不丢 env（它曾是「关沙盒分支传裸字符串」的现场）", () => {
    const env = { HOME: "/runtime/home" };
    const fromShell = dependencyToolInternals.executionTarget({ kind: "shell", command: "npm i", env });
    expect("command" in fromShell && fromShell.env).toBe(env);
    const fromArgv = dependencyToolInternals.executionTarget({ kind: "argv", argv: ["/bin/sh", "-c", "npm i"], env });
    expect("argv" in fromArgv && fromArgv.env).toBe(env);
  });
});
