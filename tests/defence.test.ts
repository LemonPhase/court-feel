import { describe, expect, it } from 'vitest';
import { AI, COURT } from '../src/config';
import { attackKind, readSpots } from '../src/ai/defence';

const W = COURT.halfWidth;
const D = AI.defence;

/**
 * Perimeter defence, in the defending team's own frame: x > 0 is our right (facing the net), z is
 * metres off the net on our side. The attack is where their hitter meets the ball: x along the
 * net, `off` metres off the net on their side.
 */
describe('perimeter defence: where each defender reads to (Mini Rally)', () => {
  it('against their outside (our right) the setter at right back digs the line: ~1 m inside the sideline, ~5.75 m deep', () => {
    const s = readSpots({ x: 4.05, off: 0.9, kind: 'pin' });
    expect(s.S!.x).toBeCloseTo(W - D.lineIn, 6);
    expect(s.S!.z).toBeCloseTo(D.digDepth, 6);
  });

  it('the libero at left back digs cross court, outside the inside blocker, and at least 1 m inside the sideline', () => {
    const s = readSpots({ x: 4.05, off: 0.9, kind: 'pin' });
    expect(s.L!.z).toBeCloseTo(D.digDepth, 6);
    expect(s.L!.x).toBeLessThan(0);
    expect(s.L!.x).toBeGreaterThanOrEqual(-(W - D.sideIn) - 1e-9);
    // outside the inside blocker's shadow: the line from the hitter past the inside hand misses the libero
    const insideHand = 4.05 - AI.middle.closeGap - D.handHalf;
    const shadowX = 4.05 + (insideHand - 4.05) * ((0.9 + D.digDepth) / 0.9);
    expect(s.L!.x).toBeLessThanOrEqual(Math.max(shadowX, -(W - D.sideIn)) + 1e-9);
  });

  it('the back-row outside plays middle back: deep, lined up on the seam of the block', () => {
    const s = readSpots({ x: 4.05, off: 0.9, kind: 'pin' });
    expect(s.OH2!.z).toBeCloseTo(D.middleBack, 6);
    // the seam is between the middle's outer hand and the pin blocker's inner hand
    const seam = (4.05 - AI.middle.closeGap + D.handHalf + (4.05 + D.shade - D.handHalf)) / 2;
    const onSeam = 4.05 + (seam - 4.05) * ((0.9 + D.middleBack) / 0.9);
    expect(s.OH2!.x).toBeCloseTo(Math.max(-D.middleBackMaxX, Math.min(D.middleBackMaxX, onSeam)), 6);
  });

  it('the off-blocker (left front) pulls off the net to ~3 m, ~3 m in from the sideline; the right front blocks', () => {
    const s = readSpots({ x: 4.05, off: 0.9, kind: 'pin' });
    expect(s.OH1).toEqual({ x: -(W - D.offIn), z: D.offOff });
    expect(s.OPP).toBeNull();
  });

  it('against their opposite (our left) it mirrors: the libero digs the line, the setter the cross, the right front pulls off', () => {
    const s = readSpots({ x: -4.0, off: 0.9, kind: 'pin' });
    expect(s.L!.x).toBeCloseTo(-(W - D.lineIn), 6);
    expect(s.S!.x).toBeGreaterThan(0);
    expect(s.OPP).toEqual({ x: W - D.offIn, z: D.offOff });
    expect(s.OH1).toBeNull();
  });

  it('against the quick nobody has time to move: the wings stay at the net, the middle back cheats up', () => {
    const s = readSpots({ x: -0.2, off: 0.75, kind: 'middle' });
    expect(s.OH1).toBeNull();
    expect(s.OPP).toBeNull();
    expect(s.OH2!.z).toBeCloseTo(D.quickMiddleBack, 6);
    expect(s.OH2!.z).toBeLessThan(D.middleBack);
  });

  it('against a pipe the back row steps in and forward, and both wings pull off the net', () => {
    const pin = readSpots({ x: 4.05, off: 0.9, kind: 'pin' });
    const s = readSpots({ x: -0.4, off: 2.0, kind: 'back' });
    expect(Math.abs(s.S!.x)).toBeLessThan(Math.abs(pin.S!.x));
    expect(s.S!.z).toBeLessThan(pin.S!.z);
    expect(Math.abs(s.L!.x)).toBeLessThan(W - D.lineIn);
    expect(s.OH1!.z).toBeCloseTo(D.offOff, 6);
    expect(s.OPP!.z).toBeCloseTo(D.offOff, 6);
  });

  it('a set is read as a pin attack outside the middle third, a back-row attack well off the net, else a middle attack', () => {
    expect(attackKind(4.0, 0.9)).toBe('pin');
    expect(attackKind(-3.9, 3.5)).toBe('pin');
    expect(attackKind(-0.4, 2.0)).toBe('back');
    expect(attackKind(0.2, 0.75)).toBe('middle');
  });
});
