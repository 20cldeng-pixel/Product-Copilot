/**
 * 子 Agent 终态判定 —— 治「什么都没干却报完成」的静默失败
 *
 * 背景（2026-09-16 photo-waterfall-wall 实证，两轮独立复现）：
 * 子 Agent 在最后一轮把全部输出预算烧在思考上（模型 maxTokens=16384，`usage.reasoning`
 * 恰好等于 `usage.output`），回合被截断成「只有 thinking 块、无 text、无 toolCall」。
 * pi 的 agent loop 对这种回合**当作正常收尾**——`node_modules/@earendil-works/pi-agent-core/
 * dist/agent-loop.js` 的 runLoop：没有工具调用 ⇒ `hasMoreToolCalls = false` ⇒ 走 `agent_end`；
 * `stopReason` 只在「有工具调用」时用来把它们判失败，不用来判定回合是否成功。
 * 截断的事实只留在 `stopReason === "length"` 上，不抛错。
 *
 * 而 executor 收尾只看 `signal.aborted`，于是把它记成 completed —— 上层看到
 * 「⏺ xx - 完成 · 92s」，实际产出为零，「详细结果」还退化成第一句开场白（整会话只有
 * 第 1 条 assistant 带 text 块，collector 只能收集到那一句）。
 *
 * 判据不是拍脑袋来的：本机 459 份子会话实测分布 —— 正常完成 290/290 **全部**以
 * `stop` + 非空文本收尾，没有任何一例「正常完成但没有终局文本」；`aborted` 126 例
 * （主动停止，另有中止通知）、`error` 12 例、`toolUse` 27 例（发完工具调用就被切断，
 * 从未拿到 toolResult，属被中止的那一类）、`length` 2 例（本次事故）。
 * 因此「没有终局文本」本身就是异常收尾的可靠信号。
 */

/** 判定所需的终态信号（全部由 executor 从会话事件里采集，本模块保持纯函数） */
export interface TerminalSignals {
  /** 主动停止（signal.aborted）——不是失败，上层另有中止通知 */
  aborted: boolean;
  /** 最后一条 assistant 消息的 stopReason（pi 语义：stop/toolUse/length/error/aborted） */
  lastStopReason?: string;
  /** stopReason === "error" 时模型/供应商给的原文 */
  lastErrorMessage?: string;
  /** 最后一条 assistant 是否带非空 text 块（= 终局总结） */
  hasFinalText: boolean;
  /** 委派时是否声明了 outputSchema */
  outputSchemaRequested: boolean;
  /** 子 Agent 实际调用 yield 的次数 */
  yieldCount: number;
}

export interface TerminalVerdict {
  /** 有值 ⇒ 判失败（formatDelegationResult 会渲染成「失败」而不是「完成」） */
  error?: string;
  /** 不判失败、但必须让上层看见的降级项（避免静默） */
  warning?: string;
}

export function judgeSubagentTerminal(s: TerminalSignals): TerminalVerdict {
  // 主动停止优先：用户/Mint 停的不算失败（否则会把「已中止」误报成「失败」）
  if (s.aborted || s.lastStopReason === "aborted") return {};

  if (s.lastStopReason === "error") {
    return { error: s.lastErrorMessage || "API 请求失败（可能额度用完或供应商不可用）" };
  }

  if (s.lastStopReason === "length") {
    return {
      error: "输出被 max_tokens 截断（stopReason=length）：最后一轮耗尽了输出预算，未产出任何内容。"
        + "请调高该模型的「最大输出」（设置 → 模型管理），或降低主会话的思考等级",
    };
  }

  if (!s.hasFinalText) {
    // 兜底：其它会让回合静默终止的形态（发完工具调用就断、loop 提前退出等）
    return {
      error: `子 Agent 未产出终局总结（回合异常结束${s.lastStopReason ? `，stopReason=${s.lastStopReason}` : ""}），本轮结果不可信`,
    };
  }

  if (s.outputSchemaRequested && s.yieldCount === 0) {
    return { warning: "未按 outputSchema 调用 yield，结构化结果缺失" };
  }

  return {};
}
