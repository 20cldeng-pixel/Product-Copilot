/**
 * 环境探测层：**防假检测**是这一层的首要目标（方案 §3.5）。
 *
 * 三条铁律（每条都对应一次真实误报）：
 * 1. 绝对路径候选 + PATH 前置：GUI 进程的 PATH 是启动时的快照，用户后装的工具
 *    （~/.cargo/bin、/snap/bin、~/.local/bin、homebrew、%APPDATA%\npm）不在里面；
 *    只用裸命令名 / `which` 会把"已安装"报成"没装"（codegraph 误报的根因之一）。
 * 2. 三态：`ok` / `missing` / `unknown`(探测失败) / `blocked`(装了但被系统策略挡)——
 *    绝不把探测失败或"被挡"压成"未安装"，那样用户会反复装、还是不行。
 * 3. 探测环境要干净：剔除会污染子进程的变量；**不用 EM 托管的环境**（用户自己设的变量不应影响判定）；
 *    也**不在沙盒里探测**（沙盒会 deny 掉读路径，把"存在"探成"不存在"）。
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { readDistro, resolveInstaller, manualInstallCommand, distroHint } from "./plan";
import type { EnvItem, EnvItemId, EnvItemStatus, EnvReport } from "./types";

/** 传下去会让被测程序行为异常的变量（本项目实际见过外部注入 NODE_OPTIONS） */
const POLLUTING_ENV = [
  "NODE_OPTIONS", "ELECTRON_RUN_AS_NODE", "NODE_ENV",
  "LD_PRELOAD", "LD_LIBRARY_PATH", "DYLD_INSERT_LIBRARIES", "DYLD_LIBRARY_PATH",
];

/** 探测/安装子进程都用一个干净且补全过 PATH 的环境（见文件头三条铁律） */
export function cleanEnv(): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env };
  for (const k of POLLUTING_ENV) delete env[k];
  return env;
}

/** PATH 前置目录（去重后拼到子进程 PATH 前面） */
export function prependPathDirs(env: NodeJS.ProcessEnv, dirs: readonly string[]): NodeJS.ProcessEnv {
  const sep = process.platform === "win32" ? ";" : ":";
  const existing = (env.PATH ?? "").split(sep).filter(Boolean);
  const merged = [...new Set([...dirs, ...existing])];
  return { ...env, PATH: merged.join(sep) };
}

/** PATH 前置目录（去重后拼到子进程 PATH 前面）——探测与安装子进程共用 */
export function probePathDirs(): string[] {
  const home = os.homedir();
  if (process.platform === "win32") {
    const pf = process.env.ProgramFiles ?? "C:\\Program Files";
    const appData = process.env.APPDATA ?? "";
    return [path.join(pf, "nodejs"), path.join(appData, "npm"), path.join(home, ".local", "bin")];
  }
  return [
    "/usr/local/bin", "/usr/bin", "/bin", "/usr/sbin", "/sbin",
    "/snap/bin", "/run/current-system/sw/bin",           // snap / NixOS
    path.join(home, ".local", "bin"), path.join(home, ".cargo", "bin"), // pipx / cargo
  ];
}

// ── 探测原语（依赖注入，便于单测三态）─────────────────────────────────────────

export interface ProbeDeps {
  exists(p: string): boolean;
  run(cmd: string, args: readonly string[]): { status: number | null; stdout: string };
}

const realDeps: ProbeDeps = {
  exists: (p) => fs.existsSync(p),
  run: (cmd, args) => {
    const r = spawnSync(cmd, [...args], {
      encoding: "utf-8", timeout: 5000, stdio: "pipe", windowsHide: true,
      env: prependPathDirs(cleanEnv(), probePathDirs()),
    });
    // 失败留痕：静默会把「装了但启不来」和「没装」压成同一个结论（这正是潜伏 v0.6.6→v0.23.1 的原因）
    if (r.status !== 0) {
      const code = (r.error as NodeJS.ErrnoException | undefined)?.code;
      console.warn(`[provisioning] 探测失败 cmd=${cmd} reason=${code ?? `exit ${r.status}`}`);
    }
    return { status: r.status, stdout: (r.stdout ?? "").trim() };
  },
};

const isAbsolutePath = (p: string): boolean => p.startsWith("/") || /^[A-Za-z]:[\\/]/.test(p);

export type ProbeOutcome =
  | { status: "ok"; version: string }
  | { status: "missing" }
  | { status: "unknown" };

/** 逐个候选尝试；绝对路径候选"存在但拿不到版本" → unknown（装了但启不来），不是 missing */
export function probeBinary(
  candidates: readonly string[],
  args: readonly string[],
  deps: ProbeDeps = realDeps,
): ProbeOutcome {
  let sawExistingButFailed = false;
  for (const cand of candidates) {
    if (isAbsolutePath(cand) && !deps.exists(cand)) continue;
    const r = deps.run(cand, args);
    if (r.status === 0 && r.stdout) return { status: "ok", version: r.stdout.split("\n")[0]!.trim() };
    if (isAbsolutePath(cand)) sawExistingButFailed = true;
  }
  return sawExistingButFailed ? { status: "unknown" } : { status: "missing" };
}

