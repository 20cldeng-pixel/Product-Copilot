import { z } from "zod";
import type { ProductWorkflowSnapshot } from "./product-workflow";
import { productCriteria } from "./product-verification";

const eventSchema = z.object({
  id: z.string().min(1), sessionId: z.string().min(1), mockUserId: z.string().min(1),
  activityId: z.string().min(1), artifactVersion: z.string().min(1),
  at: z.iso.datetime(), source: z.enum(["synthetic", "local_trial"]),
  kind: z.enum(["view", "submit", "result"]),
  outcome: z.enum(["success", "rejected"]).optional(), reason: z.string().max(80).optional(),
}).strict().superRefine((event, context) => {
  if (event.kind === "result" && !event.outcome) context.addIssue({ code: "custom", message: "结果事件必须有结果" });
  if (event.kind !== "result" && event.outcome) context.addIssue({ code: "custom", message: "只有结果事件可填写结果" });
});
export const reviewExportSchema = z.object({ format: z.literal("gather-events-v1"), events: z.array(eventSchema).max(10000) }).strict();
export type ReviewEvent = z.infer<typeof eventSchema>;

export interface ReviewFilter { artifactVersion?: string; activityId?: string; source?: ReviewEvent["source"]; from?: string; to?: string }
export interface BusinessReview {
  events: number; duplicateIds: number; viewedUsers: number; submittedUsers: number; successfulUsers: number;
  rejectedByReason: Record<string, number>; funnelUnits: number; submittedUnits: number; successfulUnits: number;
  submitRate: number | null; successRate: number | null; retries: number; nonFunnelEvents: number;
  sources: ReviewEvent["source"][]; artifactVersions: string[];
}

export function calculateBusinessReview(input: ReviewEvent[], filter: ReviewFilter = {}): BusinessReview {
  const seen = new Set<string>();
  let duplicateIds = 0;
  const events = input.filter((event) => {
    if ((filter.artifactVersion && event.artifactVersion !== filter.artifactVersion)
      || (filter.activityId && event.activityId !== filter.activityId)
      || (filter.source && event.source !== filter.source)
      || (filter.from && event.at < filter.from)
      || (filter.to && event.at > filter.to)) return false;
    if (seen.has(event.id)) { duplicateIds++; return false; }
    seen.add(event.id);
    return true;
  }).sort((a, b) => a.at.localeCompare(b.at));
  const users = { view: new Set<string>(), submit: new Set<string>(), success: new Set<string>() };
  const units = new Map<string, { viewed: boolean; submitted: boolean; succeeded: boolean; submits: number }>();
  const rejected = new Map<string, number>();
  let nonFunnelEvents = 0;
  for (const event of events) {
    const unitId = JSON.stringify([event.sessionId, event.mockUserId, event.activityId]);
    const unit = units.get(unitId) ?? { viewed: false, submitted: false, succeeded: false, submits: 0 };
    units.set(unitId, unit);
    if (event.kind === "view") { users.view.add(event.mockUserId); unit.viewed = true; }
    if (event.kind === "submit") {
      users.submit.add(event.mockUserId);
      unit.submits++;
      if (unit.viewed) unit.submitted = true; else nonFunnelEvents++;
    }
    if (event.kind === "result") {
      if (event.outcome === "success") {
        users.success.add(event.mockUserId);
        if (unit.viewed && unit.submitted) unit.succeeded = true; else nonFunnelEvents++;
      } else {
        const reason = event.reason || "unknown";
        rejected.set(reason, (rejected.get(reason) ?? 0) + 1);
      }
    }
  }
  const funnelUnits = [...units.values()].filter((unit) => unit.viewed).length;
  const submittedUnits = [...units.values()].filter((unit) => unit.viewed && unit.submitted).length;
  const successfulUnits = [...units.values()].filter((unit) => unit.viewed && unit.submitted && unit.succeeded).length;
  return {
    events: events.length, duplicateIds, viewedUsers: users.view.size, submittedUsers: users.submit.size,
    successfulUsers: users.success.size, rejectedByReason: Object.fromEntries(rejected), funnelUnits, submittedUnits, successfulUnits,
    submitRate: funnelUnits ? submittedUnits / funnelUnits : null,
    successRate: submittedUnits ? successfulUnits / submittedUnits : null,
    retries: [...units.values()].reduce((sum, unit) => sum + Math.max(0, unit.submits - 1), 0), nonFunnelEvents,
    sources: [...new Set(events.map((event) => event.source))].sort(),
    artifactVersions: [...new Set(events.map((event) => event.artifactVersion))].sort(),
  };
}

