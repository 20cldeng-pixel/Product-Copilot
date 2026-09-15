import { describe, expect, it } from "vitest";
import { fadeTailChars, splitTailText, TAIL_FADE_CHARS } from "./tail-fade";

/** 期望的渐隐 span（类名是 CSS 的锚点，改 CSS 必须同步改这里） */
const fade = (s: string): string => `<span class="stream-tail-fade">${s}</span>`;

describe("fadeTailChars：只在最后一个文本段的末尾包渐隐 span", () => {
  it("普通段落：末尾 4 字被包，前面原样，末尾换行保留", () => {
    // "启动必然失败啊" 7 字 → 前 3 + 末 4
    expect(fadeTailChars("<p>启动必然失败啊</p>\n", 4))
      .toBe(`<p>启动必${fade("然失败啊")}</p>\n`);
  });

  it("末尾是嵌套标签：剥掉闭合标签序列后在**最内层**文本段里取字", () => {
    expect(fadeTailChars("<p>这是<strong>重点内容</strong></p>", 4))
      .toBe(`<p>这是<strong>${fade("重点内容")}</strong></p>`);
  });

  it("末尾收在 </code>：继续往前找到 code 内的字（它才是最后一个可见字符）", () => {
    expect(fadeTailChars("<p>看这一行 <code>xyz</code></p>", 2))
      .toBe(`<p>看这一行 <code>x${fade("yz")}</code></p>`);
  });

  it("HTML 实体整体算一个可见字符，绝不在实体中间切开", () => {
    // "a &amp; b" 的可见字符是 a / ␣ / &amp; / ␣ / b（5 个）—— 取末 4 个应含整个实体；
    // 若按字符数硬切会得到 "&am" + "p; b"，渲染出乱码
    const out = fadeTailChars("<p>a &amp; b</p>", 4);
    expect(out).toBe(`<p>a${fade(" &amp; b")}</p>`);
    expect(out).not.toContain("&am<span");
    expect(fadeTailChars("<p>a &amp; b</p>", 2))
      .toBe(`<p>a &amp;${fade(" b")}</p>`);
  });

  it("段长不足 count：整段渐隐（不会越界或留空 span）", () => {
    expect(fadeTailChars("<p>好</p>", 4)).toBe(`<p>${fade("好")}</p>`);
  });

  it("只剩标签没有文字：原样返回，不硬塞 span", () => {
    expect(fadeTailChars("<p></p>", 4)).toBe("<p></p>");
  });

  it("count 为 0 或内容为空：完全不动", () => {
    expect(fadeTailChars("<p>abc</p>", 0)).toBe("<p>abc</p>");
    expect(fadeTailChars("", 4)).toBe("");
  });

  it("多处标签：只动最后一段，前面的段落不受影响", () => {
    expect(fadeTailChars("<p>第一段结束。</p>\n<p>第二段也结束了</p>", 3))
      .toBe(`<p>第一段结束。</p>\n<p>第二段也${fade("结束了")}</p>`);
  });
});

describe("emoji 不被切半（按 grapheme 计数，不按 UTF-16 码元）", () => {
  // 一个 emoji 通常占 2 个以上码元：按 length/slice 切会留下孤立代理项（渲染成 U+FFFD 乱码框）
  const FACE = "😀";              // 代理对，2 码元
  const THUMB_TONE = "👍🏽";        // 基础 + 肤色修饰，4 码元
  const FAMILY = "👨‍👩‍👧";            // ZWJ 序列，8 码元

  it("splitTailText：切点落在代理对中间时，末段是整个 emoji", () => {
    // "a😀" 的码元是 [a, D83D, DE00]：取末 1 个码元会得到落单的低代理项
    expect(splitTailText(`a${FACE}`, 1)).toEqual(["a", FACE]);
    expect(splitTailText(`看这里${FACE}`, 2)).toEqual(["看这", `里${FACE}`]);
  });

  it("splitTailText：肤色修饰不会脱钩、ZWJ 家庭序列不拆开", () => {
    // 旧实现把 "👍🏽" 切成 "👍" + "🏽"，末段只剩一个肤色色块
    expect(splitTailText(`好${THUMB_TONE}`, 1)).toEqual(["好", THUMB_TONE]);
    expect(splitTailText(`好${FAMILY}`, 1)).toEqual(["好", FAMILY]);
  });

  it("fadeTailChars：渐隐 span 里不出现孤立代理项", () => {
    const out = fadeTailChars(`<p>a${FACE}</p>`, 1);
    expect(out).toBe(`<p>a${fade(FACE)}</p>`);
    // 半个 emoji 的痕迹：span 里以低代理项开头 / 以高代理项结尾
    expect(out).not.toContain(`<span class="stream-tail-fade">\uDE00`);
    expect(out).not.toContain("\uD83D</span>");
  });

  it("fadeTailChars：实体与 emoji 混排，两类单元都整体算一个", () => {
    // 可见单元 = a / ␣ / &amp; / ␣ / 😀（5 个）→ 末 2 个是「␣😀」，实体整个留在渐隐段之外
    const out = fadeTailChars(`<p>a &amp; ${FACE}</p>`, 2);
    expect(out).toBe(`<p>a &amp;${fade(` ${FACE}`)}</p>`);
    expect(out).not.toContain("&am<span");
  });
});

describe("splitTailText：纯文本（思考块）版的同一切分", () => {
  it("取末尾 count 个字符", () => {
    expect(splitTailText("先看它的换 token 请求走哪条路", 4))
      .toEqual(["先看它的换 token 请求", "走哪条路"]);
  });

  it("不足 count 时整段作为末段", () => {
    expect(splitTailText("好", 4)).toEqual(["", "好"]);
  });

  it("count 为 0 时不切", () => {
    expect(splitTailText("abc", 0)).toEqual(["abc", ""]);
  });
});

describe("常量", () => {
  it("默认渐隐 4 个字符（与 index.css 注释、UI元素库文档三处保持一致）", () => {
    expect(TAIL_FADE_CHARS).toBe(4);
  });
});
