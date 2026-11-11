import { AI, PLAYER } from '../config';
import { clamp } from '../core/mathx';
import type { Athlete } from '../game/athlete';

/** a team-mate, and whether they keep their line (playing the ball, or the user) */
export interface Mate {
  athlete: Athlete;
  firm: boolean;
}

/** the side each player picked to pass each team-mate on, kept until they are clear (no dithering) */
const sides = new WeakMap<Athlete, WeakMap<Athlete, 1 | -1>>();

/**
 * Steer `a` (walking to a spot) around its team-mates: for each, look ahead along both paths (its
 * command at its own top speed, their actual velocity) to where they come closest, and if that is
 * closer than `AI.giveWay.room`, step off their path to one side, the same side until they are
 * clear. A team-mate who keeps their line gets all the room; two walkers share it, and head-on they
 * both pass on the right. Only the command changes: the athlete's own kinematics still decide how
 * fast it can sidestep. Giving way is by priority, not by collisions: athletes still don't collide
 * physically, so whoever plays the ball (or is committed to an approach or a jump) never gets bumped.
 */
export function giveWay(a: Athlete, mates: readonly Mate[]): void {
  if (a.state !== 'ground' && a.state !== 'land') return;
  const G = AI.giveWay;
  let mine = sides.get(a);
  if (!mine) sides.set(a, (mine = new WeakMap()));
  const top = a.cmd.sprint ? a.stats.approachSpeed : a.stats.shuffleSpeed;
  const wx = a.cmd.moveX * top;
  const wz = a.cmd.moveZ * top;
  let sx = 0;
  let sz = 0;
  let wsum = 0;
  for (const m of mates) {
    const o = m.athlete;
    if (o === a) continue;
    // their position and velocity relative to where we are going
    const rx = o.pos.x - a.pos.x;
    const rz = o.pos.z - a.pos.z;
    const vx = o.vel.x - wx;
    const vz = o.vel.z - wz;
    const v = Math.hypot(vx, vz);
    const t = v > 1e-3 ? clamp(-(rx * vx + rz * vz) / (v * v), 0, G.ahead) : 0;
    const cx = rx + vx * t;
    const cz = rz + vz * t;
    const d = Math.hypot(cx, cz);
    if (d >= G.room) {
      mine.delete(o);
      continue;
    }
    let ax: number;
    let az: number;
    if (v > 1e-3) {
      // off their path, to one side: away from where they will be, or to the right of our way
      const px = -vz / v;
      const pz = vx / v;
      let side = mine.get(o);
      if (side === undefined) {
        const away = -(cx * px + cz * pz);
        side = Math.abs(away) > 1e-3 ? (away > 0 ? 1 : -1) : 1;
        mine.set(o, side);
      }
      ax = px * side;
      az = pz * side;
    } else {
      // neither going anywhere: just step apart
      const n = Math.hypot(rx, rz) || 1;
      ax = -rx / n;
      az = -rz / n;
    }
    // the nearer and the sooner, the harder; a walker coming the other way takes half
    const w = ((G.room - d) / G.room) * (1 - (0.5 * t) / G.ahead) * (m.firm ? 1 : 0.5);
    sx += ax * w;
    sz += az * w;
    wsum += w;
  }
  if (wsum === 0) return;
  // while giving way the spot can wait: the step aside comes first, the way back after
  const keep = Math.max(0, 1 - 2 * wsum);
  let mx = a.cmd.moveX * keep + sx * G.push;
  let mz = a.cmd.moveZ * keep + sz * G.push;
  // and never walk into someone at arm's length: drop the part of the step that heads at them
  for (const m of mates) {
    const o = m.athlete;
    const rx = o.pos.x - a.pos.x;
    const rz = o.pos.z - a.pos.z;
    const dn = Math.hypot(rx, rz);
    if (o === a || dn >= G.touch || dn < 1e-6) continue;
    const at = (mx * rx + mz * rz) / dn;
    if (at <= 0) continue;
    mx -= (rx / dn) * at;
    mz -= (rz / dn) * at;
  }
  const len = Math.hypot(mx, mz);
  if (len > 1) {
    mx /= len;
    mz /= len;
  }
  a.cmd.moveX = mx;
  a.cmd.moveZ = mz;
}

/**
 * Team-mates at the net (one of them in the air: a block, a quick) don't pass through each other:
 * a player moving into another stops at their shoulder (`PLAYER.shoulder`), the other holds. A
 * closing middle drifts into the seam and stops against its pin blocker. Applies to the user too.
 */
export function shoulderToShoulder(players: readonly Athlete[]): void {
  const S = PLAYER.shoulder;
  for (let i = 0; i < players.length; i++)
    for (let j = i + 1; j < players.length; j++) {
      const a = players[i];
      const b = players[j];
      if (Math.abs(a.pos.z) > 1.5 || Math.abs(b.pos.z) > 1.5) continue;
      if (a.state !== 'air' && b.state !== 'air') continue;
      const dx = b.pos.x - a.pos.x;
      if (Math.abs(dx) >= S || Math.abs(a.pos.z - b.pos.z) >= S) continue;
      const dir = dx >= 0 ? 1 : -1;
      // who is closing: the one moving towards the other faster stops at the shoulder
      const va = a.vel.x * dir;
      const vb = -b.vel.x * dir;
      const mover = va >= vb ? a : b;
      const other = mover === a ? b : a;
      const side = mover === a ? -dir : dir;
      mover.pos.x = other.pos.x + side * S;
      // still moving into them: it moves with them now (no further)
      if ((other.vel.x - mover.vel.x) * side > 0) mover.vel.x = other.vel.x;
    }
}
