import { describe, expect, it } from 'vitest';
import { isDirectLockedTravel } from '../src/core/input';
import { TOUCH_KEY_LABELS } from '../src/ui/touchControls';
import { translateKeyMarkup } from '../src/ui/hud';
import {
  COLLAR_DEG_PER_S,
  TEXT,
  TUTORIAL_KEY,
  TutorialDirector,
  collarDegrees,
  collarZone,
  jumpLoadFrac,
  reached,
  readTutorialFlag,
  resumeStep,
  tutorialOffer,
  tutorialPending,
  writeTutorialFlag,
  type GuideFacts,
  type GuideOut,
  type TutorialStorage,
} from '../src/game/tutorial';
import { PLAYER, SIM, TIMING, TUTORIAL as T } from '../src/config';

function mem(): TutorialStorage & { raw: Map<string, string> } {
  const raw = new Map<string, string>();
  return {
    raw,
    getItem: (k) => (raw.has(k) ? raw.get(k)! : null),
    setItem: (k, v) => {
      raw.set(k, v);
    },
  };
}

/** one high ball: GO at 1.0 s, the plant at 1.4 s, a 0.28 s load, the ball best met at 2.1 s */
const SET = { tGo: 1.0, tPlant: 1.4, hold: 0.28, ideal: 2.1, lead: TIMING.swingCharged };
const FRAME = 1 / 60;
const STEP = 1 / SIM.hz;

type Held = { run?: boolean; move?: boolean; jump?: boolean; attack?: boolean };

/**
 * A stand-in for the game around the director: a clock that runs at the speed the lesson asks
 * for and never past the moment it waits at, a hitter who does what the lesson does for them,
 * and the buttons the test holds.
 */
class Court {
  d = new TutorialDirector();
  simTime = 0;
  state: GuideFacts['state'] = 'ground';
  loadT = 0;
  /** real seconds the arm has been drawn while the ball waited, on top of game time */
  private drawn = -1;
  private airAt = -1;
  private accum = 0;
  swungAt = -1;
  held: Held = {};
  out!: GuideOut;
  /** real seconds the ball has waited for the player */
  waited = 0;
  /** every cue shown, in order (changes only) */
  cues: string[] = [];

  constructor(step: 1 | 2 | 3 = 1) {
    this.d.begin(step);
    this.d.noteFeed();
    this.out = this.d.guide(this.facts());
  }

  private charge(): number {
    if (this.drawn < 0 || this.swungAt >= 0) return -1;
    return Math.min(1, Math.max(0, (this.drawn - TIMING.tapThreshold) / (TIMING.chargeFull - TIMING.tapThreshold)));
  }

  facts(): GuideFacts {
    const air = this.state === 'air';
    return {
      simTime: this.simTime,
      setUp: this.simTime >= 0.5,
      tGo: this.simTime >= 0.5 ? SET.tGo : -1,
      tPlant: this.simTime >= 0.5 ? SET.tPlant : -1,
      hold: SET.hold,
      state: this.state,
      loadT: this.loadT,
      charge: this.charge(),
      swinging: this.swungAt >= 0,
      sweetAt: air ? SET.ideal - SET.lead + T.sweetErr : -1,
      run: !!this.held.run,
      move: !!this.held.run || !!this.held.move,
      jump: !!this.held.jump,
      attack: !!this.held.attack,
      startD: this.simTime > SET.tGo + 0.2 ? 2 : 0,
    };
  }

