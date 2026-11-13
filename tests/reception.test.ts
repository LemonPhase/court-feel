import { describe, expect, it } from 'vitest';
import * as THREE from 'three';
import { CONTACT, COURT, SIM, TIMING } from '../src/config';
import { lerp } from '../src/core/mathx';
import { Athlete } from '../src/game/athlete';
import { ContactSystem, type ContactEvent, type ContactHost } from '../src/game/contact';
import { makeBall, stepBall, type V3 } from '../src/physics/ball';
import { BallPredictor } from '../src/physics/predict';
import { solveFixedTime } from '../src/physics/solve';
import { serveAim } from '../src/ai/server';
import { Rng } from '../src/core/mathx';

const DT = 1 / SIM.hz;
const TARGET = { x: 1, y: 2.35, z: 0.9, apex: 4 };

/**
 * A home passer at the end of their court takes a ball from the other side at `speed` m/s,
 * the platform out `lead` s before it arrives (the ideal lead for that speed by default).
 * Returns the contact and how far from the setter's target the pass was aimed.
 */
function receive(speed: number, opts: { lead?: number; rand?: number; moving?: number; spikeBy?: 'user' | 'ai' } = {}) {
  const state = makeBall();
  const predictor = new BallPredictor(DT, SIM.predictHorizon);
  let version = 0;
  let pv = -1;
  const ball = {
    state,
    active: true,
    lastTouch: null as any,
    get pos() {
      return state.p;
    },
    get vel() {
      return state.v;
    },
    speed: () => Math.hypot(state.v.x, state.v.y, state.v.z),
    ensurePrediction(env: { netTop: number }, t: number) {
      if (pv !== version) {
        predictor.compute(state, env, t);
        pv = version;
      }
      return predictor;
    },
    hit(v: V3, w: V3) {
      Object.assign(state.v, v);
      Object.assign(state.w, w);
      version++;
    },
  };
  if (opts.spikeBy) {
    const hitter = new Athlete('OH', -1);
    hitter.isUser = opts.spikeBy === 'user';
    ball.lastTouch = { athlete: hitter, kind: 'spike', t: 0, side: -1 };
  }
  const events: ContactEvent[] = [];
  const host = {
    ball: ball as any,
    simTime: 0,
    env: { netTop: COURT.netHeightMen },
    aimAssist: () => 0,
    aimTargetFor: (_a: Athlete, out: THREE.Vector3) => out.set(1, 0.105, -6),
    emitContact: (e: ContactEvent) => events.push(e),
    rand: () => opts.rand ?? 0.5,
    passTarget: () => TARGET,
    setOptions: () => [],
    canServe: () => true,
  } satisfies ContactHost;
  const cs = new ContactSystem(host);
  const a = new Athlete('L', 1);
  a.place(0.5, 7.5, 0);
  if (opts.moving) a.vel.set(opts.moving * a.stats.approachSpeed, 0, 0);
  const P = cs.platformPoint(a, new THREE.Vector3());
  // the ball comes over the net from 9 m away and arrives at the platform at T
  const T = 9 / speed;
  const from = { x: P.x, y: 3.3, z: P.z - 9 };
  solveFixedTime(from, { x: P.x, y: P.y, z: P.z }, T, { x: 0, y: 0, z: 0 }, state.v);
  Object.assign(state.p, from);
  version++;
  const fast = Math.min(1, Math.max(0, (speed - 12) / 10));
  const lead = opts.lead ?? lerp(TIMING.passLead, TIMING.digLead, fast);
  let act: ReturnType<Athlete['startAction']> | null = null;
  for (let i = 0; i < SIM.hz * 2 && !events.length; i++) {
    if (!act && host.simTime >= T - lead - 1e-9) act = a.startAction('pass', host.simTime);
    if (act) cs.tryPass(a, act);
    host.simTime += DT;
    stepBall(state, DT, host.env);
  }
  const e = events[0];
  return { e, off: e ? Math.hypot(e.target.x - TARGET.x, e.target.z - TARGET.z) : NaN, v: { ...state.v }, vIn: speed };
}

