import { describe, expect, it } from "vitest";
import { filterBenignViolations } from "./manager";

/** 2026-09-17 权限模式自测暴露：成功命令的返回里也挂着 violations 块，全是被连带记录的系统探测拒绝。 */
function block(lines: string[]): string {
  return `stderr 正文\n<sandbox_violations>\n${lines.join("\n")}\n</sandbox_violations>\n`;
}

describe("沙盒违规注解的噪声过滤", () => {
  it("只含系统探测类（sysctl/system-info/mach-lookup）→ 整块移除", () => {
    const stderr = block([
      "bash(1459) deny(1) sysctl-read kern.iossupportversion",
      "curl(1493) deny(1) system-info vfs.disk-space",
      "open(1563) deny(1) mach-lookup com.apple.lsd.open",
    ]);
    expect(filterBenignViolations(stderr)).toBe("stderr 正文\n");
  });

  it("语义明确的拦截一律保留，只摘掉噪声行", () => {
    const stderr = block([
      "bash(1488) deny(1) sysctl-read kern.iossupportversion",
      "deny network-outbound example.com:443 (host is not on the allow list)",
      "ssh(1535) deny(1) file-read-data /Users/x/.ssh/id_ed25519",
    ]);
    const out = filterBenignViolations(stderr);
    expect(out).toContain("network-outbound");
    expect(out).toContain("file-read-data");
    expect(out).not.toContain("sysctl-read");
    expect(out).toContain("<sandbox_violations>");
  });

  it("无 violations 块时原样返回（正文里出现同类词也不动）", () => {
    const plain = "grep: mach-lookup: No such file or directory\nsysctl-read 只是正文\n";
    expect(filterBenignViolations(plain)).toBe(plain);
  });
});
