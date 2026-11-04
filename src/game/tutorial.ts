import { PLAYER, TIMING } from '../config';
import { clamp } from '../core/mathx';
import type { Grade } from './athlete';
import type { Game } from './game';
import { kbd } from './modes/mode';

/**
 * First-run tutorial v2 (issue #25, PR #27). A coach layer on Spike Drill:
 * slow, freeze at the decision, wait for the right press or release, resume.
 * Not a separate mode.
 *
 * Persisted once per browser: `courtFeel.tutorial.v1` =
 * `done | skipped | in_progress:{step}`.
 */

export const TUTORIAL_KEY = 'courtFeel.tutorial.v1';

export type TutorialStep = 0 | 1 | 2 | 3 | 4 | 5 | 6;

/** which decision the world is waiting on */
export type TutorialGate = 'none' | 'jump-load' | 'jump-release' | 'swing-draw' | 'swing-ride' | 'swing-rehold' | 'swing-release';

/** how long the feet have to rest inside the plant ring */
export const FEET_DWELL_S = 0.4;
/** welcome line, then the feet step — or sooner if they start running */
export const WELCOME_S = 2.8;
const WELCOME_RUN_S = 0.35;
/** hand-off line, then the drill's own hints take over */
const HANDOFF_S = 2.6;
/** read-the-grade beat, or any key */
const GRADE_S = 3;
/** anti-stuck: pulse the hint key and brighten Skip. Does not advance. */
export const GATE_NUDGE_S = 6;
/** load ring fraction that unlocks the jump hold (the HUD's own meter) */
export const JUMP_GATE_LOAD = 0.7;
/** sim seconds before the ideal release when the arm-draw freeze starts */
export const SWING_DRAW_LEAD = 0.25;
/** release-now error (s) at the centre of the Perfect window: the release freeze */
export const SWING_SWEET_ERR = 0.015;
/** slow-motion factor between freezes */
export const TUTOR_SLOW = 0.35;
/** solo rep: one miss gets another try, the next miss hands the court over */
const SOLO_MISS_LIMIT = 2;

export const HINT_FEET = `Run in — hold ${kbd('Shift')}+${kbd('W')}. Stop on the ring.`;
export const HINT_LOAD = `Hold ${kbd('Space')} — load the jump`;
export const HINT_TAKEOFF = `Release — leave the floor`;
export const HINT_DRAW = `Hold ${kbd('Left mouse')} — draw the arm`;
export const HINT_THROUGH = `Now — release ${kbd('Left mouse')} through the ball`;
export const NUDGE_LOAD = 'Keep holding — fill the ring';
export const NUDGE_CHARGE = 'Hold until the ring closes';
export const NUDGE_GOLD = 'Not yet — hold till the gold';
export const HINT_SOLO = 'Your rep — no stops. Release on the gold.';

/** degrees of collar per second of release error. 0° is 12 o'clock; early is left. */
export const COLLAR_DEG_PER_S = 450;
/** collar span: −0.20 s … +0.16 s → −90° … +72° */
export const COLLAR_ERR_MIN = -0.2;
export const COLLAR_ERR_MAX = 0.16;

export type CollarZone = 'wood' | 'good' | 'perfect';

/** where a release right now sits on the collar, clamped to the drawn arc */
export function collarDegrees(err: number): number {
  return clamp(err * COLLAR_DEG_PER_S, COLLAR_ERR_MIN * COLLAR_DEG_PER_S, COLLAR_ERR_MAX * COLLAR_DEG_PER_S);
}

/** gold = Perfect window, cyan = Good, wood = Early/Late outside that. Real TIMING numbers. */
export function collarZone(err: number): CollarZone {
  if (err >= -TIMING.spikePerfect && err <= TIMING.spikePerfectLate) return 'perfect';
  if (err >= -TIMING.spikeGood && err <= TIMING.spikeGoodLate) return 'good';
  return 'wood';
}

/** same fraction the HUD load ring draws */
export function jumpLoadFrac(loadT: number): number {
  const denom = PLAYER.loadMax - PLAYER.loadMin * 0.5;
  return denom <= 0 ? 0 : Math.min(1, Math.max(0, (loadT - PLAYER.loadMin * 0.5) / denom));
}

export interface TutorialStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

export interface TutorialBegin {
  /** start at step 0 even if a previous run was saved */
  replay?: boolean;
  /** force a step (0 welcome … 6 hand-off). Used by replay and `?tutorial=` */
  step?: number;
}

function browserStore(): TutorialStorage | null {
  try {
    if (typeof localStorage === 'undefined') return null;
    return localStorage;
  } catch {
    return null;
  }
}

