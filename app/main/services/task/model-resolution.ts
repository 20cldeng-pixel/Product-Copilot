/**
 * 子 Agent 的模型解析顺序 —— 纯函数，无运行时依赖（便于单测锚住顺序）
 *
 * 「主会话优先于模板」是 2026-09-16 定的：模板里的模型是**长驻人设**，
 * 主会话的模型是**用户此刻的选择**，后者更该赢——否则子 Agent 会拿着和父会话
 * 不同的额度/能力去干活（典型后果：父会话 384K 输出、子 Agent 落到 16K 输出的模型上，
 * 一次大 Write 就被 max_tokens 截断）。顺序错了很难从现象上看出来，故抽出来单测。
 */

/** 候选模型（按优先级排列；provider+model 缺一不成立） */
export interface SubagentModelCandidate {
  /** 来源标签（排错用：知道当前生效的是哪一级） */
  source: string;
  provider: string;
  model: string;
}

/**
 * 候选模型优先级 —— 自上而下第一个能解析到的胜出：
 *   委派显式指定 > **主会话当前模型** > AgentTemplate > 子 agent 默认模型
 * （全部解析不到时由调用方回落到全局默认 getActiveModel）
 */
export function subagentModelCandidates(input: {
  delegate?: { provider?: string; model?: string };
  parent?: { provider?: string; model?: string };
  template?: { provider?: string; model?: string };
  subagentDefault?: { provider?: string; model?: string };
}): SubagentModelCandidate[] {
  const out: SubagentModelCandidate[] = [];
  const push = (source: string, p?: { provider?: string; model?: string }): void => {
    if (p?.provider && p?.model) out.push({ source, provider: p.provider, model: p.model });
  };
  push("委派指定", input.delegate);
  push("主会话", input.parent);
  push("Agent模板", input.template);
  push("子Agent默认", input.subagentDefault);
  return out;
}
