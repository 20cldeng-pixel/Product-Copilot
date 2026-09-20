import type { ProductDraft } from "./product-workflow";

export interface ProductChangeInput {
  proposalId?: string;
  target: string;
  preserve: string[];
  nextDraft: ProductDraft;
  impact: Array<{ area: string; reason: string; files: string[] }>;
}

/** 只做字段级前后对照；不推断语义影响，也不把描述差异当作代码改动。 */
export function productDraftDiff(before: ProductDraft, after: ProductDraft): Array<{ label: string; before: string; after: string }> {
  const changes: Array<{ label: string; before: string; after: string }> = [];
  const add = (label: string, old: unknown, next: unknown) => {
    if (JSON.stringify(old) !== JSON.stringify(next)) changes.push({ label, before: typeof old === "string" ? old : JSON.stringify(old, null, 2), after: typeof next === "string" ? next : JSON.stringify(next, null, 2) });
  };
  add("产品想法", before.brief.idea, after.brief.idea);
  add("目标用户", before.brief.targetUser, after.brief.targetUser);
  add("使用场景", before.brief.scenario, after.brief.scenario);
  add("产品约束", before.brief.constraints, after.brief.constraints);
  add("调研状态", before.researchStatus, after.researchStatus);
  add("调研来源", before.research, after.research);
  for (const id of new Set([...before.requirements, ...after.requirements].map((r) => r.id))) {
    const old = before.requirements.find((r) => r.id === id);
    const next = after.requirements.find((r) => r.id === id);
    add(`需求 ${id}：${next?.title ?? old?.title ?? id}`, old ?? "无", next ?? "移除");
  }
  add("问题与已采纳答案", before.questions, after.questions);
  return changes;
}
