import { isPositionId, RANKED, type PositionId } from '../config.js';

/**
 * Leaderboard boards: which drill × position boards exist, their ids, the weekly featured board and
 * the medals. Pure (imports only the config), so the leaderboard server uses the same rules.
 */

/** a ranked run on a drill's season board, or on this week's featured board */
export type RankedPlay = 'season' | 'weekly';

/** the drills that score (each could have a ranked run) */
export type RankedMode = 'spike' | 'block' | 'receive' | 'setter';

/**
 * The drills a ranked run is open for: the Spike Drill only for now. The others still score in
 * practice; add one here to open its boards (their rules are in `boardFor`).
 */
export const RANKED_MODES: readonly RankedMode[] = ['spike'];

export const isRankedMode = (v: unknown): v is RankedMode => RANKED_MODES.includes(v as RankedMode);

/**
 * The board a drill is played on from the chosen position. The Setter Drill's hitters are AI, so it is
 * one board for the setter; a libero may not block, so the Block Drill has no libero board.
 */
export function boardFor(mode: RankedMode, pos: PositionId): { mode: RankedMode; pos: PositionId } | null {
  if (mode === 'setter') return { mode, pos: 'S' };
  if (mode === 'block' && pos === 'L') return null;
  return { mode, pos };
}

/** the board a ranked run of this drill is played on, if the drill has ranked runs */
export function rankedBoard(mode: string, pos: PositionId): { mode: RankedMode; pos: PositionId } | null {
  return isRankedMode(mode) ? boardFor(mode, pos) : null;
}

/** every open season board */
export function seasonBoards(): { mode: RankedMode; pos: PositionId }[] {
  const out: { mode: RankedMode; pos: PositionId }[] = [];
  for (const mode of RANKED_MODES)
    for (const pos of RANKED.weeklyPositions) {
      const b = boardFor(mode, pos);
      if (b && !out.some((o) => o.mode === b.mode && o.pos === b.pos)) out.push(b);
    }
  return out;
}

// ------------------------------------------------------------ weeks

const DAY = 86_400_000;
/** Monday of ISO week 2026-W01: week indexes count from here */
const WEEK_EPOCH = Date.UTC(2025, 11, 29);

/** the ISO week a moment is in (weeks start on Monday, UTC): its id ("2026-W45") and index since 2026-W01 */
export function weekOf(ms: number): { id: string; index: number } {
  const d = new Date(Math.floor(ms / DAY) * DAY);
  const day = d.getUTCDay() || 7;
  const monday = d.getTime() - (day - 1) * DAY;
  // the ISO year is the year of that week's Thursday
  const thursday = new Date(monday + 3 * DAY);
  const year = thursday.getUTCFullYear();
  const week = Math.floor((thursday.getTime() - Date.UTC(year, 0, 1)) / DAY / 7) + 1;
  return { id: `${year}-W${String(week).padStart(2, '0')}`, index: Math.round((monday - WEEK_EPOCH) / (7 * DAY)) };
}

/** this week's featured board: the first open drill, the position rotating week by week */
export function weeklyBoard(week: { index: number }): { mode: RankedMode; pos: PositionId } {
  const ps = RANKED.weeklyPositions;
  const pos = ps[((week.index % ps.length) + ps.length) % ps.length];
  return boardFor(RANKED_MODES[0], pos) ?? { mode: RANKED_MODES[0], pos };
}

// ------------------------------------------------------------ board ids

/** a board's id: ruleset, drill, position and, for a weekly board, the week ("1:spike:OH:2026-W45") */
export function boardId(mode: RankedMode, pos: PositionId, week: string | null = null, ruleset: number = RANKED.ruleset): string {
  return `${ruleset}:${mode}:${pos}${week ? `:${week}` : ''}`;
}

export interface BoardRef {
  ruleset: number;
  mode: RankedMode;
  pos: PositionId;
  week: string | null;
}

/** a board id from outside (a request): null unless it names a real, open board of this ruleset */
export function parseBoardId(id: unknown): BoardRef | null {
  if (typeof id !== 'string' || id.length > 40) return null;
  const m = /^(\d+):([a-z]+):([A-Z]+)(?::(\d{4}-W\d{2}))?$/.exec(id);
  if (!m) return null;
  const ruleset = Number(m[1]);
  const mode = m[2];
  const pos = m[3];
  if (ruleset !== RANKED.ruleset || !isRankedMode(mode) || !isPositionId(pos)) return null;
  const b = boardFor(mode, pos);
  if (!b || b.pos !== pos) return null;
  return { ruleset, mode, pos, week: m[4] ?? null };
}

// ------------------------------------------------------------ medals

export type Medal = 'coach' | 'gold' | 'silver' | 'bronze';
export const MEDALS: readonly Medal[] = ['coach', 'gold', 'silver', 'bronze'];
export const MEDAL_NAMES: Record<Medal, string> = { coach: 'Coach', gold: 'Gold', silver: 'Silver', bronze: 'Bronze' };

/** the medal a total earns on a position's board (null: none yet) */
export function medalFor(total: number, pos: PositionId): Medal | null {
  const coach = RANKED.coach[pos];
  if (coach !== undefined && total >= coach) return 'coach';
  const [bronze, silver, gold] = RANKED.medals[pos];
  return total >= gold ? 'gold' : total >= silver ? 'silver' : total >= bronze ? 'bronze' : null;
}

/** the next medal up from a total, and what it takes (null: the top medal there is) */
export function nextMedal(total: number, pos: PositionId): { medal: Medal; at: number } | null {
  const [bronze, silver, gold] = RANKED.medals[pos];
  const coach = RANKED.coach[pos];
  const steps: [Medal, number | undefined][] = [
    ['bronze', bronze],
    ['silver', silver],
    ['gold', gold],
    ['coach', coach],
  ];
  for (const [medal, at] of steps) if (at !== undefined && total < at) return { medal, at };
  return null;
}
