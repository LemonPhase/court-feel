# What the body and the net show never feeds back into the play

The simulation knows an athlete as a point with a reach, and the net as a
plane the ball bounces off. Everything drawn on top of that is drawn after
the step and never read back by it: the hand placed on the ball, the arm
and head held off the net below the tape, the net mesh bulging where the
ball hit it. Giving the simulation arms to collide with the net, or a net
that stretches, would have changed where balls go and what a late swing
costs, and the look is not allowed to do that.

## Consequences

The same inputs give the same contact, to the millisecond, whatever is
drawn. Where the picture and the simulation would disagree, the picture
gives way: blocking hands stay about 17 cm on their own side of the tape,
because that is where the block's contact zone is.
