import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { developmentRuntimeFor, ensureDevelopmentRuntime, workspaceRuntimeId } from "./development-runtime";
import { createExecutionContext, executionContextInternals } from "./execution-context";

describe("项目开发运行区", () => {
  const tempRoots: string[] = [];
  afterEach(() => {
    for (const root of tempRoots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
  });

  function fixture(): { workspace: string; runtimes: string } {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "easymint-runtime-test-"));
    tempRoots.push(root);
    const workspace = path.join(root, "workspace");
    const runtimes = path.join(root, "private", "runtimes");
    fs.mkdirSync(workspace);
    fs.mkdirSync(path.dirname(runtimes), { recursive: true, mode: 0o700 });
    return { workspace, runtimes };
  }

  it("同一工作区得到稳定 ID，不同工作区彼此隔离", () => {
    const { workspace, runtimes } = fixture();
    expect(workspaceRuntimeId(workspace)).toBe(workspaceRuntimeId(path.join(workspace, ".")));
    expect(developmentRuntimeFor(workspace, runtimes).root)
      .not.toBe(developmentRuntimeFor(`${workspace}-other`, runtimes).root);
  });

  it("创建私有目录结构", () => {
    const { workspace, runtimes } = fixture();
    const runtime = ensureDevelopmentRuntime(workspace, runtimes);
    for (const directory of [runtime.root, runtime.home, runtime.cache, runtime.tmp, runtime.tools, runtime.config, runtime.state, runtime.logs]) {
      expect(fs.statSync(directory).isDirectory()).toBe(true);
      if (process.platform !== "win32") expect(fs.statSync(directory).mode & 0o777).toBe(0o700);
    }
  });

  it("标准模式重定向开发写入，完全访问保留宿主 HOME", () => {
    const { workspace, runtimes } = fixture();
    const standard = createExecutionContext(workspace, "standard", { NODE_OPTIONS: "--require evil", CUSTOM: "ok" }, runtimes);
    expect(standard.environment.HOME).toBe(path.join(standard.runtimeRoot, "home"));
    expect(standard.environment.TMPDIR).toBe(path.join(standard.runtimeRoot, "tmp"));
    expect(standard.environment.GRADLE_USER_HOME).toContain(standard.runtimeRoot);
    expect(standard.environment.NODE_OPTIONS).toBeUndefined();
    expect(standard.environment.CUSTOM).toBe("ok");

    const full = createExecutionContext(workspace, "full", { CUSTOM: "ok" }, runtimes);
    expect(full.environment.HOME).toBe(process.env.HOME);
    expect(full.environment.CUSTOM).toBe("ok");
  });

  it("识别会改变加载过程的危险环境变量", () => {
    expect(executionContextInternals.isUnsafeEnvironmentName("NODE_OPTIONS")).toBe(true);
    expect(executionContextInternals.isUnsafeEnvironmentName("path")).toBe(false);
  });
});
