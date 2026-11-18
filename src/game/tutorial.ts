import { PLAYER, SERVE, SERVE_KINDS, SIM, TIMING, TUTORIAL as T, type ServeKind } from '../config';
import { clamp } from '../core/mathx';
import type { Athlete, Grade } from './athlete';
import { ContactSystem, tossGroove } from './contact';
import type { Game } from './game';
import { kbd } from './modes/mode';

/**
 * First-run lesson (issue #25, PR #27): a coach layer on the Spike Drill, not a separate mode.
 * One Outside high ball, hit three times with less help each time:
 *
 *   1. Together     the ball waits for you. At each moment (run, jump, draw, hit) time eases
 *                   down and stops until you do it. Do it on time, or already be holding the
 *                   button, and nothing stops. The coach holds your line to the spot.
 *   2. Slow motion  you drive: the same cues, slowed down, nothing waits. The result is real.
 *   3. Full speed   the drill as it is played, with the contact slow-mo dip.
 *
 * Buttons are read as held, never as fresh presses, in the together rep: a button that is
 * already down when its moment comes counts. Nobody has to let go and press again.
 *
 * Persisted once per browser: `courtFeel.tutorial.v1` = `done | skipped | in_progress:{step}`.
 *
 * The serve lessons (one per serve: standing float, jump float, jump serve) are the same three
 * reps on the Serve Drill. They add the toss before the rest (TOSS › RUN › JUMP › DRAW › HIT, and
 * TOSS › DRAW › HIT for the standing float, which has no run or jump), and the coach holds the
 * server behind the line until GO. They are taken from Learn; which have been finished is kept in
 * `courtFeel.serveLessons.v1`.
 */

export const TUTORIAL_KEY = 'courtFeel.tutorial.v1';

/** 0 welcome, 1 together, 2 slow motion, 3 full speed, 4 done (the lesson is over: the game offers what to do next) */
export type TutorialStep = 0 | 1 | 2 | 3 | 4;
export const LAST_STEP = 4;

/** which lesson: the spike, or one of the three serves */
export type Lesson = 'spike' | ServeKind;
export const isLesson = (v: unknown): v is Lesson => v === 'spike' || SERVE_KINDS.includes(v as ServeKind);

/** where the together rep is */
export type Beat = 'toss' | 'watch' | 'run' | 'plant' | 'draw' | 'hit' | 'swing' | 'result';

/** the four things a spike is made of, in order (a serve has the toss first) */
export type CueId = 'toss' | 'run' | 'jump' | 'draw' | 'hit';
export const CUE_ORDER: readonly CueId[] = ['run', 'jump', 'draw', 'hit'];
export const CUE_NAMES: Record<CueId, string> = { toss: 'TOSS', run: 'RUN', jump: 'JUMP', draw: 'DRAW', hit: 'HIT' };

/** what a lesson's rep is made of, in order */
export function cueOrder(lesson: Lesson): readonly CueId[] {
  if (lesson === 'spike') return CUE_ORDER;
  return lesson === 'float' ? ['toss', 'draw', 'hit'] : ['toss', 'run', 'jump', 'draw', 'hit'];
}

export interface Cue {
  id: CueId;
  /** key caps, as hint markup */
  keys: string;
  text: string;
  /** the ball is waiting on this */
  waiting: boolean;
}

const KEYS: Record<CueId, string> = {
  toss: kbd('Q'),
  run: `${kbd('Shift')}+${kbd('W')}`,
  jump: kbd('Space'),
  draw: kbd('Left mouse'),
  hit: kbd('Left mouse'),
};

export const TEXT = {
  welcome: "Three balls. We'll hit the first one together.",
  watch: 'Watch the set go up. The ball waits for you.',
  run: 'Hold to run in',
  sprint: `Hold ${kbd('Shift')} as well: an approach is a sprint`,
  sprintTouch: 'Push the stick all the way: an approach is a sprint',
  jump: 'Hold at the line to jump',
  load: 'Keep holding',
  draw: 'Hold to draw your arm back',
  fill: 'Keep holding: fill the ring',
  ride: 'Let go on the gold',
  notYet: 'Not yet. Hold again and let go on the gold',
  now: 'Let go!',
  click: 'Click to swing',
  tap: 'Tap to swing',
  slowIntro: 'Now you drive, in slow motion. Nothing waits this time.',
  soloIntro: 'Full speed. Run when you see GO.',
  again: "Let's take that one again.",
  aim: 'You aim with where you look: higher is deeper.',
  toss: 'Hold to toss',
  tossMark: "Let go at the white mark: that is this serve's toss",
  tossHeld: 'The toss goes up at the white mark',
  watchToss: 'Watch the toss. The ball waits for you.',
  serveSolo: 'Full speed. Toss, and run when you see GO.',
  floatSolo: 'Full speed. Toss, draw, hit.',
  drawFloat: 'Hold to draw your arm back',
};

/** the name of a serve lesson's serve, in a sentence */
const serveName = (k: ServeKind): string => SERVE[k].name.toLowerCase();

const STEP = 1 / SIM.hz;

/**
 * Has the simulation reached the moment `t`? It has once one more step would pass it: the game
 * never steps past a moment the ball waits at, so this is as close as the clock gets.
 */
export function reached(simTime: number, t: number): boolean {
  return simTime + STEP > t + 1e-6;
}

// ---------------------------------------------------------------- the timing collar

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

// ---------------------------------------------------------------- the stored flag

export interface TutorialStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

