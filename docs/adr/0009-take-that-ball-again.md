# After your own mistake the same ball comes again, at the lower levels

A long rally that ends because the player swung late or let their ball drop
is demoralising, most of all for a learner. At Rec (every time) and Club
(once a rally) the Mini Rally offers that ball again: the rally goes back to
the start of the play the mistake was in, exactly as it was, and the lost
point is taken back. It is what a coach does in practice, the same toss
again; National and Pro are matches and do not offer it. The whole
simulation is saved at every touch (`src/core/memento.ts`,
`src/game/flashback.ts`), so the same ball comes until the player does
something different.

## Considered options

* **Go back a fixed number of seconds.** Turned down: it drops the player in
  mid-run or mid-jump with no time to read the ball. Going back to a touch
  (their set, our first touch, the serve) gives the ball with its whole cue.
* **Void the point and serve again.** Turned down: it takes the sting out of
  the score, but the long rally is still gone.
* **Offer it for every lost point.** Turned down: a stuffed spike, a dug
  spike and a team-mate's error are the other players' doing. Only the
  player's own error is theirs to take again.
* **A new ball of the same kind, not the same ball.** Turned down: repeating
  the exact rep is the learning value, and re-rolling the set or the serve
  would change what was missed.

## Consequences

* Anything a player's next move depends on has to be part of what is saved.
  Hidden state (a cache worked out again, a module-level map) makes the
  players drift from what they did the first time. The ball's prediction is
  saved to the bit, the approach planner's scratch athletes are saved, and
  the side a player gives way on lives on the athlete for that reason.
  `tests/flashback.test.ts` plays a team on from a touch, goes back and plays
  on again, and compares every position.
