import { useCallback, useEffect, useState } from "react";
import type {
  ProductDraft, ProductQuestion, ProductRequirement,
  ProductWorkflowSnapshot,
} from "@shared/product-workflow";
import { renderProductPrd } from "@shared/product-prd";
import { ProductVerification } from "./ProductVerification";
import { ProductBuild } from "./ProductBuild";
import { ProductChange } from "./ProductChange";
import { ProductReview } from "./ProductReview";

// TypeScript 没有从 ProductDraft 自动导出单条来源类型，这里沿用数组成员。
type Source = ProductDraft["research"][number];

const stages: Record<ProductWorkflowSnapshot["stage"], string> = {
  draft: "需求草案",
  scope_confirmed: "首版范围已确认",
  prototype_ready: "原型待确认",
  development_authorized: "开发已获授权",
};

function freshId(prefix: string): string { return `${prefix}-${crypto.randomUUID()}`; }

export function ProductWorkspace({ projectId, projectPath }: { projectId: string; projectPath: string }): JSX.Element {
  const [snapshot, setSnapshot] = useState<ProductWorkflowSnapshot | null>(null);
  const [draft, setDraft] = useState<ProductDraft | null>(null);
  const [dirty, setDirty] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [prototypePath, setPrototypePath] = useState(`${projectPath}/prototype/index.html`);
  const [showPrd, setShowPrd] = useState(false);

  const load = useCallback(async () => {
    const current = await window.electronAPI.productWorkflow.get(projectId);
    setSnapshot(current);
    setDraft(current.draft);
    setDirty(false);
  }, [projectId]);

  useEffect(() => {
    let active = true;
    window.electronAPI.productWorkflow.get(projectId).then((current) => {
      if (!active) return;
      setSnapshot(current);
      setDraft(current.draft);
      setDirty(false);
      setError("");
    }).catch((cause) => { if (active) setError(String(cause)); });
    return () => { active = false; };
  }, [projectId]);

  async function commit(run: (revision: number, commandId: string) => Promise<{ snapshot: ProductWorkflowSnapshot }>) {
    if (!snapshot || busy) return;
    setBusy(true);
    setError("");
    try {
      const result = await run(snapshot.revision, crypto.randomUUID());
      setSnapshot(result.snapshot);
      setDraft(result.snapshot.draft);
      setDirty(false);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setBusy(false);
    }
  }

  function edit(update: (current: ProductDraft) => ProductDraft) {
    setDraft((current) => current ? update(current) : current);
    setDirty(true);
  }

  if (!snapshot || !draft) {
    return <div className="p-6 text-text-secondary">{error || "正在读取产品计划…"}</div>;
  }

  const editable = snapshot.stage === "draft";
  const inputClass = "w-full rounded-[var(--radius-lg)] border border-border bg-surface px-3 py-2 text-sm text-text-primary";
  const actionClass = "rounded-[var(--radius-lg)] bg-accent px-4 py-2 text-sm text-white disabled:opacity-50";

  return (
    <div className="mx-auto max-w-4xl px-6 py-7 space-y-5 text-text-primary">
      <div className="flex items-start justify-between gap-4">
        <div>
          <h1 className="text-xl font-semibold">产品计划</h1>
          <p className="mt-1 text-sm text-text-secondary">需求分析 → 竞品调研 → 优先级与 PRD → 原型 → 开发与验收 → 复盘</p>
        </div>
        <div className="text-xs text-text-secondary text-right">{snapshot.revision === 0 ? "产品流程未启用" : stages[snapshot.stage]}<br />版本 {snapshot.revision}</div>
      </div>

      {snapshot.revision === 0 && <section className="rounded-[var(--radius-lg)] border border-border p-4 space-y-2">
        <p className="text-sm">启用后，Mint 会先梳理需求与原型，确认开发范围前不能写应用代码。保存草案也会启用此流程。</p>
        <button className={actionClass} disabled={dirty || busy} onClick={() => void commit((revision, commandId) => window.electronAPI.productWorkflow.activate(projectId, revision, commandId))}>启用产品流程</button>
      </section>}

      <div>
        <button className="text-sm text-accent" onClick={() => setShowPrd((value) => !value)}>
          {showPrd ? "收起 PRD" : "查看当前 PRD"}
        </button>
        {showPrd && <pre className="mt-3 max-h-96 overflow-auto whitespace-pre-wrap rounded-[var(--radius-lg)] bg-surface-hover p-4 text-xs">{renderProductPrd(snapshot)}</pre>}
      </div>

      {error && <div role="alert" className="rounded-[var(--radius-lg)] bg-red-500/10 p-3 text-sm text-red-500">{error}</div>}

      <section className="rounded-[var(--radius-lg)] border border-border p-4 space-y-3">
        <h2 className="font-medium">想法与需求</h2>
        <label className="block text-sm">想法
          <textarea className={`${inputClass} mt-1 min-h-20`} disabled={!editable} value={draft.brief.idea}
            onChange={(e) => edit((d) => ({ ...d, brief: { ...d.brief, idea: e.target.value } }))} />
        </label>
        <div className="grid grid-cols-1 gap-3 md:grid-cols-2">
          <label className="text-sm">目标用户
            <input className={`${inputClass} mt-1`} disabled={!editable} value={draft.brief.targetUser}
              onChange={(e) => edit((d) => ({ ...d, brief: { ...d.brief, targetUser: e.target.value } }))} />
          </label>
          <label className="text-sm">使用场景
            <input className={`${inputClass} mt-1`} disabled={!editable} value={draft.brief.scenario}
              onChange={(e) => edit((d) => ({ ...d, brief: { ...d.brief, scenario: e.target.value } }))} />
          </label>
        </div>
        <label className="block text-sm">约束或明确不做的内容（每行一条）
          <textarea className={`${inputClass} mt-1`} rows={2} disabled={!editable} value={draft.brief.constraints.join("\n")}
            onChange={(e) => edit((d) => ({ ...d, brief: { ...d.brief, constraints: e.target.value.split("\n").map((item) => item.trim()).filter(Boolean) } }))} />
        </label>
      </section>

      <section className="rounded-[var(--radius-lg)] border border-border p-4 space-y-3">
        <h2 className="font-medium">竞品调研</h2>
        <p className="text-xs text-text-secondary">事实与推断分别填写，保存的来源仅是记录，尚未由系统独立核验。没有可用资料时，明确记录按假设继续。</p>
        <select className={inputClass} disabled={!editable} value={draft.researchStatus}
          onChange={(e) => edit((d) => ({ ...d, researchStatus: e.target.value as ProductDraft["researchStatus"] }))}>
          <option value="pending">尚未完成</option>
          <option value="complete">已有来源</option>
          <option value="insufficient_accepted">资料不足，按假设继续</option>
        </select>
        {draft.research.map((source: Source, index: number) => (
          <div key={source.id} className="space-y-2 rounded-[var(--radius-lg)] bg-surface-hover p-3">
            <input className={inputClass} placeholder="产品或来源名称" disabled={!editable} value={source.subject}
              onChange={(e) => edit((d) => ({ ...d, research: d.research.map((item, i) => i === index ? { ...item, subject: e.target.value } : item) }))} />
            <input className={inputClass} placeholder="来源网址（可选）" disabled={!editable} value={source.sourceUrl ?? ""}
              onChange={(e) => edit((d) => ({ ...d, research: d.research.map((item, i) => i === index ? { ...item, sourceUrl: e.target.value || undefined } : item) }))} />
            <input className={inputClass} placeholder="用户提供材料的名称或引用（可选）" disabled={!editable} value={source.materialRef ?? ""}
              onChange={(e) => edit((d) => ({ ...d, research: d.research.map((item, i) => i === index ? { ...item, materialRef: e.target.value || undefined } : item) }))} />
            <input className={inputClass} placeholder="观察事实" disabled={!editable} value={source.fact}
              onChange={(e) => edit((d) => ({ ...d, research: d.research.map((item, i) => i === index ? { ...item, fact: e.target.value } : item) }))} />
            <input className={inputClass} placeholder="对本项目的推断或建议" disabled={!editable} value={source.inference}
              onChange={(e) => edit((d) => ({ ...d, research: d.research.map((item, i) => i === index ? { ...item, inference: e.target.value } : item) }))} />
            {editable && <button className="text-xs text-text-secondary" onClick={() => edit((d) => ({ ...d, research: d.research.filter((_, i) => i !== index) }))}>删除来源</button>}
          </div>
        ))}
        {editable && <button className="text-sm text-accent" onClick={() => edit((d) => ({ ...d, research: [...d.research, { id: freshId("source"), subject: "", fact: "", inference: "" }] }))}>＋ 添加来源</button>}
      </section>

      <section className="rounded-[var(--radius-lg)] border border-border p-4 space-y-3">
        <h2 className="font-medium">范围、优先级与验收</h2>
        {draft.requirements.map((req: ProductRequirement, index: number) => (
          <div key={req.id} className="grid grid-cols-1 gap-2 rounded-[var(--radius-lg)] bg-surface-hover p-3 md:grid-cols-4">
            <input className={`${inputClass} md:col-span-2`} placeholder="需求标题" disabled={!editable} value={req.title}
              onChange={(e) => edit((d) => ({ ...d, requirements: d.requirements.map((item, i) => i === index ? { ...item, title: e.target.value } : item) }))} />
            <select className={inputClass} disabled={!editable} value={req.priority}
              onChange={(e) => edit((d) => ({ ...d, requirements: d.requirements.map((item, i) => i === index ? { ...item, priority: e.target.value as ProductRequirement["priority"] } : item) }))}>
              <option value="P0">P0 本版必做</option><option value="P1">P1 候选增强</option><option value="P2">P2 后续</option>
            </select>
            {editable && <button className="text-sm text-text-secondary" onClick={() => edit((d) => ({ ...d, requirements: d.requirements.filter((_, i) => i !== index) }))}>删除需求</button>}
            <input className={`${inputClass} md:col-span-4`} placeholder="可观察行为" disabled={!editable} value={req.behavior}
              onChange={(e) => edit((d) => ({ ...d, requirements: d.requirements.map((item, i) => i === index ? { ...item, behavior: e.target.value } : item) }))} />
            <textarea className={`${inputClass} md:col-span-4`} rows={2} placeholder="验收条件；多条用换行分隔" disabled={!editable} value={req.acceptance.join("\n")}
              onChange={(e) => edit((d) => ({ ...d, requirements: d.requirements.map((item, i) => i === index ? { ...item, acceptance: e.target.value.split("\n").filter(Boolean) } : item) }))} />
          </div>
        ))}
        {editable && <button className="text-sm text-accent" onClick={() => edit((d) => ({ ...d, requirements: [...d.requirements, { id: freshId("REQ"), title: "", priority: "P0", behavior: "", acceptance: [] }] }))}>＋ 添加需求</button>}
      </section>

      <section className="rounded-[var(--radius-lg)] border border-border p-4 space-y-3">
        <h2 className="font-medium">待回答问题</h2>
        {draft.questions.map((question: ProductQuestion, index: number) => (
          <div key={question.id} className="grid grid-cols-1 gap-2 md:grid-cols-2">
            <input className={inputClass} placeholder="问题" disabled={!editable} value={question.text}
              onChange={(e) => edit((d) => ({ ...d, questions: d.questions.map((item, i) => i === index ? { ...item, text: e.target.value } : item) }))} />
            <input className={inputClass} placeholder="回答或采纳的假设" disabled={!editable} value={question.resolution ?? ""}
              onChange={(e) => edit((d) => ({ ...d, questions: d.questions.map((item, i) => i === index ? { ...item, resolution: e.target.value } : item) }))} />
            <label className="text-xs text-text-secondary"><input type="checkbox" disabled={!editable} checked={question.blocking}
              onChange={(e) => edit((d) => ({ ...d, questions: d.questions.map((item, i) => i === index ? { ...item, blocking: e.target.checked } : item) }))} /> 影响核心行为，必须回答</label>
            {editable && <button className="text-xs text-text-secondary text-left" onClick={() => edit((d) => ({ ...d, questions: d.questions.filter((_, i) => i !== index) }))}>删除问题</button>}
          </div>
        ))}
        {editable && <button className="text-sm text-accent" onClick={() => edit((d) => ({ ...d, questions: [...d.questions, { id: freshId("Q"), text: "", blocking: true }] }))}>＋ 添加问题</button>}
      </section>

      {editable && <div className="flex gap-2">
        <button className={actionClass} disabled={!dirty || busy} onClick={() => void commit((revision, commandId) => window.electronAPI.productWorkflow.saveDraft(projectId, revision, commandId, draft))}>保存草案</button>
        <button className={actionClass} disabled={dirty || busy || snapshot.revision === 0} onClick={() => void commit((revision, commandId) => window.electronAPI.productWorkflow.confirmScope(projectId, revision, commandId))}>确认首版范围</button>
      </div>}

      {snapshot.stage === "scope_confirmed" || snapshot.stage === "prototype_ready" || snapshot.stage === "development_authorized" ? (
        <section className="rounded-[var(--radius-lg)] border border-border p-4 space-y-3">
          <h2 className="font-medium">原型与开发确认</h2>
          <p className="text-xs text-text-secondary">原型由现有设计流程生成。选择当前项目 prototype 目录内的原型文件；文件变化后需要重新提交。</p>
          <input className={inputClass} value={prototypePath} onChange={(e) => setPrototypePath(e.target.value)} />
          <div className="flex gap-2">
            <button className="rounded-[var(--radius-lg)] border border-border px-4 py-2 text-sm" onClick={() => void window.electronAPI.editor.open(prototypePath).catch((cause) => setError(String(cause)))}>预览原型</button>
            <button className={actionClass} disabled={busy} onClick={() => void commit((revision, commandId) => window.electronAPI.productWorkflow.submitPrototype(projectId, revision, commandId, prototypePath))}>登记原型版本</button>
            {snapshot.stage === "prototype_ready" && <button className={actionClass} disabled={busy} onClick={() => void commit((revision, commandId) => window.electronAPI.productWorkflow.confirmDevelopment(projectId, revision, commandId))}>确认原型与开发范围</button>}
          </div>
        </section>
      ) : null}

      {snapshot.stage !== "draft" && <ProductChange key={`${projectId}-${snapshot.approvals.scope?.revision}`} snapshot={snapshot} onChange={(next) => {
        setSnapshot(next); setDraft(next.draft); setDirty(false);
      }} />}

      {(snapshot.stage === "development_authorized" || snapshot.runs.length > 0) && <>
        <ProductBuild key={`build-${projectId}`} snapshot={snapshot} onChange={setSnapshot} />
        <ProductVerification key={projectId} snapshot={snapshot} onChange={setSnapshot} />
        <ProductReview snapshot={snapshot} projectPath={projectPath} />
      </>}

      <button className="text-xs text-text-secondary" onClick={() => void load().catch((cause) => setError(String(cause)))}>刷新状态</button>
    </div>
  );
}
