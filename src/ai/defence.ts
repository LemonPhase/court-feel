import { AI, COURT } from '../config';
import { clamp } from '../core/mathx';

/**
 * Perimeter defence: where each defender reads to as the other team's set flies. Everything is in
 * the defending team's own frame: x > 0 is our right (facing the net), z is metres off the net on
 * our side. Back row: the setter plays right back, the libero left back, the back-row outside
 * middle back. Sources and the inferred numbers: AI-movement notes, section 9.
 */

/** where their hitter meets the ball: x along the net (our frame), `off` metres off the net on their side */
export interface Attack {
  x: number;
  off: number;
  kind: AttackKind;
}
export type AttackKind = 'pin' | 'middle' | 'back';
export type Spot = { x: number; z: number };
/** the defenders' read spots by team slot; null: a front-row player blocks, a back-row player holds its base */
export type ReadSpots = Record<'S' | 'L' | 'OH2' | 'OH1' | 'OPP', Spot | null>;

/** a pin attack outside the middle of the net (a back-row one from zone 1 or 5 too); a back-row attack well off the net; else a middle attack (the quick, an inside ball) */
export function attackKind(x: number, off: number): AttackKind {
  const D = AI.defence;
  if (Math.abs(x) > D.pinX) return 'pin';
  return off > D.backOff ? 'back' : 'middle';
}

export function readSpots(a: Attack): ReadSpots {
  const D = AI.defence;
  const W = COURT.halfWidth;
  if (a.kind === 'middle') {
    // the quick: no time to move. The corners hold their base, the wings stay at the net to help the
    // middle, the middle back cheats up
    return { S: null, L: null, OH2: { x: 0, z: D.quickMiddleBack }, OH1: null, OPP: null };
  }
  if (a.kind === 'back') {
    // a pipe: the middle blocks, both wings pull off, the back row steps into the court and forward
    return {
      S: { x: D.pipeCornerX, z: D.pipeCornerZ },
      L: { x: -D.pipeCornerX, z: D.pipeCornerZ },
      OH2: { x: 0, z: D.pipeMiddleBack },
      OH1: { x: -(W - D.offIn), z: D.offOff },
      OPP: { x: W - D.offIn, z: D.offOff },
    };
  }
  // a pin attack on our right (r = 1) or left (r = -1): the pin blocker shades the line, the middle closes inside
  const r = a.x >= 0 ? 1 : -1;
  const pinBlocker = a.x + r * D.shade;
  const middle = pinBlocker - r * AI.middle.closeGap;
  const insideHand = middle - r * D.handHalf;
  const seam = (middle + r * D.handHalf + pinBlocker - r * D.handHalf) / 2;
  // where a straight ball from the hitter past `xNet` (at the net) is, `depth` m into our court
  const along = (xNet: number, depth: number) => a.x + (xNet - a.x) * ((a.off + depth) / Math.max(0.3, a.off));
  const line: Spot = { x: r * (W - D.lineIn), z: D.digDepth };
  const crossX = clamp(along(insideHand, D.digDepth) - r * D.crossOutside, -(W - D.sideIn), W - D.sideIn);
  const cross: Spot = { x: crossX, z: D.digDepth };
  // the middle back plays deep, at the end line: on the seam if the block leaves one (shallower, at
  // middleBackSeam), else beside the block's inside edge, towards the cross (a closed block's shadow
  // is no place to stand)
  const seamWidth = Math.abs(pinBlocker - middle) - 2 * D.handHalf;
  const mbX = seamWidth > 0 ? along(seam, D.middleBackSeam) : insideHand - r * D.middleBackCross;
  const middleBack: Spot = { x: clamp(mbX, -D.middleBackMaxX, D.middleBackMaxX), z: seamWidth > 0 ? D.middleBackSeam : D.middleBack };
  const off: Spot = { x: -r * (W - D.offIn), z: D.offOff };
  return {
    S: r > 0 ? line : cross,
    L: r > 0 ? cross : line,
    OH2: middleBack,
    OH1: r > 0 ? off : null,
    OPP: r > 0 ? null : off,
  };
}

/**
 * Where the middle back steps up to when our block actually leaves a seam: the seam's line at
 * `middleBackSeam` (a ball through a seam is a hard, straight ball that lands shorter than a deep
 * cross shot over a closed block — MatusGib, 2026-11-10). `a` is the attack and `pinX` / `midX` the
 * two blockers' actual x at the net, all in the defending team's frame. Null when the block is closed
 * (the middle back stays deep, cross, as `readSpots` placed it).
 */
export function seamSpot(a: Attack, pinX: number, midX: number): Spot | null {
  const D = AI.defence;
  if (Math.abs(pinX - midX) - 2 * D.handHalf <= 0) return null;
  const along = (xNet: number, depth: number) => a.x + (xNet - a.x) * ((a.off + depth) / Math.max(0.3, a.off));
  const seam = (pinX + midX) / 2;
  return { x: clamp(along(seam, D.middleBackSeam), -D.middleBackMaxX, D.middleBackMaxX), z: D.middleBackSeam };
}
