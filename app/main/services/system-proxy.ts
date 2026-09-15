/**
 * 让主进程的 HTTP 请求跟随系统代理。
 *
 * 为什么需要（2026-09-15 实测，别再重新推导）：
 * Node 原生 fetch（undici）**既不读 macOS 系统代理、也不读 HTTPS_PROXY**：
 *   · 同一条换 token 请求直连 → `403 unsupported_country_region_territory`（OpenAI 按出口地区拦）；
 *     经系统代理（`curl --proxy http://localhost:9527`）→ 通过。
 *   · **运行期改 process.env 无效**：undici 在启动阶段就决定要不要启用环境变量代理
 *     （NODE_USE_ENV_PROXY 必须在启动前给），所以"进程序里再设 HTTPS_PROXY"这条路走不通。
 * 于是出现最容易误判的症状：**浏览器授权页显示 Authentication successful（Chromium 走系统代理），
 * 程序内却报地区拦截** —— 那个成功页是本进程的本地回调服务发的，与换 token 无关。
 *
 * 上游 SDK 的另一半：它自己的 LLM 路径（Codex 的 WebSocket、Bedrock）**另行支持代理**，读的是
 * `https_proxy`/`all_proxy` 环境变量（见 `@earendil-works/pi-ai/dist/utils/node-http-proxy.js`
 * 的 `getProxyEnv`/`resolveHttpProxyUrlForTarget`）；只有 OAuth 换 token 这类裸全局 fetch 没人照顾。
 * 所以本模块在改写 fetch 的同时，也把小写代理变量写进 process.env 供那些路径使用。
 *
 * 策略：检测到代理才动手（检测不到 → 完全不改行为），且**本机/环回地址永远直连**。
 * 逃生阀：`EASYMINT_NO_SYSTEM_PROXY=1`。
 */

import { execFileSync } from "node:child_process";

export interface ProxyDeps {
  platform?: string;
  env?: NodeJS.ProcessEnv;
  /** 执行系统命令取 stdout（注入以便测试）；失败应返回空串 */
  run?: (cmd: string, args: string[]) => string;
  /** 建连接代理（默认真实实现为 undici 的 ProxyAgent，动态加载以免拖慢启动） */
  createAgent?: (proxyUrl: string) => Promise<unknown>;
  /** 改写对象（测试注入；默认 globalThis） */
  target?: { fetch: typeof globalThis.fetch };
}

const LOOPBACK = /^(localhost|.*\.localhost|127(\.\d{1,3}){3}|::1|0\.0\.0\.0|\[::1\])$/i;

function normalizeProxyUrl(raw: string): string | undefined {
  const value = raw.trim();
  if (!value) return undefined;
  return /^[a-z][a-z0-9+.-]*:\/\//i.test(value) ? value : `http://${value}`;
}

/**
 * 解析 macOS `scutil --proxy` 的输出（纯函数：用真实输出做回归，见 __system-proxy.test.ts）。
 * 优先 HTTPS 条目——它同样是一个 HTTP CONNECT 代理；undici 的 ProxyAgent 不支持 SOCKS，故不取 SOCKS。
 */
export function parseScutilProxy(out: string): string | undefined {
  const value = (key: string): string | undefined =>
    out.match(new RegExp(`^\\s*${key}\\s*:\\s*(.+?)\\s*$`, "m"))?.[1]?.trim();
  const enabled = (key: string): boolean => value(key) === "1";
  if (enabled("HTTPSEnable")) {
    const host = value("HTTPSProxy");
    const port = value("HTTPSPort");
    return host && port ? `http://${host}:${port}` : undefined;
  }
  if (enabled("HTTPEnable")) {
    const host = value("HTTPProxy");
    const port = value("HTTPPort");
    return host && port ? `http://${host}:${port}` : undefined;
  }
  return undefined;
}

/**
 * 解析 Windows 注册表 `Internet Settings` 的 `reg query` 输出（纯函数）。
 * ProxyServer 有两种形态：`host:port` 与按协议列举的 `http=host:port;https=host:port`。
 */
export function parseWindowsProxy(out: string): string | undefined {
  if (!/ProxyEnable\s+REG_DWORD\s+0x1/i.test(out)) return undefined;
  const server = out.match(/ProxyServer\s+REG_SZ\s+(.+?)\s*$/im)?.[1];
  if (!server) return undefined;
  const perProtocol = server.match(/(?:^|;)\s*https=([^;]+)/i)?.[1];
  const host = (perProtocol ?? server.split(";")[0]?.replace(/^[a-z]+=/i, "") ?? "").trim();
  return host ? `http://${host}` : undefined;
}

