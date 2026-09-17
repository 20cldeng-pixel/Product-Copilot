/**
 * 系统提示词动态 section 构建 — 借鉴 cc 的 section 组装思想。
 *
 * 稳定核心(MINT_SYSTEM_PROMPT)保持静态;此模块按项目运行时信息构建动态段,
 * 在 buildSystemPrompt 拼装时附加(会话创建时一次)。
 */

import { existsSync, readFileSync } from "node:fs";
import path from "node:path";

/** 是否 git 仓库(检测 .git 目录) */
function isGitRepo(projectPath: string): boolean {
  try {
    return existsSync(path.join(projectPath, ".git"));
  } catch {
    return false;
  }
}

/** 平台显示名 */
function platformLabel(): string {
  if (process.platform === "darwin") return "macOS";
  if (process.platform === "win32") return "Windows";
  if (process.platform === "linux") return "Linux";
  return process.platform;
}

/**
 * # 项目环境 段 — 会话内稳定真相(工作目录/git/平台),快照式注入。
 * 借鉴 cc computeSimpleEnvInfo:只放稳定值,变化细节不在此。
 */
export function buildProjectEnvSection(projectPath: string): string {
  return [
    "\n## 项目环境",
    `- 工作目录: ${projectPath}`,
    `- 是否 Git 仓库: ${isGitRepo(projectPath) ? "是" : "否"}`,
    `- 平台: ${platformLabel()}`,
  ].join("\n");
}

/**
 * # 项目类型规范 段 — 按项目产品形态注入开发规范基线(web/桌面/CLI 等)。
 * @param platformSpec detectProfile/composeProfile 产物的 platformSpec 文本
 */
export function buildProjectProfileSection(platformSpec?: string): string {
  if (!platformSpec) return "";
  return `\n## 项目类型规范\n${platformSpec.trim()}`;
}

/** 读取项目持久化的 platformSpec(NewProjectDialog 创建时写入 .easymint/project-profile.json);失败返回 undefined */
export function readProjectProfile(projectPath: string): string | undefined {
  try {
    const f = path.join(projectPath, ".easymint", "project-profile.json");
    if (!existsSync(f)) return undefined;
    const data = JSON.parse(readFileSync(f, "utf-8")) as { platformSpec?: unknown };
    return typeof data.platformSpec === "string" && data.platformSpec.length > 0 ? data.platformSpec : undefined;
  } catch {
    return undefined;
  }
}

/**
 * 权限边界提示词段（主会话与子 Agent 共用）。
 * 只写基本概念：绝对禁区（两模式共同、不可变）+ 两模式的定义。
 * 不写「当前处于哪个模式」——模式会随用户切换变化，写死会过时误导；
 * 当前模式以系统反馈为准：操作被拒时错误信息会说明原因（标准限制 / 禁区），据此应对。
 * 权限摘要与 access-policy.ts 的资源语义保持一致，不在提示词复制完整路径清单。
 */
export const PERMISSION_RULES_PROMPT = `<permission_rules>
权限由系统在后台强制执行，你无需在执行前询问用户。
- 绝对禁止（任何模式）：修改系统核心与系统安全控制面（系统目录、磁盘设备、内核扩展，以及关闭 Gatekeeper/防火墙/FileVault 这类安全机制的开关）；提权；改写会自动执行代码的持久化配置（MCP 配置、开机自启目录、EasyMint 的模型与供应商设置）。这些限制在完全访问中也不会关闭。
- 受限模式：在标准模式的全部边界之上再叠加系统级沙盒（用户为"跑来源不明的项目"选的）。**浏览器与浏览器自动化（Playwright）不可用、无法管理其它命令启动的进程、open 打不开**——这是沙盒机制决定的，不是故障，不要反复重试或试图绕过；需要这些能力时请用户切到标准或完全访问。
- 标准模式：完整读写当前工作空间和该项目专属开发运行区；依赖缓存、用户级工具安装、运行配置和临时目录会自动放在运行区；可读取并执行宿主工具链与 SDK，也可读取项目外普通文件。命令在运行时安全边界内执行——越界写入（工作区与运行区之外）、读取高度敏感凭据、提权与系统核心改动会被执行前判定直接拒绝。开发环境是本项目专属的：依赖本机登录态的工具（gh、git push、gcloud）在此模式下用不了，需要时请让用户切到完全访问。
- 完全访问：用宿主真实环境执行——系统命令、进程管理、打开浏览器与浏览器自动化（Playwright）、gh / git push 都能用；不受工作区和普通开发路径限制，不询问日常文件或命令权限，可读写系统核心与高度敏感资源之外的普通位置，包括桌面、文档、下载和外部项目。
- 上面第一条的绝对禁区在两种模式下都由执行前判定拦截（写系统核心/磁盘设备/持久化配置、提权与关闭安全机制的命令会被直接拒绝）——这是设计而非误伤：不要尝试绕过，也不要反复重试。
- 命令中的消息、正则、提交说明和普通文本不会被当成路径；越界 I/O 会在执行前被判定拦下。
</permission_rules>`;
