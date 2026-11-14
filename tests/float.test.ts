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
  // (a float that drops before the net can die in the tape: `net`)
  return { path, land: { x: events[0].x, z: events[0].z }, net: events[0].kind !== 'floor', t: path.length * DT };
}

const median = (a: number[]) => [...a].sort((x, y) => x - y)[Math.floor(a.length / 2)];
const p90 = (a: number[]) => [...a].sort((x, y) => x - y)[Math.floor(a.length * 0.9)];
/** how far each of many floats comes down from where the same hit would without the float */
function drift(from: { p: V3; v: V3 }, knuckle: number) {
  const line = fly(from, 0, 0).land;
  const flights = SEEDS.map((seed) => fly(from, knuckle, seed));
  // nearly all of them clear the tape, as the serve they were aimed as does
  expect(flights.filter((f) => f.net).length).toBeLessThan(SEEDS.length / 10);
  const lands = flights.filter((f) => !f.net).map((f) => f.land);
  return {
    side: lands.map((l) => l.x - line.x),
    short: lands.map((l) => l.z - line.z),
    total: lands.map((l) => Math.hypot(l.x - line.x, l.z - line.z)),
  };
}

/**
 * the float's own push across the flight (what the seams add to gravity, drag and spin, less the
 * part along the flight: that is the drag jump)
 */
function push(s: BallState): V3 {
  const a = aeroAccel(s, { x: 0, y: 0, z: 0 });
  const plain = copyBall(s, makeBall());
  plain.knuckle = 0;
  const b = aeroAccel(plain, { x: 0, y: 0, z: 0 });
  const d = { x: a.x - b.x, y: a.y - b.y, z: a.z - b.z };
  const sp = Math.hypot(s.v.x, s.v.y, s.v.z) || 1;
  const along = (d.x * s.v.x + d.y * s.v.y + d.z * s.v.z) / sp;
  return { x: d.x - (along * s.v.x) / sp, y: d.y - (along * s.v.y) / sp, z: d.z - (along * s.v.z) / sp };
}

