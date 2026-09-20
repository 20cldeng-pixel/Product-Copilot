import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { lstatSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { z } from "zod";
import type { TestCaseResult, VerificationReport } from "../../shared/product-verification";

const excluded = new Set([".git", "node_modules", ".easymint", "dist", "coverage", "temp", ".vite", ".DS_Store", ".eslintcache"]);
/** 包括未提交代码与测试；不跟随链接，避免把项目外文件静默纳入证据。 */
export function productArtifactDigest(root: string): string {
  const hash = createHash("sha256");
  let bytes = 0;
  let count = 0;
  function visit(dir: string) {
    for (const name of readdirSync(dir).sort()) {
      if (excluded.has(name)) continue;
      const file = path.join(dir, name);
      const stat = lstatSync(file);
      if (stat.isSymbolicLink()) throw new Error("验收源码包含符号链接，请先改用项目内文件");
      if (stat.isDirectory()) { visit(file); continue; }
      if (!stat.isFile()) throw new Error("验收源码包含不支持的文件类型");
      bytes += stat.size;
      if (++count > 20000 || bytes > 100 * 1024 * 1024) throw new Error("项目超出首版验收快照大小限制");
      const content = readFileSync(file);
      hash.update(JSON.stringify([path.relative(root, file), content.length]));
      hash.update(content);
    }
  }
  visit(root);
  return hash.digest("hex");
}

// Vitest 4/5 JSON reporter 公共格式；只解析所需字段，不以总计或 success 单独判通过。
const jsonReportSchema = z.object({
  success: z.boolean(), numTotalTests: z.number().int().nonnegative(),
  testResults: z.array(z.object({
    name: z.string().min(1), status: z.string(),
    assertionResults: z.array(z.object({
      fullName: z.string().min(1), status: z.string(), failureMessages: z.array(z.string()).nullable(),
    })),
  })),
});

export function parseVitestReport(stdout: string, root: string): { cases: TestCaseResult[]; problem?: string } {
  const result = jsonReportSchema.parse(JSON.parse(stdout) as unknown);
  const cases = result.testResults.flatMap((suite) => {
    const file = path.relative(root, suite.name).split(path.sep).join("/");
    if (file.startsWith("../") || path.isAbsolute(file)) throw new Error("测试报告引用了项目外文件");
    return suite.assertionResults.map((test): TestCaseResult => ({
      key: JSON.stringify([file, test.fullName]), file, name: test.fullName,
      status: test.status === "passed" || test.status === "failed" ? test.status : "pending",
      messages: test.failureMessages ?? [],
    }));
  });
  if (new Set(cases.map((test) => test.key)).size !== cases.length) throw new Error("测试名称不唯一，无法精确关联");
  if (!cases.length || cases.length !== result.numTotalTests) return { cases, problem: "报告为空或用例数量不一致" };
  if (!result.success || result.testResults.some((suite) => suite.status !== "passed") || cases.some((test) => test.status !== "passed")) {
    return { cases, problem: "测试套件未全部成功；请检查失败断言或运行环境" };
  }
  return { cases };
}

export async function runProductVerification(root: string, artifactDigest: string): Promise<VerificationReport> {
  let stdout = "";
  let stderr = "";
  let exitCode: number | null = null;
  let problem: string | undefined;
  let vitestVersion = "unknown";
  let cases: TestCaseResult[] = [];
  let rawReport: string | undefined;
  let outputDir: string | undefined;
  try {
    root = realpathSync(root);
    const cli = realpathSync(path.join(root, "node_modules/vitest/vitest.mjs"));
    const pkg = z.object({ version: z.string() }).parse(JSON.parse(readFileSync(path.join(root, "node_modules/vitest/package.json"), "utf8")) as unknown);
    vitestVersion = pkg.version;
    if (!/^[45]\./.test(vitestVersion)) throw new Error("首版验收仅适配已安装的 Vitest 4/5");
    outputDir = mkdtempSync(path.join(tmpdir(), "easymint-verification-"));
    const outputFile = path.join(outputDir, "report.json");
    const execution = await new Promise<{ stdout: string; stderr: string; exitCode: number | null; problem?: string }>((resolve) => {
      // Electron 自身附带 Node；普通 Node 测试下沿用当前解释器。无需 shell 或自动下载依赖。
      execFile(process.execPath, [cli, "run", "--reporter=json", `--outputFile=${outputFile}`, "--retry=0", "--passWithNoTests=false"], {
        cwd: root, encoding: "utf8", timeout: 120000, maxBuffer: 4 * 1024 * 1024,
        killSignal: "SIGKILL", windowsHide: true,
        env: { ...process.env, ELECTRON_RUN_AS_NODE: "1", CI: "1", NO_COLOR: "1" },
      }, (error, out, err) => resolve({
        stdout: out, stderr: err, exitCode: error ? typeof error.code === "number" ? error.code : null : 0,
        problem: error ? error.killed ? "测试超时或输出超限，执行已终止" : "测试进程异常退出" : undefined,
      }));
    });
    ({ stdout, stderr, exitCode, problem } = execution);
    const stat = lstatSync(outputFile);
    if (!stat.isFile() || stat.size > 4 * 1024 * 1024) throw new Error("测试报告格式异常或超过大小限制");
    rawReport = readFileSync(outputFile, "utf8");
    const parsed = parseVitestReport(rawReport, root);
    cases = parsed.cases;
    problem ??= parsed.problem;
  } catch (cause) {
    problem = `无法完成验收：${cause instanceof Error ? cause.message : String(cause)}`;
  } finally {
    if (outputDir) rmSync(outputDir, { recursive: true, force: true });
  }
  let finishedArtifactDigest = "unavailable";
  try { finishedArtifactDigest = productArtifactDigest(root); }
  catch (cause) { problem = `无法核对运行后源码：${String(cause)}`; }
  return { artifactDigest, finishedArtifactDigest, exitCode, problem, stdout, stderr, rawReport, cases,
    finishedAt: new Date().toISOString(), nodeVersion: process.versions.node, vitestVersion };
}
