import type { LevelId } from '../src/config';
import { headlessGame } from './headlessGame';

/** how an attack ended */
export type AttackEnd = 'kill' | 'stuffed' | 'error' | 'kept';

export interface LevelStats {
  level: LevelId;
  seconds: number;
  points: number;
  attacks: number;
  /** each attack's end, counted */
  ends: Record<AttackEnd, number>;
  /** attacks whose next touch by the other side was a block */
  touchedBlock: number;
  /** attacks that were tips (a soft touch over the block) */
  tips: number;
  /** attacks by a middle (the quick) */
  quicks: number;
  /** each point's call from the banner (KILL, OUT, BLOCKED, ...) */
  reasons: Record<string, number>;
  /** every touch by kind (pass, dig, set, spike, tip, block, free, serve, ...) */
  kinds: Record<string, number>;
  /** dives by AI players */
  dives: number;
  /** third balls sent over with the arms or the hands, not attacked: a set, then a pass by the same side */
  freeOvers: number;
}

/**
 * All-AI Mini Rally at `level` (both teams, the user's slot played by the AI) for `seconds` of play
 * on the simulation's own clock, read from the touch log and the point banners. An attack is a spike
 * or a tip; it is a kill when the attacking side wins the next point without touching the ball again,
 * stuffed when the other side's block is the only touch before they win it, an error when the other
 * side wins it without touching it, and kept otherwise.
 */
export function playLevel(level: LevelId, seconds: number, seed = 2024): LevelStats {
  const game = headlessGame('rally', 'OH', seed, { level, autoUser: true });
  const events: { t: number; side: 1 | -1; kind: string; role: string }[] = [];
  const points: { t: number; winner: 1 | -1; reason: string }[] = [];
  let seenTouches = 0;
  let seenSaid = 0;
  let dives = 0;
  const diving = new Set<unknown>();
  const frames = Math.round(seconds * 60);
  for (let i = 0; i < frames; i++) {
    game.frame();
    for (const a of game.sim.athletes) {
      if (a.state === 'dive' && !diving.has(a)) {
        diving.add(a);
        dives++;
      } else if (a.state !== 'dive') diving.delete(a);
    }
    for (; seenTouches < game.touches.length; seenTouches++) {
      // "12.3456 OHH spike Perfect" or "12.3456 SA set ai"
      const [t, who, kind] = game.touches[seenTouches].split(' ');
      events.push({ t: Number(t), side: who.endsWith('H') ? 1 : -1, kind, role: who.slice(0, -1) });
    }
    for (; seenSaid < game.said.length; seenSaid++) {
      const m = /^banner POINT (YOU|THEM) . (.+?) (good|bad)/.exec(game.said[seenSaid]);
      if (m) points.push({ t: game.sim.simTime, winner: m[1] === 'YOU' ? 1 : -1, reason: m[2] });
    }
  }
  const stats: LevelStats = {
    level,
    seconds,
    points: points.length,
    attacks: 0,
    ends: { kill: 0, stuffed: 0, error: 0, kept: 0 },
    touchedBlock: 0,
    tips: 0,
    quicks: 0,
    reasons: {},
    kinds: {},
    dives,
    freeOvers: events.filter((e, i) => i > 0 && e.kind === 'pass' && events[i - 1].kind === 'set' && events[i - 1].side === e.side).length,
  };
  for (const p of points) stats.reasons[p.reason] = (stats.reasons[p.reason] ?? 0) + 1;
  for (const e of events) stats.kinds[e.kind] = (stats.kinds[e.kind] ?? 0) + 1;
  events.forEach((e, i) => {
    if (e.kind !== 'spike' && e.kind !== 'tip') return;
    const point = points.find((p) => p.t >= e.t);
    // (play still going when the probe stopped: not counted)
    if (!point) return;
    stats.attacks++;
    if (e.kind === 'tip') stats.tips++;
    if (e.role === 'MB') stats.quicks++;
    const after = events.slice(i + 1).filter((x) => x.t < point.t);
    const theirs = after.filter((x) => x.side !== e.side);
    const firstTheirs = theirs[0];
    if (firstTheirs?.kind === 'block') stats.touchedBlock++;
    const oursAgain = after.some((x) => x.side === e.side);
    let end: AttackEnd = 'kept';
    if (!oursAgain && point.winner === e.side && !theirs.some((x) => x.kind !== 'block' && x.t > (firstTheirs?.t ?? 0) + 2)) end = 'kill';
    else if (!theirs.length && point.winner !== e.side) end = 'error';
    else if (theirs.length && theirs.every((x) => x.kind === 'block') && point.winner !== e.side && !oursAgain) end = 'stuffed';
    // a ball the other side touched and kept in play is kept, whoever won the rally later
    if (end === 'kill' && theirs.some((x) => x.kind !== 'block' && after.some((y) => y.side === x.side && y.t > x.t && y !== x)))
      end = 'kept';
    stats.ends[end]++;
  });
  return stats;
}

/** a share as a whole percent */
export const pct = (n: number, of: number): number => (of ? Math.round((100 * n) / of) : 0);
