// The leaderboard's wire format and the checks both sides share. The server imports this file, so
// it stays pure and its relative imports carry `.js` (the serverless runtime runs native ES modules).
import { RANKED } from '../config.js';
import { parseBoardId, weekOf, weeklyBoard, type BoardRef } from '../game/boards.js';

/** a finished ranked run, as the game submits it */
export interface RunSubmission {
  board: string;
  /** a random id kept in the player's browser (no accounts) */
  player: string;
  name: string;
  /** points per rep */
  reps: number[];
  perfects: number;
  bestStreak: number;
  /** how long the run took (ms) */
  ms: number;
  cam: 'fp' | 'tp';
  input: 'mouse' | 'touch';
  hand: 'right' | 'left';
  /** the game build that played it */
  build: string;
}

/** one line of a board */
export interface BoardRow {
  rank: number;
  name: string;
  total: number;
  perfects: number;
  bestStreak: number;
  /** when the run was set (ms since 1970) */
  at: number;
  /** the asking player's own line */
  you?: boolean;
}

/** a board as the leaderboard screen shows it: the top, and around you if you are further down */
export interface BoardView {
  board: string;
  count: number;
  top: BoardRow[];
  /** your line (null: no run on this board yet) */
  me: BoardRow | null;
  /** the players just above you, when you are outside the top */
  above: BoardRow[];
}

/** the answer to a submitted run */
export interface SubmitResult {
  /** the run is your new best on the board (a worse run leaves your best as it was) */
  saved: boolean;
  me: BoardRow;
  count: number;
  /** the player just above you (null: you are first) */
  next: BoardRow | null;
}

/** one player in the medal table */
export interface MedalRow {
  rank: number;
  name: string;
  coach: number;
  gold: number;
  silver: number;
  bronze: number;
  you?: boolean;
}

export interface MedalView {
  boards: string[];
  rows: MedalRow[];
}

/** how many lines a board shows from the top, and how many players above you */
export const TOP_ROWS = 10;
export const ABOVE_ROWS = 2;

/** a nickname: 2-16 letters, digits, spaces, dots, dashes, underscores or apostrophes (any alphabet) */
export function cleanName(raw: unknown): string | null {
  if (typeof raw !== 'string') return null;
  const name = raw.trim().replace(/\s+/g, ' ');
  return [...name].length >= 2 && [...name].length <= 16 && /^[\p{L}\p{N} ._'-]+$/u.test(name) ? name : null;
}

export const isPlayerId = (v: unknown): v is string => typeof v === 'string' && /^[A-Za-z0-9-]{8,64}$/.test(v);

const count = (v: unknown, max: number): v is number => typeof v === 'number' && Number.isInteger(v) && v >= 0 && v <= max;

/**
 * A submitted run is untrusted: every field is checked and anything impossible is refused (a rep
 * worth more than a rep can be, the wrong number of reps, a run played faster than 20 reps can be,
 * a board that isn't open, a weekly board that isn't this week's or last week's).
 */
export function validateRun(body: unknown, now: number): { ok: true; run: RunSubmission; ref: BoardRef } | { ok: false; error: string } {
  if (!body || typeof body !== 'object' || Array.isArray(body)) return { ok: false, error: 'not a run' };
  const b = body as Record<string, unknown>;
  const ref = parseBoardId(b.board);
  if (!ref) return { ok: false, error: 'unknown board' };
  if (ref.week) {
    const thisWeek = weekOf(now);
    const lastWeek = weekOf(now - 7 * 86_400_000);
    const week = ref.week === thisWeek.id ? thisWeek : ref.week === lastWeek.id ? lastWeek : null;
    if (!week) return { ok: false, error: 'that week is over' };
    const featured = weeklyBoard(week);
    if (featured.mode !== ref.mode || featured.pos !== ref.pos) return { ok: false, error: "not that week's board" };
  }
  if (!isPlayerId(b.player)) return { ok: false, error: 'bad player id' };
  const name = cleanName(b.name);
  if (!name) return { ok: false, error: 'bad name' };
  const reps = b.reps;
  if (!Array.isArray(reps) || reps.length !== RANKED.reps || !reps.every((p) => count(p, RANKED.maxRepPoints)))
    return { ok: false, error: 'impossible reps' };
  if (!count(b.perfects, RANKED.reps) || !count(b.bestStreak, RANKED.reps)) return { ok: false, error: 'impossible counts' };
  if (typeof b.ms !== 'number' || !Number.isFinite(b.ms) || b.ms < RANKED.minRunMs) return { ok: false, error: 'too fast' };
  const run: RunSubmission = {
    board: b.board as string,
    player: b.player,
    name,
    reps: [...(reps as number[])],
    perfects: b.perfects,
    bestStreak: b.bestStreak,
    ms: Math.round(b.ms),
    cam: b.cam === 'fp' ? 'fp' : 'tp',
    input: b.input === 'touch' ? 'touch' : 'mouse',
    hand: b.hand === 'left' ? 'left' : 'right',
    build: typeof b.build === 'string' ? b.build.slice(0, 40) : '',
  };
  return { ok: true, run, ref };
}

/** the latest moment a run can be set and still order correctly (2096): earlier runs win ties */
const T_MAX = 4e12;

/**
 * A run's place on a board as one number, higher first: the total, then Perfects, then the best
 * streak, then the earlier run (the fraction). Totals stay under 10 000 a run, so the fraction has
 * room for the time to about a minute.
 */
export function rankScore(total: number, perfects: number, bestStreak: number, at: number): number {
  return total * 10_000 + perfects * 100 + bestStreak + ((T_MAX - at) / T_MAX) * 0.99;
}
