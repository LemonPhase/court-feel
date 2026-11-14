import { describe, expect, it } from 'vitest';
import { BALL, COURT, SIM } from '../src/config';
import { makeBall, R, stepBall, topspinFor, type BallState, type CollisionEvent, type V3 } from '../src/physics/ball';
import { BallPredictor } from '../src/physics/predict';
import { netClearance, solveApex, solveFixedTime, solveSpeedToFloor } from '../src/physics/solve';

const DT = 1 / SIM.hz;
const env = { netTop: COURT.netHeightMen };

function ballAt(p: V3, v: V3, w: V3 = { x: 0, y: 0, z: 0 }): BallState {
  const b = makeBall();
  Object.assign(b.p, p);
  Object.assign(b.v, v);
  Object.assign(b.w, w);
  return b;
}

/** run the live sim until the first floor contact; returns landing point and events */
function simulateToFloor(b: BallState, maxT = 5, dt = DT) {
  const events: CollisionEvent[] = [];
  let apexY = b.p.y;
  let t = 0;
  let crossY: number | null = null;
  let crossX: number | null = null;
  while (t < maxT) {
    const pz = b.p.z;
    const py = b.p.y;
    const px = b.p.x;
    const before = events.length;
    stepBall(b, dt, env, events);
    t += dt;
    apexY = Math.max(apexY, b.p.y);
    if (crossY === null && Math.sign(pz) !== Math.sign(b.p.z) && pz !== 0) {
      const f = pz / (pz - b.p.z);
      crossY = py + (b.p.y - py) * f;
      crossX = px + (b.p.x - px) * f;
    }
    const floor = events.slice(before).find((e) => e.kind === 'floor');
    if (floor) return { land: floor, t, apexY, events, crossY, crossX };
  }
  return { land: null, t, apexY, events, crossY, crossX };
}

describe('ball constants', () => {
  it('uses a regulation-sized ball', () => {
    expect(BALL.radius * 2).toBeCloseTo(0.21, 2);
    expect(BALL.mass).toBeCloseTo(0.27, 2);
  });
});

describe('set trajectory', () => {
  it('a high outside set peaks at the requested apex and arrives at the hitter', () => {
    const p0 = { x: 1.0, y: 2.55, z: 0.7 };
    const target = { x: -3.6, y: 3.2, z: 1.0 };
    const v: V3 = { x: 0, y: 0, z: 0 };
    const w = { x: 0, y: 0, z: 0 };
    const { T } = solveApex(p0, target, 4.6, w, v);
    const b = ballAt(p0, v, w);
    let apex = b.p.y;
    let closest = 1e9;
    for (let t = 0; t < T + 0.3; t += DT) {
      stepBall(b, DT, env);
      apex = Math.max(apex, b.p.y);
      closest = Math.min(closest, Math.hypot(b.p.x - target.x, b.p.y - target.y, b.p.z - target.z));
    }
    expect(Math.abs(apex - 4.6)).toBeLessThan(0.06);
    expect(closest).toBeLessThan(0.06);
    // hang time of a high outside ball feels right (~1.1-1.6 s setter to hitter)
    expect(T).toBeGreaterThan(1.0);
    expect(T).toBeLessThan(1.7);
  });

  it('solveFixedTime hits a target at the requested time despite drag', () => {
    const p0 = { x: 0, y: 1, z: 6 };
    const target = { x: 0.5, y: 2.6, z: 1 };
    const v: V3 = { x: 0, y: 0, z: 0 };
    const zero = { x: 0, y: 0, z: 0 };
    solveFixedTime(p0, target, 1.2, zero, v);
    const b = ballAt(p0, v);
    const steps = Math.round(1.2 / DT);
    for (let i = 0; i < steps; i++) stepBall(b, DT, env);
    expect(Math.hypot(b.p.x - target.x, b.p.y - target.y, b.p.z - target.z)).toBeLessThan(0.05);
  });
});

