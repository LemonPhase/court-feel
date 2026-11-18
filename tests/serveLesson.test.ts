import { describe, expect, it } from 'vitest';
import {
  cueOrder,
  markServeLessonDone,
  readServeLessons,
  reached,
  SERVE_LESSONS_KEY,
  TUTORIAL_KEY,
  TutorialDirector,
  type GuideFacts,
  type GuideOut,
  type Lesson,
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

const FRAME = 1 / 60;
const STEP = 1 / SIM.hz;
/** the hold that gives the serve its own toss (s) */
const GROOVE = 0.36;
/**
 * One toss, times from the moment it leaves the hand: a jump serve's run starts 0.3 s later and
 * plants 0.7 s later, the ball is best met 1.4 s after the toss in the air; a standing float is
 * best met 1.0 s after its toss, from the floor.
 */
const JUMP = { go: 0.3, plant: 0.7, hold: 0.28, ideal: 1.4 };
const FLOAT = { ideal: 1.0 };
const LEAD = TIMING.swingCharged;

type Held = { toss?: boolean; run?: boolean; jump?: boolean; attack?: boolean };

/**
 * A stand-in for the game around a serve lesson: a clock that runs at the speed the lesson asks
 * for, a server who does what the lesson does for them (lets go of the toss, plants, takes off,
 * draws, swings), and the buttons the test holds.
 */
class ServeCourt {
  d = new TutorialDirector();
  simTime = 0;
  state: GuideFacts['state'] = 'ground';
  loadT = 0;
  /** when the toss left the hand (-1: still in it) */
  tossedAt = -1;
  /** when the toss button went down (-1: up) */
  private tossDown = -1;
  private drawn = -1;
  private accum = 0;
  swungAt = -1;
  held: Held = {};
  out!: GuideOut;
  cues: string[] = [];
  /** what the lesson asked the feet to do, frame by frame, before the toss and after it */
  drives: { tossed: boolean; drive: GuideOut['drive']; t: number }[] = [];

  constructor(
    readonly lesson: Lesson,
    step: 1 | 2 | 3 = 1,
  ) {
    this.d.begin(step, lesson);
    this.d.noteFeed();
    this.out = this.d.guide(this.facts());
  }

  private get standing(): boolean {
    return this.lesson === 'float';
  }

  private charge(): number {
    if (this.drawn < 0 || this.swungAt >= 0) return -1;
    return Math.min(1, Math.max(0, (this.drawn - TIMING.tapThreshold) / (TIMING.chargeFull - TIMING.tapThreshold)));
  }

  private at(dt: number): number {
    return this.tossedAt < 0 ? -1 : this.tossedAt + dt;
  }

  facts(): GuideFacts {
    const up = this.tossedAt >= 0;
    const ideal = this.standing ? this.at(FLOAT.ideal) : this.state === 'air' ? this.at(JUMP.ideal) : -1;
    return {
      simTime: this.simTime,
      setUp: up,
      tGo: this.standing ? -1 : this.at(JUMP.go),
      tPlant: this.standing ? -1 : this.at(JUMP.plant),
      hold: JUMP.hold,
      state: this.state,
      loadT: this.loadT,
      charge: this.charge(),
      swinging: this.swungAt >= 0,
      sweetAt: ideal > 0 ? ideal - LEAD + T.sweetErr : -1,
      run: !!this.held.run,
      move: !!this.held.run,
      jump: !!this.held.jump,
      attack: !!this.held.attack,
      startD: up && this.simTime > this.at(JUMP.go) + 0.2 && !this.standing ? 2 : 0,
      tossHeld: this.tossDown < 0 ? -1 : this.simTime - this.tossDown,
      tossAt: GROOVE,
      drawAt: this.standing && up ? this.at(FLOAT.ideal) - T.floatDraw : -1,
    };
  }

  private toss(): void {
    if (this.tossDown < 0 || this.tossedAt >= 0) return;
    this.tossedAt = this.simTime;
    this.tossDown = -1;
  }

  /** press or let go of the toss button */
  setToss(down: boolean): void {
    if (down && !this.held.toss && this.tossedAt < 0) this.tossDown = this.simTime;
    if (!down && this.held.toss) this.toss();
    this.held.toss = down;
  }

  frame(): void {
    const o = this.out;
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
        if (this.loadT >= PLAYER.loadMax) this.state = 'air';
      }
      if (this.drawn >= 0) this.drawn += STEP;
    }
    if (o.fill && this.held.attack && this.drawn >= 0) this.drawn += FRAME;
    this.d.tick(FRAME);
    this.out = this.d.guide(this.facts());
    this.drives.push({ tossed: this.tossedAt >= 0, drive: this.out.drive, t: this.simTime });
    const cue = this.d.cue ? `${this.d.cue.id}${this.d.cue.waiting ? '!' : ''}` : '';
    if (cue && cue !== this.cues[this.cues.length - 1]) this.cues.push(cue);
    switch (this.out.act) {
      case 'toss':
        this.toss();
        break;
      case 'plant':
        this.state = 'load';
        this.loadT = 0;
        break;
      case 'takeoff':
        this.state = 'air';
        break;
      case 'draw':
        this.drawn = 0;
        break;
      case 'swing':
        this.swungAt = this.simTime;
        break;
    }
  }

  until(done: () => boolean, max = 20): boolean {
    for (let t = 0; t < max; t += FRAME) {
      if (done()) return true;
      this.frame();
    }
    return done();
  }

  run(sec: number): void {
    for (let t = 0; t < sec - 1e-9; t += FRAME) this.frame();
  }

  /** hold each button the lesson waits on as it comes, and let go of the last one */
  serveTogether(): void {
    this.setToss(true);
    this.until(() => this.tossedAt >= 0, 3);
    this.setToss(false);
    const holds: Held[] = this.standing ? [{ attack: true }, {}] : [{ run: true }, { run: true, jump: true }, { attack: true }, {}];
    for (const h of holds) {
      this.until(() => this.out.waiting, 5);
      this.held = h;
      this.run(0.1);
    }
    this.until(() => this.swungAt >= 0, 3);
  }
}

