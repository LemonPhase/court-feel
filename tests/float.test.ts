import { describe, expect, it } from 'vitest';
import * as THREE from 'three';
import { BALL, CONTACT, COURT, SERVE, SIM } from '../src/config';
import { aeroAccel, copyBall, makeBall, R, stepBall, type BallState, type CollisionEvent, type V3 } from '../src/physics/ball';
import { FloatRead } from '../src/physics/floatRead';
import { netClearance, solveSpeedToFloor } from '../src/physics/solve';
import { serveRun } from './serveRun';

const DT = 1 / SIM.hz;
const env = { netTop: COURT.netHeightMen };
const SEEDS = Array.from({ length: 200 }, (_, i) => (i + 1) * 3.777);

/**
 * a serve hit from the end line at `speed` m/s (no spin), aimed 6.5 m into the far court or as
 * much deeper as it takes to clear the tape by a ball's width and a half (as the contact aims a float)
 */
function serve(y0: number, speed: number): { p: V3; v: V3 } {
  const p = { x: 0, y: y0, z: COURT.halfLength + 0.3 };
  const v = { x: 0, y: 0, z: 0 };
  const w = { x: 0, y: 0, z: 0 };
  for (let deep = 6.5; deep < 9; deep += 0.25) {
    solveSpeedToFloor(p, 0, -deep, speed, 0, v, w, { x: 0, y: 0, z: 0 }, -0.6, 0.7);
    const c = netClearance(p, v, w);
    if (c && c.y > env.netTop + R + 0.3) break;
  }
  return { p, v };
}
/** a clean jump float and a clean standing float, as they leave the hand */
const JUMP_FLOAT = serve(3.15, SERVE.jumpFloatSpeed);
const STANDING_FLOAT = serve(2.4, CONTACT.serveFloatSpeed);

/** fly it to the floor: every state on the way, and where it came down */
function fly(from: { p: V3; v: V3 }, knuckle: number, seed: number) {
  const s = makeBall();
  Object.assign(s.p, from.p);
  Object.assign(s.v, from.v);
  s.knuckle = knuckle;
  s.seed = seed;
  const path: BallState[] = [];
  const events: CollisionEvent[] = [];
  while (!events.length && path.length < SIM.hz * 4) {
    path.push(copyBall(s, makeBall()));
    stepBall(s, DT, env, events);
  }
  // (nothing but the floor is in the way of these serves)
  expect(events[0]?.kind).toBe('floor');
  return { path, land: { x: events[0].x, z: events[0].z }, t: path.length * DT };
}

const median = (a: number[]) => [...a].sort((x, y) => x - y)[Math.floor(a.length / 2)];
const p90 = (a: number[]) => [...a].sort((x, y) => x - y)[Math.floor(a.length * 0.9)];
/** how far each of many floats comes down from where the same hit would without the float */
function drift(from: { p: V3; v: V3 }, knuckle: number) {
  const line = fly(from, 0, 0).land;
  const lands = SEEDS.map((seed) => fly(from, knuckle, seed).land);
  return {
    side: lands.map((l) => l.x - line.x),
    short: lands.map((l) => l.z - line.z),
    total: lands.map((l) => Math.hypot(l.x - line.x, l.z - line.z)),
  };
}

/** the float's own push on the ball (what the seams add to gravity, drag and spin) */
function push(s: BallState): V3 {
  const a = aeroAccel(s, { x: 0, y: 0, z: 0 });
  const plain = copyBall(s, makeBall());
  plain.knuckle = 0;
  const b = aeroAccel(plain, { x: 0, y: 0, z: 0 });
  return { x: a.x - b.x, y: a.y - b.y, z: a.z - b.z };
}

