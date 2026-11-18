import type { Rng } from '../core/mathx';
import type { BallEnv } from '../physics/ball';
import type { Athlete } from './athlete';
import type { BallEntity, TouchKind } from './ballEntity';
import type { ContactSystem } from './contact';

/**
 * What a brain may use of the game: the clock, the random stream, the ball, the net, the contact
 * system and the other athletes. A brain is handed this and never the game itself, so it cannot
 * reach the HUD, the camera or the user's input (docs/adr/0010). What a brain has to tell the
 * player goes out through a callback its drill listens to (`TeamAI.onRead`, `TeamAI.onUserSet`).
 *
 * Both sides of the seam are declared here, in the simulation: the game runs brains and knows
 * nothing of `src/ai`, and `src/ai` implements `Brain` against `AiHost`.
 */
export interface AiHost {
  /** simulation time (s) */
  readonly simTime: number;
  /** the simulation's one random stream */
  readonly rng: Rng;
  readonly ball: BallEntity;
  readonly env: BallEnv;
  readonly contact: ContactSystem;
  readonly athletes: readonly Athlete[];
  /** rally modes: is the ball in play */
  readonly ballLive: boolean;
  /** give an athlete its brain (a team adding a player) */
  setBrain(a: Athlete, b: Brain): void;
  /** a touch the brain made without the contact system (the AI setter's set) */
  onAiContact(a: Athlete, kind: TouchKind, speed: number): void;
}

/** An AI controller for one athlete. */
export interface Brain {
  athlete: Athlete;
  step(dt: number, g: AiHost): void;
  /** optional reset at the start of a rally / rep */
  reset?(g: AiHost): void;
}
