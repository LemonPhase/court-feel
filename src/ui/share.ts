import { POSITIONS, RANKED } from '../config';
import { MEDAL_NAMES, medalFor } from '../game/boards';
import { MODE_INFO } from '../game/modes/mode';
import { repMark, type RankedRun, type RepMark } from '../game/ranked';
import { formatPoints } from './hud';

/** the run strip's colours as squares: gold Perfect, blue Good, orange weak, red nothing */
const SQUARE: Record<RepMark, string> = { perfect: '\u{1F7E8}', good: '\u{1F7E6}', weak: '\u{1F7E7}', zero: '\u{1F7E5}' };

/**
 * A finished run as a few lines of text for a group chat (like Wordle's grid): the board, the
 * total, the medal and place, one square per rep, and a link that opens the same board.
 */
export function shareText(run: RankedRun, opts: { link: string; place?: { rank: number; count: number } | null }): string {
  const board = `${MODE_INFO[run.mode].title} · ${POSITIONS[run.pos].name} · ${run.week ? `week ${run.week.slice(-2)}` : `season ${RANKED.ruleset}`}`;
  const medal = medalFor(run.total, run.pos);
  const head = [`${formatPoints(run.total)} pts`];
  if (medal) head.push(MEDAL_NAMES[medal]);
  if (run.newBest) head.push('new PB');
  if (opts.place) head.push(`#${opts.place.rank} of ${opts.place.count}`);
  const squares = run.reps.map((r) => SQUARE[repMark(r)]);
  const rows = [squares.slice(0, 10).join(''), squares.slice(10).join('')].filter(Boolean);
  const link = `${opts.link}?ranked=${run.week ? 'weekly' : `${run.mode}&pos=${run.pos}`}`;
  return [`Court Feel · ${board}`, head.join(' · '), ...rows, link].join('\n');
}
