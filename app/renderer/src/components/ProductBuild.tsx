import { useEffect, useRef, useState } from "react";
import type { ProductRun, ProductWorkflowSnapshot } from "@shared/product-workflow";

const labels: Record<ProductRun["executionStatus"], string> = {
  queued: "等待执行", running: "正在开发", completed: "开发回合结束，待验收", failed: "开发执行失败",
  interrupted: "执行中断，产物已保留", cancelled: "已停止，产物已保留",
};

export function ProductBuild({ snapshot, onChange }: {
  snapshot: ProductWorkflowSnapshot; onChange: (state: ProductWorkflowSnapshot) => void;
}): JSX.Element {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const lock = useRef(false);
  const builds = snapshot.runs.filter((run) => run.kind === "build");
  const latest = builds.at(-1);
  const running = latest?.executionStatus === "running" || latest?.executionStatus === "queued";
  const occupied = snapshot.runs.some((run) => ["running", "queued"].includes(run.executionStatus));
  const current = (run: ProductRun) => run.scopeDigest === snapshot.approvals.scope?.contentDigest
    && run.prototypeDigest === snapshot.prototype?.contentDigest;
  const latestVerification = [...snapshot.runs].reverse().find((run) => run.kind === "verification" && current(run)
    && ["completed", "failed"].includes(run.executionStatus) && run.verificationStatus !== "stale");
  const failedCriteria = latestVerification?.criteria?.filter((criterion) => snapshot.evidence.some((entry) =>
    entry.runId === latestVerification.id && entry.criterionId === criterion.id && entry.outcome === "fail")) ?? [];
  const repairIntegrationComplete = !!latestVerification && builds.some((run) => current(run) && run.executionStatus === "completed"
    && run.build?.batch?.kind === "integration" && run.build.batch.sourceVerificationRunId === latestVerification.id);
  const repairPending = failedCriteria.length > 0 && !repairIntegrationComplete;
  const initialIntegrationComplete = builds.some((run) => run.executionStatus === "completed"
    && run.scopeDigest === snapshot.approvals.scope?.contentDigest
    && run.prototypeDigest === snapshot.prototype?.contentDigest
    && run.build?.batch?.kind === "integration" && !run.build.batch.sourceVerificationRunId);
  const developmentComplete = initialIntegrationComplete && !repairPending;
  const api = window.electronAPI.productWorkflow;
  const batchLabel = latest?.build?.batch?.kind === "requirements"
    ? `需求批次 ${latest.build.batch.index}/${latest.build.batch.total} · ${latest.build.batch.requirementIds.join("、")}`
    : latest?.build?.batch?.kind === "repair"
      ? `验收修复 ${latest.build.batch.index}/${latest.build.batch.total} · ${latest.build.batch.requirementIds.join("、")}`
    : latest?.build?.batch?.kind === "integration"
      ? `${latest.build.batch.sourceVerificationRunId ? "修复后集成" : "集成补缺"} · ${latest.build.batch.requirementIds.join("、")}` : undefined;

  useEffect(() => {
    if (!running) return;
    let active = true;
    let timer: ReturnType<typeof setTimeout>;
    const poll = async () => {
      try {
        const state = await window.electronAPI.productWorkflow.get(snapshot.projectId);
        if (active) onChange(state);
      } catch (cause) { if (active) setError(String(cause)); }
      if (active) timer = setTimeout(() => void poll(), 1500);
    };
    timer = setTimeout(() => void poll(), 1500);
    return () => { active = false; clearTimeout(timer); };
  }, [running, snapshot.projectId, onChange]);

  async function perform(stop: boolean) {
    if (lock.current) return;
    lock.current = true; setBusy(true); setError("");
    try {
      const current = await api.get(snapshot.projectId);
      await (stop && latest
        ? api.stopBuild(snapshot.projectId, current.revision, crypto.randomUUID(), latest.id)
        : api.startBuild(snapshot.projectId, current.revision, crypto.randomUUID()));
      onChange(await api.get(snapshot.projectId));
    } catch (cause) { setError(String(cause)); }
    finally { lock.current = false; setBusy(false); }
  }

  return <section className="rounded-[var(--radius-lg)] border border-border p-4 space-y-3">
    <h2 className="font-medium">按已确认范围开发</h2>
    <p className="text-sm text-text-secondary">Builder 每轮最多处理 2 项首版需求；失败或中断会重试同一批次。全部批次完成后进入集成补缺；独立验收失败时只重开相关需求，再做一次集成。运行满 10 分钟或调用 80 次工具后请求停止；开发回合结束仍需独立验收。</p>
    <div className="flex gap-2">
      <button className="rounded-[var(--radius-lg)] bg-accent px-4 py-2 text-sm text-white disabled:opacity-50" disabled={busy || occupied || developmentComplete || snapshot.stage !== "development_authorized" || snapshot.developmentCurrent === false}
        onClick={() => void perform(false)}>{developmentComplete ? "开发已完成" : repairPending ? "修复验收失败项" : latest ? "继续开发未完成项" : "开始开发"}</button>
      {running && <button className="rounded-[var(--radius-lg)] border border-border px-4 py-2 text-sm disabled:opacity-50"
        disabled={busy || latest?.build?.stopRequested} onClick={() => void perform(true)}>{latest?.build?.stopRequested ? "正在停止…" : "停止本轮开发"}</button>}
    </div>
    {snapshot.stage === "development_authorized" && snapshot.developmentCurrent === false && <p role="status" className="text-sm text-amber-600">开发批准已失效，请重新登记原型并确认开发范围。</p>}
    {developmentComplete && <p role="status" className="text-sm text-emerald-600">{repairIntegrationComplete ? "修复与集成已完成，请重新运行独立验收。" : "需求批次与集成补缺已完成，请运行独立验收。"}</p>}
    {repairPending && <p role="status" className="text-sm text-amber-600">独立验收发现 {failedCriteria.length} 条失败条件，Builder 将只修复相关需求。</p>}
    {error && <p role="alert" className="text-sm text-red-500">{error}</p>}
    {latest && <div className="space-y-2 text-sm">
      {batchLabel && <p className="text-xs text-text-secondary">{batchLabel}</p>}
      <p role="status">{latest.build?.stopRequested && running ? "已请求停止，等待执行器退出" : labels[latest.executionStatus]}</p>
      {latest.build?.result && <>
        <p className="text-xs text-text-secondary">工具调用 {latest.build.result.toolCalls} 次，工具错误 {latest.build.result.toolErrors} 次 · {latest.build.result.model ?? "模型未启动"}</p>
        {latest.build.result.error && <p className="text-amber-600">{latest.build.result.error}</p>}
        <pre className="max-h-60 overflow-auto whitespace-pre-wrap rounded bg-surface-hover p-3 text-xs">{latest.build.result.summary || "本轮没有最终说明"}</pre>
        <p className="text-xs text-text-secondary">以上是模型的开发说明；业务结果以逐项验收为准。</p>
      </>}
    </div>}
    {builds.length > 0 && <details><summary className="cursor-pointer text-sm">运行记录（{builds.length} 次）</summary>
      {builds.slice().reverse().map((run) => <details className="mt-2 text-xs" key={run.id}>
        <summary className="cursor-pointer">{new Date(run.createdAt).toLocaleString()} · {labels[run.executionStatus]}</summary>
        <pre className="max-h-52 overflow-auto whitespace-pre-wrap">{JSON.stringify(run, null, 2)}</pre>
      </details>)}
    </details>}
  </section>;
}
