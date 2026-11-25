import { BALL, BLOCK } from '../config';
import { INV_I_TERM, type V3 } from './ball';

/**
 * A blocking hand meeting the ball (`BLOCK`). A hand is a flat plate: the middle of its palm `c`,
 * the way the palm faces `n`, the way from the wrist to the fingertips `u` and across the hand `w`
 * (the three at right angles), half its length `hl` and half its width `hw`. The ball meets it
 * where it passes within its radius (and half the hand's thickness) of the plate: the face, the
 * fingertips' edge or a side. Where on the hand is where the ball's line goes through it: a ball
 * aimed inside the hand is taken square on its face there (a steep spike aimed at the palm touches
 * the fingertips first, they give and it rolls onto the palm), one aimed past an edge glances off
 * that edge, the normal running from the edge to the ball's centre: one that clips the fingertips
 * is pushed up and on, one that clips the side is pushed off sideways. A block-out is the ball
 * glancing off the outer edge, not a rule. Between the two the touch turns from the face's to the
 * edge's over the last ball's radius (no jump in where a ball goes for a centimetre in its aim).
 *
 * Pure: the game places the hands (src/game/blockHands.ts) and decides how firm they are.
 */

export interface HandPlate {
  c: V3;
  n: V3;
  u: V3;
  w: V3;
  hl: number;
  hw: number;
  /** the fingertips' middle */
  tip: V3;
  /** how the hand is moving (m/s) */
  v: V3;
  /** which hand or arm (unique per athlete) */
  id: number;
  /**
   * the gap (m) past its -w edge to the other hand's thumb: a ball whose line is in it rests on
   * both thumbs, so each hand takes it on its face (0: nothing there, a forearm)
   */
  gap: number;
  /** how far (m) past its -u edge (the heel) the arm carries on: a ball's line there is on the arm, not past an edge */
  heel: number;
}

export interface HandHit {
  /** the share of the step at which the ball met the hand (0: where it started) */
  s: number;
  /** the ball's centre then, the point of the hand it touched, and the normal from that point to the ball */
  p: V3;
  q: V3;
  N: V3;
  /** where on the hand: 0 the heel to 1 the fingertips; across it from -1 (the -w edge) through 0 (the middle) to 1 (the +w edge) */
  along: number;
  across: number;
  /**
   * how far (m) inside the hand the ball's line goes through it, from its nearest edge: < 0 the line
   * passes outside the hand by that much and only the ball's side touches it (a nick, a graze over the
   * fingertips); 0 when the ball is not coming at the hand's face
   */
  depth: number;
  plate: HandPlate;
}

const dot = (a: V3, b: V3) => a.x * b.x + a.y * b.y + a.z * b.z;

/** the nearest point of the plate to `p`, into `q`; returns the distance and where on the hand it is */
function nearest(p: V3, h: HandPlate, q: V3): { d: number; along: number; across: number } {
  const dx = p.x - h.c.x;
  const dy = p.y - h.c.y;
  const dz = p.z - h.c.z;
  const lu = dx * h.u.x + dy * h.u.y + dz * h.u.z;
  const lw = dx * h.w.x + dy * h.w.y + dz * h.w.z;
  const cu = Math.max(-h.hl, Math.min(h.hl, lu));
  const cw = Math.max(-h.hw, Math.min(h.hw, lw));
  q.x = h.c.x + h.u.x * cu + h.w.x * cw;
  q.y = h.c.y + h.u.y * cu + h.w.y * cw;
  q.z = h.c.z + h.u.z * cu + h.w.z * cw;
  return {
    d: Math.hypot(p.x - q.x, p.y - q.y, p.z - q.z),
    along: (cu + h.hl) / (2 * h.hl),
    across: cw / h.hw,
  };
}

const at = (a: V3, b: V3, s: number): V3 => ({ x: a.x + (b.x - a.x) * s, y: a.y + (b.y - a.y) * s, z: a.z + (b.z - a.z) * s });

/**
 * Where, on its way from `p0` to `p1` this step, the ball first comes within `reach` (its radius
 * and half a hand's thickness) of the hand, or null. The hand moved too: `dt` s of its speed is
 * taken off the ball's start, so the search runs in the hand's frame at the end of the step.
 */
export function meetHand(p0: V3, p1: V3, h: HandPlate, reach: number, dt: number): HandHit | null {
  const a = { x: p0.x + h.v.x * dt, y: p0.y + h.v.y * dt, z: p0.z + h.v.z * dt };
  const q = { x: 0, y: 0, z: 0 };
  const len = Math.hypot(p1.x - a.x, p1.y - a.y, p1.z - a.z);
  const n = Math.max(1, Math.ceil(len / BLOCK.sweepStep));
  let lo = 0;
  let hi = -1;
  if (nearest(a, h, q).d <= reach) hi = 0;
  for (let i = 1; i <= n && hi < 0; i++) {
    if (nearest(at(a, p1, i / n), h, q).d <= reach) hi = i / n;
    else lo = i / n;
  }
  if (hi < 0) return null;
  if (hi > 0)
    for (let k = 0; k < BLOCK.sweepIters; k++) {
      const mid = (lo + hi) / 2;
      if (nearest(at(a, p1, mid), h, q).d <= reach) hi = mid;
      else lo = mid;
    }
  return touchAt(at(a, p1, hi), { x: p1.x - a.x, y: p1.y - a.y, z: p1.z - a.z }, h, reach, hi);
}

