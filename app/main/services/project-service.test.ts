/**
 * project-service 单测 —— 打开项目弹窗的「最近打开」排序。
 *
 * 隔离方式：Store 传入临时目录作 baseDir（projects.json / em-settings.json 都落在那里），
 * 不碰用户真实的 ~/.easymint。electron 只用到 shell（delete 路径），本文件用不到但需存在。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

vi.mock("electron", () => ({ shell: { trashItem: vi.fn() } }));

import { Store } from "./store";
import { ProjectService } from "./project-service";

let tmpDir: string;
let store: Store;
let svc: ProjectService;

function rec(id: string, lastOpenedAt?: string): Record<string, unknown> {
  return {
    id,
    name: id,
    path: path.join(tmpDir, id),
    createdAt: "2026-01-01T00:00:00.000Z",
    ...(lastOpenedAt === undefined ? {} : { lastOpenedAt }),
    status: "setup",
    description: "",
  };
}

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "em-project-svc-"));
  store = new Store(tmpDir);
  svc = new ProjectService(store, tmpDir);
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
  vi.useRealTimers();
});

describe("ProjectService.list — 最近打开排序", () => {
  it("按 lastOpenedAt 降序返回（最近的在前），与 json 中的存储顺序无关", () => {
    store.saveProjects([
      rec("old", "2026-01-01T00:00:00.000Z"),
      rec("newest", "2026-03-01T00:00:00.000Z"),
      rec("mid", "2026-02-01T00:00:00.000Z"),
    ] as never);

    expect(svc.list().map((p) => p.id)).toEqual(["newest", "mid", "old"]);
  });

  it("lastOpenedAt 缺失或非法时排到最后，且不产生 NaN 乱序", () => {
    store.saveProjects([
      rec("noField"),
      rec("bad", "不是时间"),
      rec("ok", "2026-02-01T00:00:00.000Z"),
    ] as never);

    const ids = svc.list().map((p) => p.id);
    expect(ids[0]).toBe("ok");
    expect(ids.slice(1).sort()).toEqual(["bad", "noField"]);
  });

  it("lastOpenedAt 相同时保持 json 原有顺序（稳定排序，不来回抖）", () => {
    store.saveProjects([
      rec("a", "2026-02-01T00:00:00.000Z"),
      rec("b", "2026-02-01T00:00:00.000Z"),
      rec("c", "2026-02-01T00:00:00.000Z"),
    ] as never);

    expect(svc.list().map((p) => p.id)).toEqual(["a", "b", "c"]);
  });
});

describe("Store.setLastProjectId — 打开项目时刷新 lastOpenedAt", () => {
  it("更新目标项目的 lastOpenedAt 并落盘，其它项目不受影响", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-05-05T10:00:00.000Z"));
    store.saveProjects([
      rec("target", "2026-01-01T00:00:00.000Z"),
      rec("other", "2026-01-02T00:00:00.000Z"),
    ] as never);

    store.setLastProjectId("target");

    const after: Record<string, string> = {};
    for (const p of store.getProjects()) after[p.id] = p.lastOpenedAt;
    expect(after.target).toBe("2026-05-05T10:00:00.000Z");
    expect(after.other).toBe("2026-01-02T00:00:00.000Z");
    // 落盘的成果能被后续读取：重新构造 Store 依然是最新时间
    expect(new Store(tmpDir).getProjects().find((p) => p.id === "target")!.lastOpenedAt)
      .toBe("2026-05-05T10:00:00.000Z");
  });

  it("随后 list() 把刚打开的项目排到最前", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-05-05T10:00:00.000Z"));
    store.saveProjects([
      rec("first", "2026-03-01T00:00:00.000Z"),
      rec("second", "2026-04-01T00:00:00.000Z"),
    ] as never);

    store.setLastProjectId("first");

    expect(svc.list().map((p) => p.id)).toEqual(["first", "second"]);
  });

  it("id 不在项目列表中时只写 lastProjectId，不弄坏 projects.json", () => {
    store.saveProjects([rec("real", "2026-01-01T00:00:00.000Z")] as never);

    expect(() => store.setLastProjectId("ghost")).not.toThrow();

    expect(store.getLastProjectId()).toBe("ghost");
    expect(store.getProjects().find((p) => p.id === "real")!.lastOpenedAt)
      .toBe("2026-01-01T00:00:00.000Z");
  });
});
