import { describe, expect, it } from "vitest";
import { subagentModelChoice, subagentThinkingLevel } from "./model-resolution";

/**
 * 子 Agent 的模型与思考等级**只有主会话一个来源**（2026-09-16 用户拍板：
 * 「子 agent 只跟随主会话的模型配置，取消全部子 agent 的配置入口」）。
 *
 * 这里逐条锚死，是因为它**曾经有过一条四级候选链**
 * （委派指定 > Agent模板 > 子Agent默认模型 > 主会话），而把它加回来
 * 从现象上几乎看不出来——子 Agent 变笨 / 变贵 / 被 max_tokens 截断都可能被归因到别处。
 * 要新增来源，先改这个文件。
 */
describe("subagentModelChoice", () => {
  it("主会话是唯一来源", () => {
    expect(subagentModelChoice({ parent: { provider: "deepseek", model: "deepseek-v4-flash" } }))
      .toEqual({ source: "主会话", provider: "deepseek", model: "deepseek-v4-flash" });
  });

  it("provider 或 model 缺一不成立（不能半截匹配）", () => {
    expect(subagentModelChoice({ parent: { provider: "deepseek" } })).toBeUndefined();
    expect(subagentModelChoice({ parent: { model: "deepseek-v4-flash" } })).toBeUndefined();
  });

  it("主会话未绑定模型（新建会话早期）→ 返回空，调用方回落全局默认", () => {
    expect(subagentModelChoice({})).toBeUndefined();
    expect(subagentModelChoice({ parent: {} })).toBeUndefined();
  });

  it("已删除的来源即便被传进来也不采纳（回归点：钉住「只能从主会话来」）", () => {
    const choice = subagentModelChoice({
      parent: { provider: "deepseek", model: "deepseek-v4-flash" },
      // 这三个来源随模板运行配置与供应商「子 Agent 默认模型」一起删除；
      // 类型上已不接受（多余属性），运行时若被任何绕过类型的写法塞进来也必须无效
      ...({ delegate: { provider: "anthropic", model: "claude-opus-4-6" } } as object),
      ...({ template: { provider: "anthropic", model: "claude-opus-4-6" } } as object),
      ...({ subagentDefault: { provider: "openai", model: "gpt-5" } } as object),
    } as Parameters<typeof subagentModelChoice>[0]);
    expect(choice).toEqual({ source: "主会话", provider: "deepseek", model: "deepseek-v4-flash" });
  });
});

describe("subagentThinkingLevel", () => {
  it("跟随主会话：主会话给什么就是什么（含 off 与极高档位，原样透传）", () => {
    expect(subagentThinkingLevel("low")).toBe("low");
    expect(subagentThinkingLevel("xhigh")).toBe("xhigh");
    expect(subagentThinkingLevel("off")).toBe("off");
  });

  it("主会话值缺失 → medium 兜底（这是「值缺失」的兜底，不是子 Agent 的默认档）", () => {
    expect(subagentThinkingLevel(undefined)).toBe("medium");
  });
});
