import * as THREE from 'three';
import { describe, expect, it } from 'vitest';
import { BALL } from '../src/config';
import { at, elbowAngle, local, OUT, runSet, type Frame } from './setScenes';

// The hand set (issue #132): how the setter's hands and body look from the ball's arrival to the
// release. What a coach looks for: the hands up early in a window above the forehead, the thumbs and
// index fingers making a triangle, the wrists cocked back; the ball sinks into the hands, the wrists
// and elbows give; then the legs, arms and wrists extend together towards the target, up and back
// with an arched back for a back set, short and quick for a quick.
//
// Every setter has their own habits and no two sets are the same (CHARACTER.set.vary): each fact is
// checked for several setters, so a habit can never take a set out of what a coach would accept.

/** the setters every fact is checked for (each id is a setter with habits of their own) */
const SETTERS = Array.from({ length: 12 }, (_, i) => i + 1);

describe('the hand set, as the body shows it', () => {
  it('the hands are up early, in a window above and in front of the forehead, the elbows bent and out', () => {
    for (const id of SETTERS) {
      const { frames } = runSet({ out: OUT.front, id });
      // a quarter of a second before the ball arrives
      const f = at(frames, -0.25);
      for (const [sh, el, wr] of [
        [f.shoulderL, f.elbowL, f.wristL],
        [f.shoulderR, f.elbowR, f.wristR],
      ]) {
        // the wrists above the eyes and in front of the face
        expect(wr.y).toBeGreaterThan(f.eye.y + 0.02);
        expect(local(wr.clone().sub(f.eye)).fwd).toBeGreaterThan(0.04);
        // the elbows bent (well short of a straight arm) and below the hands
        expect(elbowAngle(sh, el, wr)).toBeLessThan(2.3);
        expect(el.y).toBeLessThan(wr.y - 0.06);
      }
      // the elbows are out: further apart than the wrists
      expect(f.elbowL.distanceTo(f.elbowR)).toBeGreaterThan(f.wristL.distanceTo(f.wristR) + 0.1);
    }
  });

  it('in the window the wrists are cocked back: the palms face up to the ball and the thumbs point back towards the eyes', () => {
    for (const id of SETTERS) {
      const { frames } = runSet({ out: OUT.front, id });
      for (const tt of [-0.2, -0.12, -0.03]) {
        const f = at(frames, tt);
        for (const [palm, thumb] of [
          [f.palmL, f.thumbL],
          [f.palmR, f.thumbR],
        ]) {
          // the palm faces up (and forward), not at the other palm
          expect(palm.y).toBeGreaterThan(0.6);
          // the thumb runs back, towards the setter's face, not up
          expect(local(thumb).fwd).toBeLessThan(-0.1);
        }
      }
    }
  });

  it('the ball sinks into the hands: they are lower and the elbows more bent at the touch than as the ball arrives', () => {
    for (const id of SETTERS) {
      const { frames } = runSet({ out: OUT.front, id });
      const meet = at(frames, -0.06);
      const touch = at(frames, 0);
      const y = (f: Frame) => (f.wristL.y + f.wristR.y) / 2;
      expect(y(meet) - y(touch)).toBeGreaterThan(0.015);
      expect(elbowAngle(touch.shoulderR, touch.elbowR, touch.wristR)).toBeLessThan(elbowAngle(meet.shoulderR, meet.elbowR, meet.wristR));
      // and at the touch the elbows are well bent: the ball is played from the forehead, not reached for
      expect(elbowAngle(touch.shoulderR, touch.elbowR, touch.wristR)).toBeLessThan(1.9);
    }
  });

  it('your set: the hands give with the ball while it loads, then push it out', () => {
    const { frames } = runSet({ out: OUT.front, absorb: true });
    const caught = at(frames, -0.15);
    const loaded = at(frames, 0);
    const y = (f: Frame) => (f.wristL.y + f.wristR.y) / 2;
    // the ball came down about 9 cm while it loaded: the hands came with it
    expect(y(caught) - y(loaded)).toBeGreaterThan(0.05);
    const pushed = at(frames, 0.15);
    expect(y(pushed) - y(loaded)).toBeGreaterThan(0.15);
  });

  it('on the ball only the fingers touch it: the fingers spread up its back, the thumbs under it, the index fingers and thumbs a triangle', () => {
    for (const id of SETTERS) {
      // your set, the ball loading in the hands
      const { frames } = runSet({ out: OUT.front, absorb: true, id });
      const f = at(frames, -0.05);
      const C = f.ball;
      const gap = (p: THREE.Vector3) => p.distanceTo(C) - BALL.radius;
      for (const side of ['L', 'R'] as const) {
        const tips = f[`tips${side}`];
        // every fingertip and the thumb on the ball (the middle of a finger a finger's thickness off it, give or take)
        for (const p of Object.values(tips)) expect(Math.abs(gap(p) - 0.01)).toBeLessThan(0.025);
        // the palm off it: a hand cupped round the ball, not a tray under it
        expect(gap(f[`wrist${side}`].clone().lerp(f[`hand${side}`], 0.5))).toBeGreaterThan(0.025);
        // the thumb under the ball and behind it, towards the eyes; the fingers up its back
        expect(tips.thumb.y).toBeLessThan(C.y - 0.04);
        expect(local(tips.thumb.clone().sub(C)).fwd).toBeLessThan(-0.04);
        expect(tips.middle.y).toBeGreaterThan(tips.thumb.y + 0.06);
      }
      // the window: the index fingers a hand apart and the thumbs a few centimetres, neither crossed
      const right = (p: THREE.Vector3) => local(p).right;
      expect(f.tipsL.index.distanceTo(f.tipsR.index)).toBeGreaterThan(0.07);
      expect(right(f.tipsR.index) - right(f.tipsL.index)).toBeGreaterThan(0.06);
      const thumbs = right(f.tipsR.thumb) - right(f.tipsL.thumb);
      expect(thumbs).toBeGreaterThan(0.015);
      expect(thumbs).toBeLessThan(0.09);
    }
  });

  it('the push straightens the wrists but never bends them over: the palms finish up and forward to where the ball went', () => {
    // how far the wrist is bent back (rad): + back, - over towards the palm
    const back = (f: Frame, side: 'L' | 'R') => {
      const fore = f[`wrist${side}`].clone().sub(f[`elbow${side}`]).normalize();
      const hand = f[`hand${side}`].clone().sub(f[`wrist${side}`]).normalize();
      return Math.atan2(fore.dot(f[`palm${side}`]), fore.dot(hand));
    };
    for (const kind of ['front', 'back', 'quick'] as const) {
      const away = local(OUT[kind]);
      const flat = Math.hypot(away.fwd, away.right);
      for (const id of SETTERS) {
        const { frames } = runSet({ out: OUT[kind], id });
        // cocked well back on the ball (the give takes it further)
        const touch = at(frames, 0);
        for (const side of ['L', 'R'] as const) expect(back(touch, side)).toBeGreaterThan(0.8);
        // through the push and the hold, never past straight (Maessen and Holt's film of a national-team setter)
        for (const f of frames.filter((x) => x.t > 0 && x.t < 0.3)) {
          for (const side of ['L', 'R'] as const) expect(back(f, side)).toBeGreaterThan(-0.05);
        }
        const f = at(frames, 0.2);
        for (const side of ['L', 'R'] as const) {
          const p = local(f[`palm${side}`]);
          // the palm faces the way the ball went, and not down
          expect((p.fwd * away.fwd + p.right * away.right) / flat).toBeGreaterThan(0.6);
          expect(p.up).toBeGreaterThan(-0.15);
        }
        // the two palms turned towards each other a little, never away (over-rotated wrists)
        expect(local(f.palmL).right).toBeGreaterThan(0);
        expect(local(f.palmR).right).toBeLessThan(0);
      }
    }
  });

  it('a front set is pushed forward and up: the arms finish nearly straight, the hands out towards the target', () => {
    for (const id of SETTERS) {
      const { frames } = runSet({ out: OUT.front, id });
      const touch = at(frames, 0);
      const f = at(frames, 0.12);
      for (const [h, h0] of [
        [f.handL, touch.handL],
        [f.handR, touch.handR],
      ]) {
        const d = local(h.clone().sub(h0));
        expect(d.fwd).toBeGreaterThan(0.08);
        expect(d.up).toBeGreaterThan(0.1);
      }
      // both arms at their longest after the push: nearly straight
      const pushed = frames.filter((x) => x.t > 0 && x.t < 0.25);
      for (const side of ['L', 'R'] as const) {
        const most = Math.max(...pushed.map((x) => elbowAngle(x[`shoulder${side}`], x[`elbow${side}`], x[`wrist${side}`])));
        expect(most).toBeGreaterThan(2.6);
      }
      // the fingers point where the ball went: the palms face the target, not each other
      expect(local(f.palmL).fwd).toBeGreaterThan(0.3);
      expect(local(f.palmR).fwd).toBeGreaterThan(0.3);
    }
  });

  it('a back set arches the back and pushes up and over the head: the chest leans back and the hips go forward', () => {
    for (const id of SETTERS) {
      const front = runSet({ out: OUT.front, id }).frames;
      const back = runSet({ out: OUT.back, id }).frames;
      const fb = at(back, 0.12);
      const ff = at(front, 0.12);
      // the chest's up axis tips back (away from the target), the front set's does not
      expect(local(fb.chestUp).fwd).toBeLessThan(-0.15);
      expect(local(fb.chestUp).fwd).toBeLessThan(local(ff.chestUp).fwd - 0.15);
      // the hips go forward, under the arch
      const feet = (f: Frame) => f.ankleL.clone().add(f.ankleR).multiplyScalar(0.5);
      expect(local(fb.hips.clone().sub(feet(fb))).fwd).toBeGreaterThan(local(ff.hips.clone().sub(feet(ff))).fwd + 0.03);
      // the hands go up over the head, not out in front of it as for a front set
      for (const [w, sh, wf, shf] of [
        [fb.wristL, fb.shoulderL, ff.wristL, ff.shoulderL],
        [fb.wristR, fb.shoulderR, ff.wristR, ff.shoulderR],
      ]) {
        expect(w.y).toBeGreaterThan(fb.head.y + 0.3);
        expect(local(w.clone().sub(sh)).fwd).toBeLessThan(0.1);
        expect(local(w.clone().sub(sh)).fwd).toBeLessThan(local(wf.clone().sub(shf)).fwd - 0.08);
      }
    }
  });

  it('a quick is short and quick: the hands travel less than for a high ball outside and are done sooner', () => {
    for (const id of SETTERS) {
      const front = runSet({ out: OUT.front, id }).frames;
      const quick = runSet({ out: OUT.quick, id }).frames;
      // (both hands: one may trail the other by a few milliseconds)
      const travel = (fr: Frame[], t: number) =>
        (at(fr, t).wristR.distanceTo(at(fr, 0).wristR) + at(fr, t).wristL.distanceTo(at(fr, 0).wristL)) / 2;
      expect(travel(quick, 0.1)).toBeLessThan(travel(front, 0.1) - 0.05);
      // half of the quick's push is done in the first 40 ms
      expect(travel(quick, 0.04)).toBeGreaterThan(0.5 * travel(quick, 0.1));
    }
  });

  it('the legs drive with the arms: the hips sit lower under the ball and rise through the release, the heels come up on a long set', () => {
    for (const id of SETTERS) {
      const { frames } = runSet({ out: OUT.front, id, after: 1.1 });
      const under = at(frames, -0.15);
      const up = at(frames, 0.1);
      expect(up.hips.y - under.hips.y).toBeGreaterThan(0.04);
      const ankles = (f: Frame) => (f.ankleL.y + f.ankleR.y) / 2;
      expect(ankles(up) - ankles(under)).toBeGreaterThan(0.01);
      // and down again: by a second after the touch the heels are back on the floor
      expect(Math.abs(ankles(at(frames, 1.05)) - ankles(under))).toBeLessThan(0.006);
    }
  });

  it('the arms let go after the set: by 0.6 s the hands are back below the head', () => {
    for (const id of SETTERS) {
      for (const out of [OUT.front, OUT.back, OUT.quick]) {
        const f = at(runSet({ out, id }).frames, 0.65);
        expect(f.wristL.y).toBeLessThan(f.head.y);
        expect(f.wristR.y).toBeLessThan(f.head.y);
      }
    }
  });

  it('no two sets are the same, but one set is drawn the same way every time', () => {
    // the same set twice: every bone in the same place
    const a1 = runSet({ out: OUT.front, before: 0.3 }).frames;
    const a2 = runSet({ out: OUT.front, before: 0.3 }).frames;
    expect(a1.length).toBe(a2.length);
    for (let i = 0; i < a1.length; i++) expect(a1[i].pose).toEqual(a2[i].pose);
    // one setter's six sets at different moments: where the hands are as the arms come down differs by a few centimetres
    const hy: number[] = [];
    const hold: number[] = [];
    for (let k = 0; k < 6; k++) {
      const fr = runSet({ out: OUT.front, before: 0.11 * k }).frames;
      const f = at(fr, 0.3);
      hy.push(local(f.wristR.clone().sub(f.head)).up);
      // how long the arms stay up after the push
      const top = Math.max(...fr.filter((x) => x.t > 0).map((x) => x.wristR.y));
      hold.push(fr.find((x) => x.t > 0.05 && x.wristR.y < top - 0.08)?.t ?? 1);
    }
    expect(Math.max(...hy) - Math.min(...hy)).toBeGreaterThan(0.02);
    expect(Math.max(...hold) - Math.min(...hold)).toBeGreaterThan(0.03);
  });

  it("the right foot steps ahead to set: the setter's stance squares the body to the target", () => {
    for (const id of SETTERS) {
      const touch = at(runSet({ out: OUT.front, id }).frames, 0);
      // facing the target (the left antenna), the right foot is ahead of the left
      expect(local(touch.ankleR.clone().sub(touch.ankleL)).fwd).toBeGreaterThan(0.04);
    }
  });
});
