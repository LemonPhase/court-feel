import { describe, expect, it } from 'vitest';
import {
  AI,
  ASSIST,
  BALL,
  BODY,
  CONTACT,
  DEFAULT_SETTINGS,
  PLAYER,
  POSITIONS,
  RANKED,
  SCORING,
  TIMING,
  type PositionId,
  type Settings,
} from '../src/config';
import { parseLaunchParams } from '../src/core/launch';
import { boardSeed, hash32, rankedBoard, RankedRun, repSeed, spikeScript } from '../src/game/ranked';
import { boardFor, RANKED_MODES } from '../src/game/boards';
import { SET_PLAYS } from '../src/game/plays';

const settings = (over: Partial<Settings> = {}): Settings => ({ ...DEFAULT_SETTINGS, bodies: {}, ...over });

/** a run with `n` reps recorded, each scoring `pts` */
function runWith(n: number, pts: number, s = settings()): RankedRun {
  const run = new RankedRun('spike', 'OH', s);
  for (let i = 0; i < n; i++) run.record({ points: pts, label: 'KILL', grade: 'Good', kmh: 80 });
  return run;
}

describe('ranked run: the same balls for everyone', () => {
  it('rep 7 has the same seed whatever happened in reps 1-6', () => {
    const a = runWith(6, 300);
    const b = new RankedRun('spike', 'OH', settings());
    for (let i = 0; i < 6; i++) b.skip();
    expect(a.seedFor(6)).toBe(b.seedFor(6));
    expect(a.seedFor(a.current)).toBe(b.seedFor(b.current));
  });

  it('every board and every rep gets its own seed', () => {
    const seeds = new Set<number>();
    for (const mode of ['spike', 'block', 'receive', 'setter'] as const)
      for (const pos of Object.keys(POSITIONS) as PositionId[]) {
        const board = boardSeed(mode, pos);
        for (let k = 0; k < RANKED.reps; k++) seeds.add(repSeed(board, k));
      }
    expect(seeds.size).toBe(4 * 5 * RANKED.reps);
  });

  it('the seeds are fixed numbers, the same in every browser', () => {
    expect(hash32('spike', 'OH')).toBe(hash32('spike', 'OH'));
    expect(hash32('spike', 'OH')).not.toBe(hash32('spike', 'OPP'));
    expect(Number.isInteger(hash32(1, 2))).toBe(true);
    expect(hash32(1, 2)).toBeGreaterThanOrEqual(0);
    expect(hash32(1, 2)).toBeLessThan(2 ** 32);
    // different season, different balls
    expect(boardSeed('spike', 'OH', 1)).not.toBe(boardSeed('spike', 'OH', 2));
  });
});

describe('ranked run: 20 reps, N counts', () => {
  it('a run is over after rep 20, not before', () => {
    expect(RANKED.reps).toBe(20);
    expect(runWith(19, 100).done).toBe(false);
    expect(runWith(20, 100).done).toBe(true);
  });

  it('N scores the rep as 0 and still counts towards the 20', () => {
    const run = runWith(3, 100);
    run.skip();
    expect(run.reps).toHaveLength(4);
    expect(run.reps[3]).toMatchObject({ points: 0, label: 'SKIPPED', skipped: true });
    expect(run.total).toBe(300);
    for (let i = 0; i < 16; i++) run.skip();
    expect(run.done).toBe(true);
  });

  it('nothing is recorded after the last rep', () => {
    const run = runWith(20, 100);
    run.record({ points: 999, label: 'KILL', grade: 'Perfect', kmh: 100 });
    run.skip();
    expect(run.reps).toHaveLength(20);
    expect(run.total).toBe(2000);
  });

  it('the total, the Perfect count and the per-rep breakdown add up', () => {
    const run = new RankedRun('block', 'MB', settings());
    run.record({ points: 150, label: 'STUFF BLOCK!', grade: 'Perfect', kmh: null });
    run.record({ points: 60, label: 'SOFT BLOCK · TOUCH', grade: 'Good', kmh: null });
    run.record({ points: 0, label: 'KILLED', grade: null, kmh: null });
    run.skip();
    expect(run.total).toBe(210);
    expect(run.perfects).toBe(1);
    expect(run.reps.reduce((s, r) => s + r.points, 0)).toBe(run.total);
  });
});

describe('ranked run: locked settings', () => {
  const changes: [string, Partial<Settings>][] = [
    ['aim assist', { aimAssist: 0.3 }],
    ['slow-mo assist', { slowmoAssist: true }],
    ["the women's net", { womenNet: true }],
    ['your custom body', { bodies: { OH: { height: 2.1, jump: 0.8, power: 1 } } }],
  ];
  for (const [what, over] of changes) {
    it(`changing ${what} mid-run makes the run unranked`, () => {
      const s = settings();
      const run = new RankedRun('spike', 'OH', s);
      expect(run.checkSettings(s)).toBe(false);
      Object.assign(s, over);
      expect(run.checkSettings(s)).toBe(true);
      expect(run.unranked).toBe(true);
      // it stays unranked, and says so only once
      expect(run.checkSettings(s)).toBe(false);
      expect(run.unranked).toBe(true);
    });
  }

  it('changing the camera, FOV, sensitivity, volume, hints or hand keeps it ranked', () => {
    const s = settings();
    const run = new RankedRun('spike', 'OH', s);
    Object.assign(s, { firstPerson: true, fov: 90, sensitivity: 2, volume: 0.1, showHints: false, hand: 'left', shake: 0 });
    expect(run.checkSettings(s)).toBe(false);
    expect(run.unranked).toBe(false);
  });

  it("a custom body for another position doesn't matter", () => {
    const s = settings();
    const run = new RankedRun('spike', 'OH', s);
    s.bodies.MB = { height: 2.1, jump: 0.8, power: 1 };
    expect(run.checkSettings(s)).toBe(false);
  });

  it('aim assist is locked to the default', () => {
    expect(RANKED.aimAssist).toBe(ASSIST.aim);
    expect(RANKED.aimAssist).toBe(DEFAULT_SETTINGS.aimAssist);
  });
});

