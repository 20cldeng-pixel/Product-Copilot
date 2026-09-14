import { useCallback, useEffect, useState } from "react";
import { useSettingsStore } from "../../stores/settings-store";

// ── Git Check ─────────────────────────────────────────────────────────────────

type DetectInfo = { found: boolean; version?: string; reason?: "not-found" | "probe-error" };

function useDetect(cmd: "git" | "nodeRuntime" | "codegraph") {
  const [info, setInfo] = useState<DetectInfo | null>(null);
  const [nonce, setNonce] = useState(0);
  useEffect(() => {
    // IPC 层报错也是「探测失败」而非「没装」——避免把异常断言成未安装
    window.electronAPI?.[cmd]?.detect().then(setInfo).catch(() => setInfo({ found: false, reason: "probe-error" }));
  }, [cmd, nonce]);
  /** 重新检测：先置空显示「检测中...」，再触发一次 IPC——装了工具但没重启 EM 时用它重测 */
  const refresh = useCallback(() => {
    setInfo(null);
    setNonce((n) => n + 1);
  }, []);
  return { info, refresh };
}

function EnvRow({ label, info, installUrl }: {
  label: string;
  info: DetectInfo | null;
  installUrl?: string;
}) {
  return (
    <div className="px-4 py-2.5 flex items-center justify-between em-hover-row transition-shadow">
      <div className="flex items-center gap-2">
        <span className="text-sm text-text-secondary">{label}</span>
        {info === null ? (
          <span className="text-xs text-text-muted">检测中...</span>
        ) : info.found ? (
          <span className="text-xs text-text-secondary">{info.version}</span>
        ) : (
          <span className="text-xs text-danger">未安装</span>
        )}
      </div>
      {info && !info.found && installUrl && (
        <a
          href={installUrl}
          target="_blank"
          rel="noopener noreferrer"
          className="px-3 py-1.5 rounded-[var(--radius-lg)] btn-accent text-xs font-medium"
        >
          点击安装 {label}
        </a>
      )}
    </div>
  );
}

function CodegraphRow({ info }: { info: DetectInfo | null }) {
  // Windows 无 sh：原 curl|sh 在 PowerShell/cmd 下必失败，按平台给对应安装器
  const isWin = window.electronAPI?.platform === "win32";
  const cmd = isWin
    ? "irm https://raw.githubusercontent.com/colbymchenry/codegraph/main/install.ps1 | iex"
    : "curl -fsSL https://raw.githubusercontent.com/colbymchenry/codegraph/main/install.sh | sh";
  const [copied, setCopied] = useState(false);

  const handleCopy = async () => {
    await navigator.clipboard.writeText(cmd);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };

  return (
    <div className="px-4 py-2.5 flex items-start justify-between em-hover-row transition-shadow">
      <div className="flex items-center gap-2 mt-1">
        <span className="text-sm text-text-secondary">CodeGraph</span>
        {info === null ? (
          <span className="text-xs text-text-muted">检测中...</span>
        ) : info.found ? (
          <span className="text-xs text-text-secondary">{info.version}</span>
        ) : info.reason === "probe-error" ? (
          <span className="text-xs text-danger">检测失败，可点「重新检测」重试</span>
        ) : (
          <span className="text-xs text-danger">未安装</span>
        )}
      </div>
      {info && !info.found && info.reason !== "probe-error" && (
        <div className="flex flex-col items-end gap-1.5">
          <div className="flex items-center gap-1">
            <code className="text-[length:var(--text-2xs)] text-text-secondary bg-surface px-2 py-0.5 rounded-[var(--radius-lg)] select-all">{cmd}</code>
            <button
              className="shrink-0 px-1.5 py-0.5 rounded-[var(--radius-lg)] text-[length:var(--text-2xs)] text-text-secondary hover:text-accent em-hover-control transition-all"
              onClick={handleCopy}
            >
              {copied ? "已复制" : "复制"}
            </button>
          </div>
          <span className="text-[length:var(--text-2xs)] text-text-muted">
            {isWin ? "在 PowerShell 中运行 · " : ""}https://github.com/colbymchenry/codegraph
          </span>
        </div>
      )}
    </div>
  );
}

// ── 系统保护（沙盒）─────────────────────────────────────────────────────────────

type SandboxInfo = { found: boolean; missing: string[]; blockedReason?: string; reason?: "probe-error" };

/** Linux 上 srt 需要的系统依赖；缺失时前台命令一律不执行（fail-closed），故在设置页给安装指引 */
function useSandboxDetect() {
  const [info, setInfo] = useState<SandboxInfo | null>(null);
  const [nonce, setNonce] = useState(0);
  useEffect(() => {
    window.electronAPI?.sandbox?.detect().then(setInfo).catch(() => setInfo({ found: false, missing: [], reason: "probe-error" }));
  }, [nonce]);
  const refresh = useCallback(() => { setInfo(null); setNonce((n) => n + 1); }, []);
  return { info, refresh };
}

const SANDBOX_INSTALL_CMD = "sudo apt install bubblewrap socat ripgrep";

