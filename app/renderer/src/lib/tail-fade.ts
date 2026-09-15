/**
 * 流式尾部**字符级**渐隐：只把末尾几个可见字符包成 `<span class="stream-tail-fade">`
 * （样式见 index.css），由 CSS 给这一小段铺一道横向渐隐，表示"这段还没写完"。
 *
 * 为什么必须做到字符级、而不能靠容器级 mask：mask 是按**元素盒子的几何位置**渐变的
 * （`calc(100% - 60px)` 这类），它只能撑起"末端若干行"的整片淡出，选中不到"最后几个字"。
 * 要让几个字独立渐隐，它们就得是独立元素。
 *
 * 为什么在**渲染后的 HTML** 上做、而不是往 markdown 源码里插标签：源码里这几个字符可能被标记
 * 分隔（`**粗**体`），插在源码层要处理未闭合的强调符号；渲染后的 HTML 里位置是确定的。
 * 又因为调用点在 `DOMPurify.sanitize()` **之后**，插入的 span 不会被净化掉。
 *
 * 与 markdown 管线分开放，是为了让本模块保持零依赖（纯字符串函数，测试无需拉起 dompurify/marked）。
 */

/** 末尾渐隐的字符数（改这个数要连着看视觉效果：字数越少越像"打字机拖尾"）。
 *  **单位是用户感知字符（grapheme），不是 UTF-16 码元** —— 见下方 graphemes() */
export const TAIL_FADE_CHARS = 4;

/** 分词器实例（构造失败不致命：环境缺 ICU 时退化为码点切分，见 graphemes） */
const segmenter: Intl.Segmenter | undefined = ((): Intl.Segmenter | undefined => {
  try {
    return typeof Intl !== "undefined" && typeof Intl.Segmenter === "function"
      ? new Intl.Segmenter(undefined, { granularity: "grapheme" })
      : undefined;
  } catch {
    return undefined; // 构造失败（环境缺 ICU）不该把整个模块带崩
  }
})();

/**
 * 按「用户感知的字符」（grapheme cluster）切分。
 *
 * 为什么不能用 `length` / `slice`：JS 的字符串下标是 **UTF-16 码元**，一个 emoji 常常占 2 个以上
 * 码元（"😀" = 代理对；"👍🏽" = 基础 + 肤色修饰；"👨‍👩‍👧" = 三个 emoji 用 ZWJ 连起来），
 * 按码元切会把它们**从中间剪断**——渲染出来是半个字符（U+FFFD 乱码框），比"少渐隐一个字"糟得多。
 * `Intl.Segmenter` 是标准的分词 API（ECMA-402），它按 grapheme 边界切，正好解决这件事。
 *
 * 兜底：Segmenter 缺失（Electron/Chromium 与 Node ≥16 都带，理论上不会发生）时退化为按**码点**切——
 * 至少不会把代理对切成半个字符；ZWJ 组合序列在这种环境下仍可能被拆开。
 */
export function graphemes(text: string): string[] {
  if (!segmenter) return Array.from(text);
  const out: string[] = [];
  for (const s of segmenter.segment(text)) out.push(s.segment);
  return out;
}

/** HTML 实体（`&amp;` / `&#39;`）：在文本里整体算**一个**可见字符 */
const ENTITY = /^&[a-zA-Z#][a-zA-Z0-9]*;/;

/**
 * 文本 → 渲染单元序列：HTML 实体整体一个单元，其余按 grapheme 切。
 * 渐隐/切分都在这份单元序列上数，才能既不在实体中间切、也不在 emoji 中间切。
 */
function textUnits(text: string): string[] {
  const units: string[] = [];
  let rest = text;
  while (rest) {
    const entity = ENTITY.exec(rest);
    if (entity) {
      units.push(entity[0]);
      rest = rest.slice(entity[0].length);
      continue;
    }
    const stop = rest.indexOf("&");
    if (stop === 0) { // 裸露的 "&"（不是实体开头）：按一个字符处理，避免原地打转
      units.push(rest[0]!);
      rest = rest.slice(1);
      continue;
    }
    const plain = stop === -1 ? rest : rest.slice(0, stop);
    units.push(...graphemes(plain));
    rest = stop === -1 ? "" : rest.slice(stop);
  }
  return units;
}

/**
 * 把 HTML 里**最后一个文本段**的末尾 `count` 个可见字符包进 `<span class="stream-tail-fade">`。
 *
 * 宁可不动手也不做坏——三条保守规则：
 * 1. 先剥掉末尾的空白与闭合标签，只在**最后一个文本段**内工作；
 * 2. 该文本段不是纯文本（含 `<`）或找不到字符 → 原样返回（例如末尾刚好是 `<code>x</code>`）；
 * 3. HTML 实体（`&amp;`、`&#39;`）与 emoji 序列整体算一个可见字符，绝不在中间切开。
 */
export function fadeTailChars(html: string, count: number): string {
  if (count <= 0 || !html) return html;

  // ① 剥掉末尾空白与闭合标签，end = 最后一个文本段的结束位置
  let end = html.length;
  for (;;) {
    const stripped = html.slice(0, end).replace(/\s+$/, "");
    const tag = /<\/?[a-zA-Z][^<>]*>$/.exec(stripped);
    if (tag && tag.index > 0) { end = tag.index; continue; }
    if (stripped.length === end) break;
    end = stripped.length;
  }
  if (end <= 0) return html;

  // ② 最后一个文本段 = 最后一个 ">" 之后到 end 之间（纯文本才处理）
  const core = html.slice(0, end);
  const textStart = core.lastIndexOf(">") + 1;
  const segment = core.slice(textStart);
  if (!segment || segment.includes("<")) return html;

  // ③ 自右向左数 count 个可见单元（实体 / emoji 序列各算一个）
  const units = textUnits(segment);
  if (units.length === 0) return html;
  const start = Math.max(0, units.length - count);
  const pos = units.slice(0, start).reduce((n, u) => n + u.length, 0);

  return core.slice(0, textStart)
    + segment.slice(0, pos)
    + `<span class="stream-tail-fade">${segment.slice(pos)}</span>`
    + html.slice(end);
}

/** 纯文本版的同一件事（思考块是 `<pre>{text}</pre>`，没有 HTML 可定位）：
 *  返回 [前段, 末段]；末段为空串表示不处理。段长不足 count 时整段渐隐。
 *  同样按 grapheme 切——切在 emoji 中间会渲染出半个字符。 */
export function splitTailText(text: string, count: number): [string, string] {
  if (count <= 0) return [text, ""];
  const units = graphemes(text);
  if (units.length <= count) return ["", text];
  const cut = units.slice(0, units.length - count).reduce((n, u) => n + u.length, 0);
  return [text.slice(0, cut), text.slice(cut)];
}
