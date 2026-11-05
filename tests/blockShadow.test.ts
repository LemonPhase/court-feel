import { describe, expect, it } from 'vitest';
import { COURT } from '../src/config';
import { blockShadow, blockShadowOnCourt, clipPoly, inShadow, mergeSpans } from '../src/game/blockShadow';

const handsTop = COURT.netHeightMen + 0.5;
// an outside hitter's contact: high and a step off the net on the +z side
const contact = { x: -4.0, y: 3.3, z: 0.9 };
const pin = { x0: -4.5, x1: -3.5 };

describe('block shadow', () => {
  it('a single blocker casts one wedge that widens away from the net and stops where the ball clears the hands', () => {
    const q = blockShadow(contact, [pin], handsTop);
    expect(q).toHaveLength(1);
    const s = q[0];
    expect(s.nearX0).toBeCloseTo(-4.5);
    expect(s.nearX1).toBeCloseTo(-3.5);
    expect(s.farX1 - s.farX0).toBeGreaterThan(s.nearX1 - s.nearX0);
    expect(s.farZ).toBeLessThan(-3);
    expect(s.farZ).toBeGreaterThan(-COURT.halfLength);
  });

  it('a ball straight over the hands is blocked, a deep ball or a cross-court ball is not', () => {
    // short, straight down the line behind the blocker: through the hands
    expect(inShadow(contact, [pin], handsTop, -4.0, -3.0)).toBe(true);
    // deep down the line: over the top of the hands
    expect(inShadow(contact, [pin], handsTop, -4.0, -8.5)).toBe(false);
    // cross court: around the hands
    expect(inShadow(contact, [pin], handsTop, 3.5, -6.0)).toBe(false);
  });

  it('a closed double block is one wall; a seam between two blockers stays open', () => {
    const closed = mergeSpans([pin, { x0: -3.55, x1: -2.55 }]);
    expect(closed).toHaveLength(1);
    expect(closed[0].x0).toBeCloseTo(-4.5);
    expect(closed[0].x1).toBeCloseTo(-2.55);
    const open = blockShadow(contact, [pin, { x0: -2.0, x1: -1.0 }], handsTop);
    expect(open).toHaveLength(2);
    // the seam between them is hittable (this ball crosses the net at x ≈ -2.85)
    expect(inShadow(contact, [pin, { x0: -2.0, x1: -1.0 }], handsTop, -0.3, -2.0)).toBe(false);
  });

  it('no shadow when the contact is below the hands or on the wrong side of the net', () => {
    expect(blockShadow({ x: -4, y: 2.5, z: 0.9 }, [pin], handsTop)).toHaveLength(0);
    expect(blockShadow({ x: -4, y: 3.3, z: -0.9 }, [pin], handsTop)).toHaveLength(0);
  });

  it('on the court it is clipped to the opponent half and never reaches the free zone', () => {
    const polys = blockShadowOnCourt(contact, [pin], handsTop, COURT.halfWidth, COURT.halfLength);
    expect(polys.length).toBeGreaterThan(0);
    for (const poly of polys) {
      expect(poly.length).toBeGreaterThanOrEqual(3);
      expect(poly.length).toBeLessThanOrEqual(8);
      for (const [x, z] of poly) {
        expect(Math.abs(x)).toBeLessThanOrEqual(COURT.halfWidth + 1e-9);
        expect(z).toBeLessThanOrEqual(1e-9);
        expect(z).toBeGreaterThanOrEqual(-COURT.halfLength - 1e-9);
      }
    }
    // a square fully inside is untouched; one hanging over the sideline gets cut at it
    expect(
      clipPoly(
        [
          [0, -1],
          [1, -1],
          [1, -2],
          [0, -2],
        ],
        -4.5,
        4.5,
        -9,
        0,
      ),
    ).toHaveLength(4);
    expect(
      clipPoly(
        [
          [4, -1],
          [6, -1],
          [6, -3],
          [4, -3],
        ],
        -4.5,
        4.5,
        -9,
        0,
      ),
    ).toEqual([
      [4, -1],
      [4.5, -1],
      [4.5, -3],
      [4, -3],
    ]);
  });
});