describe('the float: a ball hit without spin', () => {
  it('is pushed off its line: a clean jump float comes down one to three ball widths from where it was heading', () => {
    const d = drift(JUMP_FLOAT, 1);
    expect(median(d.total)).toBeGreaterThan(0.2);
    expect(median(d.total)).toBeLessThan(0.6);
    expect(p90(d.total)).toBeLessThan(1.2);
    // sideways alone: a ball's width or two
    expect(median(d.side.map(Math.abs))).toBeGreaterThan(0.1);
    expect(median(d.side.map(Math.abs))).toBeLessThan(0.45);
  });

  it('goes its own way every serve, left as often as right, and nobody chooses which', () => {
    const d = drift(JUMP_FLOAT, 1);
    const left = d.side.filter((x) => x < 0).length / d.side.length;
    expect(left).toBeGreaterThan(0.35);
    expect(left).toBeLessThan(0.65);
    // the same serve flies the same way twice (the replay shows what happened)
    expect(fly(JUMP_FLOAT, 1, 7).land).toEqual(fly(JUMP_FLOAT, 1, 7).land);
    expect(fly(JUMP_FLOAT, 1, 7).land).not.toEqual(fly(JUMP_FLOAT, 1, 8).land);
  });

  it('breaks: the push holds, then turns another way, one to three times before it reaches the passers', () => {
    const breaks = SEEDS.map((seed) => {
      const { path } = fly(JUMP_FLOAT, 1, seed);
      let n = 0;
      let last: V3 | null = null;
      // sample the push every 0.1 s: a turn of more than 60 degrees is a break
      for (let i = 0; i < path.length; i += Math.round(0.1 / DT)) {
        const a = push(path[i]);
        const l = Math.hypot(a.x, a.y, a.z);
        if (l < 0.2) continue;
        if (last && (a.x * last.x + a.y * last.y + a.z * last.z) / (l * Math.hypot(last.x, last.y, last.z)) < 0.5) n++;
        last = a;
      }
      return n;
    });
    expect(median(breaks)).toBeGreaterThanOrEqual(1);
    expect(median(breaks)).toBeLessThanOrEqual(3);
    expect(Math.max(...breaks)).toBeLessThanOrEqual(5);
  });

  it('floats as much as it was hit cleanly: a Good contact about half of a Perfect one, a mishit hardly, a spun ball not at all', () => {
    const [mishit, good, perfect] = [CONTACT.floatClean[1], CONTACT.floatClean[2], CONTACT.floatClean[3]];
    expect(perfect).toBe(1);
    const clean = median(drift(JUMP_FLOAT, perfect).total);
    const half = median(drift(JUMP_FLOAT, good).total);
    const little = median(drift(JUMP_FLOAT, mishit).total);
    expect(half / clean).toBeGreaterThan(0.35);
    expect(half / clean).toBeLessThan(0.75);
    expect(little / clean).toBeLessThan(0.3);
    expect(Math.max(...drift(JUMP_FLOAT, 0).total)).toBe(0);
  });

  it('is pushed harder the faster it flies, as the square of its speed: a jump float more than a standing float', () => {
    const at = (speed: number) => {
      const s = makeBall();
      s.v.z = -speed;
      s.knuckle = 1;
      s.seed = 3;
      s.kt = 0.15;
      const a = push(s);
      // across the flight only (the drag jump acts along it)
      return Math.hypot(a.x, a.y);
    };
    expect(at(20) / at(15)).toBeCloseTo((20 / 15) ** 2, 1);
    // of the order of gravity's quarter: enough to move the ball a width in a third of a second
    expect(at(20)).toBeGreaterThan(0.8);
    expect(at(20)).toBeLessThan(3.5);
  });

  it('dies under its critical speed: a standing float comes down short of where it was heading', () => {
    const d = drift(STANDING_FLOAT, 1);
    // (the far court is -z: a ball that lands short has the larger z)
    expect(median(d.short)).toBeGreaterThan(0.1);
    expect(median(d.short)).toBeLessThan(0.8);
    expect(d.short.filter((x) => x > 0).length / d.short.length).toBeGreaterThan(0.7);
  });

  it('needs pace: a free ball or a set with no spin does not float', () => {
    const slow = { p: { x: 0, y: 2, z: 2 }, v: { x: 0.5, y: 5, z: 7 } };
    expect(Math.hypot(slow.v.x, slow.v.y, slow.v.z)).toBeLessThan(BALL.float.speedLo);
    expect(fly(slow, 1, 5).land).toEqual(fly(slow, 0, 0).land);
  });
});

