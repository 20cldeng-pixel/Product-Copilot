/**
 * deb 后置脚本（`build/linux-after-install.sh`）的两道守卫。
 *
 * 这个脚本由 dpkg 以 **root** 执行，做的是「往 /etc/apparmor.d 落一份 AppArmor profile」
 * 这件事——它错了会很贵（让 dpkg 报安装失败、或覆盖系统自带的 profile），所以要有守卫：
 *
 * 1. **同步守卫**：文件前段必须与 electron-builder 内置模板
 *    `templates/linux/after-install.tpl` **逐字一致**。因为 `deb.afterInstall` 在
 *    electron-builder 里是"接管"而不是"追加"（`getResource()` 直接返回项目内路径），
 *    模板一旦升级而前段没跟着同步，就会**静默**丢掉「应用自身那份 AppArmor profile」
 *    等关键步骤。这里刻意让它失败得响一点。
 * 2. **行为守卫**：把追加段抽出来、把其中的绝对路径重定位到一个临时假根下执行，
 *    验证「不适用就跳过 / 幂等 / 该落就落并加载 / 任何情况都 exit 0」。
 *
 * 注意两处刻意的做法：
 * - 追加段用 `/bin/sh` 跑（不用 bash）：能过说明它不依赖 bash 专有语法。
 * - 不做"找不到 apparmor_parser"那条分支的用例：脚本里查找解析器时有一条
 *   `command -v` 兜底，能否命中取决于宿主 PATH，在 CI 上不可控；而脚本**刻意不接受**
 *   任何环境变量注入路径（postinst 以 root 跑，可注入路径＝任意 root 写），
 *   所以这里不为了可测性去放宽它，只断言"无论装没装解析器都 exit 0 且文件就位"。
 */
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";

// 仓库内文件用 cwd 定位（vitest 的 root 就是仓库根，项目里其它测试也是这个约定）
const SCRIPT = path.join(process.cwd(), "build/linux-after-install.sh");
const TEMPLATE = path.join(
  process.cwd(), "node_modules/app-builder-lib/templates/linux/after-install.tpl",
);

const BEGIN = "# >>> EasyMint bwrap-userns-profile (begin)";
const END = "# <<< EasyMint bwrap-userns-profile (end)";

const scriptText = fs.readFileSync(SCRIPT, "utf-8");

/** 追加段里出现过的真实 profile 源文件路径（Ubuntu 24.04 的 apparmor-profiles 包） */
const SRC = "usr/share/apparmor/extra-profiles/bwrap-userns-restrict";
const DEST = "etc/apparmor.d/bwrap-userns-restrict";
const ENABLED = "sys/module/apparmor/parameters/enabled";
const SYSCTL = "proc/sys/kernel/apparmor_restrict_unprivileged_userns";
const LOG = "var/log/easymint-apparmor.log";

const PROFILE_TEXT = [
  "abi <abi/4.0>,",
  "include <tunables/global>",
  "",
  "profile bwrap-userns-restrict /usr/bin/bwrap flags=(unconfined) {",
  "  userns,",
  "}",
  "",
].join("\n");

