import { describe, expect, it, vi } from "vitest";
import {
  buildInstallArgv, formatCommand, manualInstallCommand, parseOsRelease, readDistro, resolveInstaller,
  type Installer,
} from "./plan";
import { prependPathDirs, probeBinary, type ProbeDeps } from "./probe";

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
