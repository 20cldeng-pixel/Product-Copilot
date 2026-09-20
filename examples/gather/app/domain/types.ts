export const USER_IDS = ['U1', 'U2', 'U3'] as const;

export type UserId = (typeof USER_IDS)[number];
export type EventId = string;

export interface GatherEvent {
  id: EventId;
  name: string;
  capacity: number;
  open: boolean;
}

export interface Registration {
  userId: UserId;
  eventId: EventId;
}

export interface AppState {
  eventsById: Record<EventId, GatherEvent>;
  eventOrder: EventId[];
  registrationsByUserId: Partial<Record<UserId, EventId[]>>;
}

export type CommandSuccess<Value> = {
  ok: true;
  state: AppState;
  value: Value;
};

export type CommandFailure<Error> = {
  ok: false;
  state: AppState;
  error: Error;
};

export type CommandResult<Value, Error> = CommandSuccess<Value> | CommandFailure<Error>;
