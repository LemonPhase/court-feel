import { describe, expect, it } from 'vitest';
import * as THREE from 'three';
import { COURT, SERVE, SERVE_KINDS, SIM, type ServeKind } from '../src/config';
import { Athlete } from '../src/game/athlete';
import { ContactSystem, type ContactEvent, type ContactHost } from '../src/game/contact';
import { rateServe } from '../src/game/modes/serveDrill';
import { makeBall, stepBall } from '../src/physics/ball';
import { BallPredictor } from '../src/physics/predict';
import { serveRun } from './serveRun';

/** the player's serve from where the Serve drill stands them, with a full run-up and a clean (or `sd` off) swing */
const serve = (kind: ServeKind, sd = 0, back: number = SERVE[kind].back) => serveRun({ kind, sd, user: { back } });

describe("the player's three serves (keys 1-3)", () => {
  it('each one is faster off the hand and gives the passers less time than the one before', () => {
    const [float, jumpFloat, jump] = SERVE_KINDS.map((k) => serve(k));
    for (const r of [float, jumpFloat, jump]) {
      expect(r.e?.kind).toBe('serve');
      expect(r.e!.grade).toBe('Perfect');
      expect(r.in).toBe(true);
    }
    expect(jumpFloat.e!.speed).toBeGreaterThan(float.e!.speed * 1.1);
    expect(jump.e!.speed).toBeGreaterThan(jumpFloat.e!.speed * 1.2);
    // from the hit to passing height on the far side
    expect(jumpFloat.flight).toBeLessThan(float.flight - 0.1);
    expect(jump.flight).toBeLessThan(jumpFloat.flight - 0.2);
  });

  it("their speeds are those of the men's game: a float about 60 km/h, a jump float about 70, a jump serve over 90", () => {
    // top speeds measured in men's international play: 63, 73 and 125 km/h (Häyrinen et al. 2007)
    const kmh = (k: ServeKind) => serve(k).e!.speed * 3.6;
    expect(kmh('float')).toBeGreaterThan(55);
    expect(kmh('float')).toBeLessThan(66);
    expect(kmh('jumpFloat')).toBeGreaterThan(66);
    expect(kmh('jumpFloat')).toBeLessThan(78);
    expect(kmh('jump')).toBeGreaterThan(90);
    expect(kmh('jump')).toBeLessThan(125);
  });

  it('a float leaves the hand without spin and knuckles, standing or jumping; a jump serve is topspin', () => {
    for (const k of ['float', 'jumpFloat'] as const) {
      const r = serve(k);
      expect(r.spin, k).toBe(0);
      expect(r.knuckle, k).toBeGreaterThan(0);
    }
    const j = serve('jump');
    expect(j.spin).toBeGreaterThan(40);
    expect(j.knuckle).toBe(0);
  });

  it('the float is hit with the feet on the floor; the jump float and the jump serve at the top of a jump', () => {
    expect(serve('float').jumpH).toBe(0);
    const jf = serve('jumpFloat');
    const j = serve('jump');
    expect(jf.jumpH).toBeGreaterThan(0.5);
    expect(j.jumpH).toBeGreaterThan(0.5);
    expect(jf.contactY).toBeGreaterThan(serve('float').contactY + 0.5);
  });

  it('each serve has its own toss: low for the floats, high and far ahead for the jump serve', () => {
    const [float, jumpFloat, jump] = SERVE_KINDS.map((k) => serve(k));
    // how far the toss tops out over where it is hit, and how long it is in the air
    expect(float.tossApex - float.contactY).toBeGreaterThan(0.5);
    expect(float.tossApex - float.contactY).toBeLessThan(1.0);
    expect(jumpFloat.tossApex - jumpFloat.contactY).toBeGreaterThan(0.5);
    expect(jumpFloat.tossApex - jumpFloat.contactY).toBeLessThan(1.1);
    expect(jump.tossApex - jump.contactY).toBeGreaterThan(1.4);
    expect(jump.tossApex - jump.contactY).toBeLessThan(2.2);
    expect(jump.hitT - jump.tossT).toBeGreaterThan(jumpFloat.hitT - jumpFloat.tossT + 0.2);
    // the jump serve's run-up is the long one: a full spike approach against a step and a half
    const run = (r: typeof jump, back: number) => back - (r.takeoffZ - COURT.halfLength);
    expect(run(jumpFloat, SERVE.jumpFloat.back)).toBeGreaterThan(0.7);
    expect(run(jump, SERVE.jump.back)).toBeGreaterThan(run(jumpFloat, SERVE.jumpFloat.back) + 1);
  });

  it('a person has time to see the toss before the run-up has to start (the AI goes on the same step)', () => {
    expect(serve('jumpFloat').runAt).toBeGreaterThan(0.1);
    expect(serve('jump').runAt).toBeGreaterThan(0.2);
  });

  it('from where the drill stands you, a clean jump float or jump serve takes off behind the end line', () => {
    for (const k of ['jumpFloat', 'jump'] as const) {
      const r = serve(k);
      expect(r.takeoffZ - COURT.halfLength, k).toBeGreaterThan(0.8);
      expect(r.e!.footFault, k).toBe(false);
    }
    // the jump serve carries the server into the court (FIVB rule 12.4.3 allows the landing)
    expect(serve('jump').landZ).toBeLessThan(COURT.halfLength);
  });

  it('a hop on the spot under a float toss adds height, not pace: the pace of a jump float comes from its run-up', () => {
    const standing = serve('float');
    const hop = serveRun({ kind: 'float', jump: true, user: { back: SERVE.float.back } });
    const run = serve('jumpFloat');
    expect(hop.e?.serve).toBe('float');
    expect(hop.jumpH).toBeGreaterThan(0.3);
    expect(hop.contactY).toBeGreaterThan(standing.contactY + 0.3);
    expect(hop.spin).toBe(0);
    expect(hop.e!.speed).toBeLessThan(standing.e!.speed * 1.08);
    expect(run.e!.speed).toBeGreaterThan(hop.e!.speed * 1.1);
  });

  it('a jump serve hit with the feet on the floor is a topspin serve with less behind it', () => {
    const standing = serveRun({ kind: 'jump', jump: false, toss: SERVE.float, user: { back: SERVE.float.back } });
    const jumped = serve('jump');
    expect(standing.e?.serve).toBe('jump');
    expect(standing.jumpH).toBe(0);
    expect(standing.spin).toBeGreaterThan(20);
    expect(standing.e!.speed).toBeLessThan(jumped.e!.speed * 0.8);
  });
});

