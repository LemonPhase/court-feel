import { describe, expect, it } from 'vitest';
import { DEFAULT_SETTINGS, RANKED, type Settings } from '../src/config';
import { boardId, medalFor, nextMedal, parseBoardId, seasonBoards, weekOf, weeklyBoard } from '../src/game/boards';
import { RankedRun } from '../src/game/ranked';
import { cleanName, rankScore, validateRun, type BoardView, type MedalView, type SubmitResult } from '../src/net/protocol';
import { createHandler, MemoryStore } from '../src/net/server';
import { shareText } from '../src/ui/share';

const NOW = Date.UTC(2026, 10, 5, 18, 0); // Thursday 5 November 2026, week 45
const settings = (): Settings => ({ ...DEFAULT_SETTINGS, bodies: {} });

/** a valid submission: 20 reps of `pts`, from player `id` */
function run(id: string, pts: number, over: Record<string, unknown> = {}) {
  return {
    board: boardId('spike', 'OH'),
    player: id,
    name: `Player ${id.slice(-2)}`,
    reps: new Array(RANKED.reps).fill(pts),
    perfects: 5,
    bestStreak: 3,
    ms: 150_000,
    cam: 'tp',
    input: 'mouse',
    hand: 'right',
    build: 'test',
    ...over,
  };
}

/** a leaderboard over memory, with a clock the test moves */
function server() {
  let now = NOW;
  const handler = createHandler(new MemoryStore(() => now), { prefix: 't', now: () => now });
  const post = async (body: unknown, ip = '1.2.3.4') => {
    const res = await handler(
      new Request('http://x/api/leaderboard', { method: 'POST', body: JSON.stringify(body), headers: { 'x-forwarded-for': ip } }),
    );
    return { status: res.status, body: (await res.json()) as SubmitResult & { error?: string } };
  };
  const get = async (query: string) => {
    const res = await handler(new Request(`http://x/api/leaderboard?${query}`));
    return { status: res.status, body: (await res.json()) as BoardView & MedalView & { error?: string } };
  };
  return { post, get, wait: (s: number) => (now += s * 1000) };
}

describe('the weekly board', () => {
  it('weeks are ISO weeks, Monday to Sunday (UTC)', () => {
    expect(weekOf(NOW).id).toBe('2026-W45');
    expect(weekOf(Date.UTC(2026, 0, 1)).id).toBe('2026-W01');
    // Sunday 28 December 2025 is still the last week of 2025; 1 January 2027 (a Friday) is in 2026's week 53
    expect(weekOf(Date.UTC(2025, 11, 28)).id).toBe('2025-W52');
    expect(weekOf(Date.UTC(2027, 0, 1)).id).toBe('2026-W53');
    // Sunday night and Monday morning are a week apart
    expect(weekOf(Date.UTC(2026, 10, 9)).index - weekOf(Date.UTC(2026, 10, 8, 23, 59)).index).toBe(1);
  });

  it('the featured position changes every week and comes round every five weeks', () => {
    const start = weekOf(NOW).index;
    const seen = Array.from({ length: 5 }, (_, i) => weeklyBoard({ index: start + i }).pos);
    expect(new Set(seen).size).toBe(5);
    expect(weeklyBoard({ index: start + 5 }).pos).toBe(seen[0]);
    expect(weeklyBoard({ index: -3 }).mode).toBe('spike');
  });

  it("a weekly board has its own balls, different from the season board's", () => {
    const season = new RankedRun('spike', 'OH', settings());
    const week = new RankedRun('spike', 'OH', settings(), '2026-W45');
    const next = new RankedRun('spike', 'OH', settings(), '2026-W46');
    expect(week.seedFor(0)).not.toBe(season.seedFor(0));
    expect(week.seedFor(0)).not.toBe(next.seedFor(0));
    expect(week.board).toBe('1:spike:OH:2026-W45');
    expect(season.board).toBe('1:spike:OH');
  });
});

describe('medals', () => {
  it('bronze, silver and gold at the position thresholds; nothing below bronze', () => {
    const [bronze, silver, gold] = RANKED.medals.OH;
    expect(medalFor(bronze - 1, 'OH')).toBeNull();
    expect(medalFor(bronze, 'OH')).toBe('bronze');
    expect(medalFor(silver, 'OH')).toBe('silver');
    expect(medalFor(gold + 500, 'OH')).toBe('gold');
    expect(nextMedal(bronze, 'OH')).toEqual({ medal: 'silver', at: silver });
    // no Coach run set yet: gold is the top
    expect(nextMedal(gold, 'OH')).toBeNull();
  });

  it('each position has its own, rising thresholds', () => {
    for (const b of seasonBoards()) {
      const [bronze, silver, gold] = RANKED.medals[b.pos];
      expect(bronze).toBeLessThan(silver);
      expect(silver).toBeLessThan(gold);
    }
    // a libero's pipe scores less than an outside's high ball, so its gold comes lower
    expect(RANKED.medals.L[2]).toBeLessThan(RANKED.medals.OH[2]);
  });
});

