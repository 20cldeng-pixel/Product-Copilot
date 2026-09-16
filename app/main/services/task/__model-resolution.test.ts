import { describe, expect, it } from "vitest";
import { subagentModelCandidates } from "./model-resolution";

/**
 * 这条顺序是 2026-09-16 定的（父会话模型必须赢过模板）——
 * 顺序被改回去的现象是「子 Agent 用了和主会话不同的模型」，
 * 从委派结果里基本看不出来，所以这里逐级锚死。
 */
describe("subagentModelCandidates", () => {
  const delegate = { provider: "deepseek", model: "deepseek-v4-pro" };
  const parent = { provider: "deepseek", model: "deepseek-v4-flash" };
  const template = { provider: "anthropic", model: "claude-opus-4-6" };
  const subagentDefault = { provider: "deepseek", model: "deepseek-flash" };

  it("顺序：委派指定 > 主会话 > Agent模板 > 子Agent默认", () => {
    expect(subagentModelCandidates({ delegate, parent, template, subagentDefault }))
      .toEqual([
        { source: "委派指定", ...delegate },
        { source: "主会话", ...parent },
        { source: "Agent模板", ...template },
        { source: "子Agent默认", ...subagentDefault },
      ]);
  });

  it("主会话排在模板之前（本条的回归点）", () => {
    const c = subagentModelCandidates({ parent, template });
    expect(c.map((x) => x.source)).toEqual(["主会话", "Agent模板"]);
    expect(c[0]!.model).toBe(parent.model);
  });

  it("缺 provider 或 model 的候选被跳过（不能半截匹配）", () => {
    const c = subagentModelCandidates({
      parent: { provider: "deepseek" },
      template: { model: "claude-opus-4-6" },
      subagentDefault,
    });
    expect(c).toEqual([{ source: "子Agent默认", ...subagentDefault }]);
  });

  it("父会话还没绑定模型时（新建会话早期）不影响顺序", () => {
    const c = subagentModelCandidates({ template, subagentDefault });
    expect(c.map((x) => x.source)).toEqual(["Agent模板", "子Agent默认"]);
  });

  it("全空返回空数组（调用方回落到全局默认）", () => {
    expect(subagentModelCandidates({})).toEqual([]);
  });
});
