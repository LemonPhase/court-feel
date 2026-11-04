import { describe, expect, it } from 'vitest';
import { isDirectLockedTravel } from '../src/core/input';
import { TOUCH_KEY_LABELS } from '../src/ui/touchControls';
import { translateKeyMarkup } from '../src/ui/hud';
import {
  COLLAR_DEG_PER_S,
  FEET_DWELL_S,
  GATE_NUDGE_S,
  HINT_DRAW,
  HINT_LOAD,
  HINT_THROUGH,
  JUMP_GATE_LOAD,
  SWING_SWEET_ERR,
  TUTOR_SLOW,
  TUTORIAL_KEY,
  TutorialDirector,
  collarDegrees,
  collarZone,
  jumpLoadFrac,
  readTutorialFlag,
  resumeStep,
  tutorialPending,
  writeTutorialFlag,
  type TutorialStorage,
} from '../src/game/tutorial';
import { PLAYER, TIMING } from '../src/config';

function mem(): TutorialStorage & { raw: Map<string, string> } {
  const raw = new Map<string, string>();
  return {
    raw,
    getItem: (k) => (raw.has(k) ? raw.get(k)! : null),
    setItem: (k, v) => {
      raw.set(k, v);
    },
  };
}

describe('tutorial flag', () => {
  it('stores done, skipped and in_progress under courtFeel.tutorial.v1', () => {
    const s = mem();
    expect(readTutorialFlag(s)).toBeNull();
    expect(tutorialPending(null)).toBe(true);
    writeTutorialFlag('in_progress:2', s);
    expect(s.raw.get(TUTORIAL_KEY)).toBe('in_progress:2');
    expect(readTutorialFlag(s)).toBe('in_progress:2');
    expect(resumeStep(readTutorialFlag(s))).toBe(2);
    expect(tutorialPending('in_progress:2')).toBe(true);
    writeTutorialFlag('done', s);
    expect(tutorialPending('done')).toBe(false);
    writeTutorialFlag('skipped', s);
    expect(tutorialPending('skipped')).toBe(false);
    expect(resumeStep('nope')).toBe(0);
    expect(resumeStep('in_progress:9')).toBe(0);
    expect(resumeStep('in_progress:6')).toBe(6);
  });
});

describe('tutorial gates', () => {
  it('welcome advances on its own, or sooner once they run', () => {
    const d = new TutorialDirector();
    d.begin(0);
    d.tick(2.7, false);
    expect(d.step).toBe(0);
    d.tick(0.2, false);
    expect(d.step).toBe(1);
    const run = new TutorialDirector();
    run.begin(0);
    run.tick(0.2, true);
    expect(run.step).toBe(0);
    run.tick(0.2, true);
    expect(run.step).toBe(1);
  });

  it('feet in the ring for 0.4s starts the toss, and waiting does not skip the gate', () => {
    const d = new TutorialDirector();
    d.begin(1);
    d.noteFeet(true, FEET_DWELL_S - 0.05);
    expect(d.step).toBe(1);
    d.noteFeet(false, 0.1);
    d.noteFeet(true, FEET_DWELL_S);
    expect(d.step).toBe(2);
    expect(d.holdingFeed()).toBe(false);
    const stuck = new TutorialDirector();
    stuck.begin(1);
    stuck.tick(30, false);
    expect(stuck.step).toBe(1);
  });

  it('freezes for the jump hold, rejects an early release, then takes the release', () => {
    const d = new TutorialDirector();
    d.begin(2);
    d.noteSetRising(true);
    expect(d.tutorTarget).toBe(TUTOR_SLOW);
    expect(d.onJumpPress()).toBe('block');
    d.notePlant(2, 1.2, true);
    expect(d.frozen).toBe(true);
    expect(d.gate).toBe('jump-load');
    expect(d.tutorTarget).toBe(0);
    expect(d.onJumpPress()).toBe('allow');
    expect(d.onJumpRelease()).toBe('cancel');
    expect(d.hint()).toBe('Keep holding — fill the ring');
    expect(d.frozen).toBe(true);
    const ready = jumpLoadFrac(PLAYER.loadMax);
    expect(ready).toBeGreaterThan(JUMP_GATE_LOAD);
    d.noteLoad(JUMP_GATE_LOAD, true);
    expect(d.gate).toBe('jump-release');
    expect(d.hint()).toContain('Release');
    expect(d.onJumpRelease()).toBe('allow');
    expect(d.frozen).toBe(false);
    expect(d.tutorTarget).toBe(TUTOR_SLOW);
    d.noteTakeoff();
    expect(d.step).toBe(3);
    expect(d.frozen).toBe(false);
  });

  it('freezes the arm draw, swallows an early release, then freezes the sweet spot', () => {
    const d = new TutorialDirector();
    d.begin(3);
    expect(d.onAttackPress()).toBe('block');
    d.noteSwingWindow(0.4, -0.4, true, 0);
    expect(d.frozen).toBe(false);
    d.noteSwingWindow(0.2, -0.2, true, 0);
    expect(d.gate).toBe('swing-draw');
    expect(d.frozen).toBe(true);
    expect(d.hint()).toBe(HINT_DRAW);
    expect(d.onAttackRelease()).toBe('cancel');
    expect(d.hint()).toBe('Hold until the ring closes');
    d.noteSwingWindow(0.2, -0.2, true, 1);
    expect(d.gate).toBe('swing-ride');
    expect(d.frozen).toBe(false);
    expect(d.tutorTarget).toBe(TUTOR_SLOW);
    expect(d.onAttackRelease()).toBe('keep');
    expect(d.gate).toBe('swing-rehold');
    expect(d.frozen).toBe(true);
    expect(d.onAttackPress()).toBe('allow');
    expect(d.gate).toBe('swing-ride');
    d.noteSwingWindow(0.05, SWING_SWEET_ERR, true, 1);
    expect(d.gate).toBe('swing-release');
    expect(d.frozen).toBe(true);
    expect(d.hint()).toBe(HINT_THROUGH);
    expect(d.onAttackRelease()).toBe('allow');
    expect(d.tutorTarget).toBe(1);
    d.noteContact('Perfect');
    expect(d.step).toBe(4);
    expect(d.hint().toLowerCase()).not.toContain('tip');
    expect(d.hint(false)).not.toContain('see that again');
    expect(d.hint(true)).toContain('see that again');
    expect(d.gradeSub('Early', 'x')).toBe("You're under the ball — it sails long");
    expect(d.gradeSub('Late', 'x')).toBe('Over the top — into the net');
  });

  it('a gate never auto-advances; after 6s it only asks for attention', () => {
    const d = new TutorialDirector();
    d.begin(2);
    d.notePlant(1, 0.5, true);
    let nudged = false;
    d.onStuck = () => (nudged = true);
    d.tick(GATE_NUDGE_S - 0.1, false);
    expect(d.gate).toBe('jump-load');
    expect(nudged).toBe(false);
    d.tick(0.1, false);
    expect(nudged).toBe(true);
    expect(d.step).toBe(2);
  });

  it('the solo rep has no freeze, and a second miss hands the court over', () => {
    const hit = new TutorialDirector();
    hit.begin(5);
    expect(hit.frozen).toBe(false);
    expect(hit.contactDip).toBe(true);
    hit.noteContact('Good');
    expect(hit.step).toBe(6);
    hit.tick(2.6, false);
    expect(hit.active).toBe(false);

    const misses = new TutorialDirector();
    misses.begin(5);
    misses.noteContact('Miss');
    misses.noteRepEnd();
    expect(misses.step).toBe(5);
    misses.noteContact('Miss');
    misses.noteRepEnd();
    expect(misses.step).toBe(6);
  });

  it('never teaches the tip', () => {
    const d = new TutorialDirector();
    for (const step of [0, 1, 2, 3, 4, 5, 6] as const) {
      d.begin(step);
      expect(d.hint().toLowerCase()).not.toContain('tip');
    }
  });
});

