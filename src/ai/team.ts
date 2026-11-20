import * as THREE from 'three';
import { AI, BALL, CONTACT, COURT, PLAYER, TIMING, type PositionId } from '../config';
import { clamp, lerp, Rng, smooth01, wrapAngle, yawFromDir } from '../core/mathx';
import type { V3 } from '../physics/ball';
import type { Athlete } from '../game/athlete';
import type { Touch } from '../game/ballEntity';
import type { AiHost, Brain } from '../game/brains';
import { applyCalls, callOptions, runCalls, sideLane, syncRuns, type CallHitters } from '../game/callRuns';
import { COMBOS, type Combo } from '../game/combos';
import type { TeamPlayView } from '../game/routes';
import { clashes, clashWith, SETTER_KEYS, SetterCalls, type SetterKey } from '../game/setterCalls';
import { AI_TOUCH, planSetJump } from '../game/setJump';
import {
  attackHeight,
  BACKUP_TARGET,
  isQuick,
  laneFor,
  PIPE_HIGH_Z,
  quickSetFor,
  SET_PLAYS,
  SETTER_SPOT,
  SETTER_TARGET,
  setterTouchY,
  type SetPlay,
} from '../game/plays';
import { BlockerBrain } from './blocker';
import { moveTo, netYaw, stop } from './brain';
import { attackKind, readSpots, seamSpot } from './defence';
import { giveWay, shoulderToShoulder, type Mate } from './giveWay';
import { HitterBrain } from './hitter';
import { MiddleBlocker } from './middle';
import { situationOf, type Situation } from './situation';
import { BallRead } from './read';
import { ServerBrain } from './server';
import { SetterBrain } from './setter';

/** the six team slots (no rotation: a sandbox mini rally) */
export type Slot = 'S' | 'OH1' | 'MB' | 'OPP' | 'OH2' | 'L';
export const SLOTS: Slot[] = ['S', 'OH1', 'MB', 'OPP', 'OH2', 'L'];
export const SLOT_ROLE: Record<Slot, PositionId> = { S: 'S', OH1: 'OH', MB: 'MB', OPP: 'OPP', OH2: 'OH', L: 'L' };
export const USER_SLOT: Record<PositionId, Slot> = { OH: 'OH1', OPP: 'OPP', MB: 'MB', S: 'S', L: 'L' };
/** which hitter of a play (SETTER_KEYS) each slot is: the back-row outside hits the pipe */
export const SLOT_KEY: Partial<Record<Slot, SetterKey>> = { OH1: 'OH', MB: 'MB', OPP: 'OPP', OH2: 'PIPE' };
/** the lane each hitting slot attacks from when no play is on */
const SLOT_LANE: Partial<Record<Slot, PositionId>> = { OH1: 'OH', MB: 'MB', OPP: 'OPP', OH2: 'L' };

/**
 * A combination play the AI setter runs (`AI.plays`), called on their free ball (`free`) or signalled
 * before their serve (`receive`). `signalled`: the hitters know it and line up for it; `running`:
 * the pass was good enough and the runs are on; `off`: it wasn't, the setter runs the base sets.
 */
export interface TeamPlay {
  combo: Combo;
  on: 'free' | 'receive';
  state: 'signalled' | 'running' | 'off';
  /** each hitter's route in it (yours, when you are a hitter of ours, is your own call) */
  calls: SetterCalls;
  /**
   * AI hitters who gave way to you: you changed your route onto their spot once the play was
   * running (too late for the setter to call another). They wait for a high ball and get no set.
   */
  yields: Set<SetterKey>;
}

/** the three who pass the serve (the two outsides and the libero) */
export const PASSERS: ReadonlySet<Slot> = new Set<Slot>(['OH1', 'OH2', 'L']);

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

/** hand a player a job, where to do it, and whether they are in a hurry to get there */
type SetJob = (a: Athlete | undefined, job: Job, spot?: Spot, run?: boolean, due?: number) => void;

/**
 * How hard to go (0-1 of a shuffle's top speed) to be set `d` m away in `left` s (`AI.pace`): the
 * pace that arrives `early` s before the moment, never under `min`. 1: no moment to pace to, or a
 * shuffle would be late (go as fast as it takes).
 */
export function paceFor(d: number, left: number, shuffleSpeed: number): number {
  const P = AI.pace;
  const t = left - P.early;
  if (left <= 0 || t <= 0.05) return 1;
  const need = d / t / shuffleSpeed;
  return need >= 1 ? 1 : Math.max(P.min, need);
}

/** a touch that is not an attack, a serve or a block: sent over the net it is a free ball */
const FREE_KINDS: ReadonlySet<string> = new Set(['pass', 'dig', 'set', 'free']);

/**
 * Free-ball defence, back row (home side): with the setter gone to the net and the front row off it
 * at their approach starts, the libero and the back-row outside split the court behind them, the
 * libero in the middle of it to take most balls. (Inferred spots: coaching sources give the shape, a
 * W with the setter at the net, not the numbers.)
 */
