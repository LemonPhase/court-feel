import { describe, expect, it } from 'vitest';
import { LEVEL_IDS } from '../src/config';
import { cardLine, playLevel, poolCards } from './levelProbe';

/**
 * The level card (`npm run levels`; docs/adr/0013): seeded all-AI Mini Rallies at every level, team
 * by team. Not part of `npm test` (it plays an hour of rallies a level, about two minutes to run):
 * run it after an AI change and before re-tuning a level, and compare it with the facts in
 * `tests/levels.test.ts`. One seed is 30 to 40 points, too few to tune on: read the pooled line.
 */
const SECONDS = 900;
const SEEDS = [7, 2024, 11, 99];

describe.runIf(import.meta.env.MODE === 'card')('the level card', () => {
  it('plays every level and prints what each team did', () => {
    const lines: string[] = [];
    for (const level of LEVEL_IDS) {
      const cards = SEEDS.map((seed) => playLevel(level, SECONDS, seed));
      lines.push(...cards.map(cardLine), cardLine(poolCards(cards)));
    }
    console.log(`\n${lines.join('\n\n')}\n`);
    expect(lines).toHaveLength(LEVEL_IDS.length * (SEEDS.length + 1));
  }, 900_000);
});
