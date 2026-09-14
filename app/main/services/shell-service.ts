import { spawn } from "child_process";
import { resolveHome } from "../utils/paths";
import { createCodingAwareDecoder } from "./background-shell/encoding";
import { isSystemMutationCommand } from "./permission/agent-permission-service";
import { ensureSandbox, wrapForSandbox } from "./sandbox/manager";
import { createExecutionContext } from "./permission/execution-context";

export interface ShellExecResult {
  code: number | null;
  stdout: string;
  stderr: string;
}

/**
 * Execute a shell command in the given working directory.
 * Streams stdout/stderr lines via callbacks, resolves with final result.
 */
/**
 * shell:exec 使用标准模式运行时策略。这里只提前拒绝明确的系统控制命令；
 * 动态路径、变量和子进程的真实 I/O 由 OS 沙盒强制限制。
 * 返回拒绝原因；null = 放行。
 */
function checkForbiddenCommand(command: string): string | null {
  const trimmed = command.trim();
  if (!trimmed) return "命令为空";
  if (isSystemMutationCommand(trimmed)) {
    return "系统级变更命令，禁止在 shell 通道执行（如需请手动在终端操作）";
  }
  return null;
}

export async function execShell(
  projectPath: string,
  command: string,
  onStdout: (line: string) => void,
  onStderr: (line: string) => void,
): Promise<ShellExecResult> {
  const denied = checkForbiddenCommand(command);
  if (denied) return { code: -1, stdout: "", stderr: denied };
  const cwd = resolveHome(projectPath);
  const sandbox = await ensureSandbox(cwd);
  if (!sandbox.ok) return { code: -1, stdout: "", stderr: `安全执行后端不可用：${sandbox.reason}` };
  let spec;
  try {
    spec = await wrapForSandbox(command, { context: createExecutionContext(cwd, "standard") });
  } catch (e) {
    return { code: -1, stdout: "", stderr: `安全执行包装失败：${(e as Error).message}` };
  }
  return new Promise((resolve) => {
    const proc = spec.kind === "argv"
      ? spawn(spec.argv[0]!, spec.argv.slice(1), { cwd, env: spec.env, shell: false })
      : spawn(spec.command, { cwd, env: spec.env, shell: true });

    let stdout = "";
    let stderr = "";
    // 流式解码（chunk 截断不乱码）；ANSI 保留原文（前端渲染彩色）
    const outDec = createCodingAwareDecoder();
    const errDec = createCodingAwareDecoder();

    proc.stdout.on("data", (chunk: Buffer) => {
      const text = outDec.feed(chunk);
      stdout += text;
      const lines = text.split("\n").filter(Boolean);
      for (const line of lines) onStdout(line);
    });

    proc.stderr.on("data", (chunk: Buffer) => {
      const text = errDec.feed(chunk);
      stderr += text;
      const lines = text.split("\n").filter(Boolean);
      for (const line of lines) onStderr(line);
    });

    proc.on("close", (code) => {
      void spec.release?.();
      resolve({ code, stdout, stderr });
    });

    proc.on("error", (err) => {
      void spec.release?.();
      resolve({ code: -1, stdout, stderr: err.message });
    });
  });
}
