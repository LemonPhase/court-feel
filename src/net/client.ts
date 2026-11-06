// The game's side of the online leaderboard: who you are (a random id and a nickname in this
// browser: not an account, and not recoverable on another device), finished runs waiting to be
// sent, and the requests. Nothing here polls: lists are fetched when a screen opens, and kept a
// few seconds.
import { LEADERBOARD } from '../config';
import { BUILD_ID } from '../core/build';
import type { RankedRun } from '../game/ranked';
import {
  cleanName,
  isPlayerId,
  type BoardView,
  type ErrorBody,
  type MedalView,
  type PersonalBoard,
  type PublicBoard,
  type RunSubmission,
  type SubmitResult,
} from './protocol';

const PLAYER_KEY = 'courtfeel.player.v1';
const PENDING_KEY = 'courtfeel.pending.v1';
const API = 'api/leaderboard';

export interface Player {
  id: string;
  /** your name on the boards (null until you pick one) */
  name: string | null;
}

/** what became of a run sent to the leaderboard */
export type SubmitAttempt =
  | { kind: 'ok'; result: SubmitResult }
  /** the leaderboard refused the run (it can't be right): it is not sent again */
  | { kind: 'refused'; error: string }
  /** one run at a time: it can go after this many seconds */
  | { kind: 'limited'; retryAfterS: number }
  /** the leaderboard answered but can't take runs right now (not set up, or its store is down) */
  | { kind: 'unavailable' }
  /** no answer at all (no connection) */
  | { kind: 'offline' };

export function newId(): string {
  try {
    return crypto.randomUUID();
  } catch {
    return `r-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 12)}`;
  }
}

function read<T>(key: string, fallback: T): T {
  try {
    const raw = localStorage.getItem(key);
    return raw ? (JSON.parse(raw) as T) : fallback;
  } catch {
    return fallback;
  }
}

function write(key: string, value: unknown): void {
  try {
    localStorage.setItem(key, JSON.stringify(value));
  } catch {
    /* blocked storage: it lives for this session only */
  }
}

/** you, as this browser knows you (an id is made the first time) */
export function loadPlayer(): Player {
  const p = read<Partial<Player>>(PLAYER_KEY, {});
  const player: Player = { id: isPlayerId(p.id) ? p.id : newId(), name: cleanName(p.name) };
  write(PLAYER_KEY, player);
  return player;
}

/** set your name (null if it isn't a valid name) */
export function setPlayerName(name: string): Player | null {
  const clean = cleanName(name);
  if (!clean) return null;
  const p = { ...loadPlayer(), name: clean };
  write(PLAYER_KEY, p);
  return p;
}

/** a finished run as the leaderboard takes it; `id` is made once per run, so a retry sends the same one */
export function toSubmission(
  run: RankedRun,
  player: Player,
  how: { cam: 'fp' | 'tp'; input: 'mouse' | 'touch'; hand: 'right' | 'left' },
  id: string,
): RunSubmission {
  return {
    id,
    board: run.board,
    player: player.id,
    name: player.name ?? '',
    reps: run.reps.map((r) => r.points),
    perfects: run.perfects,
    bestStreak: run.bestStreak,
    ms: Date.now() - run.startedAt,
    ...how,
    build: BUILD_ID,
  };
}

// ------------------------------------------------------------ runs waiting to be sent

/** finished runs the leaderboard hasn't confirmed yet, oldest first */
export function pendingRuns(): RunSubmission[] {
  const list = read<unknown>(PENDING_KEY, []);
  return Array.isArray(list) ? (list as RunSubmission[]).filter((s) => s && isPlayerId(s.id)) : [];
}

/** keep a run until the leaderboard has it (the oldest go first when there are too many) */
export function keepPending(s: RunSubmission): void {
  const list = pendingRuns().filter((p) => p.id !== s.id);
  list.push(s);
  write(PENDING_KEY, list.slice(-LEADERBOARD.pendingMax));
}

function dropPending(id: string): void {
  write(
    PENDING_KEY,
    pendingRuns().filter((p) => p.id !== id),
  );
}

/** send one run; it leaves the waiting list once the leaderboard has it (or refuses it for good) */
export async function submitRun(s: RunSubmission): Promise<SubmitAttempt> {
  let res: Response;
  try {
    res = await fetch(API, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(s) });
  } catch {
    return { kind: 'offline' };
  }
  if (res.ok) {
    try {
      const result = (await res.json()) as SubmitResult;
      dropPending(s.id);
      memo.clear();
      return { kind: 'ok', result };
    } catch {
      return { kind: 'offline' };
    }
  }
  const body = (await res.json().catch(() => ({}))) as Partial<ErrorBody>;
  if (res.status === 429)
    return { kind: 'limited', retryAfterS: body.retryAfterS ?? (Number(res.headers.get('retry-after')) || LEADERBOARD.playerWindowS) };
  if (res.status === 400 || res.status === 413) {
    dropPending(s.id);
    return { kind: 'refused', error: body.error ?? 'refused' };
  }
  return { kind: 'unavailable' };
}

/** send the runs still waiting, oldest first; stops at the first that can't go right now */
export async function sendPending(): Promise<{ sent: number; left: number; last: SubmitAttempt | null }> {
  let sent = 0;
  let last: SubmitAttempt | null = null;
  for (const s of pendingRuns()) {
    last = await submitRun(s);
    if (last.kind === 'ok') sent++;
    else if (last.kind !== 'refused') break;
  }
  return { sent, left: pendingRuns().length, last };
}

// ------------------------------------------------------------ reads

/** answers kept a few seconds: switching tabs back and forth doesn't ask again */
const memo = new Map<string, { until: number; data: unknown }>();

async function get<T>(query: string, keepS: number): Promise<T | null> {
  const m = memo.get(query);
  if (m && m.until > Date.now()) return m.data as T;
  try {
    const res = await fetch(`${API}${query}`);
    if (!res.ok) return null;
    const data = (await res.json()) as T;
    if (keepS > 0) memo.set(query, { until: Date.now() + keepS * 1000, data });
    return data;
  } catch {
    return null;
  }
}

/** a board: the public list (cached, may be a few seconds old) and your own line (fresh) */
export async function fetchBoard(board: string, player: string): Promise<BoardView | null> {
  const b = encodeURIComponent(board);
  const [pub, mine] = await Promise.all([
    get<PublicBoard>(`?board=${b}`, LEADERBOARD.clientCacheS),
    get<PersonalBoard>(`?view=me&board=${b}&player=${encodeURIComponent(player)}`, LEADERBOARD.clientCacheS),
  ]);
  if (!pub) return null;
  const me = mine?.me ?? null;
  const top = pub.top.map((r) => (me && r.rank === me.rank && r.name === me.name && r.total === me.total ? { ...r, you: true } : r));
  return { ...pub, top, me, above: mine?.above ?? [] };
}

export const fetchMedals = (): Promise<MedalView | null> => get<MedalView>('?view=medals', LEADERBOARD.clientCacheS);