export function readTutorialFlag(storage?: TutorialStorage | null): string | null {
  const s = storage === undefined ? browserStore() : storage;
  if (!s) return null;
  try {
    return s.getItem(TUTORIAL_KEY);
  } catch {
    return null;
  }
}

export function writeTutorialFlag(value: string, storage?: TutorialStorage | null): void {
  const s = storage === undefined ? browserStore() : storage;
  if (!s) return;
  try {
    s.setItem(TUTORIAL_KEY, value);
  } catch {
    /* private mode / blocked storage */
  }
}

/** PLAY offers the tutorial until this browser finished or skipped it */
export function tutorialPending(flag: string | null): boolean {
  return flag !== 'done' && flag !== 'skipped';
}

export function resumeStep(flag: string | null): TutorialStep {
  if (!flag) return 0;
  const m = /^in_progress:([0-6])$/.exec(flag);
  return m ? (Number(m[1]) as TutorialStep) : 0;
}

function clampStep(n: number): TutorialStep {
  if (!Number.isInteger(n) || n < 0 || n > 6) return 0;
  return n as TutorialStep;
}

export type GateInput = 'allow' | 'block' | 'cancel' | 'keep';

/**
 * The beat machine, with no rendering. Spike Drill and the game loop report
 * the plant time, the swing window and the buttons; the director decides
 * when the world freezes and which press is allowed through.
 */
export class TutorialDirector {
  active = false;
  step: TutorialStep = 0;
  gate: TutorialGate = 'none';
  /** world is stopped: sim scale target is 0 */
  frozen = false;
  /** 1 normal, 0.35 slow, 0 freeze */
  tutorTarget = 1;
  /** beat 5 uses the contact slow-mo dip and no freezes */
  contactDip = false;
  lastGrade: Grade | null = null;
  /** anti-stuck has fired for the current gate */
  stuck = false;
  /** the click that re-locks after Esc is not a swing */
  swallowNextAttack = false;
  /** the guided release has been allowed; the contact that follows is beat 4 */
  private armedContact = false;
  /** fired when the step changes (not on the initial begin) */
  onStep: ((step: TutorialStep) => void) | null = null;
  onStuck: (() => void) | null = null;

  private feetDwell = 0;
  private stepT = 0;
  private gateT = 0;
  private nudge = '';
  private soloMisses = 0;
  private soloHit = false;
  private setSlow = false;

  begin(step: TutorialStep): void {
    this.active = true;
    this.step = step;
    this.gate = 'none';
    this.frozen = false;
    this.tutorTarget = 1;
    this.contactDip = step === 5;
    this.feetDwell = 0;
    this.stepT = 0;
    this.gateT = 0;
    this.nudge = '';
    this.stuck = false;
    this.soloMisses = 0;
    this.soloHit = false;
    this.armedContact = false;
    this.setSlow = false;
    this.swallowNextAttack = false;
    this.lastGrade = null;
  }

  skip(): void {
    this.active = false;
    this.frozen = false;
    this.tutorTarget = 1;
    this.contactDip = false;
    this.gate = 'none';
  }

  /** steps 0–1 hold the coach's toss */
  holdingFeed(): boolean {
    return this.active && this.step < 2;
  }

  /** no drifting while a jump or swing gate is frozen */
  ignoreMovement(): boolean {
    return this.active && this.frozen && (this.step === 2 || this.step === 3);
  }

  /** real-time clocks: welcome, grade, hand-off, anti-stuck. `moving` once they run. */
  tick(dt: number, moving: boolean, anyKey = false): void {
    if (!this.active) return;
    this.stepT += dt;
    if (this.frozen) {
      this.gateT += dt;
      if (!this.stuck && this.gateT >= GATE_NUDGE_S) {
        this.stuck = true;
        this.onStuck?.();
      }
    }
    if (this.step === 0 && (this.stepT >= WELCOME_S || (moving && this.stepT >= WELCOME_RUN_S))) this.enter(1);
    else if (this.step === 4 && (this.stepT >= GRADE_S || (anyKey && this.stepT > 0.4))) this.enter(5);
    else if (this.step === 6 && this.stepT >= HANDOFF_S) this.active = false;
  }

  /** step 1: feet settled inside the cyan plant ring. No give-up — Skip is the way out. */
  noteFeet(inRing: boolean, dt: number): void {
    if (!this.active || this.step !== 1) return;
    if (!inRing) {
      this.feetDwell = 0;
      return;
    }
    this.feetDwell += dt;
    if (this.feetDwell >= FEET_DWELL_S) this.enter(2);
  }

