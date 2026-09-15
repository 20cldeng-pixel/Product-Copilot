import path from "node:path";
import { defineConfig } from "vitest/config";

/**
 * 测试跑在 node 环境（不启 jsdom）。
 *
 * `@shared` / `@` 别名与 `app/renderer/vite.config.ts` 保持一致——渲染层组件里有**运行时**
 * 引用 `@shared/*` 的（如 `ProviderSettings` 的 `getPreset`）。此前没配别名，于是只能测那些
 * 只做 type-only 引用的组件（type 会被编译期擦除，所以一直没暴露）。别名只影响真的 import 了
 * `@shared` 的模块，不会改变既有测试的解析结果。
 */
export default defineConfig({
  resolve: {
    alias: {
      "@": path.resolve(import.meta.dirname, "app/renderer/src"),
      "@shared": path.resolve(import.meta.dirname, "app/shared"),
    },
  },
  test: {
    globals: true,
    environment: "node",
    include: ["app/**/*.test.ts"],
  },
});
