import * as THREE from 'three';
import { CHARACTER } from '../config';
import { lerp, smooth01 } from '../core/mathx';
import type { Athlete, Gesture } from '../game/athlete';

/**
 * What a gesture between points (`Athlete.gesture`, set by the AI's routine) does to a body: the
 * trunk, a hop, and each arm. Drawn only: nothing here is read back by the play (decision record
 * 0008). Every number is `CHARACTER.gesture`'s.
 *
 * Arm targets are given as the animator's arm keys are: a wrist offset from the shoulder in the
 * body frame (out to the arm's own side, up, forward), in body heights, with an elbow pole; or,
 * where the hand has to be on something in the world (a team-mate's hand in a five, a shoulder
 * in the huddle, the top of a knee), a world point.
 */

type V = THREE.Vector3;

export interface HandShape {
  knuckle: number;
  mid: number;
  spread: number;
  cup: number;
  thumbOut: number;
  thumbCurl: number;
}

/** one arm's part in a gesture */
export interface ArmGesture {
  /** 0..1: how much of the arm the gesture has */
  weight: number;
  /** body-frame wrist offset (body heights) and elbow pole, or a world point for the wrist */
  w: V;
  pole: V;
  world: V | null;
  shape: HandShape;
  /** palm facing: 0 towards the body's middle, 1 forward, -1 back */
  palm: number;
  flex: number;
  /** how fast the arm follows (1/s) */
  rate: number;
}

/** the trunk's part: added to the animator's own pose */
export interface TorsoGesture {
  drop: number;
  spineX: number;
  chestX: number;
  chestY: number;
  chestZ: number;
  /** the whole body off the floor (m): a bounce, arms-up on the toes */
  hop: number;
}

/** where the animator's body is this frame, for gestures that put a hand on something */
export interface BodyNow {
  /** world: the knee on this arm's side, the body's forward and right */
  knee: V;
  fwd: V;
  right: V;
}

const SH = CHARACTER.hand;
const G = () => CHARACTER.gesture;

/** in over `inT`, out over `outT` at the end of `dur` (s since the start: `u`) */
function envelope(u: number, dur: number, inT: number, outT: number): number {
  if (u < 0) return 0;
  const i = smooth01(u / inT);
  if (!Number.isFinite(dur)) return i;
  return i * (1 - smooth01((u - (dur - outT)) / outT));
}

/** a path through keys [t (0..1), x, y, z], eased from key to key */
function track(keys: readonly (readonly number[])[], p: number, out: V): V {
  if (p <= keys[0][0]) return out.set(keys[0][1], keys[0][2], keys[0][3]);
  for (let i = 1; i < keys.length; i++) {
    const k = keys[i];
    if (p <= k[0]) {
      const j = keys[i - 1];
      const e = smooth01((p - j[0]) / (k[0] - j[0]));
      return out.set(lerp(j[1], k[1], e), lerp(j[2], k[2], e), lerp(j[3], k[3], e));
    }
  }
  const l = keys[keys.length - 1];
  return out.set(l[1], l[2], l[3]);
}

function setShape(o: HandShape, a: HandShape): HandShape {
  o.knuckle = a.knuckle;
  o.mid = a.mid;
  o.spread = a.spread;
  o.cup = a.cup;
  o.thumbOut = a.thumbOut;
  o.thumbCurl = a.thumbCurl;
  return o;
}

/** where two athletes' hands meet in a five: between them, overhead or at the hip */
export function fivePoint(a: Athlete, b: Athlete, low: boolean, out: V): V {
  const F = G().five;
  const h = (a.height + b.height) / 2;
  return out.set((a.rpos.x + b.rpos.x) / 2, h * (low ? F.low : F.high), (a.rpos.z + b.rpos.z) / 2);
}

/** the gesture is still drawn at `tr` (it eases out after its end) */
export function gestureOn(g: Gesture | null, tr: number): g is Gesture {
  return !!g && tr >= g.t0 && tr < g.t0 + g.dur + G().out;
}

/** a five: how far the hand has come up to the meeting point (0..1), then down after the slap */
function fiveWeight(g: Gesture, tr: number): number {
  const F = G().five;
  const raise = Math.max(g.meet - g.t0, F.minRaise);
  return smooth01((tr - (g.meet - raise)) / raise) * (1 - smooth01((tr - g.meet - F.hold) / F.after));
}