describe('the risk of each serve (the player can fault, the AI never does)', () => {
  it('a float mistimed either way still lands in: it is the safe serve', () => {
    for (const k of ['float', 'jumpFloat'] as const)
      for (const sd of [-2, -1, 1, 2]) {
        const r = serve(k, sd);
        expect(r.e?.kind, `${k} ${sd}`).toBe('serve');
        expect(r.in, `${k} ${sd}`).toBe(true);
      }
  });

  it('a jump serve met early flies flat and long: the serve with the most pace is the one that misses', () => {
    for (const sd of [-1, -2]) {
      const r = serve('jump', sd);
      expect(r.e!.grade).toBe('Early');
      expect(r.in).toBe(false);
      expect(r.ball.z).toBeLessThan(-COURT.halfLength);
    }
  });

  it('a mistimed serve is a slower serve', () => {
    for (const k of SERVE_KINDS) expect(serve(k, 2).e!.speed, k).toBeLessThan(serve(k).e!.speed * 0.9);
  });
});

describe('the foot fault (FIVB rule 12.4.3)', () => {
  it('a float hit with the feet on the end line is a fault; from behind it, it is not', () => {
    expect(serve('float', 0, 0.05).e!.footFault).toBe(true);
    expect(serve('float', 0, 0.5).e!.footFault).toBe(false);
  });

  it('a jump serve is judged where the feet leave the floor: starting too close takes off on the line or in the court', () => {
    const close = serve('jump', 0, SERVE.jump.back - 1.2);
    expect(close.takeoffZ).toBeLessThan(COURT.halfLength + SERVE.foot);
    expect(close.e!.footFault).toBe(true);
    // landing in the court after the hit is no fault
    const clean = serve('jump');
    expect(clean.landZ).toBeLessThan(COURT.halfLength);
    expect(clean.e!.footFault).toBe(false);
  });

  it('serving from outside the service zone (wide of the court) is a fault', () => {
    const a = new Athlete('OH', 1);
    a.isUser = true;
    a.place(COURT.halfWidth + 0.3, COURT.halfLength + 1, 0);
    const r = ownToss(a, 'float', 'down');
    expect(r?.kind).toBe('serve');
    expect(r!.footFault).toBe(true);
  });

  it('the AI is never called for it', () => {
    for (const k of ['float', 'jump'] as const) expect(serveRun({ kind: k }).e!.footFault).toBe(false);
  });
});