function SandboxRow({ info }: { info: SandboxInfo | null }): JSX.Element {
  const isLinux = window.electronAPI?.platform === "linux";
  const sandboxDisabled = useSettingsStore((s) => s.sandboxDisabled);
  const setSandboxDisabled = useSettingsStore((s) => s.setSandboxDisabled);
  const [copied, setCopied] = useState(false);

  const handleCopy = async () => {
    await navigator.clipboard.writeText(SANDBOX_INSTALL_CMD);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };

  const broken = !!info && !info.found && info.reason !== "probe-error";
  return (
    <div className="px-4 py-2.5 em-hover-row transition-shadow">
      <div className="flex items-start justify-between">
        <div className="flex items-center gap-2 mt-1">
          <span className="text-sm text-text-secondary">系统保护（沙盒）</span>
          {info === null ? (
            <span className="text-xs text-text-muted">检测中...</span>
          ) : info.reason === "probe-error" ? (
            <span className="text-xs text-danger">检测失败，可点「重新检测」重试</span>
          ) : info.found ? (
            <span className="text-xs text-text-secondary">{sandboxDisabled ? "可用（已手动关闭）" : "可用"}</span>
          ) : info.missing.length > 0 ? (
            <span className="text-xs text-danger">缺少 {info.missing.join("、")}</span>
          ) : (
            <span className="text-xs text-danger">不可用</span>
          )}
        </div>
        {broken && info?.missing.length ? (
          <div className="flex flex-col items-end gap-1.5">
            <div className="flex items-center gap-1">
              <code className="text-[length:var(--text-2xs)] text-text-secondary bg-surface px-2 py-0.5 rounded-[var(--radius-lg)] select-all">{SANDBOX_INSTALL_CMD}</code>
              <button
                className="shrink-0 px-1.5 py-0.5 rounded-[var(--radius-lg)] text-[length:var(--text-2xs)] text-text-secondary hover:text-accent em-hover-control transition-all"
                onClick={handleCopy}
              >
                {copied ? "已复制" : "复制"}
              </button>
            </div>
            <span className="text-[length:var(--text-2xs)] text-text-muted">
              Fedora/RHEL 用 sudo dnf install、Arch 用 sudo pacman -S（同三个包）；装好点上方「重新检测」，不必重启
            </span>
          </div>
        ) : null}
      </div>

      {broken && info?.blockedReason && (
        <p className="mt-1.5 text-[length:var(--text-2xs)] text-text-muted break-all">{info.blockedReason}</p>
      )}

      {isLinux && broken && (
        <div className="mt-2 flex items-center justify-between gap-3">
          <span className="text-[length:var(--text-2xs)] text-text-muted">
            装不了时可以先关掉沙盒继续用——命令将不再受系统层限制（EasyMint 自身的路径禁区检查仍生效）
          </span>
          <button
            className={`shrink-0 px-3 py-1.5 rounded-[var(--radius-lg)] text-xs em-hover-control transition-shadow ${sandboxDisabled ? "text-text-secondary" : "text-danger"}`}
            onClick={() => setSandboxDisabled(!sandboxDisabled)}
          >
            {sandboxDisabled ? "重新开启沙盒" : "关闭沙盒运行"}
          </button>
        </div>
      )}

      {isLinux && sandboxDisabled && !broken && (
        <div className="mt-2 flex items-center justify-between gap-3">
          <span className="text-[length:var(--text-2xs)] text-danger">沙盒已关闭：命令不受系统层限制（不推荐长期如此）</span>
          <button
            className="shrink-0 px-3 py-1.5 rounded-[var(--radius-lg)] text-xs text-text-secondary em-hover-control transition-shadow"
            onClick={() => setSandboxDisabled(false)}
          >
            重新开启沙盒
          </button>
        </div>
      )}
    </div>
  );
}

function EnvCheckSection(): JSX.Element {
  const git = useDetect("git");
  const nodeRt = useDetect("nodeRuntime");
  const codegraph = useDetect("codegraph");
  const sandbox = useSandboxDetect();

  return (
    <section>
      <div className="flex items-center justify-between mb-2">
        <h3 className="text-sm font-medium text-text-secondary">环境检测</h3>
        <button
          className="px-3 py-1.5 rounded-[var(--radius-lg)] text-xs text-text-secondary em-hover-control transition-shadow"
          onClick={() => { git.refresh(); nodeRt.refresh(); codegraph.refresh(); sandbox.refresh(); }}
        >
          重新检测
        </button>
      </div>
      <div className="bg-surface-alt rounded-[var(--radius-lg)] overflow-hidden">
        <EnvRow label="Git" info={git.info} installUrl="https://git-scm.com/downloads" />
        <EnvRow label="Node.js" info={nodeRt.info} installUrl="https://nodejs.org/" />
        <CodegraphRow info={codegraph.info} />
        <SandboxRow info={sandbox.info} />
      </div>
    </section>
  );
}

// ── Cache Management ──────────────────────────────────────────────────────────