/** the trunk and the hop of a gesture at `tr` (an AI player's body only: your eyes ride on yours) */
export function torsoGesture(a: Athlete, g: Gesture, tr: number, H: number, out: TorsoGesture): TorsoGesture {
  out.drop = out.spineX = out.chestX = out.chestY = out.chestZ = out.hop = 0;
  const C = G();
  const u = tr - g.t0;
  const k = lerp(C.size[0], C.size[1], g.k);
  switch (g.kind) {
    case 'fist': {
      const e = envelope(u, g.dur, C.in, C.out);
      // the pull: the body crunches into it, turned to the fist's side
      const pull = smooth01((u / g.dur - C.fist.pull[0]) / (C.fist.pull[1] - C.fist.pull[0]));
      out.spineX = -C.fist.crunch * pull * e * k;
      out.chestY = g.hand * C.fist.turn * e * k;
      out.drop = C.fist.sink * H * pull * e;
      break;
    }
    case 'roar': {
      const e = envelope(u, g.dur, C.in, C.out);
      out.drop = C.roar.sink * H * e * k;
      out.spineX = -C.roar.bend * e * k;
      out.chestX = C.roar.chest * e;
      break;
    }
    case 'armsUp': {
      const e = envelope(u, g.dur, C.in, C.out);
      out.chestX = C.armsUp.chest * e;
      out.spineX = C.armsUp.back * e;
      // up on the toes, and (the bigger the point) a jump or two
      const hz = C.armsUp.hopHz;
      out.hop = g.k > C.armsUp.jumpFrom ? Math.max(0, Math.sin(u * hz * Math.PI * 2)) * C.armsUp.hop * k * e : 0;
      break;
    }
    case 'huddle': {
      const e = envelope(u, g.dur, C.in, C.out);
      out.spineX = -C.huddle.lean * e;
      out.drop = C.huddle.sink * H * e;
      // a ring that won the point bounces together
      if (g.k > C.huddle.bounceFrom) out.drop += C.huddle.bounce * H * (0.5 - 0.5 * Math.cos(u * C.huddle.bounceHz * Math.PI * 2)) * e;
      break;
    }
    case 'hips': {
      const e = envelope(u, g.dur, C.slowIn, C.out);
      out.spineX = C.hips.back * e;
      out.chestX = -C.hips.head * e;
      break;
    }
    case 'knees': {
      const e = envelope(u, g.dur, C.slowIn, C.out);
      const K = g.low ? C.knees.crouch : C.knees.tired;
      out.drop = K.sink * H * e;
      out.spineX = -K.bend * e;
      out.chestX = K.head * e;
      break;
    }
    case 'sorry': {
      const e = envelope(u, g.dur, C.in, C.out);
      out.chestX = -C.sorry.head * e;
      break;
    }
    case 'wipe': {
      const e = envelope(u, g.dur, C.in, C.out);
      out.spineX = -C.wipe.bend * e;
      out.drop = C.wipe.sink * H * e;
      break;
    }
    case 'bounce': {
      const e = envelope(u, g.dur, C.in, C.out);
      const ph = u * C.bounce.hz * Math.PI * 2;
      out.hop = Math.max(0, Math.sin(ph)) * C.bounce.hop * e;
      out.drop = Math.max(0, -Math.sin(ph)) * C.bounce.sink * H * e;
      break;
    }
    case 'five': {
      // a high five comes up on the toes, a low one bends a little to it
      const e = fiveWeight(g, tr);
      out.drop = (g.low ? C.five.lowSink : -C.five.rise) * H * e;
      out.spineX = (g.low ? -C.five.lowBend : C.five.back) * e;
      break;
    }
    default:
      break;
  }
  return out;
}

/**
 * One arm's part in a gesture at `tr` (`s` the arm: -1 left, +1 right). Returns false when this
 * arm has no part in it. `onHands` is told when two hands meet (a clap, a five).
 */
