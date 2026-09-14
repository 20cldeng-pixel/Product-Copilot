/**
 * Agent 权限服务。
 *
 * 安全边界由实际执行时的 OS 沙盒承担；本文件只做确定目标的提前判定、阻止提权类命令，
 * 并把不可伪造的执行策略交给工具包装层。命令中的消息、正则和脚本文本不再扫描成路径。
 */

import { ensureSandbox } from "../sandbox/manager";
import { readCache } from "../session-cache";
import { parse as parseShell } from "shell-quote";
import {
  canonicalPolicyPath,
  isStandardWritableTarget,
  pathHitsAny,
  protectedControlPaths,
  protectedCredentialPaths,
  protectedWriteRoots,
  type PermissionMode,
} from "./access-policy";
import { bindExecutionOwner, createExecutionContext, type ExecutionContext } from "./execution-context";

type PermissionBehavior = "allow" | "deny";
type PermissionUpdateDestination = "userSettings" | "projectSettings" | "localSettings" | "session" | "cliArg";
interface PermissionRuleValue { toolName: string; ruleContent?: string }
type PermissionUpdate = {
  type: "addRules" | "replaceRules" | "removeRules";
  rules: PermissionRuleValue[];
  behavior: PermissionBehavior;
  destination: PermissionUpdateDestination;
} | {
  type: "setMode";
  mode: string;
  destination: PermissionUpdateDestination;
} | {
  type: "addDirectories" | "removeDirectories";
  directories: string[];
  destination: PermissionUpdateDestination;
};
type PermissionDecisionClassification = "user_temporary" | "user_permanent" | "user_reject";

export type PermissionResult = {
  behavior: "allow";
  updatedInput?: Record<string, unknown>;
  executionPolicy?: ExecutionContext;
  updatedPermissions?: PermissionUpdate[];
  toolUseID?: string;
  decisionClassification?: PermissionDecisionClassification;
} | {
  behavior: "deny";
  message: string;
  interrupt?: boolean;
  toolUseID?: string;
  decisionClassification?: PermissionDecisionClassification;
};

export interface CanUseToolOptions {
  signal: AbortSignal;
  suggestions?: PermissionUpdate[];
  blockedPath?: string;
  decisionReason?: string;
  decisionReasonType?: string;
  classifierApprovable?: boolean;
  toolUseID: string;
  agentID?: string;
  title?: string;
  displayName?: string;
  description?: string;
}