/** 把追加段里的绝对路径挂到临时假根下（脚本本身不读环境变量拿路径，只能这样重定位） */
function relocate(src: string, root: string): string {
  return src.replace(/\/(etc|usr|proc|sys|var)\//g, (_m, dir: string) => `${root}/${dir}/`);
}

interface FakeRoot {
  p(rel: string): string;
  write(rel: string, content: string, mode?: number): void;
  exists(rel: string): boolean;
  read(rel: string): string;
  /** 装一个假的 apparmor_parser：把收到的参数记进 parser-args，按 exitCode 退出 */
  installParser(exitCode: number): void;
  run(args?: string[]): { status: number | null };
}

function makeRoot(): FakeRoot {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "em-postinst-"));
  const block = scriptText.slice(scriptText.indexOf(BEGIN), scriptText.indexOf(END) + END.length);
  const file = path.join(root, "block.sh");
  fs.writeFileSync(file, relocate(block, root), "utf-8");
  // 真实系统上 /var/log 必然存在；脚本刻意不自己创建日志目录（多一处 root 写操作没必要）
  fs.mkdirSync(path.join(root, "var/log"), { recursive: true });

  const p = (rel: string): string => path.join(root, rel);
  const api: FakeRoot = {
    p,
    write(rel, content, mode) {
      fs.mkdirSync(path.dirname(p(rel)), { recursive: true });
      fs.writeFileSync(p(rel), content, "utf-8");
      if (mode !== undefined) fs.chmodSync(p(rel), mode);
    },
    exists: (rel) => fs.existsSync(p(rel)),
    read: (rel) => (fs.existsSync(p(rel)) ? fs.readFileSync(p(rel), "utf-8") : ""),
    installParser(exitCode) {
      api.write("usr/sbin/apparmor_parser", `#!/bin/sh\nprintf '%s\\n' "$*" >>"${p("parser-args")}"\nexit ${exitCode}\n`, 0o755);
    },
    run: (args = []) => {
      const r = spawnSync("/bin/sh", [file, ...args], { encoding: "utf-8" });
      return { status: r.status };
    },
  };
  return api;
}

/** 造一个"AppArmor 已启用 + userns 限制生效 + apparmor-profiles 已装 + 有解析器"的环境 */
function activeRoot(opts: { parser: number | null } = { parser: 0 }): FakeRoot {
  const r = makeRoot();
  r.write(ENABLED, "Y\n");
  r.write(SYSCTL, "1\n");
  r.write(SRC, PROFILE_TEXT);
  r.write("etc/apparmor.d/.keep", "");
  if (opts.parser !== null) r.installParser(opts.parser);
  return r;
}

describe("同步守卫：前段必须与 electron-builder 模板逐字一致", () => {
  it("begin 标记以上 == templates/linux/after-install.tpl", () => {
    const template = fs.readFileSync(TEMPLATE, "utf-8");
    const prefix = scriptText.slice(0, scriptText.indexOf(BEGIN));
    expect(
      prefix.trimEnd(),
      "deb.afterInstall 是「接管」而非「追加」：electron-builder 升级后必须把新模板同步到本文件前段，"
      + "否则会静默丢掉 /usr/bin/easymint 软链、chrome-sandbox 权限与应用自身那份 AppArmor profile",
    ).toBe(template.trimEnd());
  });

  it("追加段只有一个 begin / end 标记（抽取测试依赖这一点）", () => {
    expect(scriptText.split(BEGIN).length - 1).toBe(1);
    expect(scriptText.split(END).length - 1).toBe(1);
    expect(scriptText.indexOf(BEGIN)).toBeLessThan(scriptText.indexOf(END));
  });
});

describe("行为守卫：不适用就不动手", () => {
  it("AppArmor 未启用（enabled != Y）→ 不落 profile，exit 0", () => {
    const r = activeRoot();
    r.write(ENABLED, "N\n");
    expect(r.run().status).toBe(0);
    expect(r.exists(DEST)).toBe(false);
  });

  it("内核无 userns 限制（值为 0）→ 不落 profile，exit 0", () => {
    const r = activeRoot();
    r.write(SYSCTL, "0\n");
    expect(r.run().status).toBe(0);
    expect(r.exists(DEST)).toBe(false);
  });

  it("内核没有该开关（读不到）→ 不落 profile，exit 0", () => {
    const r = activeRoot();
    fs.rmSync(r.p(SYSCTL));
    expect(r.run().status).toBe(0);
    expect(r.exists(DEST)).toBe(false);
  });

  it("dpkg 回滚阶段（abort-upgrade）→ 什么都不做，exit 0", () => {
    const r = activeRoot();
    expect(r.run(["abort-upgrade"]).status).toBe(0);
    expect(r.exists(DEST)).toBe(false);
    expect(r.read("parser-args")).toBe("");
  });
});

