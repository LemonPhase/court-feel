import { describe, expect, it } from 'vitest';
import * as THREE from 'three';
import { AI, CONTACT, COURT, SIM, TIMING } from '../src/config';
import { Rng } from '../src/core/mathx';
import { SetterBrain } from '../src/ai/setter';
import { Athlete } from '../src/game/athlete';
import { ContactSystem, type ContactEvent, type ContactHost, type SetOption } from '../src/game/contact';
import type { Game } from '../src/game/game';
import { SETTER_SPOT } from '../src/game/plays';
import type { SetPick } from '../src/game/setterCalls';
import { makeBall, stepBall, type BallState } from '../src/physics/ball';
import { BallPredictor } from '../src/physics/predict';
import { solveApex } from '../src/physics/solve';

const DT = 1 / SIM.hz;
const ENV = { netTop: COURT.netHeightMen };
const OH = { x: -4.05, y: 3.25, z: 0.9 };
const OPP = { x: 4.0, y: 3.34, z: 0.9 };

class FakeBall {
  state: BallState = makeBall();
  predictor = new BallPredictor(DT, SIM.predictHorizon);
  version = 0;
  private pv = -1;
  lastTouch: unknown = { kind: 'pass', side: 1 };
  active = true;
  get pos() {
    return this.state.p;
  }
  get vel() {
    return this.state.v;
  }
  speed() {
    const v = this.state.v;
    return Math.hypot(v.x, v.y, v.z);
  }
  ensurePrediction(env: { netTop: number }, t: number) {
    if (this.pv !== this.version) {
      this.predictor.compute(this.state, env, t);
      this.pv = this.version;
    }
    return this.predictor;
  }
  hit(v: { x: number; y: number; z: number }, w: { x: number; y: number; z: number }) {
    Object.assign(this.state.v, v);
    Object.assign(this.state.w, w);
    this.version++;
  }
  /** a ball on its way down to `to`, from the back court */
  passTo(to: { x: number; y: number; z: number }) {
    const from = { x: -1, y: 0.85, z: 7.5 };
    const v = { x: 0, y: 0, z: 0 };
    solveApex(from, to, 4.4, { x: 0, y: 0, z: 0 }, v);
    Object.assign(this.state.p, from);
    Object.assign(this.state.v, v);
    this.version++;
  }
}

/**
 * A second ball coming down onto a home setter standing 3 m off the net, who plays it with the
 * forearms (E), pressed `off` s from the ideal moment. `bump`: there are hitters to bump-set (a
 * high ball to each pin); `key`: the pick. Returns the touch and where the ball came down at the
 * hitter's contact height.
 */
function forearms(o: { bump?: boolean; key?: SetPick | null; off?: number; seed?: number } = {}) {
  const ball = new FakeBall();
  const events: ContactEvent[] = [];
  const rng = new Rng(o.seed ?? 3);
  const options: SetOption[] = [
    { target: OH, apex: OH.y + 1.9, hitter: null, label: 'OH High', key: 'OH', outOfSystem: true },
    { target: OPP, apex: OPP.y + 1.8, hitter: null, label: 'OPP High', key: 'OPP', outOfSystem: true },
  ];
  const host = {
    ball: ball as unknown as ContactHost['ball'],
    simTime: 0,
    env: ENV,
    aimAssist: () => 0,
    aimTargetFor: (_a: Athlete, out: THREE.Vector3) => out,
    emitContact: (e: ContactEvent) => events.push(e),
    rand: () => rng.next(),
    passTarget: () => ({ x: 0.5, y: 2.35, z: 3.4, apex: 5.2 }),
    setOptions: () => options,
    bumpOptions: () => (o.bump === false ? [] : options),
    setPick: () => o.key ?? null,
    setLevel: () => 'easy' as const,
    canServe: () => false,
  } satisfies ContactHost;
  const cs = new ContactSystem(host);
  const a = new Athlete('S', 1);
  a.isUser = true;
  a.place(SETTER_SPOT.x, 3, Math.PI / 2);
  const P = cs.platformPoint(a, new THREE.Vector3());
  ball.passTo({ x: P.x, y: P.y, z: P.z });
  const tArrive = ball.ensurePrediction(ENV, 0).descendThrough(P.y, 0);
  const pressAt = tArrive - TIMING.passLead + (o.off ?? 0);
  let landed: { x: number; z: number } | null = null;
  for (let i = 0; i < SIM.hz * 6; i++) {
    host.simTime += DT;
    const t = host.simTime;
    a.cmd = { moveX: 0, moveZ: 0, sprint: false, faceYaw: Math.PI / 2 };
    a.step(DT, t);
    if (!a.action && !events.length && t >= pressAt) a.startAction('pass', t);
    const act = a.action;
    if (act && !act.resolved && act.kind === 'pass') cs.tryPass(a, act);
    stepBall(ball.state, DT, ENV);
    const target = cs.lastSet?.target;
    if (events.length && target && ball.state.v.y < 0 && ball.state.p.y <= target.y) {
      landed = { x: ball.state.p.x, z: ball.state.p.z };
      break;
    }
    if (events.length && !target && t > tArrive + 0.5) break;
  }
  const to = cs.lastSet?.target;
  return {
    ev: events[0],
    touch: ball.lastTouch as { kind: string },
    set: cs.lastSet,
    result: cs.lastSetResult,
    miss: landed && to ? Math.hypot(landed.x - to.x, landed.z - to.z) : NaN,
  };
}

