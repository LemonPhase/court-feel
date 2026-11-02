import * as THREE from 'three';
import { AI, COURT, TIMING, type PositionId } from '../config';
import { clamp, yawFromDir } from '../core/mathx';
import type { V3 } from '../physics/ball';
import type { Athlete } from '../game/athlete';
import type { Game } from '../game/game';
import { attackHeight, laneFor, SETTER_SPOT } from '../game/plays';
import { BlockerBrain } from './blocker';
import { moveTo, netYaw, stop, type Brain } from './brain';
import { HitterBrain } from './hitter';
import { ServerBrain } from './server';
import { SetterBrain } from './setter';

/** the six team slots (no rotation: a sandbox mini rally) */
export type Slot = 'S' | 'OH1' | 'MB' | 'OPP' | 'OH2' | 'L';
export const SLOTS: Slot[] = ['S', 'OH1', 'MB', 'OPP', 'OH2', 'L'];
export const SLOT_ROLE: Record<Slot, PositionId> = { S: 'S', OH1: 'OH', MB: 'MB', OPP: 'OPP', OH2: 'OH', L: 'L' };
export const USER_SLOT: Record<PositionId, Slot> = { OH: 'OH1', OPP: 'OPP', MB: 'MB', S: 'S', L: 'L' };

type Spot = { x: number; z: number };
/** formations for the home side (+z); mirrored for the away side */
const FORM: Record<'receive' | 'defense' | 'offense', Record<Slot, Spot>> = {
  receive: {
    S: { x: 2.3, z: 1.7 }, OH1: { x: -2.5, z: 6.0 }, MB: { x: 0.4, z: 2.2 },
    OPP: { x: 3.4, z: 3.0 }, OH2: { x: 0.0, z: 6.5 }, L: { x: 2.5, z: 6.2 },
  },
  defense: {
    S: { x: 2.8, z: 6.2 }, OH1: { x: -2.7, z: 0.7 }, MB: { x: 0.0, z: 0.7 },
    OPP: { x: 2.7, z: 0.7 }, OH2: { x: -2.9, z: 6.2 }, L: { x: 0.0, z: 7.3 },
  },
  offense: {
    S: { x: SETTER_SPOT.x, z: SETTER_SPOT.z }, OH1: { x: -4.2, z: 3.7 }, MB: { x: 0.35, z: 2.2 },
    OPP: { x: 4.0, z: 3.3 }, OH2: { x: -0.4, z: 6.4 }, L: { x: 1.2, z: 6.0 },
  },
};

export type Job = 'base' | 'receive' | 'set' | 'attack' | 'block' | 'cover' | 'serve' | 'free';

/** one AI player in a team: executes the job the coordinator assigns */
export class TeamPlayer implements Brain {
  job: Job = 'base';
  spot: Spot = { x: 0, z: 0 };
  readonly setter: SetterBrain;
  readonly hitter: HitterBrain | null;
  readonly blocker: BlockerBrain;
  readonly server: ServerBrain;
  private pressT = -1;
  private err = 0;
  private b: V3 = { x: 0, y: 0, z: 0 };
  skill = AI.defenderSkill;

  constructor(public athlete: Athlete, public slot: Slot, public team: TeamAI) {
    const s = athlete.side;
    const setterFace = s === 1 ? Math.PI / 2 : -Math.PI / 2;
    this.setter = new SetterBrain(athlete, { x: SETTER_SPOT.x * s, z: SETTER_SPOT.z * s }, setterFace);
    this.setter.shouldPlay = () => this.job === 'set';
    this.setter.call = (g) => team.callSet(g, this.athlete);
    this.setter.onSet = (c) => team.onSet(c.hitter);
    const laneRole: PositionId | null = slot === 'OH1' ? 'OH' : slot === 'MB' ? 'MB' : slot === 'OPP' ? 'OPP' : slot === 'OH2' ? 'L' : null;
    this.hitter = laneRole ? new HitterBrain(athlete, laneFor(laneRole, s)) : null;
    if (this.hitter) {
      this.hitter.isMySet = (g) => team.setFor === athlete && g.ball.lastTouch?.kind === 'set' && g.ball.lastTouch.side === s;
      this.hitter.blockers = () => team.opponents?.frontRow() ?? [];
    }
    this.blocker = new BlockerBrain(athlete, FORM.defense[slot].x * s, slot === 'MB' ? 2.8 : 1.3);
    this.server = new ServerBrain(athlete);
  }

