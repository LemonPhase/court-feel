import { AI, FACET_IDS, LEVELS, YOURS_AT_PRO, type AiTuning, type Facet, type LevelId } from '../config';

/**
 * The level of play as a team carries it (docs/adr/0012 and 0013, `LEVELS`): a copy of `AI` with the
 * level's overrides written in, facet by facet. Your team takes every facet but `YOURS_AT_PRO` from
 * the level; the other team takes all of them. `AI` is never written: it is Pro, and every drill
 * plays at it.
 */

type Section = Record<string, unknown>;

/** which team a tuning is for: yours (the user's team-mates) or theirs */
export type TeamOf = 'yours' | 'theirs';

const isSection = (v: unknown): v is Section => !!v && typeof v === 'object' && !Array.isArray(v);

/** write `from` into `to`, key by key: nested sections in part, arrays as new copies */
function write(to: Section, from: Section): void {
  for (const [k, v] of Object.entries(from)) {
    if (v === undefined) continue;
    if (isSection(v) && isSection(to[k])) write(to[k] as Section, v);
    else to[k] = Array.isArray(v) ? [...(v as unknown[])] : v;
  }
}

/** the facets `team` takes from a level (the rest are Pro's) */
export function facetsFor(team: TeamOf): Facet[] {
  return team === 'theirs' ? [...FACET_IDS] : FACET_IDS.filter((f) => !YOURS_AT_PRO.includes(f));
}

/** how `team`'s AI players play at level `id`: a new tuning, Pro's numbers with the level's facets on top */
export function tuningFor(id: LevelId, team: TeamOf): AiTuning {
  const t = structuredClone(AI) as unknown as Section;
  const level = LEVELS[id].facets;
  for (const f of facetsFor(team)) {
    const o = level[f];
    if (o) write(t, o as Section);
  }
  return t as unknown as AiTuning;
}
