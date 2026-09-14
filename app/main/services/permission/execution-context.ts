import path from "node:path";
import fs from "node:fs";
import { developmentRuntimeFor, developmentRuntimesRoot, ensureDevelopmentRuntime, type DevelopmentRuntime } from "./development-runtime";
import { readManagedEnvironment } from "../tools/environment-tool";

export type PermissionMode = "standard" | "full";

export interface ExecutionContext {
  mode: PermissionMode;
  workspaceRealPath: string;
  runtimeRoot: string;
  environment: NodeJS.ProcessEnv;
  policyVersion: "2";
  /** 会话级执行所有者。Windows 用它隔离 ACL 沙盒 worker，避免权限模式在会话间串用。 */
  ownerId?: string;
}

/** 给已经编译好的策略绑定执行所有者；所有者不是模型参数，不能从工具输入伪造。 */
export function bindExecutionOwner(context: ExecutionContext, ownerId: string): ExecutionContext {
  return { ...context, ownerId };
}

const UNSAFE_INHERITED_ENV = new Set([
  "BASH_ENV", "ENV", "ZDOTDIR", "PROMPT_COMMAND", "SHELLOPTS",
  "LD_PRELOAD", "LD_LIBRARY_PATH", "DYLD_INSERT_LIBRARIES", "DYLD_LIBRARY_PATH",
  "NODE_OPTIONS", "RUBYOPT", "PERL5OPT", "PYTHONSTARTUP",
  "GIT_EXEC_PATH", "GIT_SSH_COMMAND", "GIT_TEMPLATE_DIR",
  "JAVA_TOOL_OPTIONS", "_JAVA_OPTIONS", "ELECTRON_RUN_AS_NODE",
]);

function realWorkspace(workspace: string): string {
  const absolute = path.resolve(workspace);
  try { return fs.realpathSync.native(absolute); } catch { return absolute; }
}

function toolPathEntries(runtime: DevelopmentRuntime): string[] {
  const suffix = process.platform === "win32" ? "Scripts" : "bin";
  return [
    path.join(runtime.tools, "bin"),
    path.join(runtime.tools, "npm", "bin"),
    path.join(runtime.tools, "python", suffix),
    path.join(runtime.tools, "cargo", "bin"),
    path.join(runtime.tools, "go", "bin"),
    path.join(runtime.tools, "pnpm"),
    path.join(runtime.tools, "bun", "bin"),
  ];
}

function cleanEnvironment(source: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const result: NodeJS.ProcessEnv = {};
  for (const [key, value] of Object.entries(source)) {
    if (value !== undefined && !UNSAFE_INHERITED_ENV.has(key.toUpperCase())) result[key] = value;
  }
  return result;
}

export function createExecutionContext(
  workspace: string,
  mode: PermissionMode,
  additions: NodeJS.ProcessEnv = {},
  runtimeBaseRoot = developmentRuntimesRoot(),
): ExecutionContext {
  const workspaceRealPath = realWorkspace(workspace);
  const managed = readManagedEnvironment();
  const runtime = mode === "standard"
    ? ensureDevelopmentRuntime(workspaceRealPath, runtimeBaseRoot)
    : developmentRuntimeFor(workspaceRealPath, runtimeBaseRoot);
  if (mode === "full") {
    return {
      mode,
      workspaceRealPath,
      runtimeRoot: runtime.root,
      environment: { ...process.env, ...managed, ...additions },
      policyVersion: "2",
    };
  }

  const base = cleanEnvironment({ ...process.env, ...managed, ...additions });
  const pathValue = [...toolPathEntries(runtime), base.PATH ?? ""].filter(Boolean).join(path.delimiter);
  const environment: NodeJS.ProcessEnv = {
    ...base,
    HOME: runtime.home,
    USERPROFILE: runtime.home,
    TMPDIR: runtime.tmp,
    TMP: runtime.tmp,
    TEMP: runtime.tmp,
    XDG_CACHE_HOME: runtime.cache,
    XDG_CONFIG_HOME: runtime.config,
    XDG_STATE_HOME: runtime.state,
    NPM_CONFIG_PREFIX: path.join(runtime.tools, "npm"),
    npm_config_prefix: path.join(runtime.tools, "npm"),
    npm_config_global_prefix: path.join(runtime.tools, "npm"),
    NPM_CONFIG_CACHE: path.join(runtime.cache, "npm"),
    npm_config_cache: path.join(runtime.cache, "npm"),
    NPM_CONFIG_USERCONFIG: path.join(runtime.config, "npm", "npmrc"),
    npm_config_userconfig: path.join(runtime.config, "npm", "npmrc"),
    npm_config_globalconfig: path.join(runtime.config, "npm", "global-npmrc"),
    COREPACK_HOME: path.join(runtime.cache, "corepack"),
    PNPM_HOME: path.join(runtime.tools, "pnpm"),
    YARN_CACHE_FOLDER: path.join(runtime.cache, "yarn"),
    BUN_INSTALL: path.join(runtime.tools, "bun"),
    BUN_INSTALL_CACHE_DIR: path.join(runtime.cache, "bun"),
    PIP_CACHE_DIR: path.join(runtime.cache, "pip"),
    UV_CACHE_DIR: path.join(runtime.cache, "uv"),
    PYTHONUSERBASE: path.join(runtime.tools, "python"),
    GRADLE_USER_HOME: path.join(runtime.cache, "gradle"),
    MAVEN_OPTS: `${base.MAVEN_OPTS ?? ""} -Dmaven.repo.local=${path.join(runtime.cache, "maven")}`.trim(),
    CARGO_HOME: path.join(runtime.tools, "cargo"),
    GOPATH: path.join(runtime.tools, "go"),
    GOMODCACHE: path.join(runtime.cache, "go", "pkg", "mod"),
    GOBIN: path.join(runtime.tools, "go", "bin"),
    PUB_CACHE: path.join(runtime.cache, "dart"),
    DENO_DIR: path.join(runtime.cache, "deno"),
    DOTNET_CLI_HOME: path.join(runtime.home, ".dotnet"),
    NUGET_PACKAGES: path.join(runtime.cache, "nuget"),
    COMPOSER_HOME: path.join(runtime.config, "composer"),
    COMPOSER_CACHE_DIR: path.join(runtime.cache, "composer"),
    CCACHE_DIR: path.join(runtime.cache, "ccache"),
    PATH: pathValue,
    PWD: workspaceRealPath,
    INIT_CWD: workspaceRealPath,
    EASYMINT_WORKSPACE: workspaceRealPath,
    EASYMINT_RUNTIME: runtime.root,
  };
  if (process.platform === "win32") {
    environment.APPDATA = path.join(runtime.config, "AppData", "Roaming");
    environment.LOCALAPPDATA = path.join(runtime.state, "AppData", "Local");
  }
  return { mode, workspaceRealPath, runtimeRoot: runtime.root, environment, policyVersion: "2" };
}

export const executionContextInternals = {
  isUnsafeEnvironmentName: (name: string): boolean => UNSAFE_INHERITED_ENV.has(name.toUpperCase()),
};
