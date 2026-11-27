import type { Athlete } from './athlete';
import type { TouchKind } from './ballEntity';
import type { ContactEvent } from './contact';
import type { Outcome } from './judge';

/**
 * What a game announces while it plays, by name. The simulation is where almost all of it happens;
 * the display (effects, sound, touch controls) only listens. It lives here, below both, so a
 * listener can name an event without importing the app that owns the emitter.
 */
export type GameEvents = {
  toggleCam: { fp: boolean };
  contact: ContactEvent;
  aiContact: { athlete: Athlete; kind: TouchKind; speed: number };
  outcome: Outcome;
  ballEvent: { kind: string; x: number; y: number; z: number; impact: number };
  /** a float serve has just broken (`BALL.float`): how hard, 0..1 */
  floatBreak: { strength: number };
  crowd: { amount: number; cheer: boolean };
  step: { athlete: Athlete; speed: number };
  land: { athlete: Athlete; impact: number };
  takeoff: { athlete: Athlete };
  /** a team-mate's call to the user (the setter's read of the pass: in system, high, help) */
  setterCall: { athlete: Athlete; call: 'in' | 'out' | 'help' };
  /** the referee's whistle for the next serve (the server has 8 s from it) */
  serveWhistle: { side: 1 | -1 };
  /** two hands meet between points: a clap, a five */
  hands: { athlete: Athlete; kind: 'clap' | 'five' };
};