export interface TutorialBegin {
  /** the spike (the first-run lesson, the default) or a serve */
  lesson?: Lesson;
  /** start at the welcome even if a previous run was saved */
  replay?: boolean;
  /** force a step (0 welcome … 4 hand-off). Used by replay and `?tutorial=` */
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

export const SERVE_LESSONS_KEY = 'courtFeel.serveLessons.v1';

/** the serve lessons finished in this browser */
export function readServeLessons(storage?: TutorialStorage | null): ServeKind[] {
  const s = storage === undefined ? browserStore() : storage;
  if (!s) return [];
  try {
    const v: unknown = JSON.parse(s.getItem(SERVE_LESSONS_KEY) ?? '[]');
    return Array.isArray(v) ? SERVE_KINDS.filter((k) => v.includes(k)) : [];
  } catch {
    return [];
  }
}

/** remember that a serve lesson has been finished */
export function markServeLessonDone(kind: ServeKind, storage?: TutorialStorage | null): void {
  const s = storage === undefined ? browserStore() : storage;
  if (!s) return;
  const done = readServeLessons(s);
  if (!done.includes(kind)) done.push(kind);
  try {
    s.setItem(SERVE_LESSONS_KEY, JSON.stringify(done));
  } catch {
    /* private mode / blocked storage */
  }
}

/** the lesson has not been finished or skipped in this browser */
export function tutorialPending(flag: string | null): boolean {
  return flag !== 'done' && flag !== 'skipped';
}

/**
 * What the start screen offers a visitor: the lesson to someone who has never been here
 * ('new'), the rest of it to someone who left part-way ('resume'), nothing once it has been
 * finished or skipped.
 */
export type TutorialOffer = 'new' | 'resume' | null;

export function tutorialOffer(flag: string | null): TutorialOffer {
  if (!tutorialPending(flag)) return null;
  return resumeStep(flag) >= 1 ? 'resume' : 'new';
}

/** a saved lesson resumes at its rep (an older build saved steps up to 6: those were past the guided swing) */
export function resumeStep(flag: string | null): TutorialStep {
  if (!flag) return 0;
  const m = /^in_progress:([0-6])$/.exec(flag);
  return m ? (Math.min(Number(m[1]), 3) as TutorialStep) : 0;
}

function clampStep(n: number): TutorialStep {
  // (the last step is the end of the lesson, not a place to start it)
  if (!Number.isInteger(n) || n < 0 || n >= LAST_STEP) return 0;
  return n as TutorialStep;
}

// ---------------------------------------------------------------- the director

/** what the lesson is told about this frame */
export interface GuideFacts {
  simTime: number;
  /** the set has left the setter's hands */
  setUp: boolean;
  /** when a perfect run starts for this set and when it plants (sim time; -1: no set planned yet) */
  tGo: number;
  tPlant: number;
  /** how long that plant holds the load (s) */
  hold: number;
  state: Athlete['state'];
  loadT: number;
  /** wind-up charge 0..1, or -1 with the arm not drawn */
  charge: number;
  /** the swing has been let go and is on its way to the ball */
  swinging: boolean;
  /** when the release reaches `TUTORIAL.sweetErr` (sim time; -1: unknown) */
  sweetAt: number;
  /** what is held right now: a sprint, any movement, the jump button, the attack button */
  run: boolean;
  move: boolean;
  jump: boolean;
  attack: boolean;
  /** feet to where the run started (m) */
  startD: number;
  /** serve lessons: how long the toss button has been held (s), -1 while it is up */
  tossHeld?: number;
  /** serve lessons: the hold that gives this serve its own toss (s) */
  tossAt?: number;
  /** standing float lesson: when the draw cue comes (sim time; -1 not known yet) */
  drawAt?: number;
}

/** what the lesson asks of the game this frame */
export interface GuideOut {
  /** game speed (1: real time, 0: the ball waits) */
  scale: number;
  /** take `scale` at once instead of easing to it */
  snap: boolean;
  /** time is stopped until the player does the cue */
  waiting: boolean;
  /** together rep: the coach holds the hitter still, or runs them down the line to the spot */
  drive: 'none' | 'stand' | 'run';
  /** together rep: the one thing to do for the player this frame */
  act: 'none' | 'toss' | 'plant' | 'takeoff' | 'draw' | 'swing';
  /** the wind-up charges in real time while the ball waits */
  fill: boolean;
  /** do not simulate past this sim time (the moment the ball waits at) */
  stopAt: number;
}

interface RepStats {
  tossed: boolean;
  ran: boolean;
  jumped: boolean;
  landed: boolean;
  drew: boolean;
  swung: boolean;
  grade: Grade | null;
  note: string;
  /** a serve's outcome when it was not in (the drill's word: OUT, IN THE NET, FOOT FAULT...) */
  why: string;
}

const freshRep = (): RepStats => ({
  tossed: false,
  ran: false,
  jumped: false,
  landed: false,
  drew: false,
  swung: false,
  grade: null,
  note: '',
  why: '',
});

const idleOut = (): GuideOut => ({ scale: 1, snap: false, waiting: false, drive: 'none', act: 'none', fill: false, stopAt: Infinity });

/**
 * The lesson's rules, with no rendering and no game objects: it is told the facts of the frame
 * and answers with the game speed, the cue to show and what to do for the player.
 */
export class TutorialDirector {
  active = false;
  step: TutorialStep = 0;
  /** the spike, or a serve */
  lesson: Lesson = 'spike';
  beat: Beat = 'watch';
  /** time is stopped for the player right now */
  waiting = false;
  /** the cue on screen (null: none) */
  cue: Cue | null = null;
  /** how many of the four parts are behind us this rep (0..4) */
  stage = 0;
  /** the ball has waited `TUTORIAL.nudge` seconds on the same cue */
  stuck = false;
  /** just back from a pause: the click that took the pointer back is not a swing (s, real time, left) */
  swallowFor = 0;
  /** touch controls: there is no Shift and no click */
  touch = false;
  /** fired when the step changes (not on the initial begin). The last step ends the lesson: `active` is already false. */
  onStep: ((step: TutorialStep) => void) | null = null;
  /** the last rep played was a clean hit (Perfect or Good) */
  clean = false;
  onStuck: (() => void) | null = null;