  /** the set is in the air: ease from full speed down to the slow ride */
  noteSetRising(up: boolean): void {
    if (!this.active || this.step !== 2 || this.gate !== 'none') return;
    if (up) this.setSlow = true;
    this.tutorTarget = this.setSlow ? TUTOR_SLOW : 1;
  }

  /** approach planner's plant time: freeze and wait for the jump load */
  notePlant(simTime: number, tPress: number, grounded: boolean): void {
    if (!this.active || this.step !== 2 || this.gate !== 'none') return;
    if (!grounded || tPress <= 0 || simTime < tPress) return;
    this.freeze('jump-load');
  }

  /**
   * Airborne swing window. `releaseIn` is seconds until the ideal release
   * (positive = still early). `releaseErr` is how late a release *now* would be.
   */
  noteSwingWindow(releaseIn: number, releaseErr: number, airborne: boolean, charge: number): void {
    if (!this.active || !airborne || this.step !== 3) return;
    if (this.gate === 'none' && releaseIn <= SWING_DRAW_LEAD && releaseIn > 0.02) this.freeze('swing-draw');
    else if (this.gate === 'swing-draw' && charge >= 1) {
      this.gate = 'swing-ride';
      this.frozen = false;
      this.tutorTarget = TUTOR_SLOW;
      this.nudge = '';
      this.gateT = 0;
      this.stuck = false;
    } else if (this.gate === 'swing-ride' && releaseErr >= SWING_SWEET_ERR) this.freeze('swing-release');
  }

  /** while frozen, the load / charge meters fill in real time. 'load' or 'charge'. */
  freezeFill(): 'load' | 'charge' | 'none' {
    if (!this.frozen) return 'none';
    if (this.gate === 'jump-load' || this.gate === 'jump-release') return 'load';
    if (this.gate === 'swing-draw') return 'charge';
    return 'none';
  }

  /** load ring crossed 70% while held: same freeze, now waiting for the release */
  noteLoad(frac: number, held: boolean): void {
    if (!this.active || this.gate !== 'jump-load') return;
    if (held && frac >= JUMP_GATE_LOAD) {
      this.gate = 'jump-release';
      this.nudge = '';
      this.gateT = 0;
      this.stuck = false;
    }
  }

  onJumpPress(): GateInput {
    if (!this.active) return 'allow';
    if (this.step === 1) return 'block';
    if (this.step === 2 && this.gate === 'none') return 'block';
    if (this.step === 3 && this.gate !== 'none') return 'block';
    if (this.gate === 'jump-load' || this.gate === 'jump-release') return 'allow';
    return 'allow';
  }

  onJumpRelease(): GateInput {
    if (!this.active) return 'allow';
    if (this.gate === 'jump-load') {
      this.nudge = NUDGE_LOAD;
      return 'cancel';
    }
    if (this.gate === 'jump-release') {
      this.frozen = false;
      this.tutorTarget = TUTOR_SLOW;
      this.gate = 'none';
      this.nudge = '';
      return 'allow';
    }
    if (this.step === 2 || this.step === 3 || this.frozen) return 'block';
    return 'allow';
  }

  onAttackPress(): GateInput {
    if (!this.active) return 'allow';
    if (this.swallowNextAttack) {
      this.swallowNextAttack = false;
      return 'block';
    }
    if (this.step === 1 || this.step === 2) return 'block';
    if (this.step === 3 && this.gate === 'none') return 'block';
    if (this.gate === 'swing-rehold') {
      this.gate = 'swing-ride';
      this.frozen = false;
      this.tutorTarget = TUTOR_SLOW;
      this.nudge = '';
      this.gateT = 0;
      this.stuck = false;
      return 'allow';
    }
    if (this.gate === 'swing-draw' || this.gate === 'swing-release' || this.gate === 'swing-ride') return 'allow';
    return 'allow';
  }

  /**
   * Attack button up. 'cancel' drops the wind-up (no tip, ring drains).
   * 'keep' leaves the full charge in place and re-freezes. 'allow' swings.
   */
  onAttackRelease(): GateInput {
    if (!this.active) return 'allow';
    if (this.gate === 'swing-draw') {
      this.nudge = NUDGE_CHARGE;
      return 'cancel';
    }
    if (this.gate === 'swing-ride') {
      this.freeze('swing-rehold');
      this.nudge = NUDGE_GOLD;
      return 'keep';
    }
    if (this.gate === 'swing-release') {
      this.frozen = false;
      this.tutorTarget = 1;
      this.gate = 'none';
      this.nudge = '';
      this.armedContact = true;
      return 'allow';
    }
    if (this.step === 3 && this.gate !== 'none') return 'block';
    return 'allow';
  }

