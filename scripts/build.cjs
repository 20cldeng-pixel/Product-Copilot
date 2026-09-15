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
 * esbuild 会给 **≥ 1 MiB** 的产物加 ⚠️（实测边界：1023KB 无、1024KB 有）。它只报大小、
 * 不报来源——dev 里看到一个 `[1] app/main/dist/main.cjs 1.0mb ⚠️` 无从下手。
 * 这里在构建后补一行"谁贡献的"，只在越线时输出（不越线完全静默）。
 *
 * 处置顺序：① 若大头是纯 JS 第三方依赖 → 加进 EXTERNALS（前提：在 dependencies 里，
 * 且在 electron-builder 产物 node_modules 内，可用 @electron/asar 核验）
 * ② 若大头是自身代码 → 考虑拆入口或把大段文本资源外置 ③ 都不可行再看是否需要放宽
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
