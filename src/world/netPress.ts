import { BALL, COURT } from '../config';

/**
 * How far the ball is pressed into the net mesh, for drawing: the mesh is pushed as far as the
 * ball has sunk into it, away from the side the ball is on. Null when the ball is not in the mesh
 * (over the tape, under the net, past its ends, or clear of it).
 *
 * `x`, `y`: where on the net (y measured from the middle of the net's height); `push`: how far the
 * mesh is pushed along z, signed.
 */
export function netPress(
  ball: { x: number; y: number; z: number },
  netTop: number,
  out: { x: number; y: number; push: number },
): { x: number; y: number; push: number } | null {
  const depth = BALL.radius - Math.abs(ball.z);
  if (depth <= 0) return null;
  if (Math.abs(ball.x) > COURT.netHalfLength) return null;
  if (ball.y > netTop || ball.y < netTop - COURT.netDepth) return null;
  out.x = ball.x;
  out.y = ball.y - (netTop - COURT.netDepth / 2);
  out.push = (ball.z >= 0 ? -1 : 1) * depth;
  return out;
}
