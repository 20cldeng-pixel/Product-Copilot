#!/usr/bin/env node
/**
 * 品牌清单生成器：从 `resources/skills/brand-tokens/brands/<品牌>/DESIGN.md` 抽出每个品牌的一句话
 * 描述，生成 `resources/skills/brand-tokens/brands.md`（内置 skill 的清单资源）。
 *
 * 为什么需要：品牌库是内置 skill，提示词里**不能**硬编码品牌数量或清单（历史上 `prompts.ts` 写死
 * 过"74 个品牌"，与资源一解耦就开始漂）。清单改由本脚本从资源生成，`brands.md` 入库，
 * `--check` 挂进 `npm run lint` —— 资源变了但忘了重新生成，CI 直接红。
 *
 * 描述来源（**不要以 README.md 为源**：那是跳转样板，只有一行 `Design system details have been
 * moved to: https://getdesign.md/<brand>/design-md`，没有品牌信息）：
 *   1. `DESIGN.md` frontmatter 的 `description:` —— 单行（可用双引号包裹）或块标量（`|` / `>` 系列）
 *   2. 无 frontmatter 的（10 个）→ `## 1. Visual Theme & Atmosphere` 之后第一个非空段落
 *   3. 都取不到 → frontmatter `name:`，再退到目录名
 * 取完做 markdown 清理 + 取首句 + 按词边界截断，保证一行一条、可复现。
 *
 * 用法：
 *   node scripts/gen-brand-index.mjs           生成（内容相同则不写，避免 mtime 抖动）
 *   node scripts/gen-brand-index.mjs --check   只校验不写（漂移或结构异常则 exit 1）
 * 两种模式都会先做三条结构校验：SKILL.md 存在 / 每个品牌目录有 DESIGN.md / 旧的
 * resources/brand-tokens/ 已消失（防半程迁移）。
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const SKILL_DIR = path.join(ROOT, "resources", "skills", "brand-tokens");
const BRANDS_DIR = path.join(SKILL_DIR, "brands");
const OUT_FILE = path.join(SKILL_DIR, "brands.md");
const LEGACY_DIR = path.join(ROOT, "resources", "brand-tokens");

/** 一行描述的最大字符数（超出按词边界截断）。调大更能区分品牌，但清单会变长。 */
const DESC_LIMIT = 140;

const log = (msg) => console.log(`[gen-brands] ${msg}`);
const fail = (msg, hint) => {
  console.error(`[gen-brands] ✗ ${msg}`);
  if (hint) console.error(`    处置：${hint}`);
  return 1;
};

/** frontmatter 正文（首个 `---` 到下一个 `---`）；没有则 null */
function frontmatter(text) {
  if (!text.startsWith("---\n")) return null;
  const end = text.indexOf("\n---", 4);
  return end < 0 ? null : text.slice(4, end);
}

/** 取 frontmatter 里某个键的值；支持单行（含双引号包裹）与块标量（`|` / `>` 系列） */
function scalarValue(fm, key) {
  if (!fm) return null;
  const lines = fm.split("\n");
  for (let i = 0; i < lines.length; i++) {
    const m = lines[i].match(new RegExp(`^${key}:[ \\t]*(.*)$`));
    if (!m) continue;
    const inline = m[1].trim();
    if (inline && !/^[|>][+-]?$/.test(inline)) {
      return inline.startsWith('"') && inline.endsWith('"') && inline.length > 1
        ? inline.slice(1, -1)
        : inline;
    }
    // 块标量：收后续缩进行，遇到非缩进行即止
    const body = [];
    for (const next of lines.slice(i + 1)) {
      if (next.trim() === "") {
        if (body.length) break;
        continue;
      }
      if (!next.startsWith("  ")) break;
      body.push(next.trim());
    }
    return body.length ? body.join(" ") : null;
  }
  return null;
}