describe('the float: a ball hit without spin', () => {
  it('is pushed off its line: a clean jump float comes down two to four ball widths from where it was heading', () => {
    const d = drift(JUMP_FLOAT, 1);
    expect(median(d.total)).toBeGreaterThan(0.4);
    expect(median(d.total)).toBeLessThan(0.9);
    expect(p90(d.total)).toBeLessThan(1.8);
    // sideways alone: half a metre, a metre now and then, never across the court
    expect(median(d.side.map(Math.abs))).toBeGreaterThan(0.3);
    expect(median(d.side.map(Math.abs))).toBeLessThan(0.8);
    expect(Math.max(...d.side.map(Math.abs))).toBeLessThan(1.6);
  });

  it('goes its own way every serve, left as often as right, and nobody chooses which', () => {
    // (the serves that broke sideways: some only drop)
    const d = { side: drift(JUMP_FLOAT, 1).side.filter((x) => Math.abs(x) > 0.1) };
    expect(d.side.length).toBeGreaterThan(SEEDS.length / 2);
    const left = d.side.filter((x) => x < 0).length / d.side.length;
    expect(left).toBeGreaterThan(0.35);
    expect(left).toBeLessThan(0.65);
    // the same serve flies the same way twice (the replay shows what happened)
    expect(fly(JUMP_FLOAT, 1, 7).land).toEqual(fly(JUMP_FLOAT, 1, 7).land);
    expect(fly(JUMP_FLOAT, 1, 7).land).not.toEqual(fly(JUMP_FLOAT, 1, 8).land);
  });

  it('flies true, then breaks: one to three short, hard pushes left, right or down before it reaches the passers', () => {
    const flights = SEEDS.map((seed) => {
      const { path } = fly(JUMP_FLOAT, 1, seed);
      let breaks = 0;
      let on = 0;
      let longest = 0;
      let quiet = 0;
      let pushing = false;
      let sideways = 0;
      let down = 0;
      let up = 0;
      for (const s of path) {
        const a = push(s);
        const hard = Math.hypot(a.x, a.y, a.z) > 1;
        if (hard && !pushing) {
          breaks++;
          if (Math.abs(a.x) > Math.abs(a.y)) sideways++;
          else if (a.y < 0) down++;
          else up++;
        }
        on = hard ? on + DT : 0;
        longest = Math.max(longest, on);
        if (!hard) quiet += DT;
        pushing = hard;
      }
      return { breaks, longest, quiet, t: path.length * DT, sideways, down, up };
    });
    expect(Math.min(...flights.map((f) => f.breaks))).toBeGreaterThanOrEqual(1);
    expect(median(flights.map((f) => f.breaks))).toBeLessThanOrEqual(2);
    expect(Math.max(...flights.map((f) => f.breaks))).toBeLessThanOrEqual(3);
    // a break is over in a quarter of a second, and most of the flight is true
    expect(Math.max(...flights.map((f) => f.longest))).toBeLessThan(0.25);
    expect(median(flights.map((f) => f.quiet / f.t))).toBeGreaterThan(0.6);
    // left or right three times in four, down the rest, never up
    const n = flights.reduce((k, f) => k + f.breaks, 0);
    const sideways = flights.reduce((k, f) => k + f.sideways, 0);
    expect(sideways / n).toBeGreaterThan(0.6);
    expect(sideways / n).toBeLessThan(0.9);
    expect(flights.reduce((k, f) => k + f.up, 0)).toBe(0);
  });

  it('a break is abrupt: it turns a clean jump float a metre and a half a second sideways in a fifth of a second', () => {
    const turns = SEEDS.slice(0, 60).map((seed) => {
      const { path } = fly(JUMP_FLOAT, 1, seed);
      // the most the sideways speed changes over any 0.2 s of the flight
      const k = Math.round(0.2 / DT);
      let most = 0;
      for (let i = k; i < path.length; i++) most = Math.max(most, Math.abs(path[i].v.x - path[i - k].v.x));
      return most;
    });
    expect(median(turns)).toBeGreaterThan(1);
    expect(Math.max(...turns)).toBeLessThan(3);
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
      // the hardest it is pushed in its first second
      let most = 0;
      for (s.kt = 0; s.kt < 1; s.kt += DT) {
        const a = push(s);
        most = Math.max(most, Math.hypot(a.x, a.y, a.z));
      }
      return most;
    };
    expect(at(20) / at(15)).toBeCloseTo((20 / 15) ** 2, 1);
    // about as hard as gravity pulls: enough to turn the ball in a fifth of a second
    expect(at(20)).toBeGreaterThan(6);
    expect(at(20)).toBeLessThan(15);
  });

  it('dies under its critical speed: a standing float comes down short of where it was heading', () => {
    const d = drift(STANDING_FLOAT, 1);
    // (the far court is -z: a ball that lands short has the larger z)
    expect(median(d.short)).toBeGreaterThan(0.1);
    expect(median(d.short)).toBeLessThan(1.1);
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

  it('so a ball that has just broken is not where it looked to be going: off by up to two balls', () => {
    // the furthest off the read is at any moment of the flight to the passers
    const off = SEEDS.slice(0, 60).map((seed) => {
      let most = 0;
      for (let t = 0.3; t < 0.95; t += 0.05) {
        const { s, read } = watch(seed, t);
        // fly the read forward to now, as the predictor does
        const r = read.from(s);
        const seen = copyBall(r.state, makeBall());
        for (let i = 0; i < Math.round(r.age / DT); i++) stepBall(seen, DT, env);
        most = Math.max(most, Math.hypot(seen.p.x - s.p.x, seen.p.y - s.p.y, seen.p.z - s.p.z));
      }
      return most;
    });
    expect(median(off)).toBeGreaterThan(0.1);
    expect(Math.max(...off)).toBeLessThan(4 * R + 0.05);
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
