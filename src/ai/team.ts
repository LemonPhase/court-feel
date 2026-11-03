import * as THREE from 'three';
import { AI, BALL, COURT, PLAYER, TIMING, type PositionId } from '../config';
import { clamp, yawFromDir } from '../core/mathx';
import type { V3 } from '../physics/ball';
import type { Athlete } from '../game/athlete';
import type { Game } from '../game/game';
import { attackHeight, laneFor, quickSetFor, SETTER_SPOT, setterTouchY, type SetPlay } from '../game/plays';
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
    S: { x: 2.8, z: 6.2 }, OH1: { x: -3.0, z: 0.7 }, MB: { x: 0.0, z: 0.7 },
    OPP: { x: 3.0, z: 0.7 }, OH2: { x: -2.9, z: 6.2 }, L: { x: 0.0, z: 7.3 },
  },
  offense: {
    S: { x: SETTER_SPOT.x, z: SETTER_SPOT.z }, OH1: { x: -4.85, z: 3.7 }, MB: { x: 0.35, z: 2.8 },
    OPP: { x: 4.7, z: 3.4 }, OH2: { x: -0.4, z: 6.4 }, L: { x: 1.2, z: 6.0 },
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
      if (slot === 'MB') this.hitter.passToSetter = (g) => team.passToSetter(g);
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
    // in the air on a block there is nothing else to do; back on the floor a block that is
    // over must not keep the player at the net when the ball is dropping behind them
    if (a.state === 'air' && (a.action?.kind === 'block' || this.job === 'block')) {
      this.blocker.step(dt, g);
      return;
    }
    if (a.action?.kind === 'block' && this.job !== 'block' && a.state !== 'load' && a.action.held && a.stateT > 0.1) {
      a.action.held = false;
      a.action.releaseT = g.simTime;
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
    let tArr = pred.descendThrough(h, now);
    if (tArr > 0) pred.posAt(tArr, this.b);
    else if (pred.landT > now) {
      // already under platform height (a dribble off the tape, a low deflection): dig it where it lands
      tArr = pred.landT;
      this.b.x = pred.land.x;
      this.b.z = pred.land.z;
    } else {
      stop(a, netYaw(a.side));
      return;
    }
    const face = netYaw(a.side);
    const fx = -Math.sin(face);
    const fz = -Math.cos(face);
    const sx = this.b.x - fx * 0.45;
    const sz = this.b.z - fz * 0.45;
    const sp = ball.speed();
    const fast = clamp((sp - 12) / 10, 0, 1);
    const lead = TIMING.passLead + (TIMING.digLead - TIMING.passLead) * fast;
    // far from the spot: turn and run (no backpedalling after a tip), face the net again on arrival;
    // sprint whenever a shuffle would not get there with the platform ready in time
    const dist = Math.hypot(sx - a.pos.x, sz - a.pos.z);
    const left = tArr - lead - now;
    const needSpeed = left > 0.05 ? dist / left : 1e9;
    const d = moveTo(a, sx, sz, { face: dist < 1.1 ? face : undefined, arrive: 0.35, sprintDist: 1e9 });
    a.cmd.sprint = dist > 0.9 && needSpeed > a.stats.shuffleSpeed * 0.75;
    if (this.pressT < 0) this.err = g.rng.gauss() * (0.03 + (1 - this.skill) * 0.12) - (d > 0.8 ? 0.1 : 0);
    // anything that is not actually in progress (a block that is over, a set that never
    // got its ball, a finished swing) gives way to the pass
    const act = a.action;
    const busy = act && ((act.kind === 'pass' && !act.resolved) || act.kind === 'windup' || act.kind === 'toss'
      || (act.kind === 'swing' && !act.resolved) || (act.kind === 'block' && act.held));
    if (!busy && now >= tArr - lead + this.err && (a.state === 'ground' || a.state === 'land')) {
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
  /** where the ball was expected when the receiver was picked (re-pick if it strays, e.g. off the tape) */
  private receiverAt: Spot = { x: 0, z: 0 };
  private freeFor: unknown = null;
  private freeAthlete: Athlete | null = null;
  userSlot: Slot | null = null;
  private lastTouchRef: unknown = null;
  /** set selection bias towards the user (when the user is a front-row hitter) */
  userSetBias = 0.6;
  /** the set the user has called for themselves (keys 1-3); null = the default for their position */
  userPlay: SetPlay | null = null;
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

  /** set call for a specific hitter in a lane (the middle gets a quick timed to their jump) */
  callSetFor(h: Athlete, lanePos: PositionId): { target: V3; apex: number; hitter: Athlete | null; time?: number } {
    if (lanePos === 'MB') return this.quickFor(h);
    const lane = laneFor(lanePos, this.side);
    const y = attackHeight(h);
    return { target: { x: lane.x, y, z: lane.z }, apex: y + lane.apexAbove, hitter: h };
  }

  /** the quick for our middle, met at the top of their jump if they are up */
  private quickFor(h: Athlete) {
    const g = this.g;
    const releaseAt = h.isUser ? undefined : this.brains.get(h)?.hitter?.releaseAt;
    // the user's call picks where along the net the quick goes (1, shoot, back quick)
    const inFront = h.isUser ? this.userPlay?.inFront : undefined;
    return quickSetFor(h, g.simTime, g.ball.pos, releaseAt, inFront);
  }

  /**
   * A pass on its way to our setter: when and where the setter will touch it.
   * Null for anything else, or for a pass too far off the net to run a quick.
   */
  passToSetter(g: Game): { t: number; x: number } | null {
    const lt = g.ball.lastTouch;
    const s = this.side;
    if (!g.ball.active || !lt || lt.side !== s || (lt.kind !== 'pass' && lt.kind !== 'dig' && lt.kind !== 'free')) return null;
    if (this.touches !== 1) return null;
    const setter = this.players.get('S');
    if (!setter || lt.athlete === setter) return null;
    const pred = g.ball.ensurePrediction(g.env, g.simTime);
    const t = pred.descendThrough(setterTouchY(setter), g.simTime);
    if (t < 0) return null;
    pred.posAt(t, this.qp);
    if (Math.hypot(this.qp.x - SETTER_SPOT.x * s, this.qp.z - SETTER_SPOT.z * s) > 1.5) return null;
    return { t, x: this.qp.x };
  }
  private qp: V3 = { x: 0, y: 0, z: 0 };

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
    add('OH2', 'L', 0.35);
    // the quick only goes if the middle is up with the setter's touch
    const mb = this.players.get('MB');
    const quick = mb && mb !== setter ? this.quickFor(mb) : null;
    if (mb && quick?.onTime) options.push({ slot: 'MB', a: mb, lane: 'MB', w: 0.75 });
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
    if (pick.lane === 'MB' && quick) return quick;
    // the user's call (a go, a 3 ball, a fast back...) instead of the lane's default tempo
    const call = pick.a === user && this.userPlay && this.userPlay.inFront === undefined ? this.userPlay.lane : null;
    const lane = call ?? laneFor(pick.lane, s);
    const y = attackHeight(pick.a);
    // off a bad pass the setter can only put up a high ball
    const apexBoost = passQuality > 1.6 ? 0.4 : 0;
    const apexAbove = passQuality > 1.6 && call ? Math.max(call.apexAbove, laneFor(pick.lane, s).apexAbove) : lane.apexAbove;
    return { target: { x: lane.x, y, z: lane.z }, apex: y + apexAbove + apexBoost, hitter: pick.a };
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

  /** how long until `a` can have a platform under a ball dropping at p (feet, landing and a run) */
  reachTime(a: Athlete, p: V3): number {
    const d = Math.hypot(a.pos.x - p.x, a.pos.z - (p.z - this.side * 0.4));
    // a long way is run, not shuffled
    const v = d > 1.5 ? a.stats.approachSpeed * 0.8 : a.stats.shuffleSpeed * 0.9;
    let t = d / v + AI.reactionTime;
    // a blocker still up at the net has to come down first
    if (a.state === 'air') {
      const vy = a.vel.y;
      t += (vy + Math.sqrt(Math.max(0, vy * vy + 2 * BALL.gravity * a.pos.y))) / BALL.gravity + PLAYER.landRecover;
    } else if (a.state === 'land') t += Math.max(0, PLAYER.landRecover - a.stateT);
    else if (a.state === 'load') t += 0.7;
    return t;
  }

  /**
   * A team-mate (or the user) best placed to take a ball dropping at p: the one who
   * gets there first, preferring anyone who can actually make it. Someone is always
   * sent (a desperate dig beats watching it drop) unless `exclude` was the only option.
   */
  private pickReceiver(p: V3, serve: boolean, exclude: Athlete | null = null): Athlete | null {
    let best: Athlete | null = null;
    let bestT = 1e9;
    for (const [slot, a] of this.players) {
      if (a === exclude) continue;
      if (serve && (slot === 'S' || slot === 'MB' || slot === 'OPP')) continue;
      let t = this.reachTime(a, p);
      if (slot === 'S') t += 0.4; // the setter digs only if nobody else can
      if (slot === 'L') t -= 0.15;
      if (a.isUser) t -= 0.25; // the user's own zone: give it to them
      if (t < bestT) {
        bestT = t;
        best = a;
      }
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
      const ourBlock = lt && lt.side === this.side && lt.kind === 'block';
      const inBounds = Math.abs(p.x) < COURT.halfWidth + 0.3 && Math.abs(p.z) < COURT.halfLength + 0.3;
      // the receiver sticks to one ball, unless the ball is no longer going where they were sent
      const strayed = comingToUs && tDown > 0 && Math.hypot(p.x - this.receiverAt.x, p.z - this.receiverAt.z) > 1.5;
      const receive = (serve: boolean, exclude: Athlete | null) => {
        if (this.receiver && this.receiverFor === lt && !strayed) {
          setJob(this.receiver, 'receive');
        } else if (comingToUs && tDown > 0 && inBounds) {
          const r = this.pickReceiver(p, serve, exclude);
          this.receiver = r;
          this.receiverFor = lt;
          this.receiverAt = { x: p.x, z: p.z };
          if (r) setJob(r, 'receive');
        }
      };
      if (theirBall || (lt?.kind === 'block' && lt.side !== this.side)) {
        // the other team touched it last: defend, receive if it is coming
        form = lt?.kind === 'serve' ? 'receive' : 'defense';
        receive(lt?.kind === 'serve', null);
        // blockers read their set
        if (lt?.kind === 'set' && !onOurSide) {
          for (const a of this.frontRow()) setJob(a, 'block', this.formSpot('defense', this.slotOf(a)));
        }
      } else if (ourBlock) {
        // our block touched it and it is dropping back on our side: a block is not a touch,
        // so somebody (preferably not the blocker) picks it up and we run our offence
        form = 'defense';
        receive(false, lt?.athlete ?? null);
      } else if (ourBall) {
        form = 'offense';
        if (this.touches === 1) {
          // second ball: the setter (or the libero if the setter played the first)
          let setter = this.players.get('S');
          if (setter && lt?.athlete === setter) setter = this.players.get('L');
          if (setter && !setter.isUser) {
            // a pass the setter cannot run down (dug from the back row): whoever is closest
            // bumps the second ball. Decided once per ball, so the two never leave it to each other.
            if (this.freeFor !== lt) {
              this.freeFor = lt;
              this.freeAthlete = null;
              if (comingToUs && tDown > 0) {
                const tHands = pred.descendThrough(setterTouchY(setter), now);
                const tAt = tHands > 0 ? tHands : tDown;
                if (tHands > 0) pred.posAt(tHands, this.qp);
                else Object.assign(this.qp, p);
                // the setter releases at once and runs: only a hopeless one gives it up
                const d = Math.hypot(setter.pos.x - this.qp.x, setter.pos.z - this.qp.z);
                const tRun = d / setter.stats.approachSpeed + 0.15 + (setter.state === 'air' ? 0.5 : 0);
                if (tRun > tAt - now + 0.05) this.freeAthlete = this.pickReceiver(p, false, lt?.athlete ?? null);
              }
            }
            const r = this.freeAthlete;
            if (r && r !== setter) setJob(r, 'free');
            else setJob(setter, 'set');
          }
        } else if (this.touches >= 2) {
          // third ball: the set hitter attacks; if nobody can, someone bumps it over
          const h = this.setFor;
          const hb = h ? this.brains.get(h) : null;
          // a set our hitter never went for (still up from a block, caught at the net): keep it in play
          const stranded = lt?.kind === 'set' && hb?.hitter && hb.hitter.phase === 'ready' && !hb.hitter.plan
            && comingToUs && tDown > 0 && tDown - now < 0.9;
          if (lt?.kind !== 'set' || (h && !h.isUser && hb && !hb.hitter) || stranded) {
            if (this.freeFor !== lt) {
              this.freeFor = lt;
              this.freeAthlete = comingToUs && tDown > 0 ? this.pickReceiver(p, false, lt?.athlete ?? null) : null;
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
