import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  buildExecutionPolicy,
  accessPolicyInternals,
  canonicalPolicyPath,
  isWithin,
  isStandardWritableTarget,
  protectedControlPaths,
  protectedCredentialPaths,
  protectedWriteRoots,
} from "./access-policy";
import { developmentRuntimeFor, developmentRuntimesRoot } from "./development-runtime";
import type { ExecutionContext } from "./execution-context";

describe("统一资源策略", () => {
  const cwd = path.join(os.homedir(), "dev", "project");

  const context = (mode: "standard" | "full"): ExecutionContext => ({
    mode,
    workspaceRealPath: path.resolve(cwd),
    runtimeRoot: path.join(os.homedir(), ".easymint", "runtimes", "test-runtime"),
    environment: {},
    policyVersion: "2",
  });

  it("标准模式只允许工作区和当前开发运行区写入", () => {
    const filesystem = buildExecutionPolicy(context("standard")).filesystem!;
    expect(filesystem.allowWrite).toEqual([path.resolve(cwd), context("standard").runtimeRoot]);
    expect(filesystem.allowWrite).not.toContain(path.resolve(os.tmpdir()));
    expect(filesystem.allowWrite).not.toContain(path.join(os.homedir(), ".npm"));
    expect(filesystem.denyRead).toContain(developmentRuntimesRoot());
    expect(filesystem.allowRead).toContain(context("standard").runtimeRoot);
  });

  it("完全访问扩大 allowWrite，但保留相同核心 deny", () => {
    const standard = buildExecutionPolicy(context("standard")).filesystem!;
    const full = buildExecutionPolicy(context("full")).filesystem!;
    expect(full.allowWrite).toContain(process.platform === "win32" ? path.parse(os.homedir()).root : "/");
    expect(standard.denyWrite).toEqual(expect.arrayContaining(full.denyWrite ?? []));
    expect(standard.denyWrite).toContain(path.join(os.homedir(), ".npm", "_logs"));
    expect(full.denyRead).toEqual(protectedCredentialPaths());
  });

  it("Windows 完全访问始终包含当前工作区所在卷", () => {
    expect(accessPolicyInternals.filesystemRoots("D:\\work\\demo", "win32")).toContain("D:\\");
    expect(accessPolicyInternals.filesystemRoots("D:\\work\\demo", "win32", ["E:\\"])).toContain("E:\\");
    expect(accessPolicyInternals.windowsVolumeMetadataPaths(["D:\\", "E:\\"], "win32"))
      .toEqual(expect.arrayContaining(["D:\\System Volume Information", "D:\\$Recycle.Bin", "E:\\System Volume Information"]));
  });

  it("/tmp 和用户文档不属于核心写保护", () => {
    const protectedRoots = protectedWriteRoots();
    expect(protectedRoots).not.toContain("/tmp");
    expect(protectedRoots).not.toContain(path.join(os.homedir(), "Desktop"));
  });

  it("凭据读写保护独立于普通用户目录", () => {
    const credentials = protectedCredentialPaths();
    expect(credentials).toContain(path.join(os.homedir(), ".ssh"));
    expect(credentials).not.toContain(path.join(os.homedir(), "Documents"));
    expect(credentials).toContain(path.join(os.homedir(), ".easymint", "em-settings.json"));
    expect(credentials).toContain(path.join(os.homedir(), ".easymint", ".control-tmp"));
    expect(credentials).toContain(path.join(os.homedir(), ".zshrc"));
    expect(credentials).toContain(path.join(os.homedir(), ".curlrc"));
    expect(credentials).toContain(path.join(os.homedir(), ".wgetrc"));
  });

  it("EasyMint 权限状态与可执行配置属于写保护控制面", () => {
    const controls = protectedControlPaths(cwd);
    expect(controls).toContain(path.join(os.homedir(), ".easymint", "session-cache"));
    expect(controls).toContain(path.join(cwd, ".easymint", "mcp.json"));
    expect(controls).toContain(path.join(cwd, ".mcp.json"));
    expect(controls).not.toContain(path.join(os.homedir(), ".easymint", "skills"));
    expect(protectedControlPaths(cwd, "win32")).toContain(path.win32.join(
      process.env.APPDATA || path.win32.join(os.homedir(), "AppData", "Roaming"),
      "Microsoft", "Windows", "Start Menu", "Programs", "Startup",
    ));
  });

  it("路径包含关系在折叠 .. 后判定", () => {
    const root = canonicalPolicyPath(cwd, cwd);
    expect(isWithin(root, canonicalPolicyPath(path.join(cwd, "src", "a.ts"), cwd))).toBe(true);
    expect(isWithin(root, canonicalPolicyPath(path.join(cwd, "..", "outside.ts"), cwd))).toBe(false);
  });

  it("标准模式的显式文件工具只可写工作区和本项目运行区", () => {
    expect(isStandardWritableTarget(cwd, path.join(cwd, "src", "a.ts"))).toBe(true);
    expect(isStandardWritableTarget(cwd, path.join(developmentRuntimeFor(cwd).root, "cache", "x"))).toBe(true);
    expect(isStandardWritableTarget(cwd, path.join(developmentRuntimesRoot(), "other-runtime", "x"))).toBe(false);
  });
});
