import * as THREE from 'three';
import { COURT, type SetLevel } from '../config';
import { Rng } from '../core/mathx';
import type { BallEnv, CollisionEvent } from '../physics/ball';
import type { Athlete } from './athlete';
import { BallEntity, type TouchKind } from './ballEntity';
import type { AiHost, Brain } from './brains';
import { ContactSystem, type ContactEvent, type SetOption } from './contact';
import { Judge, type Outcome } from './judge';
import { defaultPassTarget, defaultSetOptions } from './plays';
import type { SetPick } from './setterCalls';

/**
 * What the simulation asks of whoever runs it, and what it tells them. The answers come from
 * outside because they are not the simulation's to know: where the player is looking is the
 * camera's, how much the aim is helped is a setting.
 */
export interface SimulationHooks {
  /** how much this athlete's aim is helped (0..1) */
  aimAssist(a: Athlete): number;
  /** how much this athlete's set is helped (0..1); their aim assist when not given */
  setAssist?(a: Athlete): number;
  /** the player sets by feel, with no timing cues (a setting): their set's windows are wider */
  setByFeel?(): boolean;
  /** where this athlete is aiming on the floor */
  aimTargetFor(a: Athlete, out: THREE.Vector3): THREE.Vector3;
  /** which way the player is looking (rad) */
  userAimYaw(): number;
  /** a touch was resolved */
  contact(ev: ContactEvent): void;
  /** a touch a brain made without the contact system (the AI setter's set) */
  aiContact(a: Athlete, kind: TouchKind, speed: number): void;
  /** the ball hit the floor, the net, a post */
  ballEvent(e: CollisionEvent): void;
  /** a float has just broken, and how hard */
  floatBreak(strength: number): void;
  /** the judge called the rally */
  outcome(o: Outcome): void;
  /** how hard the player's set is to time (a setting; Easy without one) */
  setLevel?(): SetLevel;
  /** before the athletes move: the player's body goes up for a set by itself (Settings: Auto jump set) */
  userSetJump?(): void;
}

/** the drill being played, as the simulation sees it */
export interface SimDrill {
  step(dt: number): void;
  onOutcome(o: Outcome): void;
  passTarget?(a: Athlete): { x: number; y: number; z: number; apex: number };
  setOptions?(a: Athlete): SetOption[];
  /** the hitter the player picked for this set, if any */
  setPick?(a: Athlete): SetPick | null;
  canServe?(a: Athlete): boolean;
}

/**
 * The simulation: the athletes, the ball, the clock, the random stream, the brains, the contact
 * system and the judge, and the one step that moves them all. It has no renderer and no DOM, so it
 * can be built and stepped in a unit test (docs/adr/0010). `Game` holds one and draws it.
 */
export class Simulation implements AiHost {
  athletes: Athlete[] = [];
  /** the athlete the player controls */
  me!: Athlete;
  readonly ball = new BallEntity();
  readonly env: BallEnv = { netTop: COURT.netHeightMen };
  readonly rng = new Rng(2024);
  readonly brains = new Map<Athlete, Brain>();
  readonly contact: ContactSystem;
  readonly judge = new Judge();
  /** the player's held actions (a pass, a set, a block waiting on its moment), stepped between the athletes and the contacts */
  actions: { step(dt: number): void } | null = null;
  drill: SimDrill | null = null;
  simTime = 0;
  /** rally modes: is the ball in play (AI teams read this) */
  ballLive = false;

  constructor(private hooks: SimulationHooks) {
    // eslint-disable-next-line @typescript-eslint/no-this-alias
    const sim = this;
    this.contact = new ContactSystem({
      ball: this.ball,
      get simTime() {
        return sim.simTime;
      },
      env: this.env,
      aimAssist: (a) => hooks.aimAssist(a),
      setAssist: (a) => (hooks.setAssist ?? hooks.aimAssist)(a),
      setByFeel: () => hooks.setByFeel?.() ?? false,
      aimTargetFor: (a, out) => hooks.aimTargetFor(a, out),
      emitContact: (ev) => hooks.contact(ev),
      rand: () => this.rng.next(),
      passTarget: (a) => this.drill?.passTarget?.(a) ?? defaultPassTarget(a),
      setOptions: (a) => this.drill?.setOptions?.(a) ?? defaultSetOptions(a),
      setPick: (a) => this.drill?.setPick?.(a) ?? null,
      setLevel: () => hooks.setLevel?.() ?? 'easy',
      canServe: (a) => (this.drill?.canServe ? this.drill.canServe(a) : !this.ball.active || this.ball.state.rest),
    });
    this.contact.userAimYaw = () => hooks.userAimYaw();
  }

  setBrain(a: Athlete, b: Brain): void {
    this.brains.set(a, b);
  }

  clearBrains(): void {
    this.brains.clear();
  }

  onAiContact(a: Athlete, kind: TouchKind, speed: number): void {
    this.hooks.aiContact(a, kind, speed);
  }

  /** one fixed step: brains, athletes, the player's actions, contacts, the ball, the judge, the drill, in that order */
  step(dt: number): void {
    this.simTime += dt;
    for (const [, b] of this.brains) b.step(dt, this);
    this.hooks.userSetJump?.();
    // assist magnet for the user's mid-air drift
    this.contact.magnet(this.me);
    for (const a of this.athletes) a.step(dt, this.simTime);
    this.actions?.step(dt);
    this.contact.step(this.athletes);
    // cleanup finished actions
    for (const a of this.athletes) {
      const act = a.action;
      if (!act) continue;
      if (act.kind === 'swing' && act.resolved && this.simTime > act.contactT + 0.35) a.endAction();
      // a wind-up never released before landing is dropped
      else if (act.kind === 'windup' && a.state === 'land' && a.stateT >= 0 && act.t0 < this.simTime - a.stateT) a.endAction();
      else if (act.kind === 'block' && !act.held && this.simTime > act.releaseT + 0.25) a.endAction();
      else if (act.kind === 'toss' && this.simTime > act.t0 + 1.6) a.endAction();
      else if (act.kind === 'set' && act.resolved && this.simTime > act.contactT + 0.45) a.endAction();
      else if (act.kind === 'pass' && act.resolved && this.simTime > act.contactT + 0.4) a.endAction();
    }
    this.ball.step(dt, this.env);
    for (const e of this.ball.events) this.hooks.ballEvent(e);
    if (this.ball.broke > 0) this.hooks.floatBreak(this.ball.broke);
    const out = this.judge.step(this.ball, this.ball.events, this.env.netTop);
    if (out) {
      this.hooks.outcome(out);
      this.drill?.onOutcome(out);
    }
    this.drill?.step(dt);
  }
}
