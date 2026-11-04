import type { Grade } from './athlete';
import type { Game } from './game';
import { kbd } from './modes/mode';

/**
 * First-run tutorial (issue #25). A guided first session of Spike Drill —
 * Outside, block off — taught with the existing hint line, plant ring and
 * load / charge rings. Not a separate mode.
 *
 * Persisted once per browser: `courtFeel.tutorial.v1` =
 * `done | skipped | in_progress:{step}`.
 */

export const TUTORIAL_KEY = 'courtFeel.tutorial.v1';

export type TutorialStep = 0 | 1 | 2 | 3 | 4 | 5 | 6;

/** how long the feet have to rest inside the plant ring */
export const FEET_DWELL_S = 0.4;
/** step 1 gives up and moves on (fail-forward: there is no rep to count yet) */
export const FEET_GIVE_UP_S = 10;
/** missed reps on a step before it advances anyway */
export const FAIL_FORWARD_TRIES = 3;
/** welcome line, then the feet step — or sooner if they start running */
export const WELCOME_S = 2.8;
const WELCOME_RUN_S = 0.35;
/** hand-off line, then the drill's own hints take over */
const HANDOFF_S = 2.6;

/** locked copy from the step 2 / 3 mocks */
export const HINT_JUMP = `Hold ${kbd('Space')} to load the jump, release to leave the floor`;
export const HINT_SWING = `Hold ${kbd('Left mouse')} to draw the arm, release through the ball`;

const RETRY_JUMP = 'Jump as the set rises — try again.';
const RETRY_SWING = 'Swing through the ball — try again.';

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

/**
 * The step machine, with no rendering. Spike Drill reports feet, takeoff,
 * contact and the end of a rep; the director decides when to move on.
 */
export class TutorialDirector {
  active = false;
  step: TutorialStep = 0;
  attempts = 0;
  lastGrade: Grade | null = null;
  /** fired when the step changes (not on the initial begin) */
  onStep: ((step: TutorialStep) => void) | null = null;

  private feetDwell = 0;
  private stepT = 0;
  private liveJump = false;
  private contacted = false;
  private goodEnough = false;
  private retry = '';
  private retryT = 0;

  begin(step: TutorialStep): void {
    this.active = true;
    this.step = step;
    this.attempts = 0;
    this.feetDwell = 0;
    this.stepT = 0;
    this.liveJump = false;
    this.contacted = false;
    this.goodEnough = false;
    this.lastGrade = null;
    this.retry = '';
    this.retryT = 0;
  }

  /** full skip: the caller writes `skipped` */
  skip(): void {
    this.active = false;
  }

  /** steps 0–1 hold the coach's toss so the player can find the ring first */
  holdingFeed(): boolean {
    return this.active && this.step < 2;
  }

  /** welcome timer, feet give-up, hand-off. `moving` is true once they run or load a jump */
  tick(dt: number, moving: boolean): void {
    if (!this.active) return;
    this.stepT += dt;
    if (this.retryT > 0) this.retryT = Math.max(0, this.retryT - dt);
    if (this.step === 0 && (this.stepT >= WELCOME_S || (moving && this.stepT >= WELCOME_RUN_S))) this.enter(1);
    else if (this.step === 1 && this.stepT >= FEET_GIVE_UP_S) this.enter(2);
    else if (this.step === 6 && this.stepT >= HANDOFF_S) this.active = false;
  }

  /** step 1: feet settled inside the cyan plant ring */
  noteFeet(inRing: boolean, dt: number): void {
    if (!this.active || this.step !== 1) return;
    if (!inRing) {
      this.feetDwell = 0;
      return;
    }
    this.feetDwell += dt;
    if (this.feetDwell >= FEET_DWELL_S) this.enter(2);
  }

  /**
   * A takeoff during the jump step. In the air with the set live, go teach the
   * swing on this same ball. A jump before the set is a soft retry.
   */
  noteTakeoff(setLive: boolean): void {
    if (!this.active || this.step !== 2) return;
    if (!setLive) {
      this.setRetry(RETRY_JUMP);
      return;
    }
    this.liveJump = true;
    this.enter(3);
  }

  /** any graded contact on the swing step advances; a Good+ alone-rep finishes the lesson */
  noteContact(grade: Grade): void {
    if (!this.active) return;
    this.lastGrade = grade;
    if (this.step === 3) {
      this.contacted = true;
      this.enter(4);
    } else if (this.step === 5 && (grade === 'Perfect' || grade === 'Good')) {
      this.goodEnough = true;
      this.enter(6);
    }
  }

  /** the rep reset (the ball died, or N). Missed attempts fail forward. */
  noteRepEnd(): void {
    if (!this.active) return;
    const step = this.step;
    if (step === 2 && !this.liveJump) {
      this.attempts += 1;
      if (this.attempts >= FAIL_FORWARD_TRIES) this.enter(3);
      else this.setRetry(RETRY_JUMP);
    } else if (step === 3 && !this.contacted) {
      this.attempts += 1;
      if (this.attempts >= FAIL_FORWARD_TRIES) this.enter(5);
      else this.setRetry(RETRY_SWING);
    } else if (step === 4) {
      this.enter(5);
    } else if (step === 5 && !this.goodEnough) {
      this.attempts += 1;
      if (this.attempts >= FAIL_FORWARD_TRIES) this.enter(6);
    }
    this.liveJump = false;
    this.contacted = false;
    this.goodEnough = false;
  }