describe('timing collar', () => {
  it('places Perfect on the gold, Good on the cyan, and a mishit on the wood', () => {
    expect(collarZone(0)).toBe('perfect');
    expect(collarZone(SWING_SWEET_ERR)).toBe('perfect');
    expect(collarZone(-TIMING.spikePerfect)).toBe('perfect');
    expect(collarZone(TIMING.spikePerfectLate)).toBe('perfect');
    expect(collarZone(-TIMING.spikeGood)).toBe('good');
    expect(collarZone(TIMING.spikeGoodLate)).toBe('good');
    expect(collarZone(-0.15)).toBe('wood');
    expect(collarZone(0.13)).toBe('wood');
    // +0.015 s sits 6.75° to the right of 12 o'clock, inside the gold wedge
    expect(collarDegrees(SWING_SWEET_ERR)).toBeCloseTo(SWING_SWEET_ERR * COLLAR_DEG_PER_S, 5);
    expect(collarDegrees(-0.03)).toBeCloseTo(-13.5, 5);
    expect(collarDegrees(0.07)).toBeCloseTo(31.5, 5);
    expect(collarDegrees(-1)).toBe(-90);
    expect(collarDegrees(1)).toBe(72);
  });
});

describe('locked skip chip', () => {
  it('a direct move from the lock anchor onto the chip counts, looking around does not', () => {
    // measured in Chrome: lock at (400, 300), one move of (777, -272) lands on the chip
    const x = 400 + 777;
    const y = 300 - 272;
    const travel = Math.hypot(777, -272);
    expect(isDirectLockedTravel(400, 300, x, y, travel)).toBe(true);
    // the same landing after wandering across the court is a swing, not Skip
    expect(isDirectLockedTravel(400, 300, x, y, travel * 4)).toBe(false);
    expect(isDirectLockedTravel(400, 300, x, y, 0)).toBe(false);
    expect(isDirectLockedTravel(400, 300, 400, 300, 0)).toBe(true);
  });
});

describe('tutorial touch labels', () => {
  it('maps Left mouse to HIT and Space to JUMP, matching the step 2 and 3 mocks', () => {
    expect(TOUCH_KEY_LABELS['Left mouse']).toBe('HIT');
    expect(TOUCH_KEY_LABELS.LMB).toBe('HIT');
    expect(TOUCH_KEY_LABELS.Space).toBe('JUMP');
    expect(translateKeyMarkup(HINT_LOAD, TOUCH_KEY_LABELS)).toBe('Hold <kbd>JUMP</kbd> — load the jump');
    expect(translateKeyMarkup(HINT_THROUGH, TOUCH_KEY_LABELS)).toBe('Now — release <kbd>HIT</kbd> through the ball');
    const feet = `Run in — hold <kbd>Shift</kbd>+<kbd>W</kbd>. Stop on the ring.`;
    expect(translateKeyMarkup(feet, TOUCH_KEY_LABELS)).toBe('Run in — hold <kbd>stick out</kbd>. Stop on the ring.');
  });
});
