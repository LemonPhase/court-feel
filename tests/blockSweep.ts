import { COURT, CONTACT, DEFAULT_SETTINGS } from '../src/config';
import { Athlete } from '../src/game/athlete';
import { blockJump, blockScene, ghost, R, type SceneSpec } from './blockScene';

/**
 * The block sweep (`npm run block-sweep`, scripts/block-sweep.mjs): a measurement of what the block
 * does, not a test. Their hitter (side -1, on -z) spikes over the net at our blocker (side +1),
 * from the real spike solver, with the real ball and the real block (`ContactSystem.tryBlock`),
 * through `blockScene` (tests/blockScene.ts). Only the blocker's jump is scripted, on the game's own
 * jump curve: its peak `timing` s before the ball reaches the net.
 *
 * Every shot is flown twice: once with nobody at the net (the ghost: where it crosses the net and
 * where it would land) and once into the block. Sides are folded so that `+` always means the same
 * thing: `off` > 0 is the ball crossing the net on the outer side of the blocker (toward the nearer
 * antenna), and a yaw > 0 is toward the outer side too. For a middle attack (x = 0) outer is +x.
 */

export type Matchup = 'ai-ai' | 'user-hits' | 'user-blocks';

export interface SweepOptions {
  matchups: Matchup[];
  /** where along the net the hitter meets the ball (x, m) */
  attacks: { name: string; x: number }[];
  /** shot direction (deg) from straight across the net; > 0 cross (toward the court's middle), < 0 toward the line (clamped inside the sideline) */
  angles: number[];
  /** spike speeds (m/s) */
  speeds: number[];
  /** the ball reaches the net this long after the blocker's peak: > 0 jumped early, < 0 late */
  timings: number[];
  /** where the ball crosses the net from the blocker's middle (m), > 0 on the outer side */
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
  /** where the ghost crosses the net: along it (folded, from the blocker's middle) and how high */
  crossOff: number;
  crossY: number;
  /** the top of the hands with the arms straight up, as the ghost crosses (the most they can reach) */
  handsTop: number;
  touched: boolean;
  kind: string;
  grade: string;
  /** where the ball met the block: a hand or a forearm, how far up it (0 heel, 1 fingertips) and across it (folded: > 0 toward the outer side) */
  part: string;
  along: number;
  across: number;
  /** how much arm was behind the touch (kg) and the restitution */
  mass: number;
  rest: number;
  /** where the ball met the block, z (> 0: our side of the net) */
  hitZ: number;
  /** incoming and outgoing direction along the floor (deg, folded: > 0 outer), speeds and the up part of the outgoing */
  inYaw: number;
  outYaw: number;
  inSpeed: number;
  outSpeed: number;
  outVy: number;
  /** first floor contact after the block (null: none in 4 s) and whose floor, in or out */
  landX: number | null;
  landZ: number | null;
  landOn: 'blocker' | 'hitter' | 'none';
  landIn: boolean;
  /** the ghost's landing */
  ghostX: number;
  ghostZ: number;
}

/** FNV-1a: a seed from a shot's description */
function hash(text: string): number {
  let h = 2166136261;
  for (let i = 0; i < text.length; i++) h = Math.imul(h ^ text.charCodeAt(i), 16777619);
  return h >>> 0;
}

const deg = (r: number) => (r * 180) / Math.PI;

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
  // outer: toward the nearer antenna (for a middle attack, +x)
  const sx = o.attackX < 0 ? -1 : 1;
  const from = { x: o.attackX, y: o.contactY, z: -opts.contactOff };
  const run = opts.depth + opts.contactOff;
  const tx = Math.max(-COURT.halfWidth + 0.3, Math.min(COURT.halfWidth - 0.3, o.attackX - sx * Math.tan((o.angle * Math.PI) / 180) * run));
  const spec: SceneSpec = { from, to: { x: tx, y: 0, z: opts.depth }, speed: o.speed, blockers: [], hitterUser: o.matchup === 'user-hits' };
  const g = ghost(spec);
  const c = g.cross;
  const crossX = c ? c.x : from.x;
  const bx = crossX - o.off * sx;
  const r = blockScene({
    ...spec,
    blockers: [{ x: bx, timing: o.timing, user: o.matchup === 'user-blocks' }],
    seed: hash(`${o.attack} ${o.angle} ${o.speed} ${o.timing} ${o.off} ${o.contactY} ${o.seed}`),
  });
  const probe = new Athlete('MB', 1);
  const shot: Shot = {
    matchup: o.matchup,
    contactY: o.contactY,
    attack: o.attack,
    angle: o.angle,
    speed: o.speed,
    timing: o.timing,
    off: o.off,
    seed: o.seed,
    crossOff: c ? (c.x - bx) * sx : NaN,
    crossY: c ? c.y : NaN,
    handsTop: probe.standReach + blockJump(probe) + 0.04,
    touched: r.touched,
    kind: r.kind,
    grade: r.grade,
    part: '',
    along: NaN,
    across: NaN,
    mass: NaN,
    rest: NaN,
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
    ghostX: g.land ? g.land.x : NaN,
    ghostZ: g.land ? g.land.z : NaN,
  };
  if (r.touched && r.vIn && r.vOut && r.hit) {
    const h = r.hit;
    const plate = h.hit.plate as { arm?: boolean; w: { x: number } };
    shot.part = plate.arm ? 'arm' : 'hand';
    shot.along = h.hit.along;
    // (folded: a hand's +w is out toward its little finger; for the outer hand that is toward the antenna)
    shot.across = h.hit.across * Math.sign(plate.w.x * sx || 1);
    shot.mass = h.mass;
    shot.rest = h.rest;
    shot.hitZ = h.hit.p.z;
    shot.inYaw = deg(Math.atan2(r.vIn.x * sx, r.vIn.z));
    shot.inSpeed = Math.hypot(r.vIn.x, r.vIn.y, r.vIn.z);
    // outgoing along the floor, folded the same way; for a ball coming back (z < 0) measured from -z
    shot.outYaw = deg(Math.atan2(r.vOut.x * sx, Math.abs(r.vOut.z)));
    shot.outSpeed = Math.hypot(r.vOut.x, r.vOut.y, r.vOut.z);
    shot.outVy = r.vOut.y;
  }
  if (r.touched && r.land) {
    shot.landX = r.land.x * sx;
    shot.landZ = r.land.z;
    shot.landOn = r.landSide ?? 'none';
    shot.landIn = r.landIn;
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
  seeds: 1,
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
  const H = blockJump(a);
  return {
    standReach: a.standReach,
    jump: H,
    handsTopAtPeak: a.standReach + 0.04 + H,
    halfWidthAi: CONTACT.blockHalfWidth + 0.3 * 0.06,
    halfWidthUser: CONTACT.blockHalfWidth + DEFAULT_SETTINGS.aimAssist * 0.06,
  };
}

export { R };
