import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { SandboxRuntimeConfig } from "@anthropic-ai/sandbox-runtime";
import { developmentRuntimeFor, developmentRuntimesRoot } from "./development-runtime";
import type { ExecutionContext } from "./execution-context";

export type { PermissionMode } from "./execution-context";

/**
 * 两种模式共同的安全底线。这里只列“禁止写入”的系统控制面；普通系统文件允许读取，
 * /tmp、用户文档、开发工具链也不属于系统核心。
 */
export function protectedWriteRoots(platform: NodeJS.Platform = process.platform): string[] {
  if (platform === "win32") {
    const systemRoot = process.env.SystemRoot || "C:\\Windows";
    return [
      systemRoot,
      "C:\\Recovery",
      "C:\\System Volume Information",
      "C:\\$Recycle.Bin",
    ];
  }
  if (platform === "darwin") {
    return [
      "/System", "/Library", "/bin", "/sbin",
      "/usr/bin", "/usr/sbin", "/usr/lib", "/usr/libexec", "/usr/share",
      "/etc", "/private/etc", "/private/var/db", "/private/var/root",
      "/private/var/at", "/private/var/audit", "/private/var/log", "/private/var/run",
      "/private/var/vm", "/private/var/protected", "/private/var/networkd",
      "/cores",
    ];
  }
  return [
    "/boot", "/etc", "/bin", "/sbin", "/lib", "/lib32", "/lib64",
    "/usr/bin", "/usr/sbin", "/usr/lib", "/usr/lib32", "/usr/lib64", "/usr/share",
    "/var/lib", "/var/spool", "/var/log", "/var/run", "/run",
    "/proc/sys", "/sys", "/root", "/lost+found",
  ];
}

/** 原始设备不能通过“完全访问”获得写权限；按启动时实际存在的设备展开，避免 glob 后端差异。 */
function protectedDevicePaths(platform: NodeJS.Platform = process.platform): string[] {
  if (platform === "win32") return [];
  const fixed = ["/dev/mem", "/dev/kmem", "/dev/port", "/dev/kmsg", "/dev/mapper", "/dev/disk"];
  try {
    const dynamic = fs.readdirSync("/dev")
      .filter((name) => /^(?:disk|rdisk|sd[a-z]|nvme|vd[a-z]|xvd[a-z]|mmcblk)/.test(name))
      .map((name) => path.join("/dev", name));
    return [...fixed, ...dynamic];
  } catch {
    return fixed;
  }
}

/** 高敏凭据保留给受限认证能力，普通工具与脚本不可直接读写。 */
export function protectedCredentialPaths(platform: NodeJS.Platform = process.platform): string[] {
  const home = os.homedir();
  const common = [
    ".ssh", ".aws", ".gnupg", ".gnupg2", ".kube", ".docker",
    path.join(".config", "gcloud"), path.join(".config", "gh"),
    ".netrc", ".npmrc", ".pypirc", ".git-credentials",
    ".zshrc", ".zprofile", ".bashrc", ".bash_profile", ".profile",
    path.join(".easymint", "em-settings.json"),
    path.join(".easymint", "mcp-oauth.json"),
    path.join(".easymint", "environment.sh"),
    path.join(".easymint", ".control-tmp"),
    path.join(".easymint", "agent", "auth.json"),
  ].map((p) => path.join(home, p));
  if (platform === "darwin") common.push(path.join(home, "Library", "Keychains"));
  if (platform === "win32") {
    if (process.env.APPDATA) common.push(path.join(process.env.APPDATA, "Microsoft", "Credentials"));
    if (process.env.LOCALAPPDATA) common.push(path.join(process.env.LOCALAPPDATA, "Microsoft", "Credentials"));
  }
  return common;
}

/**
 * EasyMint 与 shell 的持久控制面。它们不一定含凭据，所以仍可由只读工具检查，
 * 但普通文件工具和沙盒进程不能改写；修改应走宿主提供的专用、结构化能力。
 */