  private stepT = 0;
  private waitT = 0;
  private airAt = -1;
  private wasAttack = false;
  private nudge = '';
  private line = '';
  private tries = 0;
  private next: TutorialStep = 0;
  private rep: RepStats = freshRep();
  /** this rep's ball has been tossed (until then the last rep's ball may still be lying there) */
  private live = false;

  begin(step: TutorialStep, lesson: Lesson = 'spike'): void {
    this.active = true;
    this.lesson = lesson;
    this.step = step;
    this.tries = 0;
    this.clean = false;
    this.stuck = false;
    this.swallowFor = 0;
    this.stepT = 0;
    this.resetRep();
    this.live = false;
  }

  skip(): void {
    this.active = false;
    this.waiting = false;
    this.cue = null;
    this.beat = 'watch';
  }

  /** the welcome holds the coach's first toss */
  holdingFeed(): boolean {
    return this.active && this.step === 0;
  }

  /** the coach is still talking about the last rep: the next toss waits */
  holdingResult(): boolean {
    return this.active && this.beat === 'result';
  }

  /** the together rep is live: the lesson reads the buttons as held and moves the hitter */
  guiding(): boolean {
    return this.active && this.step === 1 && this.beat !== 'result';
  }

  /** the two reps that teach one thing: the other buttons stay quiet */
  quiet(): boolean {
    return this.active && (this.step === 1 || this.step === 2);
  }

  /** a new ball is tossed */
  noteFeed(): void {
    if (!this.active) return;
    this.resetRep();
    this.live = true;
  }

  noteContact(grade: Grade, note = ''): void {
    if (!this.active) return;
    this.rep.swung = true;
    this.rep.grade = grade;
    this.rep.note = note;
    if (this.beat !== 'result') this.stage = this.order.length;
  }

  /** what this lesson's rep is made of, in order */
  get order(): readonly CueId[] {
    return cueOrder(this.lesson);
  }

  /** a serve lesson */
  get serving(): boolean {
    return this.lesson !== 'spike';
  }

  /** the standing float: no run, no jump */
  get standing(): boolean {
    return this.lesson === 'float';
  }

  /** where a cue sits in this lesson's order (the HUD strip lights the ones before it) */
  private at(id: CueId): number {
    return this.order.indexOf(id);
  }

  /**
   * The rep is over (the ball is down, or nobody played it): the coach says one thing about it.
   * `kill`: the ball landed in their court. `why`: a serve's outcome when it was not in.
   */
  noteRepEnd(kill = false, why = ''): void {
    if (!this.active || this.step < 1 || this.step > 3 || this.beat === 'result') return;
    const r = this.rep;
    r.why = why;
    // (a serve has to be in as well: a foot fault or a ball in the net is not a clean serve)
    const clean = (r.grade === 'Perfect' || r.grade === 'Good') && (!this.serving || kill);
    // together: any ball over the net is the point of it. After that the timing has to be there.
    const ok = this.step === 1 ? r.swung && r.grade !== 'Miss' : clean;
    this.tries += 1;
    this.clean = clean;
    this.next = ok || this.tries >= T.tries ? ((this.step + 1) as TutorialStep) : this.step;
    this.line = this.verdict(kill) + (this.next === this.step && this.step !== 1 ? ' One more.' : '');
    this.beat = 'result';
    this.stepT = 0;
    this.waiting = false;
    this.cue = null;
  }

  /** real-time clocks: the welcome, the coach's line after a rep, the hand-off */
  tick(dt: number, anyKey = false): void {
    if (!this.active) return;
    this.stepT += dt;
    this.swallowFor = Math.max(0, this.swallowFor - dt);
    if (this.step === 0) {
      if (this.stepT >= T.welcome || (anyKey && this.stepT > 0.3)) this.enter(1);
    } else if (this.beat === 'result') {
      if (this.stepT >= T.result || (anyKey && this.stepT > T.resultMin)) this.enter(this.next);
    }
    if (this.waiting) {
      this.waitT += dt;
      if (!this.stuck && this.waitT >= T.nudge) {
        this.stuck = true;
        this.onStuck?.();
      }
    } else {
      this.waitT = 0;
      this.stuck = false;
    }
  }

  /** once per frame, after the simulation: the game speed, the cue and what to do for the player */
  guide(f: GuideFacts): GuideOut {
    const out = idleOut();
    this.cue = null;
    if (!this.active || !this.live || this.step < 1 || this.step > 3 || this.beat === 'result') {
      this.waiting = false;
      return out;
    }
    const r = this.rep;
    if (this.serving && f.setUp) r.tossed = true;
    // what the hitter did with this set (the jog back to the start before it is not a run)
    if (f.setUp && f.startD > T.ranDist) r.ran = true;
    if (f.state === 'air') r.jumped = true;
    else if (r.jumped && f.state !== 'load') r.landed = true;
    if (f.charge >= 0) r.drew = true;
    if (this.step === 1) this.together(f, out);
    else this.alone(f, out);
    this.wasAttack = f.attack;
    this.waiting = out.waiting;
    return out;
  }

