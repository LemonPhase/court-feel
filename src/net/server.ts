// The leaderboard server: one handler for the boards, the medal table and run submissions, over a
// small Redis-like store (Upstash in production, memory in development and tests). Pure web
// standards (Request / Response), no framework.
//
// Accepting a run (is it possible? `validateRun`) is kept apart from recording it (`record`, one
// atomic store operation), so a trusted match server can later write through the same ranking path.
import { LEADERBOARD, RANKED } from '../config.js';
import { boardId, medalFor, parseBoardId, seasonBoards, type BoardRef, type Medal } from '../game/boards.js';
import {
  ABOVE_ROWS,
  isPlayerId,
  rankScore,
  TOP_ROWS,
  validateRun,
  type BoardRow,
  type ErrorBody,
  type MedalRow,
  type MedalView,
  type PersonalBoard,
  type PublicBoard,
  type RunSubmission,
  type SubmitResult,
} from './protocol.js';

/** one run to record, with every key and limit the store needs to do it in one atomic step */
export interface SubmitOp {
  keys: {
    /** the board's sorted set: player -> rank score */
    board: string;
    /** the board's runs: player -> the best run's details */
    entries: string;
    /** player -> name */
    names: string;
    /** this submission, once recorded: '1' it won (became the best), '0' it didn't */
    submission: string;
    /** the player's window: holds the id of the last new run */
    playerLimit: string;
    /** the address's run counter */
    addressLimit: string;
  };
  player: string;
  name: string;
  submission: string;
  score: number;
  /** the run's details (JSON), stored only if it becomes the player's best */
  entry: string;
  playerWindowS: number;
  addressWindowS: number;
  addressMax: number;
  submissionTtlS: number;
  /** delete the board this long after its last run (0: keep it) */
  boardTtlS: number;
}

export type SubmitOutcome =
  | { kind: 'recorded'; won: boolean }
  /** the same submission id again (a retry): nothing changed */
  | { kind: 'repeat'; won: boolean }
  | { kind: 'limited'; retryAfterS: number };

/** the few Redis operations the leaderboard needs */
export interface Store {
  readonly kind: 'upstash' | 'memory';
  /**
   * Record a run atomically: a repeat of a recorded submission changes nothing; a new run within
   * the player's window (or over the address's limit) is refused; otherwise the run replaces the
   * player's best only if it scores higher, its details and its rank score together, and the name
   * is updated. Nothing is ever half-written.
   */
  submit(op: SubmitOp): Promise<SubmitOutcome>;
  /** 0-based rank from the top, or null */
  zrevrank(key: string, member: string): Promise<number | null>;
  zcard(key: string): Promise<number>;
  /** members from the top, `start` to `stop` inclusive */
  zrevrange(key: string, start: number, stop: number): Promise<string[]>;
  hmget(key: string, fields: string[]): Promise<(string | null)[]>;
  /** count a hit in a window that starts with the first hit and lasts `seconds`; the count so far */
  hit(key: string, seconds: number): Promise<number>;
  /** take a player's run off a board (both the rank and the details); false if there was none */
  remove(board: string, entries: string, player: string): Promise<boolean>;
}

/** a store in memory: the dev server and the tests. Every operation finishes before the next starts. */
export class MemoryStore implements Store {
  readonly kind = 'memory';
  private z = new Map<string, Map<string, number>>();
  private h = new Map<string, Map<string, string>>();
  private s = new Map<string, string>();
  private until = new Map<string, number>();

  constructor(private now: () => number = Date.now) {}

  /** drop a key whose time is up; true if it is (still) there */
  private alive(key: string): boolean {
    const u = this.until.get(key);
    if (u !== undefined && this.now() >= u) {
      this.z.delete(key);
      this.h.delete(key);
      this.s.delete(key);
      this.until.delete(key);
    }
    return this.z.has(key) || this.h.has(key) || this.s.has(key);
  }

  private expire(key: string, seconds: number): void {
    this.until.set(key, this.now() + seconds * 1000);
  }

  private ttl(key: string): number {
    const u = this.until.get(key);
    return u === undefined ? -1 : Math.max(1, Math.ceil((u - this.now()) / 1000));
  }

