import * as THREE from 'three';
import { AI, BALL, COURT, PLAYER, TIMING, type PositionId } from '../config';
import { clamp, yawFromDir } from '../core/mathx';
import type { V3 } from '../physics/ball';
import type { Athlete } from '../game/athlete';
import type { Touch } from '../game/ballEntity';
import type { Game } from '../game/game';
import {
  attackHeight,
  BACKUP_TARGET,
  laneFor,
  PIPE_HIGH_Z,
  quickSetFor,
  SETTER_SPOT,
  SETTER_TARGET,
  setterTouchY,
  type SetPlay,
} from '../game/plays';
import { BlockerBrain } from './blocker';
import { moveTo, netYaw, stop, type Brain } from './brain';
import { attackKind, readSpots, seamSpot } from './defence';
import { giveWay, shoulderToShoulder, type Mate } from './giveWay';
import { HitterBrain } from './hitter';
import { MiddleBlocker } from './middle';
import { BallRead } from './read';
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
    S: { x: 2.3, z: 1.7 },
    OH1: { x: -2.5, z: 6.0 },
    MB: { x: 0.4, z: 2.2 },
    OPP: { x: 3.4, z: 3.0 },
    OH2: { x: 0.0, z: 6.5 },
    L: { x: 2.5, z: 6.2 },
  },
  defense: {
    S: { x: 2.8, z: 6.2 },
    OH1: { x: -3.0, z: 0.7 },
    MB: { x: 0.0, z: 0.7 },
    OPP: { x: 3.0, z: 0.7 },
    OH2: { x: 0.0, z: 8.5 },
    L: { x: -2.9, z: 6.2 },
  },
  offense: {
    S: { x: SETTER_SPOT.x, z: SETTER_SPOT.z },
    OH1: { x: -4.85, z: 3.7 },
    MB: { x: 0.35, z: 2.8 },
    OPP: { x: 4.7, z: 3.4 },
    OH2: { x: -0.4, z: 6.4 },
    // the libero plays left back in defence, so it waits on that side while we attack (it no longer
    // runs across the back-row outside's path on every transition)
    L: { x: -2.4, z: 6.0 },
  },
};

export type Job = 'base' | 'receive' | 'set' | 'attack' | 'block' | 'cover' | 'serve' | 'free';

/**
 * The setter's read of a pass on its way in, made AI.setterRead after the pass and
 * called out loud. It is the decision, not a forecast: the set follows it.
 * - `in`: in system, the hitters' calls are on (quicks, fast sets)
 * - `out`: out of system, high balls only (no quick; a called fast set goes up high)
 * - `help`: the setter cannot get there; someone else plays the second ball, no set
 */
export interface SetterRead {
  /** the touch (pass, dig, free ball) this read is for */
  touch: unknown;
  setter: Athlete;
  call: 'in' | 'out' | 'help';
  /** where the setter will take the ball (their feet), and how far that is from their spot */
  at: Spot;
  off: number;
}

/** one AI player in a team: executes the job the coordinator assigns */
export class TeamPlayer implements Brain {
  job: Job = 'base';
  spot: Spot = { x: 0, z: 0 };
  readonly setter: SetterBrain;
  readonly hitter: HitterBrain | null;
  readonly blocker: BlockerBrain | MiddleBlocker;
  readonly server: ServerBrain;
  private pressT = -1;
  private err = 0;
  private b: V3 = { x: 0, y: 0, z: 0 };
  skill = AI.defenderSkill;
  /** this player's read of the other team's set (where the attack will be), and of the ball's last touch */
  readonly setRead = new BallRead({ react: AI.defence.react, reactSd: AI.defence.reactSd, err: AI.defence.readErr });
  readonly hitRead = new BallRead({ react: AI.defence.hitReact, reactSd: AI.defence.hitReactSd, err: 0 });
  /** where the set read put this defender: held while their attack flies (null: no read this rally) */
  readSpot: Spot | null = null;

