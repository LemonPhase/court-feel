import * as THREE from 'three';
import { COURT, SERVE, SIM, type ServeKind } from '../src/config';
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
  hit(v: any, w: any, knuckle = 0) {
    Object.assign(this.state.v, v);
    Object.assign(this.state.w, w);
    this.state.knuckle = knuckle;
    this.version++;
  }
  launch(p: any, v: any, w: any) {
    Object.assign(this.state.p, p);
    Object.assign(this.state.v, v);
    Object.assign(this.state.w, w);
    this.state.knuckle = 0;
    this.active = true;
    this.version++;
  }
}

export interface ServeRunOptions {
  /** which serve (the toss, the start, the run-up) */
  kind?: ServeKind;
  /** the server's timing error, in standard deviations of the brain's error for that serve */
  sd?: number;
  /** where it is aimed (the floor of the far court) */
  aim?: THREE.Vector3;
  /** meet a standing serve's toss off a jump on the spot, or hit a jump serve's spin with the feet on the floor */
  jump?: boolean;
  /** the toss, when it is not the serve's own */
  toss?: { toss: number; tossHigh: number };
  /**
   * The player serves: they can fault (the AI never misses a serve), and they toss the serve's own
   * toss from a standing start `back` m behind the end line (the Serve drill stands them at `SERVE[kind].back`).
   */
  user?: { back: number };
  role?: 'OH' | 'OPP' | 'MB' | 'S' | 'L';
}

/**
 * A serve from the home end line on the real contact system: the server brain's toss, run-up and
 * swing, then the served ball's flight to the floor.
 */
export function serveRun(o: ServeRunOptions = {}) {
  const { kind = 'jump', sd = 0, aim = new THREE.Vector3(-3.5, 0, -7.5), user, role = 'OH', jump, toss } = o;
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
  const a = new Athlete(role, 1);
  a.isUser = !!user;
  const brain = new ServerBrain(a);
  brain.serve(aim, -2.5, kind);
  if (user) {
    brain.back = user.back;
    brain.walkIn = 0;
    brain.toss = SERVE[kind];
  }
  if (jump !== undefined) brain.jump = jump;
  if (toss) brain.toss = toss;
  a.place(brain.spot.x, brain.spot.z, 0);
  const r = {
    tossT: NaN,
    hitT: NaN,
    tossApex: 0,
    takeoffZ: NaN,
    landZ: NaN,
    jumpH: 0,
    contactY: NaN,
    contactZ: NaN,
    apex: 0,
    /** the served ball as it left the hand: its spin (rad/s) and its knuckle (0: none) */
    spin: NaN,
    knuckle: NaN,
    overTape: NaN,
    /** the run-up: when it starts and when the plant starts, s after the toss (NaN: a standing serve) */
    runAt: NaN,
    plantAt: NaN,
    /** the server's speed at the plant, as a share of their approach speed */
    run: NaN,
    /** time from the hit to the ball being down at passing height on the far side (s) */
    flight: NaN,
    e: null as ContactEvent | null,
    ball: { x: NaN, z: NaN },
    /** the ball came down on the far side, inside the lines */
    in: false,
  };
  for (let i = 0; i < SIM.hz * 8; i++) {
    brain.step(DT, g as unknown as Game);
    host.simTime += DT;
    a.step(DT, host.simTime);
    contact.step([a]);
    const z0 = ball.pos.z;
    stepBall(ball.state, DT, host.env);
    if (Number.isNaN(r.tossT) && ball.lastTouch?.kind === 'feed') r.tossT = host.simTime;
    const plan = (brain as unknown as { plan: { tStart: number; tPress: number } | null }).plan;
    if (plan && Number.isNaN(r.runAt)) {
      r.runAt = plan.tStart - r.tossT;
      r.plantAt = plan.tPress - r.tossT;
    }
    if (a.state === 'load' && Number.isNaN(r.run)) r.run = a.loadApproach / a.stats.approachSpeed;
    if (!r.e && events.length) {
      r.e = events[0];
      r.hitT = host.simTime;
      r.contactY = ball.pos.y;
      r.contactZ = ball.pos.z;
      r.jumpH = a.state === 'air' ? a.jumpH : 0;
      const w = ball.state.w;
      r.spin = Math.hypot(w.x, w.y, w.z);
      r.knuckle = ball.state.knuckle;
    }
    if (!r.e && ball.lastTouch?.kind === 'feed') r.tossApex = Math.max(r.tossApex, ball.pos.y);
    if (a.state === 'air' && Number.isNaN(r.takeoffZ)) r.takeoffZ = a.pos.z;
    if (Number.isNaN(r.landZ) && !Number.isNaN(r.takeoffZ) && a.state === 'land') r.landZ = a.pos.z;
    if (r.e) {
      r.apex = Math.max(r.apex, ball.pos.y);
      if (z0 > 0 && ball.pos.z <= 0) r.overTape = ball.pos.y - COURT.netHeightMen;
      if (Number.isNaN(r.flight) && ball.pos.z < 0 && ball.pos.y < 0.75) r.flight = host.simTime - r.hitT;
      if (ball.pos.y < 0.3) {
        r.ball = { x: ball.pos.x, z: ball.pos.z };
        r.in = ball.pos.z < 0 && ball.pos.z > -COURT.halfLength && Math.abs(ball.pos.x) < COURT.halfWidth;
        break;
      }
    }
  }
  return r;
}