  /** paused (the clocks stop with it): the click that takes the pointer back is not the swing */
  onPause(): void {
    if (this.active) this.swallowFor = T.resumeGrace;
  }

  /** the coach's line at the bottom of the screen */
  hint(): string {
    if (!this.active) return '';
    if (this.step === 0)
      return this.serving
        ? `The ${serveName(this.lesson as ServeKind)}, in three balls. We'll serve the first one together.`
        : TEXT.welcome;
    if (this.beat === 'result') return this.line;
    if (this.nudge) return this.nudge;
    if (this.step === 1 && this.serving && this.beat === 'watch' && !this.cue) return TEXT.watchToss;
    if (this.stage === 0 && !this.cue) {
      if (this.step === 1) return this.serving ? TEXT.toss : TEXT.watch;
      if (this.step === 2) return TEXT.slowIntro;
      return this.serving ? (this.standing ? TEXT.floatSolo : TEXT.serveSolo) : TEXT.soloIntro;
    }
    return '';
  }

  /** the title pinned at the top */
  label(): string | null {
    switch (this.step) {
      case 1:
        return '1 / 3 · TOGETHER';
      case 2:
        return '2 / 3 · SLOW MOTION';
      case 3:
        return '3 / 3 · FULL SPEED';
      default:
        return null;
    }
  }

  /** Early / Late say what the ball actually does */
  gradeSub(grade: Grade, fallback: string): string {
    if (!this.active) return fallback;
    if (grade === 'Early') return "You're under the ball: it sails long";
    if (grade === 'Late') return 'Over the top: into the net';
    return fallback;
  }

  // ---------------------------------------------------------------- rep 1: together

  /**
   * The ball waits for you. Each beat has one thing to hold (or let go of). Time runs while
   * you do it, eases down as its moment comes if you have not yet, and stops at the moment
   * until you do. Held buttons count whenever they went down.
   */
  private together(f: GuideFacts, out: GuideOut): void {
    // a beat that is already over hands on to the next one within the same frame
    for (let i = 0; i < 6; i++) {
      switch (this.beat) {
        case 'toss': {
          // a serve starts with the server's own toss: nothing moves until it goes up
          out.drive = 'stand';
          this.stage = this.at('toss');
          if (f.setUp) {
            this.beat = 'watch';
            continue;
          }
          const held = f.tossHeld ?? -1;
          // held: the lesson lets go at the serve's own toss, so the rest of the rep is the serve's own timing
          if (held >= 0 && held >= (f.tossAt ?? 0) - STEP) out.act = 'toss';
          this.show('toss', held >= 0 ? TEXT.tossHeld : TEXT.toss, false);
          return;
        }
        case 'watch': {
          out.drive = 'stand';
          if (this.standing) {
            // a standing float: the toss goes up, and the arm is drawn as it tops out
            this.stage = this.at('draw');
            const at = f.drawAt ?? -1;
            if (at < 0) return;
            if (reached(f.simTime, at)) {
              this.beat = 'draw';
              this.airAt = at - T.drawDelay;
              continue;
            }
            const until = at - f.simTime;
            out.scale = f.attack ? T.watchScale : this.ease(until, T.watchScale);
            out.stopAt = at;
            if (until < T.cueLead) this.show('draw', TEXT.drawFloat, false);
            return;
          }
          this.stage = this.at('run');
          // the toss and the set play at full speed: nothing to do yet
          if (!f.setUp || f.tGo < 0) return;
          const until = f.tGo - f.simTime;
          if (reached(f.simTime, f.tGo)) {
            this.beat = 'run';
            continue;
          }
          out.scale = f.run ? T.watchScale : this.ease(until, T.watchScale);
          out.stopAt = f.tGo;
          if (until < T.cueLead) this.show('run', TEXT.run, false);
          return;
        }
        case 'run': {
          out.drive = 'run';
          this.stage = this.at('run');
          const until = f.tPlant - f.simTime;
          if (reached(f.simTime, f.tPlant) || f.state !== 'ground') {
            this.beat = 'plant';
            continue;
          }
          if (!f.run) {
            this.stop(out);
            this.show('run', TEXT.run, true);
            this.nudge = f.move ? (this.touch ? TEXT.sprintTouch : TEXT.sprint) : '';
            return;
          }
          this.nudge = '';
          out.scale = f.jump ? T.runScale : this.ease(until, T.runScale);
          out.stopAt = f.tPlant;
          if (until < T.cueLead) this.show('jump', TEXT.jump, false);
          else this.show('run', TEXT.run, false);
          return;
        }
        case 'plant': {
          this.stage = this.at('jump');
          this.nudge = '';
          if (f.state === 'air') {
            this.beat = 'draw';
            this.airAt = f.simTime;
            continue;
          }
          if (f.state === 'load') {
            if (!f.jump) {
              this.stop(out);
              this.show('jump', TEXT.load, true);
              return;
            }
            out.scale = T.plantScale;
            if (f.loadT >= f.hold - STEP) out.act = 'takeoff';
            this.show('jump', TEXT.load, false);
            return;
          }
          // on the spot, on the floor: the plant starts the moment Space is down
          out.drive = 'run';
          if (f.jump) {
            out.act = 'plant';
            out.scale = T.plantScale;
            this.show('jump', TEXT.load, false);
          } else {
            this.stop(out);
            this.show('jump', TEXT.jump, true);
          }
          return;
        }
        case 'draw': {
          this.stage = this.at('draw');
          if (!this.inPlay(f)) {
            // landed without a swing (it should not happen): the drill ends the rep and we go again
            this.beat = 'swing';
            return;
          }
          if (f.charge >= 1) {
            this.beat = 'hit';
            continue;
          }
          if (f.charge < 0) {
            if (f.attack) {
              // the arm goes back now, and the ring fills while the ball waits
              out.act = 'draw';
              this.freeze(out);
              this.show('draw', TEXT.fill, false);
              return;
            }
            // leave the floor first: the cue comes a moment into the jump
            if (!reached(f.simTime, this.airAt + T.drawDelay)) {
              out.scale = T.airScale;
              out.stopAt = this.airAt + T.drawDelay;
              this.show('draw', this.standing ? TEXT.drawFloat : TEXT.draw, false);
              return;
            }
            this.stop(out);
            this.show('draw', this.standing ? TEXT.drawFloat : TEXT.draw, true);
            return;
          }
          // drawing: the charge fills in real time while it is held
          if (f.attack) {
            this.freeze(out);
            out.fill = true;
            this.show('draw', TEXT.fill, false);
          } else {
            this.stop(out);
            this.show('draw', TEXT.fill, true);
          }
          return;
        }
        case 'hit': {
          this.stage = this.at('hit');
          if (!this.inPlay(f) || f.charge < 0) {
            this.beat = 'swing';
            return;
          }
          const fell = this.wasAttack && !f.attack && this.swallowFor <= 0;
          const sweet = f.sweetAt > 0 && reached(f.simTime, f.sweetAt);
          if (!sweet) {
            // riding up to the gold: letting go early costs nothing here, the arm stays drawn
            out.scale = T.airScale;
            if (f.sweetAt > 0) out.stopAt = f.sweetAt;
            if (fell) this.nudge = TEXT.notYet;
            else if (f.attack) this.nudge = '';
            this.show('hit', f.attack ? TEXT.ride : TEXT.notYet, false);
            return;
          }
          this.nudge = '';
          if (fell) {
            out.act = 'swing';
            this.beat = 'swing';
            this.stage = this.order.length;
            return;
          }
          this.stop(out);
          this.show('hit', f.attack ? TEXT.now : this.touch ? TEXT.tap : TEXT.click, true);
          return;
        }
        default:
          // the swing is on its way: real time until the ball is down
          this.nudge = '';
          return;
      }
    }
  }

