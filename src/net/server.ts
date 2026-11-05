// The leaderboard server: one handler for the board, the medal table and run submissions, over a
// small Redis-like store (Upstash in production, memory in development and tests). Pure web
// standards (Request / Response), no framework.
import { RANKED } from '../config.js';
import { boardId, medalFor, parseBoardId, seasonBoards, type Medal } from '../game/boards.js';
import {
  ABOVE_ROWS,
  isPlayerId,
  rankScore,
  TOP_ROWS,
  validateRun,
  type BoardRow,
  type BoardView,
  type MedalRow,
  type MedalView,
  type SubmitResult,
} from './protocol.js';

/** the few Redis commands the leaderboard needs */
export interface Store {
  /** ZADD key GT score member: only ever raises a member's score */
  zaddGreater(key: string, score: number, member: string): Promise<void>;
  zscore(key: string, member: string): Promise<number | null>;
  /** 0-based rank from the top, or null */
  zrevrank(key: string, member: string): Promise<number | null>;
  zcard(key: string): Promise<number>;
  /** members from the top, `start` to `stop` inclusive */
  zrevrange(key: string, start: number, stop: number): Promise<string[]>;
  hset(key: string, field: string, value: string): Promise<void>;
  hmget(key: string, fields: string[]): Promise<(string | null)[]>;
  /** count a hit in a window that starts with the first hit and lasts `seconds`; the count so far */
  hit(key: string, seconds: number): Promise<number>;
}

/** a store in memory: the dev server and the tests */
export class MemoryStore implements Store {
  private z = new Map<string, Map<string, number>>();
  private h = new Map<string, Map<string, string>>();
  private hits = new Map<string, { n: number; until: number }>();

  constructor(private now: () => number = Date.now) {}

  private sorted(key: string): [string, number][] {
    // highest first; equal scores in reverse member order, like Redis
    return [...(this.z.get(key) ?? new Map<string, number>())].sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? 1 : -1));
  }

  async zaddGreater(key: string, score: number, member: string): Promise<void> {
    const z = this.z.get(key) ?? new Map<string, number>();
    this.z.set(key, z);
    const prev = z.get(member);
    if (prev === undefined || score > prev) z.set(member, score);
  }

  async zscore(key: string, member: string): Promise<number | null> {
    return this.z.get(key)?.get(member) ?? null;
  }

  async zrevrank(key: string, member: string): Promise<number | null> {
    const i = this.sorted(key).findIndex(([m]) => m === member);
    return i < 0 ? null : i;
  }

  async zcard(key: string): Promise<number> {
    return this.z.get(key)?.size ?? 0;
  }

  async zrevrange(key: string, start: number, stop: number): Promise<string[]> {
    return this.sorted(key)
      .slice(start, stop + 1)
      .map(([m]) => m);
  }

  async hset(key: string, field: string, value: string): Promise<void> {
    const h = this.h.get(key) ?? new Map<string, string>();
    this.h.set(key, h);
    h.set(field, value);
  }

  async hmget(key: string, fields: string[]): Promise<(string | null)[]> {
    const h = this.h.get(key);
    return fields.map((f) => h?.get(f) ?? null);
  }

  async hit(key: string, seconds: number): Promise<number> {
    const t = this.now();
    const w = this.hits.get(key);
    if (!w || t >= w.until) {
      this.hits.set(key, { n: 1, until: t + seconds * 1000 });
      return 1;
    }
    w.n++;
    return w.n;
  }
}

/** one run as stored on a board */
interface Entry {
  name: string;
  total: number;
  perfects: number;
  bestStreak: number;
  at: number;
  reps: number[];
  ms: number;
  cam: string;
  input: string;
  hand: string;
  build: string;
}

export interface HandlerOptions {
  /** key prefix: production and previews keep separate boards ("cf:prod", "cf:dev") */
  prefix: string;
  now?: () => number;
}

/** one submission per player per this many seconds (a run takes minutes), and per address per hour */
const PLAYER_WINDOW_S = 30;
const ADDRESS_LIMIT = 40;
/** a submitted body is a few hundred bytes */
const MAX_BODY = 8_192;
/** the medal table reads this many runs of each board */
const MEDAL_DEPTH = 500;

const json = (data: unknown, status = 200): Response =>
  new Response(JSON.stringify(data), { status, headers: { 'content-type': 'application/json', 'cache-control': 'no-store' } });

