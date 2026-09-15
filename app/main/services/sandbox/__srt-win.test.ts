import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { packagedSrtVersion, srtWinSpawn } from "./srt-win";

/** 假 srt 模块：只提供我们用到的那两个公开量（真模块同样从包根导出它们） */
function fakeSrt(exe: string) {
  const resolveSrtWin = vi.fn((cfg: { path: string }) => ({ exe: cfg.path, prependArgs: ["--srt-win"] }));
  return { mod: { VENDORED_SRT_WIN_EXE: exe, resolveSrtWin } as never, resolveSrtWin };
}

describe("Windows：srt-win spawn 规格（不传该参数时 srt 必抛 no srt-win path configured）", () => {
  it("把包内 vendored exe 交给 srt 自己的 resolveSrtWin —— 不手拼 prependArgs", () => {
    const { mod, resolveSrtWin } = fakeSrt("/pkg/vendor/srt-win/x64/srt-win.exe");

    expect(srtWinSpawn(mod)).toEqual({
      exe: "/pkg/vendor/srt-win/x64/srt-win.exe",
      prependArgs: ["--srt-win"],
    });
    // 钉住"走 srt 的解析"这件事：`--srt-win` 是 srt 的内部常量，我们写死就会随上游改动失效
    expect(resolveSrtWin).toHaveBeenCalledWith({ path: "/pkg/vendor/srt-win/x64/srt-win.exe" });
  });
});

describe("包内 srt 版本（供手动命令钉版本，不写死第二处）", () => {
  const dirs: string[] = [];
  afterEach(() => {
    for (const d of dirs) rmSync(d, { recursive: true, force: true });
    dirs.length = 0;
  });

  /** 造出 `<root>/vendor/srt-win/x64/srt-win.exe` 的目录形状 */
  function fixture(version: string | null): string {
    const root = mkdtempSync(path.join(os.tmpdir(), "srt-ver-"));
    dirs.push(root);
    if (version !== null) {
      writeFileSync(path.join(root, "package.json"), JSON.stringify({ version }));
    }
    mkdirSync(path.join(root, "vendor", "srt-win", "x64"), { recursive: true });
    return path.join(root, "vendor", "srt-win", "x64", "srt-win.exe");
  }

  it("从 vendor 路径上溯三层（<arch> → srt-win → vendor）读包根 package.json 的 version", () => {
    expect(packagedSrtVersion(fakeSrt(fixture("0.0.75")).mod)).toBe("0.0.75");
  });

  it("读不到（文件缺失）时返回 undefined —— 调用方退化为不钉版本，且不抛", () => {
    expect(packagedSrtVersion(fakeSrt(fixture(null)).mod)).toBeUndefined();
    expect(packagedSrtVersion(fakeSrt("/nowhere/srt-win.exe").mod)).toBeUndefined();
  });
});
