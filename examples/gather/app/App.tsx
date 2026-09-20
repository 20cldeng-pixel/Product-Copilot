import { useEffect, useId, useRef, useState, type FormEvent, type ReactNode } from 'react';
import {
  USER_IDS,
  createEvent,
  getEventCapacityStatus,
  getEventRegistrationCount,
  getEventRoster,
  getRemainingCapacity,
  isUserRegisteredForEvent,
  registerForEvent,
  selectEvents,
  selectRegistrationsForUser,
  toggleEventOpen,
  type AppState,
  type CreateEventError,
  type EventId,
  type GatherEvent,
  type RegistrationError,
  type UserId,
} from './domain';
import {
  LocalStorageRepository,
  PersistenceError,
  type StateRepository,
} from './repository';
import { exportEvents, recordEvent } from './telemetry';

interface ToastMessage {
  id: number;
  title: string;
  message: string;
  type: 'success' | 'error';
}

interface AppProps {
  repository?: StateRepository;
}

const statusLabels = { open: '开放', full: '已满员', closed: '已关闭' } as const;

function eventDisplayName(event: GatherEvent): string {
  return event.name.replace(/^A\d+\s*·\s*/, '');
}

function registrationErrorMessage(error: RegistrationError, state: AppState): ToastMessage {
  switch (error.code) {
    case 'EVENT_NOT_FOUND':
      return { id: 0, title: '活动不存在', message: '请刷新页面后重新选择活动。', type: 'error' };
    case 'INVALID_USER':
      return { id: 0, title: '请先选择身份', message: '选择 U1、U2 或 U3 后再报名。', type: 'error' };
    case 'ALREADY_REGISTERED':
      return {
        id: 0,
        title: '不能重复报名',
        message: `${error.userId} 已报名 ${state.eventsById[error.eventId]?.name ?? '其他活动'}。`,
        type: 'error',
      };
    case 'EVENT_CLOSED':
      return { id: 0, title: '报名已关闭', message: `${state.eventsById[error.eventId]?.name ?? '该活动'} 暂不接受新报名。`, type: 'error' };
    case 'EVENT_FULL':
      return { id: 0, title: '活动已满员', message: `${state.eventsById[error.eventId]?.name ?? '该活动'} 已没有剩余名额。`, type: 'error' };
  }
}

function persistenceMessage(error: unknown): ToastMessage {
  const message = error instanceof PersistenceError && error.code === 'INVALID_STATE'
    ? '活动数据无效，请刷新页面后重试。'
    : '浏览器未能保存更改，请检查存储权限后重试。';
  return { id: 0, title: '更改未保存', message, type: 'error' };
}

function PlusIcon() {
  return <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" aria-hidden="true"><path d="M12 5v14M5 12h14" strokeLinecap="round" /></svg>;
}

function CloseIcon() {
  return <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" aria-hidden="true"><path d="m6 6 12 12M18 6 6 18" strokeLinecap="round" /></svg>;
}

function SaveState({ failed, children }: { failed: boolean; children: ReactNode }) {
  return <div className={`save-state${failed ? ' save-state-error' : ''}`}><span className="save-dot" />{failed ? '更改未保存' : children}</div>;
}

type CreateSubmitResult = CreateEventError | 'PERSISTENCE_FAILED' | null;

interface CreateFormProps {
  onCreate: (name: string, capacity: number, open: boolean) => CreateSubmitResult;
}

