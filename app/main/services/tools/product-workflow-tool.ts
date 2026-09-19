import { createHash } from "node:crypto";
import type { ToolDefinition } from "../pi-sdk";
import { getDefineToolFn } from "../pi-sdk";
import { ProductWorkflowService } from "../product-workflow-service";
import type { ProductDraft } from "../../../shared/product-workflow";

function message(text: string) { return { content: [{ type: "text" as const, text }] }; }

function commandIdFor(projectId: string, toolCallId: string): string {
  const hash = createHash("sha256").update(`${projectId}:save_product_draft:${toolCallId}`).digest("hex");
  return `${hash.slice(0, 8)}-${hash.slice(8, 12)}-5${hash.slice(13, 16)}-8${hash.slice(17, 20)}-${hash.slice(20, 32)}`;
}

/** Mint 可读取和更新未确认的草案；此工具族没有任何批准或启动开发入口。 */
export async function createProductWorkflowTools(
  projectId: string,
  projectPath: string,
): Promise<ToolDefinition[]> {
  const defineTool = await getDefineToolFn();
  const service = new ProductWorkflowService((id) => id === projectId ? projectPath : undefined);
  const tools: ToolDefinition[] = [];

  tools.push(defineTool({
    name: "get_product_plan", label: "读取产品计划",
    description: "读取当前项目的产品需求草案、调研、优先级和批准状态。用户要从 Idea 创建产品或修改需求时先读它，不要凭聊天历史猜现状。",
    promptSnippet: "读取当前产品计划及其版本",
    parameters: { type: "object" as const, properties: {} },
    async execute() {
      try {
        const state = service.get(projectId);
        const view = {
          active: service.isActive(projectId), revision: state.revision, stage: state.stage, draft: state.draft,
          scopeApproved: Boolean(state.approvals.scope), prototype: state.prototype,
          developmentApproved: Boolean(state.approvals.development),
        };
        const serialized = JSON.stringify(view);
        if (serialized.length > 14000) return message("产品计划超过单次上下文上限，请到产品计划界面查看或收窄需求范围。");
        return message(serialized);
      } catch (error) { return message(`读取产品计划失败：${(error as Error).message}`); }
    },
  } as any) as ToolDefinition);

  tools.push(defineTool({
    name: "save_product_draft", label: "保存产品草案",
    executionMode: "sequential",
    description:
      "保存当前项目尚未确认的产品草案：Idea/目标用户/场景、带事实与推断区分的来源、需求优先级和验收条件。"
      + "先 get_product_plan 取得 revision；本工具只能更新 draft，不能确认范围、原型或开发。"
      + "竞品事实须来自可指出的来源；资料不足时用 pending 并解释缺口，不伪造 URL 或观察结论。",
    promptSnippet: "保存未确认的需求和调研草案（需要当前 revision）",
    parameters: {
      type: "object" as const,
      properties: {
        expectedRevision: { type: "number" as const, description: "get_product_plan 返回的 revision" },
        draft: {
          type: "object" as const,
          properties: {
            brief: {
              type: "object" as const,
              properties: {
                idea: { type: "string" as const }, targetUser: { type: "string" as const },
                scenario: { type: "string" as const }, constraints: { type: "array" as const, items: { type: "string" as const } },
              },
              required: ["idea", "targetUser", "scenario", "constraints"],
            },
            research: {
              type: "array" as const,
              items: {
                type: "object" as const,
                properties: {
                  id: { type: "string" as const }, subject: { type: "string" as const },
                  sourceUrl: { type: "string" as const }, materialRef: { type: "string" as const }, observedAt: { type: "string" as const },
                  fact: { type: "string" as const }, inference: { type: "string" as const },
                }, required: ["id", "subject", "fact", "inference"],
              },
            },
            researchStatus: { type: "string" as const, enum: ["pending", "complete", "insufficient_accepted"] },
            requirements: {
              type: "array" as const,
              items: {
                type: "object" as const,
                properties: {
                  id: { type: "string" as const }, title: { type: "string" as const },
                  priority: { type: "string" as const, enum: ["P0", "P1", "P2"] },
                  behavior: { type: "string" as const },
                  acceptance: { type: "array" as const, items: { type: "string" as const } },
                }, required: ["id", "title", "priority", "behavior", "acceptance"],
              },
            },
            questions: {
              type: "array" as const,
              items: {
                type: "object" as const,
                properties: {
                  id: { type: "string" as const }, text: { type: "string" as const },
                  blocking: { type: "boolean" as const }, resolution: { type: "string" as const },
                }, required: ["id", "text", "blocking"],
              },
            },
          }, required: ["brief", "research", "researchStatus", "requirements", "questions"],
        },
      }, required: ["expectedRevision", "draft"],
    },
    async execute(toolCallId: string, params: Record<string, unknown>) {
      try {
        if (!service.isActive(projectId)) {
          return message("产品流程尚未启用。请用户先在「产品计划」页点击「启用产品流程」，再保存草案。");
        }
        const result = service.saveDraft(
          projectId, params.expectedRevision as number,
          commandIdFor(projectId, toolCallId), params.draft as ProductDraft,
        );
        return message(`草案已保存，当前版本 ${result.snapshot.revision}。用户可在「产品计划」页检查后自行确认范围；模型不能代替确认。`);
      } catch (error) { return message(`保存草案失败：${(error as Error).message}`); }
    },
  } as any) as ToolDefinition);

  return tools;
}
