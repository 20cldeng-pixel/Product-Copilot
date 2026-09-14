/**
 * 执行层：把 plan 产出的 argv 跑起来，按**阶段**回报进度，装完复核。
 *
 * 为什么用阶段而非解析包管理器输出：apt/dnf/pacman/zypper 的输出格式、进度条、语言各不相同，
 * 解析必然脆弱且随时被上游改坏；阶段化（准备→安装→复核）在四家都成立，进度条用"不确定态"更诚实。
 *
 * 安全（方案 §8）：只执行 plan.buildInstallArgv() 的产物——本文件**不拼任何命令**；
 * 提权交给系统弹窗（pkexec → polkit），EM 不代持凭据；需要改系统安全配置的项不在这里（属 manual）。
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { buildInstallArgv, manualInstallCommand, readDistro, resolveInstaller } from "./plan";
import { cleanEnv, prependPathDirs, probeEnvironment, probePathDirs } from "./probe";
import type { EnvReport } from "./types";

export type InstallPhase = "preparing" | "installing" | "verifying" | "done" | "failed";

export interface InstallEvent {
  phase: InstallPhase;
  /** 进度（1-based；preparing 为 0） */
  index: number;
  total: number;
  message?: string;
}

export interface InstallResult {
  ok: boolean;
  /** 失败时的自助命令（复制到终端可执行）；undefined = 连命令都生成不出来（如未知发行版） */
  manualCommand?: string;
  /** 面向用户的原因 */
  reason?: string;
  report?: EnvReport;
  exitCode?: number | null;
}

export interface RunDeps {
  spawn: typeof spawn;
  probe: () => Promise<EnvReport>;
  logger: (line: string) => void;
  /** 覆盖计划层（单测注入用；生产不传） */
  plan?: { argv: string[] | null; manualCommand?: string };
}

const LOG_DIR = path.join(os.homedir(), ".easymint", "logs");
const LOG_PATH = path.join(LOG_DIR, "provisioning.log");

/** 审计日志：命令、退出码、输出尾部（方案 §8.4）。日志本身失败不能影响安装 */
function defaultLog(line: string): void {
  try {
    fs.mkdirSync(LOG_DIR, { recursive: true });
    fs.appendFileSync(LOG_PATH, `${new Date().toISOString()} ${line}\n`);
  } catch { /* ignore */ }
}

/** 输出尾部用于诊断：剥掉终端控制字符、截断（包管理器输出可能很长） */
export function outputTail(s: string, n = 400): string {
  return s.replace(/\u001b\[[0-9;]*m/g, "").trim().slice(-n);
}

function computePlan(ids: readonly string[]): { argv: string[] | null; manualCommand?: string } {
  const distro = readDistro();
  const installer = resolveInstaller({ id: distro.id, idLike: [] });
  return {
    argv: buildInstallArgv(ids, installer),
    manualCommand: manualInstallCommand(ids, installer) ?? undefined,
  };
}

export async function installDependencies(
  ids: readonly string[],
  onEvent: (e: InstallEvent) => void,
  deps: Partial<RunDeps> = {},
  signal?: AbortSignal,
): Promise<InstallResult> {
  const spawnFn = deps.spawn ?? spawn;
  const probe = deps.probe ?? ((): Promise<EnvReport> => probeEnvironment());
  const log = deps.logger ?? defaultLog;
  const plan = deps.plan ?? computePlan(ids);
  const total = ids.length;

  onEvent({ phase: "preparing", index: 0, total, message: "正在准备安装…" });
  if (!plan.argv) {
    return {
      ok: false,
      reason: "当前系统无法自动安装（未识别的发行版，或没有可用的包管理器）",
      manualCommand: plan.manualCommand,
    };
  }

  log(`[install] argv=${JSON.stringify(plan.argv)}`);
  onEvent({ phase: "installing", index: 1, total, message: "正在安装系统组件（可能弹出系统授权窗口）…" });

  const child = spawnFn(plan.argv[0]!, plan.argv.slice(1), {
    stdio: ["ignore", "pipe", "pipe"],
    env: prependPathDirs(cleanEnv(), probePathDirs()),
    windowsHide: true,
  });
  let out = "";
  child.stdout?.on("data", (d) => { out += String(d); });
  child.stderr?.on("data", (d) => { out += String(d); });

  const kill = (): void => { try { child.kill("SIGTERM"); } catch { /* 已退出 */ } };
  if (signal?.aborted) kill(); // 传入时已取消（addEventListener 不会再触发）
  signal?.addEventListener("abort", kill, { once: true });
  const exitCode = await new Promise<number | null>((resolve) => child.on("close", (c) => resolve(c)));
  signal?.removeEventListener("abort", kill);
  log(`[install] exit=${exitCode} tail=${outputTail(out, 200)}`);

  onEvent({ phase: "verifying", index: total, total, message: "正在复核…" });
  const report = await probe();
  const remaining = report.items.filter((i) => i.status !== "ok").map((i) => i.id);
  if (remaining.length === 0) {
    onEvent({ phase: "done", index: total, total, message: "环境已就绪" });
    return { ok: true, report, exitCode };
  }

  // 失败原因要能指导下一步：区分「取消 / 命令跑完了但仍不可用（多为系统策略拦截）/ 命令没跑成」
  const reason = signal?.aborted
    ? "安装已取消"
    : exitCode === 0
      ? `组件已安装，但 ${remaining.join("、")} 仍不可用——多为系统策略拦截，请看下方说明`
      : `安装未完成（退出码 ${exitCode}）——常见原因：取消了系统授权、当前环境弹不出授权窗口、网络或镜像源不可达`;
  onEvent({ phase: "failed", index: total, total, message: reason });
  return { ok: false, report, manualCommand: plan.manualCommand, reason, exitCode };
}