  /** one render frame of real time */
  frame(): void {
    const o = this.out;
    // the clock: the lesson's speed, and never past the moment it waits at
    this.accum += FRAME * o.scale;
    while (this.accum >= STEP - 1e-9) {
      if (reached(this.simTime, o.stopAt)) {
        this.accum = 0;
        break;
      }
      this.simTime += STEP;
      this.accum -= STEP;
      if (this.state === 'load') {
        this.loadT += STEP;
        if (this.loadT >= PLAYER.loadMax) this.takeoff();
      }
      if (this.drawn >= 0) this.drawn += STEP;
    }
    if (o.fill && this.held.attack && this.drawn >= 0) this.drawn += FRAME;
    this.d.tick(FRAME);
    this.out = this.d.guide(this.facts());
    if (this.out.waiting) this.waited += FRAME;
    const cue = this.d.cue ? `${this.d.cue.id}${this.d.cue.waiting ? '!' : ''}` : '';
    if (cue && cue !== this.cues[this.cues.length - 1]) this.cues.push(cue);
    switch (this.out.act) {
      case 'plant':
        this.state = 'load';
        this.loadT = 0;
        break;
      case 'takeoff':
        this.takeoff();
        break;
      case 'draw':
        this.drawn = 0;
        break;
      case 'swing':
        this.swungAt = this.simTime;
        break;
    }
  }

  private takeoff(): void {
    this.state = 'air';
    this.airAt = this.simTime;
  }

  /** frames until `done`, at most `max` real seconds; false if it never happened */
  until(done: () => boolean, max = 20): boolean {
    for (let t = 0; t < max; t += FRAME) {
      if (done()) return true;
      this.frame();
    }
    return done();
  }

  /** `sec` real seconds */
  run(sec: number): void {
    for (let t = 0; t < sec - 1e-9; t += FRAME) this.frame();
  }

  /** how late the swing was let go (s): 0 is the best moment */
  get releaseErr(): number {
    return this.swungAt + SET.lead - SET.ideal;
  }

  get tookOffAt(): number {
    return this.airAt;
  }
}

describe('tutorial flag', () => {
  it('stores done, skipped and in_progress under courtFeel.tutorial.v1', () => {
    const s = mem();
    expect(readTutorialFlag(s)).toBeNull();
    expect(tutorialPending(null)).toBe(true);
    writeTutorialFlag('in_progress:2', s);
    expect(s.raw.get(TUTORIAL_KEY)).toBe('in_progress:2');
    expect(resumeStep(readTutorialFlag(s))).toBe(2);
    expect(tutorialPending('in_progress:2')).toBe(true);
    writeTutorialFlag('done', s);
    expect(tutorialPending('done')).toBe(false);
    writeTutorialFlag('skipped', s);
    expect(tutorialPending('skipped')).toBe(false);
    expect(resumeStep('nope')).toBe(0);
    expect(resumeStep('in_progress:9')).toBe(0);
  });

  it('the start screen offers the lesson to a new visitor, the rest of it to one who left part-way, and nothing after that', () => {
    expect(tutorialOffer(null)).toBe('new');
    // left during the welcome line: nothing has been played yet
    expect(tutorialOffer('in_progress:0')).toBe('new');
    expect(tutorialOffer('in_progress:2')).toBe('resume');
    expect(tutorialOffer('done')).toBeNull();
    expect(tutorialOffer('skipped')).toBeNull();
    // a value this build does not know is a visitor it has not met
    expect(tutorialOffer('nope')).toBe('new');
  });

  it('a lesson saved by the older build past its guided swing resumes at the full-speed rep', () => {
    expect(resumeStep('in_progress:4')).toBe(3);
    expect(resumeStep('in_progress:6')).toBe(3);
  });
});

