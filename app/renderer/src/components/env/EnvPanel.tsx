/**
 * 环境准备面板 —— 引导流程与设置页「环境检测」共用同一套 UI 与逻辑（避免两处各写一份）。
 *
 * 交互原则（方案 §4/§7）：
 * - 只推荐"能自动装的"：一键安装缺失项；装不了的给可复制的自助命令，不猜命令。
 * - 状态四态如实呈现：ok / missing / **blocked（装了但被系统策略挡，不是没装）** / unknown（检测失败）。
 *   把后两者说成"未安装"会逼用户反复装——那是这个面板最不能犯的错。
 * - **说清"少了它会影响什么"**（`item.impact`）：用户不关心 bubblewrap 是什么，只关心不装的后果
 *   （用户 2026-09-15 反馈：此前只说缺什么、没说影响，提醒不够明确）。
 * - 实在装不了才提供「关闭沙盒运行」，且必须先说清失去什么、保留什么，并说明随时能开回来（安抚）。
 */
import { useCallback, useEffect, useImperativeHandle, useRef, useState, type Ref } from "react";
import { confirmDialog } from "../ui/ConfirmDialog";
import { useSettingsStore } from "../../stores/settings-store";

/**
 * 引导步骤的副标题文案。**检查完就不能继续说"正在检查"**（用户明确要求：
 * 无需依赖时提醒"检查完毕、继续下一步"）。抽成纯函数以便单测各状态。
 *
 * 2026-09-15 起还负责说明"现在在做什么"：自动安装中 / 已就绪正在跳下一步 / 必装项还差几项。
 */
export function onboardingHint(s: {
  probing: boolean;
  probeFailed: boolean;
  hasReport: boolean;
  /** 必装项里还没就绪的（决定能不能继续往下走） */
  requiredBroken: number;
  /** 可选项没就绪的（不影响继续，只提示） */
  optionalBroken: number;
  /** 正在自动安装/修复 */
  busy: boolean;
  /** 面板已把"就绪"交回宿主（宿主随即自动进入下一步） */
  handedOff: boolean;
}): string {
  if (s.probing || (!s.hasReport && !s.probeFailed)) {
    return "Mint 需要几个系统组件才能安全地执行命令，正在为你检查…";
  }
  if (s.probeFailed) return "检查没能完成——可点「重新检测」重试";
  if (s.handedOff) return "运行环境已就绪——正在进入下一步…";
  if (s.busy) return "正在自动安装缺少的组件（若弹出系统授权窗口，请点允许）…";
  if (s.requiredBroken > 0) {
    return `还有 ${s.requiredBroken} 项必须处理——缺少它们时命令会被拦下，下面的说明写了怎么装`;
  }
  if (s.optionalBroken > 0) {
    return `运行环境已就绪，点下方「下一步」继续；另有 ${s.optionalBroken} 项可选组件未安装，可按需安装`;
  }
  return "检查完毕——运行环境已就绪，点下方「下一步」继续";
}

/**
 * 「自动安装」的一次性决策（纯函数，便于单测）：返回这一轮该自动触发的动作。
 *
 * 跑过的动作记在 `done` 里——**失败/被用户拒绝授权框后不再自动重试**（否则会反复弹 UAC）；
 * 此时按钮仍在操作区，由用户决定何时再来。`installableCount === 0`（平台没有自动安装通道、
 * 或只能手工）时返回 null → 界面只剩自助命令，这正是"无法自动化才让用户点击"的落点。
 *
 * 两个"不该自动动手"的情形也在这里挡住：
 * - `probeFailed`：报告是上一轮的旧数据，按它去装可能装错（先让用户重测）
 * - `sandboxDisabled`：用户已明确选择"关闭沙盒运行"，不该再替他弹系统授权框（按钮仍可手点）
 */
export function nextAutoAction(s: {
  autoFix: boolean;
  hasReport: boolean;
  probeFailed: boolean;
  probing: boolean;
  installing: boolean;
  sandboxDisabled: boolean;
  installableCount: number;
  fixableCount: number;
  done: ReadonlySet<"pkg" | "userns">;
}): "pkg" | "userns" | null {
  if (!s.autoFix || !s.hasReport || s.probeFailed || s.probing || s.installing || s.sandboxDisabled) return null;
  if (s.installableCount > 0) return s.done.has("pkg") ? null : "pkg";
  if (s.fixableCount > 0) return s.done.has("userns") ? null : "userns";
  return null;
}

/** 面板对外的唯一能力：重新探测（含重置沙盒失败缓存，「装好点一下即生效」靠它）。
 *  宿主把它接到自己的「重新检测」按钮上（组件见 ./EnvRetestButton）。 */
export interface EnvPanelHandle {
  retest: () => void;
}

