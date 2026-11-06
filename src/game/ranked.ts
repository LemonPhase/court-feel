import { RANKED, type PositionId, type Settings } from '../config';
import { Rng } from '../core/mathx';
import type { Grade } from './athlete';
import type { BestRun } from './bests';
import { boardId, type RankedMode } from './boards';
import type { BlockTakes } from './blockPlan';

export { isRankedMode, RANKED_MODES, rankedBoard, type RankedMode } from './boards';

/** a 32-bit hash of the parts (FNV-1a over their text, then a final avalanche): the same number in every browser */
export function hash32(...parts: (string | number)[]): number {
  const text = parts.join('|');
  let h = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  h ^= h >>> 16;
  h = Math.imul(h, 0x85ebca6b);
  h ^= h >>> 13;
  h = Math.imul(h, 0xc2b2ae35);
  h ^= h >>> 16;
  return h >>> 0;
}

/** every board has its own fixed seed for the season, and a weekly board one for its week */
export const boardSeed = (mode: RankedMode, pos: PositionId, season: number = RANKED.seasonSeed, week: string | null = null): number =>
  week ? hash32(season, mode, pos, week) : hash32(season, mode, pos);

/** rep k (0-based) of a board: generated from its own seed, so it is the same ball however the earlier reps went */
export const repSeed = (board: number, k: number): number => hash32(board, k);

/** the settings a ranked run locks (they change physics, timing, reach or your body), as they apply to this position */
export function lockedKey(s: Settings, pos: PositionId): string {
  return JSON.stringify([s.aimAssist, s.slowmoAssist, s.womenNet, s.bodies[pos] ?? null]);
}

/** the Spike Drill's set call (0-based) and opposing block for one rep */
export interface ScriptedRep {
  call: number;
  block: 0 | 1 | 2;
  /** the side the block takes away (when there is one): the same for everyone, from the rep's seed */
  takes: BlockTakes;
}

/**
 * The Spike Drill script for rep k (0-based): `calls` is how many set calls the position has
 * (0 = none: only the block follows the script). A mixed call and the block's side are drawn from
 * the rep's seed.
 */
export function spikeScript(k: number, seed: number, calls: number): ScriptedRep {
  let first = 0;
  const steps = RANKED.spikeScript;
  let step = steps[steps.length - 1];
  for (const s of steps) {
    if (k < first + s.reps) {
      step = s;
      break;
    }
    first += s.reps;
  }
  const takes: BlockTakes = new Rng(hash32(seed, 'takes')).next() < 0.5 ? 'line' : 'cross';
  if (calls <= 0) return { call: 0, block: step.block, takes };
  const call = step.call === 'mix' ? Math.floor(new Rng(hash32(seed, 'call')).next() * calls) : Math.min(step.call, calls - 1);
  return { call, block: step.block, takes };
}

/** one rep of a ranked run, as the results screen shows it */
export interface RepResult {
  points: number;
  /** what happened: KILL · ON TARGET, STUFF BLOCK!, 3-PASS, SKIPPED... */
  label: string;
  /** the timing grade of your contact, if you made one */
  grade: Grade | null;
  /** ball speed off your hand (attacks) */
  kmh: number | null;
  /** N: skipped, scored as 0 */
  skipped: boolean;
}

/** how a rep went, for the run strip: a Perfect or Good contact that scored, a weak one, or no points */
export type RepMark = 'perfect' | 'good' | 'weak' | 'zero';

export function repMark(r: RepResult): RepMark {
  if (r.points <= 0) return 'zero';
  return r.grade === 'Perfect' ? 'perfect' : r.grade === 'Good' ? 'good' : 'weak';
}

/**
 * A ranked run: a fixed number of reps on one board (drill × position) with that board's seeds and
 * locked settings. The drill records each rep; N records a 0. Pure: no scene, no DOM.
 */
export class RankedRun {
  readonly reps: RepResult[] = [];
  readonly seed: number;
  /** a locked setting changed mid-run: the run still finishes but does not count */
  unranked = false;
  /** the drill's best streak, filled in when the run ends */
  bestStreak = 0;
  /** your best run on this board before this one (null: none yet) */
  best: BestRun | null = null;
  /** the run has ended and replaced your best */
  newBest = false;
  private locked: string;

  /** wall-clock start (ms), for the run's length */
  readonly startedAt = Date.now();

  constructor(
    readonly mode: RankedMode,
    readonly pos: PositionId,
    settings: Settings,
    /** a weekly board's week ("2026-W45"), or null for the season board */
    readonly week: string | null = null,
  ) {
    this.seed = boardSeed(mode, pos, RANKED.seasonSeed, week);
    this.locked = lockedKey(settings, pos);
  }

  /** the board this run counts on (also the key of your best) */
  get board(): string {
    return boardId(this.mode, this.pos, this.week);
  }

  get length(): number {
    return RANKED.reps;
  }

  /** all reps played */
  get done(): boolean {
    return this.reps.length >= RANKED.reps;
  }

  /** the rep being played (0-based) */
  get current(): number {
    return Math.min(this.reps.length, RANKED.reps - 1);
  }

  seedFor(k: number): number {
    return repSeed(this.seed, k);
  }

  get total(): number {
    return this.reps.reduce((s, r) => s + r.points, 0);
  }

  get perfects(): number {
    return this.reps.filter((r) => r.grade === 'Perfect').length;
  }

  /** ahead (+) or behind (-) your best after as many reps as you have played (null: no best, or no rep yet) */
  get split(): number | null {
    const n = this.reps.length;
    if (!this.best || n === 0) return null;
    let bestSoFar = 0;
    for (let i = 0; i < n; i++) bestSoFar += this.best.reps[i] ?? 0;
    return this.total - bestSoFar;
  }

  record(r: Omit<RepResult, 'skipped'>): void {
    if (this.done) return;
    this.reps.push({ ...r, skipped: false });
  }

  /** N: the rep counts, as 0 */
  skip(): void {
    if (this.done) return;
    this.reps.push({ points: 0, label: 'SKIPPED', grade: null, kmh: null, skipped: true });
  }

  /** after a settings change: true when a locked setting changed and the run has just become unranked */
  checkSettings(s: Settings): boolean {
    if (this.unranked || lockedKey(s, this.pos) === this.locked) return false;
    this.unranked = true;
    return true;
  }
}
