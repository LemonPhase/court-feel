import * as THREE from 'three';
import { BALL, COURT, CONTACT, DEFAULT_SETTINGS, SIM, type PositionId } from '../src/config';
import { Rng } from '../src/core/mathx';
import { Athlete, type Action } from '../src/game/athlete';
import { BallEntity, type Touch, type TouchKind } from '../src/game/ballEntity';
import { handPlates, type BlockHand } from '../src/game/blockHands';
import { ContactSystem, type ContactEvent, type ContactHost } from '../src/game/contact';
import type { V3 } from '../src/physics/ball';
import { solveSpeedToFloor } from '../src/physics/solve';

/**
 * A block, on its own: their hitter (side -1, on -z) sends a ball over the net at our blockers
 * (side +1) with the real ball and the real block (`ContactSystem.tryBlock`, called every step in
 * the order the simulation calls it: the blockers' hands, then the ball's step). Only the blockers'
 * jumps are scripted, on the game's own jump curve, timed from the moment the ball would reach the
 * net with nobody there (the ghost). Used by the block's unit tests and by the block sweep
 * (`node scripts/block-sweep.mjs`).
 */

export const DT = 1 / SIM.hz;
export const R = BALL.radius;
export const env = { netTop: COURT.netHeightMen };

export interface BlockerSpec {
  /** where the blocker's feet are along the net, and off it (m) */
  x: number;
  z?: number;
  /** the ball reaches the net this long (s) after the blocker's peak: > 0 jumped early, < 0 late */
  timing?: number;
  /** feet on the floor: no jump at all */
  ground?: boolean;
  user?: boolean;
  role?: PositionId;
  /** a sideways reach of the hands (m, `Athlete.reachX`) */
  reachX?: number;
}

export interface SceneSpec {
  /** the hitter's contact point */
  from: V3;
  /** where the attack is aimed on the floor (spike solver), at `speed` m/s with the spike's topspin... */
  to?: V3;
  speed?: number;
  /** ...or the ball's velocity and spin as given */
  vel?: V3;
  spin?: V3;
  blockers: BlockerSpec[];
  hitterUser?: boolean;
  /** the user blocker's aim assist (Settings); the game's default when not given */
  assist?: number;
  /** the attack is off the user's green set */
  green?: boolean;
  /** what their touch was (a spike when not given; a serve may not be blocked) */
  kind?: TouchKind;
  seed?: number;
}

export interface GhostFlight {
  /** where and when the ball crosses the net (z = 0) with nobody there */
  cross: { x: number; y: number; t: number } | null;
  land: { x: number; z: number } | null;
  /** the launch velocity and spin */
  v: V3;
  w: V3;
}

export interface SceneResult {
  touched: boolean;
  /** stuff, soft, tool, recycle (or none) */
  kind: string;
  note: string;
  grade: string;
  /** every block contact, in order */
  events: ContactEvent[];
  /** which blocker touched first (index into `blockers`) */
  by: number;
  /** where the ball met the hands, and its velocity just before and just after */
  at: V3 | null;
  vIn: V3 | null;
  vOut: V3 | null;
  /** first floor contact after the block (null: none in 4 s) */
  land: { x: number; z: number } | null;
  /** inside the lines (and on which side of the net) */
  landIn: boolean;
  landSide: 'blocker' | 'hitter' | null;
  ghost: GhostFlight;
  athletes: Athlete[];
  /** the first touch: where on the hand, how the hand gave, the ball's spin before and after */
  hit: ContactSystem['lastBlock'];
  wIn: V3 | null;
  wOut: V3 | null;
  /** the middles of the hands and forearms the first blocker's action carried at the touch: what the game draws */
  drawn: V3[];
}