  reset(): void {
    this.hitter?.reset();
    this.blocker.reset();
    this.server.phase = 'idle';
    this.pressT = -1;
  }

  step(dt: number, g: Game): void {
    const a = this.athlete;
    const face = netYaw(a.side);
    // an attack in progress always finishes, whatever the coordinator says
    if (this.hitter && this.hitter.phase !== 'ready' && this.hitter.phase !== 'recover') {
      this.hitter.step(dt, g);
      return;
    }
    if (a.action?.kind === 'block' || (a.state === 'air' && this.job === 'block')) {
      this.blocker.step(dt, g);
      return;
    }
    switch (this.job) {
      case 'serve':
        this.server.step(dt, g);
        break;
      case 'set':
        this.setter.step(dt, g);
        break;
      case 'attack':
        if (this.hitter) {
          this.hitter.holdSpot = null;
          this.hitter.step(dt, g);
        } else moveTo(a, this.spot.x, this.spot.z, { face });
        break;
      case 'block':
        this.blocker.homeX = this.spot.x;
        this.blocker.step(dt, g);
        break;
      case 'receive':
      case 'free':
        this.playFirstOrFree(dt, g);
        break;
      case 'cover':
      case 'base':
      default:
        if (a.action?.kind === 'pass' && a.action.resolved && g.simTime - a.action.contactT > 0.35) a.endAction();
        if (a.state === 'ground' || a.state === 'land') moveTo(a, this.spot.x, this.spot.z, { face, arrive: 0.6 });
        else stop(a, face);
        break;
    }
  }

  /** intercept the ball with the platform and pass it (to the setter, or over as a free ball) */
  private playFirstOrFree(_dt: number, g: Game): void {
    const a = this.athlete;
    const ball = g.ball;
    const now = g.simTime;
    if (!ball.active || ball.lastTouch?.athlete === a) {
      stop(a, netYaw(a.side));
      return;
    }
    // resolve first: the closest approach happens as the ball drops past the platform
    if (a.action?.kind === 'pass' && !a.action.resolved) {
      g.contact.tryPass(a, a.action);
      if (now - a.action.t0 > 1.2) a.endAction();
    }
    const pred = ball.ensurePrediction(g.env, now);
    const h = a.height * 0.34 + 0.05;
    const tArr = pred.descendThrough(h, now);
    if (tArr < 0) return;
    pred.posAt(tArr, this.b);
    const face = netYaw(a.side);
    const fx = -Math.sin(face);
    const fz = -Math.cos(face);
    const sx = this.b.x - fx * 0.45;
    const sz = this.b.z - fz * 0.45;
    const d = moveTo(a, sx, sz, { face, arrive: 0.35, sprintDist: 1.2 });
    const sp = ball.speed();
    const fast = clamp((sp - 12) / 10, 0, 1);
    const lead = TIMING.passLead + (TIMING.digLead - TIMING.passLead) * fast;
    if (this.pressT < 0) this.err = g.rng.gauss() * (0.03 + (1 - this.skill) * 0.12) - (d > 0.8 ? 0.1 : 0);
    if (!a.action && now >= tArr - lead + this.err && a.state === 'ground') {
      a.startAction('pass', now);
      this.pressT = now;
    }
  }
}

/**
 * Coordinates one side: formations, who receives, the setter's choice, who
 * blocks. The user's athlete is part of the team but never given AI jobs;
 * the coordinator just avoids doubling up on balls that are the user's.
 */
export class TeamAI {
  players = new Map<Slot, Athlete>();
  brains = new Map<Athlete, TeamPlayer>();
  touches = 0;
  setFor: Athlete | null = null;
  opponents: TeamAI | null = null;
  /** who should take the incoming first ball (sticky per incoming ball) */
  receiver: Athlete | null = null;
  private receiverFor: unknown = null;
  private freeFor: unknown = null;
  private freeAthlete: Athlete | null = null;
  userSlot: Slot | null = null;
  private lastTouchRef: unknown = null;
  /** set selection bias towards the user (when the user is a front-row hitter) */
  userSetBias = 0.6;
  serving = false;

  constructor(public side: 1 | -1, private g: Game) {}

  add(slot: Slot, a: Athlete, isUser: boolean): void {
    this.players.set(slot, a);
    if (isUser) this.userSlot = slot;
    else {
      const b = new TeamPlayer(a, slot, this);
      this.brains.set(a, b);
      this.g.setBrain(a, b);
    }
  }

  frontRow(): Athlete[] {
    return (['OH1', 'MB', 'OPP'] as Slot[]).map((s) => this.players.get(s)!).filter(Boolean);
  }

