import { AI, COURT } from '../config';
import type { V3 } from '../physics/ball';
import { blockShadowOnCourt, HANDS_WIDTH, type FloorPoly, type HandSpan } from './blockShadow';

/**
 * The Spike Drill's block, planned (pure, no scene): which side it takes, where its blockers start
 * and end up, and which target zones it leaves open.
 */

/** the side a block takes away from the hitter: the line (towards the sideline) or the cross */
export type BlockTakes = 'line' | 'cross';

/** a floor rectangle on their side (z < 0) */
export interface FloorRect {
  x0: number;
  x1: number;
  z0: number;
  z1: number;
}

export interface BlockPlan {
  /** the blocker in front of the hitter: where it starts, where it ends up, and whether it holds (formed early) or reads the set */
  pin: { start: number; end: number; hold: boolean };
  /**
   * The middle closing next to it (a double block only). `late` on fast sets: it starts away from its
   * spot (`end`) and is still arriving when you swing, at `at`; otherwise `at` is its spot.
   */
  middle: { start: number; end: number; at: number; hold: boolean; late: boolean } | null;
}

const clamp = (v: number, a: number, b: number) => Math.min(b, Math.max(a, v));

/**
 * Where the block stands for an attack at `contactX` (along the net). On a pin set the block is formed
 * before the set and holds; on an inside set (`inside`: a quick, a 3 ball, an attack on two, a pipe) the
 * pin blocker starts at its usual spot (`normalX`) and moves after the set. A double block's middle closes
 * next to the pin blocker on the inside: formed early on a high ball, late on a fast set (`fast`).
 */
export function blockPlan(
  contactX: number,
  takes: BlockTakes,
  level: 1 | 2,
  opts: { inside: boolean; fast: boolean; normalX: number },
): BlockPlan {
  const B = AI.drillBlock;
  // the hitter's line is the sideline on their side of the court
  const s = Math.sign(contactX) || -1;
  const lim = COURT.halfWidth - 0.1;
  const end = clamp(contactX + s * (takes === 'line' ? B.takeShift : -B.takeShift), -lim, lim);
  const pin = { start: opts.inside ? opts.normalX : end, end, hold: !opts.inside };
  if (level < 2) return { pin, middle: null };
  const mEnd = clamp(end - s * B.closeGap, -lim, lim);
  if (!opts.fast) return { pin, middle: { start: mEnd, end: mEnd, at: mEnd, hold: true, late: false } };
  const start = mEnd * B.fastStart;
  return { pin, middle: { start, end: mEnd, at: mEnd + (start - mEnd) * B.arriveShort, hold: false, late: true } };
}

/** the block's hands when you swing (a late middle still arriving), `margin` (m) wider on each side */
export function planSpans(p: BlockPlan, margin = 0): HandSpan[] {
  const xs = [p.pin.end, ...(p.middle ? [p.middle.at] : [])];
  const half = HANDS_WIDTH / 2 + margin;
  return xs.map((x) => ({ x0: x - half, x1: x + half }));
}

function inPoly(x: number, z: number, poly: FloorPoly): boolean {
  let inside = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const [xi, zi] = poly[i];
    const [xj, zj] = poly[j];
    if (zi > z !== zj > z && x < ((xj - xi) * (z - zi)) / (zj - zi) + xi) inside = !inside;
  }
  return inside;
}

/** how much of a floor rectangle the shadow covers (0 to 1, sampled on an n × n grid) */
export function coveredFraction(r: FloorRect, polys: FloorPoly[], n = 6): number {
  let hit = 0;
  for (let i = 0; i < n; i++)
    for (let j = 0; j < n; j++) {
      const x = r.x0 + ((i + 0.5) / n) * (r.x1 - r.x0);
      const z = r.z0 + ((j + 0.5) / n) * (r.z1 - r.z0);
      if (polys.some((p) => inPoly(x, z, p))) hit++;
    }
  return hit / (n * n);
}

/**
 * A target zone the block leaves open: one it covers less than `AI.drillBlock.openFrac` of, from a
 * hitter at `contact` (the least covered one if none is open). `avoid` (the last target) is skipped
 * when another open zone is left.
 */
export function openZone<Z extends FloorRect>(
  zones: Z[],
  contact: V3,
  spans: HandSpan[],
  handsTop: number,
  rand: () => number,
  avoid?: Z,
): Z {
  const polys = blockShadowOnCourt(contact, spans, handsTop, COURT.halfWidth, COURT.halfLength);
  const cover = zones.map((z) => coveredFraction(z, polys));
  let open = zones.filter((_, i) => cover[i] < AI.drillBlock.openFrac);
  if (open.length > 1 && avoid) open = open.filter((z) => z !== avoid);
  if (open.length) return open[Math.floor(rand() * open.length) % open.length];
  return zones[cover.indexOf(Math.min(...cover))];
}