function formatMB(bytes: number): string {
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function CacheManagementSection(): JSX.Element {
  const [clearing, setClearing] = useState(false);
  const [updateSize, setUpdateSize] = useState<number | null>(null);
  const [uploadSize, setUploadSize] = useState<number | null>(null);

  const scan = () => {
    window.electronAPI?.app?.updateCacheSize?.().then(setUpdateSize).catch(() => {});
    window.electronAPI?.upload?.stats?.().then((s) => setUploadSize(s.totalSize)).catch(() => {});
  };
  useEffect(() => { scan(); }, []);

  const handleClear = async () => {
    setClearing(true);
    await window.electronAPI?.app?.clearUpdateCache?.();
    await scan();
    setClearing(false);
  };

  return (
    <section>
      <h3 className="text-sm font-medium text-text-secondary mb-2">缓存管理</h3>
      <div className="bg-surface-alt rounded-[var(--radius-lg)] overflow-hidden">

        <div className="px-4 py-3 flex items-center justify-between em-hover-row transition-shadow">
          <div>
            <h4 className="text-xs font-medium text-text-secondary">安装包缓存</h4>
            {updateSize === null ? (
              <p className="text-[length:var(--text-11)] text-text-muted">扫描中...</p>
            ) : updateSize > 0 ? (
              <p className="text-[length:var(--text-11)] text-text-secondary">{formatMB(updateSize)}</p>
            ) : (
              <p className="text-[length:var(--text-11)] text-text-muted">暂无缓存</p>
            )}
          </div>
          {updateSize !== null && updateSize > 0 && (
            <div className="flex items-center gap-1.5 shrink-0">
              <button
                className="px-3 py-1.5 rounded-[var(--radius-lg)] text-xs text-text-secondary em-hover-control transition-shadow"
                onClick={handleClear}
                disabled={clearing}
              >
                {clearing ? "清除中..." : "清除缓存"}
              </button>
              <button
                className="px-3 py-1.5 rounded-[var(--radius-lg)] text-xs text-text-secondary em-hover-control transition-shadow"
                onClick={() => window.electronAPI?.app?.openUpdateCache?.()}
              >
                文件夹
              </button>
            </div>
          )}
        </div>

        <div className="px-4 py-3 flex items-center justify-between em-hover-row transition-shadow">
          <div>
            <h4 className="text-xs font-medium text-text-secondary">上传缓存</h4>
            {uploadSize === null ? (
              <p className="text-[length:var(--text-11)] text-text-muted">扫描中...</p>
            ) : uploadSize > 0 ? (
              <p className="text-[length:var(--text-11)] text-text-secondary">{formatMB(uploadSize)}</p>
            ) : (
              <p className="text-[length:var(--text-11)] text-text-muted">暂无缓存</p>
            )}
          </div>
          {uploadSize !== null && uploadSize > 0 && (
            <button
              className="px-3 py-1.5 rounded-[var(--radius-lg)] text-xs text-text-secondary em-hover-control transition-shadow"
              onClick={() => window.electronAPI?.upload?.openDir?.()}
            >
              打开文件夹
            </button>
          )}
        </div>

      </div>
    </section>
  );
}

/** 通用设置:默认项目路径 / 压缩阈值 / 缓存 / 环境检测 */
export function GeneralTab(): JSX.Element {
  const {
    defaultProjectDir,
    contextThreshold,
    setDefaultProjectDir,
    setContextThreshold,
  } = useSettingsStore();

  return (
    <div className="space-y-5">
      {/* 路径 */}
      <section>
        <h3 className="text-sm font-medium text-text-secondary mb-2">默认项目路径</h3>
        <div className="bg-surface-alt rounded-[var(--radius-lg)] px-4 py-3">
          <input
            className="em-input w-full px-3 py-2 text-text-primary text-sm"
            placeholder="~/EasyMintProject"
            value={defaultProjectDir}
            onChange={(e) => setDefaultProjectDir(e.target.value)}
          />
          <p className="text-[length:var(--text-2xs)] text-text-secondary mt-0.5">新建项目的默认位置，workspace 会话也存于此</p>
        </div>
      </section>

      {/* Context threshold */}
      <section>
        <h3 className="text-sm font-medium text-text-secondary mb-2">上下文压缩阈值</h3>
        <div className="bg-surface-alt rounded-[var(--radius-lg)] px-4 py-3">
          <div className="flex items-center gap-3">
            <input
              type="range"
              min="60"
              max="80"
              step="5"
              value={contextThreshold}
              onChange={(e) => setContextThreshold(Number(e.target.value))}
              className="flex-1 accent-accent"
            />
            <span className="text-sm text-text-primary font-medium w-10 text-right">{contextThreshold}%</span>
          </div>
          <p className="text-[length:var(--text-11)] text-text-secondary mt-1">达到阈值时询问是否压缩（可跳过）；SDK 在接近满时自动压缩。范围 60%-80%，建议 75%</p>
        </div>
      </section>

      {/* 更新缓存 */}
      <CacheManagementSection />

      {/* 环境检测 */}
      <EnvCheckSection />
    </div>
  );
}