describe('together: the ball waits for you', () => {
  it('a button already held when its moment comes counts: nobody lets go and presses again', () => {
    // everything down before the set is even up, and never let go until the gold
    const c = new Court();
    c.held = { run: true, jump: true, attack: true };
    expect(c.until(() => c.d.beat === 'hit' && c.out.waiting)).toBe(true);
    // the only time the ball waited was at the gold, for the release
    expect(c.waited).toBeLessThanOrEqual(FRAME + 1e-9);
    expect(c.d.cue).toMatchObject({ id: 'hit', text: TEXT.now, waiting: true });
    c.held = {};
    c.frame();
    expect(c.out.act).toBe('swing');
  });

  it('the ball waits at GO until you sprint, and stops again the moment you let go', () => {
    const c = new Court();
    c.run(6);
    expect(c.d.beat).toBe('run');
    expect(c.out.waiting).toBe(true);
    expect(c.out.scale).toBe(0);
    // as close to GO as the clock gets: within one step of it, never past it
    expect(SET.tGo - c.simTime).toBeGreaterThanOrEqual(-1e-6);
    expect(SET.tGo - c.simTime).toBeLessThanOrEqual(STEP);
    expect(c.d.cue).toMatchObject({ id: 'run', waiting: true });
    c.held = { run: true };
    c.run(0.2);
    expect(c.out.waiting).toBe(false);
    expect(c.simTime).toBeGreaterThan(SET.tGo + 0.05);
    const at = c.simTime;
    c.held = {};
    c.run(1);
    // one frame to notice, then nothing moves
    expect(c.simTime - at).toBeLessThanOrEqual(FRAME);
    expect(c.out.waiting).toBe(true);
  });

  it('walking is not an approach: with a direction held but no sprint it asks for the sprint', () => {
    const c = new Court();
    c.held = { move: true };
    c.run(6);
    expect(c.out.waiting).toBe(true);
    expect(c.d.hint()).toBe(TEXT.sprint);
    c.d.touch = true;
    c.frame();
    expect(c.d.hint()).toBe(TEXT.sprintTouch);
  });

  it('the coach holds the hitter still until GO and runs them down the line after it', () => {
    const c = new Court();
    c.held = { run: true };
    c.until(() => c.simTime > 0.6);
    expect(c.out.drive).toBe('stand');
    c.until(() => c.d.beat === 'run');
    expect(c.out.drive).toBe('run');
  });

  it('the plant starts on the line, at the planned moment, however late Space comes', () => {
    const c = new Court();
    c.held = { run: true };
    c.until(() => c.d.beat === 'plant');
    c.run(3);
    // the ball waited: the clock is still at the plant
    expect(c.out.waiting).toBe(true);
    expect(SET.tPlant - c.simTime).toBeGreaterThanOrEqual(-1e-6);
    expect(SET.tPlant - c.simTime).toBeLessThanOrEqual(STEP);
    expect(c.state).toBe('ground');
    c.held = { jump: true };
    c.frame();
    expect(c.out.act).toBe('plant');
    c.until(() => c.state === 'air');
    // the jump leaves the floor a full load after the plant, as the approach was planned
    expect(c.tookOffAt).toBeCloseTo(SET.tPlant + SET.hold, 1);
  });

  it('letting go of Space half way through the load stops time: it does not jump early', () => {
    const c = new Court();
    c.held = { run: true, jump: true };
    c.until(() => c.state === 'load' && c.loadT > 0.1);
    c.held = {};
    c.run(2);
    expect(c.state).toBe('load');
    expect(c.out.waiting).toBe(true);
    expect(c.loadT).toBeLessThan(SET.hold);
    c.held = { jump: true };
    c.until(() => c.state === 'air');
    expect(c.tookOffAt).toBeCloseTo(SET.tPlant + SET.hold, 1);
  });

  it('in the air the ball waits for the arm, and the ring fills while it is held', () => {
    const c = new Court();
    c.held = { run: true, jump: true };
    c.until(() => c.d.beat === 'draw' && c.out.waiting);
    expect(c.d.cue).toMatchObject({ id: 'draw', waiting: true });
    const at = c.simTime;
    c.held = { attack: true };
    c.frame();
    expect(c.out.act).toBe('draw');
    // full power needs chargeFull of holding: the clock does not move while the ring fills
    c.run(TIMING.chargeFull * 0.5);
    expect(c.d.beat).toBe('draw');
    expect(c.out.waiting).toBe(false);
    expect(c.simTime).toBeCloseTo(at, 5);
    c.until(() => c.d.beat === 'hit');
    expect(c.simTime).toBeCloseTo(at, 5);
  });

  it('the release is held for you in the gold: letting go there is a Perfect', () => {
    const c = new Court();
    c.held = { run: true, jump: true, attack: true };
    c.until(() => c.d.beat === 'hit' && c.out.waiting);
    c.run(4);
    c.held = {};
    c.until(() => c.swungAt >= 0, 1);
    expect(c.releaseErr).toBeGreaterThanOrEqual(-TIMING.spikePerfect);
    expect(c.releaseErr).toBeLessThanOrEqual(TIMING.spikePerfectLate);
    expect(collarZone(c.releaseErr)).toBe('perfect');
  });

  it('letting go before the gold does not swing: the arm stays drawn and a click at the gold swings', () => {
    const c = new Court();
    c.held = { run: true, jump: true, attack: true };
    c.until(() => c.d.beat === 'hit');
    c.frame();
    c.held = {};
    c.frame();
    expect(c.out.act).toBe('none');
    expect(c.d.hint()).toBe(TEXT.notYet);
    c.until(() => c.out.waiting);
    expect(c.swungAt).toBe(-1);
    expect(c.d.cue).toMatchObject({ id: 'hit', text: TEXT.click, waiting: true });
    // a click: down, then up
    c.held = { attack: true };
    c.frame();
    expect(c.out.act).toBe('none');
    c.held = {};
    c.frame();
    expect(c.out.act).toBe('swing');
    expect(collarZone(c.releaseErr)).toBe('perfect');
  });

  it('the click that takes the pointer back after a pause is not the swing', () => {
    const c = new Court();
    c.held = { run: true, jump: true, attack: true };
    c.until(() => c.d.beat === 'hit' && c.out.waiting);
    c.held = {};
    c.d.onPause();
    // back from the menu: the click on the canvas
    c.held = { attack: true };
    c.frame();
    c.held = {};
    c.frame();
    expect(c.swungAt).toBe(-1);
    // after that a real hold and release swings
    c.run(T.resumeGrace + 0.1);
    c.held = { attack: true };
    c.frame();
    c.held = {};
    c.frame();
    expect(c.out.act).toBe('swing');
  });

  it('the cues come in the order of a spike: run, jump, draw, hit', () => {
    const c = new Court();
    for (const hold of [{ run: true }, { jump: true }, { attack: true }, {}] as Held[]) {
      c.until(() => c.out.waiting);
      c.held = hold;
      c.run(0.1);
    }
    c.until(() => c.swungAt >= 0, 2);
    const waitedOn = c.cues.filter((q) => q.endsWith('!'));
    expect(waitedOn).toEqual(['run!', 'jump!', 'draw!', 'hit!']);
    expect(c.d.stage).toBe(4);
  });

  it('a first-timer who has done nothing for a while gets a nudge, once the ball has waited long enough', () => {
    const c = new Court();
    let stuck = 0;
    c.d.onStuck = () => stuck++;
    c.until(() => c.out.waiting);
    c.run(T.nudge - 0.5);
    expect(c.d.stuck).toBe(false);
    c.run(1);
    expect(c.d.stuck).toBe(true);
    expect(stuck).toBe(1);
    c.held = { run: true };
    c.run(0.1);
    expect(c.d.stuck).toBe(false);
  });
});

