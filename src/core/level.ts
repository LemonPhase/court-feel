import { AI, CONTACT, LEVELS, type LevelId } from '../config';

/**
 * The level of play (docs/adr/0012, `LEVELS`): a level is a set of overrides of named config numbers,
 * applied once when a Mini Rally starts. `AI` and the user's bends in `CONTACT` are put back to Pro
 * (config as written) and the level's overrides go on top, so game code just reads the numbers and
 * never asks which level it is in. Every other drill plays at Pro.
 */

type Section = Record<string, unknown>;

/** Pro: the sections as config wrote them, copied before any level was applied */
const PRO_AI = structuredClone(AI) as Section;
const PRO_CONTACT = {
  userSpikeShank: CONTACT.userSpikeShank,
  userToolEdge: CONTACT.userToolEdge,
  userToolEdgeP: CONTACT.userToolEdgeP,
};

let current: LevelId = 'pro';

/** the level the numbers are set to now */
export function currentLevel(): LevelId {
  return current;
}

const isSection = (v: unknown): v is Section => !!v && typeof v === 'object' && !Array.isArray(v);

/** write `from` into `to`, key by key: nested sections in part, arrays as new copies */
function write(to: Section, from: Section): void {
  for (const [k, v] of Object.entries(from)) {
    if (v === undefined) continue;
    if (isSection(v) && isSection(to[k])) write(to[k] as Section, v);
    else to[k] = Array.isArray(v) ? [...(v as unknown[])] : v;
  }
}

/** set the AI's numbers (and the bends toward the user) to level `id`: Pro first, then its overrides */
export function applyLevel(id: LevelId): void {
  write(AI as unknown as Section, PRO_AI);
  Object.assign(CONTACT, PRO_CONTACT);
  write(AI as unknown as Section, LEVELS[id].ai as Section);
  Object.assign(CONTACT, LEVELS[id].contact);
  current = id;
}