export function armGesture(a: Athlete, g: Gesture, tr: number, s: -1 | 1, H: number, body: BodyNow, out: ArmGesture): boolean {
  const C = G();
  const u = tr - g.t0;
  const lead = s === g.hand;
  out.world = null;
  out.palm = 0;
  out.flex = 0;
  out.rate = C.rate;
  setShape(out.shape, SH.relaxed);
  const k = lerp(C.size[0], C.size[1], g.k);
  const keys = (list: readonly (readonly number[])[], p: number) => {
    track(list, p, out.w).multiplyScalar(H);
  };
  const pole = (p: readonly number[]) => out.pole.set(p[0], p[1], p[2]);
  switch (g.kind) {
    case 'fist': {
      // the leading arm, or both for a big one
      if (!lead && g.k < C.fist.both) return false;
      out.weight = envelope(u, g.dur, C.in, C.out);
      keys(C.fist.keys, u / g.dur);
      pole(C.fist.pole);
      setShape(out.shape, SH.fist);
      out.rate = C.fastRate;
      return true;
    }
    case 'roar': {
      out.weight = envelope(u, g.dur, C.in, C.out);
      keys(C.roar.keys, u / g.dur);
      // the fists shake with it
      out.w.y += Math.sin(u * C.roar.shakeHz * Math.PI * 2 + s) * C.roar.shake * H;
      pole(C.roar.pole);
      setShape(out.shape, SH.fist);
      out.rate = C.fastRate;
      return true;
    }
    case 'armsUp': {
      out.weight = envelope(u, g.dur, C.in, C.out);
      keys(C.armsUp.keys, u / g.dur);
      out.w.x *= k;
      pole(C.armsUp.pole);
      setShape(out.shape, SH.firm);
      out.palm = C.armsUp.palm;
      out.rate = C.fastRate;
      return true;
    }
    case 'clap': {
      // the hands together in front of the chest, apart and in again for each clap
      const P = C.clap;
      const per = g.dur / Math.max(1, g.count);
      const lastHit = per * (g.count - P.phase);
      out.weight = envelope(u, lastHit + P.after, C.in, C.out);
      const ph = Math.min(Math.max(0, u / per + P.phase), g.count);
      const apart = 0.5 - 0.5 * Math.cos(ph * Math.PI * 2);
      out.w.set(P.mid + P.apart * apart * k, P.up, P.fwd).multiplyScalar(H);
      pole(P.pole);
      setShape(out.shape, SH.firm);
      out.rate = C.clapRate;
      return true;
    }
    case 'five': {
      if (!g.with || s !== g.hand) return false;
      const F = C.five;
      out.weight = fiveWeight(g, tr);
      if (out.weight <= 0) return false;
      out.world = fivePoint(a, g.with, g.low, _p);
      // a little past the meeting point with the slap, then down
      const through = smooth01((tr - g.meet) / F.hold) * F.through;
      out.world.x += body.fwd.x * through;
      out.world.z += body.fwd.z * through;
      out.w.set(F.w[0], g.low ? F.lowW : F.w[1], F.w[2]).multiplyScalar(H);
      pole(g.low ? F.lowPole : F.pole);
      setShape(out.shape, SH.firm);
      out.palm = 1;
      // the wrist cocks back as it comes, and snaps through the slap
      out.flex = tr < g.meet ? -F.cock : F.snap * (1 - smooth01((tr - g.meet) / F.after));
      out.rate = C.fastRate;
      return true;
    }
    case 'pat': {
      if (!g.with || !lead) return false;
      const P = C.pat;
      out.weight = envelope(u, g.dur, C.in, C.out);
      const w = g.with;
      // on the team-mate's shoulder nearest, patting
      _d.set(a.rpos.x - w.rpos.x, 0, a.rpos.z - w.rpos.z).normalize();
      out.world = _p.set(
        w.rpos.x + _d.x * P.out,
        w.rpos.y + w.height * P.up + Math.max(0, Math.sin(u * P.hz * Math.PI * 2)) * P.lift,
        w.rpos.z + _d.z * P.out,
      );
      out.w.set(P.w[0], P.w[1], P.w[2]).multiplyScalar(H);
      pole(P.pole);
      out.palm = P.palm;
      return true;
    }
    case 'huddle': {
      const U = C.huddle;
      out.weight = envelope(u, g.dur, C.in, C.out);
      // a hand in the middle (the leading one), or each arm round the neighbour on its side
      if (g.low && lead && g.at) {
        _d.set(a.rpos.x - g.at.x, 0, a.rpos.z - g.at.z);
        const d = _d.length() || 1;
        out.weight *= 1 - smooth01((d - U.near) / (U.far - U.near));
        out.world = _p.set(
          g.at.x + (_d.x / d) * U.inMiddle,
          a.height * U.handsUp + (a.id % U.stack) * U.stackStep,
          g.at.z + (_d.z / d) * U.inMiddle,
        );
        out.w.set(U.inW[0], U.inW[1], U.inW[2]).multiplyScalar(H);
        pole(U.inPole);
        out.palm = U.inPalm;
        setShape(out.shape, SH.firm);
        return true;
      }
      // the neighbour on this arm's side
      let nb: Athlete | null = null;
      let best = 0;
      for (const o of [g.with, g.with2]) {
        if (!o || o === a) continue;
        const side = ((o.rpos.x - a.rpos.x) * body.right.x + (o.rpos.z - a.rpos.z) * body.right.z) * s;
        if (side > best) {
          best = side;
          nb = o;
        }
      }
      if (!nb) return false;
      // (only once they are there: nobody reaches out for a team-mate still on the way)
      _d.set(nb.rpos.x - a.rpos.x, 0, nb.rpos.z - a.rpos.z);
      out.weight *= 1 - smooth01((_d.length() - U.near) / (U.far - U.near));
      _d.normalize();
      // the hand on their far shoulder blade: across their back, as far as the arm goes
      out.world = _p.set(nb.rpos.x + _d.x * U.across, nb.rpos.y + nb.height * U.shoulder, nb.rpos.z + _d.z * U.across);
      if (g.at) {
        _d.set(nb.rpos.x - g.at.x, 0, nb.rpos.z - g.at.z).normalize();
        out.world.x += _d.x * U.behind;
        out.world.z += _d.z * U.behind;
      }
      out.w.set(U.armW[0], U.armW[1], U.armW[2]).multiplyScalar(H);
      pole(U.armPole);
      out.palm = U.armPalm;
      return true;
    }
    case 'hips': {
      out.weight = envelope(u, g.dur, C.slowIn, C.out);
      out.w.set(C.hips.w[0], C.hips.w[1], C.hips.w[2]).multiplyScalar(H);
      pole(C.hips.pole);
      out.palm = C.hips.palm;
      out.flex = C.hips.flex;
      out.rate = C.slowRate;
      return true;
    }
    case 'knees': {
      out.weight = envelope(u, g.dur, C.slowIn, C.out);
      // the hand just above the knee, on the front of the thigh
      out.world = _p.copy(body.knee);
      out.world.y += C.knees.above * H;
      out.world.x += body.fwd.x * C.knees.front * H;
      out.world.z += body.fwd.z * C.knees.front * H;
      out.w.set(C.knees.w[0], C.knees.w[1], C.knees.w[2]).multiplyScalar(H);
      pole(C.knees.pole);
      out.palm = C.knees.palm;
      out.rate = C.slowRate;
      return true;
    }
    case 'sorry': {
      if (!lead) return false;
      out.weight = envelope(u, g.dur, C.in, C.out);
      out.w.set(C.sorry.w[0], C.sorry.w[1] + Math.sin(u * C.sorry.waveHz * Math.PI * 2) * C.sorry.wave, C.sorry.w[2]).multiplyScalar(H);
      pole(C.sorry.pole);
      setShape(out.shape, SH.firm);
      out.palm = 1;
      return true;
    }
    case 'signal': {
      // behind the back: the leading hand, or both (one for each of their hitters)
      if (!lead && g.k < C.signal.both) return false;
      out.weight = envelope(u, g.dur, C.slowIn, C.out);
      out.w.set(C.signal.w[0], C.signal.w[1], C.signal.w[2]).multiplyScalar(H);
      pole(C.signal.pole);
      setShape(out.shape, g.low ? SH.fist : SH.firm);
      out.palm = -1;
      out.rate = C.slowRate;
      return true;
    }
    case 'wipe': {
      out.weight = envelope(u, g.dur, C.in, C.out);
      keys(C.wipe.keys, u / g.dur);
      pole(C.wipe.pole);
      setShape(out.shape, SH.firm);
      out.palm = -1;
      out.rate = C.fastRate;
      return true;
    }
    case 'shake': {
      out.weight = envelope(u, g.dur, C.in, C.out);
      const ph = u * C.shake.hz * Math.PI * 2 + (s > 0 ? 0 : C.shake.offset);
      out.w.set(C.shake.w[0] + Math.sin(ph) * C.shake.lat, C.shake.w[1], C.shake.w[2]).multiplyScalar(H);
      out.flex = Math.sin(ph + Math.PI / 2) * C.shake.flex;
      pole(C.shake.pole);
      out.rate = C.fastRate;
      return true;
    }
    default:
      // bounce: the arms just hang loose
      return false;
  }
}

/** a clap's or a five's hands meet between `from` and `to` (render times): which, if any */
export function handsMeet(a: Athlete, g: Gesture, from: number, to: number): 'clap' | 'five' | null {
  if (g.kind === 'five') {
    // one slap for the two of them: the lower id hears it
    if (!g.with || a.id > g.with.id) return null;
    return from < g.meet && to >= g.meet ? 'five' : null;
  }
  if (g.kind !== 'clap' || g.count < 1) return null;
  const per = g.dur / g.count;
  const P = G().clap;
  for (let i = 0; i < g.count; i++) {
    const t = g.t0 + per * (i + 1 - P.phase);
    if (from < t && to >= t) return 'clap';
  }
  return null;
}

const _p = new THREE.Vector3();
const _d = new THREE.Vector3();
