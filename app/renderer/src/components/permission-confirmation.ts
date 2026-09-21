import { confirmDialog } from "./ui/ConfirmDialog";

/** 所有进入完全访问的 UI 入口共用同一份一次性风险确认。 */
export function confirmFullAccess(): Promise<boolean> {
  return confirmDialog({
    title: "切换到完全访问？",
    message: "Mint 将可以读写当前工作区之外的普通文件，并可能创建、覆盖或删除这些文件。运行的命令、依赖安装脚本和子进程也将获得相同权限。\n\n系统核心、敏感凭据和 Product Copilot 安全配置仍然禁止访问。",
    confirmText: "确认完全访问",
    // 实心权限色（与输入卡权限盾形图标一致），不是删除类的危险色线框
    permissionConfirm: true,
  });
}
