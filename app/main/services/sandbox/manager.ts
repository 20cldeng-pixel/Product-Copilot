/**
 * system-protection manager — 基于 srt（@anthropic-ai/sandbox-runtime）的底层系统保护。
 *
 * - 懒加载：首次需要时 initialize（起代理 + 平台探测）；失败记不可用原因，
 *   权限层对「判不了」命令按 fail-closed 退回拒绝（沙盒不可用不静默放行）。
 * - 规则单一来源：两模式均由 access-policy 编译，每次执行传入工作区与模式。
 * - srt 是 ESM-only 包，Electron 主进程 CJS 用动态 import 加载（对齐 pi-sdk wrapper 模式）。
 */

import type { SandboxRuntimeConfig } from "@anthropic-ai/sandbox-runtime";
import { spawnSync } from "node:child_process";
import { buildExecutionPolicy, type PermissionMode } from "../permission/access-policy";
import { createExecutionContext, type ExecutionContext } from "../permission/execution-context";
import { wrapWithWindowsWorker } from "./windows-execution-manager";

/** Linux 沙盒系统依赖（EM 不代做系统安装——缺失时给安装指引，装好前自动降级） */
const LINUX_SANDBOX_DEPS = ["bwrap", "socat", "rg"] as const;

type SrtModule = typeof import("@anthropic-ai/sandbox-runtime");

let _srt: SrtModule | null = null;
let _state: "untouched" | "ok" | "failed" = "untouched";
let _failReason = "";

async function getSrt(): Promise<SrtModule> {
  if (!_srt) _srt = await import("@anthropic-ai/sandbox-runtime");
  return _srt;
}

export function isSandboxAvailable(): boolean {
  return _state === "ok";
}

export function sandboxUnavailableReason(): string {
  return _failReason;
}

/** Linux 沙盒缺失的系统依赖（bwrap/socat/rg 缺任一，srt 都无法初始化） */
export function missingLinuxSandboxDeps(): string[] {
  if (process.platform !== "linux") return [];
  return LINUX_SANDBOX_DEPS.filter((bin) => {
    try {
      return spawnSync("which", [bin], { stdio: "ignore" }).status !== 0;
    } catch {
      return true;
    }
  });
}

/**
 * 「是否关闭了沙盒运行」的读取器——由主进程启动时接线（读设置文件）。
 * 用注入的读取函数而不是缓存字段，避免设置改了、缓存没同步这类不一致。
 */
let _sandboxDisabledProvider: () => boolean = () => false;

export function setSandboxDisabledProvider(fn: () => boolean): void {
  _sandboxDisabledProvider = fn;
}

/**
 * Linux 兜底通道：系统依赖装不上时允许关掉沙盒运行。
 * 用户政策：**优先引导安装依赖**，实在装不了才走这里（见设置页「环境检测」）。
 * 仅 Linux 生效——macOS 用系统 Seatbelt（无外部依赖），Windows 走 srt-sandbox 账户（另有一次性安装）。
 * 关闭后仅保留结构化工具的路径检查与已知系统命令预检；任意 shell/解释器 I/O 不再有强制边界。
 */
export function isSandboxBypassed(): boolean {
  return process.platform === "linux" && _sandboxDisabledProvider();
}

/**
 * srt filesystem 规则（写 allow-only / 读 deny-then-allow）：
 * - 两模式都禁止直接读取高度敏感凭据、禁止修改系统核心与安全控制面；
 * - 标准模式可写工作区与正式开发资源，完全访问可写其余普通位置；
 * - 工作区不能覆盖核心 deny。
 * 网络（实测修正 2026-09-06）：srt 的 allowedDomains 语义 = 域名限制档——mac/Windows 运行时模式
 *   下需宿主自带 HTTP/SOCKS 代理（Claude Code 集成层有，EM 无）才放行，配置即全 deny（出网也死）。
 *   用空对象 network:{} → 不触发限制档 → macOS seatbelt `allow network*` 出网放行；
 *   回环出站/bind 仍被隔离（allowLocalBinding=false 的 deny 规则独立生效，实测 curl/node 连 127.0.0.1 均 deny）。
 *   Linux 有 srt 内置 bridge（initializeLinuxNetworkBridge）保留 allowedDomains 档；Windows 待实测。
 */
export function buildSandboxConfig(cwd: string, mode: PermissionMode = "standard"): SandboxRuntimeConfig {
  return buildExecutionPolicy(createExecutionContext(cwd, mode));
}

export interface SandboxInitResult {
  ok: boolean;
  reason?: string;
}

/**
 * 平台化失败原因（区分「缺什么、怎么补」——EM 不代做系统级安装，只给指引）。
 * - Linux：系统包 bwrap/socat/rg 缺失（deb 安装的 EM 由 apt 依赖自动装；AppImage 需手动）或 userns 内核限制
 * - Windows：srt-sandbox 账户/WFP 未安装（需一次性管理员安装，弹 UAC）
 * - macOS：原样返回（无系统依赖，问题属内部错误）
 */