/**
 * The touch of a ball at `p`, going `d` (against the hand), on hand `h` (reach: its radius and half
 * the hand's thickness): the point of the hand, the normal, where on the hand. `s` is passed through.
 */
export function touchAt(p: V3, d: V3, h: HandPlate, reach: number, s = 0): HandHit & { dist: number } {
  const q = { x: 0, y: 0, z: 0 };
  const near = nearest(p, h, q);
  const off = { x: p.x - h.c.x, y: p.y - h.c.y, z: p.z - h.c.z };
  const face = dot(off, h.n) >= 0 ? 1 : -1;
  let N: V3;
  if (near.d > Number.EPSILON) N = { x: (p.x - q.x) / near.d, y: (p.y - q.y) / near.d, z: (p.z - q.z) / near.d };
  else N = { x: h.n.x * face, y: h.n.y * face, z: h.n.z * face };
  let along = near.along;
  let across = near.across;
  let depth = 0;
  // The ball's line: where its centre would go through the hand's plane. Aimed inside the hand, the
  // hand takes the ball there, square on its face, whatever touched first (the fingertips give and
  // the ball rolls onto the palm); near an edge, more and more the edge's glancing touch.
  const dn = dot(d, h.n);
  if (dn * face < 0) {
    const k = -dot(off, h.n) / dn;
    const lu = (off.x + d.x * k) * h.u.x + (off.y + d.y * k) * h.u.y + (off.z + d.z * k) * h.u.z;
    const lw = (off.x + d.x * k) * h.w.x + (off.y + d.y * k) * h.w.y + (off.z + d.z * k) * h.w.z;
    // (past the thumb, across the gap, a ball's line is still on the hands: the ball rests on both thumbs)
    // (and past the heel the arm carries on: only the fingertips and the little finger's side are edges a ball glances off)
    const inside = Math.min(lu > 0 ? h.hl - lu : h.hl + h.heel + lu, lw < 0 ? h.hw + h.gap + reach + lw : h.hw - lw);
    depth = inside;
    if (inside > 0) {
      const f = Math.min(1, inside / reach);
      const m = {
        x: N.x + (h.n.x * face - N.x) * f,
        y: N.y + (h.n.y * face - N.y) * f,
        z: N.z + (h.n.z * face - N.z) * f,
      };
      const l = Math.hypot(m.x, m.y, m.z);
      if (l > Number.EPSILON) N = { x: m.x / l, y: m.y / l, z: m.z / l };
      along = Math.max(0, (lu + h.hl) / (2 * h.hl));
      across = Math.max(-1, lw / h.hw);
    }
  }
  return { s, p, q, N, along, across, depth, plate: h, dist: near.d };
}

/**
 * The ball coming off the hand: an impulse at the touch. `mass` (kg) is how much of the arm is
 * behind the hand there, `rest` the restitution of the ball against it, `grip` the skin's
 * friction. The part of the ball's speed into the hand (at the touching point: its spin counts) is
 * turned round, `rest` of it kept, and shared with the hand by their masses; the part along the
 * hand is slowed by the grip, at most until the ball rolls, which changes its spin. Writes the
 * ball's new velocity and spin into `v` and `w`. False (and nothing changed) when the ball is
 * already leaving the hand.
 */
export function bounceOffHand(v: V3, w: V3, hit: HandHit, mass: number, rest: number, grip: number): boolean {
  const N = hit.N;
  const R = BALL.radius;
  const m = BALL.mass;
  const hv = hit.plate.v;
  // from the ball's centre to the touching point, and that point's velocity against the hand
  const r = { x: -N.x * R, y: -N.y * R, z: -N.z * R };
  const c = {
    x: v.x + (w.y * r.z - w.z * r.y) - hv.x,
    y: v.y + (w.z * r.x - w.x * r.z) - hv.y,
    z: v.z + (w.x * r.y - w.y * r.x) - hv.z,
  };
  const vn = dot(c, N);
  if (vn >= 0) return false;
  const jn = (-(1 + rest) * vn) / (1 / m + 1 / mass);
  const t = { x: c.x - vn * N.x, y: c.y - vn * N.y, z: c.z - vn * N.z };
  const slip = Math.hypot(t.x, t.y, t.z);
  // along the hand: the grip's impulse, no more than stops the slip (a rolling ball)
  const jt = slip > Number.EPSILON ? Math.min(grip * jn, slip / ((1 + INV_I_TERM) / m + 1 / mass)) : 0;
  const P = {
    x: jn * N.x - (slip > Number.EPSILON ? (jt * t.x) / slip : 0),
    y: jn * N.y - (slip > Number.EPSILON ? (jt * t.y) / slip : 0),
    z: jn * N.z - (slip > Number.EPSILON ? (jt * t.z) / slip : 0),
  };
  v.x += P.x / m;
  v.y += P.y / m;
  v.z += P.z / m;
  // spin: r x P over the moment of inertia (I = m R^2 / INV_I_TERM)
  const k = INV_I_TERM / (m * R * R);
  w.x += (r.y * P.z - r.z * P.y) * k;
  w.y += (r.z * P.x - r.x * P.z) * k;
  w.z += (r.x * P.y - r.y * P.x) * k;
  return true;
}
