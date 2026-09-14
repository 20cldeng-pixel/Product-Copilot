import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { ensureSandbox, resetSandboxForTest, wrapForSandbox } from "./manager";
import { createExecutionContext } from "../permission/execution-context";

describe("执行策略真实 I/O", () => {
  const root = path.join(process.cwd(), `.sandbox-policy-${process.pid}`);
  const workspace = path.join(root, "workspace");
  const outside = path.join(root, "outside.txt");

  beforeAll(() => {
    fs.mkdirSync(workspace, { recursive: true });
  });

  afterAll(async () => {
    fs.rmSync(root, { recursive: true, force: true });
    await resetSandboxForTest();
  });

  function run(command: string, env?: NodeJS.ProcessEnv): ReturnType<typeof spawnSync> {
    return spawnSync(command, { cwd: workspace, shell: true, env, encoding: "utf8", timeout: 30_000 });
  }

  it("标准模式由 OS 沙盒阻止工作区外写入，完全访问允许同一普通目标", async () => {
    const initialized = await ensureSandbox(workspace);
    expect(initialized).toEqual({ ok: true });

    const standardContext = createExecutionContext(workspace, "standard", {}, path.join(root, "runtimes"));
    const standard = await wrapForSandbox(`touch ${JSON.stringify(outside)}`, { context: standardContext });
    expect(standard.kind).toBe("shell");
    if (standard.kind !== "shell") return;
    const denied = run(standard.command, standard.env);
    expect(denied.status).not.toBe(0);
    expect(fs.existsSync(outside)).toBe(false);

    const runtimeWrite = await wrapForSandbox(`touch "$HOME/home-write" "$TMPDIR/tmp-write"`, { context: standardContext });
    expect(runtimeWrite.kind).toBe("shell");
    if (runtimeWrite.kind !== "shell") return;
    const runtimeAllowed = run(runtimeWrite.command, runtimeWrite.env);
    expect(runtimeAllowed.status, String(runtimeAllowed.stderr)).toBe(0);
    expect(fs.existsSync(path.join(standardContext.runtimeRoot, "home", "home-write"))).toBe(true);
    expect(fs.existsSync(path.join(standardContext.runtimeRoot, "tmp", "tmp-write"))).toBe(true);

    const full = await wrapForSandbox(`touch ${JSON.stringify(outside)}`, {
      context: createExecutionContext(workspace, "full", {}, path.join(root, "runtimes")),
    });
    expect(full.kind).toBe("shell");
    if (full.kind !== "shell") return;
    const allowed = run(full.command, full.env);
    expect(allowed.status, String(allowed.stderr)).toBe(0);
    expect(fs.existsSync(outside)).toBe(true);
  }, 60_000);

  it("标准模式允许开发服务器绑定本机端口", async () => {
    const initialized = await ensureSandbox(workspace);
    expect(initialized).toEqual({ ok: true });
    const wrapped = await wrapForSandbox(
      `node -e 'const s=require("net").createServer();s.listen(0,"127.0.0.1",()=>s.close())'`,
      { context: createExecutionContext(workspace, "standard", {}, path.join(root, "runtimes")) },
    );
    expect(wrapped.kind).toBe("shell");
    if (wrapped.kind !== "shell") return;
    const result = run(wrapped.command, wrapped.env);
    expect(result.status, String(result.stderr)).toBe(0);
  }, 60_000);

  it("标准模式在命令最内层使用项目运行区的 HOME、临时目录和 npm 缓存", async () => {
    const initialized = await ensureSandbox(workspace);
    expect(initialized).toEqual({ ok: true });
    const context = createExecutionContext(workspace, "standard", {}, path.join(root, "runtimes"));
    const wrapped = await wrapForSandbox(
      `printf '%s\\n' "$HOME" "$TMPDIR" "$(npm config get cache)" "$(npm config get prefix)"`,
      { context },
    );
    expect(wrapped.kind).toBe("shell");
    if (wrapped.kind !== "shell") return;
    const result = run(wrapped.command, wrapped.env);
    expect(result.status, String(result.stderr)).toBe(0);
    expect(String(result.stdout).trim().split("\n")).toEqual([
      path.join(context.runtimeRoot, "home"),
      path.join(context.runtimeRoot, "tmp"),
      path.join(context.runtimeRoot, "cache", "npm"),
      path.join(context.runtimeRoot, "tools", "npm"),
    ]);
  }, 60_000);

  it("标准模式完整读写工作区配置，不继承第三方按文件名硬编码的误拦", async () => {
    const initialized = await ensureSandbox(workspace);
    expect(initialized).toEqual({ ok: true });
    const context = createExecutionContext(workspace, "standard", {}, path.join(root, "runtimes"));
    const wrapped = await wrapForSandbox(
      "mkdir -p .vscode .idea .git/hooks && touch .vscode/settings.json .idea/workspace.xml .git/config .git/hooks/pre-commit",
      { context },
    );
    expect(wrapped.kind).toBe("shell");
    if (wrapped.kind !== "shell") return;
    const result = run(wrapped.command, wrapped.env);
    expect(result.status, String(result.stderr)).toBe(0);
    for (const relative of [".vscode/settings.json", ".idea/workspace.xml", ".git/config", ".git/hooks/pre-commit"]) {
      expect(fs.existsSync(path.join(workspace, relative))).toBe(true);
    }
  }, 60_000);

  it("两种模式都不能把工作区兼容 MCP 配置改造成后续可执行配置", async () => {
    const initialized = await ensureSandbox(workspace);
    expect(initialized).toEqual({ ok: true });
    const protectedFile = path.join(workspace, ".mcp.json");
    for (const mode of ["standard", "full"] as const) {
      const wrapped = await wrapForSandbox(
        `printf '%s' '{"mcpServers":{}}' > ${JSON.stringify(protectedFile)}`,
        { context: createExecutionContext(workspace, mode, {}, path.join(root, "runtimes")) },
      );
      expect(wrapped.kind).toBe("shell");
      if (wrapped.kind !== "shell") return;
      const result = run(wrapped.command, wrapped.env);
      expect(result.status).not.toBe(0);
      expect(fs.existsSync(protectedFile)).toBe(false);
    }
  }, 60_000);
});