export class AgentPermissionService {
  createCanUseTool(
    sessionId: string,
    cwd: string,
    resolveSessionId?: (sid: string) => string,
  ): (toolName: string, input: Record<string, unknown>, options: CanUseToolOptions) => Promise<PermissionResult> {
    return async (toolName, input) => {
      const sid = resolveSessionId ? resolveSessionId(sessionId) : sessionId;
      const mode = normalizeMode(readCache(sid)?.permissionMode || "auto");
      const allow = (executionPolicy?: ExecutionContext): PermissionResult => ({
        behavior: "allow",
        updatedInput: input,
        executionPolicy,
      });
      const deny = (rule: string, operation: string, target: string, detail: string): PermissionResult => ({
        behavior: "deny",
        message: [
          `操作被阻止：${detail}`,
          `模式：${mode === "full" ? "完全访问" : "标准"}`,
          `操作：${operation}`,
          `目标：${target}`,
          `规则：${rule}`,
          "阶段：执行前",
        ].join("\n"),
      });

      const name = toolName.toLowerCase();
      const explicitPaths = extractExplicitPaths(input);

      if (isReadTool(name)) {
        for (const requested of explicitPaths) {
          if (pathHitsAny(requested, protectedCredentialPaths(), cwd)) {
            return deny("core.credential_read", "read", requested, "读取高度敏感凭据");
          }
        }
        return allow();
      }

      if (isWriteTool(name)) {
        for (const requested of explicitPaths) {
          const target = canonicalPolicyPath(requested, cwd);
          if (pathHitsAny(target, [
            ...protectedWriteRoots(),
            ...protectedCredentialPaths(),
            ...protectedControlPaths(cwd),
          ], cwd)) {
            return deny("core.protected_write", "write", target, "修改系统核心或高度敏感资源（完全访问也不允许）");
          }
          if (mode === "standard" && !isStandardWritableTarget(cwd, target)) {
            return deny("standard.write_scope", "write", target, "写入工作区外文件");
          }
        }
        return allow();
      }

      if (name === "install_dependency") {
        const sandbox = await ensureSandbox(cwd);
        if (!sandbox.ok) {
          return deny("backend.sandbox_unavailable", "execute", "install_dependency", `安全执行后端不可用：${sandbox.reason}`);
        }
        return allow(bindExecutionOwner(createExecutionContext(cwd, mode), sid));
      }

      if (isShellTool(name)) {
        const command = String(input.command || "");
        if (!command.trim()) return allow();
        if (isSystemMutationCommand(command)) {
          return deny("core.privileged_operation", "execute", firstCommand(command), "执行提权或系统控制命令（完全访问也不允许）");
        }
        const sandbox = await ensureSandbox(cwd);
        if (!sandbox.ok) {
          return deny("backend.sandbox_unavailable", "execute", firstCommand(command), `安全执行后端不可用：${sandbox.reason}`);
        }
        return allow(bindExecutionOwner(createExecutionContext(cwd, mode), sid));
      }

      if (name.startsWith("mcp__") && explicitPaths.length > 0) {
        const writeLike = /(?:write|edit|create|delete|remove|move|copy|upload|update|patch|save)/.test(name);
        const readLike = /(?:read|get|list|search|find|fetch|download)/.test(name);
        for (const requested of explicitPaths) {
          const target = canonicalPolicyPath(requested, cwd);
          if (readLike && pathHitsAny(target, protectedCredentialPaths(), cwd)) {
            return deny("core.credential_read", "read", target, "读取高度敏感凭据");
          }
          if (writeLike && pathHitsAny(target, [
            ...protectedWriteRoots(),
            ...protectedCredentialPaths(),
            ...protectedControlPaths(cwd),
          ], cwd)) {
            return deny("core.protected_write", "write", target, "修改系统核心或高度敏感资源（完全访问也不允许）");
          }
          if (writeLike && mode === "standard" && !isStandardWritableTarget(cwd, target)) {
            return deny("standard.write_scope", "write", target, "写入工作区外文件");
          }
        }
      }
      return allow();
    };
  }
}

export const permissionService = new AgentPermissionService();

function normalizeMode(raw: string): PermissionMode {
  return raw === "full" || raw === "bypassPermissions" ? "full" : "standard";
}

function isReadTool(name: string): boolean {
  return name === "read" || name === "grep" || name === "find" || name === "ls" || name === "glob";
}

function isWriteTool(name: string): boolean {
  return name === "write" || name === "edit" || name === "notebookedit";
}

function isShellTool(name: string): boolean {
  return name === "bash" || name === "powershell";
}

function extractExplicitPaths(input: Record<string, unknown>): string[] {
  const keys = new Set(["file_path", "notebook_path", "path", "directory", "dir", "destination", "dest", "target", "source", "src", "file"]);
  const result: string[] = [];
  for (const [key, value] of Object.entries(input)) {
    const k = key.toLowerCase();
    if (!keys.has(k) && !k.endsWith("_path")) continue;
    if (typeof value === "string" && value.trim()) result.push(value);
    if (Array.isArray(value)) {
      for (const item of value) if (typeof item === "string" && item.trim()) result.push(item);
    }
  }
  return [...new Set(result)];
}

function firstCommand(command: string): string {
  return command.trim().split(/\s+/)[0]?.slice(0, 100) || "shell";
}

