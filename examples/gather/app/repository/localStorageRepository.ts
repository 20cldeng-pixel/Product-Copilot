import { createInitialState, USER_IDS, type AppState, type EventId, type GatherEvent, type UserId } from '../domain';

export const CURRENT_SCHEMA_VERSION = 2;
export const DEFAULT_STORAGE_KEY = 'gather-app-state';

export interface StorageAdapter {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

export interface StateRepository {
  load(): AppState;
  save(state: AppState): void;
}

interface StoredSnapshot {
  schemaVersion: typeof CURRENT_SCHEMA_VERSION;
  state: AppState;
}

interface V1AppState {
  eventsById: Record<EventId, GatherEvent>;
  eventOrder: EventId[];
  registrationsByUserId: Partial<Record<UserId, EventId>>;
}

interface V1StoredSnapshot {
  schemaVersion: 1;
  state: V1AppState;
}

export type PersistenceErrorCode = 'INVALID_STATE' | 'WRITE_FAILED';

export class PersistenceError extends Error {
  readonly name = 'PersistenceError';

  constructor(
    readonly code: PersistenceErrorCode,
    message: string,
    options?: ErrorOptions,
  ) {
    super(message, options);
  }
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function hasOnlyKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  const actualKeys = Object.keys(value);
  return actualKeys.length === keys.length && actualKeys.every((key) => keys.includes(key));
}

function isGatherEvent(value: unknown, expectedId: string): value is GatherEvent {
  if (!isPlainRecord(value) || !hasOnlyKeys(value, ['id', 'name', 'capacity', 'open'])) return false;
  return (
    value.id === expectedId &&
    typeof value.id === 'string' &&
    value.id.length > 0 &&
    typeof value.name === 'string' &&
    value.name.trim().length > 0 &&
    typeof value.capacity === 'number' &&
    Number.isInteger(value.capacity) &&
    value.capacity > 0 &&
    typeof value.open === 'boolean'
  );
}

function hasValidEventState(value: Record<string, unknown>): boolean {
  if (
    !hasOnlyKeys(value, ['eventsById', 'eventOrder', 'registrationsByUserId']) ||
    !isPlainRecord(value.eventsById) ||
    !Array.isArray(value.eventOrder) ||
    !isPlainRecord(value.registrationsByUserId)
  ) {
    return false;
  }

  const eventIds = Object.keys(value.eventsById);
  return (
    eventIds.every((eventId) => isGatherEvent((value.eventsById as Record<string, unknown>)[eventId], eventId)) &&
    value.eventOrder.every((eventId): eventId is string => typeof eventId === 'string') &&
    new Set(value.eventOrder).size === value.eventOrder.length &&
    value.eventOrder.length === eventIds.length &&
    value.eventOrder.every((eventId) => Object.hasOwn(value.eventsById as object, eventId))
  );
}

export function isValidAppState(value: unknown): value is AppState {
  if (!isPlainRecord(value) || !hasValidEventState(value)) return false;

  const eventsById = value.eventsById as Record<string, GatherEvent>;
  const registrationEntries = Object.entries(value.registrationsByUserId as Record<string, unknown>);
  const countsByEventId = new Map<string, number>();

  for (const [userId, eventIds] of registrationEntries) {
    if (!USER_IDS.some((validUserId) => validUserId === userId) || !Array.isArray(eventIds)) return false;
    if (!eventIds.every((eventId) => typeof eventId === 'string' && Object.hasOwn(eventsById, eventId))) return false;
    if (new Set(eventIds).size !== eventIds.length) return false;

    for (const eventId of eventIds as string[]) {
      const count = (countsByEventId.get(eventId) ?? 0) + 1;
      if (count > eventsById[eventId].capacity) return false;
      countsByEventId.set(eventId, count);
    }
  }

  return true;
}

function isValidV1AppState(value: unknown): value is V1AppState {
  if (!isPlainRecord(value) || !hasValidEventState(value)) return false;

  const eventsById = value.eventsById as Record<string, GatherEvent>;
  const registrationEntries = Object.entries(value.registrationsByUserId as Record<string, unknown>);
  const countsByEventId = new Map<string, number>();
  for (const [userId, eventId] of registrationEntries) {
    if (
      !USER_IDS.some((validUserId) => validUserId === userId) ||
      typeof eventId !== 'string' ||
      !Object.hasOwn(eventsById, eventId)
    ) {
      return false;
    }
    const count = (countsByEventId.get(eventId) ?? 0) + 1;
    if (count > eventsById[eventId].capacity) return false;
    countsByEventId.set(eventId, count);
  }
  return true;
}

export function isValidSnapshot(value: unknown): value is StoredSnapshot {
  return (
    isPlainRecord(value) &&
    hasOnlyKeys(value, ['schemaVersion', 'state']) &&
    value.schemaVersion === CURRENT_SCHEMA_VERSION &&
    isValidAppState(value.state)
  );
}

function isValidV1Snapshot(value: unknown): value is V1StoredSnapshot {
  return (
    isPlainRecord(value) &&
    hasOnlyKeys(value, ['schemaVersion', 'state']) &&
    value.schemaVersion === 1 &&
    isValidV1AppState(value.state)
  );
}

function migrateV1State(state: V1AppState): AppState {
  return {
    ...state,
    registrationsByUserId: Object.fromEntries(
      Object.entries(state.registrationsByUserId).map(([userId, eventId]) => [userId, [eventId]]),
    ),
  };
}

export class LocalStorageRepository implements StateRepository {
  constructor(
    private readonly storage: StorageAdapter = globalThis.localStorage,
    private readonly storageKey = DEFAULT_STORAGE_KEY,
  ) {}

  load(): AppState {
    let snapshot: unknown;
    try {
      const serialized = this.storage.getItem(this.storageKey);
      if (serialized === null) return this.recoverInitialState();
      snapshot = JSON.parse(serialized);
    } catch {
      return this.recoverInitialState();
    }

    if (isValidSnapshot(snapshot)) return snapshot.state;
    if (isValidV1Snapshot(snapshot)) {
      const migratedState = migrateV1State(snapshot.state);
      try {
        this.save(migratedState);
      } catch {
        return migratedState;
      }
      return migratedState;
    }
    return this.recoverInitialState();
  }

  save(state: AppState): void {
    if (!isValidAppState(state)) {
      throw new PersistenceError('INVALID_STATE', '拒绝保存无效的应用状态。');
    }

    const snapshot: StoredSnapshot = { schemaVersion: CURRENT_SCHEMA_VERSION, state };
    try {
      this.storage.setItem(this.storageKey, JSON.stringify(snapshot));
    } catch (cause) {
      throw new PersistenceError('WRITE_FAILED', '无法将应用状态保存到本地存储。', { cause });
    }
  }

  private recoverInitialState(): AppState {
    const initialState = createInitialState();
    try {
      this.save(initialState);
    } catch {
      return initialState;
    }
    return initialState;
  }
}
