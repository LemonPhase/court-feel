import * as THREE from 'three';
import { BALL, COURT, CONTACT, DEFAULT_SETTINGS, SIM } from '../src/config';
import { Rng } from '../src/core/mathx';
import { Athlete } from '../src/game/athlete';
import { BallEntity } from '../src/game/ballEntity';
import { blockHands, ContactSystem, type ContactEvent, type ContactHost } from '../src/game/contact';
import type { V3 } from '../src/physics/ball';
import { solveSpeedToFloor } from '../src/physics/solve';

/**
 * The block sweep (`npm run block-sweep`, scripts/block-sweep.mjs): a measurement of what the block
 * does today, not a test. Their hitter (side -1, on -z) spikes over the net at our blocker (side +1),
 * from the real spike solver (`solveSpeedToFloor`, the same topspin), with the real ball, and the real
 * block (`ContactSystem.tryBlock`, called every step as the brains and the user's hands call it).
 * Only the blocker's jump is scripted: a plain parabola whose peak is `dt` s before the ball reaches
 * the net (so the grade comes from where in the jump the hands meet it, as in play).
 *
 * Every shot is flown twice: once with nobody at the net (the ghost: where it crosses the net and
 * where it would land) and once into the block. Sides are folded so that `+` always means the same
 * thing: `off` > 0 is the ball crossing the net on the outer side of the hands (toward the nearer
 * antenna), and an angle > 0 is toward the outer side too. For a middle attack (x = 0) outer is +x.
 */

const DT = 1 / SIM.hz;
const R = BALL.radius;
const env = { netTop: COURT.netHeightMen };

export type Matchup = 'ai-ai' | 'user-hits' | 'user-blocks';

export interface SweepOptions {
  matchups: Matchup[];
  /** where along the net the hitter meets the ball (x, m) */
  attacks: { name: string; x: number }[];
  /** shot direction (deg) from straight across the net; > 0 cross (toward the court's middle), < 0 toward the line (clamped inside the sideline) */
  angles: number[];
  /** spike speeds (m/s) */
  speeds: number[];
  /** the ball reaches the net this long (s) after the blocker's peak: > 0 jumped early, < 0 late */
  timings: number[];
  /** where the ball crosses the net from the middle of the hands (m), > 0 on the outer side */
  offsets: number[];
  seeds: number;
  /** contact point of the hitter: heights (m) and distance off the net (m) */
  contactYs: number[];
  contactOff: number;
  /** how deep into our court the shot is aimed (m) */
  depth: number;
}

export interface Shot {
  matchup: Matchup;
  contactY: number;
  attack: string;
  angle: number;
  speed: number;
  timing: number;
  off: number;
  seed: number;
  /** where the ghost crosses the net: along it (folded, from the hands' middle) and how high */
  crossOff: number;
  crossY: number;
  /** the top of the hands as the ghost crosses */
  handsTop: number;
  /** the ghost's line crosses the net plane inside the hands' face (± halfWidth + R, top - height - R .. top + R) */
  netPlaneHit: boolean;
  touched: boolean;
  kind: string;
  grade: string;
  /** where the ball met the block: off the hands' middle (folded), below the fingertips, and z (> 0: our side of the net) */
  hitOff: number;
  hitBelowTop: number;
  hitZ: number;
  /** incoming and outgoing direction along the floor (deg, folded: > 0 outer), outgoing speed and its up part */
  inYaw: number;
  outYaw: number;
  inSpeed: number;
  outSpeed: number;
  outVy: number;
  /** first floor contact after the block (null: none in 6 s) and whose floor, in or out */
  landX: number | null;
  landZ: number | null;
  landOn: 'blocker' | 'hitter' | 'none';
  landIn: boolean;
  /** the ghost's landing */
  ghostX: number;
  ghostZ: number;
}

class Host implements ContactHost {
  ball = new BallEntity();
  simTime = 0;
  env = env;
  rng = new Rng(1);
  events: ContactEvent[] = [];
  contactSys = new ContactSystem(this);
  aimAssist(a: Athlete): number {
    // as the game gives it (src/app/game.ts): the user's setting, 0.3 for the AI
    return a.isUser ? DEFAULT_SETTINGS.aimAssist : 0.3;
  }
  aimTargetFor(_a: Athlete, out: THREE.Vector3): THREE.Vector3 {
    return out.set(0, 0, 6);
  }
  emitContact(ev: ContactEvent): void {
    this.events.push(ev);
  }
  rand(): number {
    return this.rng.next();
  }
  passTarget(): { x: number; y: number; z: number; apex: number } {
    throw new Error('not in the block sweep');
  }
  setOptions(): never[] {
    return [];
  }
  canServe(): boolean {
    return false;
  }
}

/** FNV-1a: a seed from a shot's description */
function hash(text: string): number {
  let h = 2166136261;
  for (let i = 0; i < text.length; i++) h = Math.imul(h ^ text.charCodeAt(i), 16777619);
  return h >>> 0;
}

const deg = (r: number) => (r * 180) / Math.PI;
const isIn = (x: number, z: number) => Math.abs(x) <= COURT.halfWidth + R && Math.abs(z) <= COURT.halfLength + R;