describe('reading a float', () => {
  /** fly a clean jump float for `t` s the way the game does: remember, then step */
  function watch(seed: number, t: number) {
    const s = makeBall();
    Object.assign(s.p, JUMP_FLOAT.p);
    Object.assign(s.v, JUMP_FLOAT.v);
    s.knuckle = 1;
    s.seed = seed;
    const read = new FloatRead(DT);
    const past: BallState[] = [];
    for (let i = 0; i < Math.round(t / DT); i++) {
      read.keep(s);
      past.push(copyBall(s, makeBall()));
      stepBall(s, DT, env);
    }
    return { s, read, past };
  }

  it('what anyone sees of it is where it was heading a reaction time ago, with no push to come', () => {
    const { s, read, past } = watch(11, 0.6);
    const r = read.from(s);
    expect(r.age).toBeCloseTo(BALL.float.read, 2);
    expect(r.state.knuckle).toBe(0);
    const then = past[past.length - Math.round(BALL.float.read / DT)];
    expect(r.state.p).toEqual(then.p);
    expect(r.state.v).toEqual(then.v);
    // the ball itself still floats
    expect(s.knuckle).toBe(1);
  });

  it('right off the hand the read is the hit itself: the line it was aimed on', () => {
    const { s, read } = watch(11, 0);
    const r = read.from(s);
    expect(r.age).toBe(0);
    expect(r.state.p).toEqual(s.p);
    expect(r.state.knuckle).toBe(0);
    const young = watch(11, 0.1);
    expect(young.read.from(young.s).age).toBeCloseTo(0.1, 2);
  });

  it('so the ball is never quite where it looked to be going: off by up to a ball, more as it breaks', () => {
    const off = SEEDS.slice(0, 100).map((seed) => {
      const { s, read } = watch(seed, 0.8);
      // fly the read forward to now, as the predictor does
      const r = read.from(s);
      const seen = copyBall(r.state, makeBall());
      for (let i = 0; i < Math.round(r.age / DT); i++) stepBall(seen, DT, env);
      return Math.hypot(seen.p.x - s.p.x, seen.p.y - s.p.y, seen.p.z - s.p.z);
    });
    expect(median(off)).toBeGreaterThan(0.015);
    expect(Math.max(...off)).toBeLessThan(2 * R + 0.05);
  });
});

/** a repeatable stream of numbers in 0..1 */
function dice(seed: number): () => number {
  let x = seed >>> 0;
  return () => {
    x = (x * 1664525 + 1013904223) >>> 0;
    return x / 2 ** 32;
  };
}

describe('serving a float', () => {
  const player = (kind: 'float' | 'jumpFloat', sd: number, seed?: number, aim?: THREE.Vector3) =>
    serveRun({ kind, sd, seed, aim, user: { back: SERVE[kind].back } });

  it('a Perfect contact floats most, a Good one about half, a mistimed one hardly', () => {
    for (const kind of ['float', 'jumpFloat'] as const) {
      expect(player(kind, 0).e!.grade, kind).toBe('Perfect');
      expect(player(kind, 0).knuckle, kind).toBe(1);
      expect(player(kind, 1).e!.grade, kind).toBe('Good');
      expect(player(kind, 1).knuckle, kind).toBeCloseTo(0.55);
      expect(player(kind, 2).knuckle, kind).toBeLessThanOrEqual(0.2);
    }
    // a jump serve is spun: it does not float
    expect(serveRun({ kind: 'jump', user: { back: SERVE.jump.back } }).knuckle).toBe(0);
  });

  it('a clean jump float aimed a metre and a half inside the lines stays in nine times in ten: it is not aimed at a line', () => {
    const aim = new THREE.Vector3(-3, 0, -7);
    const runs = SEEDS.slice(0, 100).map((seed) => player('jumpFloat', 0, seed, aim));
    for (const r of runs) expect(r.overTape).toBeGreaterThan(0);
    expect(runs.filter((r) => r.in).length).toBeGreaterThanOrEqual(90);
    // and it does not all land in one place
    const xs = runs.map((r) => r.ball.x);
    expect(Math.max(...xs) - Math.min(...xs)).toBeGreaterThan(0.4);
  });

  it("the AI's float still never misses: whatever way it breaks, it clears the tape and lands in", () => {
    const rand = dice(2024);
    const aims = [
      new THREE.Vector3(-4.4, 0, -8.9),
      new THREE.Vector3(4.4, 0, -8.9),
      new THREE.Vector3(0, 0, -3.2),
      new THREE.Vector3(-3.5, 0, -7.5),
    ];
    let floated = 0;
    for (let i = 0; i < 120; i++) {
      const aim = aims[i % aims.length];
      const r = serveRun({ kind: 'float', sd: (i % 5) - 2, aim, rand });
      const what = `serve ${i} at ${aim.x},${aim.z}`;
      expect(r.e?.kind, what).toBe('serve');
      expect(r.overTape, what).toBeGreaterThan(0.1);
      expect(r.in, what).toBe(true);
      if (r.knuckle > 0) floated++;
    }
    // (it is still a float: most of them move)
    expect(floated).toBeGreaterThan(90);
  });
});
