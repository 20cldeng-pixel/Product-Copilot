import { useMemo, useState } from "react";
import type { ProductWorkflowSnapshot } from "@shared/product-workflow";
import { buildReviewExplanationPrompt, calculateBusinessReview, calculateDeliveryReview, reviewExportSchema, type ReviewEvent, type ReviewFilter } from "@shared/product-review";
import { postToAgent } from "../lib/agent-stream";

export function ProductReview({ snapshot, projectPath }: { snapshot: ProductWorkflowSnapshot; projectPath: string }): JSX.Element {
  const [events, setEvents] = useState<ReviewEvent[]>([]);
  const [fileName, setFileName] = useState("");
  const [error, setError] = useState("");
  const [filter, setFilter] = useState<ReviewFilter>({});
  const [explanation, setExplanation] = useState<{ key: string; text: string } | null>(null);
  const [explaining, setExplaining] = useState(false);
  const [explanationError, setExplanationError] = useState("");
  const delivery = useMemo(() => calculateDeliveryReview(snapshot), [snapshot]);
  const business = useMemo(() => calculateBusinessReview(events, filter), [events, filter]);
  const reviewKey = JSON.stringify({ delivery, business, filter });
  const versions = [...new Set(events.map((event) => event.artifactVersion))].sort();
  const activities = [...new Set(events.map((event) => event.activityId))].sort();
  const input = "rounded border border-border bg-surface p-2 text-sm";
  const rate = (value: number | null) => value === null ? "N/A" : `${(value * 100).toFixed(1)}%`;

  async function importFile(file?: File) {
    if (!file) return;
    setError("");
    try {
      if (file.size > 2_000_000) throw new Error("文件超过 2 MB 上限");
      const parsed = reviewExportSchema.parse(JSON.parse(await file.text()));
      setEvents(parsed.events);
      setFileName(file.name);
      setFilter({ source: parsed.events.some((event) => event.source === "local_trial") ? "local_trial" : "synthetic" });
    } catch (cause) { setError(`无法读取事件文件：${String(cause)}`); }
  }

  async function explainReview() {
    if (explaining) return;
    setExplaining(true);
    setExplanationError("");
    try {
      const prompt = buildReviewExplanationPrompt(delivery, business, filter);
      const result = await postToAgent({ cwd: projectPath, sessionId: null, permissionMode: "readonly" }, prompt);
      const reply = await result.replyText;
      if (!reply) throw new Error("Mint 未返回解释");
      setExplanation({ key: reviewKey, text: reply });
    } catch (cause) { setExplanationError(`解读失败：${String(cause)}`); }
    finally { setExplaining(false); }
  }

  return <section className="rounded-[var(--radius-lg)] border border-border p-4 space-y-4">
    <h2 className="font-medium">数据复盘</h2>
    <p className="text-xs text-text-secondary">交付结果来自当前产品计划的运行与证据。业务观察仅分析你选取的本地 JSON；导入本身不会发送数据到模型或修改需求。</p>
    <div className="space-y-1 text-sm">
      <h3 className="font-medium">交付质量</h3>
      <p>P0 条件 {delivery.criteria} 项：通过 {delivery.pass} · 失败 {delivery.fail} · 未判定 {delivery.inconclusive}</p>
      <p>开发回合 {delivery.buildRuns} · 测试运行 {delivery.verificationRuns} · 工具调用 {delivery.toolCalls} · 工具错误 {delivery.toolErrors} · 已记录人工决定 {delivery.manualDecisions}</p>
      <p>当前有效范围/开发确认 {delivery.currentApprovals} · 已记录变更确认 {delivery.changeApprovals}；其余追问与纠错次数未采集。</p>
      <p>已知 Builder 耗时约 {(delivery.buildDurationMs / 60000).toFixed(1)} 分钟；运行中回合不计入。费用：未知。</p>
      <p className="text-xs text-text-secondary break-all">当前测试产物摘要：{delivery.currentArtifact ?? "无当前运行"}</p>
      <p className="text-xs text-text-secondary">缺口：{delivery.missing.join("；")}。</p>
    </div>
    <div className="space-y-2 text-sm">
      <h3 className="font-medium">业务观察</h3>
      <label className="block">导入 Gather 本地体验事件（JSON） <input type="file" accept="application/json,.json" onChange={(event) => void importFile(event.target.files?.[0])} /></label>
      {error && <p role="alert" className="text-red-500">{error}</p>}
      {!fileName ? <p className="text-text-secondary">暂无事件数据。请在 Gather 页面点击“导出本地体验事件”，再导入文件；空数据不计算增长或转化。</p> : <>
        <p>文件：{fileName}。以下均为样例模拟身份的本地观察，不代表真实用户增长。默认只展示一种来源；跨来源汇总需主动选择“全部来源”。</p>
        <div className="flex flex-wrap gap-2">
          <select className={input} aria-label="产物版本" value={filter.artifactVersion ?? ""} onChange={(e) => setFilter({ ...filter, artifactVersion: e.target.value || undefined })}><option value="">全部版本</option>{versions.map((value) => <option key={value}>{value}</option>)}</select>
          <select className={input} aria-label="活动" value={filter.activityId ?? ""} onChange={(e) => setFilter({ ...filter, activityId: e.target.value || undefined })}><option value="">全部活动</option>{activities.map((value) => <option key={value}>{value}</option>)}</select>
          <select className={input} aria-label="数据来源" value={filter.source ?? ""} onChange={(e) => setFilter({ ...filter, source: e.target.value as ReviewFilter["source"] || undefined })}><option value="">全部来源</option><option value="local_trial">本机试用</option><option value="synthetic">测试/演示合成</option></select>
          <input className={input} type="datetime-local" aria-label="开始时间" onChange={(e) => setFilter({ ...filter, from: e.target.value ? new Date(e.target.value).toISOString() : undefined })} />
          <input className={input} type="datetime-local" aria-label="结束时间" onChange={(e) => setFilter({ ...filter, to: e.target.value ? new Date(e.target.value).toISOString() : undefined })} />
        </div>
        <p>事件 {business.events} 条 · 重复事件 ID {business.duplicateIds} 条 · 来源 {business.sources.join("、") || "无"} · 版本 {business.artifactVersions.join("、") || "无"}</p>
        {business.events === 0 ? <p className="text-text-secondary">当前筛选无事件；转化率 N/A。</p> : <>
          <p>浏览身份 {business.viewedUsers} · 提交身份 {business.submittedUsers} · 成功身份 {business.successfulUsers}（各按模拟身份去重，不能跨指标相除）</p>
          <p>会话内漏斗：浏览单元 {business.funnelUnits} → 提交单元 {business.submittedUnits} → 成功单元 {business.successfulUnits}；提交率 {rate(business.submitRate)} · 提交后成功率 {rate(business.successRate)}</p>
          <p>重试提交 {business.retries} 次 · 缺前置路径的事件 {business.nonFunnelEvents} 条 · 拒绝原因 {Object.entries(business.rejectedByReason).map(([key, count]) => `${key} ${count}`).join("、") || "无"}</p>
          <p className="text-xs text-text-secondary">漏斗单元为会话 ID＋模拟身份＋活动，须按时间先后有浏览→提交→成功。时间筛选不推断窗口外路径；零分母显示 N/A。</p>
        </>}
      </>}
    </div>
    <p className="text-xs text-text-secondary">下一步验证：{business.events === 0
      ? "先从样例网页导入带来源的事件，再观察不同身份与活动的报名路径。"
      : Object.keys(business.rejectedByReason).length
        ? "按当前拒绝原因选择一个高频场景访谈，核实是否需要更清楚的名额或开放状态提示。"
        : "继续积累不同活动与身份的本地试用，并核对浏览到提交的真实路径。"} 这只是待验证假设；用户采纳后才进入新草案或变更提案。</p>
    <div className="space-y-2 border-t border-border pt-3 text-sm">
      <button className="rounded border border-border px-3 py-2 disabled:opacity-50" disabled={explaining} onClick={() => void explainReview()}>{explaining ? "Mint 正在解读…" : "请 Mint 解读汇总"}</button>
      <p className="text-xs text-text-secondary">点击后仅向当前模型发送汇总数字、来源类型和筛选状态；不发送原始事件文件、模拟身份 ID 或自由文本。解读不自动修改需求，可能产生模型用量。</p>
      {explanationError && <p role="alert" className="text-red-500">{explanationError}</p>}
      {explanation?.key === reviewKey && <div className="whitespace-pre-wrap rounded bg-surface-hover p-3">{explanation.text}</div>}
    </div>
  </section>;
}