/**
 * The blocker's jump as the game flies it (`Athlete.takeoffSpeed`, `Athlete.gravityAt`: a little hang
 * at the top), as a table of height and vertical speed from the takeoff, and the time of its peak.
 */
function jumpCurve(H: number): { y: number[]; vy: number[]; peak: number; step: number } {
  const step = 1 / 2000;
  const y = [0];
  const vy = [Athlete.takeoffSpeed(H)];
  let peak = 0;
  while (y[y.length - 1] >= 0) {
    const v = vy[vy.length - 1];
    const nv = v - Athlete.gravityAt(v) * step;
    y.push(y[y.length - 1] + ((v + nv) / 2) * step);
    vy.push(nv);
    if (v > 0 && nv <= 0) peak = (y.length - 1) * step;
  }
  return { y, vy, peak, step };
}
const curves = new Map<number, ReturnType<typeof jumpCurve>>();

/** the blocker's feet on that jump, peaking at `tPeak` */
function jumpAt(a: Athlete, t: number, tPeak: number, H: number): void {
  let c = curves.get(H);
  if (!c) curves.set(H, (c = jumpCurve(H)));
  const i = Math.round((t - tPeak + c.peak) / c.step);
  if (i > 0 && i < c.y.length - 1) {
    a.state = 'air';
    a.jumpH = H;
    a.pos.y = c.y[i];
    a.vel.y = c.vy[i];
  } else {
    a.state = 'ground';
    a.pos.y = 0;
    a.vel.y = 0;
  }
}

function launchSpike(ball: BallEntity, p0: V3, target: V3, speed: number): void {
  const v = { x: 0, y: 0, z: 0 };
  const w = { x: 0, y: 0, z: 0 };
  const land = { x: 0, y: 0, z: 0 };
  const spin =
    speed >= CONTACT.spikePerfect ? CONTACT.spikeSpinPerfect : speed >= CONTACT.spikeGood ? CONTACT.spikeSpinGood : CONTACT.spikeSpinOk;
  solveSpeedToFloor(p0, target.x, target.z, speed, spin, v, w, land);
  ball.launch(p0, v, w, 0, 0);
}

/** fly the ball until it first touches the floor (or `limit` s): where, and how long it took */
function flyToFloor(host: Host, limit: number, each?: (t: number) => void): { x: number; z: number } | null {
  const ball = host.ball;
  for (let t = 0; t < limit; t += DT) {
    ball.step(DT, env);
    host.simTime += DT;
    each?.(host.simTime);
    const floor = ball.events.find((e) => e.kind === 'floor');
    if (floor) return { x: floor.x, z: floor.z };
  }
  return null;
}

