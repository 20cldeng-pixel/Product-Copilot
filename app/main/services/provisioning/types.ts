/**
 * 环境自检与依赖安装：类型定义。
 *
 * 设计约束（见 docs/design/环境检测与依赖安装引导实施方案.md）：
 * - 探测必须**三态**（ok / missing / unknown），绝不把「探测失败」报成「未安装」——
 *   这条来自 codegraph-detector 的教训（同一误报潜伏 v0.6.6→v0.23.1）。
 * - 安装只走**白名单**：渲染层只能传 EnvItemId，命令由 plan.ts 按发行版生成。
 */

/** 环境条目标识。新增项必须同时更新 plan.ts 的 PACKAGE_OF（否则自动安装会拒绝） */
export type EnvItemId = "bwrap" | "socat" | "rg" | "userns";

/** ok=可用；missing=确实没有；blocked=装了但系统策略不许用（如 Ubuntu 24.04 的 AppArmor）；
 *  unknown=探测失败（**绝不能显示成"未安装"**） */
export type EnvItemStatus = "ok" | "missing" | "blocked" | "unknown";

export interface EnvFix {
  /** auto：可由 EM 自己安装（这里只给**包名**，命令在 plan.ts 按发行版生成） */
  auto?: { packages: string[] };
  /** manual：只能用户自己执行/下载 */
  manual?: { command?: string; url?: string };
  /** 只能靠关闭沙盒绕过 */
  sandboxOff?: boolean;
}

export interface EnvItem {
  id: EnvItemId;
  label: string;
  required: boolean;
  status: EnvItemStatus;
  version?: string;
  /** status=unknown 时的原因（面向用户的中文） */
  detail?: string;
  fix: EnvFix;
}

export interface EnvDistro {
  /** /etc/os-release 的 ID（ubuntu / debian / fedora / arch / opensuse…） */
  id: string;
  versionId?: string;
  /** false = 没有可用的自动安装通道（不猜命令，只把命令展示给用户） */
  autoInstallable: boolean;
}

export interface EnvReport {
  items: EnvItem[];
  distro: EnvDistro;
  probedAt: number;
}
