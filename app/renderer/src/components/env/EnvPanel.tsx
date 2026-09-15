/**
 * 环境准备面板 —— 引导流程与设置页「环境检测」共用同一套 UI 与逻辑（避免两处各写一份）。
 *
 * 交互原则（方案 §4/§7）：
 * - 只推荐"能自动装的"：一键安装缺失项；装不了的给可复制的自助命令，不猜命令。
 * - 状态四态如实呈现：ok / missing / **blocked（装了但被系统策略挡，不是没装）** / unknown（检测失败）。
 *   把后两者说成"未安装"会逼用户反复装——那是这个面板最不能犯的错。
 * - 实在装不了才提供「关闭沙盒运行」，且必须先说清失去什么、保留什么，并说明随时能开回来（安抚）。
 */
import { useCallback, useEffect, useImperativeHandle, useState, type Ref } from "react";
import { confirmDialog } from "../ui/ConfirmDialog";
import { useSettingsStore } from "../../stores/settings-store";

/**
 * 引导步骤的副标题文案。**检查完就不能继续说"正在检查"**（用户明确要求：
 * 无需依赖时提醒"检查完毕、继续下一步"）。抽成纯函数以便单测各状态。
 */
export function onboardingHint(s: {
  probing: boolean;
  probeFailed: boolean;
  hasReport: boolean;
  brokenCount: number;
}): string {
  if (s.probing || (!s.hasReport && !s.probeFailed)) {
    return "Mint 需要几个系统组件才能安全地执行命令，正在为你检查…";
  }
  if (s.probeFailed) return "检查没能完成——可点「重新检测」重试";
  if (s.brokenCount > 0) {
    return `检查完毕——有 ${s.brokenCount} 项需要处理，按下面对应的提示装好后即可继续`;
  }
  return "检查完毕——运行环境已就绪，点下方「下一步」继续";
}

/** 面板对外的唯一能力：重新探测（含重置沙盒失败缓存，「装好点一下即生效」靠它）。
 *  宿主把它接到自己的「重新检测」按钮上（组件见 ./EnvRetestButton）。 */
export interface EnvPanelHandle {
  retest: () => void;
}