  formSpot(form: 'receive' | 'defense' | 'offense', slot: Slot): Spot {
    const f = FORM[form][slot];
    return { x: f.x * this.side, z: f.z * this.side };
  }

  place(form: 'receive' | 'defense' | 'offense'): void {
    for (const [slot, a] of this.players) {
      const p = this.formSpot(form, slot);
      if (!a.isUser) a.place(p.x, p.z, netYaw(this.side));
    }
    for (const b of this.brains.values()) b.reset();
    this.touches = 0;
    this.setFor = null;
    this.receiver = null;
  }

  get user(): Athlete | null {
    return this.userSlot ? this.players.get(this.userSlot) ?? null : null;
  }

  /** set call for a specific hitter in a lane */
  callSetFor(h: Athlete, lanePos: PositionId) {
    const lane = laneFor(lanePos, this.side);
    const y = attackHeight(h);
    return { target: { x: lane.x, y, z: lane.z }, apex: y + lane.apexAbove, hitter: h };
  }

  /** the setter's call: who gets the ball */
  callSet(g: Game, setter: Athlete) {
    const s = this.side;
    const options: { slot: Slot; a: Athlete; lane: PositionId; w: number }[] = [];
    const add = (slot: Slot, lane: PositionId, w: number) => {
      const a = this.players.get(slot);
      if (a && a !== setter) options.push({ slot, a, lane, w });
    };
    add('OH1', 'OH', 1.2);
    add('OPP', 'OPP', 1.0);
    add('MB', 'MB', 0.8);
    add('OH2', 'L', 0.35);
    // bad pass: high ball to the outside
    const passQuality = Math.hypot(setter.pos.x - SETTER_SPOT.x * s, setter.pos.z - SETTER_SPOT.z * s);
    if (passQuality > 1.6) for (const o of options) if (o.lane === 'MB') o.w = 0.05;
    const user = this.user;
    let pick = options[0];
    const userOpt = options.find((o) => o.a === user);
    if (userOpt && g.rng.next() < this.userSetBias) pick = userOpt;
    else {
      const total = options.reduce((t, o) => t + o.w, 0);
      let r = g.rng.next() * total;
      for (const o of options) {
        r -= o.w;
        if (r <= 0) {
          pick = o;
          break;
        }
      }
    }
    const lane = laneFor(pick.lane, s);
    const y = attackHeight(pick.a);
    const apexBoost = passQuality > 1.6 ? 0.4 : 0;
    return { target: { x: lane.x, y, z: lane.z }, apex: y + lane.apexAbove + apexBoost, hitter: pick.a };
  }

  onSet(hitter: Athlete | null): void {
    this.setFor = hitter;
    if (hitter && hitter.isUser) this.g.hud.message('Set to you · attack!', 1.2);
  }

  /** count touches for this side, reset when the other side touches */
  private trackTouches(): void {
    const lt = this.g.ball.lastTouch;
    if (!lt || lt === this.lastTouchRef) return;
    this.lastTouchRef = lt;
    if (lt.kind === 'block') return; // blocks do not count
    if (lt.side === this.side && lt.kind !== 'feed') this.touches++;
    else if (lt.side !== this.side) this.touches = 0;
    if (lt.kind === 'set' && lt.side === this.side) {
      // user set: whoever the aim picked
      if (lt.athlete?.isUser) this.setFor = this.g.contact.lastSet?.hitter ?? null;
    }
  }

  /** a team-mate (or the user) best placed to take a ball dropping at p */
  private pickReceiver(p: V3, tArr: number, serve: boolean): Athlete | null {
    const now = this.g.simTime;
    let best: Athlete | null = null;
    let bestT = 1e9;
    for (const [slot, a] of this.players) {
      if (serve && (slot === 'S' || slot === 'MB' || slot === 'OPP')) continue;
      if (!serve && slot === 'S' && this.touches === 0) {
        // the setter digs only if nobody else can
      }
      const d = Math.hypot(a.pos.x - p.x, a.pos.z - (p.z - this.side * 0.4));
      const speed = a.stats.shuffleSpeed * 0.9;
      let t = d / speed + AI.reactionTime;
      if (slot === 'S') t += 0.4;
      if (slot === 'L') t -= 0.15;
      if (a.isUser) t -= 0.25; // the user's own zone: give it to them
      if (t < bestT) {
        bestT = t;
        best = a;
      }
    }
    if (best && bestT > tArr - now + 0.35 && !best.isUser) {
      // unreachable: still send the closest one (a desperate dig)
    }
    return best;
  }