const FREE_BACK: Record<'L' | 'OH2', Spot> = { L: { x: -1.2, z: 5.6 }, OH2: { x: 2.0, z: 6.2 } };

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
  /** in a hurry to get to `spot` (see `AI.chase`) */
  run = false;
  /** when to be set at `spot` by (the hitter's contact: see `AI.pace`); 0: as soon as they get there */
  due = 0;
  /** this player's own habit this rally: how far off the book spot they stand (`AI.sit.personal`) */
  personal: Spot = { x: 0, z: 0 };
  readonly setter: SetterBrain;
  readonly hitter: HitterBrain | null;
  readonly blocker: BlockerBrain | MiddleBlocker;
  readonly server: ServerBrain;
  private pressT = -1;
  private err = 0;
  /** this ball, out of reach, is dived for anyway (decided once a ball) */
  private anyway = false;
  private anywayFor: unknown = null;
  private b: V3 = { x: 0, y: 0, z: 0 };
  skill = AI.defenderSkill;
  /** this player's read of the other team's set (where the attack will be), and of the ball's last touch */
  readonly setRead = new BallRead({ react: AI.defence.react, reactSd: AI.defence.reactSd, err: AI.defence.readErr });
  readonly hitRead = new BallRead({ react: AI.defence.hitReact, reactSd: AI.defence.hitReactSd, err: 0 });
  readonly coverRead = new BallRead({ react: AI.cover.react, reactSd: AI.defence.hitReactSd, err: 0 });
  /** when this player was last covering (s) */
  coverT = -10;
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
    // the team's setter jump-sets a pass in system; anyone else setting (the libero backing up) stays on the floor
    this.setter.jumps = slot === 'S';
    this.setter.call = (g) => team.callSet(g, this.athlete);
    this.setter.onSet = (c) => team.onSet(c.hitter);
    const laneRole = SLOT_LANE[slot];
    this.hitter = laneRole ? new HitterBrain(athlete, laneFor(laneRole, s)) : null;
    if (this.hitter) {
      this.hitter.isMySet = (g) => team.setFor === athlete && g.ball.lastTouch?.kind === 'set' && g.ball.lastTouch.side === s;
      this.hitter.blockers = () => team.opponents?.frontRow() ?? [];
      this.hitter.defenders = () => (team.opponents ? [...team.opponents.players.values()] : []);
      this.hitter.inSystem = () => team.setInSystem;
      this.hitter.backRow = slot === 'OH2';
      this.baseRun();
    }
    this.blocker =
      slot === 'MB'
        ? new MiddleBlocker(
            athlete,
            FORM.defense.MB.x * s,
            () => team.opponents?.players.get('MB') ?? null,
            () => team.frontRow().filter((w) => w !== athlete),
          )
        : Object.assign(new BlockerBrain(athlete, FORM.defense[slot].x * s), {
            wing: true,
            mate: () => team.players.get('MB') ?? null,
            setTo: () => team.theirSetFor(),
            reads: team.pinReads,
          });
    this.server = new ServerBrain(athlete);
  }

  /** no play on: the hitter's own lane, and (the front row) its own read of the pass for a quick or a fast set */
  baseRun(): void {
    const h = this.hitter;
    const role = SLOT_LANE[this.slot];
    if (!h || !role) return;
    h.lane = laneFor(role, this.athlete.side);
    h.inFront = undefined;
    h.missedRun = false;
    h.passToSetter = this.slot === 'OH2' ? null : (g) => this.team.passToSetter(g);
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

  step(dt: number, g: AiHost): void {
    this.act(dt, g);
    // anyone just walking to a spot gives way to the others
    if (!this.firm) giveWay(this.athlete, this.team.mates(this.athlete));
  }

  private act(dt: number, g: AiHost): void {
    const a = this.athlete;
    const face = netYaw(a.side);
    // covering: low, hands ready, and still low as the ball comes off the block until it is read
    // (the animator eases into it and stands up on the run; no effect on movement)
    if (this.job === 'cover') this.coverT = g.simTime;
    // (a player running a ball down is up and going flat out, never low)
    const chasing = (this.job === 'receive' || this.job === 'free' || this.job === 'set') && a.cmd.sprint;
    a.low = !chasing && g.simTime - this.coverT < AI.cover.react + 0.3 ? 1 : 0;
    // a platform put out for a ball this player is no longer sent to (someone else took it, it never
    // came, the rally is over) comes back in: nobody runs around in a passing crouch
    const open = a.action;
    if (
      open?.kind === 'pass' &&
      !open.resolved &&
      a.state !== 'dive' &&
      this.job !== 'receive' &&
      this.job !== 'free' &&
      this.job !== 'set' &&
      g.simTime - open.t0 > AI.passDrop
    )
      a.endAction();
    // given the ball to play while running in for a set that isn't coming: the approach is broken off
    if (this.hitter?.phase === 'approach' && (this.job === 'receive' || this.job === 'free')) this.hitter.reset();
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
        // a ball that got below the hands before the setter got under it: dig it up with the
        // platform (or dive for it) rather than watch it drop
        if (this.underTheHands(g)) this.playFirstOrFree(dt, g);
        else this.setter.step(dt, g);
        break;
      case 'attack':
        if (this.hitter) {
          // out of system the ball will be a high one: wait a little deeper, for a full approach
          const lane = this.hitter.lane;
          this.hitter.holdSpot = this.team.outOfSystem(g) ? { x: lane.sx, z: lane.sz + a.side * AI.sit.outDeep } : null;
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
        if (a.state === 'ground' || a.state === 'land') {
          // sent somewhere in a hurry (running with a team-mate at a ball, the setter releasing to
          // the net): from far off they turn and run, facing where they are going
          const d = Math.hypot(this.spot.x - a.pos.x, this.spot.z - a.pos.z);
          const far = this.run && d > AI.chase.turn;
          // a spot to be set at by a known moment is walked to at the pace that gets there on it,
          // not sprinted to and then stood on (if a shuffle gets there in time)
          const pace = this.run ? 1 : paceFor(d, this.due - g.simTime, a.stats.shuffleSpeed);
          if (pace < 1) moveTo(a, this.spot.x, this.spot.z, { face, arrive: 0.6, sprintDist: 1e9, urgency: pace });
          else
            moveTo(a, this.spot.x, this.spot.z, {
              face: far ? undefined : face,
              arrive: 0.6,
              sprintDist: this.run ? AI.chase.turn : undefined,
            });
        } else stop(a, face);
        break;
    }
  }

  /**
   * Intercept the ball and pass it (to the setter, or over as a free ball): with the platform, or
   * overhand when a slow ball comes down at head height (`AI.overhand`); a ball the platform can't
   * get to on foot is run down and dived for (PLAYER.dive*). A ball going by to one side is played
   * with the platform out to that side (the contact system finds it).
   */
  private playFirstOrFree(_dt: number, g: AiHost): void {
    const a = this.athlete;
    const ball = g.ball;
    const now = g.simTime;
    if (!ball.active || ball.lastTouch?.athlete === a) {
      stop(a, netYaw(a.side));
      return;
    }
    // an attack off a green set: the hitter hid the shot until the hand, so the dig starts late
    const hit = ball.lastTouch;
    if (hit?.green && hit.side !== a.side && now - hit.t < AI.greenSetDigDelay) {
      stop(a, netYaw(a.side));
      return;
    }
    // resolve first: the closest approach happens as the ball drops past the platform
    if (a.action?.kind === 'pass' && !a.action.resolved) {
      g.contact.tryPass(a, a.action);
      if (now - a.action.t0 > 1.2) a.endAction();
    }
    // committed to a dive: the slide does the rest
    if (a.state === 'dive') return;
    // a touch is seen a reaction time after it: until then the body stays where the read put it
    // (a coverer, low and watching the block, picks up a ball off it sooner)
    const lt = ball.lastTouch;
    const covering = lt?.kind === 'block' && lt.side !== a.side && now - this.coverT < AI.cover.hold;
    const read = covering ? this.coverRead : this.hitRead;
    if (lt) read.look(lt, lt.t, g.rng);
    if (!read.seen(now)) {
      stop(a, netYaw(a.side));
      return;
    }
    const pred = ball.ensurePrediction(g.env, now);
    // overhand or platform: decided once per ball, for a ball that will still be slow when it comes down
    // to head height, somewhere the player can step to in time (a float serve is taken high, in front)
    if (this.formFor !== lt) {
      this.formFor = lt;
      const tH = pred.descendThrough(a.height + 0.17, now);
      let ok = false;
      if (tH > now) {
        const vH = pred.velAt(tH, this.b);
        const vArr = Math.hypot(vH.x, vH.y, vH.z);
        pred.posAt(tH, this.b);
        const run = Math.hypot(this.b.x - a.pos.x, this.b.z - a.pos.z);
        const left = tH - TIMING.setLead - now;
        ok =
          vArr <= AI.overhand.maxSpeed && run <= AI.overhand.maxRun && left > 0 && run / left <= a.stats.approachSpeed * AI.overhand.pace;
      }
      // (a free ball over from deep in the court is bumped, never pushed with the fingers)
      const deep = this.team.touches >= 2 && this.b.z * a.side > AI.freeOver.bumpFrom;
      this.hands = ok && !deep && g.rng.next() < AI.overhand.share;
    }
    let hands = this.hands;
    let tArr = hands ? pred.descendThrough(a.height + 0.17, now) : -1;
    if (tArr > 0) pred.posAt(tArr, this.b);
    else hands = false;
    if (!hands) {
      tArr = pred.descendThrough(a.height * 0.34 + 0.05, now);
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
    }
    const face = netYaw(a.side);
    const fx = -Math.sin(face);
    const fz = -Math.cos(face);
    const ahead = hands ? 0.14 : 0.45;
    let sx = this.b.x - fx * ahead;
    let sz = this.b.z - fz * ahead;
    const sp = ball.speed();
    const fast = clamp((sp - 12) / 10, 0, 1);
    let lead = hands ? TIMING.setLead : TIMING.passLead + (TIMING.digLead - TIMING.passLead) * fast;
    let dist = Math.hypot(sx - a.pos.x, sz - a.pos.z);
    // overhand is for a ball you are under: one you have to run for is played with the platform
    if (hands && dist > AI.overhand.maxRun) {
      this.hands = false;
      return;
    }
    const left = tArr - lead - now;
    const needSpeed = left > 0.05 ? dist / left : 1e9;
    // anything that is not actually in progress (a block that is over, a set that never
    // got its ball, a finished swing) gives way to the pass
    const act = a.action;
    const busy =
      act &&
      ((act.kind === 'pass' && !act.resolved && act.form !== 'platform') ||
        act.kind === 'windup' ||
        act.kind === 'toss' ||
        (act.kind === 'swing' && !act.resolved) ||
        (act.kind === 'block' && act.held));
    const onFoot = a.state === 'ground' || a.state === 'land';
    // too far for the platform to be there in time: run at where the ball comes down low, and dive for it
    if (!hands && onFoot && !busy && dist > AI.dive.minDist && needSpeed > a.stats.approachSpeed * AI.dive.late) {
      const tLow = pred.descendThrough(CONTACT.diveLow + 0.1, now);
      if (tLow > now) pred.posAt(tLow, this.low);
      const dx = this.low.x - a.pos.x;
      const dz = this.low.z - a.pos.z;
      const dl = Math.hypot(dx, dz);
      // (nobody dives backwards at a serve or a spike: that ball is played on the feet, or not at all;
      // at any other, only at the end of a chase: turned to it, running flat out that way, at a ball
      // that isn't coming fast)
      const driven = !!lt && lt.side !== a.side && (lt.kind === 'serve' || lt.kind === 'spike');
      const backwards =
        dl > 1e-3 &&
        (dz * a.side) / dl > AI.dive.back &&
        (driven ||
          (a.vel.x * dx + a.vel.z * dz) / dl <= a.stats.shuffleSpeed ||
          Math.cos(wrapAngle(a.yaw - yawFromDir(dx, dz))) <= AI.dive.chase ||
          sp > AI.dive.quick);
      // (and a dive is a reaction: none before a real one to the touch)
      const reacted = !lt || now - lt.t >= AI.dive.react;
      // (nor into the net: a ball coming down at it, or beyond it, is the other team's)
      const atNet = this.low.z * a.side < AI.dive.net;
      if (tLow > now && !backwards && !atNet) {
        // where the hands will be when the ball gets there if the dive starts now: the slide, plus the arms' stretch
        const T = tLow - now;
        const v0 = Math.max(PLAYER.diveSpeed, a.speed);
        const ts = Math.min(T, v0 / PLAYER.diveDecel);
        const reach = v0 * ts - 0.5 * PLAYER.diveDecel * ts * ts + lerp(0.45, PLAYER.diveArm, smooth01(T / PLAYER.diveDown));
        // (one just beyond the hands: dived for at the last moment the arms still get all the way
        // out; one arm reaches further still, `CONTACT.diveOut.reach`, a scrape that barely keeps it up)
        const short = (T <= PLAYER.diveDown ? AI.dive.stretch : AI.dive.fit) + CONTACT.diveOut.reach;
        if (reacted && T <= PLAYER.diveDown + 0.1 && reach - dl < AI.dive.fit && dl - reach < short) {
          a.dive(yawFromDir(dx, dz));
          a.startAction('pass', now);
          this.pressT = now;
          return;
        }
        // out of reach even at full stretch: now and then they throw themselves at it anyway
        if (this.anywayFor !== lt) {
          this.anywayFor = lt;
          this.anyway = g.rng.next() < AI.dive.anyway;
        }
        if (
          this.anyway &&
          reacted &&
          T <= PLAYER.diveDown &&
          dl - reach >= short &&
          dl - reach < AI.dive.anywayFar &&
          a.speed > a.stats.shuffleSpeed
        ) {
          a.dive(yawFromDir(dx, dz));
          a.startAction('pass', now);
          this.pressT = now;
          return;
        }
        if (dl > 0.3) {
          sx = this.low.x;
          sz = this.low.z;
          dist = dl;
          lead = 0;
        }
      }
    }
    // (our own court: nobody runs at a ball through the net)
    sz = a.side * Math.max(AI.dive.net * 0.5, sz * a.side);
    // far from the spot: turn and run (no backpedalling after a tip), face the net again on arrival;
    // sprint whenever a shuffle would not get there with the platform ready in time
    const d = moveTo(a, sx, sz, { face: dist < 1.1 ? face : undefined, arrive: 0.35, sprintDist: 1e9 });
    a.cmd.sprint = dist > 0.9 && needSpeed > a.stats.shuffleSpeed * 0.75;
    if (this.pressT < 0) this.err = g.rng.gauss() * (0.03 + (1 - this.skill) * 0.12) * (1 + AI.passPressure * fast) - (d > 0.8 ? 0.1 : 0);
    if (!busy && !(act?.kind === 'pass' && !act.resolved) && now >= tArr - lead + this.err && onFoot) {
      const p = a.startAction('pass', now);
      p.form = hands ? 'hands' : 'platform';
      this.pressT = now;
    }
  }
  /** the ball the setter is sent to has dropped below their hands, out of reach of them: too late to set */
  private underTheHands(g: AiHost): boolean {
    const a = this.athlete;
    const ball = g.ball;
    const lt = ball.lastTouch;
    if (!ball.active || !lt || lt.athlete === a || lt.side !== a.side || ball.vel.y >= 0 || this.setter.bumping) return false;
    if (ball.pos.y > a.height + 0.17 - AI.lateSet) return false;
    return Math.hypot(ball.pos.x - a.pos.x, ball.pos.z - a.pos.z) > CONTACT.setRadius;
  }
  private formFor: unknown = null;
  private hands = false;
  private low: V3 = { x: 0, y: 0, z: 0 };
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
  /** how often each of their pin hitters has gone inside, as our wings read it (`AI.wing.learn`) */
  readonly pinReads = new Map<Athlete, number>();
  /** who should take the incoming first ball (sticky per incoming ball) */
  receiver: Athlete | null = null;
  /**
   * The ball (its last touch) our AI libero has called "MINE!" on: a free ball it takes, or a ball
   * it takes from a team-mate (you too) who would have been there first
   */
  liberoCall: unknown = null;
  private receiverFor: unknown = null;
  /** where the ball was expected when the receiver was picked (re-pick if it strays, e.g. off the tape) */
  private receiverAt: Spot = { x: 0, z: 0 };
  private freeFor: unknown = null;
  /** the first ball the user (our setter, or the libero backing up) called HELP on: a team-mate takes the second */
  private userHelpFor: unknown = null;

  /**
   * The user can't get to the second ball and calls for help: the libero sets it if it can get
   * there (a high ball to a pin, out of system), else whoever is closest bumps it up. Only
   * while our first ball is in the air and the second is the user's. Returns whether it was heard.
   */
  askHelp(): boolean {
    const lt = this.g.ball.lastTouch;
    if (!lt || lt.side !== this.side || this.touches !== 1 || !this.secondBy?.isUser || this.userHelpFor === lt) return false;
    this.userHelpFor = lt;
    return true;
  }
  private freeAthlete: Athlete | null = null;
  /** who sets our second ball (decided with `freeFor`), and whether the setter called HELP */
  private secondSetter: Athlete | null = null;
  private secondHelp = false;
  /** the second ball is out of everyone's reach: no call is made on it */
  private secondDead = false;

  /**
   * Who was sent to play the ball now in flight when it isn't the setter's to set (the setter
   * called HELP, or nobody can attack the third ball): may be the user, who is told it is theirs.
   */
  freeBall(g: AiHost): Athlete | null {
    return this.freeFor === g.ball.lastTouch ? this.freeAthlete : null;
  }

  /**
   * Our first ball is going over the net (an overpass): it comes down to the setter's hands
   * `AI.overpass` m or more into their court (closer, the setter jumps and plays it while it is
   * still over our side). The setter reads it as it goes up and doesn't chase it; nobody calls a set. Read
   * once per ball, while it is still to come down to the hands (a tight pass the setter is about
   * to set would land over the net if left alone: it is no overpass).
   */
  overpass(g: AiHost): boolean {
    const lt = g.ball.lastTouch;
    const s = this.side;
    if (!g.ball.active || !lt || lt.side !== s || this.touches !== 1 || g.ball.state.rest) return false;
    if (this.overFor === lt) return this.over;
    const now = g.simTime;
    const pred = g.ball.ensurePrediction(g.env, now);
    const t = pred.descendThrough(setterTouchY(this.players.get('S')), now);
    this.overFor = lt;
    this.over = false;
    if (t > 0) {
      pred.posAt(t, this.op);
      this.over = this.op.z * s < -AI.overpass;
    }
    return this.over;
  }
  private overFor: unknown = null;
  private over = false;
  private op: V3 = { x: 0, y: 0, z: 0 };
  userSlot: Slot | null = null;
  private lastTouchRef: unknown = null;
  /** set selection bias towards the user (when the user is a front-row hitter) */
  userSetBias = 0.6;
  private ownCall: SetPlay | null = null;
  /** the set the user has called for themselves (keys 1-5); null = the first of their position's */
  get userPlay(): SetPlay | null {
    return this.ownCall;
  }
  /** your call wins whenever you make it: a play already called is fitted round it again (`fitPlay`) */
  set userPlay(p: SetPlay | null) {
    if (p === this.ownCall) return;
    this.ownCall = p;
    this.fitPlay();
  }
  /** our AI setter runs combination plays (`AI.plays`; the Mini Rally turns it on) */
  playsOn = false;
  /** the plays our setter picks from (the Mini Rally gives the user's team the play wheel, saved plays included) */
  playPool: () => readonly Combo[] = () => COMBOS;
  /** the play our setter has called for this ball, if any */
  play: TeamPlay | null = null;
  /** the setter's own dice for plays: picking one never shifts the game's other random draws */
  private playRng: Rng;
  /** a play was considered for their free ball / before this serve (once each) */
  private freeRolled = false;
  private receiveRolled = false;
  private playPassFor: unknown = null;
  serving = false;
  /** the setter's read of the current pass (see SetterRead) */
  read: SetterRead | null = null;
  /** our last set was run in system (the hitter sees the whole court) */
  setInSystem = true;
  /** the setter has just called a read (the Mini Rally shows and voices it) */
  onRead: ((r: SetterRead) => void) | null = null;
  /** our setter has just set the user (the Mini Rally tells them) */
  onUserSet: (() => void) | null = null;
  /** our serve is in the air and nobody has touched it since */
  private ourServe = false;
  /** one of us touched our own serve before the other side did: a service fault */
  serveFault = false;
  /** who sets our second ball: the setter, or the libero when the setter played the first or can't get there */
  secondBy: Athlete | null = null;
  /** the other team's touches since the ball was last ours */
  theirTouches = 0;
  /** what the team is in the middle of (src/ai/situation.ts), and where the ball in flight comes down */
  situation: Situation = 'dead';
  focus: V3 | null = null;
  /** how far the back row's base defence has shifted along the net with the ball (m, world x) */
  private shadeX = 0;
  /** their serve has been read: those it isn't going to are on their way */
  private serveSeen = false;
  /** we have read that their third ball can only be a free ball (see `freeBallDefence`) */
  freeCall = false;
  /** their serve is a jump serve: read off the toss (the passers step back: `AI.sit.jumpBack`) */
  jumpServe = false;

  constructor(
    public side: 1 | -1,
    private g: AiHost,
  ) {
    this.playRng = new Rng(side === 1 ? AI.plays.seed.home : AI.plays.seed.away);
  }

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
    for (const b of this.brains.values()) {
      b.reset();
      const P = AI.sit.personal;
      b.personal = P > 0 ? { x: this.g.rng.gauss() * P, z: this.g.rng.gauss() * P } : { x: 0, z: 0 };
    }
    this.shadeX = 0;
    this.jumpServe = false;
    this.freeCall = false;
    this.theirTouches = 0;
    this.earlyFor = null;
    this.touches = 0;
    this.setFor = null;
    this.receiver = null;
    this.read = null;
    this.ourServe = false;
    this.serveFault = false;
    this.endPlay();
    this.freeRolled = false;
    this.receiveRolled = false;
    this.secondBy = null;
  }

  get user(): Athlete | null {
    return this.userSlot ? (this.players.get(this.userSlot) ?? null) : null;
  }

  /** the user's own route when they are one of our hitters (their call, else their position's first) */
  private userRoute(): { key: SetterKey; play: SetPlay } | null {
    const key = this.userSlot ? SLOT_KEY[this.userSlot] : undefined;
    const user = this.user;
    const play = this.userPlay ?? (user ? SET_PLAYS[user.role]?.[0] : undefined);
    return key && play ? { key, play } : null;
  }

  /** our AI hitters, as the calls drive them (the user is not among them: they run their own route) */
  private playHitters(): CallHitters<HitterBrain> {
    const out: CallHitters<HitterBrain> = new Map();
    for (const [slot, key] of Object.entries(SLOT_KEY) as [Slot, SetterKey][]) {
      const a = this.players.get(slot);
      const hitter = a ? this.brains.get(a)?.hitter : null;
      if (a && hitter) out.set(key, { a, brain: hitter, read: (g) => this.passToSetter(g) });
    }
    return out;
  }

  /**
   * Our AI setter may call a play (`AI.plays[on]` of the time): one from our pool that leaves every
   * front-row hitter their own spot with the user's call in it (your call wins: the play fits round
   * it). None fits: no play. The hitters line up for theirs at once.
   */
  private decidePlay(on: 'free' | 'receive'): void {
    const S = this.players.get('S');
    if (!this.playsOn || !S || S.isUser || this.play) return;
    if (this.playRng.next() >= AI.plays[on]) return;
    const combo = this.pickFit();
    if (!combo) return;
    const calls = new SetterCalls();
    calls.setCombo(combo);
    this.play = { combo, on, state: 'signalled', calls, yields: new Set() };
    applyCalls(this.playHitters(), calls, false);
  }

  /** a play from our pool that fits round your route (`playRng`), with your route in it; null: none fits */
  private pickFit(): Combo | null {
    const you = this.userRoute();
    const fits = this.playPool()
      .map((c) => (you ? { ...c, calls: { ...c.calls, [you.key]: you.play.short } } : c))
      .filter((c) => !clashes(c.calls));
    if (!fits.length) return null;
    return fits[Math.min(fits.length - 1, Math.floor(this.playRng.next() * fits.length))];
  }

  /** the play's calls as the hitters run them: yours in it, and 'High' for a hitter who gave way to you */
  private playCalls(p: TeamPlay): Record<SetterKey, string> {
    const calls = { ...p.combo.calls };
    for (const k of p.yields) calls[k] = 'High';
    const you = this.userRoute();
    if (you) calls[you.key] = you.play.short;
    return calls;
  }

  /**
   * You changed your route after the play was called. Signalled (before our pass): the setter
   * calls a play that fits round your new route instead (from the plays that fit, as `decidePlay`),
   * or none when none does. Running (the pass is played, too late to call another): the AI hitter
   * whose spot you took gives way, waits for a high ball and gets no set, so two hitters never go
   * up on one spot. Off: the base sets, nothing to fit.
   */
  private fitPlay(): void {
    const p = this.play;
    const you = this.userRoute();
    if (!p || !you || p.state === 'off') return;
    if (!clashes(this.playCalls(p))) return;
    if (p.state === 'signalled') {
      const combo = this.pickFit();
      if (!combo) {
        this.endPlay();
        return;
      }
      p.combo = combo;
      p.calls.setCombo(combo);
      applyCalls(this.playHitters(), p.calls, false);
      return;
    }
    const hitters = this.playHitters();
    for (let k = clashWith(this.playCalls(p), you.key, you.play.short); k; k = clashWith(this.playCalls(p), you.key, you.play.short)) {
      p.yields.add(k);
      p.calls.forceHigh(k);
      const h = hitters.get(k);
      if (!h) continue;
      // a run already under way is too late to stop: they pull out of it, and no set goes to them
      h.brain.holdRun();
      h.brain.lane = sideLane(p.calls.highLane(k), this.side);
      h.brain.inFront = undefined;
      h.brain.passToSetter = null;
    }
  }

  /** the play is over (their touch, a dead ball): every hitter back to their own lane */
  private endPlay(): void {
    if (!this.play) return;
    this.play = null;
    for (const b of this.brains.values()) b.baseRun();
  }

  /** the play is off for this ball (a pass not good enough): the base sets, and the HUD says so */
  private playOff(): void {
    const p = this.play;
    if (!p) return;
    for (const b of this.brains.values()) b.baseRun();
    p.state = 'off';
  }

  /**
   * Plays through a rally: signalled before their serve; called on their free ball (`freePlay`);
   * on our pass it runs (serve receive: a perfect pass; a free ball: in system) or is off; it is
   * over at their touch.
   */
  private stepPlay(live: boolean): void {
    const g = this.g;
    const lt = g.ball.lastTouch;
    if (!live) {
      // before their serve: the setter signals the play (once a rally)
      if (!this.serving && !this.receiveRolled) {
        this.receiveRolled = true;
        this.decidePlay('receive');
      }
      return;
    }
    if (!lt) return;
    if (lt.side !== this.side || lt.kind === 'block') {
      // their touch: our attack is over (a signalled serve-receive play waits for our pass)
      if (this.play && this.play.state !== 'signalled') this.endPlay();
      return;
    }
    this.freeRolled = false;
    const p = this.play;
    if (!p || p.state !== 'signalled' || this.touches !== 1 || this.playPassFor === lt) return;
    this.playPassFor = lt;
    // our first touch was no pass (an overpass attacked straight back): no play off it, and their
    // next touch ends it, so the next free ball can bring a new one
    if (lt.kind !== 'pass' && lt.kind !== 'dig' && lt.kind !== 'free') {
      this.playOff();
      return;
    }
    const touch = this.setterTouch(g);
    const good = !!touch && (p.on === 'receive' ? touch.off <= AI.quickWeight.perfectOff : touch.off <= AI.outOfSystem);
    if (!touch || !good) {
      this.playOff();
      return;
    }
    p.calls.lock(false);
    const hitters = this.playHitters();
    applyCalls(hitters, p.calls, false);
    runCalls(hitters, p.calls, touch.at, touch.t);
    p.state = 'running';
  }

  /** "FREE!": their ball can only come over as a free ball, and our setter may call a play on it (once) */
  private freePlay(): void {
    if (this.freeRolled) return;
    this.freeRolled = true;
    this.decidePlay('free');
  }

  /**
   * The set in a running play: each AI hitter at their route (a quick only to a hitter up with the
   * touch, a fast set only to one on their run), the user at theirs, picked by the usual weights.
   */
  private playSet(
    g: AiHost,
    setter: Athlete,
    perfect: boolean,
  ): { target: V3; apex: number; hitter: Athlete | null; time?: number } | null {
    const p = this.play!;
    const hitters = this.playHitters();
    syncRuns(hitters, p.calls);
    const W: Record<SetterKey, number> = {
      OH: AI.setWeight.outside,
      OPP: AI.setWeight.opposite,
      PIPE: AI.pipe.inSystem,
      MB: perfect ? AI.quickWeight.perfect : AI.quickWeight.good,
    };
    type Set = { target: V3; apex: number; hitter: Athlete | null; time?: number };
    const opts: { set: Set; w: number; user: boolean }[] = [];
    for (const o of callOptions(g, hitters, p.calls, false)) {
      const k = o.key as SetterKey;
      const h = hitters.get(k);
      if (!h || h.a === setter || h.a.state === 'dive' || p.yields.has(k)) continue;
      const quick = 'onTime' in o;
      if (quick && !o.onTime) continue;
      const running = h.brain.phase === 'approach' || h.brain.phase === 'load' || h.brain.phase === 'air';
      if (o.fast && !quick && !running) continue;
      opts.push({ set: o, w: W[k], user: false });
    }
    const you = this.user;
    const route = this.userRoute();
    if (you && route && you !== setter && you.state !== 'dive') {
      let set: Set;
      if (isQuick(route.play)) set = this.quickFor(you);
      else {
        const lane = sideLane(route.play.lane, this.side);
        const y = attackHeight(you);
        set = { target: { x: lane.x, y, z: lane.z }, apex: y + lane.apexAbove, hitter: you };
      }
      opts.push({ set, w: W[route.key], user: true });
    }
    if (!opts.length) return null;
    this.setInSystem = true;
    const yours = opts.find((o) => o.user);
    if (yours && g.rng.next() < this.userSetBias) return yours.set;
    const total = opts.reduce((t, o) => t + o.w, 0);
    let r = g.rng.next() * total;
    for (const o of opts) {
      r -= o.w;
      if (r <= 0) return o.set;
    }
    return opts[opts.length - 1].set;
  }

  /** the play our setter has called, for the HUD (never the other team's: you read theirs at the net) */
  playView(): TeamPlayView | null {
    const p = this.play;
    if (!p) return null;
    const calls = this.playCalls(p);
    // the same object while nothing in it changed: the HUD redraws only on a change
    const key = `${p.combo.name}|${p.on}|${p.state}|${SETTER_KEYS.map((k) => calls[k]).join('|')}`;
    if (this.view?.key !== key) this.view = { key, v: { name: p.combo.name, idea: p.combo.idea, calls, on: p.on, state: p.state } };
    return this.view.v;
  }
  private view: { key: string; v: TeamPlayView } | null = null;

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
    // (an AI middle's: the play's route, when one is on)
    const inFront = h.isUser ? this.userPlay?.inFront : this.brains.get(h)?.hitter?.inFront;
    return quickSetFor(h, g.simTime, g.ball.pos, releaseAt, inFront);
  }

  /**
   * A pass on its way to our setter: when the set will leave their hands (a user setter's ball
   * loads in the hands first) and where. Null for anything else, or for a pass too far off the
   * net to run a quick.
   */
  passToSetter(g: AiHost): { t: number; x: number } | null {
    const st = this.setterTouch(g);
    // the user setter's ball loads in the hands before the push (the set bar)
    return st ? { t: st.t + (this.players.get('S')?.isUser ? TIMING.setLoad : 0), x: st.at.x } : null;
  }

  /**
   * The pass on its way to our setter (see `passToSetter`): when and where the setter's hands meet
   * it (the ball's centre), and how far that is (m) from the setter's spot. Null as for passToSetter.
   */
  setterTouch(g: AiHost): { t: number; at: V3; off: number } | null {
    const lt = g.ball.lastTouch;
    const s = this.side;
    if (!g.ball.active || !lt || lt.side !== s || (lt.kind !== 'pass' && lt.kind !== 'dig' && lt.kind !== 'free')) return null;
    if (this.touches !== 1) return null;
    const setter = this.players.get('S');
    if (!setter || lt.athlete === setter) return null;
    const pred = g.ball.ensurePrediction(g.env, g.simTime);
    // a setter going up for it (a jump set) meets the ball higher and sooner
    const yours = setter.isUser ? g.contact.setCatch(setter) : null;
    const jump =
      !setter.isUser && this.brains.get(setter)?.setter.jumps && setter.state === 'ground'
        ? planSetJump(setter, pred, g.simTime, AI_TOUCH)
        : null;
    const t = yours && yours.feetY > 0 ? yours.t : jump ? jump.catchT : pred.descendThrough(setterTouchY(setter), g.simTime);
    if (t < 0) return null;
    pred.posAt(t, this.qp);
    // (the setter's own read of the pass uses the same line: a quick they may set is one the middle runs)
    const off = Math.hypot(this.qp.x - SETTER_SPOT.x * s, this.qp.z - SETTER_SPOT.z * s);
    if (off > AI.outOfSystem) return null;
    return { t, at: { x: this.qp.x, y: this.qp.y, z: this.qp.z }, off };
  }
  private qp: V3 = { x: 0, y: 0, z: 0 };

  /**
   * Where `setter` will take the ball now in flight: their feet, standing so it drops onto
   * the hands (as SetterBrain does). A ball that never comes down through the hands is
   * judged where it lands (`orLanding`), or not at all.
   */
  private setterSpotFor(setter: Athlete, g: AiHost, orLanding: boolean): Spot | null {
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
  private readPass(g: AiHost, setter: Athlete, lt: Touch, help: boolean): void {
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
    // (a pass coming down on the tape is a save at best: no quick, nobody runs a fast set off it)
    const tight = !!at && at.z * s < AI.tightPass;
    const call = help ? 'help' : backup || tight || off > AI.outOfSystem ? 'out' : 'in';
    this.read = { touch: lt, setter, call, at: at ?? { x: setter.pos.x, z: setter.pos.z }, off };
    if (call !== r?.call) this.onRead?.(this.read);
  }

  /** the setter's call: who gets the ball */
  callSet(g: AiHost, setter: Athlete) {
    const s = this.side;
    const options: { slot: Slot; a: Athlete; lane: PositionId; w: number }[] = [];
    // a pin hitter already running a fast set gets it only if the ball can meet the hand in time
    const fast = (a: Athlete) => (a.isUser ? null : (this.brains.get(a)?.hitter?.tempoBall ?? null));
    const fastOk = (a: Athlete) => {
      const f = fast(a);
      return !!f && f.t - g.simTime >= AI.tempo.minT && f.t - g.simTime <= AI.tempo.maxT;
    };
    // (a hitter still on the floor after a dive is not up in time for any set: nobody sets them)
    const down = (a: Athlete) => a.state === 'dive';
    const add = (slot: Slot, lane: PositionId, w: number) => {
      const a = this.players.get(slot);
      if (a && a !== setter && !down(a) && (!fast(a) || (fastOk(a) && !outOfSystem))) options.push({ slot, a, lane, w });
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
    // (both pins mid-run on fast sets the setter can't reach: the outside takes a high ball; the
    // opposite when the outside is the one setting it)
    // (one on their feet first; with both pins on the floor, the outside anyway)
    for (const up of [true, false])
      for (const [slot, lane] of [
        ['OH1', 'OH'],
        ['OPP', 'OPP'],
      ] as const) {
        const h = this.players.get(slot);
        if (!options.length && h && h !== setter && !(up && down(h))) options.push({ slot, a: h, lane, w: 1 });
      }
    this.setInSystem = !outOfSystem;
    // a play: the routes it called (off a pass that went off after all, the base sets: it is off)
    if (this.play?.state === 'running') {
      if (outOfSystem) this.playOff();
      else {
        const set = this.playSet(g, setter, perfect);
        if (set) return set;
        // nobody left to set on the play: the base sets, with the hitters back on their lanes
        this.playOff();
      }
    }
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
    // the user's quick behind the setter (the opposite's back 1) meets them at the top of the jump, as the middle's does
    if (pick.a === user && this.userPlay && isQuick(this.userPlay) && !outOfSystem && pick.lane !== 'MB') return this.quickFor(pick.a);
    // the user's call (a go, a 3 ball, a fast back...) instead of the lane's default tempo
    const call = pick.a === user && this.userPlay && this.userPlay.inFront === undefined ? this.userPlay.lane : null;
    const lane = call ?? laneFor(pick.lane, s);
    const y = attackHeight(pick.a);
    // off a bad pass the setter can only put up a high ball
    const apexBoost = outOfSystem ? AI.outOfSystemApex : 0;
    const apexAbove = outOfSystem && call ? Math.max(call.apexAbove, laneFor(pick.lane, s).apexAbove) : lane.apexAbove;
    // a back-row set off a bad pass stays well behind the 3 m line (in front of where its hitter waits)
    const z = outOfSystem && pick.lane === 'L' ? PIPE_HIGH_Z * s : lane.z;
    return { target: { x: lane.x, y, z }, apex: y + apexAbove + apexBoost, hitter: pick.a };
  }

  /** who their set is for (our wings see the hitter go for it): your pick, or their setter's call */
  theirSetFor(): Athlete | null {
    const lt = this.g.ball.lastTouch;
    if (!lt || lt.kind !== 'set' || lt.side === this.side) return null;
    return lt.athlete?.isUser ? (this.g.contact.lastSet?.hitter ?? null) : (this.opponents?.setFor ?? null);
  }

  onSet(hitter: Athlete | null): void {
    this.setFor = hitter;
    if (hitter && hitter.isUser) this.onUserSet?.();
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
    // their touches since the ball was last ours (a block is not one, and starts a fresh three)
    if (lt.side === this.side || lt.kind === 'block' || lt.kind === 'serve' || lt.kind === 'feed') this.theirTouches = 0;
    else this.theirTouches++;
    if (this.theirTouches < 2) this.freeCall = false;
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

  /**
   * How long until `a` can have a platform under a ball dropping at p (feet, landing and a run).
   * `lane` < 1 (serve receive: `AI.pick.lane`): a run forward, to a ball in front of them, counts
   * that much of its length when choosing who takes it. `reach` (m): the platform gets to a ball
   * this far from where the feet stop (the libero's claim: `AI.digReach`).
   */
  reachTime(a: Athlete, p: V3, lane = 1, reach = 0): number {
    const dz = a.pos.z - (p.z - this.side * 0.4);
    const d = Math.max(0, Math.hypot(a.pos.x - p.x, dz * this.side > 0 ? dz * lane : dz) - reach);
    // the first steps are shuffled, the rest of a long way is run (never quicker from further away)
    const sh = AI.pick.shuffle;
    let t = Math.min(d, sh) / (a.stats.shuffleSpeed * 0.9) + Math.max(0, d - sh) / (a.stats.approachSpeed * 0.8) + AI.reactionTime;
    // a blocker still up at the net has to come down first
    if (a.state === 'air') {
      const vy = a.vel.y;
      t += (vy + Math.sqrt(Math.max(0, vy * vy + 2 * BALL.gravity * a.pos.y))) / BALL.gravity + PLAYER.landRecover;
    } else if (a.state === 'land') t += Math.max(0, PLAYER.landRecover - a.stateT);
    else if (a.state === 'dive') t += Math.max(0, a.diveUpT - a.stateT) + PLAYER.landRecover;
    else if (a.state === 'load') t += 0.7;
    return t;
  }

  /**
   * A team-mate (or the user) best placed to take a ball dropping at p: the one who
   * gets there first (`AI.pick`: a seam ball goes to the libero or the user, the setter
   * only when nobody else is close). Someone is always sent (a desperate dig beats
   * watching it drop) unless `exclude` was the only option. Given the time until the ball is
   * down (`budget`: given for a ball off a block and a second ball), a ball the libero gets to with
   * `margin` s to spare (its platform `reach` m from its feet) is the libero's, whoever else is
   * near. Given `down` (s until it is
   * down), the user's seam preference is only for a ball they get to: one they don't goes to
   * whoever is least late, never across the court to the user over the players beside it. (On a
   * serve the times are scaled by `AI.pick.lane`, so they are not real seconds and that check is
   * lenient there: lanes, not the clock, decide who passes a serve.)
   */
  private pickReceiver(
    p: V3,
    serve: boolean,
    exclude: Athlete | null = null,
    exclude2: Athlete | null = null,
    budget?: number,
    margin = AI.pick.libero,
    down?: number,
    reach = 0,
  ): Athlete | null {
    if (budget !== undefined && this.liberoGets(p, budget, exclude, exclude2, margin, reach)) return this.players.get('L') ?? null;
    let best: Athlete | null = null;
    let bestT = 1e9;
    for (const [slot, a] of this.players) {
      if (a === exclude || a === exclude2) continue;
      if (serve && (slot === 'S' || slot === 'MB' || slot === 'OPP')) continue;
      // (a serve is received in lanes: the ball in front of a passer is theirs)
      let t = this.reachTime(a, p, serve ? AI.pick.lane : 1);
      if (slot === 'S') t += AI.pick.setter; // the setter digs only if nobody else is close
      // the seam: the libero's, or the user's (one preference, not both added up); the user's only on
      // a ball they get to, so "your ball" never goes across the court past the players beside it
      if (slot === 'L' || (a.isUser && (down === undefined || t <= down))) t -= AI.pick.seam;
      if (t < bestT) {
        bestT = t;
        best = a;
      }
    }
    return best;
  }

  /** someone (not `exclude`) gets to a ball dropping at p within `budget` s, or is a dive short of it (`AI.pick.dive` s) */
  private anyoneGets(p: V3, budget: number, exclude: Athlete | null): boolean {
    for (const a of this.players.values()) if (a !== exclude && this.reachTime(a, p) <= budget + AI.pick.dive) return true;
    return false;
  }

  /** the libero (not excluded) gets to a ball dropping at p within `budget` s, with `margin` s to spare (its platform `reach` m from its feet) */
  private liberoGets(
    p: V3,
    budget: number,
    exclude: Athlete | null = null,
    exclude2: Athlete | null = null,
    margin = AI.pick.libero,
    reach = 0,
  ): boolean {
    const L = this.players.get('L');
    return !!L && L !== exclude && L !== exclude2 && this.reachTime(L, p, 1, reach) + margin <= budget;
  }

  /**
   * The libero taking a ball dropping at p calls it ("MINE!") when it is a free ball, or when a
   * team-mate (not `exclude`; on a serve, a passer) gets there before it: it is taking it from them
   */
  private liberoCalls(p: V3, serve: boolean, free: boolean, exclude: Athlete | null): boolean {
    const L = this.players.get('L');
    if (!L || L.isUser) return false;
    if (free) return true;
    const lane = serve ? AI.pick.lane : 1;
    const mine = this.reachTime(L, p, lane);
    for (const [slot, a] of this.players) {
      if (a === L || a === exclude || (serve && (slot === 'S' || slot === 'MB' || slot === 'OPP'))) continue;
      if (this.reachTime(a, p, lane) < mine) return true;
    }
    return false;
  }

  /**
   * How much time (s) `a` has to spare running under the ball now in flight to get their hands to it
   * (negative: they can't; `fallback`: where it lands). Leaves where they would play it in `qp`.
   */
  private spareFor(a: Athlete, tDown: number, fallback: V3): number {
    const now = this.g.simTime;
    const pred = this.g.ball.ensurePrediction(this.g.env, now);
    const tHands = pred.descendThrough(setterTouchY(a), now);
    const tAt = tHands > 0 ? tHands : tDown;
    if (tHands > 0) pred.posAt(tHands, this.qp);
    else Object.assign(this.qp, fallback);
    // the setter releases at once and runs: only a hopeless one gives it up
    const d = Math.hypot(a.pos.x - this.qp.x, a.pos.z - this.qp.z);
    const tRun = d / a.stats.approachSpeed + 0.15 + (a.state === 'air' ? 0.5 : 0);
    return tAt - now + 0.05 - tRun;
  }

  /**
   * How hard a backup set by `a` is, 0-1 (`AI.backupSet`): the less time to spare, the further from
   * the setter's spot it is played, and the longer the run under it, the harder; a run away from
   * the net harder still (the set then goes back over the shoulder). Never under `base` (the
   * libero) or `otherBase` (anyone else: a hitter is no setter).
   */
  backupDifficulty(a: Athlete, spare: number, at: V3): number {
    const B = AI.backupSet;
    const s = this.side;
    const off = Math.hypot(at.x - SETTER_SPOT.x * s, at.z - SETTER_SPOT.z * s);
    const dx = at.x - a.pos.x;
    const dz = at.z - a.pos.z;
    const run = Math.hypot(dx, dz);
    const far = clamp((run - B.runEasy) / B.runHard, 0, 1);
    const away = run > 1e-3 ? Math.max(0, (dz * s) / run) : 0;
    return Math.max(
      a === this.players.get('L') ? B.base : B.otherBase,
      clamp(1 - spare / B.easy, 0, 1),
      clamp((off - B.offEasy) / B.offHard, 0, 1),
      far * (B.run + B.away * away),
    );
  }

  /** where a team-mate running with a player sent to a ball they may only dive for waits: toward the middle of our court, where the dive pops it up */
  private popSpot(p: V3): Spot {
    const cz = (this.side * COURT.halfLength) / 2;
    const dx = -p.x;
    const dz = cz - p.z;
    const dl = Math.hypot(dx, dz) || 1;
    const c = Math.min(dl, (AI.diveUp.carry[0] + AI.diveUp.carry[1]) * 0.25);
    return { x: p.x + (dx / dl) * c, z: p.z + (dz / dl) * c };
  }

  /**
   * An AI free ball over (a third ball nobody can attack) is aimed to be hard to play: deep to a
   * back corner or short, just over the net, wherever their nearest player is furthest away.
   */
  freeOverTarget(): { x: number; y: number; z: number; apex: number } {
    const g = this.g;
    const s = this.side;
    const F = AI.freeOver;
    const spots = [
      { x: -F.side, z: F.deep, apex: F.apex },
      { x: F.side, z: F.deep, apex: F.apex },
      { x: -F.side, z: F.short, apex: F.shortApex },
      { x: 0, z: F.short, apex: F.shortApex },
      { x: F.side, z: F.short, apex: F.shortApex },
    ];
    let best = spots[0];
    let bestScore = -Infinity;
    for (const sp of spots) {
      let near = Infinity;
      for (const o of g.athletes) if (o.side !== s) near = Math.min(near, Math.hypot(o.pos.x - sp.x, o.pos.z + s * sp.z));
      // (a little guesswork: not always the very same spot)
      const score = near + g.rng.next() * F.guess;
      if (score > bestScore) {
        bestScore = score;
        best = sp;
      }
    }
    return { x: best.x, y: 0.5, z: -s * best.z, apex: best.apex };
  }

  /**
   * A ball that is only kept up goes somewhere towards the middle of our court: `dist` m from where
   * it was played, up to `turn` rad to either side of the line to the middle, no nearer than
   * `AI.up.net` m to the net and at most `AI.up.out` m outside the lines.
   */
  private keptUp(from: V3, dist: [number, number], turn: number): Spot {
    const rng = this.g.rng;
    const s = this.side;
    const cz = (s * COURT.halfLength) / 2;
    const dl = Math.hypot(from.x, cz - from.z) || 1;
    const a = (rng.next() * 2 - 1) * turn;
    const ux = -from.x / dl;
    const uz = (cz - from.z) / dl;
    const d = lerp(dist[0], dist[1], rng.next());
    const x = from.x + (ux * Math.cos(a) - uz * Math.sin(a)) * d;
    const z = from.z + (ux * Math.sin(a) + uz * Math.cos(a)) * d;
    const W = COURT.halfWidth + AI.up.out;
    return { x: clamp(x, -W, W), z: s * clamp(z * s, AI.up.net, COURT.halfLength + AI.up.out) };
  }

  /** a dive keeps the ball alive and no more: a bit up, somewhere toward the middle of our court (`AI.diveUp`) */
  diveUpTarget(from: V3): { x: number; y: number; z: number; apex: number } {
    const U = AI.diveUp;
    const at = this.keptUp(from, U.carry, U.turn);
    return { x: at.x, y: 0.9, z: at.z, apex: from.y + lerp(U.apex[0], U.apex[1], this.g.rng.next()) };
  }

  /** a second ball nobody could set is kept up, somewhere a team-mate can get to (`AI.up`): never the same spot twice */
  upTarget(from: V3): { x: number; y: number; z: number; apex: number } {
    const U = AI.up;
    const at = this.keptUp(from, [U.near, U.far], U.turn);
    return { x: at.x, y: 0.9, z: at.z, apex: Math.max(from.y + U.over, lerp(U.apex[0], U.apex[1], this.g.rng.next())) };
  }

  step(): void {
    const g = this.g;
    const ball = g.ball;
    const now = g.simTime;
    this.trackTouches();
    // team-mates at the net meet shoulder to shoulder, never through each other
    shoulderToShoulder([...this.players.values()]);
    const live = ball.active && !ball.state.rest && g.ballLive;
    this.stepPlay(live);
    const lt = ball.lastTouch;
    const jobs = new Map<Athlete, { job: Job; spot: Spot; run: boolean; due: number }>();
    const setJob: SetJob = (a, job, spot, run = false, due = 0) => {
      if (!a || a.isUser) return;
      jobs.set(a, { job, spot: spot ?? { x: a.pos.x, z: a.pos.z }, run, due });
    };
    let form: 'receive' | 'defense' | 'offense' = 'defense';
    this.serveSeen = false;
    // their server's toss tells the serve (a jump server may still settle for a float under a bad toss)
    for (const b of this.opponents?.brains.values() ?? []) {
      const sv = b.server;
      if (b.job === 'serve' && (sv.phase === 'toss' || sv.phase === 'approach' || sv.phase === 'load' || sv.phase === 'air'))
        this.jumpServe = sv.jump;
    }
    if (this.receiverFor !== lt) this.receiver = null;
    if (!live) {
      this.receiver = null;
      this.situation = 'dead';
      this.focus = null;
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
      // a ball of theirs dropping at the net is still theirs while they can play it: a tight pass
      // their setter gets to (only a real overpass is ours: `overpass`), a tight set their hitter is
      // going up for. Until it has crossed, nobody leaves the net for it
      const opp = this.opponents;
      if (theirBall && comingToUs && !onOurSide && opp) {
        const first = lt.kind === 'pass' || lt.kind === 'dig' || lt.kind === 'free';
        // (their touches as we count them: theirs may not have counted this one yet, as we step first)
        if ((first && this.theirTouches === 1 && !opp.overpass(g)) || (lt.kind === 'set' && !!opp.setFor)) comingToUs = false;
      }
      const ourBlock = lt && lt.side === this.side && lt.kind === 'block';
      // what we are in the middle of, and where the ball comes down (the play the others move with)
      const firstUp = !!ourBall && this.touches === 1 && (lt.kind === 'pass' || lt.kind === 'dig' || lt.kind === 'free');
      this.situation = situationOf({
        live,
        kind: lt?.kind ?? null,
        ours: !!lt && lt.side === this.side,
        comingToUs: firstUp ? !this.overpass(g) : comingToUs,
        freeCall: this.freeCall,
        help: this.freeFor === lt && this.secondHelp,
      });
      this.focus = tDown > 0 ? p : null;
      // base defence moves along the net with the ball while it is on their side; once they set it
      // the read takes over from where the base then was; on our own ball there is none
      const sit = this.situation;
      if (sit === 'ourServe' || sit === 'ourAttack' || sit === 'theirFirstBall')
        this.shadeX = clamp(ball.pos.x * AI.sit.ballSide, -AI.sit.ballSideMax, AI.sit.ballSideMax);
      else if (sit !== 'theirSet' && sit !== 'theirHit' && sit !== 'theirFree') this.shadeX = 0;
      // a ball that will land clearly out is let go (judged where it lands, not where it is played)
      const land = pred.land;
      const inBounds = Math.abs(land.x) < COURT.halfWidth + AI.outJudge && Math.abs(land.z) < COURT.halfLength + AI.outJudge;
      // the receiver sticks to one ball, unless the ball is no longer going where they were sent
      const strayed = comingToUs && tDown > 0 && Math.hypot(p.x - this.receiverAt.x, p.z - this.receiverAt.z) > 1.5;
      // (`mustPlay`: a ball off our own block is ours wherever it lands: out, it is their point)
      const receive = (serve: boolean, exclude: Athlete | null, mustPlay = false) => {
        // a ball off a block is the libero's whenever it gets there in time (coming in from the cover
        // to a ball someone else was sent to, it calls it and takes it); so is every ball of theirs
        // in defence (their attack, a tip, a free ball) an AI libero gets to (`AI.pick.liberoDig`).
        // In time is its platform there, `AI.digReach` from its feet, not its feet under the ball:
        // a defender digs what it gets its arms to (MatusGib, 2026-11-20: off a soft block "the
        // libero does not always take the ball even though they are in time", and you had to);
        // not on a ball down sooner than `AI.pick.mine` (a hard-driven one: whoever it comes at
        // digs it). Serve receive goes by lanes
        const offBlock = lt?.kind === 'block';
        const L = this.players.get('L');
        const defence = !serve && !offBlock && !!lt && lt.side !== this.side && !!L && !L.isUser;
        const claim = offBlock || defence;
        const margin = claim ? AI.pick.liberoDig : AI.pick.libero;
        // (a ball down too soon to call is dug by whoever it comes at: no reaching past them)
        const time = comingToUs && tDown > 0 ? tDown - now : 0;
        const reach = claim && time >= AI.pick.mine ? AI.digReach : 0;
        const free = !serve && !!lt && lt.side !== this.side && FREE_KINDS.has(lt.kind);
        // between the user and an AI libero, any ball the libero gets to is the libero's: called
        // early, never taken off the user late
        // (a serve only in the seam: serve receive goes by lanes, and a serve in the user's lane is theirs)
        const seam = (u: Athlete) =>
          !serve || (!!L && this.reachTime(L, p, AI.pick.lane) <= this.reachTime(u, p, AI.pick.lane) + AI.pick.seam);
        const users = !!this.receiver?.isUser && !!L && !L.isUser && seam(this.receiver);
        const late = users && !!lt && now - lt.t > AI.pick.call;
        const takeOver =
          (claim || users) &&
          !late &&
          !!L &&
          this.receiver !== L &&
          comingToUs &&
          tDown > 0 &&
          this.liberoGets(p, tDown - now, exclude, null, margin, reach);
        if (this.receiver && this.receiverFor === lt && !strayed && !takeOver) {
          setJob(this.receiver, 'receive');
        } else if (comingToUs && tDown > 0 && (inBounds || mustPlay)) {
          const was = this.receiverFor === lt ? this.receiver : null;
          let r = this.pickReceiver(p, serve, exclude, null, claim ? tDown - now : undefined, margin, tDown - now, reach);
          if (r?.isUser && L && !L.isUser && seam(r) && this.liberoGets(p, tDown - now, exclude, null, margin, reach)) r = L;
          // the libero calls it: a free ball, a ball it takes off whoever was sent, or one a team-mate gets to first
          if (
            r &&
            r === L &&
            !L.isUser &&
            time >= AI.pick.mine &&
            this.liberoCall !== lt &&
            ((!!was && was !== L) || this.liberoCalls(p, serve, free, exclude))
          )
            this.liberoCall = lt;
          this.receiver = r;
          this.receiverFor = lt;
          this.receiverAt = { x: p.x, z: p.z };
          if (r) setJob(r, 'receive');
        }
        // a ball the one sent may not get to: the next closest runs with them (two go, one plays it), to
        // where a dive would pop it up
        const r = this.receiver;
        if (!serve && r && this.receiverFor === lt && comingToUs && tDown > 0 && this.reachTime(r, p) > tDown - now - AI.scramble) {
          const two = this.pickReceiver(p, false, r, exclude);
          if (two && two !== this.secondBy) setJob(two, 'base', this.popSpot(p), true);
        }
      };
      if (theirBall || (lt?.kind === 'block' && lt.side !== this.side)) {
        // the other team touched it last: defend, receive if it is coming
        form = lt?.kind === 'serve' ? 'receive' : 'defense';
        // a free ball over (not an attack, not a serve, not a block): an easy first ball
        const free = lt && FREE_KINDS.has(lt.kind);
        // (never the setter's: it is the one ball a team has time to pass well, and the setter sets it;
        // unless nobody else gets there in time: then the setter digs it and someone else sets)
        const S = this.players.get('S') ?? null;
        const othersGet =
          !!free && comingToUs && tDown > 0 && [...this.players.values()].some((a) => a !== S && this.reachTime(a, p) <= tDown - now);
        receive(lt?.kind === 'serve', othersGet ? S : null);
        if (lt?.kind === 'serve') this.serveTransition(lt, setJob);
        if (free && comingToUs && tDown > 0) this.earlyTransition(lt, tDown, p, setJob);
        // their second ball was no set: their third can only be a free ball, and we get ready for it
        else if (free && this.theirTouches === 2 && lt.kind !== 'set' && !onOurSide) this.freeBallDefence(lt, setJob);
        // a free ball coming (or called): our setter may call a play on it
        if (free && ((comingToUs && tDown > 0) || this.freeCall)) this.freePlay();
        // the setter releases to the net once it reads that the ball coming over isn't its own to play
        if (lt && lt.kind !== 'serve') this.setterRelease(lt, jobs, setJob);
        // blockers read their set
        if (lt?.kind === 'set' && !onOurSide) {
          for (const a of this.frontRow()) setJob(a, 'block', this.formSpot('defense', this.slotOf(a)));
          if (this.splitFor !== lt) this.splitStep(lt);
          this.readDefence(lt, setJob);
        } else if ((lt?.kind === 'pass' || lt?.kind === 'dig') && !onOurSide && !comingToUs && !this.freeCall) {
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
        receive(false, lt?.athlete ?? null, true);
        // a soft block: if it comes down slowly to a passer who will get there, run the offence early
        if (lt && comingToUs && tDown > 0 && ball.speed() < AI.transition.softSpeed) this.earlyTransition(lt, tDown, p, setJob);
        if (lt) this.setterRelease(lt, jobs, setJob);
      } else if (ourBall && (lt.kind === 'spike' || lt.kind === 'tip')) {
        // our attack: the cover holds until it is over the net, then everyone goes back to base defence
        form = 'defense';
        if (onOurSide && this.coverFor) for (const c of this.coverSpots) if (c.a !== lt.athlete) setJob(c.a, 'cover', c.spot);
      } else if (ourBall) {
        form = 'offense';
        for (const b of this.brains.values()) b.readSpot = null;
        if (this.touches === 1 && this.overpass(g)) {
          // our first ball is going over: the setter reads it and stays (no set, no call), and the
          // front row gets ready at the net for their play on it
          form = 'defense';
          for (const a of this.frontRow()) setJob(a, 'block', this.formSpot('defense', this.slotOf(a)));
        } else if (this.touches === 1) {
          // second ball: the setter sets it. A setter who played the first ball, or can't get to
          // this one (and calls HELP), leaves it to the libero, who sets a high ball to a pin when it
          // can get there: a real libero takes every second ball it can. If the libero can't either,
          // whoever is closest and gets under it in time does. A backup's set is as good as the ball
          // lets it be (`AI.backupSet`): out of system a team nearly always still gets a high ball
          // to a pin, just a rougher one. Only a ball nobody gets under in time (or one barely
          // reached) is bumped up high to the 3 m line (the mode's pass target), so the third ball
          // can go over as a free ball from there, not from under the net; one they may only dive
          // for, a team-mate runs with them.
          const S = this.players.get('S');
          const L = this.players.get('L');
          const sDug = !!S && lt?.athlete === S;
          // a setter who played the first ball stays out of the second and goes back to defend
          if (sDug) setJob(S, 'base', this.formSpot('defense', 'S'));
          // (who calls the pass: the setter, or the libero backing up a setter who dug it)
          const caller = sDug ? L : S;
          // the user called HELP on this ball: it is decided as for an AI setter who can't get there
          const helped = !!caller?.isUser && this.userHelpFor === lt;
          this.secondBy = caller ?? null;
          if (caller && (!caller.isUser || helped)) {
            // decided once per ball, so two players never leave it to each other
            if (this.freeFor !== lt) {
              this.freeFor = lt;
              this.freeAthlete = null;
              this.secondSetter = caller;
              this.secondHelp = false;
              this.secondDead = false;
              for (const b of this.brains.values()) b.setter.sloppy = 0;
              if (comingToUs && tDown > 0) {
                const spare = (a: Athlete | undefined) => (a && a !== lt?.athlete ? this.spareFor(a, tDown, p) : -1);
                if (helped || spare(caller) < 0) {
                  this.secondHelp = true;
                  // a ball nobody gets to (a shank into the stands) is their point: nothing to call
                  this.secondDead = !this.anyoneGets(p, tDown - now, lt?.athlete ?? null);
                  this.secondSetter = !sDug && L && L !== caller && spare(L) >= 0 ? L : null;
                  if (!this.secondSetter) {
                    // nobody whose job it is: the closest plays it, and sets it if they get under it in
                    // time (the user plays their own ball; a hitter already on its approach keeps running)
                    const r = this.pickReceiver(p, false, lt?.athlete ?? null, helped ? caller : null, tDown - now, undefined, tDown - now);
                    const hb = r ? this.brains.get(r)?.hitter : null;
                    const running = !!hb && hb.phase !== 'ready' && hb.phase !== 'recover';
                    if (r && !r.isUser && !running && spare(r) >= 0) this.secondSetter = r;
                    else this.freeAthlete = r;
                  }
                }
                // a backup's set: as good as the ball lets it be; one barely reached is just bumped up
                const back = this.secondSetter;
                if (back && back !== S && !back.isUser) {
                  const d = this.backupDifficulty(back, spare(back), this.qp);
                  const B = AI.backupSet;
                  if (d + (g.rng.next() - 0.5) * B.noSetJitter > B.noSet) {
                    this.secondSetter = null;
                    this.secondHelp = true;
                    this.freeAthlete = back;
                  } else this.brains.get(back)!.setter.sloppy = d;
                }
              }
            }
            const setter = this.secondSetter;
            this.secondBy = setter;
            const r = this.freeAthlete;
            if (setter) setJob(setter, 'set');
            else if (r) {
              setJob(r, 'free');
              // one they may only dive for: the next closest runs with them, to play what the dive pops up
              if (comingToUs && tDown > 0 && this.reachTime(r, p) > tDown - now - AI.scramble) {
                const two = this.pickReceiver(p, false, r, lt?.athlete ?? null);
                if (two) setJob(two, 'base', this.popSpot(p), true);
              }
            }
            // (a good pass is not "coming to us" by the floor test: left alone it would drop at the net)
            if (lt && !this.secondDead) this.readPass(g, caller, lt, this.secondHelp);
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
              this.freeAthlete =
                comingToUs && tDown > 0 ? this.pickReceiver(p, false, lt?.athlete ?? null, null, undefined, undefined, tDown - now) : null;
            }
            const r = this.freeAthlete;
            if (r && lt?.athlete !== r) setJob(r, 'free');
          }
          // our set to a hitter: the others cover them
          if (lt?.kind === 'set' && this.setFor && !stranded) this.cover(lt, this.setFor, jobs, setJob);
        }
      }
      // the front row transitions after every block: a ball that stays on our side (their attack by
      // or off the block, a tip) sends each front-row player who is back on the floor and has read
      // the hit off the net to their approach start (the one playing it plays it); a ball our block
      // sends back over keeps them at the net to block again
      const theirHit = lt && lt.side !== this.side && (lt.kind === 'spike' || lt.kind === 'tip' || lt.kind === 'block');
      if (lt && (theirHit || ourBlock) && (comingToUs || onOurSide)) {
        for (const slot of ['OH1', 'MB', 'OPP'] as const) {
          const a = this.players.get(slot);
          const b = a ? this.brains.get(a) : null;
          if (!a || !b || a.isUser || jobs.has(a) || a.airborne) continue;
          b.hitRead.look(lt, lt.t, g.rng);
          if (b.hitRead.seen(now)) setJob(a, 'attack', this.formSpot('offense', slot));
        }
      }
    }
    // assign everyone else to the formation (hitters get 'attack' in offense)
    const attackFlying = live && lt && lt.side !== this.side && (lt.kind === 'spike' || lt.kind === 'tip');
    for (const [slot, a] of this.players) {
      if (a.isUser || jobs.has(a)) continue;
      const held = attackFlying ? this.brains.get(a)?.readSpot : null;
      const spot = held ?? this.anchor(form, slot, a);
      if (form === 'offense' && (slot === 'OH1' || slot === 'MB' || slot === 'OPP' || slot === 'OH2')) setJob(a, 'attack', spot);
      else setJob(a, 'base', spot);
    }
    // serving
    for (const [a, j] of jobs) {
      const b = this.brains.get(a)!;
      if (b.job === 'serve' && b.server.phase !== 'done' && b.server.phase !== 'idle') continue;
      b.job = j.job;
      b.spot = j.spot;
      b.run = j.run;
      b.due = j.due;
    }
  }

  /**
   * The defence reads their set: each defender, a reaction time after the set, works out from its own
   * read of where the hitter will meet it (rough off the hands, clear as it comes down) which kind of
   * attack it is and where perimeter defence puts it (src/ai/defence.ts). Until then it holds base.
   */
  private readDefence(set: Touch, setJob: SetJob): void {
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
        setJob(a, 'base', b.readSpot, false, atk.t);
      } else if (back) b.readSpot = this.anchor('defense', slot, a);
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
  private earlyTransition(t: Touch, tDown: number, p: V3, setJob: SetJob): void {
    const g = this.g;
    const now = g.simTime;
    const r = this.receiver;
    // (a free ball we called before it was sent: the team is already on its way, and stays on it;
    // so does a team that has started: nobody turns back to the net half way)
    if (!this.freeCall && this.earlyFor !== t) {
      if (!r || now - t.t < AI.transition.read) return;
      if (this.reachTime(r, p) + AI.transition.spare > tDown - now) return;
    }
    this.earlyFor = t;
    const S = this.players.get('S');
    if (S && S !== r) setJob(S, 'base', this.formSpot('offense', 'S'), true);
    for (const slot of ['OH1', 'MB', 'OPP'] as const) {
      const a = this.players.get(slot);
      if (a && a !== r) setJob(a, 'attack', this.formSpot('offense', slot));
    }
    if (this.freeCall) this.freeBack(setJob, r);
  }

  private earlyFor: unknown = null;

  /** free-ball defence, back row: the libero and the back-row outside split the court (`FREE_BACK`) */
  private freeBack(setJob: SetJob, except: Athlete | null = null): void {
    for (const slot of ['L', 'OH2'] as const) {
      const a = this.players.get(slot);
      const f = FREE_BACK[slot];
      if (a && a !== except) setJob(a, 'base', { x: f.x * this.side, z: f.z * this.side });
    }
  }

  /**
   * Their serve: once it has been read (`AI.sit.serveRead` s after the contact) the players it is
   * not going to get going before the pass is made: the setter to the target, the front row to
   * their approach starts. (The passers beside the receiver back it up: see `anchor`.)
   */
  private serveTransition(t: Touch, setJob: SetJob): void {
    const r = this.receiver;
    if (!r || this.g.simTime - t.t < AI.sit.serveRead) return;
    this.serveSeen = true;
    const S = this.players.get('S');
    if (S && S !== r) setJob(S, 'base', this.formSpot('offense', 'S'), true);
    for (const slot of ['OH1', 'MB', 'OPP'] as const) {
      const a = this.players.get(slot);
      if (a && a !== r) setJob(a, 'attack', this.formSpot('offense', slot));
    }
  }

  /** the setter has called our first ball out of system (or HELP): the set will be a high ball */
  outOfSystem(g: AiHost): boolean {
    const r = this.read;
    return !!r && r.touch === g.ball.lastTouch && r.call !== 'in';
  }

  /**
   * Where a player with no job of their own stands: their formation spot, moved with the play
   * (`AI.sit`), so nobody waits on a fixed mark while the ball is somewhere else.
   * - base defence, ball on their side: the back row shifts along the net with the ball, and a pin
   *   blocker fronts its hitter once they have the ball;
   * - their jump serve, read off the toss: the passers step back;
   * - their serve, read: the passers beside the receiver step towards it to back it up (not at a
   *   ball that is the user's);
   * - our first ball: the back row follows the pass;
   * - a scramble: everyone closes on where the ball comes down, without crowding whoever plays it.
   * Each player is also a little off the book spot, their own habit for the rally.
   */
  anchor(form: 'receive' | 'defense' | 'offense', slot: Slot, a: Athlete): Spot {
    const base = this.formSpot(form, slot);
    const C = AI.sit;
    const me = this.brains.get(a);
    let x = base.x + (me?.personal.x ?? 0);
    let z = base.z + (me?.personal.z ?? 0);
    const sit = this.situation;
    const back = slot === 'S' || slot === 'L' || slot === 'OH2';
    // their jump serve, read off the toss: the passers start deeper
    if (form === 'receive' && this.jumpServe && PASSERS.has(slot)) z += this.side * C.jumpBack;
    if (form === 'defense' && back) x += this.shadeX;
    else if (form === 'defense' && slot !== 'MB' && sit === 'theirFirstBall') {
      const h = this.opponents?.players.get(slot === 'OH1' ? 'OPP' : 'OH1');
      if (h && Math.sign(h.pos.x) === Math.sign(base.x)) x = Math.sign(base.x) * clamp(Math.abs(h.pos.x), C.frontMin, C.frontMax);
    }
    const f = this.focus;
    /** step towards the ball's landing: `share` of the way, at most `max` m, never nearer than `keep` m */
    const towards = (share: number, max: number, keep: number) => {
      if (!f) return;
      const dx = f.x - x;
      const dz = f.z - z;
      const d = Math.hypot(dx, dz);
      const m = Math.min(share * d, max, Math.max(0, d - keep));
      if (d > 1e-3 && m > 0) {
        x += (dx / d) * m;
        z += (dz / d) * m;
      }
    };
    if (sit === 'scramble') towards(C.chase, C.chaseMax, C.chaseKeep);
    else if (sit === 'ourFirstBall' && form === 'offense' && back) towards(C.follow, C.followMax, C.chaseKeep);
    else if (sit === 'theirServe' && this.serveSeen && !this.receiver?.isUser && (slot === 'OH2' || slot === 'L'))
      towards(C.backUp, C.backUpMax, C.backUpKeep);
    // (in our own court)
    const W = COURT.halfWidth - 0.3;
    const s = this.side;
    return { x: clamp(x, -W, W), z: s * clamp(z * s, 0.5, COURT.halfLength - 0.3) };
  }

  /**
   * Free-ball defence. Their second ball was not a set (a bump-up, a scramble) and nobody of theirs
   * is going up to hit it: their third ball can only come over as a free ball. A moment after that
   * second touch (`AI.transition.read`: "FREE!") the whole team gets ready for it before it is
   * sent: the setter releases to the net, the front row drops off it to their approach starts, and
   * the libero and the back-row outside split the court behind them (`FREE_BACK`). One of theirs
   * loading or in the air for it (a swing after all) and we stay in defence.
   */
  private freeBallDefence(t: Touch, setJob: SetJob): void {
    const now = this.g.simTime;
    if (now - t.t < AI.transition.read) return;
    for (const o of this.opponents?.players.values() ?? []) if (o.state === 'load' || o.state === 'air') return;
    this.freeCall = true;
    setJob(this.players.get('S'), 'base', this.formSpot('offense', 'S'), true);
    for (const slot of ['OH1', 'MB', 'OPP'] as const) setJob(this.players.get(slot), 'attack', this.formSpot('offense', slot));
    this.freeBack(setJob);
  }

  /**
   * The setter's release. On every ball coming to our side that someone else is playing (their
   * attack, a tip, a free ball or an overpass, a ball off either block) the back-row setter goes to
   * the net as soon as it has read the touch: its own reaction to it (`AI.defence.hitReact` ±
   * `hitReactSd`, the same every defender has; a setter covering our hitter, low and watching the
   * block, reads a ball off it in `AI.cover.react`). It doesn't wait to see how good the first ball
   * will be: a setter standing in defence while the pass goes up is late to every ball. (The serve
   * has its own read: `serveTransition`. The front row leaves the net on the same read, once it is
   * back on the floor: see the transition in `step`.) A setter sent somewhere already (running with
   * the player sent to a ball they may only dive for) keeps that job. A front-row setter is
   * blocking, not releasing (the Mini Rally has no rotation, so the setter is never front row).
   */
  private setterRelease(t: Touch, jobs: Map<Athlete, unknown>, setJob: SetJob): void {
    const S = this.players.get('S');
    const b = S ? this.brains.get(S) : null;
    if (!S || !b || jobs.has(S) || this.frontRow().includes(S)) return;
    if (this.receiverFor !== t || !this.receiver || this.receiver === S) return;
    const now = this.g.simTime;
    const read = t.kind === 'block' && now - b.coverT < AI.cover.hold ? b.coverRead : b.hitRead;
    read.look(t, t.t, this.g.rng);
    if (!read.seen(now)) return;
    setJob(S, 'base', this.formSpot('offense', 'S'), true);
  }

  /**
   * The middle back reads our own block as it goes up: once both our blockers on their pin attack
   * are in the air (the cue), a reaction time later (`AI.defence.react` ± `reactSd`, as for its read
   * of the set) it looks at their hands. If the middle is late and the hands leave a seam, it steps
   * up onto the seam's line (`AI.defence.middleBackSeam`) instead of staying deep, cross of a closed
   * block. It reads the hands (a late middle's reach can close the seam), not the bodies, and only
   * while their set flies: after their contact it holds what it read, like every defender.
   */
  private readBlockSeam(set: Touch, setJob: SetJob): void {
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

  /**
   * Covering our hitter (`AI.cover`): a moment after our set, the real coverage spots for where the
   * hitter meets it (a pin, the middle, the back row), each taken by the player whose job it is if
   * they are free (not the hitter, not the user, not playing the ball), else by the nearest free
   * player. Worked out once per set, held while it flies.
   */
  private cover(set: Touch, h: Athlete, jobs: Map<Athlete, unknown>, setJob: SetJob): void {
    const g = this.g;
    const now = g.simTime;
    if (now - set.t < AI.cover.read) return;
    if (this.coverFor !== set) {
      this.coverFor = set;
      this.coverSpots = [];
      const pred = g.ball.ensurePrediction(g.env, now);
      let tc = pred.descendThrough(attackHeight(h), now);
      if (tc < 0) tc = pred.apex().t;
      pred.posAt(tc, this.cp);
      this.coverDue = tc;
      const s = this.side;
      const hx = this.cp.x * s;
      const hz = Math.max(0.5, this.cp.z * s);
      const W = COURT.halfWidth - 0.4;
      const C = AI.cover;
      // (team frame: x < 0 is our left, z is the distance from the net)
      const k = Math.sign(hx) || 1;
      const cup: { who: Slot | null; x: number; z: number }[] =
        // (the pipe is met in front of the 3 m line after a broad jump: it is the back-row hitter that counts)
        this.slotOf(h) === 'OH2' || hz > C.line
          ? [
              // a back-row attack: the middle under the block, the setter and the left back close
              { who: 'MB', x: hx, z: C.net },
              { who: 'S', x: hx + C.inside, z: hz },
              { who: 'L', x: hx - C.inside, z: hz + C.inside },
            ]
          : Math.abs(hx) < 1.5
            ? [
                // a middle attack: the setter close behind, the pins on the 3 m line either side
                { who: 'S', x: hx + 0.8, z: hz + C.inside },
                { who: 'OH1', x: hx - C.behind, z: C.line },
                { who: 'OPP', x: hx + C.behind, z: C.line },
              ]
            : [
                // a pin: the middle at the net inside the hitter, the setter on the 3 m line between,
                // the back row on that side behind on the sideline, then deep down the line and cross
                { who: 'MB', x: hx - k * C.inside, z: C.net },
                { who: 'S', x: hx - k * C.inside * 0.6, z: C.line },
                { who: k < 0 ? 'L' : 'OH2', x: hx, z: hz + C.behind },
                { who: null, x: hx * 0.6, z: C.deep },
                { who: null, x: -k * 1.5, z: C.deep },
              ];
      const free = [...this.players.values()].filter((a) => a !== h && !a.isUser && !jobs.has(a));
      for (const c of cup) {
        const x = clamp(c.x, -W, W) * s;
        const z = clamp(c.z, 0.8, COURT.halfLength - 0.5) * s;
        let best = c.who ? free.indexOf(this.players.get(c.who)!) : -1;
        let bestD = Infinity;
        if (best < 0)
          free.forEach((a, i) => {
            const d = Math.hypot(a.pos.x - x, a.pos.z - z);
            if (d < bestD) {
              bestD = d;
              best = i;
            }
          });
        if (best < 0) break;
        this.coverSpots.push({ a: free[best], spot: { x, z } });
        free.splice(best, 1);
      }
    }
    for (const c of this.coverSpots) if (!jobs.has(c.a)) setJob(c.a, 'cover', c.spot, false, this.coverDue);
  }
  private coverDue = 0;
  private coverFor: unknown = null;
  private coverSpots: { a: Athlete; spot: Spot }[] = [];
  private cp: V3 = { x: 0, y: 0, z: 0 };

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
    b.server.serve(target, this.side * -2.5, jump ? 'jump' : 'float');
    return server;
  }
}

export const faceNet = (side: 1 | -1) => yawFromDir(0, -side);
