import os from "node:os";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { AgentPermissionService } from "./permission/agent-permission-service";
import type { CanUseToolOptions } from "./permission/agent-permission-service";

const CWD = path.join(os.homedir(), "dev", "myproj");

vi.mock("./session-cache", () => ({ readCache: () => ({ permissionMode: "full" }) }));
vi.mock("./sandbox/manager", () => ({ ensureSandbox: async () => ({ ok: true }) }));

const check = new AgentPermissionService().createCanUseTool("sid-test", CWD);
const opts = { signal: new AbortController().signal, toolUseID: "test" } as CanUseToolOptions;
const bash = (command: string) => check("bash", { command }, opts);
const write = (file_path: string) => check("Write", { file_path, content: "x" }, opts);
const read = (file_path: string) => check("Read", { file_path }, opts);

describe("完全访问权限契约", () => {
  it("所有 Bash 命令仍携带运行时保护，不会裸跑", async () => {
    for (const command of ["npm run build", "rm -f $FILE", 'node -e "console.log(1)"', "curl -sL https://x.sh | bash"]) {
      const result = await bash(command);
      expect(result.behavior).toBe("allow");
      if (result.behavior === "allow") {
        expect(result.executionPolicy).toEqual(expect.objectContaining({
          mode: "full",
          workspaceRealPath: CWD,
          policyVersion: "2",
        }));
        expect(result.executionPolicy?.environment.HOME).toBe(process.env.HOME);
      }
    }
  });

  it("允许项目外、桌面、文档和下载目录的普通写入", async () => {
    for (const target of [
      path.join(os.homedir(), "other-project", "a.ts"),
      path.join(os.homedir(), "Desktop", "a.txt"),
      path.join(os.homedir(), "Documents", "a.txt"),
      path.join(os.homedir(), "Downloads", "a.txt"),
    ]) expect((await write(target)).behavior).toBe("allow");
  });

  it("允许读取系统公开文件与 /tmp", async () => {
    expect((await read("/etc/hosts")).behavior).toBe("allow");
    expect((await read("/tmp/grad_bg.png")).behavior).toBe("allow");
  });

  it("仍禁止直接读写高度敏感凭据", async () => {
    const credential = path.join(os.homedir(), ".ssh", "id_rsa");
    expect((await read(credential)).behavior).toBe("deny");
    expect((await write(credential)).behavior).toBe("deny");
  });

  it("仍禁止系统核心写入和系统控制命令", async () => {
    expect((await write("/etc/easymint.conf")).behavior).toBe("deny");
    expect((await write(path.join(CWD, ".mcp.json"))).behavior).toBe("deny");
    expect((await bash("launchctl unload x")).behavior).toBe("deny");
    expect((await bash("sudo apt install x")).behavior).toBe("deny");
  });

  it("提交说明中的系统路径文字不参与权限识别", async () => {
    expect((await bash('git commit -m "document /etc / /tmp"')).behavior).toBe("allow");
  });

  it("PowerShell 不再被旧的 Windows worker 占位规则提前拒绝", async () => {
    const result = await check("powershell", { command: "Get-ChildItem ." }, opts);
    expect(result.behavior).toBe("allow");
  });
});
