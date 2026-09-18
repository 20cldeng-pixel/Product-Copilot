/**
 * IPC 广播 — 向所有窗口发送事件
 *
 * 消除 agent-service.ts 和 builtin-mcp.ts 中的重复定义。
 */

import { BrowserWindow } from "electron";
import { appEventBus } from "./app-event-bus";

export function broadcast(channel: string, data: unknown): void {
  // 主进程事件先进入统一总线。Electron 窗口和后续手机终端都消费同一份权威事件。
  appEventBus.publish(channel, data);
  BrowserWindow.getAllWindows().forEach((win) => {
    if (!win.isDestroyed()) win.webContents.send(channel, data);
  });
}
