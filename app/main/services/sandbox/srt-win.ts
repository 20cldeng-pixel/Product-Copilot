/**
 * Windows 专用：srt 的 `srt-win.exe` 路径注入 + 包内版本读取。
 *
 * **为什么需要这个模块（2026-09-15 用户实测踩到）**：
 * srt 的 `checkWindowsSandboxStatusAsync()` / `installWindowsSandbox()` / `uninstallWindowsSandbox()`
 * 内部都是 `opts.srtWin ?? resolveSrtWin()`，而**无参** `resolveSrtWin()` 必抛：
 *
 *     WindowsSandboxError: no srt-win path configured; set windows.srtWin.path
 *
 * （本机实测复现，与平台无关的代码路径；上游注释也写着 "Production callers set
 * `windows.srtWin.path`"）。只有 `SandboxManager.initialize(cfg)` 那条路径是从 config 的
 * `windows.srtWin.path` 读——所以「沙盒里跑命令」是好的，而**「环境检测 / 一键安装」在
 * Windows 上必失败**：两处调用没传这个参数，异常各自掉进 catch，界面于是显示"检测失败"与兜底文案。
 *
 * 安全/一致性：只使用 srt 自己导出的公开量，不手拼——
 * `prependArgs` 里的 `--srt-win` 是 srt 内部常量，由 `resolveSrtWin({ path })` 给出；
 * 我们若写死它，上游一改就静默失效。
 *
 * 两种形态别混：`SandboxManager.initialize(cfg)` 要的是 **config 形态**（`cfg.windows.srtWin.path`，
 * 见 `windows-sandbox-worker.ts`）；而 status / install / uninstall 三个接口要的是
 * **spawn 规格**（`{ exe, prependArgs }`）——就是本模块的 `srtWinSpawn()` 产出的那个。
 */
import fs from "node:fs";
import path from "node:path";
import type { SrtWinSpawn } from "@anthropic-ai/sandbox-runtime";

type SrtModule = typeof import("@anthropic-ai/sandbox-runtime");

/** status / install / uninstall 三类接口需要的 `srtWin` 参数（用 `{ srtWin: srtWinSpawn(srt) }` 传入） */
export function srtWinSpawn(srt: SrtModule): SrtWinSpawn {
  return srt.resolveSrtWin({ path: srt.VENDORED_SRT_WIN_EXE });
}

/**
 * 本应用实际打包的 srt 版本——用于把手动安装命令钉到同一版本。
 *
 * 不钉版本的话，用户 npx 拉到的是 registry 上的 latest（可能比包内那份新），装配出来的
 * 状态未必与包内这套的判定口径一致；而版本号若在代码里再写一份，就和 package.json 两处漂移
 * （本仓库栽过：external 清单两份互相漂移）。故这里从 srt 包自己的 package.json 读：
 * `VENDORED_SRT_WIN_EXE` = `<包根>/vendor/srt-win/<arch>/srt-win.exe`，其所在目录上溯三层
 * （`<arch>` → `srt-win` → `vendor`）即包根。
 * 读不到返回 undefined（调用方退化为"不钉版本"），绝不抛。
 */
export function packagedSrtVersion(srt: SrtModule): string | undefined {
  try {
    const pkgPath = path.join(path.dirname(srt.VENDORED_SRT_WIN_EXE), "..", "..", "..", "package.json");
    const parsed = JSON.parse(fs.readFileSync(pkgPath, "utf-8")) as { version?: unknown };
    const v = parsed.version;
    return typeof v === "string" && v.length > 0 ? v : undefined;
  } catch {
    return undefined;
  }
}
