import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

// DOMPurify 需要真实 DOM；这里被测的是"末尾有没有包出渐隐 span"，
// 净化本身不在范围内，桩掉可让本测试保持在 vitest 的 node 环境
vi.mock("dompurify", () => ({ default: { sanitize: (s: string) => s } }));
// diff-highlight 顶层 import monaco-editor（要 window）；本测试只走纯文本路径，用不到它
vi.mock("../lib/diff-highlight", () => ({ inferLang: () => "TEXT", tokenizeLines: () => [] }));

const BLOCK = { kind: "text" as const, text: "启动必然失败啊", keyPrefix: "k" };

/** 静态渲染（SSR 不跑 effect，但会跑 useState 的惰性初始化 → 初始流式帧会被渲染出来） */
async function render(props: Record<string, unknown>): Promise<string> {
  const { TextBlockView } = await import("./ChatBlocks");
  return renderToStaticMarkup(createElement(TextBlockView as never, props as never));
}

describe("流式尾块字符级渐隐的接线", () => {
  it("tail=true（正在增长的那块）→ 末尾包出渐隐 span", async () => {
    const html = await render({ block: BLOCK, streaming: true, tail: true });
    expect(html).toContain('class="stream-tail-fade"');
  });

  it("tail 缺省（同条流式消息里更靠前的块）→ 不包，哪怕它也在流式渲染路径上", async () => {
    const html = await render({ block: BLOCK, streaming: true });
    expect(html).not.toContain("stream-tail-fade");
  });

  it("非流式（历史块）→ 不包", async () => {
    const html = await render({ block: BLOCK, streaming: false, tail: false });
    expect(html).not.toContain("stream-tail-fade");
  });

  it("渐隐只落在末尾那几个字上，正文其余部分照旧渲染", async () => {
    const html = await render({ block: { kind: "text", text: "启动必然失败啊" }, streaming: true, tail: true });
    expect(html).toContain("启动必");
    expect(html).toMatch(/<span class="stream-tail-fade">然失败啊<\/span>/);
  });
});