describe('spike trajectory', () => {
  const contact = { x: -3.3, y: 3.35, z: 0.6 };
  const target = { x: 1.5, z: -6.5 };

  it('lands on the aimed point at 28 m/s with topspin', () => {
    const v: V3 = { x: 0, y: 0, z: 0 };
    const w: V3 = { x: 0, y: 0, z: 0 };
    const land: V3 = { x: 0, y: 0, z: 0 };
    solveSpeedToFloor(contact, target.x, target.z, 28, 60, v, w, land);
    expect(Math.hypot(v.x, v.y, v.z)).toBeCloseTo(28, 3);
    const r = simulateToFloor(ballAt(contact, v, w));
    expect(r.land).not.toBeNull();
    expect(Math.hypot(r.land!.x - target.x, r.land!.z - target.z)).toBeLessThan(0.15);
    // clears the net
    expect(r.events.some((e) => e.kind === 'net' || e.kind === 'tape')).toBe(false);
    expect(r.crossY!).toBeGreaterThan(env.netTop + R);
    // real spike flight time ~0.3-0.5 s
    expect(r.t).toBeGreaterThan(0.25);
    expect(r.t).toBeLessThan(0.6);
  });

  it('topspin makes the ball dip: same launch lands shorter', () => {
    const v = { x: 0, y: -2.5, z: -26 };
    const spin = topspinFor(v.x, v.z, 70, { x: 0, y: 0, z: 0 });
    const flat = simulateToFloor(ballAt(contact, { ...v }));
    const top = simulateToFloor(ballAt(contact, { ...v }, spin));
    const dFlat = contact.z - flat.land!.z;
    const dTop = contact.z - top.land!.z;
    expect(dFlat - dTop).toBeGreaterThan(0.5);
  });

  it('drag slows a spike noticeably over its flight', () => {
    const b = ballAt(contact, { x: 0, y: -4, z: -28 });
    const r = simulateToFloor(b);
    const vEndBeforeBounce = Math.hypot(b.v.x, b.v.z);
    expect(r.land).not.toBeNull();
    expect(vEndBeforeBounce).toBeLessThan(28);
  });
});

describe('net and antennae', () => {
  it('a ball driven into the net body stays on the hitting side and loses its speed', () => {
    const b = ballAt({ x: 0, y: 1.9, z: 2 }, { x: 0, y: 0, z: -12 });
    const r = simulateToFloor(b);
    expect(r.events.some((e) => e.kind === 'net')).toBe(true);
    expect(r.land!.z).toBeGreaterThan(0);
    expect(r.land!.z).toBeLessThan(1);
  });

  it('a spike into the net dies in the mesh and drops within a metre of the net, not bounced back', () => {
    const b = ballAt({ x: 0, y: 2.0, z: 1.2 }, { x: 0, y: -5, z: -20 });
    let minZ = Infinity;
    let maxZ = 0;
    let hit = false;
    const events: CollisionEvent[] = [];
    for (let i = 0; i < 240 && !events.some((e) => e.kind === 'floor'); i++) {
      stepBall(b, DT, env, events);
      minZ = Math.min(minZ, b.p.z);
      hit ||= events.some((e) => e.kind === 'net');
      if (hit) maxZ = Math.max(maxZ, b.p.z);
    }
    // it sinks into the mesh (closer than its radius) but its centre never crosses the net plane
    expect(minZ).toBeLessThan(R - 0.05);
    expect(minZ).toBeGreaterThan(0);
    expect(maxZ).toBeLessThan(1);
  });

  it('a ball driven into the side of the tape drops close to the net instead of bouncing back off it', () => {
    const b = ballAt({ x: 0, y: env.netTop + 0.08, z: 1 }, { x: 0, y: -1, z: -12 });
    const r = simulateToFloor(b);
    expect(r.events.some((e) => e.kind === 'tape')).toBe(true);
    expect(r.land!.z).toBeGreaterThan(0);
    expect(r.land!.z).toBeLessThan(1.5);
  });

  it('a 35 m/s ball does not tunnel through the net', () => {
    const b = ballAt({ x: 1, y: 1.8, z: 1.5 }, { x: 0, y: 0, z: -35 });
    const r = simulateToFloor(b);
    expect(r.events.some((e) => e.kind === 'net')).toBe(true);
    expect(r.land!.z).toBeGreaterThan(0);
  });

  it('a ball clipping the tape is deflected (let serve behaviour)', () => {
    const top = env.netTop;
    // arrives with its centre ~8cm above the tape top: clips the tape
    const b = ballAt({ x: 0, y: top + 0.1, z: 0.6 }, { x: 0, y: 0, z: -9 });
    const r = simulateToFloor(b);
    const tape = r.events.find((e) => e.kind === 'tape');
    expect(tape).toBeDefined();
    expect(r.events.some((e) => e.kind === 'net')).toBe(false);
  });

  it('a ball passing well above the net is unaffected', () => {
    const b = ballAt({ x: 0, y: 3.5, z: 4 }, { x: 0, y: 2, z: -10 });
    const r = simulateToFloor(b);
    expect(r.events.some((e) => e.kind === 'net' || e.kind === 'tape')).toBe(false);
    expect(r.land!.z).toBeLessThan(0);
  });

  it('a ball hitting an antenna bounces off it', () => {
    const b = ballAt({ x: COURT.antennaX, y: env.netTop + 0.4, z: 3 }, { x: 0, y: 0, z: -14 });
    const events: CollisionEvent[] = [];
    for (let i = 0; i < 120; i++) stepBall(b, DT, env, events);
    expect(events.some((e) => e.kind === 'antenna')).toBe(true);
    expect(b.p.z).toBeGreaterThan(0);
  });

  it("the women's net height changes what clears", () => {
    const p = { x: 0, y: 2.82, z: 3 };
    const v = { x: 0, y: 0, z: -10 };
    const cross = netClearance(p, v, { x: 0, y: 0, z: 0 })!;
    expect(cross.y).toBeLessThan(COURT.netHeightMen);
    expect(cross.y).toBeGreaterThan(COURT.netHeightWomen + R);
    const run = (netTop: number) => {
      const b = ballAt(p, { ...v });
      const ev: CollisionEvent[] = [];
      for (let i = 0; i < 90; i++) stepBall(b, DT, { netTop }, ev);
      return ev.some((e) => e.kind === 'net' || e.kind === 'tape');
    };
    expect(run(COURT.netHeightMen)).toBe(true);
    expect(run(COURT.netHeightWomen)).toBe(false);
  });
});

