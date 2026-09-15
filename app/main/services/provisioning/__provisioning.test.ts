import { describe, expect, it, vi } from "vitest";
import {
  APPARMOR_PROFILES_PACKAGE, buildInstallArgv, buildPackageArgv, formatCommand, manualInstallCommand,
  parseOsRelease, readDistro, resolveInstaller, resolveUsernsProfileSource, usernsCopyArgv,
  usernsFixAvailable, usernsLoadArgv, usernsManualCommand, usernsProfileInstalled,
  type Installer,
} from "./plan";
import { prependPathDirs, probeBinary, type ProbeDeps } from "./probe";

/** 与 plan.ts 的常量同源的钉子：命令与指引必须指向同一处 */
const USERNS_DEST = "/etc/apparmor.d/bwrap-userns-restrict";
const USERNS_SRC = "/usr/share/apparmor/extra-profiles/bwrap-userns-restrict";
const INSTALL_BIN = "/usr/bin/install";
const PARSER = "/usr/sbin/apparmor_parser";
const aSet = (...paths: string[]) => (p: string): boolean => paths.includes(p);

const aptInstaller = (exists = () => true): Installer | null =>
  resolveInstaller({ id: "ubuntu", idLike: [] }, exists);

/** 单测不依赖宿主文件系统：默认"包管理器都在"（真实存在的判定另有测试覆盖） */
const resolve = (id: string, idLike: string[] = [], exists: (p: string) => boolean = () => true) =>
  resolveInstaller({ id, idLike }, exists);

describe("发行版识别", () => {
  it("解析 /etc/os-release（值可带引号）", () => {
    const parsed = parseOsRelease('ID=ubuntu\nVERSION_ID="24.04"\nID_LIKE=debian\n');
    expect(parsed).toEqual({ id: "ubuntu", versionId: "24.04", idLike: ["debian"] });
  });

  it("未知发行版不猜命令", () => {
    const parsed = parseOsRelease("ID=someexotic\n");
    expect(resolveInstaller(parsed)).toBeNull();
  });

  it("按 ID 命中四大家族，且要求包管理器真实存在", () => {
    expect(resolve("fedora")?.kind).toBe("dnf");
    expect(resolve("arch")?.kind).toBe("pacman");
    expect(resolve("opensuse-leap")?.kind).toBe("zypper");
    // 认得发行版但机器上没有对应包管理器 → 不能生成命令
    expect(resolve("ubuntu", [], () => false)).toBeNull();
  });

  it("ID_LIKE 兜底（如 linuxmint 标 debian）", () => {
    expect(resolve("unknown-distro", ["debian"])?.kind).toBe("apt");
  });

  it("readDistro 保留 ID_LIKE，供衍生发行版的执行阶段继续解析安装器", () => {
    const distro = readDistro(
      () => 'ID=elementary\nID_LIKE="ubuntu debian"\nVERSION_ID=8\n',
      "linux",
      (p) => p === "/usr/bin/apt-get",
    );
    expect(distro).toEqual({ id: "elementary", idLike: ["ubuntu", "debian"], versionId: "8", autoInstallable: true });
    expect(resolveInstaller({ id: distro.id, idLike: distro.idLike ?? [] }, (p) => p === "/usr/bin/apt-get")?.kind).toBe("apt");
  });

  it("非 Linux 平台没有包管理器这一层", () => {
    expect(readDistro().autoInstallable).toBe(false);
  });
});

describe("安装命令白名单", () => {
  it("生成 pkexec + 绝对路径包管理器 + 常量包名", () => {
    expect(buildInstallArgv(["bwrap", "socat", "rg"], aptInstaller())).toEqual([
      "/usr/bin/pkexec", "/usr/bin/apt-get", "install", "-y", "--no-install-recommends",
      "bubblewrap", "socat", "ripgrep",
    ]);
  });

  it("包名去重（重复请求同一项只装一次）", () => {
    const argv = buildInstallArgv(["rg", "rg"], aptInstaller());
    expect(argv?.filter((a) => a === "ripgrep")).toHaveLength(1);
  });

  it("拒绝白名单外的条目 / 需人工处理的条目（整批拒绝，不做部分猜测）", () => {
    expect(buildInstallArgv(["userns"], aptInstaller())).toBeNull();
    expect(buildInstallArgv(["bwrap", "evil-package"], aptInstaller())).toBeNull();
    expect(buildInstallArgv(["bwrap; rm -rf /"], aptInstaller())).toBeNull();
    expect(buildInstallArgv([], aptInstaller())).toBeNull();
  });

  it("没有可用包管理器时不产出命令（界面转自助安装）", () => {
    expect(buildInstallArgv(["bwrap"], null)).toBeNull();
  });

  it("自助命令去掉 pkexec 换 sudo，供用户自己跑", () => {
    const cmd = manualInstallCommand(["bwrap", "rg"], aptInstaller());
    expect(cmd).toBe("sudo /usr/bin/apt-get install -y --no-install-recommends bubblewrap ripgrep");
  });

  it("命令格式化只加引号，不引入 shell 语法", () => {
    expect(formatCommand(["sudo", "/opt/my dir/x", "a'b"])).toBe(`sudo '/opt/my dir/x' 'a'\\''b'`);
  });
});

