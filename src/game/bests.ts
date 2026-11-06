import { RANKED } from '../config';
import type { RankedRun } from './ranked';

/** your best ranked run on one board, kept in this browser */
export interface BestRun {
  total: number;
  /** points per rep: later runs are split against these, rep by rep */
  reps: number[];
  perfects: number;
  bestStreak: number;
  /** when it was set (ms since 1970) */
  at: number;
}

/** where the bests live: the key and value parts of localStorage that bests use */
export interface BestStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

const KEY = 'courtfeel.bests.v1';

/** the best a finished run would leave */
export function bestFrom(run: RankedRun, at: number): BestRun {
  return { total: run.total, reps: run.reps.map((r) => r.points), perfects: run.perfects, bestStreak: run.bestStreak, at };
}

/** does this run beat your best? Higher total, then more Perfects, then the longer streak; a full tie keeps the earlier run */
export function beats(run: { total: number; perfects: number; bestStreak: number }, best: BestRun | null): boolean {
  if (!best) return true;
  if (run.total !== best.total) return run.total > best.total;
  if (run.perfects !== best.perfects) return run.perfects > best.perfects;
  return run.bestStreak > best.bestStreak;
}

const count = (v: unknown): v is number => typeof v === 'number' && Number.isInteger(v) && v >= 0;

/**
 * Stored bests are untrusted (another build, or edited by hand): an entry is kept only if every
 * field has the right type, it has at most a run's worth of reps, and its reps add up to its total.
 */
export function sanitizeBests(raw: unknown): Record<string, BestRun> {
  const out: Record<string, BestRun> = {};
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return out;
  for (const [key, v] of Object.entries(raw as Record<string, unknown>)) {
    if (!v || typeof v !== 'object') continue;
    const b = v as Record<string, unknown>;
    const reps = b.reps;
    if (!Array.isArray(reps) || reps.length > RANKED.reps || !reps.every(count)) continue;
    if (!count(b.total) || !count(b.perfects) || !count(b.bestStreak) || typeof b.at !== 'number' || !Number.isFinite(b.at)) continue;
    if (reps.reduce((s: number, p: number) => s + p, 0) !== b.total) continue;
    out[key] = { total: b.total, reps: [...reps], perfects: b.perfects, bestStreak: b.bestStreak, at: b.at };
  }
  return out;
}

function defaultStorage(): BestStorage | null {
  try {
    return typeof localStorage === 'undefined' ? null : localStorage;
  } catch {
    return null;
  }
}

export function loadBests(storage: BestStorage | null = defaultStorage()): Record<string, BestRun> {
  try {
    const raw = storage?.getItem(KEY);
    return raw ? sanitizeBests(JSON.parse(raw)) : {};
  } catch {
    /* private mode / blocked storage / unparseable JSON: no bests */
    return {};
  }
}

export function saveBest(key: string, best: BestRun, storage: BestStorage | null = defaultStorage()): void {
  try {
    const all = loadBests(storage);
    all[key] = best;
    storage?.setItem(KEY, JSON.stringify(all));
  } catch {
    /* ignore */
  }
}
