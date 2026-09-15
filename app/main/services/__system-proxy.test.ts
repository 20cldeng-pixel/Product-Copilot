/**
 * 系统代理接管（`services/system-proxy.ts`）的守卫测试。
 *
 * 背景（2026-09-15 实测）：Node 原生 fetch 不读系统代理、也不读 HTTPS_PROXY，于是
 * 「浏览器授权页显示成功（Chromium 走代理）、程序内换 token 被地区拦」——用户实际踩到。
 * 这里钉住三件事：
 * ① 检测解析（macOS `scutil --proxy` / Windows `reg query` 的真实输出形态）；
 * ② 本机/NO_PROXY 必须直连（乱挂代理会把本地服务打穿）；
 * ③ 检测不到代理时**一个字节都不改**（默认路径上的用户不该受这个特性影响）。
 */
import { describe, expect, it, vi } from "vitest";
import {
  detectSystemProxy,
  installSystemProxyFetch,
  parseScutilProxy,
  parseWindowsProxy,
  shouldBypassProxy,
} from "./system-proxy";

/** 用户机器上的真实输出（2026-09-15，VPN 客户端的系统代理） */
const SCUTIL_HTTPS = `<dictionary> {
  ExceptionsList : <array> {
    0 : localhost
    1 : 127.0.0.1/8
  }
  FTPPassive : 1
  HTTPEnable : 1
  HTTPPort : 9527
  HTTPProxy : localhost
  HTTPSEnable : 1
  HTTPSPort : 9527
  HTTPSProxy : localhost
  SOCKSEnable : 1
  SOCKSPort : 9527
  SOCKSProxy : localhost
}`;

const REG_WINDOWS = `HKEY_CURRENT_USER\\Software\\Microsoft\\Windows\\CurrentVersion\\Internet Settings
    ProxyEnable    REG_DWORD    0x1
    ProxyServer    REG_SZ    127.0.0.1:7890
`;

describe("代理检测", () => {
  it("macOS scutil：优先 HTTPS 条目，关闭时回落到 HTTP", () => {
    expect(parseScutilProxy(SCUTIL_HTTPS)).toBe("http://localhost:9527");
    expect(parseScutilProxy(SCUTIL_HTTPS.replace("HTTPSEnable : 1", "HTTPSEnable : 0")))
      .toBe("http://localhost:9527"); // 落到 HTTP 条目，同样是 9527
    expect(parseScutilProxy(SCUTIL_HTTPS.replace(/HTTPSEnable : 1/, "HTTPSEnable : 0")
      .replace("HTTPEnable : 1", "HTTPEnable : 0"))).toBeUndefined();
    expect(parseScutilProxy("")).toBeUndefined();
  });

  it("macOS scutil：SOCKS-only 不算（undici 的 ProxyAgent 不支持 SOCKS）", () => {
    const socksOnly = `<dictionary> {
  HTTPEnable : 0
  HTTPSEnable : 0
  SOCKSEnable : 1
  SOCKSPort : 1080
  SOCKSProxy : localhost
}`;
    expect(parseScutilProxy(socksOnly)).toBeUndefined();
  });

  it("Windows reg query：ProxyEnable=0 时不认，两种 ProxyServer 形态都认", () => {
    expect(parseWindowsProxy(REG_WINDOWS)).toBe("http://127.0.0.1:7890");
    expect(parseWindowsProxy(REG_WINDOWS.replace("0x1", "0x0"))).toBeUndefined();
    expect(parseWindowsProxy(
      '    ProxyEnable    REG_DWORD    0x1\n    ProxyServer    REG_SZ    http=127.0.0.1:7890;https=127.0.0.1:7891\n',
    )).toBe("http://127.0.0.1:7891");
  });

  it("来源顺序：环境变量优先于系统设置；darwin 走 scutil", () => {
    const run = vi.fn(() => SCUTIL_HTTPS);
    expect(detectSystemProxy({ platform: "darwin", env: { https_proxy: "http://env:1" }, run }))
      .toBe("http://env:1");
    expect(run).not.toHaveBeenCalled();
    expect(detectSystemProxy({ platform: "darwin", env: {}, run })).toBe("http://localhost:9527");
    // 无协议头的写法补成 http://
    expect(detectSystemProxy({ platform: "linux", env: { ALL_PROXY: "127.0.0.1:1080", https_proxy: "" } }))
      .toBe("http://127.0.0.1:1080");
    expect(detectSystemProxy({ platform: "linux", env: {} })).toBeUndefined();
  });

  it("本机与 NO_PROXY 一律直连（否则本地服务会被代理打穿）", () => {
    const no = "";
    for (const host of ["localhost", "127.0.0.1", "127.0.0.53", "::1", "app.localhost"]) {
      expect(shouldBypassProxy(host, no)).toBe(true);
    }
    expect(shouldBypassProxy("auth.openai.com", no)).toBe(false);
    expect(shouldBypassProxy("api.example.com", "example.com")).toBe(true);
    expect(shouldBypassProxy("example.com", ".example.com")).toBe(true);
    expect(shouldBypassProxy("other.com", "*")).toBe(true);
    expect(shouldBypassProxy("notexample.com", "example.com")).toBe(false);
  });
});