describe('slow motion and full speed: you drive', () => {
  it('nothing waits and nothing is done for you', () => {
    for (const step of [2, 3] as const) {
      const c = new Court(step);
      for (let t = 0; t < 4; t += FRAME) {
        c.frame();
        expect(c.out.waiting).toBe(false);
        expect(c.out.scale).toBeGreaterThan(0);
        expect(c.out.act).toBe('none');
        expect(c.out.drive).toBe('none');
        expect(c.out.stopAt).toBe(Infinity);
      }
      expect(c.d.guiding()).toBe(false);
    }
  });

  it('the slow rep slows the set down; the full-speed rep does not', () => {
    const slow = new Court(2);
    slow.until(() => slow.simTime > 0.7);
    expect(slow.out.scale).toBe(T.slowScale);
    const solo = new Court(3);
    solo.until(() => solo.simTime > 0.7);
    expect(solo.out.scale).toBe(1);
  });

  it('the slow rep still names each part as it comes; the full-speed rep only lights the strip', () => {
    const slow = new Court(2);
    slow.until(() => slow.simTime >= SET.tGo);
    expect(slow.d.cue?.id).toBe('run');
    const solo = new Court(3);
    solo.until(() => solo.simTime >= SET.tGo);
    expect(solo.d.cue).toBeNull();
  });
});