export function calculateDeliveryReview(snapshot: ProductWorkflowSnapshot) {
  const criteria = productCriteria(snapshot.draft);
  const current = [...snapshot.runs].reverse().find((run) => run.kind === "verification" && run.verificationStatus !== "stale");
  const evidence = snapshot.evidence.filter((entry) => entry.runId === current?.id);
  const counts = { pass: 0, fail: 0, inconclusive: 0 };
  for (const criterion of criteria) {
    const outcome = evidence.find((entry) => entry.criterionId === criterion.id)?.outcome ?? "inconclusive";
    counts[outcome]++;
  }
  const builds = snapshot.runs.filter((run) => run.kind === "build");
  const verifications = snapshot.runs.filter((run) => run.kind === "verification");
  const toolCalls = builds.reduce((sum, run) => sum + (run.build?.result?.toolCalls ?? 0), 0);
  const toolErrors = builds.reduce((sum, run) => sum + (run.build?.result?.toolErrors ?? 0), 0);
  const buildDurationMs = builds.reduce((sum, run) => sum + (run.build?.finishedAt
    ? Date.parse(run.build.finishedAt) - Date.parse(run.build.startedAt) : 0), 0);
  return { criteria: criteria.length, ...counts, buildRuns: builds.length, verificationRuns: verifications.length,
    toolCalls, toolErrors, buildDurationMs, manualDecisions: snapshot.manualVerifications?.length ?? 0,
    currentApprovals: Number(Boolean(snapshot.approvals.scope)) + Number(Boolean(snapshot.approvals.development)),
    changeApprovals: snapshot.proposals.filter((proposal) => Boolean(proposal.confirmation)).length,
    missing: ["澄清、确认、纠错耗时未采集", "主/子 Agent Token 与费用未采集", "独立评分器结果另列，不能由本页推断"],
    currentArtifact: current?.report?.artifactDigest ?? null };
}

/** 只把可复算的汇总数交给模型；导入文件中的自由文本不进入提示词。 */
export function buildReviewExplanationPrompt(delivery: ReturnType<typeof calculateDeliveryReview>, business: BusinessReview, filter: ReviewFilter): string {
  const knownReasons = ["EVENT_FULL", "EVENT_CLOSED", "ALREADY_REGISTERED", "WRITE_FAILED"];
  const reasonCounts = Object.fromEntries(knownReasons.map((reason) => [reason, business.rejectedByReason[reason] ?? 0]));
  const otherReasons = Object.entries(business.rejectedByReason).reduce((sum, [reason, count]) => sum + (knownReasons.includes(reason) ? 0 : count), 0);
  const summary = {
    delivery: { criteria: delivery.criteria, pass: delivery.pass, fail: delivery.fail, inconclusive: delivery.inconclusive,
      buildRuns: delivery.buildRuns, verificationRuns: delivery.verificationRuns, toolCalls: delivery.toolCalls,
      toolErrors: delivery.toolErrors, currentApprovals: delivery.currentApprovals,
      changeApprovals: delivery.changeApprovals, manualDecisions: delivery.manualDecisions },
    business: { sources: business.sources, eventCount: business.events, duplicateIds: business.duplicateIds,
      viewedMockUsers: business.viewedUsers, submittedMockUsers: business.submittedUsers,
      successfulMockUsers: business.successfulUsers, viewedSessionUnits: business.funnelUnits,
      submittedSessionUnits: business.submittedUnits, successfulSessionUnits: business.successfulUnits,
      submitRate: business.submitRate, successRate: business.successRate, retries: business.retries,
      nonFunnelEvents: business.nonFunnelEvents, rejectionCounts: reasonCounts, otherReasons },
    filters: { versionSelected: Boolean(filter.artifactVersion), activitySelected: Boolean(filter.activityId),
      sourceSelected: filter.source ?? null, timeWindowSelected: Boolean(filter.from || filter.to) },
  };
  return `你是产品复盘助手。只依据下面的聚合统计，用中文给出三段简短内容：已观察到的事实、证据边界、下一次低成本验证计划。不要调用工具、读取文件、修改需求或代码。不要把模拟身份、本机试用或合成数据称为真实用户增长；不要推断因果。零分母和缺失字段不估算；自动关联检查通过不等于独立评测成功。总计不超过 260 字。\n聚合统计：${JSON.stringify(summary)}`;
}
