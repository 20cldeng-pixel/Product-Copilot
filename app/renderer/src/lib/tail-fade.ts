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

/** 末尾渐隐的字符数（改这个数要连着看视觉效果：字数越少越像"打字机拖尾"） */
export const TAIL_FADE_CHARS = 4;

/**
 * 把 HTML 里**最后一个文本段**的末尾 `count` 个可见字符包进 `<span class="stream-tail-fade">`。
 *
 * 宁可不动手也不做坏——三条保守规则：
 * 1. 先剥掉末尾的空白与闭合标签，只在**最后一个文本段**内工作；
 * 2. 该文本段不是纯文本（含 `<`）或找不到字符 → 原样返回（例如末尾刚好是 `<code>x</code>`）；
 * 3. HTML 实体（`&amp;`、`&#39;`）整体算一个可见字符，绝不在实体中间切开。
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

  // ③ 自右向左数 count 个字符单位（实体算一个）
  let pos = segment.length;
  let taken = 0;
  while (pos > 0 && taken < count) {
    const amp = segment.lastIndexOf("&", pos - 1);
    const isEntity = amp >= 0 && segment[pos - 1] === ";"
      && /^&[a-zA-Z#][a-zA-Z0-9]*;$/.test(segment.slice(amp, pos));
    pos = isEntity ? amp : pos - 1;
    taken += 1;
  }
  if (taken === 0) return html;

  return core.slice(0, textStart)
    + segment.slice(0, pos)
    + `<span class="stream-tail-fade">${segment.slice(pos)}</span>`
    + html.slice(end);
}

/** 纯文本版的同一件事（思考块是 `<pre>{text}</pre>`，没有 HTML 可定位）：
 *  返回 [前段, 末段]；末段为空串表示不处理。段长不足 count 时整段渐隐。 */
export function splitTailText(text: string, count: number): [string, string] {
  if (count <= 0) return [text, ""];
  const cut = Math.max(0, text.length - count);
  return [text.slice(0, cut), text.slice(cut)];
}