function CreateForm({ onCreate }: CreateFormProps) {
  const nameErrorId = useId();
  const capacityErrorId = useId();
  const [name, setName] = useState('');
  const [capacity, setCapacity] = useState('');
  const [open, setOpen] = useState(true);
  const [errors, setErrors] = useState<{ name?: string; capacity?: string }>({});

  function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const result = onCreate(name, Number(capacity), open);
    if (result !== null && result !== 'PERSISTENCE_FAILED' && result.code === 'NAME_REQUIRED') {
      setErrors({ name: '请填写活动名称。' });
      return;
    }
    if (result !== null && result !== 'PERSISTENCE_FAILED' && result.code === 'INVALID_CAPACITY') {
      setErrors({ capacity: '容量必须是大于 0 的整数。' });
      return;
    }
    if (result === null) {
      setName('');
      setCapacity('');
      setOpen(true);
      setErrors({});
    }
  }

  return (
    <section className="card card-pad" aria-labelledby="create-heading">
      <div className="card-head"><div><h2 id="create-heading">创建活动</h2><div className="card-kicker">创建后立即对成员可见</div></div></div>
      <form noValidate onSubmit={handleSubmit}>
        <div className="form-grid">
          <div className="field">
            <label htmlFor="event-name">活动名称</label>
            <input id="event-name" name="name" type="text" maxLength={40} placeholder="例如：周末桌游局" value={name} onChange={(event) => { setName(event.target.value); setErrors((current) => ({ ...current, name: undefined })); }} aria-describedby={nameErrorId} aria-invalid={Boolean(errors.name)} />
            <div className="field-error" id={nameErrorId} aria-live="polite">{errors.name}</div>
          </div>
          <div className="field">
            <label htmlFor="event-capacity">容量</label>
            <input id="event-capacity" name="capacity" type="number" min="1" step="1" inputMode="numeric" placeholder="2" value={capacity} onChange={(event) => { setCapacity(event.target.value); setErrors((current) => ({ ...current, capacity: undefined })); }} aria-describedby={capacityErrorId} aria-invalid={Boolean(errors.capacity)} />
            <div className="field-error" id={capacityErrorId} aria-live="polite">{errors.capacity}</div>
          </div>
          <fieldset className="field full fieldset-reset">
            <legend className="label">初始状态</legend>
            <div className="segmented">
              <label><input type="radio" name="status" checked={open} onChange={() => setOpen(true)} /><span className="choice">开放报名</span></label>
              <label><input type="radio" name="status" checked={!open} onChange={() => setOpen(false)} /><span className="choice">暂不开放</span></label>
            </div>
          </fieldset>
        </div>
        <div className="form-actions"><button className="btn btn-primary" type="submit"><PlusIcon />创建活动</button></div>
      </form>
    </section>
  );
}

function StatusBadge({ state }: { state: 'open' | 'full' | 'closed' }) {
  return <span className={`badge badge-${state}`}><span className="badge-dot" />{statusLabels[state]}</span>;
}

interface AdminEventCardProps {
  event: GatherEvent;
  state: AppState;
  onToggle: (id: EventId) => void;
  onRoster: (id: EventId, trigger: HTMLButtonElement) => void;
}

function AdminEventCard({ event, state, onToggle, onRoster }: AdminEventCardProps) {
  const count = getEventRegistrationCount(state, event.id);
  const roster = getEventRoster(state, event.id);
  const status = getEventCapacityStatus(state, event.id) ?? 'closed';
  const percent = Math.min(100, Math.round((count / event.capacity) * 100));
  return (
    <article className="admin-event">
      <div className="admin-event-top">
        <div><h3>{event.name}</h3><div className="meta-row"><span>编号 {event.id}</span><span>{count} / {event.capacity} 人</span></div></div>
        <StatusBadge state={status} />
      </div>
      <div className="progress" role="progressbar" aria-label={`已报名 ${count} 人，共 ${event.capacity} 个名额`} aria-valuemin={0} aria-valuemax={event.capacity} aria-valuenow={count}><span style={{ width: `${percent}%` }} /></div>
      <div className="admin-event-bottom">
        <div className="roster">{roster.length ? roster.map((userId) => <span className="avatar" title={userId} key={userId}>{userId}</span>) : <span className="empty-inline">暂无报名</span>}</div>
        <div className="admin-actions">
          <button className="btn btn-secondary" type="button" onClick={(clickEvent) => onRoster(event.id, clickEvent.currentTarget)}>查看名单</button>
          <button className="btn btn-secondary" type="button" onClick={() => onToggle(event.id)}>{event.open ? '关闭报名' : '开放报名'}</button>
        </div>
      </div>
    </article>
  );
}

interface AdminViewProps {
  state: AppState;
  saveFailed: boolean;
  onCreate: CreateFormProps['onCreate'];
  onToggle: (id: EventId) => void;
  onRoster: AdminEventCardProps['onRoster'];
}