describe('floor', () => {
  it('bounces with the configured restitution', () => {
    const b = ballAt({ x: 0, y: 3, z: 3 }, { x: 0, y: 0, z: 0 });
    const r = simulateToFloor(b);
    expect(r.land).not.toBeNull();
    let maxY = 0;
    for (let i = 0; i < 200; i++) {
      stepBall(b, DT, env);
      maxY = Math.max(maxY, b.p.y);
      if (b.v.y < 0 && maxY > R + 0.1) break;
    }
    const expected = R + (3 - R) * BALL.floorRestitution ** 2;
    expect(Math.abs(maxY - expected)).toBeLessThan(0.12);
  });

  it('eventually comes to rest', () => {
    const b = ballAt({ x: 0, y: 2, z: 3 }, { x: 1, y: 0, z: -1 });
    for (let i = 0; i < SIM.hz * 20 && !b.rest; i++) stepBall(b, DT, env);
    expect(b.rest).toBe(true);
  });
});

describe('determinism and integration', () => {
  it('is bit-for-bit deterministic', () => {
    const run = () => {
      const b = ballAt({ x: -2, y: 3.1, z: 0.8 }, { x: 4, y: -3, z: -24 }, { x: -60, y: 3, z: 0 });
      for (let i = 0; i < 1200; i++) stepBall(b, DT, env);
      return [b.p.x, b.p.y, b.p.z, b.v.x, b.v.y, b.v.z];
    };
    expect(run()).toEqual(run());
  });

  it('120 Hz and 480 Hz agree on the landing point (integrator accuracy)', () => {
    const p = { x: 0, y: 2.5, z: 7 };
    const v = { x: 1, y: 8, z: -9 };
    const w = { x: -20, y: 0, z: 0 };
    const a = simulateToFloor(ballAt(p, v, w), 5, 1 / 120);
    const b = simulateToFloor(ballAt(p, v, w), 5, 1 / 480);
    expect(Math.hypot(a.land!.x - b.land!.x, a.land!.z - b.land!.z)).toBeLessThan(0.12);
  });

  it('the predictor matches the live simulation', () => {
    const b = ballAt({ x: 0, y: 1, z: 7 }, { x: 0.5, y: 9, z: -7 });
    const pred = new BallPredictor(DT, 4);
    pred.compute(b, env, 10);
    const r = simulateToFloor(b);
    expect(pred.landT).toBeGreaterThan(10);
    expect(Math.abs(pred.landT - 10 - r.t)).toBeLessThan(DT * 1.01);
    expect(Math.hypot(pred.land.x - r.land!.x, pred.land.z - r.land!.z)).toBeLessThan(1e-6);
    const ap = pred.apex();
    expect(Math.abs(ap.y - r.apexY)).toBeLessThan(1e-6);
    expect(pred.netCrossT).toBeGreaterThan(10);
  });
});