describe('serve reception (contact)', () => {
  it('the same well-timed platform passes a fast jump serve less accurately than a slow float', () => {
    const float = receive(13);
    const jump = receive(24);
    expect(float.e.grade).toBe('Perfect');
    expect(jump.e.grade).toBe('Perfect');
    expect(jump.off).toBeGreaterThan(float.off * 1.8);
  });

  it('a passer still moving when the ball arrives passes it less accurately than one who is set', () => {
    const set = receive(15);
    const moving = receive(15, { moving: 0.8 });
    expect(moving.off).toBeGreaterThan(set.off * 1.4);
  });

  it('a hard-driven ball off a mistimed platform can be shanked; a slow one never is', () => {
    const lateHard = receive(25, { lead: 0.02, rand: 0.05 });
    expect(lateHard.e.note).toBe('Shanked');
    const lateSlow = receive(10, { lead: 0.02, rand: 0.05 });
    expect(lateSlow.e.note).not.toBe('Shanked');
  });

  it('a well-timed platform is not shanked even on the hardest ball', () => {
    const r = receive(26, { rand: 0.05 });
    expect(r.e.note).not.toBe('Shanked');
  });

  it("an AI defender who gets to your hard spike shanks it half the time, well timed or not (playability); an AI hitter's is dug", () => {
    // (the harness's random draw is fixed: under the user-spike shank chance)
    const rand = CONTACT.userSpikeShank * 0.6;
    const yours = receive(24, { rand, spikeBy: 'user' });
    const theirs = receive(24, { rand, spikeBy: 'ai' });
    expect(yours.e.note).toBe('Shanked');
    expect(theirs.e.note).not.toBe('Shanked');
    // a slow ball of yours (a roll shot, an easy swing) is played as usual
    expect(receive(12, { rand, spikeBy: 'user' }).e.note).not.toBe('Shanked');
  });

  it('a shank keeps going the way the spike came, at most 100 degrees off its line, up and off the arms', () => {
    for (const rand of [0.02, 0.3, 0.5, 0.7, 0.98]) {
      const r = receive(24, { rand: Math.min(rand, CONTACT.userSpikeShank * 0.99), spikeBy: 'user' });
      expect(r.e.note).toBe('Shanked');
      // the spike came in along +z (towards our end line)
      const ang = Math.atan2(r.v.x, r.v.z);
      expect(Math.abs(ang)).toBeLessThanOrEqual(CONTACT.shankTurn + 1e-6);
      expect(r.v.y).toBeGreaterThan(0);
    }
  });
});

describe('where the AI serves (Mini Rally)', () => {
  const passers = [
    { x: -3, z: 6 },
    { x: 0, z: 6.5 },
    { x: 3, z: 6 },
  ];

  it('always into their court, mostly at the seams and the deep corners', () => {
    const rng = new Rng(11);
    let hard = 0;
    const n = 400;
    for (let i = 0; i < n; i++) {
      const jump = i % 2 === 0;
      const p = serveAim(passers, -1, rng, jump);
      expect(Math.abs(p.x)).toBeLessThan(COURT.halfWidth);
      expect(p.z).toBeLessThan(0);
      expect(-p.z).toBeLessThan(COURT.halfLength);
      // a seam (between two passers) or deep (behind them)
      const seam = [-1.5, 1.5].some((sx) => Math.abs(p.x - sx) < 1.0);
      if (seam || -p.z > 7) hard++;
    }
    expect(hard / n).toBeGreaterThan(0.5);
  });

  it('a jump serve never goes short; a float sometimes does', () => {
    const rng = new Rng(3);
    let floatShort = 0;
    for (let i = 0; i < 400; i++) {
      // short = in front of the passers, inside 4.5 m of the net, with no spread pulling it back
      const j = serveAim(passers, -1, rng, true);
      expect(-j.z).toBeGreaterThan(2.5 - 1e-9);
      const f = serveAim(passers, -1, rng, false);
      if (-f.z < 4.5) floatShort++;
    }
    expect(floatShort).toBeGreaterThan(10);
  });
});