function AdminView({ state, saveFailed, onCreate, onToggle, onRoster }: AdminViewProps) {
  const events = selectEvents(state);
  const openCount = events.filter((event) => event.open).length;
  const registrationCount = Object.values(state.registrationsByUserId)
    .reduce((total, eventIds) => total + (eventIds?.length ?? 0), 0);
  const availableCount = events.reduce((total, event) => total + (event.open ? getRemainingCapacity(state, event.id) : 0), 0);
  return (
    <section className="page">
      <div className="page-heading">
        <div><p className="eyebrow">活动管理</p><h1>把活动安排好，报名自然发生</h1><p className="lede">创建活动、控制开放状态，并在同一处查看容量与报名名单。</p></div>
        <SaveState failed={saveFailed}>已保存到此浏览器</SaveState>
      </div>
      <div className="layout">
        <div className="stack">
          <CreateForm onCreate={onCreate} />
          <section className="card card-pad" aria-labelledby="manage-heading">
            <div className="card-head"><div><h2 id="manage-heading">全部活动</h2><div className="card-kicker">共 {events.length} 场活动</div></div></div>
            <div className="event-list">{events.length ? events.map((event) => <AdminEventCard key={event.id} event={event} state={state} onToggle={onToggle} onRoster={onRoster} />) : <div className="empty-state">还没有活动，请先创建一场活动。</div>}</div>
          </section>
        </div>
        <aside className="stack">
          <section className="card card-pad">
            <div className="card-head"><h2>报名概览</h2></div>
            <div className="summary-grid">
              <div className="metric"><strong>{openCount}</strong><span>开放活动</span></div>
              <div className="metric"><strong>{registrationCount}</strong><span>成功报名</span></div>
              <div className="metric"><strong>{availableCount}</strong><span>剩余名额</span></div>
              <div className="metric"><strong>{USER_IDS.length}</strong><span>模拟成员</span></div>
            </div>
          </section>
        </aside>
      </div>
    </section>
  );
}

function memberFeedback(state: AppState, event: GatherEvent, selectedUser: UserId | null) {
  if (!selectedUser) return { text: '选择身份后即可查看报名资格。', button: '选择身份', available: false };
  if (isUserRegisteredForEvent(state, selectedUser, event.id)) return {
    text: `你已报名 ${event.name}，无需重复提交。`,
    button: '已报名',
    available: false,
  };
  const status = getEventCapacityStatus(state, event.id);
  if (status === 'closed') return { text: '管理员尚未开放这场活动。', button: '报名已关闭', available: false };
  if (status === 'full') return { text: '名额已用完，首版不提供候补。', button: '活动已满员', available: false };
  return { text: `还有 ${getRemainingCapacity(state, event.id)} 个名额，现在可以报名。`, button: '立即报名', available: true };
}

function MemberEventCard({ event, state, selectedUser, onRegister }: { event: GatherEvent; state: AppState; selectedUser: UserId | null; onRegister: (eventId: EventId) => void }) {
  const count = getEventRegistrationCount(state, event.id);
  const status = getEventCapacityStatus(state, event.id) ?? 'closed';
  const feedback = memberFeedback(state, event, selectedUser);
  return (
    <article className="card event-card">
      <div className="event-card-head"><div><div className="event-index">{event.id}</div><h2>{eventDisplayName(event)}</h2></div><StatusBadge state={status} /></div>
      {event.capacity <= 20 ? (
        <div className="seat-visual" aria-hidden="true">{Array.from({ length: event.capacity }, (_, index) => <span className={`seat${index < count ? ' filled' : ''}`} key={index} />)}</div>
      ) : (
        <div className="progress" aria-hidden="true"><span style={{ width: `${(count / event.capacity) * 100}%` }} /></div>
      )}
      <div className="event-count">{count} / {event.capacity} 人已报名</div>
      <div className="event-feedback">{feedback.text}</div>
      <button className={`btn ${feedback.available ? 'btn-primary' : 'btn-secondary'} btn-wide`} type="button" onClick={() => onRegister(event.id)}>{feedback.button}</button>
    </article>
  );
}

function MemberView({ state, saveFailed, selectedUser, onSelectUser, onRegister }: { state: AppState; saveFailed: boolean; selectedUser: UserId | null; onSelectUser: (userId: UserId) => void; onRegister: (eventId: EventId) => void }) {
  const events = selectEvents(state);
  const registrations = selectedUser ? selectRegistrationsForUser(state, selectedUser) : [];
  return (
    <section className="page">
      <div className="page-heading">
        <div><p className="eyebrow">成员报名</p><h1>选择身份，参加活动</h1><p className="lede">每个身份可报名多场活动，同一场活动不可重复报名。身份切换不会清空已有报名。</p></div>
        <SaveState failed={saveFailed}>刷新后状态仍保留</SaveState>
      </div>
      <section className="identity-panel" aria-labelledby="identity-heading">
        <div><h2 id="identity-heading">模拟身份</h2><div className="identity-options" role="group" aria-label="选择模拟身份">{USER_IDS.map((userId) => <button className={`identity-btn${selectedUser === userId ? ' active' : ''}`} type="button" aria-pressed={selectedUser === userId} onClick={() => onSelectUser(userId)} key={userId}>{userId}</button>)}</div></div>
        <div className={`identity-status${registrations.length ? ' registered' : ''}`} aria-live="polite">
          {!selectedUser ? <><strong>尚未选择身份</strong>请选择 U1、U2 或 U3 后报名。</> : registrations.length ? <><strong>{selectedUser} 已报名 {registrations.length} 场</strong>{registrations.map((event) => event.name).join('、')}；仍可报名其他符合条件的活动。</> : <><strong>{selectedUser} 可以报名</strong>请选择一场开放且有余位的活动。</>}
        </div>
      </section>
      <div className="member-grid">{events.length ? events.map((event) => <MemberEventCard event={event} state={state} selectedUser={selectedUser} onRegister={onRegister} key={event.id} />) : <div className="card empty-state member-empty">暂时没有可报名的活动。</div>}</div>
    </section>
  );
}