/** 无 frontmatter 的 DESIGN.md：取 `## 1. Visual Theme & Atmosphere` 后第一个正文段落 */
function atmosphere(text) {
  const m = text.match(/##\s*1\.\s*Visual Theme & Atmosphere\s*\n([\s\S]*)/);
  if (!m) return null;
  for (const para of m[1].split(/\n\s*\n/)) {
    const p = para.trim();
    if (p && !p.startsWith("#")) return p;
  }
  return null;
}

/** markdown/模板噪声清理 → 折叠空白 → 取首句 → 按词边界截断 */
function oneLiner(raw) {
  let s = raw
    .replace(/\{[^}]*\}/g, "") // `{colors.brand-green}` 之类的 token 占位符
    .replace(/\*\*|`|__/g, "")
    .replace(/\s+/g, " ")
    .trim()
    .replace(/^[#>\-*\s]+/, "");
  const stop = s.search(/[.!?](?=\s|$)/);
  if (stop >= 0) s = s.slice(0, stop + 1);
  s = s.replace(/[.!?,;:]+$/, "").trim();
  if (s.length > DESC_LIMIT) {
    const cut = s.slice(0, DESC_LIMIT);
    const sp = cut.lastIndexOf(" ");
    s = (sp > DESC_LIMIT * 0.6 ? cut.slice(0, sp) : cut).replace(/[\s,;:—–-]+$/, "") + "…";
  }
  return s;
}

/** 结构校验：三条都是"搬家搬对了"的守卫，任一失败即 exit 1 */
function validateStructure(names) {
  if (!fs.existsSync(path.join(SKILL_DIR, "SKILL.md"))) {
    return fail(`${path.relative(ROOT, path.join(SKILL_DIR, "SKILL.md"))} 不存在`, "品牌库的 SKILL.md 是 skill 的锚点，缺了模型看不到它。");
  }
  const missing = names.filter((n) => !fs.existsSync(path.join(BRANDS_DIR, n, "DESIGN.md")));
  if (missing.length) {
    return fail(`这些品牌目录缺 DESIGN.md：${missing.join(", ")}`, "补齐资源，或从品牌库里删掉该目录（同时跑 `npm run gen:brands`）。");
  }
  if (fs.existsSync(LEGACY_DIR)) {
    return fail(`${path.relative(ROOT, LEGACY_DIR)} 仍然存在`, "品牌库已移入 skill 目录，旧路径残留说明迁移只做了一半（或有人加回来了）。");
  }
  return 0;
}

function buildContent(names) {
  const lines = names.map((n) => {
    const text = fs.readFileSync(path.join(BRANDS_DIR, n, "DESIGN.md"), "utf-8");
    const fm = frontmatter(text);
    const raw =
      scalarValue(fm, "description") ??
      atmosphere(text) ??
      scalarValue(fm, "name") ??
      n;
    return `- **${n}** — ${oneLiner(raw)}`;
  });
  return [
    "<!-- 由 scripts/gen-brand-index.mjs 生成，请勿手改；品牌目录变动后跑 `npm run gen:brands` -->",
    "",
    "# 品牌清单",
    "",
    `共 ${names.length} 个品牌。单个品牌规范：\`<技能目录>/brands/<品牌>/DESIGN.md\`，一次只读一个，不要遍历。`,
    "",
    ...lines,
    "",
  ].join("\n");
}

/** 首个不一致行（行号从 1 起），用于把"哪里漂了"直接指出来 */
function firstDiff(expected, actual) {
  const a = expected.split("\n");
  const b = actual.split("\n");
  for (let i = 0; i < Math.max(a.length, b.length); i++) {
    if (a[i] !== b[i]) return { line: i + 1, expected: a[i], actual: b[i] };
  }
  return null;
}

function main() {
  const checkOnly = process.argv.includes("--check");

  if (!fs.existsSync(BRANDS_DIR)) {
    return fail(`${path.relative(ROOT, BRANDS_DIR)} 不存在`, "品牌资源未就位。");
  }
  // names.sort() 是字节序 —— 刻意不用 localeCompare，保证跨平台产出可复现
  const names = fs
    .readdirSync(BRANDS_DIR, { withFileTypes: true })
    .filter((e) => e.isDirectory())
    .map((e) => e.name)
    .sort();
  if (!names.length) return fail("品牌目录为空", "品牌资源未就位。");

  const structural = validateStructure(names);
  if (structural !== 0) return structural;

  const content = buildContent(names);
  const current = fs.existsSync(OUT_FILE) ? fs.readFileSync(OUT_FILE, "utf-8") : null;

  if (checkOnly) {
    if (current === content) {
      log(`✓ brands.md 与 brands/ 同步（${names.length} 个品牌）`);
      return 0;
    }
    if (current === null) {
      return fail(`${path.relative(ROOT, OUT_FILE)} 不存在`, "跑 `npm run gen:brands` 生成。");
    }
    const d = firstDiff(content, current);
    console.error(`[gen-brands] ✗ brands.md 与 brands/ 不同步（第 ${d.line} 行起）：`);
    console.error(`    应为：${(d.expected ?? "(缺该行)").slice(0, 160)}`);
    console.error(`    实为：${(d.actual ?? "(缺该行)").slice(0, 160)}`);
    console.error("    处置：跑 `npm run gen:brands` 重新生成并提交。");
    return 1;
  }

  if (current === content) {
    log(`✓ brands.md 已是最新（${names.length} 个品牌）`);
    return 0;
  }
  fs.writeFileSync(OUT_FILE, content);
  log(`✓ brands.md 已更新（${names.length} 个品牌）`);
  return 0;
}

process.exit(main());
