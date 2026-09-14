import { describe, expect, it } from "vitest";
import { dependencyToolInternals } from "./dependency-tool";

describe("受管理依赖安装", () => {
  it("包名始终作为单个 shell 参数，不能注入命令", () => {
    const command = dependencyToolInternals.installCommand("npm", ["a; touch /tmp/pwn", "@scope/pkg@1"], "project", true, "/work");
    expect(command).toBe("npm install --save-dev 'a; touch /tmp/pwn' '@scope/pkg@1'");
  });

  it("用户级安装使用包管理器的用户范围", () => {
    expect(dependencyToolInternals.installCommand("cargo", ["cargo-edit"], "user", false, "/work"))
      .toBe("cargo install 'cargo-edit'");
    expect(dependencyToolInternals.installCommand("mise", ["node@22"], "user", false, "/work"))
      .toBe("mise use --global 'node@22'");
  });

  it("拒绝空列表和换行参数", () => {
    expect(() => dependencyToolInternals.packageArgs([])).toThrow("至少提供");
    expect(() => dependencyToolInternals.packageArgs(["ok\nevil"])).toThrow("格式无效");
  });
});