export function protectedControlPaths(cwd: string): string[] {
  const home = os.homedir();
  return [
    path.join(home, ".easymint", "mcp.json"),
    path.join(home, ".easymint", "session-cache"),
    path.join(home, ".easymint", "system-prompts.json"),
    path.join(home, ".easymint", "agent", "settings.json"),
    path.join(home, ".easymint", "agent", "models.json"),
    path.join(home, ".config", "autostart"),
    path.join(home, ".config", "systemd"),
    path.join(home, ".config", "environment.d"),
    path.join(home, ".local", "share", "systemd"),
    path.join(home, ".pam_environment"),
    path.join(home, "Library", "LaunchAgents"),
    path.join(home, "Library", "LaunchDaemons"),
    path.join(cwd, ".easymint", "mcp.json"),
    // 兼容 Claude/OMP 的项目级 MCP 配置。EasyMint 只读它，但它会决定下次会话
    // 可以启动哪些本地进程，因此不能由 Agent 通过普通文件工具持久化修改。
    path.join(cwd, ".mcp.json"),
  ];
}

export function buildExecutionPolicy(context: Pick<ExecutionContext, "mode" | "workspaceRealPath" | "runtimeRoot">): SandboxRuntimeConfig {
  const { mode, workspaceRealPath, runtimeRoot } = context;
  const credentials = protectedCredentialPaths();
  const runtimesRoot = developmentRuntimesRoot();
  return {
    // 不启用域名过滤；文件与进程边界仍始终启用。开发服务器需要本机监听。
    network: process.platform === "darwin"
      ? ({ allowedDomains: undefined, deniedDomains: [], allowLocalBinding: true } as unknown as SandboxRuntimeConfig["network"])
      : { allowedDomains: ["*"], deniedDomains: [], allowLocalBinding: true },
    filesystem: {
      // EasyMint 自己按绝对资源保护安全边界；工作区内 .git/config 等开发文件需要正常可写。
      allowGitConfig: true,
      denyRead: mode === "standard" ? [...credentials, runtimesRoot] : credentials,
      allowRead: mode === "standard" ? [runtimeRoot] : [],
      allowWrite: mode === "full" ? filesystemRoots() : [workspaceRealPath, runtimeRoot],
      denyWrite: [
        ...protectedWriteRoots(),
        ...protectedDevicePaths(),
        ...credentials,
        ...protectedControlPaths(workspaceRealPath),
        ...(mode === "standard" ? sandboxRuntimeDefaultWriteLeaks() : []),
      ],
    },
  };
}

/** sandbox-runtime 为兼容性自动开放的宿主写路径；标准模式已有自己的运行区，不需要这些例外。 */
function sandboxRuntimeDefaultWriteLeaks(): string[] {
  const home = os.homedir();
  return [
    "/tmp/claude",
    "/private/tmp/claude",
    path.join(home, ".npm", "_logs"),
    path.join(home, ".claude", "debug"),
  ];
}

function filesystemRoots(): string[] {
  if (process.platform !== "win32") return ["/"];
  const roots = new Set<string>();
  for (const value of [process.env.SystemDrive, path.parse(os.homedir()).root]) {
    if (value) roots.add(value.endsWith("\\") ? value : `${value}\\`);
  }
  return [...roots];
}

/** 规范化用于策略提前判定；真实强制边界仍由 OS 沙盒负责。 */
export function canonicalPolicyPath(input: string, cwd: string): string {
  let expanded = input.trim();
  if (expanded === "~") expanded = os.homedir();
  else if (expanded.startsWith("~/") || expanded.startsWith("~\\")) {
    expanded = path.join(os.homedir(), expanded.slice(2));
  }
  const absolute = path.resolve(cwd, expanded);
  let cursor = absolute;
  const suffix: string[] = [];
  while (!fs.existsSync(cursor)) {
    const parent = path.dirname(cursor);
    if (parent === cursor) break;
    suffix.unshift(path.basename(cursor));
    cursor = parent;
  }
  try {
    return path.join(fs.realpathSync.native(cursor), ...suffix);
  } catch {
    return absolute;
  }
}

export function isWithin(root: string, candidate: string): boolean {
  const rel = path.relative(root, candidate);
  return rel === "" || (!rel.startsWith("..") && !path.isAbsolute(rel));
}

export function pathHitsAny(candidate: string, roots: readonly string[], cwd: string): boolean {
  const target = canonicalPolicyPath(candidate, cwd);
  return roots.some((root) => isWithin(canonicalPolicyPath(root, cwd), target));
}

export function isStandardWritableTarget(cwd: string, candidate: string): boolean {
  const workspace = canonicalPolicyPath(cwd, cwd);
  const target = canonicalPolicyPath(candidate, cwd);
  const runtime = canonicalPolicyPath(developmentRuntimeFor(workspace).root, workspace);
  return isWithin(workspace, target) || isWithin(runtime, target);
}
