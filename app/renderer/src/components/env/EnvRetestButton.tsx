/**
 * 环境检测的「重新检测」—— **全项目唯一一处定义**（设置页与引导流程共用）。
 *
 * 为什么单独抽出来：此前设置页有两个同文案按钮，而且刷新范围不同（标题栏那个只刷
 * Git/Node/CodeGraph 三个检测器，面板那个刷系统组件并重置沙盒失败缓存）——用户无从分辨，
 * 还出过"一进设置页就是两个按钮"的缺陷（面板用哨兵值判断是否由外层接管，与外层初值撞车）。
 *
 * 现在的口径（用户拍板）：**按钮由宿主提供、动作只有一个**——
 * 核心动作永远是 `EnvPanelHandle.retest()`（重探 + 重置沙盒失败缓存），
 * 宿主额外要刷的范围用 `onBeforeRetest` 注入（设置页用它带上三个检测器）。
 * `EnvPanel` 自身不再渲染任何刷新按钮，所以"同屏两个"在结构上不可能再出现，
 * 也不再有"两个按钮刷的东西不一样"这种隐藏差异。
 */
import type { RefObject } from "react";
import type { EnvPanelHandle } from "./EnvPanel";

export function EnvRetestButton({ panel, onBeforeRetest, className = "" }: {
  panel: RefObject<EnvPanelHandle | null>;
  /** 宿主自己的刷新范围（如 Git/Node/CodeGraph），在面板重探之前执行 */
  onBeforeRetest?: () => void;
  className?: string;
}): JSX.Element {
  return (
    <button
      className={`em-hover-control px-3 py-2 rounded-[var(--radius-lg)] text-xs text-text-secondary ${className}`}
      onClick={() => {
        onBeforeRetest?.();
        panel.current?.retest();
      }}
    >
      重新检测
    </button>
  );
}
