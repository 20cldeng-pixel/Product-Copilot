import { afterEach, describe, expect, it } from "vitest";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { UNIX_PARENT_GUARDIAN_SCRIPT } from "./process-guardian";

const fixtures: string[] = [];
afterEach(() => { for (const dir of fixtures.splice(0)) rmSync(dir, { recursive: true, force: true }); });

const exists = (file: string): boolean => {
  try { readFileSync(file); return true; } catch { return false; }
};

async function waitFor(predicate: () => boolean, timeoutMs = 5_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error("等待条件超时");
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
}

describe.skipIf(process.platform === "win32")("Unix parent process guardian", () => {
  it("kills the foreground shell group when its owning host is SIGKILLed", async () => {
    const cwd = mkdtempSync(path.join(tmpdir(), "process-guardian-")); fixtures.push(cwd);
    const before = path.join(cwd, "written-before-host-kill");
    const after = path.join(cwd, "written-after-host-kill");
    const payloadKey = "EASYMINT_PROCESS_GUARDIAN_PAYLOAD";
    const command = `touch ${JSON.stringify(before)}; sleep 2; touch ${JSON.stringify(after)}`;
    const payload = Buffer.from(JSON.stringify({ file: command, args: [], shell: true }), "utf8").toString("base64");
    const hostSource = `
      const { spawn } = require("node:child_process");
      const child = spawn(process.execPath, ["-e", ${JSON.stringify(UNIX_PARENT_GUARDIAN_SCRIPT)}], {
        cwd: ${JSON.stringify(cwd)}, detached: true, stdio: ["pipe", "ignore", "ignore"],
        env: { ...process.env, ${payloadKey}: ${JSON.stringify(payload)}, ELECTRON_RUN_AS_NODE: "1" },
      });
      child.once("spawn", () => process.stdout.write("ready\\n"));
      setInterval(() => {}, 60_000);
    `;
    const host = spawn(process.execPath, ["-e", hostSource], { stdio: ["ignore", "pipe", "pipe"] });
    await waitFor(() => exists(before));
    host.kill("SIGKILL");
    await new Promise((resolve) => setTimeout(resolve, 2_500));
    expect(exists(before)).toBe(true);
    expect(exists(after)).toBe(false);
  }, 10_000);
});
