import type { LevelId } from '../src/config';
import { tuningFor } from '../src/core/level';
import type { TeamAI } from '../src/ai/team';
import type { MiniRally } from '../src/game/modes/miniRally';
import { headlessGame } from './headlessGame';

/** one team's side of a level card: what it did over the rallies */
export interface TeamCard {
  /** points it won */
  won: number;
  /** its attacks (spikes and tips) that ended before the probe stopped */
  attacks: number;
  /** of those: won straight off the attack, out or in the net, stuffed by the block, kept in play by the other side */
  kills: number;
  errors: number;
  stuffed: number;
  kept: number;
  /** its attacks that were tips, and of those the kills */
  tips: number;
  tipKills: number;
  /** its quick attacks (by the middle) */
  quicks: number;
  /** its sets, and those its setter made in system */
  sets: number;
  inSystem: number;
  /** dives by its players */
  dives: number;
  /** third balls it sent over without attacking: a set, then a pass by the same side */
  freeOvers: number;
  /** high balls its hitters set back over with the hands, and of those, the ones nobody played */
  setOvers: number;
  setOverDrops: number;
}

export interface LevelCard {
  level: LevelId;
  seconds: number;
  seed: number;
  points: number;
  /** your team (your slot played by a Pro stand-in) and theirs */
  yours: TeamCard;
  theirs: TeamCard;
  /** your own attacks (the stand-in's): how many, and how many were kills, errors, stuffed */
  you: { attacks: number; kills: number; errors: number; stuffed: number };
}

const blank = (): TeamCard => ({
  won: 0,
  attacks: 0,
  kills: 0,
  errors: 0,
  stuffed: 0,
  kept: 0,
  tips: 0,
  tipKills: 0,
  quicks: 0,
  sets: 0,
  inSystem: 0,
  dives: 0,
  freeOvers: 0,
  setOvers: 0,
  setOverDrops: 0,
});

/**
 * An all-AI Mini Rally at `level` for `seconds` on the simulation's clock, seeded, read from the
 * touch log, the point banners and the two teams. Your slot (the opposite) is played by the AI as a
 * Pro: the stand-in for a player who hits as hard and as well as they can, so the card shows what
 * your attack does against the level. An attack is a spike or a tip: a kill when its side wins the next point without
 * touching the ball again and the other side never kept it up, stuffed when only their block
 * touched it before they won the point, an error when the other side won it without a touch, and
 * kept otherwise (the other side dug it, whoever won the rally).
 */
