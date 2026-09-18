import { describe, it, expect, vi } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, existsSync, readFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";

vi.mock("electron", () => ({ app: { isPackaged: false, getPath: () => os.tmpdir() } }));

/**
 * 播种是「委派 mint-designer 也能拿到种子模板」的关键一环（2026-09-16 补的洞）：
 * 此前只在主会话以 designer 类型启动时播种，委派路径永不播种，
 * 子 Agent 于是开局去翻一个不存在的 .easymint/templates/。
 *
 * 品牌库已改为内置 skill（resources/skills/brand-tokens/），**不再播种**——见
 * __brand-skill.test.ts。本文件的反向断言就是防它被加回来。
 */
describe("ensureDesignerTemplates", () => {
  const newProject = (): string => mkdtempSync(path.join(os.tmpdir(), "em-designer-seed-"));

  it("只把 4 个种子模板播进项目 .easymint/，品牌库不再落盘", async () => {
    const { ensureDesignerTemplates } = await import("./designer-seed");
    const { DESIGNER_TEMPLATE_FILES } = await import("../../shared/designer-templates");
    const project = newProject();

    ensureDesignerTemplates(project);

    for (const f of DESIGNER_TEMPLATE_FILES) {
      const p = path.join(project, ".easymint", "templates", f);
      expect(existsSync(p), `${f} 应该被播进项目`).toBe(true);
      // 内容来自 resources/em-html-editor/（非空，且是 HTML）
      expect(readFileSync(p, "utf-8")).toContain("<");
    }
    // 反向锚定：品牌库已改为内置 skill，项目里重新出现这个目录就是回退
    expect(existsSync(path.join(project, ".easymint", "brand-tokens"))).toBe(false);
    expect(existsSync(path.join(project, ".easymint", "templates"))).toBe(true);
  });

  it("重复调用是幂等的，且不覆盖项目里已存在的模板（用户改过的要留住）", async () => {
    const { ensureDesignerTemplates } = await import("./designer-seed");
    const project = newProject();
    const dest = path.join(project, ".easymint", "templates");
    mkdirSync(dest, { recursive: true });
    writeFileSync(path.join(dest, "template-landing.html"), "<!-- 用户改过的 -->", "utf-8");

    ensureDesignerTemplates(project);
    ensureDesignerTemplates(project);

    expect(readFileSync(path.join(dest, "template-landing.html"), "utf-8")).toBe("<!-- 用户改过的 -->");
    // 同批其余文件仍会被补齐
    expect(existsSync(path.join(dest, "template-dashboard.html"))).toBe(true);
  });

  it("项目路径为空/异常也不抛（播种失败不该拦住设计任务）", async () => {
    const { ensureDesignerTemplates } = await import("./designer-seed");
    expect(() => ensureDesignerTemplates("\u0000bad\u0000path")).not.toThrow();
  });
});