  noteTakeoff(): void {
    if (!this.active || this.step !== 2) return;
    this.enter(3);
    this.tutorTarget = TUTOR_SLOW;
    this.frozen = false;
    this.gate = 'none';
  }

  noteContact(grade: Grade): void {
    if (!this.active) return;
    this.lastGrade = grade;
    if (this.step === 3 && this.armedContact) {
      this.armedContact = false;
      this.enter(4);
      return;
    }
    if (this.step !== 5) return;
    if (grade === 'Miss') return;
    this.soloHit = true;
    this.enter(6);
  }

  /** end of a solo rep that was not a clean hit. Two misses, then the hand-off. */
  noteRepEnd(): void {
    if (!this.active || this.step !== 5 || this.soloHit) {
      this.soloHit = false;
      return;
    }
    this.soloMisses += 1;
    if (this.soloMisses >= SOLO_MISS_LIMIT) this.enter(6);
  }

  /** pause during a gate: they re-press on resume; the lock click is not the swing */
  onPause(): void {
    if (!this.active) return;
    if (this.step === 3 && (this.gate === 'swing-draw' || this.gate === 'swing-ride' || this.gate === 'swing-release' || this.gate === 'swing-rehold')) {
      this.swallowNextAttack = true;
    }
  }

  hint(): string {
    if (this.nudge) return this.nudge;
    switch (this.step) {
      case 0:
        return "We'll hit one ball together.";
      case 1:
        return HINT_FEET;
      case 2:
        return this.gate === 'jump-release' ? HINT_TAKEOFF : HINT_LOAD;
      case 3:
        return this.gate === 'swing-release' ? HINT_THROUGH : this.gate === 'swing-rehold' ? NUDGE_GOLD : HINT_DRAW;
      case 4:
        return `${this.gradeLine()} · ${kbd('R')} see that again`;
      case 5:
        return HINT_SOLO;
      default:
        return '';
    }
  }

  label(): string | null {
    switch (this.step) {
      case 1:
        return 'STEP 1 · FEET';
      case 2:
        return 'STEP 2 · JUMP';
      case 3:
        return 'STEP 3 · SWING';
      case 4:
        return 'STEP 4 · THE GRADE';
      case 5:
        return 'YOUR REP';
      case 6:
        return "You're on the court.";
      default:
        return null;
    }
  }

  /** Early / Late say what the ball actually does */
  gradeSub(grade: Grade, fallback: string): string {
    if (!this.active) return fallback;
    if (grade === 'Early') return "You're under the ball — it sails long";
    if (grade === 'Late') return 'Over the top — into the net';
    return fallback;
  }

  private gradeLine(): string {
    switch (this.lastGrade) {
      case 'Perfect':
        return 'Perfect — you released in the gold.';
      case 'Good':
        return 'Good — next to the sweet spot.';
      case 'Early':
        return "You're under the ball — it sails long.";
      case 'Late':
        return 'Over the top — into the net.';
      default:
        return 'Miss — swing through the ball next time.';
    }
  }

  private freeze(gate: TutorialGate): void {
    this.gate = gate;
    this.frozen = true;
    this.tutorTarget = 0;
    this.gateT = 0;
    this.stuck = false;
    this.nudge = '';
  }

  private enter(step: TutorialStep): void {
    if (!this.active || this.step === step) return;
    this.step = step;
    this.stepT = 0;
    this.feetDwell = 0;
    this.gate = 'none';
    this.frozen = false;
    this.nudge = '';
    this.gateT = 0;
    this.stuck = false;
    this.tutorTarget = 1;
    this.contactDip = step === 5;
    this.setSlow = false;
    if (step === 3) this.tutorTarget = TUTOR_SLOW;
    this.onStep?.(step);
  }
}

/** Session wired to the HUD, the sim clock and the stored flag. */
export class Tutorial {
  readonly director = new TutorialDirector();

  constructor(private g: Game) {
    this.director.onStep = (step) => {
      writeTutorialFlag(step >= 6 ? 'done' : `in_progress:${step}`);
      this.applyChrome();
    };
    this.director.onStuck = () => this.g.hud.nudgeTutorial();
    g.hud.onSkip = () => this.requestSkip();
  }

  get active(): boolean {
    return this.director.active;
  }

  get step(): TutorialStep {
    return this.director.step;
  }

  get frozen(): boolean {
    return this.director.frozen;
  }