  // ---------------------------------------------------------------- reps 2 and 3: you drive

  /** the same four cues read off what the hitter is doing; nothing waits and nothing is done for them */
  private alone(f: GuideFacts, out: GuideOut): void {
    const r = this.rep;
    const slow = this.step === 2;
    this.nudge = '';
    if (r.swung || r.landed) {
      this.stage = r.swung ? this.order.length : this.stage;
      return;
    }
    if (slow && f.setUp) out.scale = T.slowScale;
    if (f.swinging) {
      this.stage = this.at('hit');
      return;
    }
    if (this.serving && !f.setUp) {
      // the toss is the first thing, and the player's own
      this.stage = this.at('toss');
      if (slow) this.show('toss', (f.tossHeld ?? -1) >= 0 ? TEXT.tossMark : TEXT.toss, false);
      return;
    }
    if (this.standing) {
      const drawn = f.charge >= 0;
      this.stage = this.at(drawn ? 'hit' : 'draw');
      if (!slow) return;
      if (drawn) this.show('hit', TEXT.ride, false);
      else if (f.drawAt !== undefined && f.drawAt > 0 && f.simTime >= f.drawAt - T.reactLead) this.show('draw', TEXT.drawFloat, false);
      return;
    }
    if (f.state === 'air') {
      this.stage = this.at(f.charge >= 0 ? 'hit' : 'draw');
      if (slow) {
        if (f.charge >= 0) this.show('hit', TEXT.ride, false);
        else this.show('draw', TEXT.draw, false);
      }
      return;
    }
    if (f.state === 'load') {
      this.stage = this.at('jump');
      if (slow) this.show('jump', TEXT.load, false);
      return;
    }
    if (!f.setUp || f.tGo < 0) {
      this.stage = this.at('run');
      return;
    }
    // on the floor with the set up: run from GO, and the jump cue as the spot comes up
    // (a cue a reaction time ahead of its moment, so acting on it is on time)
    this.stage = this.at(r.ran && f.simTime >= f.tPlant - T.reactLead ? 'jump' : 'run');
    if (!slow) return;
    if (this.stage === this.at('jump')) this.show('jump', TEXT.jump, false);
    else if (f.simTime >= f.tGo - T.reactLead) this.show('run', TEXT.run, false);
  }

  // ---------------------------------------------------------------- helpers

  /** the hitter can still meet the ball: in the air, or for a standing float on the floor under the toss */
  private inPlay(f: GuideFacts): boolean {
    return this.standing ? f.state === 'ground' || f.state === 'land' : f.state === 'air';
  }

  /** game speed into a moment the player has not acted on yet: down to a crawl as it comes */
  private ease(until: number, base: number): number {
    return base * clamp(until / T.easeLead, T.crawl, 1);
  }

