import { describe, expect, it } from 'vitest';
import { BLOCK, COURT, CONTACT } from '../src/config';
import { Athlete } from '../src/game/athlete';
import { handPlates } from '../src/game/blockHands';
import { between, blockScene, edgeOf, ghost, palm, R, spikeAt, through, type BlockerSpec, type SceneSpec } from './blockScene';

/**
 * The block is two hands: surfaces the ball meets where they are, and comes off the way it met
 * them. Nothing here rolls dice for the outcome. Their hitter is on -z, our blocker on +z (side 1);
 * `+` along the net is toward the hitter's left (their outside hitter's antenna is at +x).
 */

const DEG = Math.PI / 180;

/** a blocker centred `off` m from where the attack crosses the net (> 0: the ball crosses on the blocker's +x side) */
function blockedAt(spec: SceneSpec, off: number, b: Partial<BlockerSpec> = {}) {
  const c = ghost(spec).cross!;
  return blockScene({ ...spec, blockers: [{ x: c.x - off, user: true, timing: 0, ...b }] });
}

/** the width of net (m) over which one blocker's hands touch the attack, scanning where it crosses */
function touchWidth(spec: SceneSpec, step = 0.04): number {
  let n = 0;
  for (let off = -1.2; off <= 1.2 + 1e-9; off += step) if (blockedAt(spec, off).touched) n++;
  return n * step;
}

/** the block's half-span along the net: half the gap between the thumbs and one hand (no aim assist) */
const HALF_SPAN = BLOCK.thumbGap / 2 + BLOCK.handWidth;

describe('the block is two hands', () => {
  it('a cross shot is not much harder to get past one blocker than a line shot: the hands cover about the same width of net', () => {
    const line = touchWidth(spikeAt(3.2, 0, CONTACT.spikeGood));
    const cross = touchWidth(spikeAt(3.2, 40 * DEG, CONTACT.spikeGood));
    // the hands and a ball either side of them
    expect(line).toBeGreaterThan(2 * HALF_SPAN);
    expect(line).toBeLessThan(2 * (HALF_SPAN + R) + 0.3);
    // A hand is thin, but turned to face a slanting ball it shows that ball its whole width, which
    // measured along the net is a little more (1 / cos of the angle), and there is an arm behind it.
    // No more than that: the old block, a box 0.75 m deep, covered 85% more net against this cross.
    expect(cross).toBeLessThan(line * 1.3);
  });

  it('a ball that crosses the net higher than the fingertips can reach is not touched: the hands cannot reach back for it', () => {
    const probe = new Athlete('MB', 1);
    // the highest a blocker's fingertips go: arms straight up at the top of its jump
    const reach = probe.standReach + probe.jumpMax * probe.stats.standingJumpFrac + BLOCK.reachTop;
    for (const speed of [19, 26, 30]) {
      // aimed deep from high up so it crosses the net just over that reach, and falls behind it
      for (const depth of [3, 4, 5]) {
        const spec = spikeAt(0, 0, speed, { y: reach + 0.55, depth });
        const c = ghost(spec).cross!;
        if (c.y < reach + R + 0.03) continue;
        expect(blockedAt(spec, 0).touched, `${speed} m/s, ${depth} m deep, crossing ${c.y.toFixed(2)} m`).toBe(false);
      }
    }
  });

  it('the gap between a closed double block is narrower than the ball: a spike at the seam is touched', () => {
    const spec = spikeAt(1.5, 0, CONTACT.spikeGood);
    const c = ghost(spec).cross!;
    // two blockers, hands edge to edge, the seam where the ball crosses
    const r = blockScene({
      ...spec,
      blockers: [
        { x: c.x - HALF_SPAN - 0.01, timing: 0 },
        { x: c.x + HALF_SPAN + 0.01, timing: 0 },
      ],
    });
    expect(r.touched).toBe(true);
  });

  it('on the floor the hands stay on the blocker’s side of the tape; only a blocker high in a jump reaches over it', () => {
    const a = new Athlete('MB', 1);
    a.isUser = true;
    a.place(0, 0.45, Math.PI);
    const act = a.startAction('block', -1);
    const ground = handPlates(a, act, 0, { netTop: COURT.netHeightMen });
    for (const p of ground) expect(p.tip.z).toBeGreaterThan(0);
    a.state = 'air';
    a.jumpH = a.jumpMax * a.stats.standingJumpFrac;
    a.pos.y = a.jumpH;
    const up = handPlates(a, act, 0, { netTop: COURT.netHeightMen });
    for (const p of up.filter((h) => !h.arm)) expect(p.tip.z).toBeLessThan(0);
  });
});

