/**
 * 环境状态（渲染层）：只保存"有没有问题"和最近一次报告，供侧边栏红点与设置页共用。
 *
 * 红点语义（方案 §6）：**环境问题不因"看过"而消失**——只有探测到全部就绪才灭。
 * 这与版本更新的红点（`readVersion("dot")` 看过即灭）刻意不同：
 * 环境没修好却把红点消掉，用户会以为已经好了。
 */
import { create } from "zustand";

interface EnvState {
  report: EnvReportShape | null;
  /** 探测失败（≠ 没问题，也 ≠ 没装）：不点红点、也不静默当没事 */
  probeFailed: boolean;
  hasIssue: boolean;
  setReport: (r: EnvReportShape) => void;
  setProbeFailed: () => void;
}

export const useEnvStore = create<EnvState>((set) => ({
  report: null,
  probeFailed: false,
  hasIssue: false,
  setReport: (r) => set({ report: r, probeFailed: false, hasIssue: r.items.some((i) => i.status !== "ok") }),
  setProbeFailed: () => set({ probeFailed: true, hasIssue: false }),
}));

/**
 * 订阅主进程的启动自检结果（`env:report`），并主动补一次探测。
 * 返回退订函数；由最上层组件调用一次即可。
 */
export function subscribeEnvReport(): () => void {
  const apply = (r: EnvReportShape): void => useEnvStore.getState().setReport(r);
  const off = window.electronAPI?.env?.onReport?.(apply);
  // 主进程的自检是延迟 1.5s 才发的；若此时窗口刚起、错过了广播，这里补一次（幂等、只读）
  window.electronAPI?.env?.probe?.().then(apply).catch(() => useEnvStore.getState().setProbeFailed());
  return () => { off?.(); };
}