describe('what the leaderboard refuses', () => {
  it('a good run passes', () => {
    expect(validateRun(run('player-0001', 200), NOW).ok).toBe(true);
  });

  const bad: [string, Record<string, unknown>][] = [
    ['a rep worth more than a rep can be', { reps: [...new Array(RANKED.reps - 1).fill(100), RANKED.maxRepPoints + 1] }],
    ['the wrong number of reps', { reps: new Array(RANKED.reps - 1).fill(100) }],
    ['a run faster than 20 reps can be played', { ms: RANKED.minRunMs - 1 }],
    ['more Perfects than reps', { perfects: RANKED.reps + 1 }],
    ['a board that is not open (the Block Drill)', { board: boardId('block', 'OH') }],
    ['a board of another ruleset', { board: boardId('spike', 'OH', null, RANKED.ruleset + 1) }],
    ['a weekly board from two weeks ago', { board: boardId('spike', weeklyBoard({ index: weekOf(NOW).index - 2 }).pos, '2026-W43') }],
    [
      "a weekly board that isn't this week's position",
      { board: boardId('spike', weeklyBoard({ index: weekOf(NOW).index + 1 }).pos, '2026-W45') },
    ],
    ['no name', { name: ' ' }],
    ['a made-up player id', { player: '../../etc' }],
  ];
  for (const [what, over] of bad)
    it(`refuses ${what}`, () => {
      expect(validateRun(run('player-0001', 100, over), NOW).ok).toBe(false);
    });

  it("this week's and last week's featured boards are both open (a run that ends past midnight on Sunday)", () => {
    const thisWeek = weekOf(NOW);
    const lastWeek = weekOf(NOW - 7 * 86_400_000);
    expect(validateRun(run('player-0001', 100, { board: boardId('spike', weeklyBoard(thisWeek).pos, thisWeek.id) }), NOW).ok).toBe(true);
    expect(validateRun(run('player-0001', 100, { board: boardId('spike', weeklyBoard(lastWeek).pos, lastWeek.id) }), NOW).ok).toBe(true);
  });

  it('names: 2-16 letters or digits in any alphabet, spaces tidied', () => {
    expect(cleanName('  Kasia   W  ')).toBe('Kasia W');
    expect(cleanName('Łukasz Żółć')).toBe('Łukasz Żółć');
    expect(cleanName('a')).toBeNull();
    expect(cleanName('x'.repeat(17))).toBeNull();
    expect(cleanName('<script>')).toBeNull();
    expect(parseBoardId('1:spike:XX')).toBeNull();
  });
});

describe('the board order', () => {
  it('the higher total first, then more Perfects, then the longer streak, then the earlier run', () => {
    expect(rankScore(2001, 0, 0, NOW)).toBeGreaterThan(rankScore(2000, 20, 20, NOW - 1e9));
    expect(rankScore(2000, 6, 0, NOW)).toBeGreaterThan(rankScore(2000, 5, 20, NOW));
    expect(rankScore(2000, 5, 4, NOW)).toBeGreaterThan(rankScore(2000, 5, 3, NOW));
    expect(rankScore(2000, 5, 3, NOW - 3_600_000)).toBeGreaterThan(rankScore(2000, 5, 3, NOW));
  });
});

