import { BALL, CONTACT } from '../config';
import type { V3 } from '../physics/ball';

/** a blocker's hands along the net: x span [x0, x1] */
export interface HandSpan {
  x0: number;
  x1: number;
}

/** a floor quad: near edge at the net (z = 0) and a far edge, x ranges on each */
export interface ShadowQuad {
  nearX0: number;
  nearX1: number;
  farX0: number;
  farX1: number;
  farZ: number;
}

/** a floor polygon as [x, z] points (counter-clockwise seen from above is not required) */
export type FloorPoly = [number, number][];

/** width of one blocker's hands along the net: the contact volume a ball centre can be blocked in */
export const HANDS_WIDTH = 2 * (CONTACT.blockHalfWidth + BALL.radius);

/** merge spans that touch or overlap (a closed double block is one wall) */
export function mergeSpans(spans: HandSpan[], gap = 0.15): HandSpan[] {
  const s = spans.map((x) => ({ ...x })).sort((a, b) => a.x0 - b.x0);
  const out: HandSpan[] = [];
  for (const x of s) {
    const last = out[out.length - 1];
    if (last && x.x0 <= last.x1 + gap) last.x1 = Math.max(last.x1, x.x1);
    else out.push(x);
  }
  return out;
}

/**
 * The part of the opponent floor a hitter cannot reach with a straight ball
 * from `contact`: lines from the contact point through the blockers' hands
 * (top at `handsTop`, at the net z = 0). Beyond `farZ` the ball clears the
 * hands, so the shadow stops there; a ball landing deeper went over the block.
 * The contact must be above the hands and on the +z side of the net.
 */
export function blockShadow(contact: V3, spans: HandSpan[], handsTop: number, maxDepth = 9.5): ShadowQuad[] {
  const cz = contact.z;
  const cy = contact.y;
  if (cz <= 0.05 || cy <= handsTop + 0.05) return [];
  // the line clears the hands' top when it crosses the net higher than handsTop:
  // y at the net = cy * (1 - f) with f = cz / (cz - pz)  =>  pz >= cz * (1 - 1 / (1 - handsTop / cy))
  const fMin = 1 - handsTop / cy;
  let farZ = cz * (1 - 1 / fMin);
  farZ = Math.max(farZ, -maxDepth);
  const f = cz / (cz - farZ);
  return mergeSpans(spans).map((s) => ({
    nearX0: s.x0,
    nearX1: s.x1,
    farX0: contact.x + (s.x0 - contact.x) / f,
    farX1: contact.x + (s.x1 - contact.x) / f,
    farZ,
  }));
}

/** would a ball from `contact` to floor point (px, pz) pass through the hands? */
export function inShadow(contact: V3, spans: HandSpan[], handsTop: number, px: number, pz: number): boolean {
  const cz = contact.z;
  if (cz <= 0.05 || pz >= 0) return false;
  const f = cz / (cz - pz);
  const xNet = contact.x + (px - contact.x) * f;
  const yNet = contact.y * (1 - f);
  if (yNet > handsTop) return false;
  return mergeSpans(spans).some((s) => xNet >= s.x0 && xNet <= s.x1);
}

/** Sutherland–Hodgman clip of a convex floor polygon to the axis-aligned box */
export function clipPoly(poly: FloorPoly, xMin: number, xMax: number, zMin: number, zMax: number): FloorPoly {
  type Edge = (p: [number, number]) => number; // >= 0 inside
  const edges: Edge[] = [(p) => p[0] - xMin, (p) => xMax - p[0], (p) => p[1] - zMin, (p) => zMax - p[1]];
  let out = poly;
  for (const inside of edges) {
    const input = out;
    out = [];
    if (!input.length) break;
    for (let i = 0; i < input.length; i++) {
      const cur = input[i];
      const prev = input[(i + input.length - 1) % input.length];
      const dc = inside(cur);
      const dp = inside(prev);
      if (dc >= 0) {
        if (dp < 0) out.push(lerpPt(prev, cur, dp / (dp - dc)));
        out.push(cur);
      } else if (dp >= 0) out.push(lerpPt(prev, cur, dp / (dp - dc)));
    }
  }
  return out;
}

function lerpPt(a: [number, number], b: [number, number], u: number): [number, number] {
  return [a[0] + (b[0] - a[0]) * u, a[1] + (b[1] - a[1]) * u];
}

/** the shadow quads clipped to the opponent court (x within ±halfWidth, z from the net to the end line) */
export function blockShadowOnCourt(contact: V3, spans: HandSpan[], handsTop: number, halfWidth: number, halfLength: number): FloorPoly[] {
  return blockShadow(contact, spans, handsTop, halfLength + 0.5)
    .map((q) =>
      clipPoly(
        [
          [q.nearX0, 0],
          [q.nearX1, 0],
          [q.farX1, q.farZ],
          [q.farX0, q.farZ],
        ],
        -halfWidth,
        halfWidth,
        -halfLength,
        0,
      ),
    )
    .filter((p) => p.length >= 3);
}