const avg = (m: number[]) => m.reduce((x, y) => x + y, 0) / m.length;

describe('the bump set: a second ball sent to a hitter with the forearms', () => {
  it('it is a set: the ball is your hitter’s to hit, a high ball to the outside when you picked nobody', () => {
    const r = forearms();
    expect(r.touch.kind).toBe('set');
    expect(r.ev.kind).toBe('set');
    expect(r.set?.key).toBe('OH');
    expect(r.result?.bump).toBe(true);
    expect(r.miss).toBeLessThan(CONTACT.bumpSet.spread[0] + 0.15);
  });
  it('it goes to the hitter you picked', () => {
    const r = forearms({ key: 'OPP' });
    expect(r.set?.key).toBe('OPP');
    expect(r.miss).toBeLessThan(CONTACT.bumpSet.spread[0] + 0.15);
  });
  it('it is never green: a well-timed bump set is a good set, and the hitter gets less than off a green one', () => {
    const r = forearms();
    expect(r.ev.grade).toBe('Good');
    expect(r.result?.green).toBe(false);
    expect(r.result?.quality).toBe(CONTACT.bumpSet.quality[0]);
    expect(r.result!.quality).toBeLessThan(1);
    expect(r.result!.quality).toBeGreaterThan(CONTACT.bumpSet.quality[1]);
  });
  it('it is less exact than the hands: it comes down a couple of balls from the spot, not on it', () => {
    const misses = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12].map((seed) => forearms({ seed }).miss);
    expect(avg(misses)).toBeGreaterThan(3 * CONTACT.setSpreadGreen);
    expect(avg(misses)).toBeLessThan(CONTACT.bumpSet.spread[0]);
  });
  it('timed badly it is a poor ball: further from the spot, and little for the hitter to swing at', () => {
    const clean = [1, 2, 3, 4, 5, 6, 7, 8].map((seed) => forearms({ seed }).miss);
    const early = [1, 2, 3, 4, 5, 6, 7, 8].map((seed) => forearms({ seed, off: -0.3 }));
    expect(early[0].ev.grade).toBe('Early');
    expect(early[0].result?.quality).toBe(CONTACT.bumpSet.quality[2]);
    expect(avg(early.map((r) => r.miss))).toBeGreaterThan(avg(clean) * 2);
  });
  it('with nobody to set, the same touch is a pass', () => {
    const r = forearms({ bump: false });
    expect(r.touch.kind).toBe('pass');
    expect(r.ev.kind).toBe('pass');
    expect(r.set).toBeNull();
  });
});

describe('an AI setter bumps a ball it takes deep in the court', () => {
  /** an AI setter under a second ball coming down `z` m off the net: how it played it */
  function aiSecondBall(z: number) {
    const ball = new FakeBall();
    const a = new Athlete('S', 1);
    a.place(SETTER_SPOT.x, z, Math.PI / 2);
    ball.passTo({ x: SETTER_SPOT.x - 0.14, y: a.height + 0.17, z });
    const brain = new SetterBrain(a, SETTER_SPOT, Math.PI / 2);
    brain.call = () => ({ target: OH, apex: OH.y + 1.9, hitter: null });
    const g = { simTime: 0, env: ENV, ball, rng: new Rng(5), onAiContact: () => {} };
    for (let i = 0; i < SIM.hz * 4; i++) {
      g.simTime += DT;
      brain.step(DT, g as unknown as Game);
      a.step(DT, g.simTime);
      if ((ball.lastTouch as { kind: string }).kind === 'set') return { bumped: brain.bumping, action: a.action?.kind, ballY: ball.pos.y };
      stepBall(ball.state, DT, ENV);
    }
    throw new Error('no set');
  }
  it('from behind the bump-set line it uses the forearms; nearer the net, the hands', () => {
    const deep = aiSecondBall(AI.bumpSet.from + 1);
    expect(deep.bumped).toBe(true);
    expect(deep.action).toBe('pass');
    const near = aiSecondBall(AI.bumpSet.from - 1.5);
    expect(near.bumped).toBe(false);
    expect(near.action).toBe('set');
    // the platform meets it low, the hands above the forehead
    expect(deep.ballY).toBeLessThan(near.ballY - 0.5);
  });
});
