import type { AgentService } from "./agent-service";
import { getPendingAskSnapshots } from "./agent-service";
import type { ProjectService } from "./project-service";
import { listOpenProjectIds } from "./window-manager";
import { getSessionInfo, getSessionMessages, listSessions } from "./session-service";
import { readCache } from "./session-cache";
import { backgroundShellRegistry } from "./background-shell/registry";
import { getRunningSummary } from "./task/registry";
import type { RemoteOpenProject, RemoteThinkingInfo } from "../../shared/remote-protocol";

export class RemoteAccessError extends Error {
  constructor(
    public readonly code: "PROJECT_NOT_OPEN" | "PROJECT_NOT_FOUND" | "SESSION_NOT_FOUND",
    message: string,
  ) {
    super(message);
    this.name = "RemoteAccessError";
  }
}

export interface RemoteSessionSnapshot {
  session: Awaited<ReturnType<typeof getSessionInfo>>;
  messages: Awaited<ReturnType<typeof getSessionMessages>>;
  cache: ReturnType<typeof readCache>;
  status: string;
  thinking: RemoteThinkingInfo | null;
  pendingAsks: ReturnType<typeof getPendingAskSnapshots>;
  bufferedEvents: unknown[];
  background: {
    shells: Array<{ id: string; command: string; startedAt: number; status: "running" | "stopping"; output: string }>;
    agents: Array<{ delegationId: string; index: number; title: string }>;
  };
}

/**
 * 桌面 IPC 与手机网关共用的会话应用层入口。
 * 此层只接受项目 ID，绝不信任远端传入的文件系统路径。
 */
export class SessionCoordinator {
  constructor(
    private readonly projectService: ProjectService,
    private readonly agentService: AgentService,
  ) {}

  listOpenProjects(): RemoteOpenProject[] {
    const open = new Set(listOpenProjectIds());
    return this.projectService.list()
      .filter((project) => open.has(project.id) && project.exists)
      .map(({ id, name, status }) => ({ id, name, status }));
  }

  async listProjectSessions(projectId: string) {
    const project = this.getOpenProject(projectId);
    return listSessions(project.path);
  }

  async getSessionSnapshot(projectId: string, sessionId: string): Promise<RemoteSessionSnapshot> {
    const project = this.getOpenProject(projectId);
    const session = await getSessionInfo(sessionId, project.path);
    if (!session) {
      throw new RemoteAccessError("SESSION_NOT_FOUND", "会话不存在或不属于当前项目");
    }
    const [messages] = await Promise.all([
      getSessionMessages(sessionId, project.path),
    ]);
    return {
      session,
      messages,
      cache: readCache(sessionId),
      status: this.agentService.getChatStatus(sessionId),
      thinking: this.agentService.getThinkingInfo(sessionId),
      pendingAsks: getPendingAskSnapshots(sessionId),
      bufferedEvents: this.agentService.peekBufferedStream(sessionId),
      background: {
        shells: backgroundShellRegistry.list()
          .filter((shell) => shell.sessionId === sessionId)
          .map(({ id, command, startedAt, status, output }) => ({ id, command, startedAt, status, output })),
        agents: getRunningSummary().tasks
          .filter((task) => task.sessionId === sessionId)
          .map(({ delegationId, index, title }) => ({ delegationId, index, title })),
      },
    };
  }

  getOpenProject(projectId: string) {
    if (!listOpenProjectIds().includes(projectId)) {
      throw new RemoteAccessError("PROJECT_NOT_OPEN", "项目当前未在 Product Copilot 中打开");
    }
    const project = this.projectService.get(projectId);
    if (!project?.exists) {
      throw new RemoteAccessError("PROJECT_NOT_FOUND", "项目不存在或路径不可用");
    }
    return project;
  }

  async requireSession(projectId: string, sessionId: string) {
    const project = this.getOpenProject(projectId);
    const session = await getSessionInfo(sessionId, project.path);
    if (!session) throw new RemoteAccessError("SESSION_NOT_FOUND", "会话不存在或不属于当前项目");
    return { project, session };
  }
}