describe('serve lessons: what a serve is made of', () => {
  it('a serve starts with the toss; the standing float has no run or jump', () => {
    expect(cueOrder('spike')).toEqual(['run', 'jump', 'draw', 'hit']);
    expect(cueOrder('float')).toEqual(['toss', 'draw', 'hit']);
    expect(cueOrder('jumpFloat')).toEqual(['toss', 'run', 'jump', 'draw', 'hit']);
    expect(cueOrder('jump')).toEqual(['toss', 'run', 'jump', 'draw', 'hit']);
  });
});

describe('serve lessons: together', () => {
  it('nothing happens until the server tosses: the ball is in their hand, and time runs', () => {
    const c = new ServeCourt('jump');
    c.run(2);
    expect(c.cues).toEqual(['toss']);
    expect(c.out.waiting).toBe(false);
    expect(c.simTime).toBeGreaterThan(1.9);
    expect(c.drives.every((d) => d.drive === 'stand')).toBe(true);
  });

  it("the toss goes up at the serve's own height: the lesson lets go of a held toss at the mark", () => {
    const c = new ServeCourt('jumpFloat');
    c.run(0.5);
    const down = c.simTime;
    c.setToss(true);
    expect(c.until(() => c.tossedAt >= 0, 2)).toBe(true);
    expect(c.tossedAt - down).toBeCloseTo(GROOVE, 1);
  });

  it('a jump server stays behind the line until GO, then the lesson runs them in', () => {
    const c = new ServeCourt('jump');
    c.serveTogether();
    const go = c.tossedAt + JUMP.go;
    const before = c.drives.filter((d) => d.tossed && d.t < go - STEP);
    expect(before.length).toBeGreaterThan(0);
    expect(before.every((d) => d.drive === 'stand')).toBe(true);
    expect(c.drives.some((d) => d.t >= go && d.drive === 'run')).toBe(true);
  });

  it('the jump serve and the jump float wait on run, jump, draw and hit, in that order, after the toss', () => {
    for (const lesson of ['jump', 'jumpFloat'] as const) {
      const c = new ServeCourt(lesson);
      c.serveTogether();
      expect(c.cues[0]).toBe('toss');
      expect(c.cues.filter((q) => q.endsWith('!'))).toEqual(['run!', 'jump!', 'draw!', 'hit!']);
      expect(c.swungAt).toBeGreaterThan(0);
    }
  });

  it('the standing float is toss, draw, hit, and is hit from the floor', () => {
    const c = new ServeCourt('float');
    c.serveTogether();
    expect(c.cues[0]).toBe('toss');
    expect(c.cues.filter((q) => q.endsWith('!'))).toEqual(['draw!', 'hit!']);
    expect(c.state).toBe('ground');
    expect(c.swungAt).toBeGreaterThan(0);
    // the release is held for them in the gold
    expect(Math.abs(c.swungAt + LEAD - (c.tossedAt + FLOAT.ideal))).toBeLessThan(T.sweetErr + 2 * STEP);
    expect(c.d.stage).toBe(3);
  });

  it("a float server's arm goes back as the toss tops out, a little over half a second before the hit", () => {
    const c = new ServeCourt('float');
    c.setToss(true);
    c.until(() => c.tossedAt >= 0, 2);
    c.setToss(false);
    expect(c.until(() => c.out.waiting, 5)).toBe(true);
    expect(c.d.cue?.id).toBe('draw');
    expect(c.tossedAt + FLOAT.ideal - c.simTime).toBeCloseTo(T.floatDraw, 1);
  });
});