/** 明确的提权、磁盘和系统服务控制命令；文件路径保护由运行时沙盒完成。 */
export function isSystemMutationCommand(command: string): boolean {
  const alwaysMutating = new Set([
    "sudo", "su", "dd", "mkfs", "umount", "fdisk", "parted",
    "shutdown", "reboot", "halt", "poweroff",
    "csrutil", "nvram", "diskpart", "format", "bcdedit", "netsh",
    "set-executionpolicy", "format-volume", "clear-disk", "initialize-disk",
    "set-service", "stop-service", "restart-service", "new-service", "remove-service",
    "stop-computer", "restart-computer",
    // Windows PowerShell 直接暴露系统控制面，文件 ACL 不会覆盖注册表/服务管理。
    "set-itemproperty", "new-itemproperty", "remove-itemproperty", "set-mppreference",
    "add-windowscapability", "remove-windowscapability", "enable-windowsoptionalfeature",
    "disable-windowsoptionalfeature", "install-windowsfeature", "uninstall-windowsfeature",
  ]);
  const mutatingSubcommands: Record<string, Set<string>> = {
    launchctl: new Set(["bootstrap", "bootout", "enable", "disable", "kickstart", "kill", "load", "remove", "setenv", "start", "stop", "submit", "unload", "unsetenv"]),
    systemctl: new Set(["add-wants", "cancel", "daemon-reexec", "daemon-reload", "disable", "edit", "enable", "halt", "hibernate", "isolate", "kill", "link", "mask", "preset", "reboot", "reenable", "reload", "restart", "revert", "set-default", "start", "stop", "suspend", "switch-root", "unmask"]),
    service: new Set(["start", "stop", "restart", "reload", "force-reload"]),
    sc: new Set(["config", "create", "delete", "failure", "start", "stop", "pause", "continue"]),
    reg: new Set(["add", "delete", "load", "unload", "restore", "copy"]),
    diskutil: new Set(["apfs", "corestorage", "eject", "eraseDisk", "eraseVolume", "mount", "mountDisk", "partitionDisk", "randomDisk", "rename", "repairDisk", "repairVolume", "resetFusion", "unmount", "unmountDisk", "zeroDisk"].map((v) => v.toLowerCase())),
  };
  // 命令替换会在普通命令的参数求值阶段执行。shell-quote 会把双引号中的 $(...) 当成
  // 一个字符串，因此先单独提取真实会执行的子命令；单引号内的同样文本不会被提取。
  if (extractCommandSubstitutions(command).some((nested) => isSystemMutationCommand(nested))) return true;

  return splitTopLevelShellLines(command).some((segment) => inspectShellCommand(segment, alwaysMutating, mutatingSubcommands));
}

function inspectShellCommand(
  command: string,
  alwaysMutating: ReadonlySet<string>,
  mutatingSubcommands: Readonly<Record<string, ReadonlySet<string>>>,
): boolean {
  let parsed: ReturnType<typeof parseShell>;
  try {
    // shell-quote 保留控制运算符，并把引号内的 `;`、`|` 等留在普通参数中。
    // 因此提交说明、正则和 echo 文本不会再被误当成另一条命令。
    parsed = parseShell(command);
  } catch {
    // 语法错误交给真实 shell 报告；不能因为权限层猜测而制造一次误拦。
    return false;
  }

  const commandSeparators = new Set(["&&", "||", ";", ";;", "|", "|&", "&", "(", ")", "<("]);
  const redirections = new Set(["<", ">", ">>", ">&", "<&", "<<<"]);
  const reservedPrefixes = new Set(["if", "then", "elif", "else", "while", "until", "do", "time", "!", "{"]);
  let words: string[] = [];
  const inspect = (): boolean => {
    if (words.length === 0) return false;
    let index = 0;
    while (/^[A-Za-z_][A-Za-z0-9_]*=/.test(words[index] || "")) index++;
    while (reservedPrefixes.has(commandBasename(words[index] || ""))) index++;

    // 跟进真正会执行后续 argv 的包装器；普通命令的其余参数一律视为数据。
    while (index < words.length) {
      const wrapper = commandBasename(words[index] || "");
      if (!["command", "exec", "nohup", "env", "xcrun", "nice"].includes(wrapper)) break;
      index++;
      while (words[index]?.startsWith("-")) index++;
      if (wrapper === "env") while (/^[A-Za-z_][A-Za-z0-9_]*=/.test(words[index] || "")) index++;
    }

    const token = commandBasename(words[index] || "");
    if (!token) return false;
    if (alwaysMutating.has(token)) return true;
    if (token === "mount") return words.length > index + 1;
    const verbs = mutatingSubcommands[token];
    if (verbs?.has((words[index + 1] || "").toLowerCase())) return true;

    // `sh -c` / `bash -c` / `eval` 的参数确实会作为 shell 程序执行，需要递归检查。
    if (["sh", "bash", "zsh", "dash", "ksh"].includes(token)) {
      const commandIndex = words.findIndex((word, i) => i > index && word === "-c");
      const nestedCommand = commandIndex >= 0 ? words[commandIndex + 1] : undefined;
      if (nestedCommand) return isSystemMutationCommand(nestedCommand);
    }
    if (token === "eval" && words[index + 1]) return isSystemMutationCommand(words.slice(index + 1).join(" "));
    return false;
  };

  for (const entry of parsed) {
    if (typeof entry === "string") {
      words.push(entry);
      continue;
    }
    if ("comment" in entry) break;
    if (!("op" in entry) || typeof entry.op !== "string") continue;
    if (redirections.has(entry.op)) continue;
    if (!commandSeparators.has(entry.op)) continue;
    if (inspect()) return true;
    words = [];
  }
  return inspect();
}

