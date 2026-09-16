/**
 * set_task_status 状态一致性守卫（2026-09-16）。
 *
 * 背景：原实现 **硬拒绝** 手动标 done——理由是"done 由委派执行结果自动回写"。但极简/简单档
 * 由 Mint 亲自实现（见系统提示词「任务执行」的执行方式判定），没有委派结果可回写，于是进度条
 * 永远停在 building。这条守卫把「done 可手动标记」钉死：若哪天有人把拒绝加回来，本用例必红。
 *
 * 委派实现的 done 由 task/executor 直接回写文件、不经过本函数，所以放行手动标记不影响委派路径。
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

/** 被测模块读到的 task.json 内容（每个用例前替换） */
let taskFile: { tasks: Array<{ id: number | string; status?: string; title?: string }> } = { tasks: [] };

vi.mock("node:fs", () => ({
  existsSync: (): boolean => true,
  readFileSync: (): string => JSON.stringify(taskFile),
}));

import { validateTaskStatus } from "./hooks";

const PROJ = "/tmp/fake-project";

beforeEach(() => {
  taskFile = { tasks: [{ id: 1, title: "实现首页", status: "building" }] };
});

describe("validateTaskStatus", () => {
  it("done 可手动标记——亲自实现的任务靠它推进进度（回归守卫）", () => {
    expect(validateTaskStatus(PROJ, "1", "done")).toBeNull();
  });

  it("done 不要求前置状态：pending/building 都能直接收尾", () => {
    taskFile = { tasks: [{ id: 7, status: "pending" }] };
    expect(validateTaskStatus(PROJ, "7", "done")).toBeNull();
  });

  it("evaluating 必须先 building", () => {
    taskFile = { tasks: [{ id: 2, status: "pending" }] };
    expect(validateTaskStatus(PROJ, "2", "evaluating")).toContain("必须先标记为 building");
  });

  it("failed 只能从 building / evaluating 来", () => {
    taskFile = { tasks: [{ id: 3, status: "done" }] };
    expect(validateTaskStatus(PROJ, "3", "failed")).toContain("只能将");
    taskFile = { tasks: [{ id: 3, status: "evaluating" }] };
    expect(validateTaskStatus(PROJ, "3", "failed")).toBeNull();
  });

  it("任务不存在时明确报错", () => {
    expect(validateTaskStatus(PROJ, "999", "done")).toContain("未找到");
  });

  it("无项目路径时放行（非项目态不校验）", () => {
    expect(validateTaskStatus(undefined, "1", "done")).toBeNull();
  });
});
