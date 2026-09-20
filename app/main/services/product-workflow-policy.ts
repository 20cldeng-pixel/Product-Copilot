import fs from "node:fs";
import path from "node:path";
import type { ProductStage } from "../../shared/product-workflow";

const PLANNING_TOOLS = new Set([
  "get_product_plan", "save_product_draft", "propose_product_change", "read", "ls", "grep", "find", "glob",
  "web_search", "web_fetch", "ask_user", "use_skill", "describe_image", "todo_write",
]);

/** 产品计划启动后，已批准开发前的文件写入只允许当前项目的原型目录。 */
export function productToolDenial(
  stage: ProductStage,
  projectPath: string,
  toolName: string,
  input: Record<string, unknown>,
): string | null {
  if (stage === "development_authorized") return null;
  const name = toolName.toLowerCase();
  if (PLANNING_TOOLS.has(name)) return null;
  if (name === "show_prototype" && stage !== "draft") return null;

  if ((name === "write" || name === "edit") && stage !== "draft") {
    const requested = input.file_path ?? input.path;
    if (typeof requested === "string" && requested.length > 0) {
      try {
        const projectRoot = fs.realpathSync(projectPath);
        const root = fs.realpathSync(path.join(projectPath, "prototype"));
        if (!root.startsWith(projectRoot + path.sep)) return "原型目录已移出当前项目";
        const target = path.resolve(projectPath, requested);
        const parent = fs.realpathSync(path.dirname(target));
        if (parent === root || parent.startsWith(root + path.sep)) {
          if (fs.existsSync(target)) {
            const actual = fs.realpathSync(target);
            if (!actual.startsWith(root + path.sep)) return "原型文件已移出原型目录";
          }
          return null;
        }
      } catch { /* 目录尚不存在或 symlink 无效，保持拒绝 */ }
    }
  }

  return stage === "draft"
    ? "产品范围尚未确认；当前只能分析、调研和保存草案。请让用户在「产品计划」确认范围。"
    : "开发尚未获得确认；当前只允许修改项目 prototype/ 内的原型文件。请在「产品计划」预览并确认。";
}
