import type { ProductWorkflowSnapshot } from "./product-workflow";

/** 从权威状态派生可复制的 PRD；修改原始草案后重新生成，避免维护两份需求。 */
export function renderProductPrd(state: ProductWorkflowSnapshot): string {
  const { draft } = state;
  const lines = [
    `# ${draft.brief.idea.trim() || "未命名产品"}：产品需求文档`,
    "",
    `状态：${state.approvals.scope ? "首版范围已确认" : "草案，尚未确认"}；项目版本：${state.revision}`,
    "",
    "## 目标与场景", "",
    `- 目标用户：${draft.brief.targetUser.trim() || "待明确"}`,
    `- 使用场景：${draft.brief.scenario.trim() || "待明确"}`,
    `- 产品想法：${draft.brief.idea.trim() || "待明确"}`,
    ...draft.brief.constraints.map((constraint) => `- 约束：${constraint}`),
    "", "## 竞品与依据", "",
    `调研状态：${draft.researchStatus === "complete" ? "已记录来源" : draft.researchStatus === "insufficient_accepted" ? "资料不足，按假设继续" : "待完成"}`,
    "",
  ];
  if (draft.research.length === 0) lines.push("暂无来源记录。", "");
  for (const source of draft.research) {
    lines.push(`### ${source.subject}`, "", `- 来源：${source.sourceUrl || source.materialRef || "未填写来源"}`);
    lines.push(`- 观察事实：${source.fact}`, `- 推断或建议：${source.inference || "无"}`);
    lines.push(`- 读取时间：${source.observedAt || "未记录；来源尚需核查"}`, "");
  }
  lines.push("## 范围与优先级", "");
  for (const priority of ["P0", "P1", "P2"] as const) {
    const requirements = draft.requirements.filter((item) => item.priority === priority);
    lines.push(`### ${priority}`, "");
    if (requirements.length === 0) lines.push("暂无。", "");
    for (const item of requirements) {
      lines.push(`#### ${item.id} ${item.title}`, "", item.behavior, "", "验收条件：", "");
      lines.push(...(item.acceptance.length ? item.acceptance.map((criterion) => `- ${criterion}`) : ["- 待补充"]), "");
    }
  }
  lines.push("## 待回答问题与假设", "");
  if (draft.questions.length === 0) lines.push("暂无。", "");
  for (const question of draft.questions) {
    lines.push(`- ${question.blocking ? "关键" : "非关键"}：${question.text}；回答：${question.resolution || "待回答"}`);
  }
  lines.push("", "---", "此文档由产品计划生成；界面中的已确认版本与原始证据为当前状态依据。", "");
  return lines.join("\n");
}
