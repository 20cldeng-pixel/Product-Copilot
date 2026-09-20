import { getEventRegistrationCount } from './selectors';
import {
  USER_IDS,
  type AppState,
  type CommandResult,
  type EventId,
  type GatherEvent,
  type Registration,
  type UserId,
} from './types';

export interface CreateEventInput {
  name: string;
  capacity: number;
  open: boolean;
}

export type CreateEventError =
  | { code: 'NAME_REQUIRED' }
  | { code: 'INVALID_CAPACITY' };

export type ToggleEventError = { code: 'EVENT_NOT_FOUND'; eventId: EventId };

export type RegistrationError =
  | { code: 'EVENT_NOT_FOUND'; eventId: EventId }
  | { code: 'INVALID_USER'; userId: unknown }
  | { code: 'ALREADY_REGISTERED'; userId: UserId; eventId: EventId }
  | { code: 'EVENT_CLOSED'; eventId: EventId }
  | { code: 'EVENT_FULL'; eventId: EventId };

function nextEventId(state: AppState): EventId {
  const highestId = Object.keys(state.eventsById).reduce((highest, id) => {
    const match = /^A(\d+)$/.exec(id);
    return match ? Math.max(highest, Number(match[1])) : highest;
  }, 0);
  return `A${highestId + 1}`;
}

export function createEvent(
  state: AppState,
  input: CreateEventInput,
): CommandResult<GatherEvent, CreateEventError> {
  const name = input.name.trim();
  if (!name) return { ok: false, state, error: { code: 'NAME_REQUIRED' } };
  if (!Number.isInteger(input.capacity) || input.capacity <= 0) {
    return { ok: false, state, error: { code: 'INVALID_CAPACITY' } };
  }

  const id = nextEventId(state);
  const event: GatherEvent = { id, name: `${id} · ${name}`, capacity: input.capacity, open: input.open };
  return {
    ok: true,
    state: {
      ...state,
      eventsById: { ...state.eventsById, [id]: event },
      eventOrder: [...state.eventOrder, id],
    },
    value: event,
  };
}

export function toggleEventOpen(
  state: AppState,
  eventId: EventId,
): CommandResult<GatherEvent, ToggleEventError> {
  const event = state.eventsById[eventId];
  if (!event) return { ok: false, state, error: { code: 'EVENT_NOT_FOUND', eventId } };

  const updatedEvent = { ...event, open: !event.open };
  return {
    ok: true,
    state: { ...state, eventsById: { ...state.eventsById, [eventId]: updatedEvent } },
    value: updatedEvent,
  };
}

export interface RegisterForEventInput {
  eventId: EventId;
  userId: UserId | string | null | undefined;
}

export function registerForEvent(
  state: AppState,
  input: RegisterForEventInput,
): CommandResult<Registration, RegistrationError> {
  const event = state.eventsById[input.eventId];
  if (!event) {
    return { ok: false, state, error: { code: 'EVENT_NOT_FOUND', eventId: input.eventId } };
  }
  if (!USER_IDS.some((userId) => userId === input.userId)) {
    return { ok: false, state, error: { code: 'INVALID_USER', userId: input.userId } };
  }

  const userId = input.userId as UserId;
  const existingEventIds = state.registrationsByUserId[userId] ?? [];
  if (existingEventIds.includes(input.eventId)) {
    return {
      ok: false,
      state,
      error: { code: 'ALREADY_REGISTERED', userId, eventId: input.eventId },
    };
  }
  if (!event.open) {
    return { ok: false, state, error: { code: 'EVENT_CLOSED', eventId: input.eventId } };
  }
  if (getEventRegistrationCount(state, input.eventId) >= event.capacity) {
    return { ok: false, state, error: { code: 'EVENT_FULL', eventId: input.eventId } };
  }

  const registration = { userId, eventId: input.eventId };
  return {
    ok: true,
    state: {
      ...state,
      registrationsByUserId: {
        ...state.registrationsByUserId,
        [userId]: [...existingEventIds, input.eventId],
      },
    },
    value: registration,
  };
}

export const toggleEventStatus = toggleEventOpen;
export const register = registerForEvent;
