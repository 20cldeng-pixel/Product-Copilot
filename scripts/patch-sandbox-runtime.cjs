/**
 * EasyMint 的工作区语义允许正常编辑 IDE 与 Git 工作文件。sandbox-runtime 默认按文件名
 * 禁止 .vscode、.idea、.git/hooks 和 .git/config，会造成无法通过配置消除的误拦。
 *
 * 不能直接关闭 mandatory deny：其中的 .mcp.json、shell rc、.gitconfig、.ripgreprc
 * 及 Claude 命令目录都能改变后续工具执行。此补丁只解除开发文件限制，保留这些可执行
 * 配置的保护；系统核心、凭据和 EasyMint 控制面仍由 access-policy 的绝对路径 deny 保护。
 *
 * 依赖版本升级导致补丁锚点变化时直接失败，避免静默恢复旧误拦行为。
 */
const fs = require("node:fs");
const path = require("node:path");

const root = path.join(__dirname, "..", "node_modules", "@anthropic-ai", "sandbox-runtime", "dist", "sandbox");
const marker = "// EasyMint: retain executable configuration protections.";
const macReplacement = `export function macGetMandatoryDenyPatterns(_allowGitConfig = false) {
    ${marker}
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
    ${marker}
    const cwd = process.cwd();
    const files = ['.gitconfig', '.bashrc', '.bash_profile', '.zshrc', '.zprofile', '.profile', '.ripgreprc', '.mcp.json'];
    const directories = ['.claude/commands', '.claude/agents'];
    return [
        ...files.map((name) => path.resolve(cwd, name)),
        ...directories.map((name) => path.resolve(cwd, name)),
    ];
}
// Track mount points created by bwrap`;
const patches = [
  {
    file: "macos-sandbox-utils.js",
    pattern: /export function macGetMandatoryDenyPatterns\(allowGitConfig = false\) \{[\s\S]*?\n\}\nconst sessionSuffix/,
    replacement: macReplacement,
  },
  {
    file: "linux-sandbox-utils.js",
    pattern: /async function linuxGetMandatoryDenyPaths\([\s\S]*?\n\}\n\/\/ Track mount points created by bwrap/,
    replacement: linuxReplacement,
  },
];

for (const patch of patches) {
  const target = path.join(root, patch.file);
  const source = fs.readFileSync(target, "utf8");
  if (source.includes(marker)) continue;
  if (!patch.pattern.test(source)) throw new Error(`sandbox-runtime 补丁锚点失效：${patch.file}`);
  fs.writeFileSync(target, source.replace(patch.pattern, patch.replacement));
}