describe('the coach says one thing after a rep', () => {
  const played = (
    step: 1 | 2 | 3,
    f: Partial<GuideFacts>,
    grade?: Parameters<TutorialDirector['noteContact']>[0],
    note = '',
    kill = true,
  ) => {
    const d = new TutorialDirector();
    d.begin(step);
    d.noteFeed();
    const base: GuideFacts = {
      simTime: 2,
      setUp: true,
      tGo: 1,
      tPlant: 1.4,
      hold: 0.28,
      state: 'ground',
      loadT: 0,
      charge: -1,
      swinging: false,
      sweetAt: -1,
      run: false,
      move: false,
      jump: false,
      attack: false,
      startD: 0,
    };
    d.guide({ ...base, ...f });
    if (grade) d.noteContact(grade, note);
    d.noteRepEnd(kill);
    return d;
  };

  it('never ran: run in', () => {
    expect(played(2, {}).hint()).toContain('Run in when the set goes up');
  });

  it('ran but never left the floor: jump from the line', () => {
    expect(played(2, { startD: 2 }).hint()).toContain('Jump from the line');
  });

  it('jumped but never drew the arm: hold, then let go', () => {
    expect(played(3, { startD: 2, state: 'air' }).hint()).toContain('In the air, hold');
  });

  it('early sails long, late goes into the net', () => {
    expect(played(2, { startD: 2, state: 'air', charge: 1 }, 'Early').hint()).toContain('sails long');
    expect(played(2, { startD: 2, state: 'air', charge: 1 }, 'Late').hint()).toContain('into the net');
  });

  it('good timing that missed their court was the aim', () => {
    expect(played(3, { startD: 2, state: 'air', charge: 1 }, 'Perfect', '', false).hint()).toContain(TEXT.aim);
  });

  it('a Good from reaching was the feet, not the hand', () => {
    expect(played(3, { startD: 2, state: 'air', charge: 1 }, 'Good', 'Reaching').hint()).toContain('reaching');
  });
});

describe('the lesson moves on', () => {
  const rep = (d: TutorialDirector, grade: 'Perfect' | 'Good' | 'Early' | 'Late' | 'Miss' | null) => {
    d.noteFeed();
    if (grade) d.noteContact(grade);
    d.noteRepEnd(true);
    expect(d.holdingResult()).toBe(true);
    d.tick(T.result + 0.01);
  };

  it('welcome, together, slow motion, full speed, then the court is yours', () => {
    const d = new TutorialDirector();
    const steps: number[] = [];
    d.onStep = (s) => steps.push(s);
    d.begin(0);
    expect(d.holdingFeed()).toBe(true);
    d.tick(T.welcome + 0.01);
    expect(d.holdingFeed()).toBe(false);
    rep(d, 'Perfect');
    rep(d, 'Good');
    rep(d, 'Perfect');
    // the lesson is over the moment the last coach's line is done: the game takes it from there
    expect(steps).toEqual([1, 2, 3, 4]);
    expect(d.active).toBe(false);
    expect(d.clean).toBe(true);
  });

  it('the lesson ends after the full-speed rep whether or not it came off, and says which', () => {
    const d = new TutorialDirector();
    let done = -1;
    d.onStep = (s) => (done = s);
    d.begin(3);
    rep(d, 'Late');
    rep(d, 'Miss');
    expect(done).toBe(4);
    expect(d.active).toBe(false);
    expect(d.clean).toBe(false);
  });

  it('a rep that did not come off is taken once more, then the lesson moves on anyway', () => {
    const d = new TutorialDirector();
    d.begin(2);
    rep(d, 'Late');
    expect(d.step).toBe(2);
    rep(d, null);
    expect(d.step).toBe(3);
    rep(d, 'Miss');
    expect(d.step).toBe(3);
  });

  it('the next toss waits while the coach is talking, and any key moves on once the line has had a second', () => {
    const d = new TutorialDirector();
    d.begin(1);
    d.noteFeed();
    d.noteContact('Perfect');
    d.noteRepEnd(true);
    d.tick(T.resultMin - 0.1, true);
    expect(d.holdingResult()).toBe(true);
    d.tick(0.2, true);
    expect(d.holdingResult()).toBe(false);
    expect(d.step).toBe(2);
  });

  it('the buttons the lesson is not teaching stay quiet in the two guided reps only', () => {
    const d = new TutorialDirector();
    for (const [step, quiet] of [
      [1, true],
      [2, true],
      [3, false],
    ] as const) {
      d.begin(step);
      expect(d.quiet()).toBe(quiet);
    }
  });
});

