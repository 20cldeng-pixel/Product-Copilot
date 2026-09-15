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
 * **返回 null = 这一行根本不显示**：用户 2026-09-15 接连要求"一个标题，一个动画"、
 * 去掉"正在安装系统组件…"、"正在为你检查…"也不要显示 —— 于是检测/安装进行中（`busy`）
 * 以及还没拿到结论（`!hasResult`，含探测在飞与首帧）都不出文字。真正会显示文案的只剩
 * "不忙且有结论"的少数情形，且多数是在请用户处理问题。
 */
export function onboardingHint(s: {
  /** 探测已返回报告（拿到结论）——在有报告或已失败之前不显示任何文字 */
  hasReport: boolean;
  /** 必装项里还没就绪的（决定能不能继续往下走） */
  requiredBroken: number;
  /** 可选项没就绪的（不影响继续，只提示） */
  optionalBroken: number;
  /** 正在自动安装/修复 */
  busy: boolean;
  /** 探测本身失败（≠ 没装） */
  probeFailed: boolean;
  /** 面板已把"就绪"交回宿主（宿主随即自动进入下一步） */
  handedOff: boolean;
}): string | null {
  // 没有结论（既没报告也没失败）也不显示：那一瞬是在探测，文案只会是"正在检查"这种过渡话
  if (s.busy || (!s.hasReport && !s.probeFailed)) return null;
  if (s.probeFailed) return "检查没能完成——可点「重新检测」重试";
  if (s.handedOff) return "运行环境已就绪——正在进入下一步…";
  if (s.requiredBroken > 0) {
    return `还有 ${s.requiredBroken} 项必须处理——缺少它们时命令会被拦下，下面的说明写了怎么装`;
  }
  if (s.optionalBroken > 0) {
    return `运行环境已就绪，点下方「下一步」继续；另有 ${s.optionalBroken} 项可选组件未安装，可按需安装`;
  }
  return "检查完毕——运行环境已就绪，点下方「下一步」继续";
}

/**
 * 「工作屏幕」（只有标题 + 动画，不显示依赖列表）是否可见。抽成纯函数以便单测。
 *
 * ⚠️ **判据里没有 `holdMin`**（最短停留），这是 2026-09-15 修掉的一个真缺陷：原来判的是
 * `busy || holdMin`，最短停留一走完它就变假 —— 而此刻宿主还没把页面跳走（要等 1.2s 才切步），
 * 于是那段时间**闪出一屏依赖列表**（用户报："检测没问题，还是会进入手动检测页面闪一下才跳到
 * 供应商页面"）。所以引导流程里只要"没问题且宿主会自己离开"，工作屏幕就**一直持续到本步被卸载**。
 *
 * 三种"该露出列表"的情形各自成一因：
 * - 有问题（检测失败 / 缺必装项）→ 立刻让位给提醒与建议操作，不让人对着动画干等
 * - 宿主没接管自动跳转（设置页；或用户自己按「返回」又进来）→ 该正常显示状态与「下一步」
 * - 已交回宿主（`handedOff`）仍算工作屏幕 —— 跳转前那 1.2s 不能留缝
 */
export function workScreenVisible(s: {
  /** 真在探测/安装 */
  busy: boolean;
  /** 已就绪并交回宿主，宿主正在切页 */
  handedOff: boolean;
  /** 引导流程（只有它自动装、自动走） */
  autoFix: boolean;
  /** 宿主接管了"就绪即自动离开"（传了 onReady） */
  willAutoLeave: boolean;
  /** 有必须用户处理的事：检测失败，或缺必装项 */
  hasProblem: boolean;
}): boolean {
  return s.busy || s.handedOff || (s.autoFix && s.willAutoLeave && !s.hasProblem);
}

/** 引导页"工作屏幕"（只有标题 + 动画）的最短停留：用户 2026-09-15"这个页面设置一个最小显示时间，
 *  至少显示 5 秒（不然我白做了）"。没有它，在本来就什么都不用装的机器上，探测几百毫秒就结束，
 *  动画一闪而过甚至来不及出现。 */
