/**
 * EasyMint 对 sandbox-runtime 的两类补丁（postinstall 应用；`npm ci` 时自动生效）。
 *
 * ① 开发文件按名误拦
 *    EasyMint 的工作区语义允许正常编辑 IDE 与 Git 工作文件。sandbox-runtime 默认按文件名
 *    禁止 .vscode、.idea、.git/hooks 和 .git/config，会造成无法通过配置消除的误拦。
 *    不能直接关闭 mandatory deny：其中的 .mcp.json、shell rc、.gitconfig、.ripgreprc
 *    及 Claude 命令目录都能改变后续工具执行。此补丁只解除开发文件限制，保留这些可执行
 *    配置的保护；系统核心、凭据和 EasyMint 控制面仍由 access-policy 的绝对路径 deny 保护。
 *
 * ② 根路径 allowWrite 判定（Linux）—— 见下方长注释
 *
 * 依赖版本升级导致补丁锚点变化时直接失败，避免静默恢复旧行为。
 * 每条补丁各带幂等 marker：同一文件上有多条补丁时，文件级判断会互相跳过。
 */
const fs = require("node:fs");
const path = require("node:path");

const root = path.join(__dirname, "..", "node_modules", "@anthropic-ai", "sandbox-runtime", "dist", "sandbox");

const mandatoryDenyMarker = "// EasyMint: retain executable configuration protections.";
const macReplacement = `export function macGetMandatoryDenyPatterns(_allowGitConfig = false) {
    ${mandatoryDenyMarker}
    const cwd = process.cwd();
    const files = ['.gitconfig', '.bashrc', '.bash_profile', '.zshrc', '.zprofile', '.profile', '.ripgreprc', '.mcp.json'];
    const directories = ['.claude/commands', '.claude/agents'];
    const denyPaths = [
        ...files.flatMap((name) => [path.resolve(cwd, name), \`**/\${name}\`]),
        ...directories.flatMap((name) => [path.resolve(cwd, name), \`**/\${name}/**\`]),
    ];
    return [...new Set(denyPaths)];
}
const sessionSuffix`;
const linuxReplacement = `async function linuxGetMandatoryDenyPaths() {
    ${mandatoryDenyMarker}
    const cwd = process.cwd();
    const files = ['.gitconfig', '.bashrc', '.bash_profile', '.zshrc', '.zprofile', '.profile', '.ripgreprc', '.mcp.json'];
    const directories = ['.claude/commands', '.claude/agents'];
    return [
        ...files.map((name) => path.resolve(cwd, name)),
        ...directories.map((name) => path.resolve(cwd, name)),
    ];
}
// Track mount points created by bwrap`;

/**
 * ② 根路径 allowWrite 判定（仅 Linux 实现用到）
 *
 * 上游实现：`candidatePath.startsWith(allowedPath + '/')`
 * 当 allowedPath === "/" 时拼出 "//"，任何绝对路径都不匹配 → 判定恒为 false。
 *
 * 而 EasyMint 在「完全访问」模式下传的 allowWrite 正是 `["/"]`（access-policy 的 filesystemRoots
 * 在 Linux 的返回值）。于是整张 denyWrite 表被 srt 静默跳过——srt 日志原话：
 * `Skipping deny path not within allowed paths: …`——受保护凭据、系统核心路径、EasyMint 控制面
 * （~/.easymint/mcp.json 能决定下次会话启动哪些本地进程）在 shell 命令下全部可写。
 * 标准模式（allowWrite 为具体目录）判定正常，所以这个洞只在「完全访问 + Linux」下存在。
 *
 * 已核实：上游 0.0.76 与 0.0.75 的实现逐字相同（未修）；该判定在整个 dist 里只有
 * linux-sandbox-utils.js 使用（macOS seatbelt / Windows srt-win 不受影响）。
 * 这里只修根路径分支，不改其它语义。
 */
const allowWriteMarker = "// EasyMint: root-path allowWrite fix";
const allowWriteReplacement = `${allowWriteMarker}
const isWithinAnyAllowedWritePath = (candidatePath) => allowedWritePaths.some(allowedPath => (allowedPath === '/' ? candidatePath.startsWith('/') : candidatePath.startsWith(allowedPath + '/')) ||
    candidatePath === allowedPath);`;

const patches = [
  {
    file: "macos-sandbox-utils.js",
    marker: mandatoryDenyMarker,
    pattern: /export function macGetMandatoryDenyPatterns\(allowGitConfig = false\) \{[\s\S]*?\n\}\nconst sessionSuffix/,
    replacement: macReplacement,
  },
  {
    file: "linux-sandbox-utils.js",
    marker: mandatoryDenyMarker,
    pattern: /async function linuxGetMandatoryDenyPaths\([\s\S]*?\n\}\n\/\/ Track mount points created by bwrap/,
    replacement: linuxReplacement,
  },
  {
    file: "linux-sandbox-utils.js",
    marker: allowWriteMarker,
    pattern: /const isWithinAnyAllowedWritePath = \(candidatePath\) => allowedWritePaths\.some\(allowedPath => candidatePath\.startsWith\(allowedPath \+ '\/'\) \|\|\n\s*candidatePath === allowedPath\);/,
    replacement: allowWriteReplacement,
  },
];

for (const patch of patches) {
  if (!patch.replacement.includes(patch.marker)) {
    throw new Error(`补丁文本必须包含自己的 marker（否则无法幂等）：${patch.file} / ${patch.marker}`);
  }
  const target = path.join(root, patch.file);
  const source = fs.readFileSync(target, "utf8");
  if (source.includes(patch.marker)) continue;
  if (!patch.pattern.test(source)) throw new Error(`sandbox-runtime 补丁锚点失效：${patch.file}（${patch.marker}）`);
  fs.writeFileSync(target, source.replace(patch.pattern, () => patch.replacement));
  console.log(`已应用补丁：${patch.file}（${patch.marker}）`);
}