  /** one coach line. Retry copy replaces it for a moment; it never mentions the tip. */
  hint(): string {
    if (this.retryT > 0 && this.retry) return this.retry;
    switch (this.step) {
      case 0:
        return "We'll hit one ball together.";
      case 1:
        return `Run in — hold ${kbd('Shift')}+${kbd('W')}. Stop on the ring.`;
      case 2:
        return HINT_JUMP;
      case 3:
        return HINT_SWING;
      case 4:
        return `${this.gradeLine()} · ${kbd('R')} see that again`;
      case 5:
        return `Your rep — ${kbd('Space')} load, ${kbd('Left mouse')} swing.`;
      default:
        return '';
    }
  }

  /** `hud-msg` step title. Null on the welcome (the banner carries that). */
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

  /** Early / Late keep the coach's words in the grade sub, once, while the tutorial is up */
  gradeSub(grade: Grade, fallback: string): string {
    if (!this.active) return fallback;
    if (grade === 'Early') return 'Too early — wait for the ball';
    if (grade === 'Late') return 'Late — swing sooner next time';
    return fallback;
  }

  private gradeLine(): string {
    switch (this.lastGrade) {
      case 'Perfect':
        return 'Perfect = early enough that the arm is still coming through.';
      case 'Good':
        return 'Good — the arm came through the ball.';
      case 'Early':
        return 'Too early — wait for the ball.';
      case 'Late':
        return 'Late — swing sooner next time.';
      default:
        return 'Miss — swing through the ball next time.';
    }
  }

  private setRetry(line: string): void {
    this.retry = line;
    this.retryT = 2.4;
  }

  private enter(step: TutorialStep): void {
    if (!this.active || this.step === step) return;
    this.step = step;
    this.stepT = 0;
    this.feetDwell = 0;
    this.attempts = 0;
    this.retry = '';
    this.retryT = 0;
    this.onStep?.(step);
  }
}

/** Session wired to the HUD: chrome, the stored flag, skip. */
export class Tutorial {
  readonly director = new TutorialDirector();

  constructor(private g: Game) {
    this.director.onStep = (step) => {
      writeTutorialFlag(step >= 6 ? 'done' : `in_progress:${step}`);
      this.applyChrome();
    };
    g.hud.onSkip = () => this.requestSkip();
  }

  get active(): boolean {
    return this.director.active;
  }

  get step(): TutorialStep {
    return this.director.step;
  }

  holdingFeed(): boolean {
    return this.director.holdingFeed();
  }

  begin(opts: TutorialBegin = {}): void {
    const step = clampStep(opts.step !== undefined ? opts.step : opts.replay ? 0 : resumeStep(readTutorialFlag()));
    this.director.begin(step);
    writeTutorialFlag(step >= 6 ? 'done' : `in_progress:${step}`);
  }

  /** dip, welcome banner, step label. Call after the spike drill exists and the HUD is visible. */
  present(): void {
    this.applyChrome();
    this.g.hud.clearFlash();
    this.g.hud.dip();
    if (this.director.step === 0) this.g.hud.showBanner('True to the court.', 'neutral', WELCOME_S);
  }

  /**
   * Skip tutorial. Step 0 returns to the start screen; a later step stays in
   * the drill with the lesson gone. Writes `skipped`.
   */
  requestSkip(): 'menu' | 'drill' | null {
    if (!this.director.active || this.director.step >= 6) return null;
    const where: 'menu' | 'drill' = this.director.step === 0 ? 'menu' : 'drill';
    this.director.skip();
    writeTutorialFlag('skipped');
    this.clearChrome();
    this.g.onTutorialSkipped?.(where);
    return where;
  }

  tick(dt: number, moving: boolean): void {
    const was = this.director.active;
    this.director.tick(dt, moving);
    if (was && !this.director.active) this.clearChrome();
  }

  noteFeet(inRing: boolean, dt: number): void {
    this.director.noteFeet(inRing, dt);
  }

  noteTakeoff(setLive: boolean): void {
    this.director.noteTakeoff(setLive);
  }

  noteContact(grade: Grade): void {
    this.director.noteContact(grade);
  }

  noteRepEnd(): void {
    this.director.noteRepEnd();
  }

  hint(): string {
    return this.director.hint();
  }

  gradeSub(grade: Grade, fallback: string): string {
    return this.director.gradeSub(grade, fallback);
  }

  private applyChrome(): void {
    const on = this.director.active;
    // the skip chip stays through the live steps; the hand-off is the last line
    this.g.hud.setTutorialChrome(on && this.director.step < 6);
    this.g.hud.suppressCalls = on;
    if (!on) {
      this.g.hud.pinMessage(null);
      return;
    }
    this.g.hud.pinMessage(this.director.label());
  }

  private clearChrome(): void {
    this.g.hud.setTutorialChrome(false);
    this.g.hud.suppressCalls = false;
    this.g.hud.pinMessage(null);
  }
}
