import { describe, expect, it, vi } from "vitest";

vi.mock("electron", () => ({ app: { isPackaged: false } }));

import { createEnhancedBashTool } from "./tool";
import { sandboxGitBashPath } from "./registry";

describe("前台 bash 增量输出", () => {
  it("Windows 受保护调用使用探测到的 Git Bash", () => {
    expect(sandboxGitBashPath("win32", () => "C:\\Program Files\\Git\\bin\\bash.exe"))
      .toBe("C:\\Program Files\\Git\\bin\\bash.exe");
    expect(sandboxGitBashPath("darwin", () => "unused")).toBeUndefined();
  });

  it("执行中经 onUpdate 推送 stdout", async () => {
    const tool = await createEnhancedBashTool(process.cwd());
    const updates: string[] = [];
    const onUpdate = (partial: { content: Array<{ type: string; text: string }> }): void => {
      updates.push(partial.content.map((c) => c.text).join(""));
    };
    const res = await (tool as unknown as {
      execute: (id: string, p: Record<string, unknown>, s: undefined, u: typeof onUpdate, ctx: unknown) => Promise<{ content: Array<{ text: string }> }>;
    }).execute("id1", { command: "echo hello-em-live" }, undefined, onUpdate, {});
    expect(updates.join("")).toContain("hello-em-live");
    expect(res.content[0]!.text).toContain("hello-em-live");
  }, 60_000);
});
