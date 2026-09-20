import { describe, expect, it } from 'vitest';
import {
  createEvent,
  createInitialState,
  getEventCapacityStatus,
  getEventRegistrationCount,
  getEventRoster,
  getRemainingCapacity,
  registerForEvent,
  selectRegistrationsForUser,
  toggleEventOpen,
} from './index';

describe('领域状态与 selectors', () => {
  it('fixture 使用用户到活动列表的规范化索引且统计只从状态派生', () => {
    const state = createInitialState();

    expect(state.registrationsByUserId).toEqual({ U2: ['A2'], U3: ['A2'] });
    expect(getEventRoster(state, 'A2')).toEqual(['U2', 'U3']);
    expect(getEventRegistrationCount(state, 'A2')).toBe(2);
    expect(getRemainingCapacity(state, 'A2')).toBe(0);
    expect(getEventCapacityStatus(state, 'A2')).toBe('full');
    expect(selectRegistrationsForUser(state, 'U2').map((event) => event.id)).toEqual(['A2']);
    expect(state.eventsById.A2).not.toHaveProperty('registrationCount');
    expect(state.eventsById.A2).not.toHaveProperty('remainingCapacity');
    expect(state.eventsById.A2).not.toHaveProperty('full');
  });
});

describe('集中纯函数命令', () => {
  it('创建活动并保持输入状态不变', () => {
    const state = createInitialState();
    const result = createEvent(state, { name: '  新活动  ', capacity: 3, open: true });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.id).toBe('A4');
    expect(result.value.name).toBe('A4 · 新活动');
    expect(result.state.eventOrder).toEqual([...state.eventOrder, 'A4']);
    expect(state.eventsById.A4).toBeUndefined();
  });

  it('创建失败返回原状态引用与结构化错误', () => {
    const state = createInitialState();
    const noName = createEvent(state, { name: ' ', capacity: 0, open: true });
    const badCapacity = createEvent(state, { name: '活动', capacity: 1.5, open: true });

    expect(noName).toEqual({ ok: false, state, error: { code: 'NAME_REQUIRED' } });
    expect(badCapacity).toEqual({ ok: false, state, error: { code: 'INVALID_CAPACITY' } });
  });

  it('切换活动状态且失败不修改状态', () => {
    const state = createInitialState();
    const changed = toggleEventOpen(state, 'A1');
    const missing = toggleEventOpen(state, 'missing');

    expect(changed.ok && changed.value.open).toBe(false);
    expect(changed.ok && changed.state.eventsById.A1.open).toBe(false);
    expect(state.eventsById.A1.open).toBe(true);
    expect(missing).toEqual({ ok: false, state, error: { code: 'EVENT_NOT_FOUND', eventId: 'missing' } });
  });

  it('关闭活动只改变开放状态并完整保留既有报名名单', () => {
    const state = createInitialState();
    const changed = toggleEventOpen(state, 'A2');

    expect(changed.ok).toBe(true);
    if (!changed.ok) return;
    expect(changed.state.eventsById.A2.open).toBe(false);
    expect(getEventRoster(changed.state, 'A2')).toEqual(['U2', 'U3']);
    expect(getEventRegistrationCount(changed.state, 'A2')).toBe(2);
    expect(changed.state.registrationsByUserId).toEqual(state.registrationsByUserId);
  });

  it('同一用户可报名不同活动，但同一活动只能报名一次', () => {
    const state = createInitialState();
    const first = registerForEvent(state, { eventId: 'A1', userId: 'U2' });

    expect(first.ok).toBe(true);
    if (!first.ok) return;
    expect(first.state.registrationsByUserId.U2).toEqual(['A2', 'A1']);
    expect(state.registrationsByUserId.U2).toEqual(['A2']);

    const duplicate = registerForEvent(first.state, { eventId: 'A1', userId: 'U2' });
    expect(duplicate).toEqual({
      ok: false,
      state: first.state,
      error: { code: 'ALREADY_REGISTERED', userId: 'U2', eventId: 'A1' },
    });
    expect(getEventRegistrationCount(first.state, 'A1')).toBe(1);
    expect(getEventRegistrationCount(first.state, 'A2')).toBe(2);
  });

  it('锁定报名错误优先级：活动不存在最优先', () => {
    const state = createInitialState();
    expect(registerForEvent(state, { eventId: 'missing', userId: null })).toEqual({
      ok: false,
      state,
      error: { code: 'EVENT_NOT_FOUND', eventId: 'missing' },
    });
  });

  it('锁定报名错误优先级：身份、当前活动重复、关闭、满员依次判断', () => {
    const initial = createInitialState();
    const state = { ...initial, registrationsByUserId: { ...initial.registrationsByUserId, U1: ['A3'] } };

    const errorCode = (eventId: string, userId: string | null) => {
      const result = registerForEvent(state, { eventId, userId });
      return result.ok ? undefined : result.error.code;
    };

    expect(errorCode('A3', null)).toBe('INVALID_USER');
    expect(errorCode('A3', 'U1')).toBe('ALREADY_REGISTERED');
    expect(errorCode('A3', 'U2')).toBe('EVENT_CLOSED');
    expect(errorCode('A2', 'U1')).toBe('EVENT_FULL');
  });

  it('同一活动关闭且满员时优先返回 EVENT_CLOSED', () => {
    const initialState = createInitialState();
    const state = {
      ...initialState,
      eventsById: {
        ...initialState.eventsById,
        A2: { ...initialState.eventsById.A2, open: false },
      },
    };

    expect(registerForEvent(state, { eventId: 'A2', userId: 'U1' })).toEqual({
      ok: false,
      state,
      error: { code: 'EVENT_CLOSED', eventId: 'A2' },
    });
  });
});