export function EnvPanel({ variant = "settings", ref }: {
  variant?: "onboarding" | "settings";
  /** 宿主用它驱动重探。**面板自身不再渲染任何「重新检测」按钮**——
   *  按钮由宿主提供，全项目只有一处定义（EnvRetestButton），避免同屏两个、刷一半的两套逻辑 */
  ref?: Ref<EnvPanelHandle>;
}): JSX.Element {
  const [report, setReport] = useState<EnvReportShape | null>(null);
  const [probeFailed, setProbeFailed] = useState(false);
  const [probing, setProbing] = useState(false);
  const [progress, setProgress] = useState<EnvProgressShape | null>(null);
  const [installing, setInstalling] = useState(false);
  const [result, setResult] = useState<EnvInstallResultShape | null>(null);
  const [copied, setCopied] = useState<string | null>(null);
  const sandboxDisabled = useSettingsStore((s) => s.sandboxDisabled);
  const setSandboxDisabled = useSettingsStore((s) => s.setSandboxDisabled);

  const refresh = useCallback(async (reset = true): Promise<void> => {
    setResult(null);
    setProbeFailed(false);
    setProbing(true); // 探测在飞时不要把上一次的结论当现状显示（尤其"正在检查"与"检查完毕"）
    try {
      const r = await (reset ? window.electronAPI.env.retest() : window.electronAPI.env.probe());
      setReport(r);
    } catch {
      setProbeFailed(true); // 探测失败 ≠ 没装（文案必须区分开）
    } finally {
      setProbing(false);
    }
  }, []);

  useEffect(() => { void refresh(false); }, [refresh]);

  // 宿主「重新检测」的入口：重探并**重置沙盒失败缓存**（reset=true）——装好依赖后不重置的话，
  // 缓存的 fail-closed 会让用户以为白装了。
  useImperativeHandle(ref, () => ({ retest: (): void => { void refresh(true); } }), [refresh]);

  // 安装进度：订阅主进程阶段事件（不看包管理器输出）
  useEffect(() => {
    const off = window.electronAPI.env.onProgress((ev) => setProgress(ev));
    return off;
  }, []);

  const items = report?.items ?? [];
  const broken = items.filter((i) => i.status !== "ok");
  /** 能自动装的（fix.auto 且有包名由 main 侧白名单决定）；blocked/unknown 不在一键安装范围。
   *  usernsProfile 走单独的「一键修复」按钮——它不吃 id 列表，混进来会被 main 侧整批拒绝 */
  const installable = broken.filter((i) => i.status === "missing" && i.fix.auto && i.fix.auto.strategy !== "usernsProfile");
  /** 被系统策略拦住、但 main 侧给出了"一键修复"策略的（目前是 bwrap 的 userns 放行） */
  const fixable = broken.filter((i) => i.status === "blocked" && i.fix.auto?.strategy === "usernsProfile");
  /** 兜底开关是否可用（关闭沙盒运行 / 重新开启） */
  const sandboxOffAvailable = broken.length > 0 && items.some((i) => i.fix.sandboxOff);
  /** 操作区是否有内容：设置页在"全部就绪"时不该留一行空白 */
  const hasActions = installable.length > 0 || fixable.length > 0 || installing
    || sandboxOffAvailable || sandboxDisabled;

  const install = async (): Promise<void> => {
    if (installable.length === 0) return;
    setInstalling(true);
    setResult(null);
    setProgress(null);
    try {
      const res = await window.electronAPI.env.install(installable.map((i) => i.id));
      setResult(res);
      if (res.report) setReport(res.report);
    } catch (e) {
      setResult({ ok: false, reason: (e as Error).message });
    } finally {
      setInstalling(false);
      setProgress(null);
    }
  };

  /** 一键修复 userns 放行：会弹系统授权框（改的是系统安全配置，必须由用户在系统弹窗里确认） */
  const fixUserns = async (): Promise<void> => {
    setInstalling(true);
    setResult(null);
    setProgress(null);
    try {
      const res = await window.electronAPI.env.fixUserns();
      setResult(res);
      if (res.report) setReport(res.report);
    } catch (e) {
      setResult({ ok: false, reason: (e as Error).message });
    } finally {
      setInstalling(false);
      setProgress(null);
    }
  };

  const copy = async (text: string): Promise<void> => {
    await navigator.clipboard.writeText(text);
    setCopied(text);
    setTimeout(() => setCopied(null), 2000);
  };

  const turnOffSandbox = async (): Promise<void> => {
    const okToOff = await confirmDialog({
      title: "关闭沙盒模式？",
      message:
        "关闭后，Mint 执行的命令不再受系统层限制（例如无法再阻止它写工作区外的文件）。\n\n"
        + "仍然保留的只有有限预检：结构化文件工具仍检查路径，已识别的提权和系统控制命令仍会被拒绝；但 shell、Python、Node 等命令可访问当前用户有权限访问的文件，包括凭据与用户目录。\n\n"
        + "你可以先用起来，等方便时在「设置 → 环境检测」里装好组件并随时开回来，不会影响已有项目与对话。",
      confirmText: "我了解，先关闭",
      danger: true,
    });
    if (okToOff) setSandboxDisabled(true);
  };

  // 阶段 → 进度百分比（不确定态用脉冲条，不假装知道百分比）。
  // 有 index/total 时按步数推进——一键修复是多步（写配置 + 加载），一直停在同一个值会显得卡住。
  const pct = ((): number => {
    if (result?.ok) return 100;
    if (!progress) return 0;
    switch (progress.phase) {
      case "preparing": return 8;
      case "installing": {
        const step = progress.total > 0 ? progress.index / progress.total : 1;
        return Math.min(85, 8 + Math.round(step * 70));
      }
      case "verifying": return 90;
      case "done": return 100;
      default: return 100;
    }
  })();

  const statusText = (s: EnvItemShape["status"]): { text: string; cls: string } => {
    switch (s) {
      case "ok": return { text: "可用", cls: "text-text-secondary" };
      case "missing": return { text: "未安装", cls: "text-danger" };
      case "blocked": return { text: "被系统策略拦住", cls: "text-danger" };
      default: return { text: "检测失败（已安装？）", cls: "text-danger" };
    }
  };

  return (
    <div className={variant === "onboarding" ? "w-full max-w-[540px]" : ""}>
      {variant === "onboarding" && (
        <>
          <h1 className="text-xl font-semibold text-center mb-1">准备运行环境</h1>
          <p className="text-text-secondary text-center text-sm mb-6">
            {onboardingHint({ probing, probeFailed, hasReport: report !== null, brokenCount: broken.length })}
          </p>
        </>
      )}

      <div className="bg-surface-alt rounded-[var(--radius-lg)] overflow-hidden">
        {probeFailed && (
          <div className="px-4 py-3 text-xs text-danger">检测失败，可点「重新检测」重试</div>
        )}
        {!probeFailed && items.length === 0 && (
          <div className="px-4 py-3 text-xs text-text-muted">无需额外组件</div>
        )}
        {items.map((item) => {
          const st = statusText(item.status);
          return (
            <div key={item.id} className="px-4 py-2.5 em-hover-row transition-shadow">
              <div className="flex items-center justify-between">
                <span className="text-sm text-text-secondary">{item.label}</span>
                <span className={`text-xs ${st.cls}`}>
                  {item.status === "ok" && item.version ? item.version : st.text}
                </span>
              </div>
              {item.detail && (
                <p className="mt-1 text-[length:var(--text-2xs)] text-text-muted break-all">{item.detail}</p>
              )}
              {/* 自助命令：装不了/被挡时唯一的出路（必须能复制，不能只有"一键"）。
                  可能是多行步骤（用 \n 分隔）——按多行展示，别用 truncate 截掉后半截。 */}
              {item.status !== "ok" && item.fix.manual?.command && (
                <div className="mt-1.5 flex items-start gap-1">
                  <code className="flex-1 min-w-0 text-[length:var(--text-2xs)] leading-relaxed text-text-secondary bg-surface px-2 py-0.5 rounded-[var(--radius-lg)] select-all whitespace-pre-wrap break-all">
                    {item.fix.manual.command}
                  </code>
                  <button
                    className="shrink-0 px-1.5 py-0.5 rounded-[var(--radius-lg)] text-[length:var(--text-2xs)] text-text-secondary hover:text-accent em-hover-control transition-all"
                    onClick={() => void copy(item.fix.manual!.command!)}
                  >
                    {copied === item.fix.manual.command ? "已复制" : "复制"}
                  </button>
                </div>
              )}
            </div>
          );
        })}
      </div>

      {/* 进度：阶段化，不假装精确百分比 */}
      {installing && (
        <div className="mt-3">
          <div className="h-1 w-full rounded-full bg-surface-hover overflow-hidden">
            <div className="h-full rounded-full bg-accent transition-[width] duration-300" style={{ width: `${pct}%` }} />
          </div>
          <p className="mt-1.5 text-[length:var(--text-2xs)] text-text-muted">
            {progress?.message ?? "正在准备安装…"}
          </p>
        </div>
      )}

      {result && !result.ok && (
        <div className="mt-3 px-3 py-2 rounded-[var(--radius-lg)] bg-surface text-[length:var(--text-2xs)] text-text-secondary leading-relaxed">
          <p>{result.reason}</p>
          {result.manualCommand && (
            <p className="mt-1">
              可复制到终端自己执行：
              <code className="select-all whitespace-pre-wrap break-all">{result.manualCommand}</code>
            </p>
          )}
        </div>
      )}
      {result?.ok && (
        <p className="mt-3 text-xs text-text-secondary">
          {broken.length === 0 ? "环境已就绪 ✓" : "所选组件已安装，请继续处理其余环境问题"}
        </p>
      )}

      {/* 操作区 */}
      {hasActions && (
        <div className="mt-4 flex items-center gap-2">
          {/* 一键修复：被系统策略拦住时的主出路（会弹系统授权框），失败仍有下方手工命令兜底 */}
          {fixable.length > 0 && (
            <button
              className="btn-accent px-4 py-2 rounded-[var(--radius-lg)] text-xs font-medium"
              disabled={installing}
              onClick={() => void fixUserns()}
            >
              {installing ? "正在修复…" : "一键修复（需系统授权）"}
            </button>
          )}
          {installable.length > 0 && (
            <button
              className="btn-accent px-4 py-2 rounded-[var(--radius-lg)] text-xs font-medium"
              disabled={installing}
              onClick={() => void install()}
            >
              {installing ? "正在安装…" : `一键安装 ${installable.length} 项`}
            </button>
          )}
          {installing && (
            <button
              className="em-hover-control px-3 py-2 rounded-[var(--radius-lg)] text-xs text-text-secondary"
              onClick={() => void window.electronAPI.env.cancel()}
            >
              取消
            </button>
          )}
          {/* 兜底：只在真有问题时出现（Linux 专属），且先讲清风险与可回退 */}
          {sandboxOffAvailable && !sandboxDisabled && (
            <button
              className="ml-auto em-hover-control px-3 py-2 rounded-[var(--radius-lg)] text-xs text-danger"
              onClick={() => void turnOffSandbox()}
            >
              关闭沙盒运行
            </button>
          )}
          {sandboxDisabled && (
            <button
              className="ml-auto em-hover-control px-3 py-2 rounded-[var(--radius-lg)] text-xs text-text-secondary"
              onClick={() => setSandboxDisabled(false)}
            >
              重新开启沙盒
            </button>
          )}
        </div>
      )}
      {sandboxDisabled && (
        <p className="mt-1.5 text-[length:var(--text-2xs)] text-danger">
          沙盒已关闭：shell、Python、Node 等命令可访问当前用户有权限访问的文件（不推荐长期如此）
        </p>
      )}
    </div>
  );
}