  holdingFeed(): boolean {
    return this.director.holdingFeed();
  }

  ignoreMovement(): boolean {
    return this.director.ignoreMovement();
  }

  tutorTarget(): number {
    return this.director.active ? this.director.tutorTarget : 1;
  }

  wantsContactDip(): boolean {
    return this.director.active && this.director.contactDip;
  }

  stuck(): boolean {
    return this.director.stuck;
  }

  begin(opts: TutorialBegin = {}): void {
    const step = clampStep(opts.step !== undefined ? opts.step : opts.replay ? 0 : resumeStep(readTutorialFlag()));
    this.director.begin(step);
    writeTutorialFlag(step >= 6 ? 'done' : `in_progress:${step}`);
  }

  present(): void {
    this.applyChrome();
    this.g.hud.clearFlash();
    this.g.hud.dip();
    if (this.director.step === 0) this.g.hud.showBanner('True to the court.', 'neutral', WELCOME_S);
  }

  /**
   * Skip. Welcome returns to the start screen. Anywhere else: cancel the
   * half-taught rep (no swing, no takeoff), reset like N, stay in the drill.
   */
  requestSkip(): 'menu' | 'drill' | null {
    if (!this.director.active || this.director.step >= 6) return null;
    const where: 'menu' | 'drill' = this.director.step === 0 ? 'menu' : 'drill';
    this.cancelAction();
    this.g.snapTutor();
    this.director.skip();
    writeTutorialFlag('skipped');
    this.clearChrome();
    if (where === 'drill') this.g.mode?.restartRep();
    this.g.hud.dip();
    this.g.onTutorialSkipped?.(where);
    return where;
  }

  tick(dt: number, moving: boolean): void {
    const was = this.director.active;
    let any = false;
    if (this.director.step === 4) any = this.g.input.consumeAny();
    this.director.tick(dt, moving, any);
    if (was && !this.director.active) this.clearChrome();
    this.g.hud.setFrozen(this.director.frozen);
    this.g.hud.setNudge(this.director.stuck);
  }

  noteFeet(inRing: boolean, dt: number): void {
    this.director.noteFeet(inRing, dt);
  }

  noteSetRising(up: boolean): void {
    this.director.noteSetRising(up);
  }

  notePlant(simTime: number, tPress: number, grounded: boolean): void {
    this.director.notePlant(simTime, tPress, grounded);
  }

  noteSwingWindow(releaseIn: number, releaseErr: number, airborne: boolean, charge: number): void {
    this.director.noteSwingWindow(releaseIn, releaseErr, airborne, charge);
  }

  noteLoad(frac: number, held: boolean): void {
    this.director.noteLoad(frac, held);
  }

  fillKind(): 'load' | 'charge' | 'none' {
    return this.director.freezeFill();
  }

  onJumpPress(): GateInput {
    return this.director.onJumpPress();
  }

  onJumpRelease(): GateInput {
    return this.director.onJumpRelease();
  }

  onAttackPress(): GateInput {
    return this.director.onAttackPress();
  }

  onAttackRelease(): GateInput {
    return this.director.onAttackRelease();
  }

  noteTakeoff(): void {
    this.director.noteTakeoff();
  }

  noteContact(grade: Grade): void {
    this.director.noteContact(grade);
  }

  noteRepEnd(): void {
    this.director.noteRepEnd();
  }

  onPause(): void {
    this.director.onPause();
    this.g.input.clearEdges();
  }

  hint(): string {
    return this.director.hint();
  }

  gradeSub(grade: Grade, fallback: string): string {
    return this.director.gradeSub(grade, fallback);
  }

  /** drop a wind-up or a loaded jump so Skip cannot fire it on the way out */
  private cancelAction(): void {
    const me = this.g.me;
    if (me.action?.kind === 'windup') me.endAction();
    if (me.state === 'load') {
      me.state = 'ground';
      me.loadT = 0;
      me.loadRelease = false;
    }
  }

  private applyChrome(): void {
    const on = this.director.active;
    this.g.hud.setTutorialChrome(on && this.director.step < 6);
    this.g.hud.suppressCalls = on;
    this.g.hud.setFrozen(this.director.frozen);
    if (!on) {
      this.g.hud.pinMessage(null);
      return;
    }
    this.g.hud.pinMessage(this.director.label());
  }

  private clearChrome(): void {
    this.g.hud.setTutorialChrome(false);
    this.g.hud.suppressCalls = false;
    this.g.hud.setFrozen(false);
    this.g.hud.pinMessage(null);
  }
}