async function platformFailureReason(e: Error): Promise<string | null> {
  if (process.platform === "linux") {
    const missing = missingLinuxSandboxDeps();
    if (missing.length > 0) {
      // 三发行版命令 + 指向设置页「重新检测」（不必重启）与兜底开关
      return `系统保护组件缺失：${missing.join("、")}。装好后到「设置 → 环境检测」点「重新检测」即可生效——`
        + `Debian/Ubuntu: sudo apt install bubblewrap socat ripgrep；`
        + `Fedora/RHEL: sudo dnf install bubblewrap socat ripgrep；`
        + `Arch: sudo pacman -S bubblewrap socat ripgrep。`
        + `实在装不了可在同一处关闭沙盒运行（不推荐）`;
    }
    // 官方做法是给 bwrap 加载 AppArmor profile，而不是全局关掉 userns 限制
    //（deb 安装时由 build/linux-after-install.sh 自动落；其余安装形态到「设置 → 环境检测」看指引）
    return `沙盒初始化失败（Ubuntu 24.04 起默认禁止 bwrap 创建普通用户命名空间，需加载 AppArmor profile；`
      + `用 deb 安装时已自动处理，仍失败请到「设置 → 环境检测」按指引执行一次）：${e.message}`;
  }
  if (process.platform === "win32") {
    try {
      const srt = await getSrt();
      const st = await srt.checkWindowsSandboxStatusAsync();
      const userOk = Boolean(st?.user?.provisioned && st.user.credPresent);
      if (!userOk) {
        return `Windows 系统保护组件未安装（需一次性管理员安装，将弹出 UAC 授权）——安装指引见文档`;
      }
    } catch { /* 状态探测失败按通用错误处理 */ }
    return `Windows 沙盒初始化失败（可能是 WFP 过滤未生效）：${e.message}`;
  }
  return null; // macOS 无系统依赖，原样报错
}

/**
 * Windows 专属配置注入：srt 要求显式指定 srt-win.exe 路径（vendor 随包分发，
 * asarUnpack 后路径仍有效）。VENDORED_SRT_WIN_EXE 是 srt 导出的包内常量。
 */
async function applyWindowsConfig(cfg: SandboxRuntimeConfig): Promise<SandboxRuntimeConfig> {
  if (process.platform !== "win32") return cfg;
  try {
    const srt = await getSrt();
    return { ...cfg, windows: { srtWin: { path: srt.VENDORED_SRT_WIN_EXE } } };
  } catch (e) {
    console.warn("[sandbox] srt-win 路径注入失败:", (e as Error).message);
    return cfg;
  }
}

/** 懒加载初始化（幂等）。失败原因保留供权限层 fail-closed 拒绝时展示。 */
export async function ensureSandbox(cwd: string): Promise<SandboxInitResult> {
  if (_state === "ok") return { ok: true };
  if (_state === "failed") return { ok: false, reason: _failReason };
  try {
    const srt = await getSrt();
    // srt-win 的文件允许项在 initialize 时写入 ACL。初始化必须在按会话隔离的
    // worker 内完成，主进程这里只检查系统组件，绝不能初始化共享实例。
    if (process.platform === "win32") {
      const status = await srt.checkWindowsSandboxStatusAsync();
      if (!status.user.provisioned || !status.user.credPresent) {
        throw new Error("Windows 系统保护组件未安装");
      }
      _state = "ok";
      return { ok: true };
    }
    await srt.SandboxManager.initialize(await applyWindowsConfig(buildSandboxConfig(cwd)));
    _state = "ok";
    return { ok: true };
  } catch (e) {
    _state = "failed";
    const platformHint = await platformFailureReason(e as Error);
    _failReason = platformHint ?? (e as Error).message;
    // 初始化失败诊断（Electron 环境与终端 node 差异定位用——stack + 环境探针）
    const cfg = buildSandboxConfig(cwd);
    console.error("[sandbox] initialize 失败:", {
      message: (e as Error).message,
      stack: (e as Error).stack,
      cwd,
      tmpdirEnv: process.env.TMPDIR ?? "(未设置)",
      homeEnv: process.env.HOME ?? "(未设置)",
      osTmpdir: require("node:os").tmpdir(),
      nodeVersion: process.versions.node,
      electronVersion: process.versions.electron ?? "(非 electron)",
      allowWrite: cfg.filesystem?.allowWrite,
      denyReadSample: (cfg.filesystem?.denyRead ?? []).slice(0, 3),
    });
    return { ok: false, reason: _failReason };
  }
}