export function EnvPanel({ variant = "settings", autoFix = false, onReady, ref }: {
  variant?: "onboarding" | "settings";
  /** **进入即自动装**：探测完自动开始安装（引导流程用，用户要求"不需要点击"）。
   *  只自动跑一次每种动作——失败/被系统授权框拒绝后不再自动重试，按钮留着交给用户决定。 */
  autoFix?: boolean;
  /** 必装项全部就绪时回调一次（引导流程据此自动进入下一步）。宿主需传稳定引用（useCallback）。 */
  onReady?: () => void;
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
  const [handedOff, setHandedOff] = useState(false);
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
  /** 必装项未就绪（决定能否继续）vs 可选项未就绪（只提示）——引导页据此决定是"等"还是"往下走" */
  const requiredBroken = broken.filter((i) => i.required).length;
  const optionalBroken = broken.length - requiredBroken;
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

  // ── 自动安装（autoFix=true，仅引导流程）──────────────────────────────────────
  // 用户 2026-09-15 要求：「进入检测页面就自动检测和安装，不需要用户点击」。
  // 决策交给纯函数 nextAutoAction（含"每种动作只自动跑一次"），这里只负责执行。
  // 不写依赖数组：每次渲染都判一次，靠 autoDone 去重（写数组反而要在 deps 里塞一堆派生量）
  const autoDone = useRef<Set<"pkg" | "userns">>(new Set());
  useEffect(() => {
    const action = nextAutoAction({
      autoFix, hasReport: report !== null, probeFailed, probing, installing, sandboxDisabled,
      installableCount: installable.length, fixableCount: fixable.length,
      done: autoDone.current,
    });
    if (!action) return;
    autoDone.current.add(action);
    void (action === "pkg" ? install() : fixUserns());
  });

  // ── 就绪即交回宿主（引导流程据此自动进入下一步）───────────────────────────────
  // 判据用**必装项**：可选项（如 Windows 的 Git Bash）没装不挡路，只在副标题里提一句
  useEffect(() => {
    if (!onReady || !report || probing || probeFailed) return;
    if (requiredBroken > 0) return;
    setHandedOff(true);   // 副标题据此改口为"正在进入下一步"，别让用户以为卡住了
    onReady();
  }, [onReady, report, probing, probeFailed, requiredBroken]);

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
            {onboardingHint({
              probing, probeFailed, hasReport: report !== null,
              requiredBroken, optionalBroken, busy: installing, handedOff,
            })}
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
              {/* 影响说明放最前：用户要先知道"不装会怎样"，再看状态原因与命令 */}
              {item.status !== "ok" && item.impact && (
                <p className="mt-1 text-[length:var(--text-xs)] text-text-secondary leading-relaxed">{item.impact}</p>
              )}
              {item.detail && (
                <p className="mt-1 text-[length:var(--text-xs)] text-text-muted leading-relaxed break-all">{item.detail}</p>
              )}
              {/* 自助命令：装不了/被挡时唯一的出路（必须能复制，不能只有"一键"）。
                  可能是多行步骤（用 \n 分隔）——按多行展示，别用 truncate 截掉后半截。 */}
              {item.status !== "ok" && item.fix.manual?.command && (
                <div className="mt-1.5 flex items-start gap-1">
                  <code className="flex-1 min-w-0 text-[length:var(--text-xs)] leading-relaxed text-text-secondary bg-surface px-2 py-1 rounded-[var(--radius-lg)] select-all whitespace-pre-wrap break-all">
                    {item.fix.manual.command}
                  </code>
                  <button
                    className="shrink-0 px-1.5 py-1 rounded-[var(--radius-lg)] text-[length:var(--text-xs)] text-text-secondary hover:text-accent em-hover-control transition-all"
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

      {/* 进度：只表达"在忙"，不假装精确百分比（真正的进展由下面那行阶段文案说）。
          用户 2026-09-15 定稿：光带**不柔化**（硬边）且**比轨道框细**（4px，见下），
          底衬轨道是一条与光带垂直居中的 1px 细线（`bg-divider`）——往复本身是唯一的视觉主体。 */}
      {installing && (
        <div className="mt-3">
          <div className="relative h-1.5 w-full overflow-hidden">
            {/* 细线轨道：1px，与光带垂直居中对齐 */}
            <div className="absolute inset-x-0 top-1/2 h-px -translate-y-1/2 bg-divider" />
            {/* 光带：4px 厚 × 46% 宽（上下各留 1px，故 `top-px` 即居中；长度 2026-09-15 用户要求整体 +20%）。
                这里用 top-px 而非 -translate-y-1/2 —— 动画的 keyframes 写的是 transform: translateX，
                再叠一个 translate-y 工具类会与之抢同一个属性（谁赢取决于生成顺序）。
                背景（含两端渐隐的"拖尾"）在 index.css 的 .env-sweep-glow 里，故此处不能加 bg-accent。 */}
            <div className="env-sweep-glow absolute left-0 top-px h-1 w-[46%] rounded-[50%]" />
          </div>
          <p className="mt-1.5 text-[length:var(--text-xs)] text-text-muted">
            {progress?.message ?? "正在准备安装…"}
          </p>
        </div>
      )}

      {result && !result.ok && (
        <div className="mt-3 px-3 py-2 rounded-[var(--radius-lg)] bg-surface text-[length:var(--text-xs)] text-text-secondary leading-relaxed">
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
              {/* 自动装过一次后改口为"重试"：否则用户会以为是第一次，不知道自己刚才拒绝过授权框 */}
              {installing
                ? "正在安装…"
                : `${autoDone.current.has("pkg") ? "重试安装" : "一键安装"} ${installable.length} 项`}
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
        <p className="mt-1.5 text-[length:var(--text-xs)] text-danger">
          沙盒已关闭：shell、Python、Node 等命令可访问当前用户有权限访问的文件（不推荐长期如此）
        </p>
      )}
    </div>
  );
}
