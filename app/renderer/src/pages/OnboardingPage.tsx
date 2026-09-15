import { useCallback, useEffect, useRef, useState } from "react";
import { useNavigate } from "react-router-dom";
import { useSettingsStore } from "../stores/settings-store";
import { useThemeStore } from "../stores/theme-store";
import { ProviderForm } from "../components/settings/ProviderSettings";
import { EnvPanel, type EnvPanelHandle } from "../components/env/EnvPanel";
import { EnvRetestButton } from "../components/env/EnvRetestButton";
import { TavilyKeySection } from "../components/settings/TavilyKeySection";
import { WindowControls } from "../components/WindowControls";
import type { ProviderConfig, ApiProvidersData } from "@shared/platform-presets";

const STEPS = [
  { number: 1, title: "欢迎使用 EasyMint" },
  // 依赖问题必须在"进入工作台之前"处理掉：放到对话中途才发现，用户已经聊了几轮、挫败感最强
  { number: 2, title: "准备运行环境" },
  { number: 3, title: "选择 AI 供应商" },
];

/** 环境检测这一步（`currentStep === 1`）的专用布局参数：**隐藏上方的步骤指示器**，并把内容整体上移。
 *  用户 2026-09-15：「动画检测页面，不要显示上方的步骤标识，只显示标题和动画，然后整体上移 60px」。
 *  上移用内层的 `padding-bottom: 2 × 偏移` 实现——内层是 `justify-center`，底部多留 2 倍才会把内容
 *  中心抬高 1 倍。**不用 translate**：位移不参与布局，会把内容顶出滚动区（顶部从此再也滚不到）。 */
const ENV_STEP_LIFT_PX = 60;

