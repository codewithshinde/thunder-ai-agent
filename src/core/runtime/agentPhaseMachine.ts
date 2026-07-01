import { createMachine, createActor, type Actor } from 'xstate';

export type TaskPhase = 'analyze' | 'execute' | 'verify';

type PhaseEvent =
  | { type: 'ADVANCE_EXECUTE' }
  | { type: 'ADVANCE_VERIFY' }
  | { type: 'RESET' };

export const agentPhaseMachine = createMachine({
  id: 'agentPhase',
  initial: 'analyze' as TaskPhase,
  states: {
    analyze: {
      on: {
        ADVANCE_EXECUTE: 'execute',
        ADVANCE_VERIFY: 'verify',
        RESET: 'analyze',
      },
    },
    execute: {
      on: {
        ADVANCE_VERIFY: 'verify',
        RESET: 'analyze',
      },
    },
    verify: {
      on: {
        RESET: 'analyze',
      },
    },
  },
});

export type PhaseActor = Actor<typeof agentPhaseMachine>;

export function createPhaseActor(): PhaseActor {
  const actor = createActor(agentPhaseMachine);
  actor.start();
  return actor;
}

export function getPhaseFromActor(actor: PhaseActor): TaskPhase {
  return actor.getSnapshot().value as TaskPhase;
}

export function sendPhaseEvent(actor: PhaseActor, event: PhaseEvent): void {
  actor.send(event);
}
