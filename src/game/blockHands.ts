import { BALL, BLOCK, CONTACT, TIMING } from '../config';
import { clamp, clamp01, invLerp, lerp, smooth01, smoothstep } from '../core/mathx';
import type { V3 } from '../physics/ball';
import type { HandHit, HandPlate } from '../physics/handContact';
import type { Action, Athlete } from './athlete';
import type { Touch } from './ballEntity';
import { dimsFor } from './proportions';

/**
 * Where a blocker's hands are (`BLOCK`): two plates on the ends of arms that pivot at the
 * shoulders. Arms straight up, the fingertips are at the standing reach; pressing, the arms lean
 * over the net and the wrists turn the palms down to the hitter's floor, with the torso leaning in.
 * The press comes with the jump (none low in it, all of it at the top), never takes an arm under
 * the tape, and costs height. The hands face the line the ball comes in on, and a pin blocker
 * turns its outside hand in. The simulation's hands: what is drawn follows them.
 */

export interface BlockHand extends HandPlate {
  /** how firm the hand is: the share of the arm behind it (the jump, the arms still going up, the AI's skill) */
  firm: number;
  /** a forearm, not a hand: the ball met the block under the hands */
  arm: boolean;
  /** from this far out across the hand (0 the middle, 1 the little finger's edge) it gives like fingers (`BLOCK.edgeFrom`) */
  edgeFrom: number;
}

export interface HandsContext {
  netTop: number;
  /** aim assist (`ASSIST`): the hands reach a little wider */
  assist?: number;
  /** the ball as the blocker sees it come (the hands turn to where it came from when the attacker is not known) */
  ballVel?: V3 | null;
  /** the attack being blocked: an AI blocks the user's attack and one off the user's green set differently (`BLOCK.ai`) */
  attack?: Touch | null;
}

const UP: V3 = { x: 0, y: 1, z: 0 };
const add = (a: V3, b: V3, k: number): V3 => ({ x: a.x + b.x * k, y: a.y + b.y * k, z: a.z + b.z * k });
const cross = (a: V3, b: V3): V3 => ({ x: a.y * b.z - a.z * b.y, y: a.z * b.x - a.x * b.z, z: a.x * b.y - a.y * b.x });
/** `a` turned by `ang` about the unit axis `k` (which `a` is square to) */
const turn = (a: V3, k: V3, ang: number): V3 =>
  add({ x: a.x * Math.cos(ang), y: a.y * Math.cos(ang), z: a.z * Math.cos(ang) }, cross(k, a), Math.sin(ang));

/**
 * the hands' facing along the floor: straight at the net, turned toward the attacker (where the ball
 * was hit from: the attacking athlete, or back up the ball's line when there is none), a share of
 * the way. A blocker squares to the hitter's arm, not to wherever the ball is going.
 */
function facing(a: Athlete, ctx: HandsContext, k: number): V3 {
  const f = { x: 0, y: 0, z: -a.side };
  if (k <= 0) return f;
  const from = ctx.attack?.athlete?.pos;
  const bv = ctx.ballVel;
  let dx: number;
  let dz: number;
  if (from && from.z * a.side < 0) {
    dx = from.x - (a.pos.x + a.reachX);
    dz = from.z - a.pos.z;
  } else if (bv && bv.z * a.side > 0) {
    dx = -bv.x;
    dz = -bv.z;
  } else return f;
  const len = Math.hypot(dx, dz);
  if (len <= Number.EPSILON) return f;
  dx /= len;
  dz /= len;
  const ang = clamp(Math.atan2(f.x * dz - f.z * dx, f.x * dx + f.z * dz) * k, -BLOCK.faceMax, BLOCK.faceMax);
  return { x: f.x * Math.cos(ang) - f.z * Math.sin(ang), y: 0, z: f.x * Math.sin(ang) + f.z * Math.cos(ang) };
}

/**
 * How far into its press a blocker is (0 to 1): none until the arms are up and the jump is
 * `BLOCK.pressFrom` of the way up, all of it at the top (the shoulders' lean, the arms' angle over
 * the net and the wrists' all go with it). The drawn body leans with it.
 */
