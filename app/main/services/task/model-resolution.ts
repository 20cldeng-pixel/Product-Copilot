/**
 * 子 Agent 的模型与思考等级来源 —— 纯函数，无运行时依赖（便于单测锚住来源）。
 *
 * **唯一来源是主会话**（2026-09-16 用户拍板：「子 agent 只跟随主会话的模型配置，
 * 取消全部子 agent 的配置入口」）。此前是一条四级候选链
 * （委派指定 > Agent模板 > 子Agent默认模型 > 主会话），随模板运行配置字段与
 * 供应商「子 Agent 默认模型」入口一并删除——"两处配置谁赢"的问题从此不存在。
 *
 * 来源既然唯一，为何仍留在模块里并配单测：**防止它被悄悄加回去**。子 Agent 用哪个模型 /
 * 哪个档位，从现象上几乎看不出来（变笨、变贵、被截断都可能是别的原因），
 * 故这里逐条锚死；要新增来源，先改测试。
 */

/** 子 Agent 取模型的来源标签（排错用：日志里看得出最终吃的是哪一级） */
export interface SubagentModelChoice {
  source: string;
  provider: string;
  model: string;
}

/**
 * 子 Agent 模型的唯一来源 = **主会话当前模型**。
 * 主会话尚未绑定（新建会话早期）时返回 undefined，由调用方回落到全局默认（getActiveModel）。
 */
export function subagentModelChoice(input: {
  /** 主会话当前模型（provider+model 缺一不成立） */
  parent?: { provider?: string; model?: string };
}): SubagentModelChoice | undefined {
  const p = input.parent;
  if (!p?.provider || !p?.model) return undefined;
  return { source: "主会话", provider: p.provider, model: p.model };
}

/**
 * 子 Agent 思考等级同样只有**主会话**一个来源。
 * 读不到时兜底 medium —— 那是"主会话值缺失"的兜底（与 pi-session 的默认一致），
 * 不是子 Agent 自己的默认档：子 Agent 没有默认档。
 */
export function subagentThinkingLevel(parent?: string): string {
  return parent ?? "medium";
}
