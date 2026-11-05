// The game's side of the online leaderboard: who you are (a random id and a nickname in this
// browser, no accounts) and the requests. Every call resolves to null when the leaderboard can't be
// reached (offline, or not set up on this deployment): the game never depends on it.
import { BUILD_ID } from '../core/build';
import type { RankedRun } from '../game/ranked';
import { cleanName, isPlayerId, type BoardView, type MedalView, type RunSubmission, type SubmitResult } from './protocol';

const PLAYER_KEY = 'courtfeel.player.v1';
const API = 'api/leaderboard';

export interface Player {
  id: string;
  /** your name on the boards (null until you pick one) */
  name: string | null;
}

function newId(): string {
  try {
    return crypto.randomUUID();
  } catch {
    return `p-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 12)}`;
  }
}

/** you, as this browser knows you (an id is made the first time) */
export function loadPlayer(): Player {
  let p: Partial<Player> = {};
  try {
    p = JSON.parse(localStorage.getItem(PLAYER_KEY) ?? '{}') as Partial<Player>;
  } catch {
    /* blocked or broken storage: a fresh id for this session */
  }
  const player: Player = { id: isPlayerId(p.id) ? p.id : newId(), name: cleanName(p.name) };
  savePlayer(player);
  return player;
}

function savePlayer(p: Player): void {
  try {
    localStorage.setItem(PLAYER_KEY, JSON.stringify(p));
  } catch {
    /* ignore */
  }
}

/** set your name (null if it isn't a valid name) */
export function setPlayerName(name: string): Player | null {
  const clean = cleanName(name);
  if (!clean) return null;
  const p = { ...loadPlayer(), name: clean };
  savePlayer(p);
  return p;
}

/** a finished run as the leaderboard takes it */
export function toSubmission(
  run: RankedRun,
  player: Player,
  how: { cam: 'fp' | 'tp'; input: 'mouse' | 'touch'; hand: 'right' | 'left' },
): RunSubmission {
  return {
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

async function call<T>(init?: RequestInit, query = ''): Promise<T | null> {
  try {
    const res = await fetch(`${API}${query}`, { ...init, headers: { 'content-type': 'application/json' } });
    if (!res.ok) return null;
    return (await res.json()) as T;
  } catch {
    return null;
  }
}

export const submitRun = (s: RunSubmission): Promise<SubmitResult | null> =>
  call<SubmitResult>({ method: 'POST', body: JSON.stringify(s) });

export const fetchBoard = (board: string, player: string): Promise<BoardView | null> =>
  call<BoardView>(undefined, `?board=${encodeURIComponent(board)}&player=${encodeURIComponent(player)}`);

export const fetchMedals = (player: string): Promise<MedalView | null> =>
  call<MedalView>(undefined, `?view=medals&player=${encodeURIComponent(player)}`);
