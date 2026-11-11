# AI players act on reads, not on the ball's true future

The game always knows where the ball will go, and the first AI used it: the
defence started for a spike 42 ms after the hit and dug almost everything. Now
an AI player acts on what a player on court could know: it reacts a human
reaction time after each touch (about 0.2-0.25 s), its read of where the ball
is going is rough off the hands and sharpens as the arc turns over, and it
reads the ball and the bodies it can see (an approach, a plant, the block's
hands), never the other team's plan. `src/ai/read.ts` is the read; the middle
blocker, the defence and the setter's release all go through it. A stronger AI
gets better reads and quicker reactions, not knowledge it couldn't have.