describe('timing collar', () => {
  it('places Perfect on the gold, Good on the cyan, and a mishit on the wood', () => {
    expect(collarZone(0)).toBe('perfect');
    expect(collarZone(T.sweetErr)).toBe('perfect');
    expect(collarZone(-TIMING.spikePerfect)).toBe('perfect');
    expect(collarZone(TIMING.spikePerfectLate)).toBe('perfect');
    expect(collarZone(-TIMING.spikeGood)).toBe('good');
    expect(collarZone(TIMING.spikeGoodLate)).toBe('good');
    expect(collarZone(-0.15)).toBe('wood');
    expect(collarZone(0.13)).toBe('wood');
    expect(collarDegrees(T.sweetErr)).toBeCloseTo(T.sweetErr * COLLAR_DEG_PER_S, 5);
    expect(collarDegrees(-0.03)).toBeCloseTo(-13.5, 5);
    expect(collarDegrees(0.07)).toBeCloseTo(31.5, 5);
    expect(collarDegrees(-1)).toBe(-90);
    expect(collarDegrees(1)).toBe(72);
  });

  it('the load ring reads empty at the press and full at the longest hold', () => {
    expect(jumpLoadFrac(0)).toBe(0);
    expect(jumpLoadFrac(PLAYER.loadMax)).toBe(1);
  });
});

describe('locked skip chip', () => {
  it('a direct move from the lock anchor onto the chip counts, looking around does not', () => {
    // measured in Chrome: lock at (400, 300), one move of (777, -272) lands on the chip
    const x = 400 + 777;
    const y = 300 - 272;
    const travel = Math.hypot(777, -272);
    expect(isDirectLockedTravel(400, 300, x, y, travel)).toBe(true);
    // the same landing after wandering across the court is a swing, not Skip
    expect(isDirectLockedTravel(400, 300, x, y, travel * 4)).toBe(false);
    expect(isDirectLockedTravel(400, 300, x, y, 0)).toBe(false);
    expect(isDirectLockedTravel(400, 300, 400, 300, 0)).toBe(true);
  });
});

describe('tutorial touch labels', () => {
  it('the cue keys read as the touch buttons: the stick, JUMP and HIT', () => {
    expect(TOUCH_KEY_LABELS['Left mouse']).toBe('HIT');
    expect(TOUCH_KEY_LABELS.Space).toBe('JUMP');
    const c = new Court();
    c.until(() => c.out.waiting);
    expect(translateKeyMarkup(c.d.cue!.keys, TOUCH_KEY_LABELS)).toBe('<kbd>stick out</kbd>');
    c.held = { run: true };
    c.until(() => c.d.beat === 'plant' && c.out.waiting);
    expect(translateKeyMarkup(c.d.cue!.keys, TOUCH_KEY_LABELS)).toBe('<kbd>JUMP</kbd>');
    c.held = { jump: true };
    c.until(() => c.d.beat === 'draw' && c.out.waiting);
    expect(translateKeyMarkup(c.d.cue!.keys, TOUCH_KEY_LABELS)).toBe('<kbd>HIT</kbd>');
  });
});