describe('ranked run: the Spike Drill script', () => {
  const seed = boardSeed('spike', 'OH');

  it('the script covers exactly the 20 reps', () => {
    expect(RANKED.spikeScript.reduce((n, s) => n + s.reps, 0)).toBe(RANKED.reps);
  });

  it('reps 1-5 call 1 with no block, 6-10 call 2, 11-15 call 1 against a single block, 16-20 a mix against a double', () => {
    for (let k = 0; k < 5; k++) expect(spikeScript(k, repSeed(seed, k), 3)).toMatchObject({ call: 0, block: 0 });
    for (let k = 5; k < 10; k++) expect(spikeScript(k, repSeed(seed, k), 3)).toMatchObject({ call: 1, block: 0 });
    for (let k = 10; k < 15; k++) expect(spikeScript(k, repSeed(seed, k), 3)).toMatchObject({ call: 0, block: 1 });
    const mixed = new Set<number>();
    for (let k = 15; k < 20; k++) {
      const s = spikeScript(k, repSeed(seed, k), 3);
      expect(s.block).toBe(2);
      expect(s.call).toBeGreaterThanOrEqual(0);
      expect(s.call).toBeLessThan(3);
      mixed.add(s.call);
    }
    // a mix, not five of the same call (true for this season's OH board)
    expect(mixed.size).toBeGreaterThan(1);
  });

  it('the mixed calls are the same for everyone', () => {
    for (let k = 15; k < 20; k++) expect(spikeScript(k, repSeed(seed, k), 3)).toEqual(spikeScript(k, repSeed(seed, k), 3));
  });

  it('a position without set calls follows only the block column', () => {
    for (const pos of ['S', 'L'] as const) {
      expect(SET_PLAYS[pos]).toBeUndefined();
      for (let k = 0; k < RANKED.reps; k++) expect(spikeScript(k, repSeed(boardSeed('spike', pos), k), 0).call).toBe(0);
    }
    expect(spikeScript(17, 1, 0).block).toBe(2);
  });
});

describe('ranked run: boards', () => {
  it('the Spike Drill has a ranked board for every position', () => {
    for (const pos of Object.keys(POSITIONS) as PositionId[]) expect(rankedBoard('spike', pos)).toEqual({ mode: 'spike', pos });
  });

  it('the Block, Serve Receive and Setter drills are practice only for now', () => {
    expect(RANKED_MODES).toEqual(['spike']);
    for (const mode of ['block', 'receive', 'setter']) expect(rankedBoard(mode, 'OH')).toBeNull();
  });

  it('a libero has no Block Drill board (a libero may not block)', () => {
    expect(boardFor('block', 'L')).toBeNull();
    expect(boardFor('block', 'MB')).toEqual({ mode: 'block', pos: 'MB' });
  });

  it("the Setter Drill board is the setter's, whatever position is picked", () => {
    for (const pos of Object.keys(POSITIONS) as PositionId[]) expect(boardFor('setter', pos)).toEqual({ mode: 'setter', pos: 'S' });
  });

  it('Free Play and Mini Rally have no ranked run', () => {
    expect(rankedBoard('free', 'OH')).toBeNull();
    expect(rankedBoard('rally', 'OH')).toBeNull();
  });

  it("?ranked=spike&pos=OH starts a ranked Spike Drill, ?ranked=weekly this week's board; anything else is ignored", () => {
    expect(parseLaunchParams('?ranked=spike&pos=MB')).toMatchObject({ mode: 'spike', pos: 'MB', ranked: 'season' });
    expect(parseLaunchParams('?ranked=weekly')).toMatchObject({ mode: 'spike', ranked: 'weekly' });
    expect(parseLaunchParams('?mode=block&ranked=receive')).toMatchObject({ mode: 'block', ranked: null });
    expect(parseLaunchParams('?mode=spike')?.ranked).toBeNull();
    expect(parseLaunchParams('?mode=spike&ranked=rally')).toMatchObject({ mode: 'spike', ranked: null });
    expect(parseLaunchParams('?ranked=nope')).toBeNull();
  });
});

/**
 * The ranked ruleset: scores only compare while the scoring and the difficulty stay the same.
 * Changing any of these sections without bumping RANKED.ruleset fails here.
 */
const RULESET_HASHES: Record<number, number> = {
  1: 860747682,
};

describe('ranked ruleset', () => {
  it('the ranked ruleset changes only with a version bump', () => {
    const { ruleset, ...rules } = RANKED;
    const text = JSON.stringify({ TIMING, CONTACT, ASSIST, PLAYER, POSITIONS, BODY, BALL, AI, SCORING, rules });
    const h = hash32(text);
    expect(
      h,
      `Ranked scoring or difficulty changed (hash ${h}). Bump RANKED.ruleset in config.ts (a new season) and record ` +
        `${h} for it in RULESET_HASHES in tests/ranked.test.ts.`,
    ).toBe(RULESET_HASHES[ruleset]);
  });
});