/**
 * 抽取真正会被 shell 执行的 $(...) 和反引号内容。单引号中的字符只是数据；双引号内的
 * 命令替换依然会执行，必须检查。解析失败时宁可跳过该段并让 OS 沙盒成为最终边界。
 */
function extractCommandSubstitutions(source: string): string[] {
  const result: string[] = [];
  let quote: "single" | "double" | null = null;
  let pendingHeredocs: Array<{ delimiter: string; quoted: boolean; stripTabs: boolean }> = [];
  let activeHeredocs: Array<{ delimiter: string; quoted: boolean; stripTabs: boolean }> = [];
  for (let i = 0; i < source.length; i++) {
    const char = source[i]!;
    if (activeHeredocs.length > 0) {
      const lineEnd = source.indexOf("\n", i);
      const end = lineEnd < 0 ? source.length : lineEnd;
      const line = source.slice(i, end);
      const heredoc = activeHeredocs[0]!;
      const candidate = heredoc.stripTabs ? line.replace(/^\t+/, "") : line;
      if (candidate === heredoc.delimiter) activeHeredocs.shift();
      else if (!heredoc.quoted) result.push(...extractCommandSubstitutions(line));
      i = end;
      continue;
    }
    if (char === "\\" && quote !== "single") { i++; continue; }
    if (char === "'" && quote !== "double") { quote = quote === "single" ? null : "single"; continue; }
    if (char === '"' && quote !== "single") { quote = quote === "double" ? null : "double"; continue; }
    if (quote === "single") continue;

    if (!quote && char === "#" && (i === 0 || /[\s;|&()]/.test(source[i - 1]!))) {
      const newline = source.indexOf("\n", i);
      i = newline < 0 ? source.length : newline;
      continue;
    }
    if (!quote && char === "<" && source[i + 1] === "<") {
      const heredoc = /^(<<-?)\s*(?:'([^']+)'|"([^"]+)"|([A-Za-z_][A-Za-z0-9_]*))/.exec(source.slice(i));
      if (heredoc) {
        pendingHeredocs.push({
          delimiter: heredoc[2] ?? heredoc[3] ?? heredoc[4]!,
          quoted: !!(heredoc[2] ?? heredoc[3]),
          stripTabs: heredoc[1] === "<<-",
        });
      }
    }
    if (!quote && char === "\n" && pendingHeredocs.length > 0) {
      activeHeredocs = pendingHeredocs;
      pendingHeredocs = [];
      continue;
    }

    if (char === "$" && source[i + 1] === "(") {
      const extracted = readParenthesizedSubcommand(source, i + 2);
      if (extracted) {
        result.push(extracted.content);
        i = extracted.end;
      }
      continue;
    }
    if (char === "`") {
      const extracted = readBacktickSubcommand(source, i + 1);
      if (extracted) {
        result.push(extracted.content);
        i = extracted.end;
      }
    }
  }
  return result;
}