/** 沙盒执行规格——执行层按 kind 选择 spawn 方式 */
export type SandboxSpawnSpec =
  /** darwin/linux：wrapWithSandbox 返回 shell 字符串，走 resolveSpawn 原路径（shell:true / Git Bash -c） */
  | { kind: "shell"; command: string; env: NodeJS.ProcessEnv; release?: () => Promise<void> }
  /** win32：srt 不支持 shell 字符串包装（srt-win 两跳），必须 argv + shell:false + 注入 env */
  | { kind: "argv"; argv: string[]; env: NodeJS.ProcessEnv; release?: () => Promise<void> };

/**
 * 包装命令为沙盒执行规格（调用前须 ensureSandbox ok；失败抛错由调用方转报错文本）。
 * Windows 分支：wrapWithSandboxArgv + Git Bash 绝对路径（EM Windows bash 统一走 Git Bash，
 * 与 resolveSpawn 的 findBashOnWindows 一致——gitBashPath 由调用方传入避免重复探测）。
 */
export async function wrapForSandbox(
  command: string,
  opts: { context: ExecutionContext; gitBashPath?: string; windowsShell?: "bash" | "powershell" },
): Promise<SandboxSpawnSpec> {
  const srt = await getSrt();
  const context = opts.context;
  if (process.platform === "win32") {
    const wrapped = await wrapWithWindowsWorker(command, context, opts.gitBashPath, opts.windowsShell);
    return { kind: "argv", ...wrapped };
  }
  const policy = buildExecutionPolicy(context);
  // srt 会在外层把 TMPDIR 设为自己的 scratch 目录。标准模式在最内层恢复运行区变量，
  // 让遵循 HOME/TMP/XDG 约定的开发工具稳定写入项目运行区；真正边界仍由 policy 强制。
  const effectiveCommand = context.mode === "standard"
    ? `${runtimeEnvironmentPrefix(context.environment)} ${command}`
    : command;
  return {
    kind: "shell",
    command: await srt.SandboxManager.wrapWithSandbox(effectiveCommand, undefined, policy),
    env: context.environment,
  };
}

function runtimeEnvironmentPrefix(environment: NodeJS.ProcessEnv): string {
  const names = [
    "HOME", "USERPROFILE", "TMPDIR", "TMP", "TEMP",
    "XDG_CACHE_HOME", "XDG_CONFIG_HOME", "XDG_STATE_HOME",
    "NPM_CONFIG_PREFIX", "NPM_CONFIG_CACHE", "npm_config_cache", "COREPACK_HOME",
    "npm_config_prefix", "npm_config_global_prefix", "NPM_CONFIG_USERCONFIG", "npm_config_userconfig",
    "npm_config_globalconfig", "PNPM_HOME", "YARN_CACHE_FOLDER", "BUN_INSTALL", "BUN_INSTALL_CACHE_DIR",
    "PIP_CACHE_DIR", "UV_CACHE_DIR", "PYTHONUSERBASE", "GRADLE_USER_HOME", "MAVEN_OPTS",
    "CARGO_HOME", "GOPATH", "GOMODCACHE", "GOBIN", "PUB_CACHE", "DENO_DIR", "DOTNET_CLI_HOME",
    "NUGET_PACKAGES", "COMPOSER_HOME", "COMPOSER_CACHE_DIR", "CCACHE_DIR",
    "PWD", "INIT_CWD", "EASYMINT_WORKSPACE", "EASYMINT_RUNTIME",
  ];
  const assignments = names.flatMap((name) => {
    const value = environment[name];
    return value === undefined ? [] : [`${name}=${shellLiteral(value)}`];
  });
  return assignments.length > 0 ? `export ${assignments.join(" ")};` : "";
}

function shellLiteral(value: string): string {
  return `'${value.replace(/'/g, `'"'"'`)}'`;
}

/** 违规归因：把沙盒拦截事件注解进 stderr（Operation not permitted → 大白话违规说明） */
export function annotateSandboxFailures(wrappedCommand: string, stderr: string): string {
  try {
    const srt = _srt ?? null;
    if (!srt) return stderr;
    return srt.SandboxManager.annotateStderrWithSandboxFailures(wrappedCommand, stderr);
  } catch {
    return stderr; // 注解失败不吞原 stderr
  }
}

/** 仅供测试：释放代理、监控器和全局状态。生产按每次 wrap 的策略隔离工作区。 */
export async function resetSandboxForTest(): Promise<void> {
  if (_srt) await _srt.SandboxManager.reset();
  _state = "untouched";
  _failReason = "";
}

/**
 * 重置缓存状态（供生产使用）：依赖刚装好或用户点了「重新检测」时调用，
 * 让「装完即生效」不必重启 EasyMint——否则失败状态会一直被缓存住继续 fail-closed。
 */
export async function resetSandboxState(): Promise<void> {
  await resetSandboxForTest();
}