  step(): void {
    const g = this.g;
    const ball = g.ball;
    const now = g.simTime;
    this.trackTouches();
    const live = ball.active && !ball.state.rest && g.ballLive;
    const lt = ball.lastTouch;
    const jobs = new Map<Athlete, { job: Job; spot: Spot }>();
    const setJob = (a: Athlete | undefined, job: Job, spot?: Spot) => {
      if (!a || a.isUser) return;
      jobs.set(a, { job, spot: spot ?? { x: a.pos.x, z: a.pos.z } });
    };
    let form: 'receive' | 'defense' | 'offense' = 'defense';
    if (this.receiverFor !== lt) this.receiver = null;
    if (!live) {
      this.receiver = null;
      form = this.serving ? 'defense' : 'receive';
    } else {
      const pred = ball.ensurePrediction(g.env, now);
      const onOurSide = ball.pos.z * this.side > 0;
      const tDown = pred.descendThrough(0.75, now);
      let comingToUs = false;
      const p: V3 = { x: 0, y: 0, z: 0 };
      if (tDown > 0) {
        pred.posAt(tDown, p);
        comingToUs = p.z * this.side > 0.05;
      }
      const theirBall = lt && lt.side !== this.side && lt.kind !== 'block';
      const ourBall = lt && lt.side === this.side && lt.kind !== 'block';
      if (theirBall || (lt?.kind === 'block' && lt.side !== this.side)) {
        // the other team touched it last: defend, receive if it is coming
        form = lt?.kind === 'serve' ? 'receive' : 'defense';
        if (this.receiver && this.receiverFor === lt) {
          setJob(this.receiver, 'receive');
        } else if (comingToUs && tDown > 0) {
          const inBounds = Math.abs(p.x) < COURT.halfWidth + 0.3 && Math.abs(p.z) < COURT.halfLength + 0.3;
          const serve = lt?.kind === 'serve';
          if (inBounds) {
            const r = this.pickReceiver(p, tDown, serve);
            this.receiver = r;
            this.receiverFor = lt;
            if (r) setJob(r, 'receive');
          }
        }
        // blockers read their set
        if (lt?.kind === 'set' && !onOurSide) {
          for (const a of this.frontRow()) setJob(a, 'block', this.formSpot('defense', this.slotOf(a)));
        }
      } else if (ourBall) {
        form = 'offense';
        if (this.touches === 1) {
          // second ball: the setter (or the libero if the setter played the first)
          let setter = this.players.get('S');
          if (setter && lt?.athlete === setter) setter = this.players.get('L');
          if (setter && !setter.isUser) setJob(setter, 'set');
        } else if (this.touches >= 2) {
          // third ball: the set hitter attacks; if nobody can, someone bumps it over
          const h = this.setFor;
          const hb = h ? this.brains.get(h) : null;
          if (lt?.kind !== 'set' || (h && !h.isUser && hb && !hb.hitter)) {
            if (this.freeFor !== lt) {
              this.freeFor = lt;
              this.freeAthlete = comingToUs && tDown > 0 ? this.pickReceiver(p, tDown, false) : null;
            }
            const r = this.freeAthlete;
            if (r && lt?.athlete !== r) setJob(r, 'free');
          }
        }
      }
    }
    // assign everyone else to the formation (hitters get 'attack' in offense)
    for (const [slot, a] of this.players) {
      if (a.isUser || jobs.has(a)) continue;
      const spot = this.formSpot(form, slot);
      if (form === 'offense' && (slot === 'OH1' || slot === 'MB' || slot === 'OPP' || slot === 'OH2')) setJob(a, 'attack', spot);
      else setJob(a, 'base', spot);
    }
    // serving
    for (const [a, j] of jobs) {
      const b = this.brains.get(a)!;
      if (b.job === 'serve' && b.server.phase !== 'done' && b.server.phase !== 'idle') continue;
      b.job = j.job;
      b.spot = j.spot;
    }
  }

  slotOf(a: Athlete): Slot {
    for (const [s, x] of this.players) if (x === a) return s;
    return 'L';
  }

  /** begin a serve by this team's server */
  serve(target: THREE.Vector3): Athlete {
    const server = this.players.get(this.userSlot === 'OH2' ? 'OPP' : 'OH2')!;
    const b = this.brains.get(server)!;
    b.job = 'serve';
    b.server.serve(target, this.side * -2.5);
    return server;
  }
}

export const faceNet = (side: 1 | -1) => yawFromDir(0, -side);