  constructor(
    public athlete: Athlete,
    public slot: Slot,
    public team: TeamAI,
  ) {
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
      this.hitter.defenders = () => (team.opponents ? [...team.opponents.players.values()] : []);
      this.hitter.inSystem = () => team.setInSystem;
      if (slot === 'MB' || slot === 'OH1' || slot === 'OPP') this.hitter.passToSetter = (g) => team.passToSetter(g);
    }
    this.blocker =
      slot === 'MB'
        ? new MiddleBlocker(
            athlete,
            FORM.defense.MB.x * s,
            () => team.opponents?.players.get('MB') ?? null,
            () => team.frontRow().filter((w) => w !== athlete),
          )
        : new BlockerBrain(athlete, FORM.defense[slot].x * s, 1.3);
    this.server = new ServerBrain(athlete);
  }

  reset(): void {
    this.hitter?.reset();
    this.blocker.reset();
    this.server.phase = 'idle';
    this.pressT = -1;
    this.setRead.reset();
    this.hitRead.reset();
    this.readSpot = null;
  }

  /** playing the ball, or in a move that must not be bent (an approach, a jump): keeps its line */
  get firm(): boolean {
    const a = this.athlete;
    if (a.state !== 'ground' && a.state !== 'land') return true;
    if (this.job === 'receive' || this.job === 'free' || this.job === 'set' || this.job === 'serve' || this.job === 'block') return true;
    return !!this.hitter && this.hitter.phase !== 'ready' && this.hitter.phase !== 'recover';
  }

  step(dt: number, g: Game): void {
    this.act(dt, g);
    // anyone just walking to a spot gives way to the others
    if (!this.firm) giveWay(this.athlete, this.team.mates(this.athlete));
  }

  private act(dt: number, g: Game): void {
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
    // a touch is seen a reaction time after it: until then the body stays where the read put it
    const lt = ball.lastTouch;
    if (lt) this.hitRead.look(lt, lt.t, g.rng);
    if (!this.hitRead.seen(now)) {
      stop(a, netYaw(a.side));
      return;
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
    if (this.pressT < 0) this.err = g.rng.gauss() * (0.03 + (1 - this.skill) * 0.12) * (1 + AI.passPressure * fast) - (d > 0.8 ? 0.1 : 0);
    // anything that is not actually in progress (a block that is over, a set that never
    // got its ball, a finished swing) gives way to the pass
    const act = a.action;
    const busy =
      act &&
      ((act.kind === 'pass' && !act.resolved) ||
        act.kind === 'windup' ||
        act.kind === 'toss' ||
        (act.kind === 'swing' && !act.resolved) ||
        (act.kind === 'block' && act.held));
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
  /** the setter's read of the current pass (see SetterRead) */
  read: SetterRead | null = null;
  /** our last set was run in system (the hitter sees the whole court) */
  setInSystem = true;
  /** the setter has just called a read (the Mini Rally shows and voices it) */
  onRead: ((r: SetterRead) => void) | null = null;
  /** our serve is in the air and nobody has touched it since */
  private ourServe = false;
  /** one of us touched our own serve before the other side did: a service fault */
  serveFault = false;
  /** who plays our second ball: the setter, or the libero when the setter played the first */
  secondBy: Athlete | null = null;

  constructor(
    public side: 1 | -1,
    private g: Game,
  ) {}

  add(slot: Slot, a: Athlete, isUser: boolean): void {
    this.players.set(slot, a);
    if (isUser) this.userSlot = slot;
    else {
      const b = new TeamPlayer(a, slot, this);
      this.brains.set(a, b);
      this.g.setBrain(a, b);
    }
  }

  /** `a`'s team-mates, and who keeps their line (the user always does) */
  mates(a: Athlete): Mate[] {
    const out: Mate[] = [];
    for (const m of this.players.values()) if (m !== a) out.push({ athlete: m, firm: m.isUser || (this.brains.get(m)?.firm ?? true) });
    return out;
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
    this.read = null;
    this.ourServe = false;
    this.serveFault = false;
    this.secondBy = null;
  }

  get user(): Athlete | null {
    return this.userSlot ? (this.players.get(this.userSlot) ?? null) : null;
  }

  /** where a first ball (pass, dig) by `a` goes: the setter target, or high to the 3 m line when the setter plays it */
  firstBallTarget(a: Athlete): { x: number; y: number; z: number; apex: number } {
    const s = this.side;
    if (a === this.players.get('S'))
      return { x: BACKUP_TARGET.x * s, y: BACKUP_TARGET.y, z: BACKUP_TARGET.z * s, apex: BACKUP_TARGET.apex };
    return { x: SETTER_TARGET.x * s, y: 2.35, z: SETTER_TARGET.z * s, apex: 4.1 };
  }

  /** set call for a specific hitter in a lane (the middle gets a quick timed to their jump) */
  callSetFor(h: Athlete, lanePos: PositionId, outOfSystem = false): { target: V3; apex: number; hitter: Athlete | null; time?: number } {
    if (lanePos === 'MB') return this.quickFor(h);
    const lane = laneFor(lanePos, this.side);
    const y = attackHeight(h);
    return { target: { x: lane.x, y, z: lane.z }, apex: y + lane.apexAbove + (outOfSystem ? AI.outOfSystemApex : 0), hitter: h };
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

  /**
   * Where `setter` will take the ball now in flight: their feet, standing so it drops onto
   * the hands (as SetterBrain does). A ball that never comes down through the hands is
   * judged where it lands (`orLanding`), or not at all.
   */
  private setterSpotFor(setter: Athlete, g: Game, orLanding: boolean): Spot | null {
    const now = g.simTime;
    const pred = g.ball.ensurePrediction(g.env, now);
    const t = pred.descendThrough(setterTouchY(setter), now);
    if (t > 0) pred.posAt(t, this.rp);
    else if (orLanding && pred.landT > now) Object.assign(this.rp, pred.land);
    else return null;
    const face = this.brains.get(setter)?.setter.faceYaw ?? netYaw(this.side);
    return { x: this.rp.x + Math.sin(face) * 0.14, z: this.rp.z + Math.cos(face) * 0.14 };
  }
  private rp: V3 = { x: 0, y: 0, z: 0 };

  /**
   * The setter reads the pass `lt` (AI.setterRead after it was played) and calls it.
   * If the ball is knocked off its path on the way in (the tape, the net) they look again,
   * but a call only ever gets worse: once "high" is called the set goes up high.
   * A backup setting for the setter (who played the first ball) always calls it high.
   */
  private readPass(g: Game, setter: Athlete, lt: Touch, help: boolean): void {
    const r = this.read && this.read.touch === lt ? this.read : null;
    if (r) {
      // only while the ball is still coming down to the hands (not as it drops through them)
      if (r.call !== 'in') return;
      const at = this.setterSpotFor(setter, g, false);
      if (!at || Math.hypot(at.x - r.at.x, at.z - r.at.z) < 0.6) return;
    } else if (g.simTime - lt.t < AI.setterRead) return;
    const at = this.setterSpotFor(setter, g, !r);
    if (r && !at) return;
    const s = this.side;
    const off = at ? Math.hypot(at.x - SETTER_SPOT.x * s, at.z - SETTER_SPOT.z * s) : Infinity;
    const backup = setter !== this.players.get('S');
    const call = help ? 'help' : backup || off > AI.outOfSystem ? 'out' : 'in';
    this.read = { touch: lt, setter, call, at: at ?? { x: setter.pos.x, z: setter.pos.z }, off };
    if (call !== r?.call) this.onRead?.(this.read);
  }

  /** the setter's call: who gets the ball */
  callSet(g: Game, setter: Athlete) {
    const s = this.side;
    const options: { slot: Slot; a: Athlete; lane: PositionId; w: number }[] = [];
    // a pin hitter already running a fast set gets it only if the ball can meet the hand in time
    const fast = (a: Athlete) => (a.isUser ? null : (this.brains.get(a)?.hitter?.tempoBall ?? null));
    const fastOk = (a: Athlete) => {
      const f = fast(a);
      return !!f && f.t - g.simTime >= AI.tempo.minT && f.t - g.simTime <= AI.tempo.maxT;
    };
    const add = (slot: Slot, lane: PositionId, w: number) => {
      const a = this.players.get(slot);
      if (a && a !== setter && (!fast(a) || (fastOk(a) && !outOfSystem))) options.push({ slot, a, lane, w });
    };
    // a backup (the setter played the first ball) puts up a high ball to a pin: always out of system
    const backup = setter !== this.players.get('S');
    // out of system is what the setter called on the pass (the hitters heard it, so the set
    // must agree); without a read (none was made for this ball) judge it from where the setter is
    const read = this.read && this.read.touch === g.ball.lastTouch && this.read.setter === setter ? this.read : null;
    const outOfSystem =
      backup ||
      (read ? read.call !== 'in' : Math.hypot(setter.pos.x - SETTER_SPOT.x * s, setter.pos.z - SETTER_SPOT.z * s) > AI.outOfSystem);
    add('OH1', 'OH', AI.setWeight.outside);
    add('OPP', 'OPP', AI.setWeight.opposite);
    if (!backup) add('OH2', 'L', outOfSystem ? AI.pipe.outOfSystem : AI.pipe.inSystem);
    // the quick only goes off a good pass, and only if the middle is up with the setter's touch
    const mb = this.players.get('MB');
    const quick = mb && mb !== setter && !outOfSystem ? this.quickFor(mb) : null;
    // off a perfect pass the setter goes to the middle more: the quick is the best attack there is
    const perfect = !!read && read.off <= AI.quickWeight.perfectOff;
    if (mb && quick?.onTime) options.push({ slot: 'MB', a: mb, lane: 'MB', w: perfect ? AI.quickWeight.perfect : AI.quickWeight.good });
    // (both pins mid-run on fast sets the setter can't reach: the outside takes a high ball)
    if (!options.length) {
      const oh = this.players.get('OH1');
      if (oh && oh !== setter) options.push({ slot: 'OH1', a: oh, lane: 'OH', w: 1 });
    }
    this.setInSystem = !outOfSystem;
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
    // the fast set goes where the running hitter's hand will be, arriving then (a fixed flight)
    const f = fast(pick.a);
    if (f) return { target: { x: f.contact.x, y: f.contact.y, z: f.contact.z }, apex: f.contact.y, hitter: pick.a, time: f.t - g.simTime };
    // the user's call (a go, a 3 ball, a fast back...) instead of the lane's default tempo
    const call = pick.a === user && this.userPlay && this.userPlay.inFront === undefined ? this.userPlay.lane : null;
    const lane = call ?? laneFor(pick.lane, s);
    const y = attackHeight(pick.a);
    // off a bad pass the setter can only put up a high ball
    const apexBoost = outOfSystem ? AI.outOfSystemApex : 0;
    const apexAbove = outOfSystem && call ? Math.max(call.apexAbove, laneFor(pick.lane, s).apexAbove) : lane.apexAbove;
    // a back-row set off a bad pass stays well behind the 3 m line
    const z = outOfSystem && pick.lane === 'L' ? PIPE_HIGH_Z * s : lane.z;
    return { target: { x: lane.x, y, z }, apex: y + apexAbove + apexBoost, hitter: pick.a };
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
    // the serving team may not play its own serve: only the other side can
    if (lt.kind === 'serve') this.ourServe = lt.side === this.side;
    else if (lt.kind !== 'feed') {
      if (this.ourServe && lt.side === this.side) this.serveFault = true;
      this.ourServe = false;
    }
    if (lt.kind === 'block') {
      // our own block does not count; the other team's block starts us on a fresh three
      if (lt.side !== this.side) this.touches = 0;
      return;
    }
    // our serve is not one of our three touches
    if (lt.side === this.side && lt.kind !== 'feed' && lt.kind !== 'serve') this.touches++;
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
    // team-mates at the net meet shoulder to shoulder, never through each other
    shoulderToShoulder([...this.players.values()]);
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
      // a ball that will land clearly out is let go (judged where it lands, not where it is played)
      const land = pred.land;
      const inBounds = Math.abs(land.x) < COURT.halfWidth + AI.outJudge && Math.abs(land.z) < COURT.halfLength + AI.outJudge;
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
        // a free ball over (not an attack, not a serve, not a block): an easy first ball
        const free = lt && (lt.kind === 'pass' || lt.kind === 'dig' || lt.kind === 'set' || lt.kind === 'free');
        if (free && comingToUs && tDown > 0) this.earlyTransition(lt, tDown, p, setJob);
        // on their hard attack the back-row setter releases to the net once it reads the ball isn't its own to dig
        if (lt && (lt.kind === 'spike' || lt.kind === 'tip')) this.setterRelease(lt, setJob);
        // blockers read their set
        if (lt?.kind === 'set' && !onOurSide) {
          for (const a of this.frontRow()) setJob(a, 'block', this.formSpot('defense', this.slotOf(a)));
          if (this.splitFor !== lt) this.splitStep(lt);
          this.readDefence(lt, setJob);
        } else if ((lt?.kind === 'pass' || lt?.kind === 'dig') && !onOurSide && !comingToUs) {
          // their first ball: our middle is already at work (lines up on their middle, guesses)
          const mb = this.players.get('MB');
          if (mb && !jobs.has(mb)) setJob(mb, 'block', this.formSpot('defense', 'MB'));
        }
      } else if (lt?.kind === 'serve') {
        // our own serve on its way over: not one of our touches, and nobody plays it. The team
        // settles into base defence (front row at the net to block) as the server walks in
        form = 'defense';
      } else if (ourBlock) {
        // our block touched it and it is dropping back on our side: a block is not a touch,
        // so somebody (preferably not the blocker) picks it up and we run our offence
        form = 'defense';
        receive(false, lt?.athlete ?? null);
        // a soft block: if it comes down slowly to a passer who will get there, run the offence early
        if (lt && comingToUs && tDown > 0 && ball.speed() < AI.transition.softSpeed) this.earlyTransition(lt, tDown, p, setJob);
      } else if (ourBall) {
        form = 'offense';
        for (const b of this.brains.values()) b.readSpot = null;
        if (this.touches === 1) {
          // second ball: the setter, or the libero as backup if the setter played the first (the
          // libero, not whoever is closest). A setter who played the first ball stays out of the
          // second and goes back to defend
          const S = this.players.get('S');
          const setter = S && lt?.athlete === S ? this.players.get('L') : S;
          if (setter !== S) setJob(S, 'base', this.formSpot('defense', 'S'));
          this.secondBy = setter ?? null;
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
            // (a good pass is not "coming to us" by the floor test: left alone it would drop at the net)
            if (lt) this.readPass(g, setter, lt, !!r && r !== setter);
          }
        } else if (this.touches >= 2) {
          // third ball: the set hitter attacks; if nobody can, someone bumps it over
          const h = this.setFor;
          const hb = h ? this.brains.get(h) : null;
          // a set our hitter never went for (still up from a block, caught at the net): keep it in play
          const stranded =
            lt?.kind === 'set' &&
            hb?.hitter &&
            hb.hitter.phase === 'ready' &&
            !hb.hitter.plan &&
            comingToUs &&
            tDown > 0 &&
            tDown - now < 0.9;
          if (this.touches >= 3) {
            // out of touches: nobody plays it (a fourth touch is a fault either way)
          } else if (lt?.kind !== 'set' || (h && !h.isUser && hb && !hb.hitter) || stranded) {
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
    const attackFlying = live && lt && lt.side !== this.side && (lt.kind === 'spike' || lt.kind === 'tip');
    for (const [slot, a] of this.players) {
      if (a.isUser || jobs.has(a)) continue;
      const held = attackFlying ? this.brains.get(a)?.readSpot : null;
      const spot = held ?? this.formSpot(form, slot);
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

  /**
   * The defence reads their set: each defender, a reaction time after the set, works out from its own
   * read of where the hitter will meet it (rough off the hands, clear as it comes down) which kind of
   * attack it is and where perimeter defence puts it (src/ai/defence.ts). Until then it holds base.
   */
  private readDefence(set: Touch, setJob: (a: Athlete | undefined, job: Job, spot?: Spot) => void): void {
    const g = this.g;
    const now = g.simTime;
    if (this.attackFor !== set) {
      // where their hitter meets it: around 3.2 m on the way down, a quick at the top of its arc
      const pred = g.ball.ensurePrediction(g.env, now);
      let tc = pred.descendThrough(3.25, now);
      if (tc < 0) tc = pred.apex().t;
      pred.posAt(tc, this.ap);
      this.attackFor = set;
      this.attack = { x: this.ap.x, z: this.ap.z, t: tc };
    }
    const atk = this.attack;
    const s = this.side;
    for (const slot of ['S', 'L', 'OH2', 'OH1', 'OPP'] as const) {
      const a = this.players.get(slot);
      const b = a ? this.brains.get(a) : null;
      if (!a || !b || a.isUser) continue;
      b.setRead.look(set, set.t, g.rng);
      if (!b.setRead.seen(now)) continue;
      const x = b.setRead.x(atk.x, now, atk.t) * s;
      const off = Math.abs(atk.z);
      const spot = readSpots({ x, off, kind: attackKind(x, off) })[slot];
      const back = slot === 'S' || slot === 'L' || slot === 'OH2';
      if (spot) {
        b.readSpot = { x: spot.x * s, z: spot.z * s };
        setJob(a, 'base', b.readSpot);
      } else if (back) b.readSpot = this.formSpot('defense', slot);
    }
    this.readBlockSeam(set, setJob);
  }
  private attackFor: unknown = null;
  private attack = { x: 0, z: 0, t: 0 };
  private ap: V3 = { x: 0, y: 0, z: 0 };

  /**
   * An easy first ball (their free ball, our soft block) that our passer will get to with time to
   * spare: a moment after the touch the setter releases to the net and the front row leaves it to
   * approach, before the pass is even made.
   */
  private earlyTransition(t: Touch, tDown: number, p: V3, setJob: (a: Athlete | undefined, job: Job, spot?: Spot) => void): void {
    const g = this.g;
    const now = g.simTime;
    const r = this.receiver;
    if (!r || now - t.t < AI.transition.read) return;
    if (this.reachTime(r, p) + AI.transition.spare > tDown - now) return;
    const S = this.players.get('S');
    if (S && S !== r) setJob(S, 'base', this.formSpot('offense', 'S'));
    for (const slot of ['OH1', 'MB', 'OPP'] as const) {
      const a = this.players.get(slot);
      if (a && a !== r) setJob(a, 'attack', this.formSpot('offense', slot));
    }
  }

  /**
   * On their hard attack (a spike or tip) the back-row setter releases to the net as soon as it can
   * see the ball isn't its own to dig: once its read of the hit is in (`AI.defence.hitReact` ±
   * `hitReactSd` after the contact, the same reaction every defender has to a hit) and our receiver
   * is someone else. The front row stays put (leaving the net before a hard dig is a separate item,
   * and its early transition stays limited to free balls and soft blocks). A front-row setter is
   * blocking, not releasing (the Mini Rally has no rotation, so the setter is never front row).
   */
  private setterRelease(t: Touch, setJob: (a: Athlete | undefined, job: Job, spot?: Spot) => void): void {
    const S = this.players.get('S');
    const b = S ? this.brains.get(S) : null;
    if (!S || !b || this.frontRow().includes(S)) return;
    if (this.receiverFor !== t || this.receiver === S) return;
    b.hitRead.look(t, t.t, this.g.rng);
    if (!b.hitRead.seen(this.g.simTime)) return;
    setJob(S, 'base', this.formSpot('offense', 'S'));
  }

  /**
   * The middle back reads our own block as it goes up: once both our blockers on their pin attack
   * are in the air (the cue), a reaction time later (`AI.defence.react` ± `reactSd`, as for its read
   * of the set) it looks at their hands. If the middle is late and the hands leave a seam, it steps
   * up onto the seam's line (`AI.defence.middleBackSeam`) instead of staying deep, cross of a closed
   * block. It reads the hands (a late middle's reach can close the seam), not the bodies, and only
   * while their set flies: after their contact it holds what it read, like every defender.
   */
  private readBlockSeam(set: Touch, setJob: (a: Athlete | undefined, job: Job, spot?: Spot) => void): void {
    const g = this.g;
    const now = g.simTime;
    const mb = this.players.get('OH2');
    const b = mb ? this.brains.get(mb) : null;
    if (!mb || !b || mb.isUser || !b.readSpot || !b.setRead.seen(now)) return;
    const s = this.side;
    const atk = this.attack;
    const x = b.setRead.x(atk.x, now, atk.t) * s;
    const off = Math.abs(atk.z);
    if (attackKind(x, off) !== 'pin') return;
    const wing = this.players.get(x >= 0 ? 'OPP' : 'OH1');
    const middle = this.players.get('MB');
    if (!wing || !middle || !wing.airborne || !middle.airborne) return;
    this.seamRead.look(set, now, g.rng);
    if (!this.seamRead.seen(now)) return;
    const spot = seamSpot({ x, off, kind: 'pin' }, (wing.pos.x + wing.reachX) * s, (middle.pos.x + middle.reachX) * s);
    if (!spot) return;
    b.readSpot = { x: spot.x * s, z: spot.z * s };
    setJob(mb, 'base', b.readSpot);
  }
  private readonly seamRead = new BallRead({ react: AI.defence.react, reactSd: AI.defence.reactSd, err: 0 });

  /** the defenders (not the front row, it blocks) split-step to land as their hitter meets this set */
  private splitStep(set: Touch): void {
    this.splitFor = set;
    const g = this.g;
    const pred = g.ball.ensurePrediction(g.env, g.simTime);
    // met around 3.2 m on the way down; a quick at the top of its arc
    let tc = pred.descendThrough(3.25, g.simTime);
    if (tc < 0) tc = pred.apex().t;
    const front = this.frontRow();
    for (const a of this.players.values()) if (!a.isUser && !front.includes(a)) a.splitT = tc - AI.splitStep.dip - AI.splitStep.air;
  }
  private splitFor: unknown = null;

  slotOf(a: Athlete): Slot {
    for (const [s, x] of this.players) if (x === a) return s;
    return 'L';
  }

  /** begin a serve by this team's server */
  serve(target: THREE.Vector3, jump = false): Athlete {
    const server = this.players.get(this.userSlot === 'OH2' ? 'OPP' : 'OH2')!;
    const b = this.brains.get(server)!;
    b.job = 'serve';
    b.server.serve(target, this.side * -2.5, jump);
    return server;
  }
}

export const faceNet = (side: 1 | -1) => yawFromDir(0, -side);