/** the leaderboard as one request handler: GET ?board=…&player=… or ?view=medals&player=…, POST a run */
export function createHandler(store: Store, opts: HandlerOptions): (req: Request) => Promise<Response> {
  const now = opts.now ?? Date.now;
  const k = {
    board: (b: string) => `${opts.prefix}:board:${b}`,
    entry: (b: string) => `${opts.prefix}:entry:${b}`,
    names: `${opts.prefix}:names`,
    limit: (who: string) => `${opts.prefix}:limit:${who}`,
  };

  /** lines for these players of a board, ranks counted from `first` */
  async function rows(board: string, players: string[], first: number, me: string | null): Promise<BoardRow[]> {
    if (!players.length) return [];
    const [entries, names] = await Promise.all([store.hmget(k.entry(board), players), store.hmget(k.names, players)]);
    const out: BoardRow[] = [];
    players.forEach((p, i) => {
      const raw = entries[i];
      if (!raw) return;
      const e = JSON.parse(raw) as Entry;
      const row: BoardRow = {
        rank: first + i + 1,
        name: names[i] ?? e.name,
        total: e.total,
        perfects: e.perfects,
        bestStreak: e.bestStreak,
        at: e.at,
      };
      if (p === me) row.you = true;
      out.push(row);
    });
    return out;
  }

  async function view(board: string, me: string | null): Promise<BoardView> {
    const [count, top, rank] = await Promise.all([
      store.zcard(k.board(board)),
      store.zrevrange(k.board(board), 0, TOP_ROWS - 1),
      me ? store.zrevrank(k.board(board), me) : Promise.resolve(null),
    ]);
    const topRows = await rows(board, top, 0, me);
    let mine: BoardRow | null = null;
    let above: BoardRow[] = [];
    if (rank !== null && me) {
      if (rank < TOP_ROWS) mine = topRows[rank] ?? null;
      else {
        const first = Math.max(TOP_ROWS, rank - ABOVE_ROWS);
        const around = await rows(board, await store.zrevrange(k.board(board), first, rank), first, me);
        mine = around[around.length - 1] ?? null;
        above = around.slice(0, -1);
      }
    }
    return { board, count, top: topRows, me: mine, above };
  }

  async function medals(me: string | null): Promise<MedalView> {
    const boards = seasonBoards();
    const tally = new Map<string, Record<Medal, number>>();
    for (const b of boards) {
      const id = boardId(b.mode, b.pos);
      const players = await store.zrevrange(k.board(id), 0, MEDAL_DEPTH - 1);
      const entries = players.length ? await store.hmget(k.entry(id), players) : [];
      players.forEach((p, i) => {
        const raw = entries[i];
        if (!raw) return;
        const medal = medalFor((JSON.parse(raw) as Entry).total, b.pos);
        if (!medal) return;
        const t = tally.get(p) ?? { coach: 0, gold: 0, silver: 0, bronze: 0 };
        t[medal]++;
        tally.set(p, t);
      });
    }
    const players = [...tally.keys()];
    const names = players.length ? await store.hmget(k.names, players) : [];
    const rowsOut: MedalRow[] = players.map((p, i) => ({
      rank: 0,
      name: names[i] ?? '?',
      ...tally.get(p)!,
      ...(p === me ? { you: true } : {}),
    }));
    // like an Olympic table: the most of the best medal first
    rowsOut.sort(
      (a, b) => b.coach - a.coach || b.gold - a.gold || b.silver - a.silver || b.bronze - a.bronze || a.name.localeCompare(b.name),
    );
    rowsOut.forEach((r, i) => (r.rank = i + 1));
    return { boards: boards.map((b) => boardId(b.mode, b.pos)), rows: rowsOut };
  }

  async function submit(req: Request): Promise<Response> {
    const text = await req.text();
    if (text.length > MAX_BODY) return json({ error: 'too big' }, 413);
    let body: unknown;
    try {
      body = JSON.parse(text);
    } catch {
      return json({ error: 'not json' }, 400);
    }
    const t = now();
    const v = validateRun(body, t);
    if (!v.ok) return json({ error: v.error }, 400);
    const run = v.run;
    const address = (req.headers.get('x-forwarded-for') ?? 'local').split(',')[0].trim();
    if ((await store.hit(k.limit(`p:${run.player}`), PLAYER_WINDOW_S)) > 1) return json({ error: 'one run at a time' }, 429);
    if ((await store.hit(k.limit(`a:${address}`), 3600)) > ADDRESS_LIMIT) return json({ error: 'too many runs from here' }, 429);
    const total = run.reps.reduce((s, p) => s + p, 0);
    const score = rankScore(total, run.perfects, run.bestStreak, t);
    const prev = await store.zscore(k.board(run.board), run.player);
    const saved = prev === null || score > prev;
    if (saved) {
      const entry: Entry = {
        name: run.name,
        total,
        perfects: run.perfects,
        bestStreak: run.bestStreak,
        at: t,
        reps: run.reps,
        ms: run.ms,
        cam: run.cam,
        input: run.input,
        hand: run.hand,
        build: run.build,
      };
      await store.hset(k.entry(run.board), run.player, JSON.stringify(entry));
      await store.zaddGreater(k.board(run.board), score, run.player);
    }
    await store.hset(k.names, run.player, run.name);
    const rank = (await store.zrevrank(k.board(run.board), run.player)) ?? 0;
    const [count, around] = await Promise.all([
      store.zcard(k.board(run.board)),
      store.zrevrange(k.board(run.board), Math.max(0, rank - 1), rank),
    ]);
    const lines = await rows(run.board, around, Math.max(0, rank - 1), run.player);
    const me = lines[lines.length - 1];
    const result: SubmitResult = { saved, me, count, next: rank > 0 ? lines[0] : null };
    return json(result);
  }

  return async (req: Request): Promise<Response> => {
    try {
      if (req.method === 'POST') return await submit(req);
      if (req.method !== 'GET') return json({ error: 'GET or POST' }, 405);
      const q = new URL(req.url).searchParams;
      const player = q.get('player');
      const me = isPlayerId(player) ? player : null;
      if (q.get('view') === 'medals') return json(await medals(me));
      const ref = parseBoardId(q.get('board'));
      if (!ref) return json({ error: 'unknown board' }, 400);
      return json(await view(boardId(ref.mode, ref.pos, ref.week, RANKED.ruleset), me));
    } catch (err) {
      console.error('[leaderboard]', err);
      return json({ error: 'leaderboard unavailable' }, 500);
    }
  };
}
