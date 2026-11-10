import { describe, expect, it } from 'vitest';
import { POSITIONS, type PositionId } from '../src/config';
import { MODE_INFO, type ModeId } from '../src/game/modes/mode';
import { athleteStats, STAT_STRONG } from '../src/ui/athleteStats';
import { SET_PLAYS } from '../src/game/plays';
import { ALL_CONTROLS, DRILL_INFO, HITTERS, PLAY_MODES, TRAIN_MODES } from '../src/ui/drillInfo';

const MODES = Object.keys(MODE_INFO) as ModeId[];
const tierOf = (stats: ReturnType<typeof athleteStats>, id: PositionId, label: string) => stats[id].find((s) => s.label === label)!.tier;

describe('menu: where each mode lives', () => {
  it('every mode is under Train or Play, once', () => {
    const listed = [...TRAIN_MODES, ...PLAY_MODES];
    expect([...listed].sort()).toEqual([...MODES].sort());
    expect(new Set(listed).size).toBe(listed.length);
  });

  it('the six-a-side rally is a game, and the single-skill drills are under Train', () => {
    expect(PLAY_MODES).toContain('rally');
    for (const id of ['spike', 'block', 'receive', 'setter', 'free'] as ModeId[]) expect(TRAIN_MODES).toContain(id);
  });

  it('every mode says what it is and lists its own keys, for the keyboard and for touch', () => {
    for (const id of MODES) {
      const d = DRILL_INFO[id];
      expect(d.short.length, id).toBeGreaterThan(0);
      expect(d.about.length, id).toBeGreaterThan(0);
      expect(d.scored.length, id).toBeGreaterThan(0);
      expect(d.keys.length, id).toBeGreaterThan(0);
      expect(d.touch.length, id).toBeGreaterThan(0);
      // only its own keys: the full list is under Learn
      expect(d.keys.length, id).toBeLessThanOrEqual(6);
    }
  });

  it('the Spike Drill names the approach, the jump and the swing', () => {
    const keys = DRILL_INFO.spike.keys.map((k) => k.k);
    expect(keys).toEqual(expect.arrayContaining(['Shift + W', 'Space', 'Left mouse']));
  });

  it('set calls are shown to the positions that have plays to call, and to no one else', () => {
    expect([...HITTERS].sort()).toEqual(Object.keys(SET_PLAYS).sort());
    for (const id of MODES) {
      for (const k of [...DRILL_INFO[id].keys, ...DRILL_INFO[id].touch]) {
        if (/call your set/i.test(k.a)) expect(k.hitters, `${id}: ${k.k}`).toBe(true);
      }
    }
    // the drills with set calls are the ones that read them
    expect(DRILL_INFO.spike.keys.some((k) => k.hitters)).toBe(true);
    expect(DRILL_INFO.rally.keys.some((k) => k.hitters)).toBe(true);
    expect(DRILL_INFO.block.keys.some((k) => k.hitters)).toBe(false);
  });

  it('Learn lists the same groups for the keyboard and for touch', () => {
    expect(ALL_CONTROLS.kb.map((g) => g.title)).toEqual(ALL_CONTROLS.touch.map((g) => g.title));
  });
});

describe('athlete: the stat bars', () => {
  const stats = athleteStats({});

  it('every position has jump, speed, power and control, in real units', () => {
    for (const id of Object.keys(POSITIONS) as PositionId[]) {
      expect(stats[id].map((s) => s.label)).toEqual(['Jump', 'Speed', 'Power', 'Control']);
      for (const s of stats[id]) {
        expect(s.frac).toBeGreaterThan(0);
        expect(s.frac).toBeLessThanOrEqual(1);
      }
    }
    expect(stats.OH.map((s) => s.value)).toEqual(['86 cm', '5.3 m/s', '108 km/h', '75']);
  });

  it('the opposite has the best jump and power, the libero the best feet and control', () => {
    expect(tierOf(stats, 'OPP', 'Jump')).toBe('best');
    expect(tierOf(stats, 'OPP', 'Power')).toBe('best');
    expect(tierOf(stats, 'L', 'Speed')).toBe('best');
    expect(tierOf(stats, 'L', 'Control')).toBe('best');
  });

  it('each stat has exactly one best with the default bodies', () => {
    for (const label of ['Jump', 'Speed', 'Power', 'Control']) {
      const best = (Object.keys(POSITIONS) as PositionId[]).filter((id) => tierOf(stats, id, label) === 'best');
      expect(best, label).toHaveLength(1);
    }
  });

  it("strong starts at the threshold, and below it a stat is not the position's job", () => {
    expect(tierOf(stats, 'OH', 'Jump')).toBe('strong');
    expect(tierOf(stats, 'MB', 'Control')).toBe('base');
    for (const id of Object.keys(POSITIONS) as PositionId[]) {
      for (const s of stats[id]) {
        if (s.tier === 'strong') expect(s.frac).toBeGreaterThanOrEqual(STAT_STRONG);
        if (s.tier === 'base') expect(s.frac).toBeLessThan(STAT_STRONG);
      }
    }
  });

  it('a custom body moves the bars: a setter given a 100 cm vert out-jumps the opposite', () => {
    const custom = athleteStats({ S: { height: 1.9, jump: 1.0, power: 0.82 } });
    expect(tierOf(custom, 'S', 'Jump')).toBe('best');
    expect(tierOf(custom, 'OPP', 'Jump')).toBe('strong');
    expect(custom.S[0].value).toBe('100 cm');
    // only your body's stats change
    expect(custom.S[1]).toEqual(stats.S[1]);
  });
});
