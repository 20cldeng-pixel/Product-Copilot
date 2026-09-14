/**
 * 依赖安装的「计划」层：发行版识别 + 白名单命令生成。**纯函数，便于单测**。
 *
 * 安全规则（方案 §8）：命令模板与包名全部是代码常量；本文件产出的 argv 是唯一被允许执行的形态；
 * 渲染层永远不能传命令片段——只能传 EnvItemId，未知 id 一律拒绝（返回 null → 界面转「自助安装」）。
 */
import fs from "node:fs";
import path from "node:path";
import type { EnvDistro, EnvItemId } from "./types";

/** 条目 → 包名。四个包管理器家族（apt/dnf/pacman/zypper）这三项包名一致；
 *  新增家族或新增条目时**必须逐家核对包名**，核不到就走 manual，不要猜。 */
const PACKAGE_OF: Partial<Record<EnvItemId, string>> = {
  bwrap: "bubblewrap",
  socat: "socat",
  rg: "ripgrep",
  // userns：需改系统安全配置（AppArmor/sysctl），**只展示给用户，不代执行** → 无包名
};

/** 发行版家族 → 包管理器（绝对路径候选按顺序取第一个存在的） */
const INSTALLER_CANDIDATES: Record<string, string[]> = {
  apt: ["/usr/bin/apt-get", "/usr/bin/apt"],
  dnf: ["/usr/bin/dnf", "/usr/bin/dnf5"],
  pacman: ["/usr/bin/pacman"],
  zypper: ["/usr/bin/zypper"],
};

/** os-release ID → 包管理器家族；同族发行版按 ID_LIKE 兜底 */
const FAMILY_BY_ID: Record<string, keyof typeof INSTALLER_CANDIDATES> = {
  ubuntu: "apt", debian: "apt", linuxmint: "apt", pop: "apt", kali: "apt", raspbian: "apt",
  fedora: "dnf", rhel: "dnf", centos: "dnf", rocky: "dnf", almalinux: "dnf", nobara: "dnf",
  arch: "pacman", manjaro: "pacman", endeavouros: "pacman", cachyos: "pacman",
  opensuse: "zypper", "opensuse-leap": "zypper", "opensuse-tumbleweed": "zypper", sles: "zypper",
};

/** 安装器 argv 模板（包名由调用方追加） */
const INSTALL_ARGS: Record<keyof typeof INSTALLER_CANDIDATES, string[]> = {
  apt: ["install", "-y", "--no-install-recommends"],
  dnf: ["install", "-y"],
  pacman: ["-S", "--noconfirm", "--needed"],
  zypper: ["--non-interactive", "install", "-y"],
};

export interface Installer {
  kind: keyof typeof INSTALLER_CANDIDATES;
  /** 包管理器绝对路径（pkexec 不继承 PATH、且要求绝对路径，故必须解析出来） */
  path: string;
  args: string[];
}

/** 解析 /etc/os-release（key=value，值可能带引号） */
export function parseOsRelease(text: string): { id: string; versionId?: string; idLike: string[] } {
  const map: Record<string, string> = {};
  for (const line of text.split("\n")) {
    const m = /^([A-Z_]+)=(.*)$/.exec(line.trim());
    if (!m) continue;
    map[m[1]!] = m[2]!.replace(/^["']|["']$/g, "");
  }
  return {
    id: (map.ID ?? "").toLowerCase(),
    versionId: map.VERSION_ID || undefined,
    idLike: (map.ID_LIKE ?? "").toLowerCase().split(/\s+/).filter(Boolean),
  };
}

export function readDistro(readFile: (p: string) => string = (p) => fs.readFileSync(p, "utf-8")): EnvDistro {
  if (process.platform !== "linux") {
    // macOS 用系统 Seatbelt、Windows 走 srt-sandbox，都没有"发行版包管理器"这一层
    return { id: process.platform === "darwin" ? "macos" : "windows", autoInstallable: false };
  }
  try {
    const parsed = parseOsRelease(readFile("/etc/os-release"));
    return { id: parsed.id || "unknown", versionId: parsed.versionId, autoInstallable: resolveInstaller(parsed) !== null };
  } catch {
    return { id: "unknown", autoInstallable: false };
  }
}

export function resolveInstaller(
  os: { id: string; idLike: string[] },
  exists: (p: string) => boolean = fs.existsSync,
): Installer | null {
  const family = FAMILY_BY_ID[os.id] ?? os.idLike.map((v) => FAMILY_BY_ID[v]).find(Boolean);
  if (!family) return null;
  const found = INSTALLER_CANDIDATES[family]!.find((p) => exists(p));
  if (!found) return null;
  return { kind: family, path: found, args: INSTALL_ARGS[family]! };
}

/**
 * 生成安装 argv：`pkexec <包管理器绝对路径> <参数> <包名…>`。
 * - 返回 null = 不允许自动安装（未知条目 / 需人工处理的条目 / 无可用包管理器）→ 界面转自助安装。
 * - 只用 argv（不拼 shell 字符串），包名来自常量表，杜绝任意命令。
 */
export function buildInstallArgv(
  ids: readonly string[],
  installer: Installer | null,
  pkexecPath = "/usr/bin/pkexec",
): string[] | null {
  if (ids.length === 0) return null;
  const packages: string[] = [];
  for (const id of ids) {
    const pkg = PACKAGE_OF[id as EnvItemId];
    if (!pkg) return null; // 白名单外 / 不可自动安装 → 整批拒绝，不做部分猜测
    if (!packages.includes(pkg)) packages.push(pkg);
  }
  if (!installer) return null;
  return [pkexecPath, installer.path, ...installer.args, ...packages];
}

/** 界面展示用（复制到终端可执行的字符串）。只用引号包裹，不引入任何 shell 语法 */
export function formatCommand(argv: readonly string[]): string {
  return argv.map((a) => (/[\s"'$`\\]/.test(a) ? `'${a.replace(/'/g, `'\\''`)}'` : a)).join(" ");
}

/** 无 polkit（无桌面/企业镜像）时的自助安装命令：去掉 pkexec，让用户自己 sudo */
export function manualInstallCommand(ids: readonly string[], installer: Installer | null): string | null {
  const argv = buildInstallArgv(ids, installer, "sudo");
  return argv ? formatCommand(argv) : null;
}

/** 各发行版的"没有包管理器时的兜底指引"（只展示，不执行） */
export function distroHint(distroId: string): string {
  const name = path.basename(distroId || "linux");
  return `未识别的发行版（${name}）：请用你的包管理器安装 bubblewrap、socat、ripgrep，或从源码安装后确保它们在 PATH 中`;
}
