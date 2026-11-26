# A block is two hands the ball bounces off

The block was a box over the net and a dice table: if the ball's centre was
in the box, a roll on the jump's grade picked stuff, soft block, block-out or
recycle, and each played a set response. So where the ball met the hands and
how it was hit changed nothing, a cross shot met a box twice as wide as a
line shot, balls that had cleared the fingertips were caught behind the net,
and every block-out flew 3-4 m past the end line. Now each blocker has two
hands and two forearms in the simulation (src/game/blockHands.ts), flat
plates on arms that pivot at the shoulders, pressed over the net with the
jump and never under the tape. The ball is touched where its path passes
within its radius of one, and comes off it by an impulse with the arm's mass
behind that spot, the ball's restitution and the skin's grip
(src/physics/handContact.ts). What the touch is called is read from where the
ball then goes. The drawn hands follow the simulation's, so
[0008](0008-what-the-body-and-the-net-show-never-feeds-back-into-play.md) no
longer holds for the blocking hands: they are play, and the picture shows
them. A rule kept from the dice table was turned down, because a rule cannot
say where on the hands the ball went. A full rigid-body arm with joints was
turned down, because four plates with a mass profile give every outcome a
player recognises and stay cheap and testable.

## Consequences

The bends the dice table held for playability are now numbers on the AI's
hands (`BLOCK.ai`): how much they press, how firm they are, how far they turn
the outside hand in, and how little their hands are set against your green
set. A difficulty can change them like any other named number
([0012](0012-a-difficulty-only-overrides-numbers-that-have-a-name.md)).
`node scripts/block-sweep.mjs` measures the block across hitters, angles, speeds,
timing and where along the hands the ball crosses the net.
