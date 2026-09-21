import { spawn, type ChildProcess, type SpawnOptions } from "node:child_process";

const PAYLOAD_KEY = "EASYMINT_PROCESS_GUARDIAN_PAYLOAD";

/**
 * Unix 命令守护进程。
 *
 * 主进程通过 stdin 管道持有守护进程；主进程正常退出或被 SIGKILL 后，管道会由内核关闭，
 * 守护进程随即终止自己所在的进程组。实际 shell 与其后代继承该进程组，因此不会在
 * Electron 已死亡后继续写文件或占用端口。
 */
export const UNIX_PARENT_GUARDIAN_SCRIPT = String.raw`
const { spawn } = require("node:child_process");
const key = "${PAYLOAD_KEY}";
let payload;
try { payload = JSON.parse(Buffer.from(process.env[key] || "", "base64").toString("utf8")); }
catch (error) { console.error("[process-guardian] invalid payload", error); process.exit(127); }
const env = { ...process.env };
delete env[key];
delete env.ELECTRON_RUN_AS_NODE;
const command = spawn(payload.file, payload.args, {
  cwd: process.cwd(), env, shell: payload.shell === true, detached: false,
  stdio: ["ignore", "pipe", "pipe"], windowsHide: true,
});
command.stdout.pipe(process.stdout);
command.stderr.pipe(process.stderr);
let completed = false;
const killGroup = () => {
  if (completed) return;
  try { process.kill(-process.pid, "SIGKILL"); }
  catch { try { command.kill("SIGKILL"); } catch {} process.exit(137); }
};
process.stdin.resume();
process.stdin.once("end", killGroup);
process.stdin.once("close", killGroup);
command.once("error", (error) => { completed = true; console.error("[process-guardian] spawn failed", error); process.exit(127); });
command.once("exit", (code, signal) => {
  completed = true;
  process.stdin.pause();
  process.exit(code == null ? (signal ? 128 : 1) : code);
});
`;

export function spawnWithParentGuardian(
  file: string,
  args: readonly string[],
  options: SpawnOptions,
): ChildProcess {
  if (process.platform === "win32") return spawn(file, args, options);
  const payload = Buffer.from(JSON.stringify({ file, args, shell: options.shell === true }), "utf8").toString("base64");
  return spawn(process.execPath, ["-e", UNIX_PARENT_GUARDIAN_SCRIPT], {
    ...options,
    shell: false,
    detached: true,
    stdio: ["pipe", "pipe", "pipe"],
    env: {
      ...(options.env ?? process.env),
      [PAYLOAD_KEY]: payload,
      // 打包后的 process.execPath 是 Electron；该开关让它作为普通 Node 守护进程运行。
      ELECTRON_RUN_AS_NODE: "1",
    },
  });
}