export function runShot(
  o: {
    matchup: Matchup;
    contactY: number;
    attackX: number;
    attack: string;
    angle: number;
    speed: number;
    timing: number;
    off: number;
    seed: number;
  },
  opts: SweepOptions,
): Shot {
  const host = new Host();
  const ball = host.ball;
  // outer: toward the nearer antenna (for a middle attack, +x)
  const sx = o.attackX < 0 ? -1 : 1;
  const p0 = { x: o.attackX, y: o.contactY, z: -opts.contactOff };
  // > 0 angle is cross: away from the outer side
  const run = opts.depth + opts.contactOff;
  const tx = Math.max(-COURT.halfWidth + 0.3, Math.min(COURT.halfWidth - 0.3, o.attackX - sx * Math.tan((o.angle * Math.PI) / 180) * run));
  const target = { x: tx, y: 0, z: opts.depth };

  // ---- the ghost: nobody at the net
  launchSpike(ball, p0, target, o.speed);
  let cross: { x: number; y: number; t: number } | null = null;
  let prev = { ...ball.pos };
  const ghostLand = flyToFloor(host, 3, (t) => {
    const p = ball.pos;
    if (!cross && prev.z < 0 && p.z >= 0) {
      const f = -prev.z / (p.z - prev.z);
      cross = { x: prev.x + (p.x - prev.x) * f, y: prev.y + (p.y - prev.y) * f, t: t - DT + DT * f };
    }
    prev = { ...p };
  }) ?? { x: NaN, z: NaN };
  const c = cross as { x: number; y: number; t: number } | null;

  // ---- the block
  const hitter = new Athlete('OH', -1);
  hitter.isUser = o.matchup === 'user-hits';
  const a = new Athlete('MB', 1);
  a.isUser = o.matchup === 'user-blocks';
  const H = a.jumpMax * a.stats.standingJumpFrac;
  const crossX = c ? c.x : p0.x;
  const tc = c ? c.t : 0.1;
  a.place(crossX - o.off * sx, 0.45, Math.PI);
  const tPeak = tc - o.timing;

  host.simTime = 0;
  host.events.length = 0;
  // the shot's own random stream, the same for every matchup (so they can be compared roll for roll)
  host.rng = new Rng(hash(`${o.attack} ${o.angle} ${o.speed} ${o.timing} ${o.off} ${o.contactY} ${o.seed}`));
  launchSpike(ball, p0, target, o.speed);
  ball.lastTouch = { athlete: hitter, kind: 'spike', t: 0, side: -1, green: false };
  const act = a.startAction('block', -1);
  a.action = act;
  jumpAt(a, tc, tPeak, H);
  const handsTop = blockHands(a).top;
  const halfW = CONTACT.blockHalfWidth + host.aimAssist(a) * 0.12;
  const netPlaneHit =
    !!c && Math.abs(c.x - (a.pos.x + a.reachX)) <= halfW + R && c.y <= handsTop + R && c.y >= handsTop - CONTACT.blockHeight - R;

  let inV = { x: 0, y: 0, z: 0 };
  let hitAt: V3 | null = null;
  let hands = { x: 0, top: 0 };
  const shot: Shot = {
    ...o,
    attack: o.attack,
    crossOff: c ? (c.x - (a.pos.x + a.reachX)) * sx : NaN,
    crossY: c ? c.y : NaN,
    handsTop,
    netPlaneHit,
    touched: false,
    kind: 'none',
    grade: '',
    hitOff: NaN,
    hitBelowTop: NaN,
    hitZ: NaN,
    inYaw: NaN,
    outYaw: NaN,
    inSpeed: NaN,
    outSpeed: NaN,
    outVy: NaN,
    landX: null,
    landZ: null,
    landOn: 'none',
    landIn: false,
    ghostX: ghostLand.x,
    ghostZ: ghostLand.z,
  };
  for (let t = 0; t < 2 && !act.resolved; t += DT) {
    inV = { ...ball.vel };
    ball.step(DT, env);
    host.simTime += DT;
    jumpAt(a, host.simTime, tPeak, H);
    hands = blockHands(a);
    if (host.contactSys.tryBlock(a, act)) hitAt = { ...act.contactPoint };
    if (ball.events.some((e) => e.kind === 'floor')) break;
  }
  if (act.resolved && hitAt) {
    const v = ball.vel;
    shot.touched = true;
    shot.kind = act.note === 'Stuff!' ? 'stuff' : act.note === 'Soft block' ? 'soft' : act.note === 'Off the block' ? 'recycle' : 'tool';
    shot.grade = act.grade ?? '';
    shot.hitOff = (hitAt.x - hands.x) * sx;
    shot.hitBelowTop = hands.top - hitAt.y;
    shot.hitZ = hitAt.z;
    shot.inYaw = deg(Math.atan2(inV.x * sx, inV.z));
    shot.inSpeed = Math.hypot(inV.x, inV.y, inV.z);
    // outgoing along the floor, folded the same way; for a ball coming back (z < 0) measured from -z
    shot.outYaw = deg(Math.atan2(v.x * sx, Math.abs(v.z)));
    shot.outSpeed = Math.hypot(v.x, v.y, v.z);
    shot.outVy = v.y;
    const land = flyToFloor(host, 6);
    if (land) {
      shot.landX = land.x * sx;
      shot.landZ = land.z;
      shot.landOn = land.z > 0 ? 'blocker' : 'hitter';
      shot.landIn = isIn(land.x, land.z);
    }
  }
  return shot;
}

export const DEFAULT_SWEEP: SweepOptions = {
  matchups: ['ai-ai', 'user-hits', 'user-blocks'],
  attacks: [
    { name: 'outside', x: 3.5 },
    { name: 'middle', x: 0 },
    { name: 'opposite', x: -3.5 },
  ],
  angles: [-15, 0, 15, 30, 45],
  speeds: [12, 19, 26, 30],
  timings: [-0.25, -0.15, -0.08, 0, 0.08, 0.15, 0.25],
  offsets: Array.from({ length: 23 }, (_, i) => Math.round((-1.1 + i * 0.1) * 100) / 100),
  seeds: 2,
  contactYs: [3.35, 3.55],
  contactOff: 0.8,
  depth: 6,
};

/** every combination of the options, in a fixed order */
export function* sweep(opts: SweepOptions = DEFAULT_SWEEP): Generator<Shot> {
  for (const matchup of opts.matchups)
    for (const contactY of opts.contactYs)
      for (const at of opts.attacks)
        for (const angle of opts.angles)
          for (const speed of opts.speeds)
            for (const timing of opts.timings)
              for (const off of opts.offsets)
                for (let seed = 0; seed < opts.seeds; seed++)
                  yield runShot({ matchup, contactY, attackX: at.x, attack: at.name, angle, speed, timing, off, seed }, opts);
}

/** the blocker the sweep uses, for the report header */
export function blockerFacts(): { standReach: number; jump: number; handsTopAtPeak: number; halfWidthAi: number; halfWidthUser: number } {
  const a = new Athlete('MB', 1);
  const H = a.jumpMax * a.stats.standingJumpFrac;
  return {
    standReach: a.standReach,
    jump: H,
    handsTopAtPeak: a.standReach + 0.04 + H,
    halfWidthAi: CONTACT.blockHalfWidth + 0.3 * 0.12,
    halfWidthUser: CONTACT.blockHalfWidth + DEFAULT_SETTINGS.aimAssist * 0.12,
  };
}
