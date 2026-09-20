import type { AppState } from './types';

export function createInitialState(): AppState {
  return {
    eventsById: {
      A1: { id: 'A1', name: 'A1 · 社群早餐会', capacity: 2, open: true },
      A2: { id: 'A2', name: 'A2 · 产品交流夜', capacity: 2, open: true },
      A3: { id: 'A3', name: 'A3 · 周末工作坊', capacity: 2, open: false },
    },
    eventOrder: ['A1', 'A2', 'A3'],
    registrationsByUserId: { U2: ['A2'], U3: ['A2'] },
  };
}

export const initialState = createInitialState();