function readParenthesizedSubcommand(source: string, start: number): { content: string; end: number } | null {
  let depth = 1;
  let quote: "single" | "double" | null = null;
  for (let i = start; i < source.length; i++) {
    const char = source[i]!;
    if (char === "\\" && quote !== "single") { i++; continue; }
    if (char === "'" && quote !== "double") { quote = quote === "single" ? null : "single"; continue; }
    if (char === '"' && quote !== "single") { quote = quote === "double" ? null : "double"; continue; }
    if (quote) continue;
    if (char === "(") depth++;
    if (char === ")" && --depth === 0) return { content: source.slice(start, i), end: i };
  }
  return null;
}

function readBacktickSubcommand(source: string, start: number): { content: string; end: number } | null {
  for (let i = start; i < source.length; i++) {
    if (source[i] === "\\") { i++; continue; }
    if (source[i] === "`") return { content: source.slice(start, i), end: i };
  }
  return null;
}

/**
 * shell-quote 不把换行视为控制符。这里仅分割未引用的顶层换行，并跳过 heredoc 正文，
 * 因而既能发现多行脚本中的真实命令，也不会把 heredoc、提交说明或多行字符串误判为命令。
 */
function splitTopLevelShellLines(source: string): string[] {
  const result: string[] = [];
  let current = "";
  let quote: "single" | "double" | null = null;
  let pendingHeredocs: string[] = [];
  let activeHeredocs: string[] = [];
  let heredocLine = "";

  const commit = (): void => {
    if (current.trim()) result.push(current);
    current = "";
  };

  for (let i = 0; i < source.length; i++) {
    const char = source[i]!;
    if (activeHeredocs.length > 0) {
      if (char !== "\n") { heredocLine += char; continue; }
      const expected = activeHeredocs[0]!;
      if (heredocLine.replace(/^\t+/, "") === expected) activeHeredocs.shift();
      heredocLine = "";
      continue;
    }
    if (char === "\\" && quote !== "single") {
      current += char + (source[i + 1] ?? "");
      i++;
      continue;
    }
    if (char === "'" && quote !== "double") { quote = quote === "single" ? null : "single"; current += char; continue; }
    if (char === '"' && quote !== "single") { quote = quote === "double" ? null : "double"; current += char; continue; }
    if (!quote && char === "<" && source[i + 1] === "<") {
      const heredoc = /^<<-?\s*(?:'([^']+)'|"([^"]+)"|([A-Za-z_][A-Za-z0-9_]*))/.exec(source.slice(i));
      if (heredoc) pendingHeredocs.push(heredoc[1] ?? heredoc[2] ?? heredoc[3]!);
    }
    if (!quote && char === "\n") {
      commit();
      if (pendingHeredocs.length > 0) {
        activeHeredocs = pendingHeredocs;
        pendingHeredocs = [];
      }
      continue;
    }
    current += char;
  }
  commit();
  return result;
}

function commandBasename(token: string): string {
  return token.replace(/^['"]|['"]$/g, "").replace(/\\/g, "/").split("/").pop()?.toLowerCase() || "";
}

/** 保留给诊断测试；执行安全不再依赖脚本文本扫描。 */
export function scanScriptContent(content: string): string | null {
  const c = content.slice(0, 200 * 1024);
  if (/\bsudo\b|\bsu\s+-/.test(c)) return "sudo/su 提权";
  if (/\bdd\s+if=\/dev\//.test(c)) return "dd 直接写设备";
  if (/\b(?:launchctl|systemctl|diskutil|mount|umount|mkfs|fdisk|parted|csrutil|nvram)\b/.test(c)) return "系统级管理命令";
  if (/\b(?:reg\s+add|reg\s+delete|diskpart|bcdedit)\b/.test(c)) return "Windows 系统级命令";
  if (/\bformat\s+[A-Za-z]:|\bformat['"]?\s*,\s*['"]?[A-Za-z]:/.test(c)) return "Windows 系统级命令";
  return null;
}
