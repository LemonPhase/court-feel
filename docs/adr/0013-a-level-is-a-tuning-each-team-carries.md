# A level is a tuning each team carries, made of facets

ADR 0012 left open how a level's overrides reach the code. They reach it as a
tuning: a copy of `AI` with the level's overrides written in, built once when
the rally starts and handed to a team (`TeamAI.ai`), which hands it to each
of its players (`Athlete.ai`). Every AI decision reads the tuning of the
player making it, and `AI` itself is never written: it is Pro, the default
for anyone without a team (the drills). A level is not one list of numbers
but a set of facets (body, serve, pass, set, attack, block, dig), each the
overrides of its own top-level `AI` keys (`FACETS`), so the two teams can
take different facets from one level: the other team plays the whole level,
while yours keeps its pass and dig at Pro (`YOURS_AT_PRO`), because the
player is the one who should make the difference, not their team-mates'
defence. Writing the level into the shared `AI` was turned down: both teams
then play the same level, a level left applied leaks into the next drill or
test, and two seats or two matches (#18) cannot hold two levels at once.

## Considered options

- **Write the level into `AI` when the rally starts, Pro when it ends.** It
  was the first build. One level for both teams, global state to reset, and a
  read that forgets the reset plays the wrong level.
- **Pass the tuning to each brain's constructor.** It works for the brains,
  but the contact system and the body also read AI numbers for an AI player
  (a stuff, an AI hitter's soft shot, the body's jump), and they have the
  athlete, not the brain. The athlete carries it.
- **One override list per level, with "yours" and "theirs" copies.** Two
  lists drift apart, and nobody can say which part of a level is its defence.

## Consequences

- No file under `src/ai/` imports `AI`, and no file reads a number a facet
  names from `AI` itself: it reads `athlete.ai` or `team.ai` (held by
  `tests/architecture.levels.test.ts`). A new AI number is per team from the
  day it is added, and a level can override it by naming it in a facet.
- A number a level overrides is in exactly one facet, and the type of each
  facet only takes its own keys. A new override has to say whether it rises
  or falls with the level (`LEVEL_ORDER` in `tests/levels.test.ts`), so a
  level that is out of order fails a test, not a playtest.
- What a level is for is written as outcomes, not numbers: the level card
  (`npm run levels`) plays seeded all-AI rallies at each level and prints, for
  each team, the points, the kills, the errors, the tips, the attacks dug and
  how often the attack was in system. `tests/levels.test.ts` holds the facts
  that must stay true whatever the numbers are (at Rec the other team tips far
  more than at Pro, hardly hits out, kills far less, sets a ball it cannot hit
  back over, and most attacks are in system). When an AI change moves an
  outcome, the card shows which level moved, and the facet to re-tune is the
  one that owns the cause, never the outcome.

## When the AI changes

1. A new AI number goes in `AI` as Pro plays it. If a level should change it,
   add its key to the one facet that owns that part of the game, give each
   level that differs its override, and give it a direction in `LEVEL_ORDER`.
2. A change to how the brains play: run `npm run levels` on `main` and on the
   branch and compare the pooled lines (one seed is too few points to read).
3. If a level's outcome moved, find the cause and re-tune the facet that owns
   it at that level. A test in `tests/levels.test.ts` that fails is a level
   that no longer plays like its league: fix the tuning, not the test.
4. A mode that plays more than one team (a full match, two seats online) makes
   a `TeamAI` with `tuningFor(level, team)` for each team; nothing else needs
   to know the level.