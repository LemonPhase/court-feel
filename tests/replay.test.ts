import { describe, expect, it } from 'vitest';
import * as THREE from 'three';
import { Athlete } from '../src/game/athlete';
import { AthleteView } from '../src/character/athleteView';
import { makeKit } from '../src/character/kits';
import { Replay } from '../src/fx/replay';

const DT = 1 / 60;

function makeView(x: number): AthleteView {
  const a = new Athlete('OH', 1);
  a.place(x, 1, 0);
  a.interpolate(1);
  const v = new AthleteView(a, makeKit(0, false, 1));
  v.update(DT, 0);
  return v;
}

/** play the replay forward until its cursor reaches `t` (or it ends); false once it ended */
function advanceTo(r: Replay, ball: THREE.Object3D, t: number): boolean {
  while (r.playing && r.cursor < t) if (!r.advance(DT, ball)) return false;
  return r.playing;
}

describe('replay', () => {
  /**
   * A drill that spawns athletes after it started (the spike drill's block, key B): the
   * replay must record and pose them too, not leave them frozen where they stand live.
   */
  function recordWithLateBlocker() {
    const r = new Replay(4, 60);
    const ball = new THREE.Object3D();
    const me = makeView(-3);
    r.setViews([me]);
    let t = 0;
    for (; t < 1 - 1e-9; t += DT) {
      me.root.position.x = -3 + t;
      r.record(t, ball, true);
    }
    // the block is turned on: a new athlete mid-recording
    const blocker = makeView(0);
    r.addView(blocker);
    r.addView(blocker); // twice is a no-op
    const spawnT = t;
    for (; t < 2 - 1e-9; t += DT) {
      me.root.position.x = -3 + t;
      blocker.root.position.set(t - spawnT, 0.5 * Math.sin((t - spawnT) * 3), -0.5);
      r.record(t, ball, true);
    }
    // the live scene has moved on by the time the replay is watched
    blocker.root.position.set(9, 0, 9);
    me.root.position.set(9, 0, 9);
    return { r, ball, me, blocker, spawnT };
  }

  it('records an athlete added while recording, and poses it where it was', () => {
    const { r, ball, me, blocker, spawnT } = recordWithLateBlocker();
    expect(r.views).toEqual([me, blocker]);
    expect(r.start(spawnT + 0.1, 1.9)).toBe(true);
    for (const c of [spawnT + 0.2, spawnT + 0.45, spawnT + 0.8]) {
      expect(advanceTo(r, ball, c)).toBe(true);
      const k = r.cursor - spawnT;
      expect(blocker.root.visible).toBe(true);
      expect(blocker.root.position.x).toBeCloseTo(k, 1);
      expect(blocker.root.position.y).toBeCloseTo(0.5 * Math.sin(k * 3), 1);
      expect(blocker.root.position.z).toBeCloseTo(-0.5, 3);
      expect(me.root.position.x).toBeCloseTo(-3 + r.cursor, 1);
    }
  });

  it('hides an athlete for the part of the recording from before it was there, and shows it again after', () => {
    const { r, ball, blocker, spawnT } = recordWithLateBlocker();
    expect(r.start(0.3, 1.9)).toBe(true);
    expect(advanceTo(r, ball, 0.6)).toBe(true);
    expect(blocker.root.visible).toBe(false);
    // its pose is left alone (no stale or empty slot data)
    const q = blocker.rig.bones.handR.quaternion;
    expect(Math.abs(q.lengthSq() - 1)).toBeLessThan(1e-4);
    expect(advanceTo(r, ball, spawnT + 0.1)).toBe(true);
    expect(blocker.root.visible).toBe(true);
    expect(advanceTo(r, ball, 99)).toBe(false);
    expect(blocker.root.visible).toBe(true);
  });

  it('a replay stopped (skipped) or reset while it hides an athlete gives it back to the live scene', () => {
    const { r, ball, me, blocker } = recordWithLateBlocker();
    r.start(0.3, 1.9);
    advanceTo(r, ball, 0.6);
    expect(blocker.root.visible).toBe(false);
    r.stop();
    expect(blocker.root.visible).toBe(true);
    r.start(0.3, 1.9);
    advanceTo(r, ball, 0.6);
    expect(blocker.root.visible).toBe(false);
    r.setViews([me]);
    expect(r.playing).toBe(false);
    expect(blocker.root.visible).toBe(true);
  });
});
