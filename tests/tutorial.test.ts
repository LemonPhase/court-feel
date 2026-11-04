import { describe, expect, it } from 'vitest';
import { isDirectLockedTravel } from '../src/core/input';
import { TOUCH_KEY_LABELS } from '../src/ui/touchControls';
import { translateKeyMarkup } from '../src/ui/hud';
import {
  FAIL_FORWARD_TRIES,
  FEET_DWELL_S,
  FEET_GIVE_UP_S,
  HINT_JUMP,
  HINT_SWING,
  TUTORIAL_KEY,
  TutorialDirector,
  readTutorialFlag,
  resumeStep,
  tutorialPending,
  writeTutorialFlag,
  type TutorialStorage,
} from '../src/game/tutorial';

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

describe('tutorial steps', () => {
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

  it('feet in the ring for ~0.4s starts the set; wandering resets; 10s fail-forwards', () => {
    const d = new TutorialDirector();
    d.begin(1);
    d.noteFeet(true, FEET_DWELL_S - 0.05);
    expect(d.step).toBe(1);
    d.noteFeet(false, 0.1);
    d.noteFeet(true, 0.2);
    expect(d.step).toBe(1);
    d.noteFeet(true, FEET_DWELL_S);
    expect(d.step).toBe(2);
    expect(d.holdingFeed()).toBe(false);

    const give = new TutorialDirector();
    give.begin(1);
    give.tick(FEET_GIVE_UP_S - 0.1, false);
    expect(give.step).toBe(1);
    expect(give.holdingFeed()).toBe(true);
    give.tick(0.1, false);
    expect(give.step).toBe(2);
  });

  it('a live takeoff teaches the swing on the same ball; three missed reps fail forward', () => {
    const d = new TutorialDirector();
    d.begin(2);
    expect(d.hint()).toBe(HINT_JUMP);
    d.noteTakeoff(false);
    expect(d.step).toBe(2);
    expect(d.hint()).toBe('Jump as the set rises — try again.');
    d.noteTakeoff(true);
    expect(d.step).toBe(3);
    expect(d.hint()).toBe(HINT_SWING);

    const miss = new TutorialDirector();
    miss.begin(2);
    miss.noteRepEnd();
    miss.noteRepEnd();
    expect(miss.step).toBe(2);
    miss.noteRepEnd();
    expect(miss.step).toBe(3);
    expect(miss.attempts).toBe(0);
  });

  it('any contact reads the grade; three swings with no touch skip ahead', () => {
    for (const grade of ['Perfect', 'Good', 'Early', 'Late', 'Miss'] as const) {
      const d = new TutorialDirector();
      d.begin(3);
      d.noteContact(grade);
      expect(d.step).toBe(4);
      expect(d.hint().toLowerCase()).not.toContain('tip');
    }
    const perfect = new TutorialDirector();
    perfect.begin(3);
    perfect.noteContact('Perfect');
    expect(perfect.hint()).toContain('Perfect = early enough that the arm is still coming through.');
    expect(perfect.hint()).toContain('see that again');
    expect(perfect.gradeSub('Early', 'Swing early')).toBe('Too early — wait for the ball');
    expect(perfect.gradeSub('Late', 'Swing late')).toBe('Late — swing sooner next time');
    expect(perfect.gradeSub('Good', '80 km/h')).toBe('80 km/h');

    const whiff = new TutorialDirector();
    whiff.begin(3);
    for (let i = 0; i < FAIL_FORWARD_TRIES - 1; i++) whiff.noteRepEnd();
    expect(whiff.step).toBe(3);
    whiff.noteRepEnd();
    expect(whiff.step).toBe(5);

    const read = new TutorialDirector();
    read.begin(3);
    read.noteContact('Good');
    read.noteRepEnd();
    expect(read.step).toBe(5);
    expect(read.label()).toBe('YOUR REP');
  });

  it('one Good+ finishes the alone rep; three attempts hand the court over', () => {
    const hit = new TutorialDirector();
    hit.begin(5);
    hit.noteContact('Early');
    expect(hit.step).toBe(5);
    hit.noteContact('Good');
    expect(hit.step).toBe(6);
    expect(hit.label()).toBe("You're on the court.");
    hit.tick(2.6, false);
    expect(hit.active).toBe(false);

    const tries = new TutorialDirector();
    tries.begin(5);
    tries.noteContact('Miss');
    tries.noteRepEnd();
    tries.noteContact('Late');
    tries.noteRepEnd();
    expect(tries.step).toBe(5);
    tries.noteRepEnd();
    expect(tries.step).toBe(6);
  });

  it('never teaches the tip, and skip drops the lesson', () => {
    const d = new TutorialDirector();
    for (const step of [0, 1, 2, 3, 4, 5, 6] as const) {
      d.begin(step);
      expect(d.hint().toLowerCase()).not.toContain('tip');
      expect((d.label() ?? '').toLowerCase()).not.toContain('tip');
    }
    d.begin(3);
    d.skip();
    expect(d.active).toBe(false);
    expect(d.holdingFeed()).toBe(false);
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
    expect(translateKeyMarkup(HINT_JUMP, TOUCH_KEY_LABELS)).toBe('Hold <kbd>JUMP</kbd> to load the jump, release to leave the floor');
    expect(translateKeyMarkup(HINT_SWING, TOUCH_KEY_LABELS)).toBe('Hold <kbd>HIT</kbd> to draw the arm, release through the ball');
    const feet = `Run in — hold <kbd>Shift</kbd>+<kbd>W</kbd>. Stop on the ring.`;
    expect(translateKeyMarkup(feet, TOUCH_KEY_LABELS)).toBe('Run in — hold <kbd>stick out</kbd>. Stop on the ring.');
  });
});