describe('the leaderboard server', () => {
  it('a run goes on the board, and the board shows it with your line marked', async () => {
    const s = server();
    const r = await s.post(run('player-0001', 200));
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ saved: true, count: 1, next: null, me: { rank: 1, total: 4000 } });
    const b = await s.get(`board=${boardId('spike', 'OH')}&player=player-0001`);
    expect(b.body.top).toHaveLength(1);
    expect(b.body.top[0]).toMatchObject({ rank: 1, name: 'Player 01', total: 4000, you: true });
    expect(b.body.me?.rank).toBe(1);
  });

  it('only your best counts: a worse run leaves it, a better one replaces it', async () => {
    const s = server();
    await s.post(run('player-0001', 200));
    s.wait(60);
    const worse = await s.post(run('player-0001', 150));
    expect(worse.body).toMatchObject({ saved: false, me: { total: 4000 } });
    s.wait(60);
    const better = await s.post(run('player-0001', 210));
    expect(better.body).toMatchObject({ saved: true, me: { total: 4200 }, count: 1 });
  });

  it('after a run you see where you are and who is next up', async () => {
    const s = server();
    await s.post(run('player-0001', 250), '1.1.1.1');
    await s.post(run('player-0002', 200), '2.2.2.2');
    const r = await s.post(run('player-0003', 220), '3.3.3.3');
    expect(r.body.me.rank).toBe(2);
    expect(r.body.count).toBe(3);
    expect(r.body.next).toMatchObject({ rank: 1, name: 'Player 01', total: 5000 });
  });

  it('outside the top 10 you see your line and the two players above you', async () => {
    const s = server();
    for (let i = 0; i < 14; i++) await s.post(run(`player-00${String(i).padStart(2, '0')}`, 300 - i * 10), `10.0.0.${i}`);
    const b = await s.get(`board=${boardId('spike', 'OH')}&player=player-0013`);
    expect(b.body.top).toHaveLength(10);
    expect(b.body.me).toMatchObject({ rank: 14, you: true });
    expect(b.body.above.map((r) => r.rank)).toEqual([12, 13]);
  });

  it('one run per player at a time: a second submission within 30 s is refused', async () => {
    const s = server();
    expect((await s.post(run('player-0001', 200))).status).toBe(200);
    expect((await s.post(run('player-0001', 210))).status).toBe(429);
    s.wait(31);
    expect((await s.post(run('player-0001', 210))).status).toBe(200);
  });

  it('a renamed player shows under the new name', async () => {
    const s = server();
    await s.post(run('player-0001', 200));
    s.wait(60);
    await s.post(run('player-0001', 100, { name: 'Kasia' }));
    const b = await s.get(`board=${boardId('spike', 'OH')}`);
    expect(b.body.top[0]).toMatchObject({ name: 'Kasia', total: 4000 });
  });

  it('the medal table counts medals over every season board, golds first', async () => {
    const s = server();
    const [, silverOH, goldOH] = RANKED.medals.OH;
    const goldMB = RANKED.medals.MB[2];
    const per = (total: number) => Math.ceil(total / RANKED.reps);
    await s.post(run('player-0001', per(silverOH)), '1.1.1.1');
    await s.post(run('player-0002', per(goldOH)), '2.2.2.2');
    s.wait(31);
    await s.post(run('player-0001', per(goldMB), { board: boardId('spike', 'MB') }), '1.1.1.1');
    const m = await s.get('view=medals&player=player-0002');
    expect(m.body.rows.map((r) => [r.name, r.gold, r.silver])).toEqual([
      ['Player 01', 1, 1],
      ['Player 02', 1, 0],
    ]);
    expect(m.body.rows[1].you).toBe(true);
  });

  it('a bad request is an error, not a crash', async () => {
    const s = server();
    expect((await s.get('board=1:spike:XX')).status).toBe(400);
    expect((await s.post({ hello: 1 })).status).toBe(400);
    expect((await s.post(run('player-0001', RANKED.maxRepPoints + 1))).status).toBe(400);
  });
});

describe('the share card', () => {
  it('one square per rep in the strip colours, the board, the medal, your place and a link to the same board', () => {
    const r = new RankedRun('spike', 'OH', settings());
    for (let i = 0; i < RANKED.reps; i++) {
      if (i === 3) r.skip();
      else r.record({ points: i % 2 ? 288 : 60, label: 'KILL', grade: i % 2 ? 'Perfect' : 'Good', kmh: 100 });
    }
    const text = shareText(r, { link: 'https://court-feel.vercel.app/', place: { rank: 3, count: 11 } });
    const lines = text.split('\n');
    expect(lines[0]).toBe(`Court Feel · Spike Drill · Outside Hitter · season ${RANKED.ruleset}`);
    expect(lines[1]).toContain('#3 of 11');
    expect([...lines[2]]).toHaveLength(10);
    expect([...lines[3]]).toHaveLength(10);
    // rep 4 was skipped: a red square
    expect([...lines[2]][3]).toBe('\u{1F7E5}');
    expect([...lines[2]][1]).toBe('\u{1F7E8}');
    expect(lines[4]).toBe('https://court-feel.vercel.app/?ranked=spike&pos=OH');
  });

  it("a weekly run links to this week's board", () => {
    const r = new RankedRun('spike', 'OPP', settings(), '2026-W45');
    expect(shareText(r, { link: 'x/' })).toContain('x/?ranked=weekly');
    expect(shareText(r, { link: 'x/' })).toContain('week 45');
  });
});
