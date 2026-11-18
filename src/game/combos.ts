import { SETTER_PLAYS, type SetPlay } from './plays';
import type { SetterKey } from './setterCalls';

/**
 * Combination plays: one call for every hitter, picked together on the play wheel before the
 * pass (the setter's hand signals). Each call is a `short` name from SETTER_PLAYS. They are the
 * standard ones from coaching glossaries: the point of a combination is that two hitters attack
 * the same blocker at different tempos, or stretch the block from pin to pin.
 */
export interface Combo {
  name: string;
  /** what it does to the block, in a line (the wheel's centre) */
  idea: string;
  calls: Record<SetterKey, string>;
}

/** the set a play gives a hitter */
export function comboPlay(c: Combo, k: SetterKey): SetPlay | undefined {
  return SETTER_PLAYS[k].find((p) => p.short === c.calls[k]);
}

/** in wheel order, clockwise from the top */
export const COMBOS: readonly Combo[] = [
  {
    name: 'Base high',
    idea: 'High balls, the quick holds their middle',
    calls: { OH: 'High', MB: '1', OPP: 'Back', PIPE: 'High' },
  },
  { name: 'X', idea: 'The opposite crosses behind the quick', calls: { OH: 'Go', MB: '1', OPP: 'X', PIPE: 'High' } },
  { name: 'Tandem', idea: 'The outside hits right behind the quick', calls: { OH: '2', MB: '1', OPP: 'Back', PIPE: 'High' } },
  { name: 'Double quick', idea: 'A quick in front of you, one behind', calls: { OH: 'High', MB: '1', OPP: 'Back 1', PIPE: 'High' } },
  {
    name: '31 and 32',
    idea: 'The outside hits off the shoot’s shoulder',
    calls: { OH: '3', MB: 'Shoot', OPP: 'Fast', PIPE: 'High' },
  },
  { name: 'Fast spread', idea: 'Fast and wide, the bic behind it', calls: { OH: 'Go', MB: 'Shoot', OPP: 'Fast', PIPE: 'Bic' } },
  { name: 'Go · 1 · Red', idea: 'Fast to both pins around the quick', calls: { OH: 'Go', MB: '1', OPP: 'Fast', PIPE: 'High' } },
  { name: 'Back quick', idea: 'The quick behind you, the go in front', calls: { OH: 'Go', MB: 'Back 1', OPP: 'Back', PIPE: 'High' } },
];