// ── 条目定义 ────────────────────────────────────────────────────────────────

interface BinarySpec {
  id: EnvItemId;
  label: string;
  args: string[];
  candidates: string[];
}

/** 沙盒三件套 = 只对 Linux 有意义（macOS 用系统 Seatbelt，无外部依赖） */
const LINUX_BINARIES: BinarySpec[] = [
  {
    id: "bwrap", label: "bubblewrap（隔离进程）", args: ["--version"],
    candidates: ["bwrap", "/usr/bin/bwrap", "/usr/local/bin/bwrap", "/bin/bwrap", "/snap/bin/bwrap", "/run/current-system/sw/bin/bwrap"],
  },
  {
    id: "socat", label: "socat（网络桥）", args: ["-V"],
    candidates: ["socat", "/usr/bin/socat", "/usr/local/bin/socat", "/bin/socat", "/run/current-system/sw/bin/socat"],
  },
  {
    id: "rg", label: "ripgrep（检索）", args: ["--version"],
    // cargo 安装（~/.cargo/bin）在开发者机器上很常见，必须列候选否则误报
    candidates: ["rg", "/usr/bin/rg", "/usr/local/bin/rg", "/bin/rg", "/snap/bin/rg",
      path.join(os.homedir(), ".cargo", "bin", "rg"), "/run/current-system/sw/bin/rg"],
  },
];

/** userns 功能实测命令：`which bwrap` 查不出「包在但被 AppArmor 挡」（Ubuntu 24.04+ 默认如此） */
const USERNS_PROBE_ARGS = ["--ro-bind", "/", "/", "--dev", "/dev", "--unshare-pid", "--", "echo", "ok"];

const APPARMOR_HINT =
  "系统默认策略不允许 bubblewrap 创建隔离空间（Ubuntu 24.04 起的默认行为）。"
  + "需要一次系统级设置——这会调整系统安全配置，所以由你自己确认后执行，EasyMint 不会代做。";

function blockedFix(): EnvItem["fix"] {
  return {
    manual: {
      command: "sudo install -m 0644 /usr/share/apparmor/extra-profiles/bwrap-userns-restrict /etc/apparmor.d/bwrap-userns-restrict && sudo apparmor_parser -r /etc/apparmor.d/bwrap-userns-restrict",
      url: "https://docs.kernel.org/userspace-api/apparmor.html",
    },
    sandboxOff: true,
  };
}

// ── 主入口 ──────────────────────────────────────────────────────────────────

/**
 * 探测整套环境。**异步**：Windows 的 srt-sandbox 状态探测是 async（后续接入）。
 * 只读、不改任何状态；失败留痕、绝不抛错（探测本身不能把主流程带崩）。
 */
export async function probeEnvironment(
  deps: { probe?: (spec: BinarySpec) => ProbeOutcome } = {},
): Promise<EnvReport> {
  const distro = readDistro();
  const items: EnvItem[] = [];
  const probe = deps.probe ?? ((spec: BinarySpec) => probeBinary(spec.candidates, spec.args));

  if (process.platform === "linux") {
    const installer = resolveInstaller({ id: distro.id, idLike: [] });
    const manual = (ids: EnvItemId[]): string | undefined =>
      manualInstallCommand(ids, installer) ?? undefined;

    const results = LINUX_BINARIES.map((spec) => ({ spec, out: probe(spec) }));
    let bwrapOk = false;
    for (const { spec, out } of results) {
      if (spec.id === "bwrap" && out.status === "ok") bwrapOk = true;
      const status: EnvItemStatus = out.status;
      items.push({
        id: spec.id,
        label: spec.label,
        required: true,
        status,
        ...(out.status === "ok" ? { version: out.version } : {}),
        ...(out.status === "unknown"
          ? { detail: "已安装但无法启动——可能是权限问题或安装不完整（不是没装）" }
          : {}),
        fix: {
          auto: { packages: [] },           // 包名由 plan 的白名单给出，这里只标记"可自动装"
          ...(status === "ok" ? {} : { manual: { command: manual([spec.id]) } }),
        },
      });
    }

    // userns：功能实测（只有 bwrap 在才测；否则不重复报错）
    if (!bwrapOk) {
      items.push({
        id: "userns", label: "隔离能力（用户命名空间）", required: true, status: "unknown",
        detail: "需先装好 bubblewrap 才能验证",
        fix: { sandboxOff: true },
      });
    } else {
      const out = probe({ id: "userns", label: "", args: USERNS_PROBE_ARGS, candidates: ["bwrap", "/usr/bin/bwrap"] });
      const ok = out.status === "ok";
      items.push({
        id: "userns", label: "隔离能力（用户命名空间）", required: true,
        status: ok ? "ok" : "blocked",
        ...(ok ? {} : { detail: APPARMOR_HINT }),
        fix: ok ? {} : blockedFix(),
      });
    }

    // 非 apt/dnf/pacman/zypper → 不猜命令，补一句发行版提示
    if (!distro.autoInstallable) {
      const hint = distroHint(distro.id);
      for (const item of items) if (item.status !== "ok") item.detail = item.detail ? `${item.detail}；${hint}` : hint;
    }
  }

  return { items, distro, probedAt: Date.now() };
}