export function blockPress(a: Athlete, act: Action, t: number): number {
  if (a.state !== 'air' || a.jumpH <= 0) return 0;
  const ext = smooth01((t - act.t0) / TIMING.blockArmTime);
  return smooth01((clamp01(a.pos.y / a.jumpH) - BLOCK.pressFrom) / (1 - BLOCK.pressFrom)) * ext;
}

/** the hands of a blocker `a` in its block action `act` at `t`: none until the arms are up */
export function handPlates(a: Athlete, act: Action, t: number, ctx: HandsContext): BlockHand[] {
  const ext = smooth01((t - act.t0) / TIMING.blockArmTime);
  if (ext < BLOCK.armsUp) return [];
  const d = dimsFor(a.height);
  const arm = d.upperArm + d.foreArm;
  const hand = d.hand;
  const air = a.state === 'air' && a.jumpH > 0;
  const lt = ctx.attack ?? null;
  const ai = !a.isUser;
  // an AI block beaten by the user's green set: hands up, not set
  const beaten = ai && lt?.green === true ? BLOCK.ai.green : 1;
  const press = blockPress(a, act, t) * beaten;
  const vsUser = ai && lt?.athlete?.isUser === true;
  const firm = (air ? 1 : BLOCK.floorFirm) * ext * (ai ? BLOCK.ai.firm : 1) * (vsUser ? BLOCK.ai.userFirm : 1) * beaten;
  const h = facing(a, ctx, BLOCK.face * beaten);
  const side: V3 = { x: -h.z, y: 0, z: h.x };
  const handsX = a.pos.x + a.reachX;
  const top = a.pos.y + a.standReach + BLOCK.reachTop - Math.abs(a.reachX) * CONTACT.blockReachDrop;
  const S = add({ x: handsX, y: top - arm - hand, z: a.pos.z }, h, BLOCK.lean * press);
  const clear = ctx.netTop + BLOCK.tapeClear;
  const chain = (k: number) => {
    const phi = BLOCK.press * press * k;
    const th = phi + BLOCK.wrist * press * k;
    const W = add(S, add({ x: h.x * Math.sin(phi), y: 0, z: h.z * Math.sin(phi) }, UP, Math.cos(phi)), arm);
    const u = add({ x: h.x * Math.sin(th), y: 0, z: h.z * Math.sin(th) }, UP, Math.cos(th));
    return { W, u, th, T: add(W, u, hand) };
  };
  // no arm under the tape: where the arm or the hand crosses the net's plane it is over the tape
  const clears = (k: number) => {
    const { W, T } = chain(k);
    for (const [p, q] of [
      [S, W],
      [W, T],
    ] as [V3, V3][]) {
      if (p.z * a.side <= 0 || q.z * a.side > 0) continue;
      const f = p.z / (p.z - q.z);
      if (p.y + (q.y - p.y) * f < clear) return false;
    }
    return true;
  };
  let k = 1;
  if (S.z * a.side > 0 && !clears(1)) {
    let lo = 0;
    let hi = 1;
    for (let i = 0; i < BLOCK.sweepIters; i++) {
      const mid = (lo + hi) / 2;
      if (clears(mid)) lo = mid;
      else hi = mid;
    }
    k = lo;
  }
  const { W, u, th } = chain(k);
  const n = add({ x: h.x * Math.cos(th), y: 0, z: h.z * Math.cos(th) }, UP, -Math.sin(th));
  const hw = BLOCK.handWidth / 2 + (ctx.assist ?? 0) * BLOCK.assistWiden;
  const off = BLOCK.thumbGap / 2 + hw;
  // the outside hand of a pin blocker turns in (a turn of the forearm, about `u`)
  const pin = smoothstep(BLOCK.pinTurn[0], BLOCK.pinTurn[1], Math.abs(handsX));
  const turnIn = BLOCK.turnIn * pin * ext * (ai ? BLOCK.ai.turnIn : 1) * (vsUser ? BLOCK.ai.userTurnIn : 1) * beaten;
  const out: BlockHand[] = [];
  const dArm = add(
    { x: h.x * Math.sin(BLOCK.press * press * k), y: 0, z: h.z * Math.sin(BLOCK.press * press * k) },
    UP,
    Math.cos(BLOCK.press * press * k),
  );
  const nArm = add(
    { x: h.x * Math.cos(BLOCK.press * press * k), y: 0, z: h.z * Math.cos(BLOCK.press * press * k) },
    UP,
    -Math.sin(BLOCK.press * press * k),
  );
  const v = { x: a.vel.x, y: a.vel.y, z: a.vel.z };
  for (const i of [-1, 1]) {
    const wrist = add(W, side, i * off);
    // across each hand, + is out, toward its little finger; the thumbs face each other
    const outward = { x: side.x * i, y: 0, z: side.z * i };
    const outer = Math.sign(side.x * i) === Math.sign(handsX) && handsX !== 0;
    let nn = n;
    let ww = outward;
    if (outer && turnIn !== 0) {
      // toward the middle of the court: the way that takes the palm's facing off the antenna
      const sgn = cross(u, n).x * Math.sign(handsX) > 0 ? -1 : 1;
      nn = turn(n, u, sgn * turnIn);
      ww = turn(outward, u, sgn * turnIn);
    }
    // (each hand and each forearm its own: two of each an athlete)
    const id = (a.id * 2 + (i > 0 ? 1 : 0)) * 2;
    // (against your attack an AI's outside hand is not sealed: open and not spread as wide, `BLOCK.ai`)
    const hwi = outer && vsUser ? hw * BLOCK.ai.userWidth : hw;
    out.push({
      c: add(add(wrist, u, hand / 2), outward, hwi - hw),
      n: nn,
      u,
      w: ww,
      hl: hand / 2,
      hw: hwi,
      gap: BLOCK.thumbGap,
      heel: d.foreArm,
      tip: add(wrist, u, hand),
      v,
      id,
      firm,
      arm: false,
      edgeFrom: BLOCK.edgeFrom,
    });
    // the forearm under it, from the elbow to the wrist
    out.push({
      c: add(wrist, dArm, -d.foreArm / 2),
      n: nArm,
      u: dArm,
      w: outward,
      hl: d.foreArm / 2,
      hw: BLOCK.forearmWidth / 2,
      gap: 0,
      heel: d.upperArm,
      tip: wrist,
      v,
      id: id + 1,
      firm,
      arm: true,
      edgeFrom: BLOCK.edgeFrom,
    });
  }
  return out;
}