export function OnboardingPage(): JSX.Element {
  const navigate = useNavigate();
  const isDark = useThemeStore((s) => s.effective) === "dark";
  const [currentStep, setCurrentStep] = useState(0);
  const { setApiProviders } = useSettingsStore();

  // 记录本次已保存的供应商 ID，避免重复保存
  const [savedCfg, setSavedCfg] = useState<ProviderConfig | null>(null);

  // Step 2 的「重新检测」：按钮由本页提供，动作来自面板句柄（与设置页同一份实现）
  const envPanel = useRef<EnvPanelHandle>(null);

  // 重新运行引导时预填已配置的供应商（设置 store 异步加载，故订阅而非读一次快照）：
  // 否则「重看一遍引导」会被迫重填 API Key——配置本身不丢，只是多一道无谓操作
  const apiProviders = useSettingsStore((s) => s.apiProviders);
  const prefilled = useRef(false);
  useEffect(() => {
    if (prefilled.current || !apiProviders?.current) return;
    const cur = apiProviders.configs?.[apiProviders.current];
    if (cur) setSavedCfg(cur);
    prefilled.current = true;
  }, [apiProviders]);

  const handleProviderSave = async (cfg: ProviderConfig) => {
    // 复用已保存的 ID，避免重复创建
    const id = savedCfg?.id || cfg.id;
    const finalCfg = { ...cfg, id };
    // 以主进程配置为基底：渲染态未加载完成时为空，用它重建会丢掉已有供应商配置
    const saved = (await window.electronAPI.settings.get()).apiProviders;
    const nextData: ApiProvidersData = {
      current: id,
      configs: { ...(saved?.configs ?? {}), [id]: finalCfg },
    };
    setApiProviders(nextData);
    setSavedCfg(finalCfg);
  };

  const handleComplete = () => {
    localStorage.setItem("easymint_setup_complete", "true");
    window.electronAPI?.settings?.set?.("setupComplete", true);
    window.dispatchEvent(new Event("easymint-setup-complete"));
    navigate("/");
  };

  const goNext = useCallback(() => setCurrentStep((s) => Math.min(s + 1, STEPS.length - 1)), []);
  const goPrev = useCallback(() => setCurrentStep((s) => Math.max(s - 1, 0)), []);

  // 环境就绪 → 自动进入下一步（用户 2026-09-15 要求：检测/安装完不该再让人点一次）。
  // 守卫用 ref 而非 state：**只自动跳一次**——用户自己按「返回」回到本步时不该被立刻推走（否则回不去）。
  // 延迟 1.2s 是为了让「运行环境已就绪」这句话被看见（面板副标题会同时改口为"正在进入下一步"）。
  const envAutoAdvanced = useRef(false);
  const envAdvanceTimer = useRef<number | null>(null);
  /** 面板还要不要"就绪即自动离开"。**自动跳过一次后就不再传 onReady** ——
   *  面板据此回落到普通态（显示依赖状态与「下一步」按钮），而不是挂着一个永不跳转的动画，
   *  副标题也不会一直谎报"正在进入下一步"。 */
  const [willAutoAdvance, setWillAutoAdvance] = useState(true);
  const handleEnvReady = useCallback((): void => {
    if (envAutoAdvanced.current) return;
    envAutoAdvanced.current = true;
    setWillAutoAdvance(false);
    envAdvanceTimer.current = window.setTimeout(() => {
      // 用函数式更新并判当前步：这 1.2s 里用户可能已经按「返回」，直接 +1 会把他又推回来
      setCurrentStep((s) => (s === 1 ? s + 1 : s));
    }, 1200);
  }, []);
  useEffect(() => () => {
    if (envAdvanceTimer.current !== null) window.clearTimeout(envAdvanceTimer.current);
  }, []);

  return (
    <div className="flex flex-col h-full">
      {/* Windows 自绘窗口按钮 + 顶部拖拽区（无 TabBar 的页面单独提供） */}
      <div className="relative h-[35px] shrink-0" style={{ WebkitAppRegion: "drag" } as React.CSSProperties}>
        <WindowControls />
      </div>
      {/* Step indicator —— **环境检测这一步整块不渲染**（用户 2026-09-15：这一步只留标题 + 动画）。
          连带它那截 `pt-12` 的留白一起消失，内容区自然变高、内容上提。 */}
      {currentStep !== 1 && (
        <div className="flex justify-center gap-3 pt-12 pb-2">
          {STEPS.map((step, i) => (
            <div key={step.number} className="flex items-center gap-3">
              <div
                className={`w-2 h-2 rounded-full transition-colors ${
                  i < currentStep
                    ? "bg-accent"
                    : i === currentStep
                      ? "bg-accent ring-2 ring-accent-border"
                      : "bg-text-muted"
                }`}
              />
              {i < STEPS.length - 1 && (
                <div
                  className={`w-8 h-[2px] transition-colors ${
                    i < currentStep ? "bg-accent" : "bg-text-muted"
                  }`}
                />
              )}
            </div>
          ))}
        </div>
      )}

      {/* Content：外层必须可滚动（overflow-y-auto），否则 flex-1 项的 min-height:auto
          会让超高内容把 footer 顶出视口，而 #app-shell 是 overflow:hidden —— 实测（1400×900 窗口、
          表单展开态）：不加滚动时内容区高 869 > 可用空间 642，footer 被裁 227px、「进入工作台」
          完全不可见；加上后 footer 稳定留在视口内，超高内容在内容区内部滚动。
          内层用 flex-1，**不要用 min-h-full**：min-height:100% 在这个 flex 项父容器上解析不出来
          （实测内层退化成内容高、内容贴顶），flex-1 + justify-center 才能既撑满又居中。 */}
      <div className="flex-1 overflow-y-auto px-8 pb-8 flex flex-col">
        {/* 环境检测这一步整体上移（见 ENV_STEP_LIFT_PX）；其余步骤保持居中 */}
        <div
          className="flex-1 flex flex-col items-center justify-center"
          style={currentStep === 1 ? { paddingBottom: ENV_STEP_LIFT_PX * 2 } : undefined}
        >
          {currentStep === 0 ? (
            /* ── Step 1: Welcome ── */
            <div className="w-full max-w-[480px] flex flex-col items-center text-center">
              {/* Logo：直接用图标本身（素材自带圆角口径），不套卡片容器——容器形状会在图标四角外露（形状套两层）、
                  且图标本体只占图片 80.5%，套容器后可见图标更小。与关于页（无容器、图标直接 80px）一致。
                  图标跟随主题取亮/暗版（与关于页、Dock 同一套素材） */}
              <img src={isDark ? "appicon-dark.png" : "appicon-light.png"} alt="EasyMint" className="w-24 h-24 mb-6" />

              <h1 className="text-2xl font-bold text-text-primary mb-2">EasyMint</h1>
              <p className="text-sm text-text-secondary mb-1">
                AI 驱动开发，简单的操作让想法变为现实
              </p>
              <p className="text-xs text-text-muted mb-8 leading-relaxed">
                填写项目需求，Mint 自动拆解任务、选择技术栈、调度 Builder 编码、
                Evaluator 验收，你只需要对话。
              </p>

              <div className="flex flex-col gap-3 w-full">
                <div className="px-4 py-3 rounded-[var(--radius-lg)] bg-surface-alt text-left">
                  <p className="text-sm font-medium text-text-primary">AI 项目管理</p>
                  <p className="text-xs text-text-muted mt-0.5">
                    Mint 自动分析需求、拆分任务、跟进进度
                  </p>
                </div>
                <div className="px-4 py-3 rounded-[var(--radius-lg)] bg-surface-alt text-left">
                  <p className="text-sm font-medium text-text-primary">自动开发执行</p>
                  <p className="text-xs text-text-muted mt-0.5">
                    Builder 编码 → Evaluator 验收，全自动循环
                  </p>
                </div>
                <div className="px-4 py-3 rounded-[var(--radius-lg)] bg-surface-alt text-left">
                  <p className="text-sm font-medium text-text-primary">多供应商 API 支持</p>
                  <p className="text-xs text-text-muted mt-0.5">
                    内置 Anthropic、DeepSeek、MiMo、MiniMax 等供应商
                  </p>
                </div>
              </div>
            </div>
          ) : currentStep === 1 ? (
            /* ── Step 2: 环境准备（缺失依赖在这里装/引导，避免进工作台后命令全跑不了）──
               刷新按钮由本页提供（面板自身不再渲染）：动作与设置页是同一份实现。
               autoFix：进来就自动装（不再要求用户点「一键安装」）；就绪即自动进下一步 */
            <>
              <EnvPanel
                ref={envPanel}
                variant="onboarding"
                autoFix
                onReady={willAutoAdvance ? handleEnvReady : undefined}
              />
              <div className="mt-3">
                <EnvRetestButton panel={envPanel} />
              </div>
            </>
          ) : (
            /* ── Step 3: Provider Setup ── */
            <div className="w-full max-w-[540px]">
              <h1 className="text-xl font-semibold text-center mb-1">
                选择 AI 供应商
              </h1>
              <p className="text-text-secondary text-center text-sm mb-6">
                选择一个平台并填写 API Key 即可开始使用
              </p>
              {savedCfg ? (
                <div className="bg-surface-alt rounded-[var(--radius-lg)] p-4 space-y-4">
                  <div className="flex items-center gap-3 px-4 py-3 rounded-[var(--radius-lg)] bg-accent-soft">
                    <div className="w-2 h-2 rounded-full bg-accent shrink-0" />
                    <div className="flex-1 min-w-0">
                      <div className="flex items-center gap-2">
                        <span className="text-sm text-text-primary font-medium truncate">{savedCfg.name}</span>
                        <span className="text-[length:var(--text-2xs)] px-1.5 py-0.5 rounded-[var(--radius-lg)] bg-accent-high text-accent shrink-0">使用中</span>
                      </div>
                      <div className="text-[length:var(--text-11)] text-text-muted mt-0.5">
                        模型 {savedCfg.models.length} 个 · {savedCfg.model}
                      </div>
                    </div>
                  </div>
                  <button
                    className="em-hover-control w-full px-4 py-2 rounded-[var(--radius-lg)] text-text-secondary text-xs transition-all"
                    onClick={() => setSavedCfg(null)}
                  >重新配置</button>
                </div>
              ) : (
                <ProviderForm onSave={handleProviderSave} />
              )}
              {/* 联网能力（可选）：与供应商独立存储（settings.apiKeys）、失焦即生效，
                  所以放在表单之外——不随「保存供应商配置」提交，也不需要第二个保存按钮 */}
              <TavilyKeySection />
            </div>
          )}
        </div>
      </div>

      {/* Footer */}
      <footer className="p-4 flex justify-between bg-surface-alt shrink-0">
        {currentStep === 0 ? (
          <button
            className="btn-accent px-6 py-2 rounded-[var(--radius-lg)] font-medium ml-auto"
            onClick={goNext}
          >
            开始设置
          </button>
        ) : (
          <button
            className="em-hover-control px-6 py-2 rounded-[var(--radius-lg)] text-text-secondary transition-all"
            onClick={goPrev}
          >
            返回
          </button>
        )}
        {currentStep === 1 && (
          <button
            className="btn-accent px-6 py-2 rounded-[var(--radius-lg)] font-medium"
            onClick={goNext}
          >
            下一步
          </button>
        )}
        {currentStep === 2 && (
          <button
            className="btn-accent px-6 py-2 rounded-[var(--radius-lg)] font-medium"
            disabled={!savedCfg}
            onClick={handleComplete}
          >
            进入工作台
          </button>
        )}
      </footer>
    </div>
  );
}
