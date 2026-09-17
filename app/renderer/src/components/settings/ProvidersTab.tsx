import { useEffect, useState } from "react";
import { useSettingsStore } from "../../stores/settings-store";
import { ProvidersManager } from "./ProviderSettings";
import { Select } from "../Select";
import { confirmFullAccess } from "../permission-confirmation";
import { WebCapabilityConfig } from "./WebCapabilityConfig";

// ── Chat Thinking Level Section ───────────────────────────────────────────────

const CHAT_THINKING_OPTIONS: Array<{ value: string; label: string }> = [
  { value: "off", label: "关闭" },
  { value: "minimal", label: "极低" },
  { value: "low", label: "轻度" },
  { value: "medium", label: "中" },
  { value: "high", label: "高" },
  { value: "xhigh", label: "极高" },
  { value: "max", label: "最高" },
];

/** 全局聊天思考等级:仅作为新聊天会话的初始默认,不控制 agent/task 委派 */
function ChatThinkingLevelSection(): JSX.Element {
  const chatThinkingLevel = useSettingsStore((s) => s.chatThinkingLevel);
  const setChatThinkingLevel = useSettingsStore((s) => s.setChatThinkingLevel);

  return (
    <section>
      <h3 className="text-sm font-medium text-text-secondary mb-2">全局思考等级(聊天)</h3>
      <div className="bg-surface-alt rounded-[var(--radius-lg)] px-4 py-3">
        <Select
          block
          value={chatThinkingLevel}
          onChange={setChatThinkingLevel}
          options={CHAT_THINKING_OPTIONS}
         
        />
        <p className="text-[length:var(--text-2xs)] text-text-secondary mt-1.5">仅作为新聊天会话的初始默认值，也是标准委派子 Agent 的参考；Agent 模板以模板配置为准；模型不支持所选等级时自动适配到该模型最接近的支持档位，已打开的聊天可在输入栏临时切换。</p>
      </div>
    </section>
  );
}

/** 全局默认权限模式:仅作为新聊天会话的初始默认;输入条开关切换时同步更新此默认 */
function ChatPermissionModeSection(): JSX.Element {
  const chatPermissionMode = useSettingsStore((s) => s.chatPermissionMode);
  const setChatPermissionMode = useSettingsStore((s) => s.setChatPermissionMode);
  const handleChange = async (value: string): Promise<void> => {
    const mode = value as "readonly" | "standard" | "full";
    if (mode === "full" && chatPermissionMode !== "full" && !(await confirmFullAccess())) return;
    setChatPermissionMode(mode);
  };

  return (
    <section>
      <h3 className="text-sm font-medium text-text-secondary mb-2">默认权限模式(聊天)</h3>
      <div className="bg-surface-alt rounded-[var(--radius-lg)] px-4 py-3">
        <Select
          block
          value={chatPermissionMode}
          onChange={(v) => { void handleChange(v); }}
          options={[
            { value: "readonly", label: "只读（普通项目可读，敏感凭据除外）" },
            { value: "standard", label: "标准（系统沙盒内执行，工作区可写）" },
            { value: "full", label: "完全访问（普通文件无限制）" },
          ]}
        />
        <p className="text-[length:var(--text-2xs)] text-text-secondary mt-1.5">只读模式可读普通项目内容（敏感凭据除外），但不执行命令、不写文件或应用状态、不联网，适合审阅来源不明的项目。完全访问不套沙盒；系统核心、提权与持久化配置只做执行前尽力拦截，动态脚本不提供强隔离保证。</p>
      </div>
    </section>
  );
}

// ── Built-in Tools Section ────────────────────────────────────────────────────

const VISION_KEY_URL = "https://bailian.console.aliyun.com/cn-beijing?tab=model#/api-key";