describe("探测三态（防假检测的核心）", () => {
  const deps = (opts: { exists?: string[]; ok?: string[] }): ProbeDeps => {
    const existsSet = new Set(opts.exists ?? []);
    const okSet = new Set(opts.ok ?? []);
    return {
      exists: (p) => existsSet.has(p),
      run: (cmd) => (okSet.has(cmd) ? { status: 0, stdout: "v1\n" } : { status: 127, stdout: "" }),
    };
  };

  it("裸命令名走 PATH 成功 → ok（PATH 前置过的候选表能救回 GUI 进程的快照）", () => {
    expect(probeBinary(["rg", "/usr/bin/rg"], ["--version"], deps({ ok: ["rg"] }))).toEqual({ status: "ok", version: "v1" });
  });

  it("绝对路径存在但执行失败 → unknown（装了但启不来，绝不能报未安装）", () => {
    expect(probeBinary(["rg", "/usr/bin/rg"], ["--version"], deps({ exists: ["/usr/bin/rg"] }))).toEqual({ status: "unknown" });
  });

  it("候选都不存在 → missing（真没装）", () => {
    expect(probeBinary(["rg", "/usr/bin/rg"], ["--version"], deps({}))).toEqual({ status: "missing" });
  });

  it("绝对路径候选不存在就跳过（不把 ENOENT 当成装了但失败）", () => {
    const run = vi.fn(() => ({ status: 127, stdout: "" }));
    const out = probeBinary(["/opt/nope/rg"], ["--version"], { exists: () => false, run });
    expect(out).toEqual({ status: "missing" });
    expect(run).not.toHaveBeenCalled();
  });
});

describe("探测环境", () => {
  it("PATH 前置去重（GUI 进程快照里缺的目录补在最前）", () => {
    const env = prependPathDirs({ PATH: "/usr/bin:/opt/extra" }, ["/opt/extra", "/snap/bin"]);
    expect(env.PATH).toBe("/opt/extra:/snap/bin:/usr/bin");
  });
});

describe("userns 放行的一键修复：计划层（纯函数）", () => {
  const apt = resolveInstaller({ id: "ubuntu", idLike: [] }, () => true);

  it("profile 模板来源：按候选顺序取第一个存在的", () => {
    expect(resolveUsernsProfileSource(aSet(USERNS_SRC))).toBe(USERNS_SRC);
    expect(resolveUsernsProfileSource(aSet("/usr/share/doc/apparmor-profiles/extras/bwrap-userns-restrict")))
      .toBe("/usr/share/doc/apparmor-profiles/extras/bwrap-userns-restrict");
    expect(resolveUsernsProfileSource(aSet())).toBeNull();
  });

  it("目标 profile 已在 → 视为已装（幂等，不覆盖）", () => {
    expect(usernsProfileInstalled(aSet(USERNS_DEST))).toBe(true);
    expect(usernsProfileInstalled(aSet(USERNS_SRC))).toBe(false);
  });

  it("复制命令：用系统 install 传参，不起 shell、不用重定向", () => {
    expect(usernsCopyArgv(USERNS_SRC, aSet(INSTALL_BIN))).toEqual([
      "/usr/bin/pkexec", INSTALL_BIN, "-m", "0644", USERNS_SRC, USERNS_DEST,
    ]);
    // 没有 install（coreutils）→ 不做
    expect(usernsCopyArgv(USERNS_SRC, aSet())).toBeNull();
  });

  it("加载命令：apparmor_parser -r（未加载时会新建，不必重启）", () => {
    expect(usernsLoadArgv(aSet(PARSER))).toEqual(["/usr/bin/pkexec", PARSER, "-r", USERNS_DEST]);
    expect(usernsLoadArgv(aSet())).toBeNull();
  });

  it("能否一键修复：需要工具齐备，且模板已有或能装到", () => {
    const bins = [INSTALL_BIN, PARSER];
    expect(usernsFixAvailable(apt, aSet(...bins, USERNS_SRC))).toBe(true);      // 模板已在
    expect(usernsFixAvailable(apt, aSet(...bins))).toBe(true);                  // 模板缺但能装
    expect(usernsFixAvailable(null, aSet(...bins))).toBe(false);                // 模板缺且无包管理器
    expect(usernsFixAvailable(apt, aSet(INSTALL_BIN, USERNS_SRC))).toBe(false); // 缺解析器
    expect(usernsFixAvailable(apt, aSet(PARSER, USERNS_SRC))).toBe(false);      // 缺 install
    expect(usernsFixAvailable(apt, aSet(...bins, USERNS_SRC, USERNS_DEST))).toBe(false); // 已装好
  });

  it("手工指引：官方三步，且与命令指向同一份 profile / 同一个包", () => {
    const cmd = usernsManualCommand();
    const lines = cmd.split("\n");
    expect(lines).toHaveLength(3);
    expect(lines[0]).toContain(APPARMOR_PROFILES_PACKAGE);
    expect(lines[1]).toContain(USERNS_SRC);
    expect(lines[1]).toContain(USERNS_DEST);
    expect(lines[2]).toContain(USERNS_DEST);
    expect(lines[2]).toContain("apparmor_parser -r");
    // 指引里**不能**出现"全局关掉 userns 限制"那条（会扩大所有进程的攻击面）
    expect(cmd).not.toContain("sysctl");
  });

  it("包名常量构造（不经过 id 白名单，但同样只吃本文件常量）", () => {
    expect(buildPackageArgv(["apparmor-profiles"], apt)).toEqual([
      "/usr/bin/pkexec", "/usr/bin/apt-get", "install", "-y", "--no-install-recommends", "apparmor-profiles",
    ]);
    expect(buildPackageArgv([], apt)).toBeNull();
    expect(buildPackageArgv(["x"], null)).toBeNull();
  });
});