export function playLevel(level: LevelId, seconds: number, seed = 2024): LevelCard {
  const game = headlessGame('rally', 'OPP', seed, { level, autoUser: true });
  const mode = game.mode as MiniRally;
  // you: a Pro in your team's slot (the AI plays it; its brain took your team's numbers when it was made)
  const me = game.host.me;
  me.ai = tuningFor('pro', 'yours');
  const mine = mode.home.brains.get(me)!;
  mine.hitter!.skill = me.ai.hitterSkill;
  mine.hitter!.tipChance = me.ai.tipChance;
  const you = { attacks: 0, kills: 0, errors: 0, stuffed: 0 };
  const teams: Record<1 | -1, TeamAI> = { 1: mode.home, [-1]: mode.away };
  const card: Record<1 | -1, TeamCard> = { 1: blank(), [-1]: blank() };
  const events: { t: number; side: 1 | -1; kind: string; role: string }[] = [];
  const points: { t: number; winner: 1 | -1; underNet: boolean }[] = [];
  const overs: { t: number; side: 1 | -1; role: string }[] = [];
  const seenOver = new Map<unknown, unknown>();
  const diving = new Set<unknown>();
  let seenTouches = 0;
  let seenSaid = 0;
  for (let i = 0, frames = Math.round(seconds * 60); i < frames; i++) {
    game.frame();
    for (const a of game.sim.athletes) {
      if (a.state === 'dive' && !diving.has(a)) {
        diving.add(a);
        card[a.side].dives++;
      } else if (a.state !== 'dive') diving.delete(a);
    }
    for (; seenTouches < game.touches.length; seenTouches++) {
      // "12.3456 OHH spike Perfect" or "12.3456 SA set ai"
      const [t, who, kind] = game.touches[seenTouches].split(' ');
      const side = who.endsWith('H') ? 1 : -1;
      events.push({ t: Number(t), side, kind, role: who.slice(0, -1) });
      if (kind === 'set') {
        card[side].sets++;
        if (teams[side].setInSystem) card[side].inSystem++;
      }
    }
    for (const side of [1, -1] as const)
      for (const [a, b] of teams[side].brains) {
        const over = b.hitter?.setOver;
        if (over && seenOver.get(a) !== over) {
          seenOver.set(a, over);
          overs.push({ t: game.sim.simTime, side, role: a.role });
        }
      }
    for (; seenSaid < game.said.length; seenSaid++) {
      const m = /^banner POINT (YOU|THEM) /.exec(game.said[seenSaid]);
      if (m) points.push({ t: game.sim.simTime, winner: m[1] === 'YOU' ? 1 : -1, underNet: game.said[seenSaid].includes('UNDER THE NET') });
    }
  }
  for (const p of points) card[p.winner].won++;
  events.forEach((e, i) => {
    if (i > 0 && e.kind === 'pass' && events[i - 1].kind === 'set' && events[i - 1].side === e.side) card[e.side].freeOvers++;
    if (e.kind !== 'spike' && e.kind !== 'tip') return;
    const point = points.find((p) => p.t >= e.t);
    // (play still going when the probe stopped: not counted)
    if (!point) return;
    const c = card[e.side];
    const isYou = e.side === 1 && e.role === 'OPP';
    c.attacks++;
    if (isYou) you.attacks++;
    if (e.kind === 'tip') c.tips++;
    if (e.role === 'MB') c.quicks++;
    const after = events.slice(i + 1).filter((x) => x.t < point.t);
    const theirs = after.filter((x) => x.side !== e.side);
    const oursAgain = after.some((x) => x.side === e.side);
    const keptUp = theirs.some((x) => x.kind !== 'block');
    const end =
      !theirs.length && point.winner !== e.side
        ? 'errors'
        : !keptUp && !oursAgain && point.winner === e.side
          ? 'kills'
          : !keptUp && !oursAgain && point.winner !== e.side
            ? 'stuffed'
            : 'kept';
    c[end]++;
    if (e.kind === 'tip' && end === 'kills') c.tipKills++;
    if (isYou && end !== 'kept') you[end]++;
  });
  for (const o of overs) {
    const point = points.find((p) => p.t >= o.t);
    // (a set that went under the net before the hitter could get to it is the set's fault, not a set-over)
    if (!point || point.underNet) continue;
    card[o.side].setOvers++;
    const touched = events.some((x) => x.t >= o.t && x.t < point.t && x.side === o.side);
    if (!touched) card[o.side].setOverDrops++;
  }
  return { level, seconds, seed, points: points.length, yours: card[1], theirs: card[-1], you };
}

/** several cards of one level as one: the counts added up (seed 0) */
export function poolCards(cards: LevelCard[]): LevelCard {
  const add = <T extends object>(a: T, b: T): T =>
    Object.fromEntries(Object.entries(a).map(([k, v]) => [k, (v as number) + (b as Record<string, number>)[k]])) as T;
  return cards.reduce((p, c) => ({
    ...p,
    seconds: p.seconds + c.seconds,
    seed: 0,
    points: p.points + c.points,
    yours: add(p.yours, c.yours),
    theirs: add(p.theirs, c.theirs),
    you: add(p.you, c.you),
  }));
}

/** a share as a whole percent */
export const pct = (n: number, of: number): number => (of ? Math.round((100 * n) / of) : 0);

/** what a level card says, team by team, in the numbers a coach would look at */
export function cardLine(c: LevelCard): string {
  const t = (name: string, x: TeamCard, other: TeamCard) =>
    `${name} won ${pct(x.won, c.points)}% | attacks ${x.attacks}: kill ${pct(x.kills, x.attacks)}% err ${pct(x.errors, x.attacks)}% ` +
    `stuffed ${pct(x.stuffed, x.attacks)}% tip ${pct(x.tips, x.attacks)}% (kill ${pct(x.tipKills, x.tips)}%) quick ${x.quicks} | in system ${pct(x.inSystem, x.sets)}% | ` +
    `dug ${pct(other.kept, other.attacks - other.errors)}% of theirs, dives ${x.dives} | free balls ${x.freeOvers}, set over ${x.setOvers} (dropped ${x.setOverDrops})`;
  const y = c.you;
  const you = `  you     attacks ${y.attacks}: kill ${pct(y.kills, y.attacks)}% err ${pct(y.errors, y.attacks)}% stuffed ${pct(y.stuffed, y.attacks)}%`;
  return [
    `${c.level} (${c.seconds} s, ${c.seed ? `seed ${c.seed}` : 'all seeds'}, ${c.points} points)`,
    t('  yours ', c.yours, c.theirs),
    you,
    t('  theirs', c.theirs, c.yours),
  ].join('\n');
}
