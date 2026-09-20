import { USER_IDS, type AppState, type EventId, type GatherEvent, type Registration, type UserId } from './types';

export type EventCapacityStatus = 'open' | 'full' | 'closed';

export function selectEvents(state: AppState): GatherEvent[] {
  return state.eventOrder.map((eventId) => state.eventsById[eventId]).filter((event) => event !== undefined);
}

export function selectEventById(state: AppState, eventId: EventId): GatherEvent | undefined {
  return state.eventsById[eventId];
}

export function getEventRoster(state: AppState, eventId: EventId): UserId[] {
  return USER_IDS.filter((userId) => state.registrationsByUserId[userId]?.includes(eventId));
}

export function getEventRegistrationCount(state: AppState, eventId: EventId): number {
  return getEventRoster(state, eventId).length;
}

export function getRemainingCapacity(state: AppState, eventId: EventId): number {
  const event = selectEventById(state, eventId);
  return event ? Math.max(0, event.capacity - getEventRegistrationCount(state, eventId)) : 0;
}

export function isEventFull(state: AppState, eventId: EventId): boolean {
  const event = selectEventById(state, eventId);
  return event !== undefined && getEventRegistrationCount(state, eventId) >= event.capacity;
}

export function getEventCapacityStatus(state: AppState, eventId: EventId): EventCapacityStatus | undefined {
  const event = selectEventById(state, eventId);
  if (!event) return undefined;
  if (!event.open) return 'closed';
  return isEventFull(state, eventId) ? 'full' : 'open';
}

export function isUserRegisteredForEvent(state: AppState, userId: UserId, eventId: EventId): boolean {
  return state.registrationsByUserId[userId]?.includes(eventId) ?? false;
}

export function selectRegistrationsForUser(state: AppState, userId: UserId): GatherEvent[] {
  return (state.registrationsByUserId[userId] ?? [])
    .map((eventId) => state.eventsById[eventId])
    .filter((event) => event !== undefined);
}

export function selectRegistrationRecords(state: AppState, userId: UserId): Registration[] {
  return (state.registrationsByUserId[userId] ?? []).map((eventId) => ({ userId, eventId }));
}

export const selectEventRoster = getEventRoster;
export const selectEventRegistrationCount = getEventRegistrationCount;
export const selectRemainingCapacity = getRemainingCapacity;
export const selectIsEventFull = isEventFull;
export const selectEventStatus = getEventCapacityStatus;
