import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import os from "node:os";
import fs from "node:fs";
import path from "node:path";

// paths.ts 在模块作用域 import electron（getResourcesDir 用 app）——测试里先打桩
vi.mock("electron", () => ({ app: { isPackaged: false } }));

import { nearestExistingDir } from "./paths";

let dir = "";

beforeAll(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "em-paths-"));
  fs.writeFileSync(path.join(dir, "a.txt"), "x");
});

afterAll(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

describe("nearestExistingDir（dialog.defaultPath 用）", () => {
  it("目录已存在 → 原样返回", () => {
    expect(nearestExistingDir(dir)).toBe(dir);
  });

  it("多级不存在 → 上溯到最近存在的祖先（用户还没建过项目目录时的典型情形）", () => {
    expect(nearestExistingDir(path.join(dir, "EasyMintProject"))).toBe(dir);
    expect(nearestExistingDir(path.join(dir, "no1", "no2", "no3"))).toBe(dir);
  });

  it("路径指向文件而非目录 → 继续上溯到其父目录", () => {
    expect(nearestExistingDir(path.join(dir, "a.txt"))).toBe(dir);
  });

  it("空值 → undefined（交由系统决定，不传 defaultPath）", () => {
    expect(nearestExistingDir(undefined)).toBeUndefined();
    expect(nearestExistingDir("")).toBeUndefined();
  });

  it("上溯到根：root 必然存在 → 返回 root，且不会死循环", () => {
    const root = path.parse(dir).root;
    expect(nearestExistingDir(path.join(root, "__em_not_exist_at_all__"))).toBe(root);
  });
});
