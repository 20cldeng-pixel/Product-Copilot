export type GatherEventRecord = {
  id: string; sessionId: string; mockUserId: string; activityId: string;
  artifactVersion: string; at: string; source: 'local_trial' | 'synthetic';
  kind: 'view' | 'submit' | 'result'; outcome?: 'success' | 'rejected'; reason?: string;
};

const KEY = 'gather-business-events-v1';
const SESSION_KEY = 'gather-business-session-v1';
const ARTIFACT_VERSION = 'gather-v2';

function sessionId(): string {
  let value = sessionStorage.getItem(SESSION_KEY);
  if (!value) { value = crypto.randomUUID(); sessionStorage.setItem(SESSION_KEY, value); }
  return value;
}

export function readEvents(): GatherEventRecord[] {
  const raw = localStorage.getItem(KEY);
  if (!raw) return [];
  const parsed: unknown = JSON.parse(raw);
  if (!Array.isArray(parsed)) throw new Error('事件记录格式无效');
  return parsed as GatherEventRecord[];
}

/** 分析数据与业务数据分离；调用方必须在采集失败时显示缺口。 */
export function recordEvent(input: Pick<GatherEventRecord, 'mockUserId' | 'activityId' | 'kind' | 'outcome' | 'reason'>): void {
  const existing = readEvents();
  const event: GatherEventRecord = {
    ...input, id: crypto.randomUUID(), sessionId: sessionId(), artifactVersion: ARTIFACT_VERSION,
    at: new Date().toISOString(), source: new URLSearchParams(location.search).get('dataSource') === 'synthetic' ? 'synthetic' : 'local_trial',
  };
  localStorage.setItem(KEY, JSON.stringify([...existing, event]));
}

export function exportEvents(): void {
  const data = JSON.stringify({ format: 'gather-events-v1', events: readEvents() }, null, 2);
  const url = URL.createObjectURL(new Blob([data], { type: 'application/json' }));
  try {
    const link = document.createElement('a');
    link.href = url;
    link.download = 'gather-business-events.json';
    link.click();
  } finally { window.setTimeout(() => URL.revokeObjectURL(url), 1000); }
}