/**
 * The player tosses (`kind`) and swings by hand: `when` is 'up' (0.1 s after the toss, the ball
 * still rising through the contact point) or 'down' (as it comes back down to it).
 */
function ownToss(a: Athlete, kind: ServeKind, when: 'up' | 'down'): ContactEvent | null {
  const DT = 1 / SIM.hz;
  const state = makeBall();
  const predictor = new BallPredictor(DT, SIM.predictHorizon);
  let version = 0;
  let pv = -1;
  const ball = {
    state,
    active: true,
    lastTouch: null as unknown,
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
    hit(v: object, w: object, knuckle = 0, _t = 0, seed = 0) {
      Object.assign(state.v, v);
      Object.assign(state.w, w);
      state.knuckle = knuckle;
      state.seed = seed;
      state.kt = 0;
      version++;
    },
    launch(p: object, v: object, w: object) {
      Object.assign(state.p, p);
      Object.assign(state.v, v);
      Object.assign(state.w, w);
      version++;
    },
  };
  const events: ContactEvent[] = [];
  const host = {
    ball: ball as unknown as ContactHost['ball'],
    simTime: 0,
    env: { netTop: COURT.netHeightMen },
    aimAssist: () => 0,
    aimTargetFor: (_a: Athlete, out: THREE.Vector3) => out.set(0, 0, -6),
    emitContact: (e: ContactEvent) => events.push(e),
    rand: () => 0.5,
    passTarget: () => ({ x: 0, y: 2.35, z: 0.9, apex: 4 }),
    setOptions: () => [],
    canServe: () => true,
  } satisfies ContactHost;
  const contact = new ContactSystem(host);
  expect(contact.serveToss(a, kind)).toBe(true);
  let swung = false;
  for (let i = 0; i < SIM.hz * 3 && !events.length; i++) {
    host.simTime += DT;
    a.step(DT, host.simTime);
    if (!swung) {
      const info = contact.ideal(a, host.simTime, 0.8);
      const go = when === 'up' ? host.simTime >= 0.1 : !!info && host.simTime >= info.t - ContactSystem.swingLead(1);
      if (go) {
        contact.startSwing(a);
        swung = true;
      }
    }
    contact.step([a]);
    stepBall(state, DT, host.env);
  }
  return events[0] ?? null;
}

describe('the toss', () => {
  it('is hit at its top or on its way down: a swing at a ball still on its way up is a swing too early', () => {
    const a = new Athlete('OH', 1);
    a.isUser = true;
    a.place(0, COURT.halfLength + 1, 0);
    const up = ownToss(a, 'float', 'up');
    expect(up?.grade).toBe('Miss');
    expect(up?.note).toBe('Swung early');
    const b = new Athlete('OH', 1);
    b.isUser = true;
    b.place(0, COURT.halfLength + 1, 0);
    const down = ownToss(b, 'float', 'down');
    expect(down?.kind).toBe('serve');
    expect(down?.grade).toBe('Perfect');
  });

  it('every server waits for it: nobody hits a toss a tenth of a second after it leaves the hand', () => {
    for (const user of [undefined, { back: SERVE.float.back }]) {
      const r = serveRun({ kind: 'float', user });
      expect(r.hitT - r.tossT).toBeGreaterThan(0.7);
      expect(r.tossApex).toBeGreaterThan(r.contactY + 0.4);
    }
  });
});

describe('a serve is rated by the pass it forces (0-4, as coaches chart serves)', () => {
  it('a perfect pass is worth 1 to the server, a pass off the net 2, an out-of-system pass or an overpass 3', () => {
    expect(rateServe(3, false, true).rating).toBe(1);
    expect(rateServe(2, false, true).rating).toBe(2);
    expect(rateServe(1, false, true).rating).toBe(3);
    expect(rateServe(0, true, false).rating).toBe(3);
  });

  it('a shank nobody can play a second time is an ace; one that a team-mate saves is out of system', () => {
    expect(rateServe(0, false, false).rating).toBe(4);
    expect(rateServe(0, false, true).rating).toBe(3);
  });
});
