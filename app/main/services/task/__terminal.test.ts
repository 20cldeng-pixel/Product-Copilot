import { describe, expect, it } from "vitest";
import { judgeSubagentTerminal, type TerminalSignals } from "./terminal";

/**
 * 判据来自本机 459 份子会话的实测分布（见 terminal.ts 顶部注释）：
 * 正常完成 290/290 都以 stop + 非空文本收尾，没有一例「完成但没有终局文本」。
 * 这里逐条锚定——改动判定规则时先看这些用例为什么这么写。
 */
const base: TerminalSignals = {
  aborted: false,
  lastStopReason: "stop",
  hasFinalText: true,
  outputSchemaRequested: false,
  yieldCount: 0,
};

describe("judgeSubagentTerminal", () => {
  it("正常完成（stop + 终局文本）：不判失败、不告警", () => {
    expect(judgeSubagentTerminal(base)).toEqual({});
  });

  it("本轮事故：stopReason=length（输出预算被思考吃光）判失败", () => {
    const v = judgeSubagentTerminal({
      ...base,
      // 实测：usage.reasoning === usage.output === 16386，content 只剩一个 thinking 块
      lastStopReason: "length",
      hasFinalText: false,
    });
    expect(v.error).toContain("max_tokens");
    expect(v.error).toContain("思考等级");
  });

  it("stopReason=error：带上供应商原文", () => {
    const v = judgeSubagentTerminal({
      ...base,
      lastStopReason: "error",
      lastErrorMessage: "Insufficient Balance",
      hasFinalText: false,
    });
    expect(v.error).toBe("Insufficient Balance");
  });

  it("stopReason=error 但没给原文：回落到通用文案", () => {
    const v = judgeSubagentTerminal({ ...base, lastStopReason: "error", hasFinalText: false });
    expect(v.error).toContain("API 请求失败");
  });

  it("其它静默收尾（回合结束却没有终局文本）也要判失败", () => {
    const v = judgeSubagentTerminal({ ...base, hasFinalText: false });
    expect(v.error).toContain("未产出终局总结");
  });

  it("history 实测：发完工具调用就被切断（stopReason=toolUse、无 toolResult）判失败", () => {
    const v = judgeSubagentTerminal({ ...base, lastStopReason: "toolUse", hasFinalText: false });
    expect(v.error).toContain("未产出终局总结");
    expect(v.error).toContain("toolUse");
  });

  it("signal 中止：不判失败（另有「已由用户中止」通知）", () => {
    expect(judgeSubagentTerminal({ ...base, aborted: true, hasFinalText: false })).toEqual({});
  });

  it("stopReason=aborted（signal 没标到）：同样不判失败", () => {
    expect(judgeSubagentTerminal({ ...base, lastStopReason: "aborted", hasFinalText: false })).toEqual({});
  });

  it("声明了 outputSchema 却没调 yield：告警但不判失败（工作是做了的）", () => {
    const v = judgeSubagentTerminal({ ...base, outputSchemaRequested: true, yieldCount: 0 });
    expect(v.error).toBeUndefined();
    expect(v.warning).toContain("yield");
  });

  it("yield 调过：无告警", () => {
    expect(judgeSubagentTerminal({ ...base, outputSchemaRequested: true, yieldCount: 1 })).toEqual({});
  });

  it("截断优先于 yield 告警：先报失败", () => {
    const v = judgeSubagentTerminal({
      ...base,
      lastStopReason: "length",
      hasFinalText: false,
      outputSchemaRequested: true,
      yieldCount: 0,
    });
    expect(v.error).toContain("max_tokens");
    expect(v.warning).toBeUndefined();
  });
});
