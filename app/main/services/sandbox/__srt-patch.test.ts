import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";

/**
 * sandbox-runtime 补丁的守卫（补丁在 postinstall 应用，`npm ci` 时自动生效）。
 *
 * 重点守的是「根路径 allowWrite 判定」这条：
 * 上游实现 `candidatePath.startsWith(allowedPath + '/')` 在 allowedPath === "/" 时拼出 "//"，
 * 判定恒 false → EM 在「完全访问」模式下传的 allowWrite: ["/"] 会让**整张 denyWrite 表被跳过**
 * （srt 日志：Skipping deny path not within allowed paths），受保护路径在 shell 命令下全部可写。
 *
 * 测试不只看字符串：把 dist 里的判定函数原文抽出来编译后按真实语义测——
 * 这样"补丁被上游结构变化挤掉"或"改错语义"都会红。
 */
const SRT_SANDBOX_DIR = path.join(process.cwd(), "node_modules", "@anthropic-ai", "sandbox-runtime", "dist", "sandbox");
const LINUX_FILE = path.join(SRT_SANDBOX_DIR, "linux-sandbox-utils.js");
const MAC_FILE = path.join(SRT_SANDBOX_DIR, "macos-sandbox-utils.js");

/** 抽出 dist 里的 isWithinAnyAllowedWritePath 并编译成可调用的判定 */
function compileIsWithinAllowedWrite(allowedWritePaths: string[]): (candidate: string) => boolean {
  const source = fs.readFileSync(LINUX_FILE, "utf-8");
  const matched = source.match(/const isWithinAnyAllowedWritePath = ([\s\S]*?);\n/);
  if (!matched) throw new Error("dist 里找不到 isWithinAnyAllowedWritePath（上游结构变化？）");
  const factory = new Function("allowedWritePaths", `return ${matched[1]};`) as (a: string[]) => (c: string) => boolean;
  return factory(allowedWritePaths);
}

describe("sandbox-runtime 补丁", () => {
  it("根路径 allowWrite 修复已应用：\"/\" 覆盖一切绝对路径（这正是完全访问模式的取值）", () => {
    const within = compileIsWithinAllowedWrite(["/"]);
    expect(within("/home/u/.easymint/mcp.json")).toBe(true);
    expect(within("/etc/passwd")).toBe(true);
    expect(within("/")).toBe(true);
  });

  it("修复未改变具体目录的语义（标准模式那一侧不能被带坏）", () => {
    const within = compileIsWithinAllowedWrite(["/workspace", path.join(os.tmpdir(), "rt")]);
    expect(within("/workspace/a/b")).toBe(true);
    expect(within("/workspace")).toBe(true);
    expect(within(path.join(os.tmpdir(), "rt", "home"))).toBe(true);
    expect(within("/etc/passwd")).toBe(false);
    // 前缀相似但不是子路径：不能误判为"在内"
    expect(within("/workspacex/a")).toBe(false);
  });

  it("mandatory deny 的补丁仍在（可执行配置的保护不能被连带丢掉）", () => {
    const linux = fs.readFileSync(LINUX_FILE, "utf-8");
    const mac = fs.readFileSync(MAC_FILE, "utf-8");
    for (const source of [linux, mac]) {
      expect(source).toContain("// EasyMint: retain executable configuration protections.");
    }
    for (const name of [".mcp.json", ".gitconfig", ".bashrc", ".ripgreprc"]) {
      expect(linux).toContain(name);
    }
  });

  it("未修复的写法不应再出现在 dist 里", () => {
    expect(fs.readFileSync(LINUX_FILE, "utf-8")).not.toContain("allowedPath => candidatePath.startsWith(allowedPath + '/') ||");
  });
});
