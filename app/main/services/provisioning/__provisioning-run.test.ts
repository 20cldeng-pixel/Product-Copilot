import { EventEmitter } from "node:events";
import { describe, expect, it, vi } from "vitest";
import { installDependencies, outputTail, type InstallEvent } from "./run";
import type { EnvItem, EnvReport } from "./types";

/** 假子进程：close 在下一个微任务里触发，模拟 spawn→退出 */
function fakeChild(code: number | null) {
  const child = new EventEmitter() as EventEmitter & {
    stdout: EventEmitter; stderr: EventEmitter; kill: (s?: string) => void;
  };
  child.stdout = new EventEmitter();
  child.stderr = new EventEmitter();
  child.kill = vi.fn();
  setTimeout(() => { child.stdout.emit("data", "installing…\n"); child.emit("close", code); }, 0);
  return child;
}

const report = (status: EnvItem["status"][], ids: EnvItem["id"][]): EnvReport => ({
  items: ids.map((id, i) => ({ id, label: id, required: true, status: status[i]!, fix: {} })),
  distro: { id: "ubuntu", autoInstallable: true },
  probedAt: 0,
});

const run = (opts: {
  code?: number | null;
  before?: EnvItem["status"][];
  after?: EnvItem["status"][];
  plan?: { argv: string[] | null; manualCommand?: string };
  signal?: AbortSignal;
}) => {
  const events: InstallEvent[] = [];
  const spawnFn = vi.fn(() => fakeChild(opts.code ?? 0));
  return {
    events,
    spawnFn,
    promise: installDependencies(
      ["bwrap", "socat", "rg"],
      (e) => events.push(e),
      {
        spawn: spawnFn as never,
        probe: async () => report(opts.after ?? ["ok", "ok", "ok"], ["bwrap", "socat", "rg"]),
        logger: () => { /* 单测不写日志文件 */ },
        plan: opts.plan ?? { argv: ["/usr/bin/pkexec", "/usr/bin/apt-get", "install", "-y", "bubblewrap"] },
      },
      opts.signal,
    ),
  };
};

describe("依赖安装执行层", () => {
  it("成功：事件按 准备→安装→复核→完成 顺序，且不重复", async () => {
    const { events, promise } = run({ code: 0 });
    const res = await promise;
    expect(res.ok).toBe(true);
    expect(events.map((e) => e.phase)).toEqual(["preparing", "installing", "verifying", "done"]);
  });

  it("命令失败：报退出码 + 给自助命令，并带上复核结果", async () => {
    const { promise } = run({ code: 100, after: ["missing", "ok", "ok"], plan: { argv: ["/usr/bin/pkexec", "/x"], manualCommand: "sudo apt install bubblewrap" } });
    const res = await promise;
    expect(res.ok).toBe(false);
    expect(res.exitCode).toBe(100);
    expect(res.reason).toContain("100");
    expect(res.manualCommand).toBe("sudo apt install bubblewrap");
  });

  it("命令成功但组件仍不可用（多为系统策略拦截）：不说“安装失败”，而是说清仍不可用", async () => {
    const { promise } = run({ code: 0, after: ["blocked", "ok", "ok"] });
    const res = await promise;
    expect(res.ok).toBe(false);
    expect(res.reason).toContain("bwrap");
    expect(res.reason).toContain("系统策略");
  });

  it("没有可用安装通道：不 spawn，直接给自助命令（不猜命令）", async () => {
    const { promise, spawnFn } = run({ plan: { argv: null, manualCommand: "sudo pacman -S bubblewrap" } });
    const res = await promise;
    expect(spawnFn).not.toHaveBeenCalled();
    expect(res.ok).toBe(false);
    expect(res.manualCommand).toBe("sudo pacman -S bubblewrap");
  });

  it("取消：终止子进程并把原因标为已取消", async () => {
    const ac = new AbortController();
    ac.abort();
    const { promise, spawnFn } = run({ code: null, after: ["missing", "missing", "missing"], signal: ac.signal });
    const res = await promise;
    const child = spawnFn.mock.results[0]!.value as { kill: ReturnType<typeof vi.fn> };
    expect(child.kill).toHaveBeenCalled();
    expect(res.reason).toBe("安装已取消");
  });
});

describe("输出尾部处理", () => {
  it("剥掉终端控制字符并截断", () => {
    const raw = `\u001b[32mok\u001b[0m\n${"x".repeat(500)}`;
    const t = outputTail(raw, 10);
    expect(t).not.toContain("\u001b");
    expect(t).toHaveLength(10);
  });
});
