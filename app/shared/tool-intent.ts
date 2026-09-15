/**
 * 工具调用的「意图」：让聊天页**不展开**也能知道这次调用在做什么。
 *
 * 两种来源，按可靠性排序：
 * 1. **`_intent`**（模型调用时填）—— bash 已用同样的方式（`description` 参数 + 工具说明里
 *    写死要求，见 `background-shell/tool.ts`）稳定生效。MCP 工具的 schema 由第三方 server 定义、
 *    我们改不了，但**把工具交给模型**和**把调用发给 server** 这两头都在 EM 手里：
 *    给模型看的那份 schema 加 `_intent`，`mcp-adapter` 转发前用 `stripIntentParams()` 剥掉，
 *    **server 永远不会看到它**，所以不会有"未知参数"的报错风险。
 * 2. **参数摘要**（`summarizeInput`）—— 老会话、或模型没填时的兜底：取参数里最有语义的
 *    那个字符串值（query / url / name …）。
 *
 * 字段名为什么是 `_intent` 而不是 `description`：server 的 schema 里**可能本来就有**
 * `description` 参数，撞了会覆盖真实参数。下划线前缀的冲突概率极低。
 */

/** 模型填报意图所用的参数名（仅 EM 内部使用，不会传给 MCP server） */
export const INTENT_PARAM = "_intent";

/** 追加到 MCP 工具说明末尾的那一句——与 bash 的写法一致，实测能让模型每次都填 */
export const INTENT_REQUIREMENT =
  `每次调用都要填 ${INTENT_PARAM}：一句话中文简述这次调用在做什么（≤12 字，如「查竞品资料」「建 issue」），` +
  "用于聊天页展示；该字段只用于展示，不会传给工具。";

/** 参数摘要的优先键：这些值最能说明"做了什么" */
const SUMMARY_KEYS = [
  "query", "q", "search", "keyword", "text", "prompt", "url", "path", "name", "title",
] as const;

/** 标题行展示的最大字符数（超了截断，完整值仍在展开区） */
const MAX_LEN = 28;

function clip(value: string): string {
  const s = value.trim().replace(/\s+/g, " ");
  return s.length > MAX_LEN ? `${s.slice(0, MAX_LEN - 1)}…` : s;
}

/**
 * 取这次调用的意图。优先模型填的 `_intent`，没有则回退到参数摘要。
 * 取不到返回 undefined —— 调用方应**不显示**那段，而不是显示占位（标题行越短越好）。
 */
export function intentFromInput(input: unknown): string | undefined {
  if (!input || typeof input !== "object" || Array.isArray(input)) return undefined;
  const rec = input as Record<string, unknown>;
  const intent = rec[INTENT_PARAM];
  if (typeof intent === "string" && intent.trim()) return clip(intent);
  return summarizeInput(rec);
}

/** 兜底：取第一个有语义的字符串参数（first-match，不拼接——标题行只放得下一件事） */
export function summarizeInput(input: Record<string, unknown>): string | undefined {
  for (const key of SUMMARY_KEYS) {
    const v = input[key];
    if (typeof v === "string" && v.trim()) return clip(v);
  }
  return undefined;
}

/**
 * 给工具 schema 加 `_intent` 可选字段。
 * 防御优先：schema 来自第三方，可能没有 `properties`、可能是布尔 schema —— 无法安全改写时
 * **原样返回**（宁可没有意图字段，也不能把工具搞挂）。
 */
export function withIntentParam<T>(schema: T): T {
  if (!schema || typeof schema !== "object" || Array.isArray(schema)) return schema;
  const s = schema as Record<string, unknown>;
  if (s.type !== "object") return schema;
  const props = s.properties;
  if (!props || typeof props !== "object" || Array.isArray(props)) return schema;
  if (INTENT_PARAM in (props as Record<string, unknown>)) return schema; // server 已占用：不覆盖
  return {
    ...s,
    properties: {
      ...(props as Record<string, unknown>),
      [INTENT_PARAM]: {
        type: "string",
        description: "一句话中文简述本次调用在做什么（≤12 字，如「查竞品资料」「建 issue」）；仅用于聊天页展示，不会传给工具",
      },
    },
  } as unknown as T; // 结构与入参同型（只多一个可选字段），调用处无需断言
}

/** 转发给 server 前剥掉 `_intent`（无该字段时返回原对象，避免无谓拷贝） */
export function stripIntentParams<T>(params: T): T {
  if (!params || typeof params !== "object" || Array.isArray(params)) return params;
  const rec = params as Record<string, unknown>;
  if (!(INTENT_PARAM in rec)) return params;
  const { [INTENT_PARAM]: _dropped, ...rest } = rec;
  return rest as T;
}