function RosterModal({ event, state, onClose }: { event: GatherEvent; state: AppState; onClose: () => void }) {
  const closeButton = useRef<HTMLButtonElement>(null);
  const modal = useRef<HTMLElement>(null);
  const roster = getEventRoster(state, event.id);
  useEffect(() => {
    closeButton.current?.focus();
    function handleKeyDown(keyEvent: KeyboardEvent) {
      if (keyEvent.key === 'Escape') onClose();
      if (keyEvent.key === 'Tab' && modal.current) {
        const controls = modal.current.querySelectorAll<HTMLElement>('button, [href], input, select, textarea, [tabindex]:not([tabindex="-1"])');
        if (controls.length === 0) return;
        const first = controls[0];
        const last = controls[controls.length - 1];
        if (keyEvent.shiftKey && document.activeElement === first) { keyEvent.preventDefault(); last.focus(); }
        else if (!keyEvent.shiftKey && document.activeElement === last) { keyEvent.preventDefault(); first.focus(); }
      }
    }
    document.addEventListener('keydown', handleKeyDown);
    return () => document.removeEventListener('keydown', handleKeyDown);
  }, [onClose]);
  return (
    <div className="modal-backdrop" role="presentation" onMouseDown={(mouseEvent) => { if (mouseEvent.target === mouseEvent.currentTarget) onClose(); }}>
      <section className="modal" role="dialog" aria-modal="true" aria-labelledby="roster-title" ref={modal}>
        <div className="modal-head"><div><p className="eyebrow">报名名单</p><h2 id="roster-title">{event.name}</h2></div><button className="icon-btn" type="button" aria-label="关闭名单" onClick={onClose} ref={closeButton}><CloseIcon /></button></div>
        <div className="roster-list">{roster.length ? roster.map((userId) => <div className="roster-row" key={userId}><span className="avatar">{userId}</span><strong>{userId}</strong></div>) : <div className="modal-empty">暂时还没有成员报名。</div>}</div>
      </section>
    </div>
  );
}

function ToastRegion({ toasts }: { toasts: ToastMessage[] }) {
  return <div className="toast-region" aria-live="polite" aria-atomic="true">{toasts.map((toast) => <div className={`toast ${toast.type}`} key={toast.id}><span className="toast-mark" /><div><strong>{toast.title}</strong><p>{toast.message}</p></div></div>)}</div>;
}