/**
 * How the hand gives where the ball met it (`BLOCK`): the arm's mass behind the heel, the fingers'
 * at the tips and at the little finger's edge (the thumbs are braced against each other), as firm
 * as the hand is; a forearm has the arm behind it all along. A ball that only nicks the hand (its
 * line passes outside it) has that much less of the hand behind the touch. And the ball's restitution against it:
 * less the harder it comes in, less still off the fingers.
 */
export function handGive(hit: HandHit, hand: BlockHand, impact: number): { mass: number; rest: number } {
  const ball = lerp(BLOCK.ballRest[0], BLOCK.ballRest[1], invLerp(BLOCK.ballRestSpeed[0], BLOCK.ballRestSpeed[1], impact));
  // a ball whose line passes outside the hand only nicks it with its side: the less of it on the
  // hand, the less of the hand behind the touch (none for a line a ball's radius outside)
  const thin = hit.depth < 0 ? clamp01(1 + hit.depth / (BALL.radius + BLOCK.thickness / 2)) : 1;
  if (hand.arm) return { mass: BLOCK.massArm * hand.firm * thin, rest: ball * BLOCK.restArm };
  const tips = smoothstep(BLOCK.fingers, 1, hit.along);
  const edge = smoothstep(hand.edgeFrom, 1, hit.across);
  const fingers = Math.max(tips, edge);
  const mass = lerp(BLOCK.massPalm, BLOCK.massTip, tips) * lerp(1, BLOCK.edge, edge) * hand.firm * thin;
  return { mass, rest: ball * lerp(BLOCK.restPalm, BLOCK.restTip, fingers) };
}