  private str(key: string): string | null {
    return this.alive(key) ? (this.s.get(key) ?? null) : null;
  }

  private incr(key: string, seconds: number): number {
    const n = Number(this.str(key) ?? 0) + 1;
    const fresh = n === 1;
    this.s.set(key, String(n));
    if (fresh) this.expire(key, seconds);
    return n;
  }

  private sorted(key: string): [string, number][] {
    if (!this.alive(key)) return [];
    // highest first; equal scores in reverse member order, like Redis
    return [...this.z.get(key)!].sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? 1 : -1));
  }

  async submit(op: SubmitOp): Promise<SubmitOutcome> {
    const k = op.keys;
    const done = this.str(k.submission);
    if (done !== null) return { kind: 'repeat', won: done === '1' };
    const holder = this.str(k.playerLimit);
    if (holder !== null && holder !== op.submission) return { kind: 'limited', retryAfterS: this.ttl(k.playerLimit) };
    if (this.incr(k.addressLimit, op.addressWindowS) > op.addressMax) return { kind: 'limited', retryAfterS: this.ttl(k.addressLimit) };
    this.s.set(k.playerLimit, op.submission);
    this.expire(k.playerLimit, op.playerWindowS);
    this.alive(k.board);
    const z = this.z.get(k.board) ?? new Map<string, number>();
    const h = this.h.get(k.entries) ?? new Map<string, string>();
    const prev = z.get(op.player);
    const won = prev === undefined || op.score > prev;
    if (won) {
      z.set(op.player, op.score);
      h.set(op.player, op.entry);
      this.z.set(k.board, z);
      this.h.set(k.entries, h);
    }
    const names = this.h.get(k.names) ?? new Map<string, string>();
    names.set(op.player, op.name);
    this.h.set(k.names, names);
    if (op.boardTtlS > 0) {
      this.expire(k.board, op.boardTtlS);
      this.expire(k.entries, op.boardTtlS);
    }
    this.s.set(k.submission, won ? '1' : '0');
    this.expire(k.submission, op.submissionTtlS);
    return { kind: 'recorded', won };
  }

  async zrevrank(key: string, member: string): Promise<number | null> {
    const i = this.sorted(key).findIndex(([m]) => m === member);
    return i < 0 ? null : i;
  }

  async zcard(key: string): Promise<number> {
    return this.sorted(key).length;
  }

  async zrevrange(key: string, start: number, stop: number): Promise<string[]> {
    return this.sorted(key)
      .slice(start, stop + 1)
      .map(([m]) => m);
  }

  async hmget(key: string, fields: string[]): Promise<(string | null)[]> {
    const h = this.alive(key) ? this.h.get(key) : undefined;
    return fields.map((f) => h?.get(f) ?? null);
  }

  async hit(key: string, seconds: number): Promise<number> {
    return this.incr(key, seconds);
  }

  async remove(board: string, entries: string, player: string): Promise<boolean> {
    const had = this.alive(board) && !!this.z.get(board)?.delete(player);
    if (this.alive(entries)) this.h.get(entries)?.delete(player);
    return had;
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
  submission: string;
  /** where the result comes from: the player's browser reports it (a match server would be 'verified') */
  source: 'browser';
}

export interface HandlerOptions {
  /** key prefix: production and previews keep separate boards ("cf:prod", "cf:dev") */
  prefix: string;
  now?: () => number;
  /** a secret that unlocks the admin view and removing runs (none: no admin) */
  adminToken?: string | null;
}

/** a submitted body is a few hundred bytes */
const MAX_BODY = 8_192;

type Cache = 'public' | 'private';

function json(data: unknown, status = 200, cache: Cache = 'private', maxAgeS = 0, extra: Record<string, string> = {}): Response {
  const cacheControl =
    cache === 'public' && maxAgeS > 0
      ? `public, max-age=0, s-maxage=${maxAgeS}, stale-while-revalidate=${maxAgeS * 3}`
      : 'private, no-store';
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'content-type': 'application/json', 'cache-control': cacheControl, ...extra },
  });
}

