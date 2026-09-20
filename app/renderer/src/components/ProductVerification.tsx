import { useRef, useState } from "react";
import type { ProductRun, ProductWorkflowSnapshot } from "@shared/product-workflow";
import { productCriteria } from "@shared/product-verification";

const labels: Record<ProductRun["verificationStatus"], string> = {
  not_run: "尚未验收", pass: "关联检查通过", fail: "检查失败", inconclusive: "未判定", stale: "结果已失效",
};
const executionLabels: Record<ProductRun["executionStatus"], string> = {
  queued: "等待执行", running: "正在运行测试", completed: "测试执行完成", failed: "测试执行失败", interrupted: "执行中断，请重跑", cancelled: "已取消",
};

type VerificationProps = {
  snapshot: ProductWorkflowSnapshot; onChange: (state: ProductWorkflowSnapshot) => void;
};

export function ProductVerification(props: VerificationProps): JSX.Element {
  return <VerificationContent key={`${props.snapshot.projectId}:${props.snapshot.approvals.scope?.revision ?? 0}`} {...props} />;
}

function VerificationContent({ snapshot, onChange }: VerificationProps): JSX.Element {
  const [bindings, setBindings] = useState<Record<string, string[]>>(snapshot.verificationPlan?.bindings ?? {});
  const [busy, setBusy] = useState(false);
  const lock = useRef(false);
  const [error, setError] = useState("");
  const [reason, setReason] = useState<Record<string, string>>({});
  const runs = snapshot.runs.filter((run) => run.kind === "verification");
  const latest = runs.at(-1);
  const criteria = productCriteria(snapshot.draft);
  const mappingDirty = JSON.stringify(bindings) !== JSON.stringify(snapshot.verificationPlan?.bindings ?? {});
  const occupied = snapshot.stage !== "development_authorized" || snapshot.developmentCurrent === false || snapshot.runs.some((run) => ["running", "queued"].includes(run.executionStatus));
  const api = window.electronAPI.productWorkflow;
  const button = "rounded-[var(--radius-lg)] border border-border px-3 py-2 text-sm disabled:opacity-50";

  async function perform(action: (commandId: string) => Promise<{ snapshot: ProductWorkflowSnapshot }>) {
    if (lock.current) return;
    lock.current = true; setBusy(true); setError("");
    try { onChange((await action(crypto.randomUUID())).snapshot); }
    catch (cause) { setError(String(cause)); }
    finally { lock.current = false; setBusy(false); }
  }

  return <section className="rounded-[var(--radius-lg)] border border-border p-4 space-y-4">
    <h2 className="font-medium">开发产物与验收证据</h2>
    <p className="text-sm text-text-secondary">先运行项目测试，再选择覆盖各项条件的用例。确认关联后重跑，才能得到逐项结果。测试通过仍需检查用例是否真正覆盖业务要求。</p>
    <button className={`${button} bg-accent text-white`} disabled={busy || mappingDirty || occupied} onClick={() => void perform((id) => api.verify(snapshot.projectId, snapshot.revision, id))}>
      {busy ? "正在处理…" : "运行测试并收集证据"}
    </button>
    {error && <p role="alert" className="text-sm text-red-500">{error}</p>}
    {latest && <div className="space-y-2 text-sm">
      <p>{executionLabels[latest.executionStatus]} · {labels[latest.verificationStatus]}</p>
      {latest.report && <>
        <p className="text-text-secondary">{latest.report.cases.length} 项用例 · 退出码 {latest.report.exitCode ?? "未知"} · {new Date(latest.report.finishedAt).toLocaleString()}</p>
        {latest.report.problem && <p className="text-amber-600">{latest.report.problem}。请核对业务实现、测试方法和运行环境。</p>}
        <details><summary className="cursor-pointer text-accent">查看原始测试输出与所测版本</summary>
          <p className="break-all text-xs mt-2">源码与测试摘要：{latest.report.artifactDigest}<br />Node {latest.report.nodeVersion} · Vitest {latest.report.vitestVersion}</p>
          <pre className="max-h-64 overflow-auto whitespace-pre-wrap bg-surface-hover p-3 text-xs">{latest.report.stderr}{"\n"}{latest.report.stdout}{"\n"}{latest.report.rawReport}</pre>
        </details>
      </>}
    </div>}
    {criteria.map((criterion) => {
      const evidence = snapshot.evidence.find((e) => e.runId === latest?.id && e.criterionId === criterion.id);
      const selected = bindings[criterion.id] ?? [];
      const manual = snapshot.manualVerifications?.filter((entry) => entry.runId === latest?.id && entry.criterionId === criterion.id) ?? [];
      return <div key={criterion.id} className="rounded-[var(--radius-lg)] bg-surface-hover p-3 space-y-2">
        <h3 className="text-sm font-medium">{criterion.title} · {criterion.text}</h3>
        <p className="text-xs text-text-secondary">{latest?.verificationStatus === "stale" ? "结果已失效，请重跑" : evidence ? labels[evidence.outcome] : "尚无证据"} {evidence?.observation}</p>
        {!!latest?.report?.cases.length && <details>
          <summary className="text-sm cursor-pointer text-accent">关联验证用例（已选 {selected.length} 项）</summary>
          <div className="max-h-48 overflow-auto space-y-2 py-2">
            {latest.report.cases.map((test) => <label key={test.key} className="block text-xs break-words">
              <input type="checkbox" disabled={busy || occupied} checked={selected.includes(test.key)} onChange={(event) => setBindings((current) => ({
                ...current, [criterion.id]: event.target.checked ? [...selected, test.key] : selected.filter((key) => key !== test.key),
              }))} /> {test.name} · {test.status === "passed" ? "通过" : test.status === "failed" ? "失败" : "未执行"}
              <span className="block text-text-secondary pl-4">{test.file}</span>
            </label>)}
          </div>
        </details>}
        {latest?.report && <details>
          <summary className="text-xs cursor-pointer">人工核验或接受例外</summary>
          <textarea aria-label={`核验说明：${criterion.text}`} className="mt-2 w-full rounded border border-border bg-surface p-2 text-sm"
            placeholder="记录操作、实际观察；接受例外时说明原因" value={reason[criterion.id] ?? ""}
            onChange={(event) => setReason((current) => ({ ...current, [criterion.id]: event.target.value }))} />
          <div className="flex gap-2">
            {(["verified", "exception"] as const).map((decision) => <button key={decision} className={button}
              disabled={busy || occupied || !reason[criterion.id]?.trim() || latest.verificationStatus === "stale"}
              onClick={() => void perform((id) => api.manualVerification(snapshot.projectId, snapshot.revision, id, {
                runId: latest.id, criterionId: criterion.id, decision, reason: reason[criterion.id] ?? "",
              }))}>{decision === "verified" ? "记录人工核验通过" : "接受当前例外"}</button>)}
          </div>
          <p className="mt-2 text-xs text-text-secondary">人工决定单独保留，不修改自动检查结果。</p>
        </details>}
        {manual.map((entry) => <p key={entry.id} className="text-xs">{entry.decision === "verified" ? "人工核验" : "人工接受例外"}：{entry.reason}</p>)}
      </div>;
    })}
    {!!latest?.report?.cases.length && <button className={button} disabled={busy || occupied} onClick={() => void perform((id) => api.approveVerification(snapshot.projectId, snapshot.revision, id, bindings))}>确认当前用例关联</button>}
    {(snapshot.verificationPlan || mappingDirty) && <p className="text-xs text-text-secondary">{mappingDirty ? "关联有未确认的修改，请先确认。" : "关联已确认，请重新运行以取得当前结果。"}没有关联的条件保持未判定。</p>}
    {runs.length > 1 && <details><summary className="text-sm cursor-pointer">历史运行（{runs.length} 次）</summary>
      {runs.slice().reverse().map((run) => <details key={run.id} className="my-2 text-xs">
        <summary className="cursor-pointer">{new Date(run.createdAt).toLocaleString()} · {executionLabels[run.executionStatus]} · {labels[run.verificationStatus]}</summary>
        <pre className="max-h-52 overflow-auto whitespace-pre-wrap">{JSON.stringify({ run, evidence: snapshot.evidence.filter((e) => e.runId === run.id), manual: snapshot.manualVerifications?.filter((e) => e.runId === run.id) }, null, 2)}</pre>
      </details>)}
    </details>}
  </section>;
}
