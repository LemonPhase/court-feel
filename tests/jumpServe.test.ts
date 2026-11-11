import { describe, expect, it } from 'vitest';
import * as THREE from 'three';
import { AI, COURT, SIM } from '../src/config';
import { Athlete } from '../src/game/athlete';
import { ContactSystem, type ContactEvent, type ContactHost } from '../src/game/contact';
import type { Game } from '../src/game/game';
import { makeBall, stepBall, type BallState } from '../src/physics/ball';
import { BallPredictor } from '../src/physics/predict';
import { ServerBrain } from '../src/ai/server';

const DT = 1 / SIM.hz;

/** the ball as the contact system and the serve brain see it */
class Ball {
  state: BallState = makeBall();
  predictor = new BallPredictor(DT, SIM.predictHorizon);
  version = 0;
  private pv = -1;
  lastTouch: any = null;
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
  hit(v: any, w: any) {
    Object.assign(this.state.v, v);
    Object.assign(this.state.w, w);
    this.version++;
  }
  launch(p: any, v: any, w: any) {
    Object.assign(this.state.p, p);
    Object.assign(this.state.v, v);
    Object.assign(this.state.w, w);
    this.active = true;
    this.version++;
  }
}

/**
 * An AI jump serve from the home end line (aimed deep at zone 1 of the far court), with the
 * server's timing error drawn as `sd` standard deviations: the whole run-up, toss and swing on
 * the real contact system, then the served ball's flight to the floor.
 */
function jumpServe(sd: number, aim = new THREE.Vector3(-3.5, 0, -7.5), jump = true) {
  const ball = new Ball();
  const events: ContactEvent[] = [];
  const host = {
    ball: ball as any,
    simTime: 0,
    env: { netTop: COURT.netHeightMen },
    aimAssist: () => 0,
    aimTargetFor: (a: Athlete, out: THREE.Vector3) => out.copy(a.aiAim),
    emitContact: (e: ContactEvent) => events.push(e),
    rand: () => 0.5,
    passTarget: () => ({ x: 0, y: 2.35, z: 0.9, apex: 4 }),
    setOptions: () => [],
    canServe: () => true,
  } satisfies ContactHost;
  const contact = new ContactSystem(host);
  const g = {
    get simTime() {
      return host.simTime;
    },
    env: host.env,
    ball,
    contact,
    rng: { next: () => 0.5, gauss: () => sd },
  };
  const a = new Athlete('OH', 1);
  const brain = new ServerBrain(a);
  brain.serve(aim, -2.5, jump);
  a.place(brain.spot.x, brain.spot.z, 0);
  const r = {
    tossApex: 0,
    takeoffZ: NaN,
    landZ: NaN,
    contactY: NaN,
    apex: 0,
    overTape: NaN,
    e: null as ContactEvent | null,
    ball: { x: NaN, z: NaN },
  };
  for (let i = 0; i < SIM.hz * 6; i++) {
    brain.step(DT, g as unknown as Game);
    host.simTime += DT;
    a.step(DT, host.simTime);
    contact.step([a]);
    const z0 = ball.pos.z;
    stepBall(ball.state, DT, host.env);
    if (!r.e && events.length) {
      r.e = events[0];
      r.contactY = ball.pos.y;
    }
    if (!r.e && ball.lastTouch?.kind === 'feed') r.tossApex = Math.max(r.tossApex, ball.pos.y);
    if (a.state === 'air' && Number.isNaN(r.takeoffZ)) r.takeoffZ = a.pos.z;
    if (Number.isNaN(r.landZ) && !Number.isNaN(r.takeoffZ) && a.state === 'land') r.landZ = a.pos.z;
    if (r.e) {
      r.apex = Math.max(r.apex, ball.pos.y);
      if (z0 > 0 && ball.pos.z <= 0) r.overTape = ball.pos.y - COURT.netHeightMen;
      if (ball.pos.y < 0.3) {
        r.ball = { x: ball.pos.x, z: ball.pos.z };
        break;
      }
    }
  }
  return r;
}

describe('the jump serve (Mini Rally AI)', () => {
  it('walks into the toss, runs in, takes off behind the end line and lands in the court', () => {
    const r = jumpServe(0);
    expect(r.e?.kind).toBe('serve');
    // FIVB rule 12.4.3: take off behind the end line; the landing may be in the court
    expect(r.takeoffZ).toBeGreaterThan(COURT.halfLength);
    expect(r.landZ).toBeLessThan(COURT.halfLength);
    // the run-up: from AI.serve.jumpBack behind the line to the takeoff, more than two steps' worth
    expect(COURT.halfLength + AI.serve.jumpBack - r.takeoffZ).toBeGreaterThan(2.5);
  });

  it('the toss drops into the run-up from about 1-1.5 m over the contact, not out of the sky', () => {
    const r = jumpServe(0);
    expect(r.tossApex - r.contactY).toBeGreaterThan(0.8);
    expect(r.tossApex - r.contactY).toBeLessThan(1.6);
  });

  it('a clean jump serve is driven: hard and low over the tape', () => {
    const r = jumpServe(0);
    expect(r.e!.grade).toBe('Perfect');
    expect(r.e!.speed * 3.6).toBeGreaterThan(85);
    expect(r.overTape).toBeGreaterThan(0);
    expect(r.overTape).toBeLessThan(1.2);
  });

  it('a server never lets the toss drop past untouched: a late arm still hits it (late, lower)', () => {
    const r = jumpServe(4);
    expect(r.e?.kind).toBe('serve');
    expect(r.e!.grade).toBe('Late');
  });

  it('a jump serve met early flies flat, it does not loop up into a lob', () => {
    const r = jumpServe(-4);
    expect(r.e!.grade).toBe('Early');
    expect(r.apex - r.contactY).toBeLessThan(1.2);
    expect(r.overTape).toBeLessThan(2);
  });

  it('the AI never misses a serve: early, late, at the deep corners or short, jump or float, it clears the tape and lands in', () => {
    const aims = [
      new THREE.Vector3(-4.4, 0, -8.9),
      new THREE.Vector3(4.4, 0, -8.9),
      new THREE.Vector3(0, 0, -3.2),
      new THREE.Vector3(-3.5, 0, -7.5),
    ];
    for (const jump of [true, false])
      for (const aim of aims)
        for (const sd of [-4, -2, 0, 2, 4]) {
          const r = jumpServe(sd, aim, jump);
          const what = `${jump ? 'jump' : 'float'} at ${aim.x},${aim.z}, error ${sd} sd`;
          expect(r.e?.kind, what).toBe('serve');
          expect(r.overTape, what).toBeGreaterThan(0.1);
          expect(Math.abs(r.ball.x), what).toBeLessThan(COURT.halfWidth);
          expect(r.ball.z, what).toBeLessThan(0);
          expect(r.ball.z, what).toBeGreaterThan(-COURT.halfLength);
        }
  });
});
