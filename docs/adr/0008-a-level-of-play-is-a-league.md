# A level of play is a league

The Mini Rally was tuned to men's numbers (0007) and a player who hit on time
but did not place the ball scored on a third of attacks: half touched the
block and a clean spike was dug half the time. Difficulty is now a level of
play (Rec, Club, National, Pro; `LEVELS` in `src/config.ts`), and a level is a
league: it sets how every AI player on both teams reads, reacts, times a touch
and chooses, and how high, fast and hard their bodies are. It never touches
the rules of the touch (`TIMING`, `CONTACT`, `BALL`, `ASSIST`), so a Perfect
is the same Perfect at every level, and the user's body stays their own
setting. Pro is the tune of 0007, built from the `AI` numbers.

## Considered options

* **Opponents only, team-mates stay Pro.** Turned down: with Pro team-mates
  against a Rec side the user's team wins without them. With both teams at the
  level the match is even and the score is about what the user adds.
* **One difficulty slider that scales every number.** Turned down: the levels
  differ in kind (Rec has no jump serves, fast sets or dives), and each skill
  has to move with the skill it plays against (the serve with the reception,
  the spike's power with the defender's reaction), which one scale cannot do.
* **Easier touch rules at lower levels** (wider windows, more shanks for the
  AI). Turned down: it grades the same touch differently, against 0007.
* **Skills only, pro bodies at every level.** Turned down: a Rec side would
  still serve and spike at pro speed at the libero and the blockers.