describe("接管 fetch", () => {
  const makeTarget = () => {
    const calls: Array<{ url: string; init?: Record<string, unknown> }> = [];
    const fetchImpl = vi.fn(async (input: unknown, init?: Record<string, unknown>) => {
      const url = typeof input === "string" ? input : (input as URL).href;
      calls.push({ url, init });
      return new Response("ok");
    });
    return { target: { fetch: fetchImpl as unknown as typeof fetch }, calls, fetchImpl };
  };

  it("检测到代理：非本机请求补 dispatcher，本机请求保持原样", async () => {
    const { target, calls } = makeTarget();
    const agent = { name: "agent" };
    const createAgent = vi.fn(async () => agent);
    const env: NodeJS.ProcessEnv = {};

    const r = installSystemProxyFetch({ platform: "darwin", env, run: () => SCUTIL_HTTPS, createAgent, target });
    expect(r).toMatchObject({ installed: true, proxy: "http://localhost:9527" });

    await target.fetch("https://auth.openai.com/oauth/token", { method: "POST" });
    await target.fetch("http://127.0.0.1:5199/api");
    await target.fetch("http://localhost:1455/auth/callback");

    expect(calls[0].init?.dispatcher).toBe(agent);
    expect(calls[1].init?.dispatcher).toBeUndefined();
    expect(calls[2].init?.dispatcher).toBeUndefined();
    expect(createAgent).toHaveBeenCalledTimes(1); // agent 只建一次，后续复用
    // 代理变量写进 env：SDK 自己的 LLM 路径（Codex WebSocket / Bedrock）读的是这些
    expect(env.https_proxy).toBe("http://localhost:9527");
    expect(env.no_proxy).toContain("localhost");
  });

  it("用户已显式设置的代理变量不被覆盖", () => {
    const { target } = makeTarget();
    const env: NodeJS.ProcessEnv = { https_proxy: "http://user:1" };
    installSystemProxyFetch({ platform: "darwin", env: { ...env }, run: () => SCUTIL_HTTPS, createAgent: async () => ({}), target });
    expect(env.https_proxy).toBe("http://user:1");
  });

  it("没检测到代理 → 不接管、不改任何环境变量", async () => {
    const { target, calls } = makeTarget();
    const env: NodeJS.ProcessEnv = {};
    const r = installSystemProxyFetch({ platform: "linux", env, run: () => "", createAgent: vi.fn(), target });
    expect(r.installed).toBe(false);
    expect(r.reason).toContain("未检测到");
    await target.fetch("https://auth.openai.com/oauth/token");
    expect(calls[0].init?.dispatcher).toBeUndefined();
    expect(env.https_proxy).toBeUndefined();
  });

  it("逃生阀：EASYMINT_NO_SYSTEM_PROXY=1 时不接管（即使有代理）", async () => {
    const { target, calls } = makeTarget();
    const env: NodeJS.ProcessEnv = { EASYMINT_NO_SYSTEM_PROXY: "1" };
    const r = installSystemProxyFetch({ platform: "darwin", env, run: () => SCUTIL_HTTPS, createAgent: vi.fn(), target });
    expect(r.installed).toBe(false);
    await target.fetch("https://auth.openai.com/oauth/token");
    expect(calls[0].init?.dispatcher).toBeUndefined();
  });
});