export function App({ repository: suppliedRepository }: AppProps) {
  const repositoryRef = useRef<StateRepository>(suppliedRepository ?? new LocalStorageRepository());
  const [state, setState] = useState<AppState>(() => repositoryRef.current.load());
  const [view, setView] = useState<'admin' | 'member'>('admin');
  const [selectedUser, setSelectedUser] = useState<UserId | null>(null);
  const [rosterEventId, setRosterEventId] = useState<EventId | null>(null);
  const [toasts, setToasts] = useState<ToastMessage[]>([]);
  const [saveFailed, setSaveFailed] = useState(false);
  const [telemetryFailed, setTelemetryFailed] = useState(false);
  const toastId = useRef(0);
  const rosterTrigger = useRef<HTMLButtonElement | null>(null);

  function showToast(toast: Omit<ToastMessage, 'id'> | ToastMessage) {
    const id = ++toastId.current;
    setToasts((current) => [...current, { ...toast, id }]);
    window.setTimeout(() => setToasts((current) => current.filter((item) => item.id !== id)), 3600);
  }

  function track(input: Parameters<typeof recordEvent>[0]) {
    try { recordEvent(input); }
    catch { setTelemetryFailed(true); }
  }

  function commit(candidate: AppState): boolean {
    try {
      repositoryRef.current.save(candidate);
      setState(candidate);
      setSaveFailed(false);
      return true;
    } catch (error) {
      setSaveFailed(true);
      showToast(persistenceMessage(error));
      return false;
    }
  }

  function handleCreate(name: string, capacity: number, open: boolean): CreateSubmitResult {
    const result = createEvent(state, { name, capacity, open });
    if (!result.ok) {
      showToast({ id: 0, title: '活动未创建', message: result.error.code === 'NAME_REQUIRED' ? '请填写活动名称后再提交。' : '容量必须是大于 0 的整数。', type: 'error' });
      return result.error;
    }
    if (!commit(result.state)) return 'PERSISTENCE_FAILED';
    showToast({ id: 0, title: '活动已创建', message: `${result.value.id} 已对成员可见。`, type: 'success' });
    return null;
  }

  function handleToggle(eventId: EventId) {
    const result = toggleEventOpen(state, eventId);
    if (!result.ok) {
      showToast({ id: 0, title: '状态未更改', message: '活动不存在，请刷新页面后重试。', type: 'error' });
      return;
    }
    if (!commit(result.state)) return;
    showToast({ id: 0, title: result.value.open ? '报名已开放' : '报名已关闭', message: `${result.value.name} 的既有名单保持不变。`, type: 'success' });
  }

  function handleRegister(eventId: EventId) {
    if (selectedUser) track({ mockUserId: selectedUser, activityId: eventId, kind: 'submit' });
    const result = registerForEvent(state, { eventId, userId: selectedUser });
    if (!result.ok) {
      if (selectedUser) track({ mockUserId: selectedUser, activityId: eventId, kind: 'result', outcome: 'rejected', reason: result.error.code });
      showToast(registrationErrorMessage(result.error, state));
      if (result.error.code === 'INVALID_USER') document.querySelector<HTMLButtonElement>('.identity-btn')?.focus();
      return;
    }
    if (!commit(result.state)) {
      if (selectedUser) track({ mockUserId: selectedUser, activityId: eventId, kind: 'result', outcome: 'rejected', reason: 'WRITE_FAILED' });
      return;
    }
    track({ mockUserId: result.value.userId, activityId: eventId, kind: 'result', outcome: 'success' });
    showToast({ id: 0, title: '报名成功', message: `${result.value.userId} 已报名 ${state.eventsById[eventId]?.name ?? '活动'}。`, type: 'success' });
  }

  function handleSelectUser(userId: UserId) {
    setSelectedUser(userId);
    if (view === 'member') for (const eventId of state.eventOrder) track({ mockUserId: userId, activityId: eventId, kind: 'view' });
    const registrations = selectRegistrationsForUser(state, userId);
    if (registrations.length) showToast({ id: 0, title: '已有报名', message: `${userId} 已报名 ${registrations.map((event) => event.name).join('、')}，仍可报名其他活动。`, type: 'success' });
  }

  function openRoster(eventId: EventId, trigger: HTMLButtonElement) {
    rosterTrigger.current = trigger;
    setRosterEventId(eventId);
  }

  function closeRoster() {
    setRosterEventId(null);
    window.setTimeout(() => rosterTrigger.current?.focus(), 0);
  }

  const rosterEvent = rosterEventId ? state.eventsById[rosterEventId] : undefined;
  return (
    <div className="shell">
      <header className="topbar">
        <div className="brand"><div className="brand-mark" aria-hidden="true">G</div><div><div className="brand-name">Gather</div><div className="brand-sub">社群活动报名</div></div></div>
        <nav className="view-switch" aria-label="切换使用视图">
          <button className={`view-tab${view === 'admin' ? ' active' : ''}`} type="button" aria-current={view === 'admin' ? 'page' : undefined} onClick={() => { setView('admin'); window.scrollTo({ top: 0, behavior: 'smooth' }); }}>管理员</button>
          <button className={`view-tab${view === 'member' ? ' active' : ''}`} type="button" aria-current={view === 'member' ? 'page' : undefined} onClick={() => { setView('member'); window.scrollTo({ top: 0, behavior: 'smooth' }); }}>成员报名</button>
        </nav>
      </header>
      <main>{view === 'admin' ? <AdminView state={state} saveFailed={saveFailed} onCreate={handleCreate} onToggle={handleToggle} onRoster={openRoster} /> : <MemberView state={state} saveFailed={saveFailed} selectedUser={selectedUser} onSelectUser={handleSelectUser} onRegister={handleRegister} />}</main>
      <ToastRegion toasts={toasts} />
      <div className="telemetry-export">
        <button type="button" onClick={() => { try { exportEvents(); } catch { setTelemetryFailed(true); } }}>导出本地体验事件</button>
        {telemetryFailed && <span role="status">体验事件未完整保存；报名结果不受影响。</span>}
      </div>
      {rosterEvent && <RosterModal event={rosterEvent} state={state} onClose={closeRoster} />}
    </div>
  );
}
