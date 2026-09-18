import { describe, it, expect, vi } from "vitest";
import { readFileSync, readdirSync, existsSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { getResourcesDir } from "../utils/paths";

vi.mock("electron", () => ({ app: { isPackaged: false, getPath: () => os.tmpdir() } }));

/**
 * 品牌库是**内置 skill**（不再按项目播种）——本文件锚住这条链路的每一环。
 *
 * 覆盖的脆弱点（每一环断了都会让品牌库静默失效，而模型只是"用不到品牌"、不会报错）：
 *   scanDir 扫不到 / frontmatter description 为空被 hasDescription 滤掉 / `<location>`（filePath）
 *   指错 → 子 Agent 拼不出绝对路径 / 被 EM_SKILLS 之外的同名项顶替 / 忘了重新生成 brands.md /
 *   有人把 extraResources 那条加回来（等于又拷一份进包）。
 *
 * 为什么子 Agent 侧特别要盯 `<location>`：委派出来的 mint-designer **没有 use_skill 工具**
 * （task/executor 只给 read/write/edit/bash/grep/glob），它定位技能目录的唯一依据就是
 * system prompt 里 `<available_skills>` 的 `<location>`（Pi 会把 skill 内相对路径按该目录解析）。
 */
const RESOURCES = getResourcesDir();
const REPO_ROOT = path.resolve(RESOURCES, "..");
const SKILL_DIR = path.join(RESOURCES, "skills", "brand-tokens");
const BRANDS_DIR = path.join(SKILL_DIR, "brands");
const BRANDS_INDEX = path.join(SKILL_DIR, "brands.md");

const brandDirNames = (): string[] =>
  readdirSync(BRANDS_DIR, { withFileTypes: true })
    .filter((e) => e.isDirectory())
    .map((e) => e.name)
    .sort();

describe("brand-tokens 内置 skill", () => {
  it("可被 scanSkills 扫到，且描述非空（空描述会被 hasDescription 滤掉，模型就看不到它）", async () => {
    const { scanSkills } = await import("./skill-service");
    const s = scanSkills().find((x) => x.name === "brand-tokens");

    expect(s, "resources/skills/brand-tokens/SKILL.md 没被扫到：目录名或 frontmatter 写错了？").toBeDefined();
    expect(s!.level).toBe("builtin");
    expect(s!.source).toBe("builtin");
    expect(s!.path).toBe(SKILL_DIR);
    expect(s!.description.trim()).not.toBe("");
    expect(s!.description).not.toBe("(无描述)");
  });

  it("toPiSkill 的 filePath/baseDir 就是模型看到的 <location> 与技能目录", async () => {
    const { scanSkills, toPiSkill } = await import("./skill-service");
    const s = scanSkills().find((x) => x.name === "brand-tokens")!;
    const pi = toPiSkill(s);

    expect(pi.filePath).toBe(path.join(SKILL_DIR, "SKILL.md"));
    expect(pi.baseDir).toBe(SKILL_DIR);
  });

  it("会并入会话的 skill 列表；同名原生项优先（不重复注入）", async () => {
    const { scanSkills, mergeIntoPiSkills } = await import("./skill-service");
    const s = scanSkills().find((x) => x.name === "brand-tokens")!;
    // 显式断言前置条件：em-settings.json 的 hiddenSkills 里若加了它，品牌库就静默失效
    // （这是用户在 Skill 管理界面的合法开关，不是代码 bug —— 失败了看这条消息即可判断）
    expect(s.enabled, "brand-tokens 被 hiddenSkills 隐藏了 → 会话里不会注入，品牌库失效").toBe(true);

    expect(mergeIntoPiSkills(undefined, []).some((x) => x.name === "brand-tokens")).toBe(true);
    expect(mergeIntoPiSkills(undefined, [{ name: "brand-tokens" }]).some((x) => x.name === "brand-tokens")).toBe(false);
  });

  it("SKILL.md 引用的品牌规范真实存在（路径层级搬错就会红）", () => {
    for (const brand of ["apple", "linear.app", "slack"]) {
      expect(existsSync(path.join(BRANDS_DIR, brand, "DESIGN.md")), `${brand}/DESIGN.md 缺失`).toBe(true);
    }
    // SKILL.md 里给出的相对路径必须与真实布局一致
    const body = readFileSync(path.join(SKILL_DIR, "SKILL.md"), "utf-8");
    expect(body).toContain("./brands/<品牌>/DESIGN.md");
    expect(body).toContain("./brands.md");
  });
});

describe("EM_SKILLS 注册", () => {
  it("brand-tokens 在 EM_SKILLS 里（只注入、从不落盘；且外部同名项会被标 shadowed）", async () => {
    const { EM_SKILLS } = await import("./skill-service");
    expect(EM_SKILLS).toContain("brand-tokens");
  });

  it("每个 EM_SKILLS 名字都有对应的资源目录与 SKILL.md", async () => {
    const { EM_SKILLS } = await import("./skill-service");
    for (const name of EM_SKILLS) {
      expect(existsSync(path.join(RESOURCES, "skills", name, "SKILL.md")), `EM_SKILLS 里的 ${name} 没有资源`).toBe(true);
    }
  });

  it("EM_SKILLS 与 BUNDLED_SKILLS 不相交（BUNDLED 会被拷到 ~/.easymint/skills，品牌库不能走那条）", async () => {
    const { EM_SKILLS, BUNDLED_SKILLS } = await import("./skill-service");
    const bundled = new Set<string>(BUNDLED_SKILLS);
    expect(EM_SKILLS.filter((n: string) => bundled.has(n))).toEqual([]);
  });
});

describe("brands.md 清单", () => {
  it("每个品牌目录都被列出，且数量与目录数一致", () => {
    const names = brandDirNames();
    expect(names.length).toBeGreaterThan(0);
    const md = readFileSync(BRANDS_INDEX, "utf-8");

    for (const n of names) {
      expect(md, `brands.md 少了 ${n} —— 品牌目录变动后要跑 npm run gen:brands`).toContain(`**${n}**`);
    }
    expect(md).toContain(`共 ${names.length} 个品牌`);
  });
});

describe("打包配置", () => {
  const pkg = JSON.parse(readFileSync(path.join(REPO_ROOT, "package.json"), "utf-8"));

  it("extraResources 里没有独立的 brand-tokens 项（它随 resources/skills 一起进包，别再拷第二份）", () => {
    const froms = (pkg.build.extraResources as Array<{ from: string }>).map((e) => e.from);
    expect(froms).toContain("resources/skills");
    expect(froms.some((f) => f.includes("brand-tokens"))).toBe(false);
  });

  it("mac.signIgnore 指向新路径（linear.app 以 .app 结尾会被 codesign 当 bundle）", () => {
    expect(pkg.build.mac.signIgnore).toContain("skills/brand-tokens/brands/linear.app");
  });
});