const MIN_WORK_SCREEN_MS = 5000;

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
  const [installing, setInstalling] = useState(false);
  const [result, setResult] = useState<EnvInstallResultShape | null>(null);
  const [copied, setCopied] = useState<string | null>(null);
  const [handedOff, setHandedOff] = useState(false);
  /** 最短停留是否还没到（仅引导流程初始为 true，见 MIN_WORK_SCREEN_MS） */
  const [holdMin, setHoldMin] = useState(autoFix);
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
  /** 真在探测/安装（与"工作屏幕是否可见"是两件事，见 workScreenVisible） */
  const busy = probing || installing;
  /** 有必须用户处理的事：检测失败，或缺必装项（可选项缺不挡路，不算） */
  const hasProblem = probeFailed || requiredBroken > 0;
  /** 宿主接管了"就绪即自动离开"（引导流程传 onReady）。用户自己「返回」再进来时宿主不再传它，
   *  面板据此回落到普通态 —— 否则会挂着一个动画、"正在进入下一步"却永远不会跳。 */
  const willAutoLeave = onReady !== undefined;
  /** 只留「标题 + 动画」（用户 2026-09-15 定："不要显示具体的在安装什么依赖，一个标题，一个动画"）。
   *  规则与三个例外见 workScreenVisible 的 docstring —— 那里也解释了为什么判据不含 holdMin。 */
  const working = workScreenVisible({ busy, handedOff, autoFix, willAutoLeave, hasProblem });
  /** 工作屏幕期间刻意静默（"一个标题，一个动画"）；交回宿主后才改口"正在进入下一步" */
  const quiet = working && !handedOff;

  const install = async (): Promise<void> => {
    if (installable.length === 0) return;
    setInstalling(true);
    setResult(null);
    try {
      const res = await window.electronAPI.env.install(installable.map((i) => i.id));
      setResult(res);
      if (res.report) setReport(res.report);
    } catch (e) {
      setResult({ ok: false, reason: (e as Error).message });
    } finally {
      setInstalling(false);
    }
  };

  /** 一键修复 userns 放行：会弹系统授权框（改的是系统安全配置，必须由用户在系统弹窗里确认） */
  const fixUserns = async (): Promise<void> => {
    setInstalling(true);
    setResult(null);
    try {
      const res = await window.electronAPI.env.fixUserns();
      setResult(res);
      if (res.report) setReport(res.report);
    } catch (e) {
      setResult({ ok: false, reason: (e as Error).message });
    } finally {
      setInstalling(false);
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

  // ── 最短停留（仅引导流程）────────────────────────────────────────────────────
  useEffect(() => {
    if (!autoFix) return;
    const timer = window.setTimeout(() => setHoldMin(false), MIN_WORK_SCREEN_MS);
    return () => window.clearTimeout(timer);
  }, [autoFix]);

  // 说明："有必须处理的就不等满"（检测失败 / 缺必装项）**不再需要一条 effect 去提前解除停留**——
  // `working` 现在直接由 `hasProblem` 派生（有问题 → 不是工作屏幕 → 立刻显示提醒与操作）。
  // 最短停留只用来决定"什么时候交回宿主"，不再参与"显示什么"。

  // ── 就绪即交回宿主（引导流程据此自动进入下一步）───────────────────────────────
  // 判据用**必装项**：可选项（如 Windows 的 Git Bash）没装不挡路，只在副标题里提一句。
  // 还要等过最短停留：否则"探一下就完事"的机器上，交回宿主 → 页面立刻跳走，动画等于没显示。
  useEffect(() => {
    if (!onReady || !report || probing || probeFailed) return;
    if (requiredBroken > 0) return;
    if (holdMin) return;
    setHandedOff(true);   // 副标题据此改口为"正在进入下一步"，别让用户以为卡住了
    onReady();
  }, [onReady, report, probing, probeFailed, requiredBroken, holdMin]);

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

  /** 步骤副标题：由纯函数决定"这一刻该不该有文字"（null = 不渲染，见其 docstring）。
   *  `quiet` 先挡一道：工作屏幕未交回宿主时只留标题 + 动画，任何文字都不抢它。 */
  const hint = variant === "onboarding" && !quiet
    ? onboardingHint({
        hasReport: report !== null, probeFailed,
        requiredBroken, optionalBroken, busy, handedOff,
      })
    : null;

  return (
    <div className={variant === "onboarding" ? "w-full max-w-[540px]" : ""}>
      {variant === "onboarding" && (
        <>
          <h1 className="text-xl font-semibold text-center mb-1">准备运行环境</h1>
          {/* 检测/安装进行中**连副标题也不显示**（用户 2026-09-15 逐条点名去掉了"正在为你检查…"
              与阶段文案）：忙的时候只有标题 + 动画，任何文字都不抢它。 */}
          {hint !== null && (
            <p className="text-text-secondary text-center text-sm mb-6">{hint}</p>
          )}
        </>
      )}

      {!working && (
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
                {/* 官方页面（下载页 / 说明文档）：`fix.manual.url` 一直在 main 侧产生，此前**渲染层
                    从不消费** —— Windows 缺 Git Bash 那条 fix 里只有 url、没有命令，等于界面上
                    完全没有指引。外链形制跟项目其它处一致（`target="_blank" rel="noreferrer"`）。 */}
                {item.status !== "ok" && item.fix.manual?.url && (
                  <a
                    href={item.fix.manual.url}
                    target="_blank"
                    rel="noreferrer"
                    className="mt-1.5 inline-block text-[length:var(--text-xs)] text-accent hover:underline"
                  >
                    {item.fix.manual.command ? "查看官方说明" : "前往下载"}
                  </a>
                )}
              </div>
            );
          })}
        </div>
      )}

      {/* 安装动画：**只有这一条动画，不配任何文字**（用户 2026-09-15："不要显示具体的在安装什么
          依赖，一个标题，一个动画"，随后又点名去掉了阶段文案 —— 所以既没有依赖名，也没有"正在…"那行）。
          形状：硬边、4px 厚 × 46% 长、两端渐隐、**无轨道**（装饰性动画，不是进度条）。
          容器就是裁剪框（`overflow-hidden` 让光带从两端出入干净），高度与光带一致。
          主进程仍在发 `env:progress` 阶段事件（preload 也仍暴露 onProgress），只是界面不再显示。 */}
      {working && (
        <div className="mt-4">
          {/* `env-sweep-clip` 让裁剪框两端各留 10% 的软化区：光带穿越边界时是淡入淡出，
              而不是被 `overflow: hidden` 竖切一刀（用户 2026-09-15 报"移动到两端时被整齐切开"）。
              软化区与光带居中占位（27%~73%）不重叠，故中央观感不变。 */}
          <div className="env-sweep-clip relative h-1 w-full overflow-hidden">
            {/* 颜色、白芯与两端渐隐都在 index.css 的 .env-sweep-glow 里（那里用 mask 裁水平渐隐），
                故此处不能加 bg-accent。也不能加 -translate-y-1/2 之类：动画 keyframes 写的是
                transform: translateX，会抢同一属性。`rounded-[50%]` 给光带一个胶囊轮廓。 */}
            <div className="env-sweep-glow absolute inset-y-0 left-0 w-[46%] rounded-[50%]" />
          </div>
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
