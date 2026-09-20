import { useRef, useState } from "react";
import { productDraftDiff, type ProductChangeInput } from "@shared/product-change";
import type { ProductChangeProposal, ProductDraft, ProductWorkflowSnapshot } from "@shared/product-workflow";

const labels: Record<ProductChangeProposal["status"], string> = { draft: "信息待补全", ready: "待核对确认", confirmed: "已确认", rejected: "已拒绝", superseded: "已被新范围替代" };
const lines = (value: string) => value.split("\n").map((line) => line.trim()).filter(Boolean);

export function ProductChange({ snapshot, onChange }: { snapshot: ProductWorkflowSnapshot; onChange: (state: ProductWorkflowSnapshot) => void }): JSX.Element {
  const [editor, setEditor] = useState<ProductChangeInput | null>(null);
  const [selected, setSelected] = useState(0);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const lock = useRef(false);
  const api = window.electronAPI.productWorkflow;
  const occupied = snapshot.runs.some((run) => ["queued", "running"].includes(run.executionStatus));
  const input = "w-full rounded border border-border bg-surface p-2 text-sm";
  const button = "rounded border border-border px-3 py-2 text-sm disabled:opacity-50";

  function edit(proposal?: ProductChangeProposal) {
    setError(""); setSelected(0);
    setEditor({ proposalId: proposal?.id, target: proposal?.target ?? "", preserve: proposal?.preserve ?? [],
      nextDraft: structuredClone(proposal?.nextDraft ?? snapshot.draft),
      impact: proposal?.impact?.map((item) => ({ ...item, files: item.files.map((file) => file.path) }))
        ?? [{ area: "待核对的影响", reason: "", files: [] }],
    });
  }
  function updateDraft(update: (draft: ProductDraft) => ProductDraft) {
    setEditor((current) => current ? { ...current, nextDraft: update(current.nextDraft) } : current);
  }
  async function perform(action: (id: string) => Promise<{ snapshot: ProductWorkflowSnapshot }>, closeEditor = false) {
    if (lock.current) return;
    lock.current = true; setBusy(true); setError("");
    try { onChange((await action(crypto.randomUUID())).snapshot); if (closeEditor) setEditor(null); }
    catch (cause) { setError(String(cause)); }
    finally { lock.current = false; setBusy(false); }
  }

  return <section className="rounded-[var(--radius-lg)] border border-border p-4 space-y-4">
    <div className="flex justify-between gap-3"><h2 className="font-medium">需求变更</h2>
      <button className={button} disabled={busy} onClick={() => edit()}>提出变更</button>
    </div>
    <p className="text-sm text-text-secondary">提案保存后才可确认。确认会更新正式需求，原型与开发批准、旧验收结果失效；需要重新确认原型后开发。</p>
    {error && <p role="alert" className="text-sm text-red-500">{error}</p>}
    {editor && <div className="space-y-3 rounded bg-surface-hover p-3">
      <label className="block text-sm">这次改什么
        <textarea className={input} value={editor.target} disabled={busy} onChange={(event) => setEditor({ ...editor, target: event.target.value })} />
      </label>
      <label className="block text-sm">需要修改的需求
        <select className={input} value={selected} onChange={(event) => setSelected(Number(event.target.value))}>
          {editor.nextDraft.requirements.map((req, index) => <option key={req.id} value={index}>{req.priority} · {req.title}</option>)}
        </select>
      </label>
      {editor.nextDraft.requirements[selected] && <>
        <label className="block text-sm">新的可观察行为
          <textarea className={input} disabled={busy} value={editor.nextDraft.requirements[selected].behavior} onChange={(event) => updateDraft((draft) => ({ ...draft, requirements: draft.requirements.map((req, i) => i === selected ? { ...req, behavior: event.target.value } : req) }))} />
        </label>
        <label className="block text-sm">新的验收条件（每行一条）
          <textarea className={input} rows={4} disabled={busy} value={editor.nextDraft.requirements[selected].acceptance.join("\n")} onChange={(event) => updateDraft((draft) => ({ ...draft, requirements: draft.requirements.map((req, i) => i === selected ? { ...req, acceptance: event.target.value.split("\n") } : req) }))} />
        </label>
      </>}
      <details><summary className="cursor-pointer text-sm">同步调整约束与已采纳答案</summary>
        <label className="block text-sm mt-2">产品约束（每行一条）
          <textarea className={input} rows={3} value={editor.nextDraft.brief.constraints.join("\n")} onChange={(event) => updateDraft((draft) => ({ ...draft, brief: { ...draft.brief, constraints: event.target.value.split("\n") } }))} />
        </label>
        {editor.nextDraft.questions.map((question, index) => <label key={question.id} className="block text-sm mt-2">{question.text}
          <input className={input} value={question.resolution ?? ""} onChange={(event) => updateDraft((draft) => ({ ...draft, questions: draft.questions.map((item, i) => i === index ? { ...item, resolution: event.target.value } : item) }))} />
        </label>)}
      </details>
      <label className="block text-sm">必须保留的行为与数据（每行一条）
        <textarea className={input} rows={3} value={editor.preserve.join("\n")} onChange={(event) => setEditor({ ...editor, preserve: event.target.value.split("\n") })} />
      </label>
      {editor.impact.map((item, index) => <div key={index} className="space-y-2">
        <label className="block text-sm">影响对象
          <input className={input} value={item.area} onChange={(event) => setEditor({ ...editor, impact: editor.impact.map((entry, i) => i === index ? { ...entry, area: event.target.value } : entry) })} />
        </label>
        <label className="block text-sm">影响判断与不确定项
          <textarea className={input} value={item.reason} onChange={(event) => setEditor({ ...editor, impact: editor.impact.map((entry, i) => i === index ? { ...entry, reason: event.target.value } : entry) })} />
        </label>
        <details><summary className="text-xs cursor-pointer">引用代码文件（可选）</summary>
          <textarea className={input} aria-label={`引用文件 ${index + 1}`} value={item.files.join("\n")} onChange={(event) => setEditor({ ...editor, impact: editor.impact.map((entry, i) => i === index ? { ...entry, files: event.target.value.split("\n") } : entry) })} />
        </details>
      </div>)}
      <p className="text-xs text-text-secondary">文件引用仅校验存在与版本；影响判断仍需核对，不能保证完整。</p>
      <div className="flex gap-2">
        <button className={button} disabled={busy} onClick={() => void perform((id) => api.saveChange(snapshot.projectId, snapshot.revision, id, {
          ...editor, preserve: lines(editor.preserve.join("\n")),
          nextDraft: { ...editor.nextDraft, brief: { ...editor.nextDraft.brief, constraints: lines(editor.nextDraft.brief.constraints.join("\n")) }, requirements: editor.nextDraft.requirements.map((req) => ({ ...req, acceptance: lines(req.acceptance.join("\n")) })) },
          impact: editor.impact.map((item) => ({ ...item, files: lines(item.files.join("\n")) })),
        }), true)}>保存提案并查看差异</button>
        <button className={button} disabled={busy} onClick={() => setEditor(null)}>取消编辑</button>
      </div>
    </div>}
    {[...snapshot.proposals].reverse().map((proposal) => <div key={proposal.id} className="rounded bg-surface-hover p-3 space-y-2 text-sm">
      <p className="font-medium">{proposal.target} · {labels[proposal.status]}</p>
      {proposal.status === "draft" && proposal.readinessIssue && <p className="text-amber-600">{proposal.readinessIssue}</p>}
      <p>保留：{proposal.preserve.join("；")}</p>
      {proposal.impact?.map((item, index) => <div key={index} className="text-xs text-text-secondary">
        <p>{item.area}：{item.reason}</p>
        {item.files.length ? <details><summary className="cursor-pointer">{item.files.length} 个文件引用（语义影响待核对）</summary>{item.files.map((file) => <p key={file.path}>{file.path} · {file.digest.slice(0, 12)}</p>)}</details> : <p>尚无代码文件引用。</p>}
      </div>)}
      {proposal.baseDraft && proposal.nextDraft && <details open={proposal.status === "ready"}>
        <summary className="cursor-pointer text-accent">查看需求与验收前后差异</summary>
        {productDraftDiff(proposal.baseDraft, proposal.nextDraft).map((change) => <div key={change.label} className="mt-2 space-y-1">
          <p className="text-xs font-medium">{change.label}</p>
          <div className="grid gap-2 md:grid-cols-2">
            <pre className="overflow-auto whitespace-pre-wrap rounded bg-surface p-2 text-xs">原来：{change.before}</pre>
            <pre className="overflow-auto whitespace-pre-wrap rounded bg-surface p-2 text-xs">改为：{change.after}</pre>
          </div>
        </div>)}
      </details>}
      {["draft", "ready"].includes(proposal.status) && <div className="flex flex-wrap gap-2">
        <button className={button} disabled={busy} onClick={() => edit(proposal)}>修改或重新核对提案</button>
        <button className={`${button} bg-accent text-white`} disabled={busy || occupied || !!editor || proposal.status !== "ready"}
          onClick={() => void perform((id) => api.confirmChange(snapshot.projectId, snapshot.revision, id, proposal.id))}>确认变更范围</button>
        <button className={button} disabled={busy} onClick={() => void perform((id) => api.rejectChange(snapshot.projectId, snapshot.revision, id, proposal.id), true)}>拒绝提案</button>
      </div>}
    </div>)}
  </section>;
}
