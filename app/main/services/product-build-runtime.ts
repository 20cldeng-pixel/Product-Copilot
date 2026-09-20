/** 进程内所有服务实例共用。磁盘 running 不等于当前进程确有执行器。 */
const owners = new Map<string, { runId: string; controller: AbortController }>();

export const productBuildRuntime = {
  get: (projectId: string) => owners.get(projectId),
  abortAll() { for (const owner of owners.values()) owner.controller.abort(); },
  acquire(projectId: string, runId: string): AbortController {
    if (owners.has(projectId)) throw new Error("项目已有开发任务");
    const controller = new AbortController();
    owners.set(projectId, { runId, controller });
    return controller;
  },
  release(projectId: string, runId: string) {
    if (owners.get(projectId)?.runId === runId) owners.delete(projectId);
  },
};
