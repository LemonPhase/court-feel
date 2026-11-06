import { describe, expect, it } from 'vitest';
import { DEFAULT_SETTINGS, RANKED, type Settings } from '../src/config';
import { beats, bestFrom, loadBests, sanitizeBests, saveBest, type BestRun } from '../src/game/bests';
import { boardId as bestKey } from '../src/game/boards';
import { RankedRun, repMark } from '../src/game/ranked';

const settings = (): Settings => ({ ...DEFAULT_SETTINGS, bodies: {} });

/** a finished-or-not run with these points per rep */
function run(points: number[]): RankedRun {
  const r = new RankedRun('spike', 'OH', settings());
  for (const p of points) r.record({ points: p, label: 'KILL', grade: p >= 200 ? 'Perfect' : 'Good', kmh: 90 });
  return r;
}

const best = (reps: number[], perfects = 0, bestStreak = 0): BestRun => ({
  total: reps.reduce((s, p) => s + p, 0),
  reps,
  perfects,
  bestStreak,
  at: 1,
});

/** an in-memory stand-in for localStorage */
function memoryStorage() {
  const m = new Map<string, string>();
  return { getItem: (k: string) => m.get(k) ?? null, setItem: (k: string, v: string) => void m.set(k, v), map: m };
}

describe('personal bests: the live split', () => {
  it("your split is your total minus your best's total after the same number of reps", () => {
    const r = run([288, 150]);
    r.best = best([100, 100, 288, 288]);
    // 438 after two reps against 200 after two reps
    expect(r.split).toBe(238);
    r.record({ points: 0, label: 'BLOCKED', grade: 'Perfect', kmh: 100 });
    // 438 against 488 after three
    expect(r.split).toBe(-50);
  });

  it('no best yet, or no rep played yet: no split', () => {
    expect(run([288]).split).toBeNull();
    const r = run([]);
    r.best = best([100]);
    expect(r.split).toBeNull();
  });

  it('a skipped rep counts against you in the split', () => {
    const r = run([100]);
    r.best = best([100, 100]);
    r.skip();
    expect(r.split).toBe(-100);
  });
});

describe('personal bests: what beats your best', () => {
  it('no best yet: any finished run is your best', () => {
    expect(beats(run([10]), null)).toBe(true);
  });

  it('a higher total beats it, a lower one does not', () => {
    expect(beats(run([300]), best([299]))).toBe(true);
    expect(beats(run([298]), best([299]))).toBe(false);
  });

  it('an equal total needs more Perfects, then a longer streak; a full tie keeps the earlier run', () => {
    const r = run([200, 100]); // 1 Perfect
    r.bestStreak = 2;
    expect(beats(r, best([150, 150], 0, 9))).toBe(true);
    expect(beats(r, best([150, 150], 2, 0))).toBe(false);
    expect(beats(r, best([150, 150], 1, 1))).toBe(true);
    expect(beats(r, best([150, 150], 1, 2))).toBe(false);
  });

  it('a best keeps the per-rep points, so later runs can be split against it', () => {
    const r = run([288, 0, 150]);
    r.bestStreak = 1;
    expect(bestFrom(r, 42)).toEqual({ total: 438, reps: [288, 0, 150], perfects: 1, bestStreak: 1, at: 42 });
  });
});

describe('personal bests: storage', () => {
  it('each board, each ruleset and each weekly board keeps its own best', () => {
    const keys = new Set([
      bestKey('spike', 'OH'),
      bestKey('spike', 'OPP'),
      bestKey('block', 'OH'),
      bestKey('spike', 'OH', null, RANKED.ruleset + 1),
      bestKey('spike', 'OH', '2026-W45'),
    ]);
    expect(keys.size).toBe(5);
  });

  it('bests survive a save and a load', () => {
    const s = memoryStorage();
    saveBest(bestKey('spike', 'OH'), best([288, 150], 1, 2), s);
    saveBest(bestKey('receive', 'L'), best([100]), s);
    const loaded = loadBests(s);
    expect(loaded[bestKey('spike', 'OH')]).toEqual(best([288, 150], 1, 2));
    expect(loaded[bestKey('receive', 'L')].total).toBe(100);
  });

  it('stored bests are untrusted: malformed entries are dropped, good ones kept', () => {
    const good = best([288, 150], 1, 2);
    const out = sanitizeBests({
      good,
      noReps: { ...good, reps: undefined },
      wrongTotal: { ...good, total: 9999 },
      nanPoint: { ...good, reps: [Number.NaN, 1] },
      tooLong: { ...good, reps: new Array(RANKED.reps + 1).fill(0), total: 0 },
      negative: { ...good, perfects: -1 },
      notObject: 'cheese',
    });
    expect(Object.keys(out)).toEqual(['good']);
    expect(sanitizeBests(null)).toEqual({});
    expect(sanitizeBests([good])).toEqual({});
  });

  it('broken or missing storage loads as no bests', () => {
    expect(loadBests({ getItem: () => '{not json', setItem: () => {} })).toEqual({});
    expect(
      loadBests({
        getItem: () => {
          throw new Error('blocked');
        },
        setItem: () => {},
      }),
    ).toEqual({});
  });
});

describe('the 20-rep strip', () => {
  it('a rep is marked by how it went: Perfect, Good, a weak contact, or nothing', () => {
    expect(repMark({ points: 288, label: 'KILL', grade: 'Perfect', kmh: 108, skipped: false })).toBe('perfect');
    expect(repMark({ points: 60, label: 'SOFT BLOCK', grade: 'Good', kmh: null, skipped: false })).toBe('good');
    expect(repMark({ points: 80, label: 'KILL', grade: 'Early', kmh: 90, skipped: false })).toBe('weak');
    expect(repMark({ points: 10, label: 'HITTER ERROR', grade: null, kmh: null, skipped: false })).toBe('weak');
    // no points is a lost rep, however clean the contact was (a Perfect swing into the block)
    expect(repMark({ points: 0, label: 'BLOCKED', grade: 'Perfect', kmh: 104, skipped: false })).toBe('zero');
    expect(repMark({ points: 0, label: 'SKIPPED', grade: null, kmh: null, skipped: true })).toBe('zero');
  });
});
