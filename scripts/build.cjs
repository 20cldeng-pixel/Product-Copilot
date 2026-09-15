#!/usr/bin/env node
/**
 * 主进程 / 预加载的 esbuild 构建定义——dev 与生产共用的单一真相源。
 *
 * 此前 dev（scripts/dev-electron.cjs）与生产（package.json 的 build:main 命令行）
 * 各维护一份 external 清单：xlsx→exceljs 替换时只改了生产那份，dev 产物把
 * zod/exceljs 整包打进去（2.4MB vs 884KB）。清单只此一份、两处引用，杜绝漂移。
 *
 * 用法：node scripts/build.cjs <main|preload>；main 同时生成 Windows 沙盒 worker。
 */
const path = require("node:path");
const esbuild = require("esbuild");

const ROOT = path.join(__dirname, "..");

/**
 * 不打包进 bundle、运行时从 node_modules 加载的依赖：
 * - ESM-only / 原生包（sandbox-runtime、archiver）——CJS bundle 里 require 会崩，必须外部化
 * - 体积大且无需打包的（zod、exceljs、pdf-parse 等）
 * 约束：external 化的包必须存在于生产包的 node_modules（electron-builder 按 dependencies 打包）。
 */
const EXTERNALS = [
  "electron",
  "@anthropic-ai/sandbox-runtime",
  "@earendil-works/pi-coding-agent",
  "@earendil-works/pi-agent-core",
  "@earendil-works/pi-ai",
  "@earendil-works/pi-ai/compat",
  "@modelcontextprotocol/sdk",
  "@modelcontextprotocol/sdk/*",
  "electron-updater",
  "@aws-sdk/*",
  "archiver",
  "unzipper",
  "pdf-parse",
  "mammoth",
  "exceljs",
  "dompurify",
  "zod",
  "jszip",
  // mDNS 设备发现（network-service 专用）。它自身 + ws/dns-packet/multicast-dns 依赖树
  // 约占 bundle 225KB（22%）——是主进程里最大的第三方来源。纯 CJS、无原生扩展，
  // 外部化后运行时从 node_modules 加载（已核实其在 electron-builder 产物内）
  "bonjour-service",
];

function mainOptions(overrides = {}) {
  return {
    entryPoints: [path.join(ROOT, "app/main/index.ts")],
    bundle: true, platform: "node", format: "cjs",
    outfile: path.join(ROOT, "app/main/dist/main.cjs"),
    external: EXTERNALS,
    ...overrides,
  };
}

function preloadOptions(overrides = {}) {
  return {
    entryPoints: [path.join(ROOT, "app/preload/index.ts")],
    bundle: true, platform: "node", format: "cjs",
    outfile: path.join(ROOT, "app/preload/dist/preload.cjs"),
    external: ["electron"],
    ...overrides,
  };
}

function windowsSandboxWorkerOptions(overrides = {}) {
  return {
    entryPoints: [path.join(ROOT, "app/main/services/sandbox/windows-sandbox-worker.ts")],
    bundle: true, platform: "node", format: "cjs",
    outfile: path.join(ROOT, "app/main/dist/windows-sandbox-worker.cjs"),
    external: EXTERNALS,
    ...overrides,
  };
}

module.exports = { EXTERNALS, mainOptions, preloadOptions, windowsSandboxWorkerOptions, reportOversize };

/**
 * esbuild 会给 **≥ 1 MiB** 的产物加 ⚠️。出处：esbuild `internal/logger/logger.go`
 * `const sizeWarningThreshold = 1024 * 1024`，其上注释原文 "Show a warning icon next to output
 * files that are 1mb or larger"。**纯展示层**——加个图标 + 把大小数字由青色改黄色
 * （另在 Windows CMD 下不显示 emoji），既不拦截构建也不改产物；本仓库另经二分实测复核过边界
 * （1023KB 无 / 1024KB 有）。
 *
 * 它只报大小、不报来源——dev 里看到一个 `[1] app/main/dist/main.cjs 1.0mb ⚠️` 无从下手。
 * 这里在构建后补一行"谁贡献的"，只在越线时输出（不越线完全静默）。
 *
 * 处置顺序（各手段的收益 2026-09-15 均实测过，明细见 docs/开发记录/2026-09-15.md）：
 * ① 大头是纯 JS 第三方依赖 → 加进 EXTERNALS，这是**唯一高性价比**的手段（node_modules 本就在
 *    安装包里，等于零成本搬家）。前提：在 dependencies 里、且在 electron-builder 产物 node_modules
 *    内，可用 @electron/asar 的 listPackage() 核验
 * ② 大头是自身代码 → 资源外置（大段文本改运行时读）或多入口拆分，没有配置级捷径：
 *    - minify 能把体积砍 41%（938KB→553KB），但换算到启动**只省约 1.8ms**（冷启动一次性：
 *      926KB 7.6ms → 553KB 5.8ms，独立进程实测），代价是生产堆栈不可读 → 非必要不开
 *    - esbuild 的 `splitting` **只支持 ESM 输出**（官方文档明示），本 CJS 主进程用不了，别白试
 * ③ 都不值得做 → 接受它。这只是提示线不是门禁：正常长大到 1MB 没问题，
 *    只有**突增**（如 1MB→5MB）才说明有东西被误打包进来，那才是要查的
 */
const SIZE_LIMIT = 1024 * 1024;

function reportOversize(results) {
  for (const r of [].concat(results)) {
    if (!r?.metafile) continue;
    for (const [out, info] of Object.entries(r.metafile.outputs)) {
      if (info.bytes < SIZE_LIMIT) continue;
      const top = Object.entries(info.inputs)
        .sort((a, b) => b[1].bytesInOutput - a[1].bytesInOutput)
        .slice(0, 3)
        .map(([f, v]) => `${path.relative(ROOT, f)}  ${(v.bytesInOutput / 1024).toFixed(0)}KB`);
      const mb = info.bytes / 1024 / 1024;
      const limitMb = SIZE_LIMIT / 1024 / 1024;
      console.log(
        `\n[build] ${path.relative(ROOT, out)} 已达 ${mb.toFixed(2)}MB，越过体积提示线 ${limitMb.toFixed(2)}MB` +
          `（esbuild 自身在 ≥1MiB 时会给它加 ⚠️）。贡献前三：\n  ${top.join("\n  ")}`,
      );
    }
  }
}

// ── CLI：node scripts/build.cjs <main|preload> ──
if (require.main === module) {
  const target = process.argv[2];
  let options = null;
  if (target === "main") {
    Promise.all([
      esbuild.build(mainOptions({ logLevel: "info", metafile: true })),
      esbuild.build(windowsSandboxWorkerOptions({ logLevel: "info", metafile: true })),
    ]).then(reportOversize).catch((e) => {
      console.error("[build] 构建失败:", e.message);
      process.exit(1);
    });
    return;
  }
  else if (target === "preload") options = preloadOptions({ logLevel: "info" });

  if (!options) {
    console.error("[build] 用法: node scripts/build.cjs <main|preload>");
    process.exit(1);
  }
  esbuild.build(options).catch((e) => {
    console.error("[build] 构建失败:", e.message);
    process.exit(1);
  });
}