class Host implements ContactHost {
  ball = new BallEntity();
  simTime = 0;
  env = env;
  rng: Rng;
  events: ContactEvent[] = [];
  contactSys = new ContactSystem(this);
  constructor(
    seed: number,
    private userAssist: number = DEFAULT_SETTINGS.aimAssist,
  ) {
    this.rng = new Rng(seed);
  }
  aimAssist(a: Athlete): number {
    // as the game gives it (src/app/game.ts): the user's setting, 0.3 for the AI
    return a.isUser ? this.userAssist : 0.3;
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
    throw new Error('not in a block scene');
  }
  setOptions(): never[] {
    return [];
  }
  canServe(): boolean {
    return false;
  }
}

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

/** the blocker's block jump (a standing jump: `standingJumpFrac` of its best) */
export function blockJump(a: Athlete): number {
  return a.jumpMax * a.stats.standingJumpFrac;
}

/** put the blocker's feet where its jump has them at `t`, the jump peaking at `tPeak` */
export function jumpAt(a: Athlete, t: number, tPeak: number, H: number): void {
  let c = curves.get(H);
  if (!c) curves.set(H, (c = jumpCurve(H)));
  const i = Math.round((t - tPeak + c.peak) / c.step);
  if (i > 0 && i < c.y.length - 1) {
    if (a.state !== 'air') a.takeoffT = t - i * c.step;
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

/** the attack's launch: the spike solver's line to `to` at `speed`, with its topspin, or the given velocity */
export function launch(spec: SceneSpec): { v: V3; w: V3 } {
  if (spec.vel) return { v: { ...spec.vel }, w: { ...(spec.spin ?? { x: 0, y: 0, z: 0 }) } };
  const speed = spec.speed ?? CONTACT.spikeGood;
  const to = spec.to ?? { x: spec.from.x, y: 0, z: 6 };
  const v = { x: 0, y: 0, z: 0 };
  const w = { x: 0, y: 0, z: 0 };
  const land = { x: 0, y: 0, z: 0 };
  const spin =
    speed >= CONTACT.spikePerfect ? CONTACT.spikeSpinPerfect : speed >= CONTACT.spikeGood ? CONTACT.spikeSpinGood : CONTACT.spikeSpinOk;
  solveSpeedToFloor(spec.from, to.x, to.z, speed, spin, v, w, land);
  return { v, w };
}

/** the attack with nobody at the net: where it crosses the net and where it lands */
export function ghost(spec: SceneSpec): GhostFlight {
  const { v, w } = launch(spec);
  const ball = new BallEntity();
  ball.launch(spec.from, v, w, 0, 0);
  let cross: GhostFlight['cross'] = null;
  let land: GhostFlight['land'] = null;
  let t = 0;
  for (let i = 0; i < 4 * SIM.hz && !land; i++) {
    const p0 = { ...ball.pos };
    ball.step(DT, env);
    t += DT;
    const p = ball.pos;
    if (!cross && p0.z < 0 && p.z >= 0) {
      const f = -p0.z / (p.z - p0.z);
      cross = { x: p0.x + (p.x - p0.x) * f, y: p0.y + (p.y - p0.y) * f, t: t - DT + DT * f };
    }
    const floor = ball.events.find((e) => e.kind === 'floor');
    if (floor) land = { x: floor.x, z: floor.z };
  }
  return { cross, land, v, w };
}

// as the judge calls it: where the ball meets the floor, on the lines or inside them
const isIn = (x: number, z: number) => Math.abs(x) <= COURT.halfWidth && Math.abs(z) <= COURT.halfLength;

export function kindOf(note: string): string {
  return note === 'Stuff!'
    ? 'stuff'
    : note === 'Soft block'
      ? 'soft'
      : note === 'Off the block'
        ? 'recycle'
        : note === 'Tooled'
          ? 'tool'
          : note;
}

/** play the scene: the attack, the blockers going up for it, and the ball to the floor */
export function blockScene(spec: SceneSpec): SceneResult {
  const g = ghost(spec);
  const host = new Host(spec.seed ?? 1, spec.assist);
  const ball = host.ball;
  // their hitter where it met the ball (the blockers square their hands to it, as in the game)
  const hitter = new Athlete('OH', -1);
  hitter.isUser = spec.hitterUser === true;
  hitter.place(spec.from.x, spec.from.z, 0);
  const tc = g.cross ? g.cross.t : 0.1;
  const blockers = spec.blockers.map((b) => {
    const a = new Athlete(b.role ?? 'MB', 1);
    a.isUser = b.user === true;
    a.place(b.x, b.z ?? 0.45, Math.PI);
    a.reachX = b.reachX ?? 0;
    const act = a.startAction('block', -1);
    return { a, act, H: blockJump(a), tPeak: tc - (b.timing ?? 0), ground: b.ground === true };
  });
  const pose = (t: number) => {
    for (const b of blockers) {
      if (b.ground) {
        b.a.state = 'ground';
        b.a.pos.y = 0;
        b.a.vel.y = 0;
      } else jumpAt(b.a, t, b.tPeak, b.H);
    }
  };
  ball.launch(spec.from, g.v, g.w, 0, 0);
  ball.lastTouch = { athlete: hitter, kind: spec.kind ?? 'spike', t: 0, side: -1, green: spec.green === true };
  pose(0);
  let vIn: V3 | null = null;
  let vOut: V3 | null = null;
  let wIn: V3 | null = null;
  let wOut: V3 | null = null;
  let hit: ContactSystem['lastBlock'] = null;
  let touchStep = false;
  let drawn: V3[] = [];
  let at: V3 | null = null;
  let by = -1;
  let first: Action | null = null;
  let land: SceneResult['land'] = null;
  for (let i = 0; i < 4 * SIM.hz && !land; i++) {
    host.simTime += DT;
    pose(host.simTime);
    for (let k = 0; k < blockers.length; k++) {
      const { a, act } = blockers[k];
      if (act.resolved) continue;
      const before = { ...ball.vel };
      const spin = { ...ball.state.w };
      if (host.contactSys.tryBlock(a, act) && !first) {
        first = act;
        by = k;
        vIn = before;
        vOut = { ...ball.vel };
        wIn = spin;
        wOut = { ...ball.state.w };
        hit = host.contactSys.lastBlock;
        at = { x: act.contactPoint.x, y: act.contactPoint.y, z: act.contactPoint.z };
        touchStep = true;
      }
    }
    // the contact system's own step, as the simulation runs it after the blocks: it keeps the hands to draw
    host.contactSys.step(blockers.map((b) => b.a));
    if (touchStep) {
      drawn = [...(first?.hands ?? []), ...(first?.arms ?? [])].map((p) => ({ ...p.c }));
      touchStep = false;
    }
    ball.step(DT, env);
    const floor = ball.events.find((e) => e.kind === 'floor');
    if (floor) land = { x: floor.x, z: floor.z };
  }
  const note = first ? (first as Action).note : '';
  return {
    touched: !!first,
    kind: first ? kindOf(note) : 'none',
    note,
    grade: first ? ((first as Action).grade ?? '') : '',
    events: host.events,
    by,
    at,
    vIn,
    vOut,
    land,
    landIn: !!land && isIn(land.x, land.z),
    landSide: land ? (land.z > 0 ? 'blocker' : 'hitter') : null,
    ghost: g,
    athletes: blockers.map((b) => b.a),
    hit,
    wIn,
    wOut,
    drawn,
  };
}

/** a straight-line spike from an outside hitter's spot, aimed `angle` rad cross from square, at `speed` */
export function spikeAt(fromX: number, angle: number, speed: number, opts: { y?: number; off?: number; depth?: number } = {}): SceneSpec {
  const off = opts.off ?? 0.8;
  const depth = opts.depth ?? 6;
  const sx = fromX < 0 ? -1 : 1;
  const tx = fromX - sx * Math.tan(angle) * (depth + off);
  return { from: { x: fromX, y: opts.y ?? 3.35, z: -off }, to: { x: tx, y: 0, z: depth }, speed, blockers: [] };
}

/**
 * a blocker as `blockScene` sets it up, at the top of its jump: its hands (and forearms) squared to
 * their hitter at `from` (or, with none, to a ball coming along `dir`), with the user's `assist`
 */
export function handsAtPeak(b: BlockerSpec, dir: V3, from?: V3, assist: number = DEFAULT_SETTINGS.aimAssist): BlockHand[] {
  const a = new Athlete(b.role ?? 'MB', 1);
  a.isUser = b.user === true;
  a.place(b.x, b.z ?? 0.45, Math.PI);
  a.reachX = b.reachX ?? 0;
  const act = a.startAction('block', -1);
  if (!b.ground) {
    a.state = 'air';
    a.jumpH = blockJump(a);
    a.pos.y = a.jumpH;
  }
  let attack: Touch | null = null;
  if (from) {
    const hitter = new Athlete('OH', -1);
    hitter.place(from.x, from.z, 0);
    attack = { athlete: hitter, kind: 'spike', t: 0, side: -1 };
  }
  return handPlates(a, act, 0, { netTop: env.netTop, assist: a.isUser ? assist : 0.3, ballVel: dir, attack });
}

/** an attack from `from` straight through the point `to` at `speed` m/s (gravity allowed for), with a spike's topspin */
export function through(from: V3, to: V3, speed: number, blockers: BlockerSpec[], spin: number = CONTACT.spikeSpinGood): SceneSpec {
  const dx = to.x - from.x;
  const dy = to.y - from.y;
  const dz = to.z - from.z;
  const d = Math.hypot(dx, dy, dz);
  const T = d / speed;
  const ux = dx / Math.hypot(dx, dz);
  const uz = dz / Math.hypot(dx, dz);
  return {
    from,
    vel: { x: (dx / d) * speed, y: (dy / d) * speed + (BALL.gravity * T) / 2, z: (dz / d) * speed },
    spin: { x: uz * spin, y: 0, z: -ux * spin },
    blockers,
  };
}

/** the middle of the palm of a blocker's hand at the top of its jump: `outer` its +x hand (else -x), moved `across` m out and `up` m along the hand */
export function palm(b: BlockerSpec, dir: V3, outer: boolean, across = 0, up = 0, from?: V3): V3 {
  const hands = handsAtPeak(b, dir, from).filter((h) => !h.arm);
  const h = hands.reduce((p, q) => ((outer ? q.c.x > p.c.x : q.c.x < p.c.x) ? q : p));
  return { x: h.c.x + h.w.x * across + h.u.x * up, y: h.c.y + h.w.y * across + h.u.y * up, z: h.c.z + h.w.z * across + h.u.z * up };
}

/** on the outer (little finger's) edge of a blocker's hand at the top of its jump, `beyond` m past it (at the middle of the palm's length) */
export function edgeOf(b: BlockerSpec, dir: V3, outer: boolean, beyond: number, from?: V3): V3 {
  const hands = handsAtPeak(b, dir, from).filter((h) => !h.arm);
  const h = hands.reduce((p, q) => ((outer ? q.c.x > p.c.x : q.c.x < p.c.x) ? q : p));
  const k = h.hw + beyond;
  return { x: h.c.x + h.w.x * k, y: h.c.y + h.w.y * k, z: h.c.z + h.w.z * k };
}

/** between the two palms (between the thumbs), or with `arms` between the two forearms */
export function between(b: BlockerSpec, dir: V3, from?: V3, arms = false, assist?: number): V3 {
  const [p, q] = handsAtPeak(b, dir, from, assist).filter((h) => h.arm === arms);
  return { x: (p.c.x + q.c.x) / 2, y: (p.c.y + q.c.y) / 2, z: (p.c.z + q.c.z) / 2 };
}
