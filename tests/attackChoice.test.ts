import { describe, expect, it } from 'vitest';
import { AI } from '../src/config';
import { Athlete } from '../src/game/athlete';
import { laneFor } from '../src/game/plays';
import { HitterBrain } from '../src/ai/hitter';

/** shots an outside hitter (home side) picks over a sweep of the rng, against `blockers` */
function shots(inSystem: boolean, blockers: Athlete[]) {
  const a = new Athlete('OH', 1);
  a.place(-4.0, 1.0, 0);
  const brain = new HitterBrain(a, laneFor('OH', 1));
  brain.inSystem = () => inSystem;
  brain.blockers = () => blockers;
  const seen = new Set<string>();
  for (let i = 0; i < 200; i++) {
    const r = (i + 0.5) / 200;
    const g = { rng: { next: () => r, gauss: () => 0 } } as any;
    brain.chooseAim(g, -4.0);
    seen.add(brain.lastShot);
  }
  return seen;
}

/** a blocker on the far side at the net, x along it */
function blocker(x: number) {
  const b = new Athlete('MB', -1);
  b.place(x, -0.4, Math.PI);
  return b;
}

describe('attack shot choice (Mini Rally AI)', () => {
  it('off a bad pass, with a block up, the hitter uses it: off the hands or rolled over', () => {
    // one blocker on the line: the cross is still open
    const seen = shots(false, [blocker(-4.2)]);
    expect(seen.has('tool')).toBe(true);
    expect(seen.has('roll')).toBe(true);
  });

  it('in system, with the cross open, the hitter just hits round the single block', () => {
    const seen = shots(true, [blocker(-4.2)]);
    expect(seen.has('tool')).toBe(false);
    expect(seen.has('roll')).toBe(false);
  });

  it('on a good pass a pin hitter can run a fast set: already running when the setter touches it, met about 1 s later', () => {
    const a = new Athlete('OH', 1);
    const lane = laneFor('OH', 1);
    a.place(lane.sx, lane.sz, 0);
    const brain = new HitterBrain(a, lane);
    const touch = { kind: 'pass', side: 1, t: 0 };
    // the pass reaches the setter's hands 0.9 s from now
    brain.passToSetter = () => ({ t: 0.9, x: 1.0 });
    const g = { simTime: 0, rng: { next: () => 0, gauss: () => 0 }, ball: { active: true, lastTouch: touch } } as any;
    brain.step(1 / 120, g);
    expect(brain.phase).toBe('approach');
    const f = brain.tempoBall!;
    expect(f).not.toBeNull();
    expect(f.t - 0.9).toBeCloseTo(AI.tempo.flight, 2);
    // met at the pin, inside the antenna
    expect(Math.abs(f.contact.x - lane.x)).toBeLessThan(0.3);
    // the run starts before the setter's touch: a fast set leaves no time to start after it
    expect(brain.plan!.tStart).toBeLessThan(0.9);
  });

  it('a pin hitter does not run a fast set every time: the rest wait for a high ball', () => {
    const a = new Athlete('OPP', 1);
    const lane = laneFor('OPP', 1);
    a.place(lane.sx, lane.sz, 0);
    const brain = new HitterBrain(a, lane);
    brain.passToSetter = () => ({ t: 0.9, x: 1.0 });
    const g = {
      simTime: 0,
      rng: { next: () => AI.tempo.share + 0.01, gauss: () => 0 },
      ball: { active: true, lastTouch: { kind: 'pass', side: 1, t: 0 } },
    } as any;
    brain.step(1 / 120, g);
    expect(brain.phase).toBe('ready');
    expect(brain.tempoBall).toBeNull();
  });
});
