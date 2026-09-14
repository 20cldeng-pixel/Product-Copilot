import { describe, expect, it } from "vitest";
import { environmentToolInternals } from "./environment-tool";

describe("受管理环境变量", () => {
  it("shell 值按字面量转义，不能闭合引号注入命令", () => {
    expect(environmentToolInternals.shellLiteral("a'b; $(touch x)")).toBe("'a'\"'\"'b; $(touch x)'");
    expect(environmentToolInternals.parseManagedEnvironment(
      `export SAFE=${environmentToolInternals.shellLiteral("a'b; $(touch x)")}\nsource /tmp/evil\n`,
    )).toEqual({ SAFE: "a'b; $(touch x)" });
  });

  it("更新同名项且保留注释和其他变量", () => {
    const input = "# keep\nA=old\nB=value\n";
    expect(environmentToolInternals.updateKeyValue(input, "A", "new", (k, v) => `${k}=${v}`))
      .toBe("# keep\nB=value\nA=new\n");
  });

  it("移除变量不影响其他内容", () => {
    expect(environmentToolInternals.updateKeyValue("A=1\nB=2\n", "A", undefined, (k, v) => `${k}=${v}`))
      .toBe("B=2\n");
  });

  it("用户级持久化拒绝自动代码加载变量，但允许常用开发路径变量", () => {
    expect(environmentToolInternals.isDeniedUserVariable("NODE_OPTIONS")).toBe(true);
    expect(environmentToolInternals.isDeniedUserVariable("dyld_insert_libraries")).toBe(true);
    expect(environmentToolInternals.isDeniedUserVariable("PATH")).toBe(false);
    expect(environmentToolInternals.isDeniedUserVariable("JAVA_HOME")).toBe(false);
  });

  it("迁移时只移除旧 EasyMint shell 加载块", () => {
    const input = [
      "export KEEP=1",
      "# >>> EasyMint managed environment >>>",
      '[ -f "$HOME/.easymint/environment.sh" ] && . "$HOME/.easymint/environment.sh"',
      "# <<< EasyMint managed environment <<<",
      "alias ll='ls -l'",
      "",
    ].join("\n");
    expect(environmentToolInternals.stripLegacyManagedHook(input)).toBe("export KEEP=1\nalias ll='ls -l'\n");
  });
});
