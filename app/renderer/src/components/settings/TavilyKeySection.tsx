/**
 * Tavily API Key 配置（引导流程「选择 AI 供应商」页用）。
 *
 * 为什么独立于设置页的 BuiltinToolsSection：那块是"三能力开关 + 展开填 key"，还含 Vision
 * 的模式/地址/模型；引导页只需要 Tavily 一个 key，且交互不同（这里**填写即启用**，设置页是显式开关）。
 * 但**存储与合并约定与设置页完全一致**——同一个 `settings.apiKeys.TAVILY_API_KEY`，
 * 写入前必须以主进程配置为基底合并（组件态在加载失败时为空，用它整体覆盖会清掉别的 key）。
 *
 * ⚠️ 填写后必须同时打开 `builtinTools.webSearch` / `webFetch`：能力可用性判据是
 * `builtinTools.webSearch === true && !!apiKeys.TAVILY_API_KEY`（见 api-clients.ts），
 * 只写 key 不开开关 = 用户以为配好了、实际不可用（与"装完依赖不重置沙盒缓存"同类的静默失效）。
 */
import { useEffect, useRef, useState } from "react";

const TAVILY_KEY_URL = "https://app.tavily.com/home";

/** 与最后一次成功持久化的值比较，不能与输入框的实时 state 比较。 */
export function shouldPersistTavilyKey(raw: string, loaded: boolean, persisted: string): boolean {
  return loaded && raw.trim() !== persisted;
}

export function TavilyKeySection(): JSX.Element {
  const [value, setValue] = useState("");
  const [loaded, setLoaded] = useState(false);
  const [show, setShow] = useState(false);
  const persistedValue = useRef("");

  useEffect(() => {
    void (async () => {
      const s = await window.electronAPI.settings.get();
      const saved = s.apiKeys?.TAVILY_API_KEY ?? "";
      persistedValue.current = saved;
      setValue(saved);
      setLoaded(true);
    })();
  }, []);

  const save = async (raw: string): Promise<void> => {
    const v = raw.trim();
    if (!shouldPersistTavilyKey(v, loaded, persistedValue.current)) return;
    // 以主进程配置为基底（组件态可能是空的，整体覆盖会清掉其他 key）
    const s = await window.electronAPI.settings.get();
    setValue(v);
    await window.electronAPI.settings.set("apiKeys", { ...(s.apiKeys ?? {}), TAVILY_API_KEY: v });
    // 填了 key 就把两项能力一起打开，否则填了也不生效（判据见文件头）；清空时不动开关
    if (v) {
      await window.electronAPI.settings.set("builtinTools", {
        ...(s.builtinTools ?? {}),
        webSearch: true,
        webFetch: true,
      });
    }
    persistedValue.current = v;
  };

  return (
    <div className="mt-4 bg-surface-alt rounded-[var(--radius-lg)] p-4">
      <div className="flex items-center gap-2">
        <span className="text-sm font-medium text-text-primary">联网能力</span>
        <span className="text-[length:var(--text-2xs)] px-1.5 py-0.5 rounded-[var(--radius-lg)] bg-surface-hover text-text-muted">
          可选
        </span>
      </div>
      <p className="text-[length:var(--text-11)] text-text-secondary mt-0.5 mb-3">
        让 Mint 能联网搜索资料、读取网页内容；<span className="text-text-muted">不填写则无法使用网络搜索与网页抓取</span>
      </p>

      <label className="text-[length:var(--text-2xs)] text-text-secondary block mb-1">
        Tavily API Key
      </label>
      <div className="relative">
        <input
          type={show ? "text" : "password"}
          className="em-input w-full px-2.5 py-1.5 pr-8 text-text-primary text-xs"
          placeholder="tvly-..."
          value={value}
          onChange={(e) => setValue(e.target.value)}
          onBlur={(e) => void save(e.target.value)}
          onKeyDown={(e) => { if (e.key === "Enter") (e.target as HTMLInputElement).blur(); }}
        />
        <button
          type="button"
          className="absolute right-1.5 top-1/2 -translate-y-1/2 text-text-secondary hover:text-text-primary transition-colors"
          onClick={() => setShow(!show)}
          aria-label={show ? "隐藏 Key" : "显示 Key"}
        >
          {show ? (
            <svg className="w-3.5 h-3.5" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M17.94 17.94A10.07 10.07 0 0112 20c-7 0-11-8-11-8a18.45 18.45 0 015.06-5.94M9.9 4.24A9.12 9.12 0 0112 4c7 0 11 8 11 8a18.5 18.5 0 01-2.16 3.19m-6.72-1.07a3 3 0 11-4.24-4.24"/><line x1="1" y1="1" x2="23" y2="23"/></svg>
          ) : (
            <svg className="w-3.5 h-3.5" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z"/><circle cx="12" cy="12" r="3"/></svg>
          )}
        </button>
      </div>

      {value.trim() ? (
        <p className="text-[length:var(--text-2xs)] text-text-muted mt-1.5">
          已启用联网搜索与网页抓取，进入工作台即可使用
        </p>
      ) : (
        <div className="text-[length:var(--text-2xs)] text-text-muted mt-1.5 space-y-0.5">
          <p>
            获取：登录{" "}
            <a href={TAVILY_KEY_URL} target="_blank" rel="noreferrer" className="text-accent hover:underline">
              {TAVILY_KEY_URL}
            </a>{" "}
            后，在页面下方的「API Keys」处创建一个并粘贴到上方（之后可在「设置 → 模型能力增强」修改）
          </p>
          {/* 额度数字取自 Tavily 官方 Credits & Pricing：Free 1000 credits/月、basic search 1 credit/次、
              basic extract 每 5 次成功抓取 1 credit。本项目两处调用都用 basic 档（api-clients.ts 的
              search_depth / extract_depth），故按此换算；改动调用档位时这段文案要跟着改 */}
          <p>免费额度：每月 1000 积分（普通搜索 1 积分/次，网页抓取每 5 次 1 积分）</p>
        </div>
      )}
    </div>
  );
}