/** 命中即直连：本机地址，或用户 NO_PROXY 列表里的主机（支持 `*` 与 `.suffix` 两种写法） */
export function shouldBypassProxy(hostname: string, noProxy: string): boolean {
  if (LOOPBACK.test(hostname)) return true;
  const host = hostname.toLowerCase();
  return noProxy
    .split(",")
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean)
    .some((entry) => {
      if (entry === "*") return true;
      const bare = entry.replace(/:\d+$/, "");
      if (bare.startsWith(".")) return host.endsWith(bare) || host === bare.slice(1);
      return host === bare || host.endsWith(`.${bare}`);
    });
}

/** 代理来源顺序：显式环境变量 → 系统设置。Linux 只认环境变量（桌面环境的图形设置不作为来源） */
export function detectSystemProxy(deps: ProxyDeps = {}): string | undefined {
  const env = deps.env ?? process.env;
  const fromEnv = env.https_proxy || env.HTTPS_PROXY || env.http_proxy || env.HTTP_PROXY
    || env.all_proxy || env.ALL_PROXY;
  if (fromEnv) return normalizeProxyUrl(fromEnv);

  const platform = deps.platform ?? process.platform;
  const run = deps.run ?? ((cmd, args) => {
    try {
      return execFileSync(cmd, args, { encoding: "utf-8", timeout: 3000 });
    } catch {
      return "";
    }
  });
  if (platform === "darwin") return parseScutilProxy(run("/usr/sbin/scutil", ["--proxy"]));
  if (platform === "win32") {
    return parseWindowsProxy(run("reg", [
      "query", "HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Internet Settings",
    ]));
  }
  return undefined;
}

/** 安装结果。`installed: false` 时 reason 说明原因（正常启动路径上都会打印一行） */
export interface ProxyInstallResult {
  installed: boolean;
  proxy?: string;
  reason: string;
}

/** 已接管的标记挂在 target 上（而非模块级开关）：语义是「这份 fetch 已被包装过」，测试注入各自的 target 时互不干扰 */
const WRAPPED = Symbol.for("easymint.systemProxyWrapped");

type Marked = { [WRAPPED]?: string };

/**
 * 让主进程的 fetch 跟随系统代理（幂等；须在网络请求发生前调用，见文件头说明）。
 *
 * 只对**非本机**目标补 dispatcher，因此不影响与本地服务（vite dev server、本地模型服务等）的通信。
 */
export function installSystemProxyFetch(deps: ProxyDeps = {}): ProxyInstallResult {
  const env = deps.env ?? process.env;
  const target = deps.target ?? globalThis;
  if ((target as Marked)[WRAPPED]) return { installed: false, reason: "已安装" };
  if (env.EASYMINT_NO_SYSTEM_PROXY === "1") {
    return { installed: false, reason: "已由 EASYMINT_NO_SYSTEM_PROXY=1 关闭" };
  }
  const proxy = detectSystemProxy({ ...deps, env });
  if (!proxy) return { installed: false, reason: "未检测到系统代理" };

  const noProxy = env.no_proxy || env.NO_PROXY || "localhost,127.0.0.1,::1";
  const createAgent = deps.createAgent ?? (async (url: string) => {
    // 动态加载：undici 约 2MB，没代理时不该为它付启动成本（本模块只在检测到代理后才走到这里）
    const { ProxyAgent } = await import("undici");
    return new ProxyAgent(url);
  });

  const original = target.fetch.bind(target);
  let agentPromise: Promise<unknown> | undefined;
  const ensureAgent = (): Promise<unknown> => (agentPromise ??= createAgent(proxy));

  target.fetch = (async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    let hostname: string | undefined;
    try {
      const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
      hostname = new URL(url).hostname;
    } catch {
      hostname = undefined; // 解析不了就按原样发，别把好好的请求拦死
    }
    if (!hostname || shouldBypassProxy(hostname, noProxy)) return original(input, init);
    const dispatcher = await ensureAgent();
    return original(input, { ...(init ?? {}), dispatcher } as RequestInit);
  }) as typeof globalThis.fetch;

  // 小写优先：SDK 的 getProxyEnv 先读小写，再读大写（大写一并写，兼容其它按惯例读大写变量的库）
  for (const [key, value] of [
    ["https_proxy", proxy], ["http_proxy", proxy], ["all_proxy", proxy], ["no_proxy", noProxy],
    ["HTTPS_PROXY", proxy], ["HTTP_PROXY", proxy], ["ALL_PROXY", proxy], ["NO_PROXY", noProxy],
  ] as const) {
    if (!env[key]) env[key] = value;
  }

  (target as Marked)[WRAPPED] = proxy;
  return { installed: true, proxy, reason: "已接管主进程 fetch" };
}