  /** the ball waits for the player */
  private stop(out: GuideOut): void {
    out.scale = 0;
    out.snap = true;
    out.waiting = true;
  }

  /** time is stopped while the player is doing the thing (the ring fills) */
  private freeze(out: GuideOut): void {
    out.scale = 0;
    out.snap = true;
  }

  private show(id: CueId, text: string, waiting: boolean): void {
    this.cue = { id, keys: KEYS[id], text, waiting };
  }

  /** one thing about the rep, the first thing that went wrong */
  private verdict(kill: boolean): string {
    const r = this.rep;
    if (this.serving) return this.serveVerdict(kill);
    if (this.step === 1) {
      if (!r.swung || r.grade === 'Miss') return TEXT.again;
      return `${r.grade === 'Perfect' ? 'Perfect.' : 'Nice.'} That is the whole spike: run, jump, draw, hit.`;
    }
    if (!r.ran) return `Run in when the set goes up: hold ${KEYS.run}.`;
    if (!r.jumped) return `Jump from the line: hold ${KEYS.jump} as your feet reach it.`;
    if (!r.swung) {
      return r.drew ? `Let go of ${KEYS.hit} to swing.` : `In the air, hold ${KEYS.draw}, then let go as the ball arrives.`;
    }
    // the timing was there and the ball still missed their court: that was the aim
    if ((r.grade === 'Perfect' || r.grade === 'Good') && !kill) return `${r.grade} timing, but it missed their court. ${TEXT.aim}`;
    switch (r.grade) {
      case 'Perfect':
        return 'Perfect. Right on the gold.';
      case 'Good':
        // a Good with the timing right was the feet: say which
        if (r.note === 'Reaching') return 'Good, but you were reaching for it. Follow the arrows to the line.';
        if (r.note === 'Jumped early') return 'Good, but you jumped early. Wait for the line.';
        if (r.note === 'Jumped late') return `Good, but you jumped late. Hold ${KEYS.jump} as you reach the line.`;
        return 'Good. Just off the gold.';
      case 'Early':
        return 'Early: you were under the ball and it sails long. Let go a touch later.';
      case 'Late':
        return 'Late: over the top and into the net. Let go a touch sooner.';
      default:
        if (r.note === 'Swung early') return 'You swung before the ball got there. Wait for the gold.';
        if (r.note === 'Swung late') return 'The ball was past you. Let go sooner.';
        return 'The ball was out of reach. Jump from the line and you land on the spot.';
    }
  }

  /** one thing about a serve, the first thing that went wrong */
  private serveVerdict(kill: boolean): string {
    const r = this.rep;
    const kind = this.lesson as ServeKind;
    if (this.step === 1) {
      if (!r.swung || r.grade === 'Miss') return TEXT.again;
      const parts = this.order.map((id) => id).join(', ');
      return `${r.grade === 'Perfect' ? 'Perfect.' : 'Nice.'} That is the whole ${serveName(kind)}: ${parts}.`;
    }
    if (!r.tossed) return `Hold ${KEYS.toss} and let go to toss.`;
    if (!this.standing) {
      if (!r.ran) return `Run in when you see GO: hold ${KEYS.run}.`;
      if (!r.jumped) return `Jump at the spot: hold ${KEYS.jump} as your feet reach the line on the floor.`;
    }
    if (!r.swung) {
      if (r.drew) return `Let go of ${KEYS.hit} to serve.`;
      return this.standing
        ? `As the toss tops out, hold ${KEYS.draw}, then let go as the ball comes down.`
        : `In the air, hold ${KEYS.draw}, then let go as the ball comes down.`;
    }
    if (r.why === 'FOOT FAULT') return 'Foot fault: you were on the end line. Toss from further back, or jump sooner.';
    const clean = r.grade === 'Perfect' || r.grade === 'Good';
    if (clean && !kill) {
      const where = r.why === 'IN THE NET' || r.why === 'SHORT' ? 'it was in the net' : 'it was out';
      return `${r.grade} timing, but ${where}. ${TEXT.aim}`;
    }
    switch (r.grade) {
      case 'Perfect':
        return 'Perfect. Right on the gold.';
      case 'Good':
        if (r.note === 'Reaching') return 'Good, but you were reaching for it. Toss at the mark and follow the arrows.';
        if (r.note === 'Jumped early') return 'Good, but you jumped early. Wait for the line.';
        if (r.note === 'Jumped late') return `Good, but you jumped late. Hold ${KEYS.jump} as you reach the line.`;
        return 'Good. Just off the gold.';
      case 'Early':
        return 'Early: you were under the ball. Let go a touch later.';
      case 'Late':
        return 'Late: over the top of the ball. Let go a touch sooner.';
      default:
        if (r.note === 'Swung early') return 'You swung while the toss was still going up. Wait for it to come down.';
        if (r.note === 'Swung late') return 'The ball was past you. Let go sooner.';
        return this.standing
          ? 'The ball was out of reach. Toss at the mark.'
          : 'The ball was out of reach. Toss at the mark and jump from the line.';
    }
  }

  private resetRep(): void {
    this.rep = freshRep();
    this.beat = this.serving ? 'toss' : 'watch';
    this.stage = 0;
    this.cue = null;
    this.waiting = false;
    this.waitT = 0;
    this.nudge = '';
    this.airAt = -1;
    this.wasAttack = false;
  }