const fail = (error: string, status: number, retryAfterS?: number): Response =>
  json(
    { error, ...(retryAfterS !== undefined ? { retryAfterS } : {}) } satisfies ErrorBody,
    status,
    'private',
    0,
    retryAfterS !== undefined ? { 'retry-after': String(retryAfterS) } : {},
  );

/** compare secrets without leaking where they differ */
function sameSecret(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let d = 0;
  for (let i = 0; i < a.length; i++) d |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return d === 0;
}

/**
 * The leaderboard as one request handler.
 * GET ?board=… (public, cached) · ?view=me&board=…&player=… (yours, never cached) · ?view=medals
 * (public, cached) · ?view=health. POST a finished run. Admin (Bearer token): GET ?view=admin&board=…,
 * DELETE ?board=…&player=….
 */
export function createHandler(store: Store, opts: HandlerOptions): (req: Request) => Promise<Response> {
  const now = opts.now ?? Date.now;
  const k = {
    board: (b: string) => `${opts.prefix}:board:${b}`,
    entry: (b: string) => `${opts.prefix}:entry:${b}`,
    names: `${opts.prefix}:names`,
    submission: (id: string) => `${opts.prefix}:sub:${id}`,
    limit: (who: string) => `${opts.prefix}:limit:${who}`,
  };
  /** the public lists, kept a few seconds in this instance too (the CDN keeps them at the edge) */
  const cache = new Map<string, { until: number; data: unknown }>();
  async function cached<T>(key: string, seconds: number, make: () => Promise<T>): Promise<T> {
    const c = cache.get(key);
    if (c && c.until > now()) return c.data as T;
    const data = await make();
    cache.set(key, { until: now() + seconds * 1000, data });
    return data;
  }

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

  async function publicBoard(board: string): Promise<PublicBoard> {
    const [count, top] = await Promise.all([store.zcard(k.board(board)), store.zrevrange(k.board(board), 0, TOP_ROWS - 1)]);
    return { board, count, top: await rows(board, top, 0, null) };
  }

  async function personalBoard(board: string, me: string): Promise<PersonalBoard> {
    const rank = await store.zrevrank(k.board(board), me);
    if (rank === null) return { board, me: null, above: [] };
    const first = rank < TOP_ROWS ? rank : Math.max(TOP_ROWS, rank - ABOVE_ROWS);
    const around = await rows(board, await store.zrevrange(k.board(board), first, rank), first, me);
    return { board, me: around[around.length - 1] ?? null, above: around.slice(0, -1) };
  }

  async function medals(): Promise<MedalView> {
    const boards = seasonBoards();
    const tally = new Map<string, Record<Medal, number>>();
    for (const b of boards) {
      const id = boardId(b.mode, b.pos);
      const players = await store.zrevrange(k.board(id), 0, LEADERBOARD.medalDepth - 1);
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
    const out: MedalRow[] = players.map((p, i) => ({ rank: 0, name: names[i] ?? '?', ...tally.get(p)! }));
    // like an Olympic table: the most of the best medal first
    out.sort((a, b) => b.coach - a.coach || b.gold - a.gold || b.silver - a.silver || b.bronze - a.bronze || a.name.localeCompare(b.name));
    out.forEach((r, i) => (r.rank = i + 1));
    return { boards: boards.map((b) => boardId(b.mode, b.pos)), depth: LEADERBOARD.medalDepth, rows: out };
  }

  /** record an accepted run: the ranking side, one atomic store operation */
  function record(run: RunSubmission, ref: BoardRef, t: number, address: string): Promise<SubmitOutcome> {
    const total = run.reps.reduce((s, p) => s + p, 0);
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
      submission: run.id,
      source: 'browser',
    };
    return store.submit({
      keys: {
        board: k.board(run.board),
        entries: k.entry(run.board),
        names: k.names,
        submission: k.submission(run.id),
        playerLimit: k.limit(`p:${run.player}`),
        addressLimit: k.limit(`a:${address}`),
      },
      player: run.player,
      name: run.name,
      submission: run.id,
      score: rankScore(total, run.perfects, run.bestStreak, t),
      entry: JSON.stringify(entry),
      playerWindowS: LEADERBOARD.playerWindowS,
      addressWindowS: 3600,
      addressMax: LEADERBOARD.addressRunsPerHour,
      submissionTtlS: LEADERBOARD.submissionMemoryS,
      boardTtlS: ref.week ? LEADERBOARD.weeklyRetentionDays * 86_400 : 0,
    });
  }

  async function submit(req: Request, address: string): Promise<Response> {
    const text = await req.text();
    if (text.length > MAX_BODY) return fail('too big', 413);
    let body: unknown;
    try {
      body = JSON.parse(text);
    } catch {
      return fail('not json', 400);
    }
    const t = now();
    const accepted = validateRun(body, t);
    if (!accepted.ok) return fail(accepted.error, 400);
    const run = accepted.run;
    const outcome = await record(run, accepted.ref, t, address);
    if (outcome.kind === 'limited') return fail('one run at a time', 429, outcome.retryAfterS);
    cache.delete(`board:${run.board}`);
    const rank = await store.zrevrank(k.board(run.board), run.player);
    if (rank === null) return fail('leaderboard unavailable', 500);
    const [count, around] = await Promise.all([
      store.zcard(k.board(run.board)),
      store.zrevrange(k.board(run.board), Math.max(0, rank - 1), rank),
    ]);
    const lines = await rows(run.board, around, Math.max(0, rank - 1), run.player);
    const result: SubmitResult = {
      saved: outcome.won,
      repeat: outcome.kind === 'repeat',
      me: lines[lines.length - 1],
      count,
      next: rank > 0 ? lines[0] : null,
    };
    return json(result);
  }

  const isAdmin = (req: Request): boolean => {
    const token = opts.adminToken;
    const auth = req.headers.get('authorization') ?? '';
    return !!token && auth.startsWith('Bearer ') && sameSecret(auth.slice(7), token);
  };

  return async (req: Request): Promise<Response> => {
    try {
      const address = (req.headers.get('x-forwarded-for') ?? req.headers.get('x-real-ip') ?? 'local').split(',')[0].trim();
      const q = new URL(req.url).searchParams;
      if (req.method === 'POST') return await submit(req, address);
      if (req.method === 'DELETE') {
        if (!isAdmin(req)) return fail('not allowed', 403);
        const ref = parseBoardId(q.get('board'));
        const player = q.get('player');
        if (!ref || !isPlayerId(player)) return fail('board and player', 400);
        const id = boardId(ref.mode, ref.pos, ref.week);
        const removed = await store.remove(k.board(id), k.entry(id), player);
        cache.clear();
        return json({ removed });
      }
      if (req.method !== 'GET') return fail('GET, POST or DELETE', 405);
      const view = q.get('view');
      if (view === 'health') return json({ ok: true, store: store.kind, boards: opts.prefix, ruleset: RANKED.ruleset });
      // reads are cheap but not free: a generous limit per address (a club shares one)
      if ((await store.hit(k.limit(`r:${address}`), 60)) > LEADERBOARD.addressReadsPerMinute) return fail('too many requests', 429, 60);
      if (view === 'medals') return json(await cached('medals', LEADERBOARD.medalsCacheS, medals), 200, 'public', LEADERBOARD.medalsCacheS);
      const ref = parseBoardId(q.get('board'));
      if (!ref) return fail('unknown board', 400);
      const board = boardId(ref.mode, ref.pos, ref.week);
      if (view === 'me') {
        const player = q.get('player');
        if (!isPlayerId(player)) return fail('bad player id', 400);
        return json(await personalBoard(board, player));
      }
      if (view === 'admin') {
        if (!isAdmin(req)) return fail('not allowed', 403);
        const players = await store.zrevrange(k.board(board), 0, 199);
        const lines = await rows(board, players, 0, null);
        return json({ board, rows: lines.map((r) => ({ ...r, player: players[r.rank - 1] })) });
      }
      return json(
        await cached(`board:${board}`, LEADERBOARD.publicCacheS, () => publicBoard(board)),
        200,
        'public',
        LEADERBOARD.publicCacheS,
      );
    } catch (err) {
      console.error('[leaderboard]', err);
      return fail('leaderboard unavailable', 503);
    }
  };
}
