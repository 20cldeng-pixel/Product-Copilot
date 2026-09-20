import { afterEach, describe, expect, it, vi } from "vitest";
import { createProductWorkflowTools } from "./product-workflow-tool";
import { ProductChangeService } from "../product-change-service";

vi.mock("../pi-sdk", () => ({ getDefineToolFn: async () => (definition: unknown) => definition }));
afterEach(() => vi.restoreAllMocks());

describe("product proposal tools", () => {
  it("registers a complete proposal schema without any approval or build tool", async () => {
    const tools = await createProductWorkflowTools("00000000-0000-4000-8000-000000000001", "/tmp/project");
    expect(tools.map((tool) => tool.name)).toEqual(["get_product_plan", "save_product_draft", "propose_product_change"]);
    const schema = JSON.stringify(tools.at(-1)?.parameters);
    expect(schema).toContain('"nextDraft"'); expect(schema).toContain('"preserve"'); expect(schema).toContain('"impact"');
    expect(schema).not.toContain('"confirmation"');
  });

  it("routes model requests only to proposal saving and uses stable command identifiers", async () => {
    const save = vi.spyOn(ProductChangeService.prototype, "save").mockImplementation(() => { throw new Error("schema rejection"); });
    const confirm = vi.spyOn(ProductChangeService.prototype, "confirm");
    const tools = await createProductWorkflowTools("00000000-0000-4000-8000-000000000001", "/tmp/project");
    const proposal = tools.at(-1) as unknown as { execute: (id: string, input: Record<string, unknown>) => Promise<{ content: Array<{ text: string }> }> };
    const first = await proposal.execute("call-1", { expectedRevision: 7, input: {} });
    await proposal.execute("call-1", { expectedRevision: 7, input: {} });
    expect(first.content[0].text).toContain("schema rejection");
    expect(save.mock.calls[0]?.[2]).toBe(save.mock.calls[1]?.[2]);
    expect(confirm).not.toHaveBeenCalled();
  });
});
