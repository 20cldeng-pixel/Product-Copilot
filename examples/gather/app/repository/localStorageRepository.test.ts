import { describe, expect, it, vi } from 'vitest';
import { createInitialState } from '../domain';
import {
  CURRENT_SCHEMA_VERSION,
  LocalStorageRepository,
  PersistenceError,
  type StorageAdapter,
} from './localStorageRepository';

class MemoryStorage implements StorageAdapter {
  value: string | null = null;
  getItem = vi.fn(() => this.value);
  setItem = vi.fn((_key: string, value: string) => {
    this.value = value;
  });
}

describe('LocalStorageRepository', () => {
  it('保存并完整恢复带版本的快照', () => {
    const storage = new MemoryStorage();
    const repository = new LocalStorageRepository(storage);
    const state = createInitialState();

    repository.save(state);

    expect(JSON.parse(storage.value ?? '')).toEqual({ schemaVersion: CURRENT_SCHEMA_VERSION, state });
    expect(repository.load()).toEqual(state);
  });

  it('将有效 V1 单活动报名全部迁移到 V2 并回写', () => {
    const storage = new MemoryStorage();
    const state = createInitialState();
    const v1State = { ...state, registrationsByUserId: { U1: 'A1', U2: 'A2', U3: 'A2' } };
    storage.value = JSON.stringify({ schemaVersion: 1, state: v1State });

    const loaded = new LocalStorageRepository(storage).load();

    expect(loaded.eventsById).toEqual(v1State.eventsById);
    expect(loaded.eventOrder).toEqual(v1State.eventOrder);
    expect(loaded.registrationsByUserId).toEqual({ U1: ['A1'], U2: ['A2'], U3: ['A2'] });
    expect(JSON.parse(storage.value ?? '')).toEqual({ schemaVersion: CURRENT_SCHEMA_VERSION, state: loaded });
  });

  it('V1 迁移回写失败时仍返回完整迁移数据而不重置', () => {
    const storage = new MemoryStorage();
    const state = createInitialState();
    storage.value = JSON.stringify({
      schemaVersion: 1,
      state: { ...state, registrationsByUserId: { U1: 'A1', U2: 'A2' } },
    });
    storage.setItem.mockImplementation(() => {
      throw new Error('quota');
    });

    expect(new LocalStorageRepository(storage).load().registrationsByUserId).toEqual({
      U1: ['A1'],
      U2: ['A2'],
    });
  });

  it.each([
    '{bad json',
    JSON.stringify({ schemaVersion: 999, state: createInitialState() }),
    JSON.stringify({ schemaVersion: CURRENT_SCHEMA_VERSION, state: { ...createInitialState(), eventOrder: ['A1'] } }),
    JSON.stringify({
      schemaVersion: CURRENT_SCHEMA_VERSION,
      state: { ...createInitialState(), registrationsByUserId: { U1: ['missing'] } },
    }),
    JSON.stringify({
      schemaVersion: CURRENT_SCHEMA_VERSION,
      state: { ...createInitialState(), registrationsByUserId: { U1: ['A1', 'A1'] } },
    }),
    JSON.stringify({
      schemaVersion: CURRENT_SCHEMA_VERSION,
      state: { ...createInitialState(), registrationsByUserId: { U1: ['A1'], U2: ['A1'], U3: ['A1'] } },
    }),
  ])('损坏快照回退到全新初始数据并修复存储：%s', (corruptValue) => {
    const storage = new MemoryStorage();
    storage.value = corruptValue;
    const repository = new LocalStorageRepository(storage);

    const loaded = repository.load();

    expect(loaded).toEqual(createInitialState());
    expect(JSON.parse(storage.value ?? '')).toEqual({
      schemaVersion: CURRENT_SCHEMA_VERSION,
      state: createInitialState(),
    });
  });

  it('修复损坏快照写入失败时仍安全返回初始数据', () => {
    const storage = new MemoryStorage();
    storage.value = 'invalid';
    storage.setItem.mockImplementation(() => {
      throw new Error('quota');
    });

    expect(new LocalStorageRepository(storage).load()).toEqual(createInitialState());
  });

  it('正常写入失败抛出可识别错误且不吞掉原始原因', () => {
    const storage = new MemoryStorage();
    const cause = new Error('quota');
    storage.setItem.mockImplementation(() => {
      throw cause;
    });

    expect(() => new LocalStorageRepository(storage).save(createInitialState())).toThrow(PersistenceError);
    try {
      new LocalStorageRepository(storage).save(createInitialState());
    } catch (error) {
      expect(error).toMatchObject({ code: 'WRITE_FAILED', cause });
    }
  });

  it('没有快照时返回初始数据并写入有效快照', () => {
    const storage = new MemoryStorage();
    const loaded = new LocalStorageRepository(storage).load();

    expect(loaded).toEqual(createInitialState());
    expect(storage.setItem).toHaveBeenCalledOnce();
  });
});