  private enter(step: TutorialStep): void {
    if (!this.active) return;
    const changed = step !== this.step;
    this.step = step;
    this.stepT = 0;
    if (changed) this.tries = 0;
    this.resetRep();
    this.live = false;
    // the three balls are done: the lesson is over, and the game offers what to do next
    if (step >= LAST_STEP) this.active = false;
    if (changed) this.onStep?.(step);
  }
}

// ---------------------------------------------------------------- the session

/** what the drill tells the lesson about the approach for the set in the air */
export interface ApproachLine {
  /** sim times of a perfect run's start and plant (-1: no set planned yet), and the load hold */
  tGo: number;
  tPlant: number;
  hold: number;
  /** the run's direction (unit, xz) and the body's yaw down it */
  dirX: number;
  dirZ: number;
  yaw: number;
  /** where the feet are at contact, where the run starts, and where on it the plant starts (null: not known yet) */
  spot: { x: number; z: number };
  start: { x: number; z: number };
  plant: { x: number; z: number } | null;
}

/** The director wired to the game: it gathers the facts, and applies the answer to the clock, the hitter and the HUD. */
export class Tutorial {
  readonly director = new TutorialDirector();
  private out: GuideOut = idleOut();
  private runHeld = false;
  private moveHeld = false;
  /** this browser already finished or skipped the lesson: taking it again leaves that as it is */
  private settled = false;

  constructor(private g: Game) {
    this.director.onStep = (step) => {
      this.save(step);
      if (step < LAST_STEP) {
        this.applyChrome();
        return;
      }
      this.out = idleOut();
      this.clearChrome();
      this.g.onTutorialDone?.(this.director.clean, this.director.lesson);
    };
    this.director.onStuck = () => this.g.hud.setNudge(true);
    g.hud.onSkip = () => this.requestSkip();
  }

  get active(): boolean {
    return this.director.active;
  }

  get step(): TutorialStep {
    return this.director.step;
  }

  /** the spike, or a serve */
  get lesson(): Lesson {
    return this.director.lesson;
  }

  /** a serve lesson is running */
  get serving(): boolean {
    return this.director.active && this.director.serving;
  }

  /** time is stopped for the player */
  get waiting(): boolean {
    return this.director.active && this.director.waiting;
  }

  /** the lesson is on screen */
  get teaching(): boolean {
    return this.director.active;
  }

  holdingFeed(): boolean {
    return this.director.holdingFeed();
  }

  holdingResult(): boolean {
    return this.director.holdingResult();
  }

  /** the together rep reads jump and attack as held buttons: their press and release edges do nothing */
  ownsButtons(): boolean {
    return this.director.guiding();
  }

  /** block and pass stay quiet while one swing is being taught */
  quiet(): boolean {
    return this.director.quiet();
  }

  /** the floor arrows lead to the spot in the two guided reps; the last rep has the spot alone */
  showPath(): boolean {
    return this.director.active && (this.director.step === 1 || this.director.step === 2) && !this.director.holdingResult();
  }

  /** the ball is waiting for the run */
  urgeRun(): boolean {
    return this.waiting && this.director.cue?.id === 'run';
  }

  timeScale(): number {
    return this.director.active ? this.out.scale : 1;
  }

  snapScale(): boolean {
    return this.director.active && this.out.snap;
  }

  stopAt(): number {
    return this.director.active ? this.out.stopAt : Infinity;
  }

  wantsContactDip(): boolean {
    return this.director.active && this.director.step === 3;
  }

  stuck(): boolean {
    return this.director.stuck;
  }

  begin(opts: TutorialBegin = {}): void {
    const lesson = opts.lesson ?? 'spike';
    // (a serve lesson is taken from Learn and always starts at its welcome, unless told a step)
    const step = clampStep(opts.step !== undefined ? opts.step : opts.replay || lesson !== 'spike' ? 0 : resumeStep(readTutorialFlag()));
    this.out = idleOut();
    this.settled = lesson !== 'spike' || !tutorialPending(readTutorialFlag());
    this.director.begin(step, lesson);
    this.save(step);
  }

  /**
   * remember how far the lesson has got (a lesson taken again by someone who is done with it
   * changes nothing). A serve lesson is only remembered once it is finished.
   */
  private save(step: TutorialStep): void {
    const lesson = this.director.lesson;
    if (lesson !== 'spike') {
      if (step >= LAST_STEP) markServeLessonDone(lesson);
      return;
    }
    if (this.settled) return;
    writeTutorialFlag(step >= LAST_STEP ? 'done' : `in_progress:${step}`);
  }

  present(): void {
    this.applyChrome();
    this.g.hud.clearFlash();
    this.g.hud.dip();
    if (this.director.step === 0)
      this.g.hud.showBanner(this.director.serving ? 'Serve it yourself.' : 'True to the court.', 'neutral', T.welcome);
  }

  /**
   * Skip. The welcome returns to the start screen. Anywhere else: cancel the half-taught rep
   * and put the athlete on the ground at the approach start (a jog back would leave a hitter
   * frozen in the air falling through the jump).
   */
  requestSkip(): 'menu' | 'drill' | null {
    if (!this.teaching) return null;
    const where: 'menu' | 'drill' = this.director.step === 0 ? 'menu' : 'drill';
    this.cancelAction();
    this.out = idleOut();
    this.g.snapTutor();
    this.director.skip();
    if (!this.settled) writeTutorialFlag('skipped');
    this.clearChrome();
    if (where === 'drill') this.g.mode?.restartRep(true);
    this.g.hud.dip();
    this.g.onTutorialSkipped?.(where);
    return where;
  }