function BuiltinToolsSection(): JSX.Element {
  const [apiKeys, setApiKeys] = useState<Record<string, string>>({});
  const [showKey, setShowKey] = useState(false);

  useEffect(() => {
    (async () => {
      const s = await window.electronAPI.settings.get();
      setApiKeys(s.apiKeys ?? {});
    })();
  }, []);

  // 一次算好，供下面几处条件渲染用（原来是行内 IIFE）
  const visionAnthropic = apiKeys["VISION_MODE"] === "anthropic";

  const saveKey = async (key: string, value: string) => {
    // 以主进程配置为基底：组件态在加载失败时为空，用它整体覆盖会清掉其他 key
    const s = await window.electronAPI.settings.get();
    const next = { ...(s.apiKeys ?? {}), [key]: value };
    setApiKeys(next);
    await window.electronAPI.settings.set("apiKeys", next);
  };

  return (
    <section>
      <h3 className="text-sm font-medium text-text-secondary mb-2">模型能力增强</h3>
      <p className="text-[length:var(--text-11)] text-text-secondary mb-3">
        提供视觉识别与联网能力（对非多模态模型），自动注入到每次会话
      </p>
      <div className="space-y-2">
        {/* 图片识别：与联网能力同口径——**填了 key 即启用**，没有开关（用户 2026-09-15 拍板） */}
        <div className="bg-surface-alt rounded-[var(--radius-lg)] px-4 py-3">
          <div className="text-xs font-medium text-text-secondary">图片识别</div>
          <div className="text-[length:var(--text-2xs)] text-text-muted mt-0.5">
            用视觉模型描述图片内容（填写 Key 即启用，清空即停用）
          </div>
          <div className="mt-2">
            <label className="text-[length:var(--text-2xs)] text-text-secondary block mb-1">API 模式</label>
            <div className="flex gap-4 text-xs text-text-primary">
              <label className="flex items-center gap-1.5 cursor-pointer">
                <input type="radio" name="vision-mode" className="accent-[var(--color-accent)]"
                  checked={!visionAnthropic}
                  onChange={() => saveKey("VISION_MODE", "openai")} />
                OpenAI 兼容
              </label>
              <label className="flex items-center gap-1.5 cursor-pointer">
                <input type="radio" name="vision-mode" className="accent-[var(--color-accent)]"
                  checked={visionAnthropic}
                  onChange={() => saveKey("VISION_MODE", "anthropic")} />
                Anthropic 兼容
              </label>
            </div>
            <label className="text-[length:var(--text-2xs)] text-text-secondary block mb-1 mt-2">
              {visionAnthropic
                ? "API 地址（Anthropic 兼容，默认阿里公共DashScope，可填写带有业务空间ID的专属API）"
                : "API 地址（OpenAI 兼容，默认阿里公共DashScope，可填写带有业务空间ID的专属API）"}
            </label>
            <input type="text"
              className="em-input w-full px-2 py-1.5 text-text-primary text-xs"
              defaultValue={apiKeys["VISION_BASE_URL"] || ""}
              placeholder={visionAnthropic ? "https://dashscope.aliyuncs.com/apps/anthropic" : "https://dashscope.aliyuncs.com/compatible-mode/v1"}
              onBlur={(e) => { const v = e.target.value.trim(); if (v !== (apiKeys["VISION_BASE_URL"] || "")) saveKey("VISION_BASE_URL", v); }}
              onKeyDown={(e) => { if (e.key === "Enter") (e.target as HTMLInputElement).blur(); }}
            />
            <label className="text-[length:var(--text-2xs)] text-text-secondary block mb-1 mt-2">VISION_API_KEY</label>
            <div className="relative">
              <input type={showKey ? "text" : "password"}
                className="em-input w-full px-2 py-1.5 pr-7 text-text-primary text-xs"
                defaultValue={apiKeys["VISION_API_KEY"] || ""} placeholder="未设置"
                onBlur={(e) => { const v = e.target.value.trim(); if (v !== (apiKeys["VISION_API_KEY"] || "")) saveKey("VISION_API_KEY", v); }}
                onKeyDown={(e) => { if (e.key === "Enter") (e.target as HTMLInputElement).blur(); }}
              />
              <button type="button" className="absolute right-1.5 top-1/2 -translate-y-1/2 text-text-secondary hover:text-text-primary transition-colors"
                onClick={() => setShowKey(!showKey)}>
                {showKey ? (
                  <svg className="w-3.5 h-3.5" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M17.94 17.94A10.07 10.07 0 0112 20c-7 0-11-8-11-8a18.45 18.45 0 015.06-5.94M9.9 4.24A9.12 9.12 0 0112 4c7 0 11 8 11 8a18.5 18.5 0 01-2.16 3.19m-6.72-1.07a3 3 0 11-4.24-4.24"/><line x1="1" y1="1" x2="23" y2="23"/></svg>
                ) : (
                  <svg className="w-3.5 h-3.5" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z"/><circle cx="12" cy="12" r="3"/></svg>
                )}
              </button>
            </div>
            <label className="text-[length:var(--text-2xs)] text-text-secondary block mb-1 mt-2">模型（默认 qwen3.7-flash）</label>
            <input type="text"
              className="em-input w-full px-2 py-1.5 text-text-primary text-xs"
              defaultValue={apiKeys["VISION_MODEL"] || ""} placeholder="qwen3.7-flash"
              onBlur={(e) => { const v = e.target.value.trim(); if (v !== (apiKeys["VISION_MODEL"] || "")) saveKey("VISION_MODEL", v); }}
              onKeyDown={(e) => { if (e.key === "Enter") (e.target as HTMLInputElement).blur(); }}
            />
            <div className="text-[length:var(--text-2xs)] text-text-muted mt-1">
              获取 Key：<a href={VISION_KEY_URL} target="_blank" rel="noreferrer" className="text-accent hover:underline break-all">{VISION_KEY_URL}</a>
            </div>
          </div>
        </div>

        {/* 联网能力：搜索与抓取**共用同一个 Tavily Key**，因此收成一处填写。
            此前拆成「网页抓取 / 联网搜索」两行、各带一个同 keyId 的输入框——写的是同一处存储，
            用户既不知道该填哪个，也看不出两者共用一份凭据。字段与引导页同源（WebCapabilityConfig）。 */}
        <div className="bg-surface-alt rounded-[var(--radius-lg)] px-4 py-3">
          <div className="text-xs font-medium text-text-secondary">联网能力</div>
          <div className="text-[length:var(--text-2xs)] text-text-muted mt-0.5">
            联网搜索资料、读取网页内容（两项共用一个 Tavily Key，填写即启用）
          </div>
          <div className="mt-2">
            <WebCapabilityConfig />
          </div>
        </div>
      </div>
    </section>
  );
}

/** 模型设置:供应商管理 + 全局思考等级 + 模型能力增强。
 *  供应商的添加/编辑在独立弹窗中完成(ProviderFormDialog),本页始终是列表态。 */
export function ProvidersTab(): JSX.Element {
  return (
    <div className="space-y-5">
      <ProvidersManager />
      <ChatThinkingLevelSection />
      <ChatPermissionModeSection />
      <BuiltinToolsSection />
    </div>
  );
}