describe('the ceiling and the open sky', () => {
  /** a dig sent almost straight up, hard enough to climb past the hall's 12.5 m */
  const skyBall = () => ballAt({ x: 0, y: 1, z: 4 }, { x: 0, y: 19, z: -0.6 });

  it('under a roof a ball that reaches 12.5 m hits the ceiling', () => {
    const { events, apexY } = simulateToFloor(skyBall(), 8);
    expect(events.some((e) => e.kind === 'ceiling')).toBe(true);
    expect(apexY).toBeLessThanOrEqual(COURT.ceiling);
  });

  it('outdoors nothing is up there: the same ball climbs past 12.5 m and comes down in the court', () => {
    const b = skyBall();
    const open = { netTop: COURT.netHeightMen, ceiling: null };
    const events: CollisionEvent[] = [];
    let apex = b.p.y;
    for (let t = 0; t < 8 && !events.some((e) => e.kind === 'floor'); t += DT) {
      stepBall(b, DT, open, events);
      apex = Math.max(apex, b.p.y);
    }
    expect(apex).toBeGreaterThan(COURT.ceiling);
    expect(events.some((e) => e.kind === 'ceiling')).toBe(false);
    const floor = events.find((e) => e.kind === 'floor')!;
    expect(Math.abs(floor.x)).toBeLessThan(COURT.halfWidth);
    expect(Math.abs(floor.z)).toBeLessThan(COURT.halfLength);
  });

  it('a ball that never gets near 12.5 m flies the same path with or without a roof', () => {
    const a = ballAt({ x: -2, y: 2.4, z: 1 }, { x: 3, y: 7, z: -4 });
    const b = ballAt({ x: -2, y: 2.4, z: 1 }, { x: 3, y: 7, z: -4 });
    for (let i = 0; i < 90; i++) {
      stepBall(a, DT, env);
      stepBall(b, DT, { netTop: COURT.netHeightMen, ceiling: null });
    }
    expect(b.p).toEqual(a.p);
    expect(b.v).toEqual(a.v);
  });

  it('outdoors a ball shanked 21 m up is in the air longer than any ball under a roof, and its landing is still known', () => {
    const shank = () => ballAt({ x: 0, y: 1, z: 4 }, { x: 0, y: 25, z: -0.3 });
    const open = { netTop: COURT.netHeightMen, ceiling: null };
    const predictor = new BallPredictor(DT, SIM.predictHorizonOpenSky);
    // the horizon a roof allows is too short for it
    predictor.setHorizon(SIM.predictHorizon);
    predictor.compute(shank(), open, 0);
    expect(predictor.landT).toBe(-1);
    predictor.setHorizon(SIM.predictHorizonOpenSky);
    predictor.compute(shank(), open, 0);
    expect(predictor.landT).toBeGreaterThan(SIM.predictHorizon);
    expect(predictor.landT).toBeLessThan(SIM.predictHorizonOpenSky);
  });

  it('under a roof the same shank is down well inside the indoor horizon', () => {
    const predictor = new BallPredictor(DT, SIM.predictHorizon);
    predictor.compute(ballAt({ x: 0, y: 1, z: 4 }, { x: 0, y: 25, z: -0.3 }), env, 0);
    expect(predictor.landT).toBeGreaterThan(0);
    expect(predictor.landT).toBeLessThan(SIM.predictHorizon);
  });
});