describe('the ball comes off the hands the way it met them', () => {
  /** our blocker at the top of its jump, at `x` along the net */
  const B = (x: number, more: Partial<BlockerSpec> = {}): BlockerSpec => ({ x, user: true, timing: 0, ...more });
  /** their hitter's contact, square to the hands or `ang` rad across (> 0 from the +x side) */
  const hitter = (x: number, ang = 0, y = 3.35): { x: number; y: number; z: number } => ({ x: x + Math.tan(ang) * 0.9, y, z: -0.8 });
  const dir = (from: { x: number; z: number }, to: { x: number; z: number }) => ({ x: to.x - from.x, y: 0, z: to.z - from.z });
  const speed = (v: { x: number; y: number; z: number }) => Math.hypot(v.x, v.y, v.z);
  /** an attack from `from` into the middle of the hands (between the thumbs) of blocker `b` */
  const intoMiddle = (b: BlockerSpec, from: { x: number; y: number; z: number }, sp: number) =>
    blockScene(through(from, between(b, dir(from, { x: b.x, z: 0 })), sp, [b]));

  it('a hard spike into the middle of well-pressed hands is driven down into the hitter’s court: a stuff', () => {
    const r = intoMiddle(B(3), hitter(3), CONTACT.spikeGood);
    expect(r.touched).toBe(true);
    expect(r.kind).toBe('stuff');
    expect(r.landSide).toBe('hitter');
    expect(r.landIn).toBe(true);
    // down at the hitter's feet, not lobbed back
    expect(Math.abs(r.land!.z)).toBeLessThan(4);
  });

  it('a harder spike comes back harder off the same hands', () => {
    const soft = intoMiddle(B(3), hitter(3), CONTACT.spikeOk);
    const hard = intoMiddle(B(3), hitter(3), CONTACT.spikePerfect);
    expect(soft.touched && hard.touched).toBe(true);
    expect(speed(hard.vOut!)).toBeGreaterThan(speed(soft.vOut!) + 2);
  });

  it('a line shot and a cross shot into the same hands come back on different lines', () => {
    const line = intoMiddle(B(2.5), hitter(2.5), CONTACT.spikeGood);
    const cross = intoMiddle(B(2.5), hitter(2.5, 35 * DEG), CONTACT.spikeGood);
    expect(line.touched && cross.touched).toBe(true);
    // which way along the net each goes off the hands: the cross shot was heading for -x and keeps some of it
    const along = (r: typeof line) => r.vOut!.x / Math.hypot(r.vOut!.x, r.vOut!.z);
    expect(along(cross)).toBeLessThan(along(line) - 0.15);
    expect(Math.abs(cross.land!.x - line.land!.x)).toBeGreaterThan(0.5);
  });

  it('a pin blocker turns its outside hand in: a line shot it stuffs off that hand comes down inside the sideline', () => {
    const b = B(3.9);
    let stuffs = 0;
    for (let across = -0.08; across <= 0.08; across += 0.02) {
      const from = hitter(4.1);
      const r = blockScene(through(from, palm(b, dir(from, { x: 4.1, z: 0 }), true, across), CONTACT.spikeGood, [b]));
      if (r.kind !== 'stuff') continue;
      stuffs++;
      expect(Math.abs(r.land!.x), `across ${across.toFixed(2)}`).toBeLessThan(COURT.halfWidth);
    }
    expect(stuffs).toBeGreaterThan(3);
  });

  it('a spike off the outer edge of the hands carries on, turned out, and lands out: a block-out; a nick keeps more of its pace', () => {
    // their outside hitter at the antenna hits the line, half the ball on the outer edge of our pin blocker's outside hand
    const b = B(3.75);
    const off = (beyond: number) => {
      const aim = edgeOf(b, { x: 0, y: 0, z: 1 }, true, beyond);
      return blockScene(through(hitter(aim.x), aim, CONTACT.spikeGood, [b]));
    };
    const r = off(R * 0.5);
    expect(r.touched).toBe(true);
    expect(r.kind).toBe('tool');
    expect(r.landIn).toBe(false);
    // it keeps going the way it was going (on into the blocker's side), turned out
    expect(r.vOut!.z).toBeGreaterThan(0);
    expect(r.vOut!.x).toBeGreaterThan(r.vIn!.x + 0.5);
    // a nick (the ball's line nearly a radius outside the hand) keeps more of its pace than half the ball on the hand
    const kept = (k: number) => {
      const t = off(R * k);
      expect(t.touched).toBe(true);
      return speed(t.vOut!) / speed(t.vIn!);
    };
    expect(kept(0.95)).toBeGreaterThan(kept(0.5) + 0.1);
  });

  it('a ball that only clips the fingertips goes up and on into the blocker’s court', () => {
    const b = B(0);
    const from = hitter(0, 0, 3.6);
    // the ball's centre a little over the tips of the fingers
    const tips = palm(b, dir(from, { x: 0, z: 0 }), true, 0, BLOCK.handWidth / 2 + R * 0.8);
    const r = blockScene(through(from, tips, CONTACT.spikeGood, [b]));
    expect(r.touched).toBe(true);
    expect(r.vOut!.z).toBeGreaterThan(0);
    expect(r.vOut!.y).toBeGreaterThan(r.vIn!.y);
    expect(r.landSide).toBe('blocker');
  });

  it('a soft push into the middle of good hands comes back to the hitter’s side, slow: their cover can play it', () => {
    const b = B(0, { user: false });
    const from = { x: 0, y: 3.1, z: -0.6 };
    const r = blockScene(through(from, between(b, dir(from, { x: 0, z: 0 })), CONTACT.pushSpeed, [b], 0));
    expect(r.touched).toBe(true);
    expect(r.vOut!.z).toBeLessThan(0);
    expect(r.kind).toBe('recycle');
    expect(r.landSide).toBe('hitter');
  });

  it('a tip pushed off the outer edge of a pin blocker’s outside hand goes off it and out; into the middle of the hand it comes back (#114)', () => {
    const b = B(3.5);
    for (const sp of [6, 9, 12]) {
      // pushed from just inside the hand, a little out, at its edge (the ball half on the hand)
      const edge = edgeOf(b, { x: 0, y: 0, z: 1 }, true, 0);
      const off = blockScene(through({ x: edge.x - 0.15, y: edge.y + 0.25, z: -0.6 }, edge, sp, [b], 0));
      expect(off.touched, `${sp} m/s`).toBe(true);
      expect(off.kind, `${sp} m/s`).toBe('tool');
      // the same push into the middle of the outside hand: back to the hitter's side, for their cover
      const mid = palm(b, { x: 0, y: 0, z: 1 }, true);
      const back = blockScene(through({ x: mid.x - 0.15, y: mid.y + 0.25, z: -0.6 }, mid, sp, [b], 0));
      expect(back.kind, `${sp} m/s`).toBe('recycle');
    }
  });

  it('a late block, hands still coming up under the ball, stuffs far less often than a block at the top of its jump', () => {
    const stuffs = (timing: number) => {
      let n = 0;
      for (let off = -0.3; off <= 0.3 + 1e-9; off += 0.05)
        for (const sp of [19, 26, 30]) if (blockedAt(spikeAt(3.2, 0, sp), off, { timing }).kind === 'stuff') n++;
      return n;
    };
    const onTime = stuffs(0);
    expect(onTime).toBeGreaterThan(4);
    expect(stuffs(-0.22)).toBeLessThan(onTime / 2);
  });

  it('hands are not a spring: the ball never leaves them with more energy than it met them with, seen from the hands', () => {
    // its speed and its spin (a hollow ball: a sixth of the spin's surface speed squared, for each of the speed's half)
    const energy = (
      v: { x: number; y: number; z: number },
      w: { x: number; y: number; z: number },
      h: { x: number; y: number; z: number },
    ) => (v.x - h.x) ** 2 + (v.y - h.y) ** 2 + (v.z - h.z) ** 2 + ((w.x ** 2 + w.y ** 2 + w.z ** 2) * R * R * 2) / 3;
    let n = 0;
    for (const sp of [12, 19, 26, 30])
      for (const angle of [0, 20 * DEG, 40 * DEG])
        for (let off = -0.5; off <= 0.5; off += 0.1) {
          const r = blockedAt(spikeAt(3.2, angle, sp), off);
          if (!r.touched) continue;
          n++;
          const v = r.athletes[r.by].vel;
          expect(energy(r.vOut!, r.wOut!, v)).toBeLessThanOrEqual(energy(r.vIn!, r.wIn!, v) + 1e-6);
        }
    expect(n).toBeGreaterThan(20);
  });

  it('the same spike into the same block comes off the same way', () => {
    const a = blockedAt(spikeAt(2.5, 15 * DEG, CONTACT.spikeGood), 0.12);
    const b = blockedAt(spikeAt(2.5, 15 * DEG, CONTACT.spikeGood), 0.12);
    expect(a.vOut).toEqual(b.vOut);
    expect(a.land).toEqual(b.land);
  });

  it('where the ball meets the hands decides it: from the middle of the hands to the outer edge, stuffs give way to block-outs', () => {
    const b = B(3.4);
    const from = hitter(3.9);
    const kinds = (lo: number, hi: number) => {
      const out: string[] = [];
      for (let across = lo; across <= hi + 1e-9; across += 0.02)
        for (const sp of [19, 26, 30])
          out.push(blockScene(through(from, palm(b, dir(from, { x: 3.9, z: 0 }), true, across), sp, [b])).kind);
      return out;
    };
    const middle = kinds(-0.04, 0.04);
    const edge: string[] = [];
    for (let beyond = 0; beyond <= R + 1e-9; beyond += 0.02)
      for (const sp of [19, 26, 30])
        edge.push(blockScene(through(from, edgeOf(b, dir(from, { x: 3.9, z: 0 }), true, beyond), sp, [b])).kind);
    const share = (a: string[], k: string) => a.filter((x) => x === k).length / a.length;
    expect(share(middle, 'stuff')).toBeGreaterThan(share(edge, 'stuff'));
    expect(share(edge, 'tool')).toBeGreaterThan(share(middle, 'tool'));
  });
});
