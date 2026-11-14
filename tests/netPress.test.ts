import { describe, expect, it } from 'vitest';
import { BALL, COURT } from '../src/config';
import { netPress } from '../src/world/netPress';

describe('the drawn net goes with the ball', () => {
  const top = COURT.netHeightMen;
  const out = { x: 0, y: 0, push: 0 };

  it('the mesh is pushed as far as the ball has sunk into it, away from the side the ball is on', () => {
    // sunk as deep as the net lets it, from the home side (+z)
    const z = BALL.radius - BALL.netGive;
    const p = netPress({ x: 1.2, y: top - 0.5, z }, top, out)!;
    expect(p.push).toBeCloseTo(-BALL.netGive, 6);
    expect(p.x).toBe(1.2);
    expect(p.y).toBeCloseTo(0, 6);
    // and from the other side it goes the other way
    expect(netPress({ x: 1.2, y: top - 0.5, z: -z }, top, out)!.push).toBeCloseTo(BALL.netGive, 6);
  });

  it('a ball just touching the mesh hardly moves it', () => {
    expect(Math.abs(netPress({ x: 0, y: top - 0.3, z: BALL.radius - 0.001 }, top, out)!.push)).toBeCloseTo(0.001, 6);
  });

  it('a ball over the tape, under the net, past its ends or clear of it presses nothing', () => {
    expect(netPress({ x: 0, y: top + 0.05, z: 0.02 }, top, out)).toBeNull();
    expect(netPress({ x: 0, y: top - COURT.netDepth - 0.05, z: 0.02 }, top, out)).toBeNull();
    expect(netPress({ x: COURT.netHalfLength + 0.1, y: top - 0.5, z: 0.02 }, top, out)).toBeNull();
    expect(netPress({ x: 0, y: top - 0.5, z: BALL.radius + 0.01 }, top, out)).toBeNull();
  });
});