  /**
   * Leave the lesson without finishing or skipping it (quit to the menu): it stops here, and the
   * saved step stays, so the start screen offers the rest of it next time.
   */
  leave(): void {
    if (!this.director.active) return;
    this.cancelAction();
    this.out = idleOut();
    this.g.snapTutor();
    this.director.skip();
    this.clearChrome();
  }

  /**
   * After the player's input has been read. Remembers what they are holding, then, in the
   * together rep, holds the hitter on the coach's line: still until GO, then down the line to
   * the spot. What the player holds decides whether time runs, not where the feet go.
   */
  drive(me: Athlete): void {
    this.moveHeld = Math.hypot(me.cmd.moveX, me.cmd.moveZ) > 0.5;
    this.runHeld = this.moveHeld && me.cmd.sprint;
    // (the jog back to the start between reps is the player's, or the drill's)
    if (!this.director.guiding() || this.g.userReturning) return;
    const line = this.g.mode?.approachLine?.() ?? null;
    const run = this.out.drive === 'run' && line && me.state === 'ground';
    me.cmd.moveX = run ? line.dirX : 0;
    me.cmd.moveZ = run ? line.dirZ : 0;
    me.cmd.sprint = !!run;
    if (line && me.state !== 'air') me.cmd.faceYaw = line.yaw;
  }

  /** once per frame after the simulation (real time): runs even while the ball waits */
  frame(realDt: number): void {
    const g = this.g;
    const d = this.director;
    const was = d.active;
    d.touch = g.input.touch;
    const talking = d.step === 0 || d.holdingResult();
    d.tick(realDt, talking ? g.input.consumeAny() : false);
    if (was && !d.active) {
      this.clearChrome();
      this.out = idleOut();
      return;
    }
    const me = g.me;
    const line = g.mode?.approachLine?.() ?? null;
    const wind = me.action?.kind === 'windup' ? me.action : null;
    const attack = g.user.isHeld('attack');
    // the charge fills in real time while the ball waits on the draw
    if (this.out.fill && wind && attack) wind.t0 -= realDt;
    const charge = wind ? ContactSystem.chargeFor(g.simTime - wind.t0) : -1;
    const lt = g.ball.lastTouch;
    // a serve's toss is up from the moment it leaves the hand (and still counts once it is served)
    const tossUp = g.ball.active && !!lt && lt.athlete === me && (lt.kind === 'feed' || lt.kind === 'serve');
    // a standing float is met from the floor: where the toss comes down to the hand (as the drill sees it)
    let ideal = me.state === 'air' ? g.idealT() : -1;
    if (d.standing && tossUp && g.contact.serving === me) ideal = g.contact.ideal(me, g.simTime, T.floatDraw + 1)?.t ?? -1;
    const lead = ContactSystem.swingLead(Math.max(0, charge));
    const out = d.guide({
      simTime: g.simTime,
      setUp: d.serving ? tossUp : g.ball.active && lt?.kind === 'set',
      tGo: line?.tGo ?? -1,
      tPlant: line?.tPlant ?? -1,
      hold: line?.hold ?? PLAYER.loadMax,
      state: me.state,
      loadT: me.loadT,
      charge,
      swinging: me.action?.kind === 'swing',
      sweetAt: ideal > 0 ? ideal - lead + T.sweetErr : -1,
      run: this.runHeld,
      move: this.moveHeld,
      jump: g.user.isHeld('jump'),
      attack,
      startD: line ? Math.hypot(me.pos.x - line.start.x, me.pos.z - line.start.z) : 0,
      tossHeld: g.actions.tossHeld(),
      tossAt: tossGroove(),
      drawAt: d.standing && ideal > 0 ? ideal - T.floatDraw : -1,
    });
    this.out = out;
    switch (out.act) {
      case 'toss':
        g.actions.releaseToss();
        break;
      case 'plant':
        me.jumpPress();
        break;
      case 'takeoff':
        me.jumpRelease();
        break;
      case 'draw':
        if (!wind) g.contact.beginWindup(me);
        break;
      case 'swing': {
        const swing = g.contact.releaseWindup(me);
        if (swing) g.notePress(swing.err, swing.contactT);
        break;
      }
    }
    g.hud.setFrozen(d.waiting);
    g.hud.setNudge(d.stuck);
    g.hud.setCoach(d.step >= 1 && d.step <= 3 ? { stage: d.stage, cue: d.cue, order: d.order } : null);
  }

  noteFeed(): void {
    this.director.noteFeed();
  }

  noteContact(grade: Grade, note = ''): void {
    this.director.noteContact(grade, note);
  }

  noteRepEnd(kill = false, why = ''): void {
    this.director.noteRepEnd(kill, why);
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
    this.g.hud.setTutorialChrome(this.teaching);
    this.g.hud.suppressCalls = on;
    this.g.hud.setFrozen(this.waiting);
    this.g.hud.pinMessage(on ? this.director.label() : null);
    if (!on || this.director.step < 1 || this.director.step > 3) this.g.hud.setCoach(null);
  }

  private clearChrome(): void {
    // the drill's own title and score line come back (the lesson shortened them)
    this.g.mode?.refreshHud?.();
    this.g.hud.setTutorialChrome(false);
    this.g.hud.suppressCalls = false;
    this.g.hud.setFrozen(false);
    this.g.hud.setNudge(false);
    this.g.hud.setCoach(null);
    this.g.hud.pinMessage(null);
  }
}