describe('serve lessons: slow motion and full speed', () => {
  it('nothing is done for the server: a toss held past the mark goes higher, and nothing waits', () => {
    const c = new ServeCourt('jump', 2);
    c.setToss(true);
    c.run(1);
    expect(c.tossedAt).toBe(-1);
    expect(c.d.cue?.id).toBe('toss');
    c.setToss(false);
    expect(c.tossedAt).toBeGreaterThan(0);
    c.run(3);
    expect(c.out.waiting).toBe(false);
    expect(c.swungAt).toBe(-1);
  });

  it('the strip starts on the toss in both reps', () => {
    for (const step of [2, 3] as const) {
      const c = new ServeCourt('float', step);
      c.run(0.3);
      expect(c.d.stage).toBe(0);
    }
  });
});

describe('serve lessons: the coach says one thing after a serve', () => {
  const served = (
    lesson: Lesson,
    f: Partial<GuideFacts>,
    grade?: 'Perfect' | 'Good' | 'Early' | 'Late' | 'Miss',
    kill = true,
    why = '',
    note = '',
  ) => {
    const d = new TutorialDirector();
    d.begin(2, lesson);
    d.noteFeed();
    d.guide({
      simTime: 2,
      setUp: false,
      tGo: -1,
      tPlant: -1,
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
      ...f,
    });
    if (grade) d.noteContact(grade, note);
    d.noteRepEnd(kill, why);
    return d;
  };

  it('never tossed: hold the toss button and let go', () => {
    expect(served('float', {}, undefined, false, 'TOSS NOT HIT').hint()).toMatch(/toss/i);
  });

  it('tossed but never swung: a toss that comes down unhit is the arm, at the top of the toss', () => {
    expect(served('float', { setUp: true }, undefined, false, 'TOSS NOT HIT').hint()).toMatch(/tops out/);
  });

  it('a jump server who never ran is told to run in on GO', () => {
    expect(served('jump', { setUp: true }, undefined, false, 'TOSS NOT HIT').hint()).toMatch(/GO/);
  });

  it('good timing into the net is not a clean serve: it was the aim', () => {
    const d = served('float', { setUp: true, charge: 1 }, 'Perfect', false, 'IN THE NET');
    expect(d.clean).toBe(false);
    expect(d.hint()).toMatch(/in the net/);
    d.tick(T.result + 0.1);
    expect(d.step).toBe(2);
  });

  it('a foot fault is called, however clean the contact', () => {
    const d = served('jump', { setUp: true, startD: 2, state: 'air', charge: 1 }, 'Perfect', false, 'FOOT FAULT');
    expect(d.clean).toBe(false);
    expect(d.hint()).toMatch(/Foot fault/);
  });

  it('a swing at a toss still going up is told to wait for it to come down', () => {
    expect(served('float', { setUp: true, charge: 1 }, 'Miss', false, 'TOSS NOT HIT', 'Swung early').hint()).toMatch(/going up/);
  });

  it('a clean serve in their court moves the lesson on', () => {
    const d = served('float', { setUp: true, charge: 1 }, 'Perfect', true);
    expect(d.clean).toBe(true);
    d.tick(T.result + 0.1);
    expect(d.step).toBe(3);
  });
});

describe('serve lessons: remembered apart from the spike lesson', () => {
  it('a finished serve lesson is kept under its own key, and the spike lesson flag is untouched', () => {
    const s = mem();
    expect(readServeLessons(s)).toEqual([]);
    markServeLessonDone('jump', s);
    markServeLessonDone('float', s);
    markServeLessonDone('jump', s);
    expect(readServeLessons(s)).toEqual(['float', 'jump']);
    expect(s.raw.has(SERVE_LESSONS_KEY)).toBe(true);
    expect(s.raw.has(TUTORIAL_KEY)).toBe(false);
  });

  it('a broken stored value reads as none finished', () => {
    const s = mem();
    s.setItem(SERVE_LESSONS_KEY, '{nope');
    expect(readServeLessons(s)).toEqual([]);
  });
});