describe("行为守卫：该落就落", () => {
  it("限制生效 + 模板在 → 落 profile 并 apparmor_parser -r 加载", () => {
    const r = activeRoot();
    expect(r.run().status).toBe(0);
    expect(r.read(DEST)).toBe(PROFILE_TEXT);
    expect(r.read("parser-args")).toContain(`-r ${r.p(DEST)}`);
    expect(r.read(LOG)).toContain("已加载");
  });

  it("幂等：目标已存在则跳过，不覆盖、不重复加载", () => {
    const r = activeRoot();
    r.write(DEST, "# 用户或系统自己改过的内容\n");
    expect(r.run().status).toBe(0);
    expect(r.read(DEST)).toBe("# 用户或系统自己改过的内容\n");
    expect(r.read("parser-args")).toBe(""); // 解析器一次都没被调用
  });

  it("模板缺失（apparmor-profiles 未装）→ 跳过并在日志里说明、exit 0", () => {
    const r = activeRoot();
    fs.rmSync(r.p(SRC));
    expect(r.run().status).toBe(0);
    expect(r.exists(DEST)).toBe(false);
    expect(r.read(LOG)).toContain("apparmor-profiles");
  });

  it("解析器失败 → 文件保留（重启后仍会被加载）、exit 0", () => {
    const r = activeRoot({ parser: 1 });
    expect(r.run().status).toBe(0);
    expect(r.read(DEST)).toBe(PROFILE_TEXT);
    expect(r.read(LOG)).toContain("失败");
  });

  it("写入失败（/etc/apparmor.d 不存在）→ 不留半成品、exit 0", () => {
    const r = activeRoot();
    fs.rmSync(r.p("etc/apparmor.d"), { recursive: true });
    expect(r.run().status).toBe(0);
    expect(r.exists(DEST)).toBe(false);
    expect(r.read(LOG)).toContain("失败");
  });
});

describe("打包配置守卫：depends / recommends 不能丢默认项", () => {
  // electron-builder 对 depends / recommends 都是**替换**语义：给了值就不再补默认。
  // 本项目曾因此把 9 个 Electron 运行时库全丢掉（自 881e189 起，实测 control 只剩三个沙盒包）。
  const scheme = JSON.parse(
    fs.readFileSync(path.join(process.cwd(), "node_modules/app-builder-lib/scheme.json"), "utf-8"),
  ) as { definitions: { DebOptions: { properties: Record<string, { default?: string[] }> } } };
  const debDefaults = scheme.definitions.DebOptions.properties;
  const pkg = JSON.parse(fs.readFileSync(path.join(process.cwd(), "package.json"), "utf-8")) as {
    build: { deb: { depends: string[]; recommends: string[]; afterInstall: string } };
  };

  it("depends 必须包含 electron-builder 的默认 Electron 运行时库", () => {
    const defaults = debDefaults.depends?.default ?? [];
    expect(defaults.length).toBeGreaterThan(0); // 上游默认值变了要重新核对这条断言
    expect(defaults.filter((d) => !pkg.build.deb.depends.includes(d))).toEqual([]);
  });

  it("recommends 必须包含默认的托盘依赖（本次写成替换语义时差点丢掉）", () => {
    const defaults = debDefaults.recommends?.default ?? [];
    expect(defaults.length).toBeGreaterThan(0);
    expect(defaults.filter((d) => !pkg.build.deb.recommends.includes(d))).toEqual([]);
  });

  it("沙盒依赖与 AppArmor 模板来源包都在声明里", () => {
    for (const p of ["bubblewrap", "socat", "ripgrep"]) expect(pkg.build.deb.depends).toContain(p);
    // apparmor-profiles 提供 bwrap-userns-restrict 模板（Ubuntu 24.04），后置脚本靠它
    expect(pkg.build.deb.recommends).toContain("apparmor-profiles");
  });

  it("afterInstall 指向本仓库里真实存在的脚本", () => {
    expect(pkg.build.deb.afterInstall).toBe("build/linux-after-install.sh");
    expect(fs.existsSync(path.join(process.cwd(), pkg.build.deb.afterInstall))).toBe(true);
  });
});
