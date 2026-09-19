import { afterEach, describe, expect, it } from "vitest";
import { mkdtempSync, mkdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { productToolDenial } from "./product-workflow-policy";

const dirs: string[] = [];
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });

describe("产品计划的预开发工具边界", () => {
  it("keeps draft research available while refusing old coding and approval bypass tools", () => {
    const project = mkdtempSync(join(tmpdir(), "em-policy-"));
    dirs.push(project);
    expect(productToolDenial("draft", project, "web_search", { query: "examples" })).toBeNull();
    expect(productToolDenial("draft", project, "save_product_draft", {})).toBeNull();
    expect(productToolDenial("draft", project, "todo_write", { todos: [] })).toBeNull();
    for (const tool of ["write", "edit", "bash", "task", "show_confirm_dev", "mcp__unknown__write"]) {
      expect(productToolDenial("draft", project, tool, { path: "app.ts" })).toBeTruthy();
    }
  });

  it("allows only real prototype paths and refuses symlink escapes", () => {
    const base = mkdtempSync(join(tmpdir(), "em-policy-"));
    dirs.push(base);
    const project = join(base, "project");
    const prototype = join(project, "prototype");
    mkdirSync(prototype, { recursive: true });
    const outside = join(base, "outside.html");
    writeFileSync(outside, "outside");
    const link = join(prototype, "linked.html");
    symlinkSync(outside, link);
    expect(productToolDenial("scope_confirmed", project, "write", { path: join(prototype, "index.html") })).toBeNull();
    expect(productToolDenial("scope_confirmed", project, "write", { path: outside })).toBeTruthy();
    expect(productToolDenial("scope_confirmed", project, "edit", { path: link })).toBeTruthy();
    expect(productToolDenial("scope_confirmed", project, "bash", { command: "touch prototype/index.html" })).toBeTruthy();
  });
});
