# Mini Rally

Mini Rally is 6 v 6 with the player in their chosen position. The AI serves, receives, sets, attacks, blocks and digs around them. The HUD keeps the score and says who serves, a hitter can call their set with `1`, `2`, `3`, the setter calls the pass in a speech bubble, and `n` re-serves.

## Sub-features

- `rally-start` puts twelve athletes on court with the score at 0 : 0 and the opponents serving.
- `rally-set-call` changes your set call with `1`, `2`, `3` (OH, OPP and MB), shown on the score line.
- `rally-serve` starts each point with a serve: about 6 AI serves in 10 are jump serves (the server walks in, tosses about 4.5 m up, takes off behind the end line and lands in the court), the rest standing floats. An AI serve can be an ace but never a serve error (a mistimed one is a slower, easier serve that still lands in); only the user can miss a serve. A jump server never lets the toss drop untouched.
- `rally-your-ball` a serve, attack or free ball coming to the home side goes to the player who gets there first ("Your ball!" and a green marker when it is the user). A ball in the seam between two players goes to the libero or the user, never one that a team-mate is clearly closer to; the setter digs only a ball nobody else is close to. A ball off a block (either side's) that the libero can get to is the libero's, even with the user or a team-mate nearer: it takes over from whoever was sent.
- `rally-defence` the AI defenders play the first ball in four ways, named in the contact's `note`: a platform dig (no note or a grade note), `Side dig` (a ball past the hip, never Perfect), `Dive` (a ball out of reach on foot: the athlete slides along the floor and gets back up) and `Overhand` (a slow ball at head height passed with the hands). A ball off the team's own block is chased wherever it goes, and on a ball the one sent may not reach a team-mate runs with them. An AI dive (even at a ball just past the hands, often a `Late` touch) only keeps the ball alive: it pops up a couple of metres toward the middle of the court, not to the setter, for that team-mate to play. An AI setter who arrives after the ball has dropped below the hands digs it (platform or dive) instead of letting it drop.
- `rally-transition` after a block (or any attack that stays on their side of the net) the AI front-row players who aren't playing the ball leave the net for their approach starts once they are back on the floor; a ball their block sends back over keeps them at the net. A middle never starts its quick from the net (at least 2 m off it). While a set flies to a hitter, the others cover low in the real spots: on a pin attack the middle at the net inside the hitter, the setter on the 3 m line, the back-row player on that side behind the hitter on the sideline (the middle back on the right), two deep; on a quick the setter close and the pins on the 3 m line; on the pipe the middle under the block. A soft ball into a well-formed block can come back to the hitter's side (`Off the block`); the cover digs it up high to the middle of the court (`Covered`), always out of system.
- `rally-setter-call` shows the setter's call on the pass (for example `SHOOT!` in system, `HIGH!` out of system) in a bubble. A pass going over the net (coming down 0.25 m or more into their court) is an overpass: the setter stays and calls nothing, and the front row waits at the net. When the setter calls `HELP!` the libero sets it (a high ball to a pin) if it can get there; the libero's set is only as good as the ball lets it be (off a ball it ran down far from the setter's spot it misses its hitter, and one too hard to set it bumps up high to the 3 m line instead; a set to the user is always clean); otherwise whoever is nearest bumps it high to the 3 m line, and the third ball goes over from there as a free ball (an AI's aimed deep to a corner or short over the net), never bumped over from under the net. When the user is nearest, it is the user's ball ("Your ball!", the green marker and a `YOUR BALL · the setter can't get there` hint).
- `rally-net` a ball driven into the net sinks into it (the drawn mesh goes in with it, then settles) and drops down by the net, coming out at most about a metre on the hitter's side; a ball hit into the side of the tape does the same, while a ball clipping the top of the tape can still roll over.
- `rally-easier` playability bends in the user's favour (`config.ts` says so where they are): an AI defender shanks at least 6 in 10 of the user's hard spikes (over 14 m/s) it gets to, off the arms within 100 degrees of the spike's line; the user's spike off the outer part of an AI block is tooled more often; an AI hitter misreads the user's block 3 times in 10.
- `rally-point` ends the rally with a banner, updates the score and names the next server.
- `rally-reserve` abandons the rally with `n` and serves again without changing the score.

## How to get to it (user POV)

- On the start screen open Play, choose a position and start with `PLAY`, Enter or a double-click on the Mini Rally row. [Start screen](./start-screen.md) drives this entry.
- Open a quick-start link: `?mode=rally&pos=MB`, with `OH`, `OPP`, `MB`, `S` or `L`.
- In the pause menu of a running rally choose `Restart drill`.

## Driving it with court.mjs

Preconditions:

- A desktop session is running and `court doctor` ends with `HEALTHY`.
- The recipe uses the manual clock and the autopilot for the player's athlete (test hooks). Name them in the proof.

- **Start.** Open the rally as a middle blocker with the clock frozen. Run `court open '?mode=rally&pos=MB&bot=perfect' --fresh --manual`. The state line shows `"title":"Mini Rally · you are the Middle Blocker"` and `"score":"YOU 0 : 0 THEM · their serve · call 1: 1 (quick in front)"`. Run `court state`: `game.athletes` is `12`.
- **Call your set.** Press `2`. Run `court key 2` and `court step 0.05`. The state line shows a score ending `call 2: Shoot (31)` and `"message":"Calling 2: Shoot (31)"`.
- **Serve.** Step until the serve is hit. Run `court step 30 --until 'window.__verify.events.some(e => e.type === "contact" && e.kind === "serve")'`. Run `court events`: the first entry is a `contact` with `"kind": "serve"` by an `(away)` athlete.
- **The setter calls the pass.** Step until the call. Run `court step 10 --until 'window.__verify.events.some(e => e.type === "setterCall")'`. The state line shows a call such as `"call":{"who":"SETTER","word":"SHOOT!","sub":"in system"}` (or `HIGH!` / `out of system` off a bad pass). Run `court shot rally-setter-call`: the bubble over the setter.
- **Point.** Step until the ball is down. Run `court step 30 --until 'window.__verify.events.some(e => e.type === "outcome")'`. The state line shows a banner `POINT YOU · <reason>` or `POINT THEM · <reason>` and a score of `YOU 1 : 0 THEM · your serve ...` or `YOU 0 : 1 THEM · their serve ...` to match. Run `court events`: the last entry is an `outcome` whose `winner` is `home` for a point to YOU and `away` for a point to THEM. Run `court shot rally-point`.
- **Re-serve.** Step into the next rally, then press `n`. Run `court step 30 --until 'g.ball.active && g.ballLive'`, `court key n`, `court step 0.05` and `court state`. `game.ball` is `null` and `game.score.home` and `game.score.away` are unchanged. Run `court step 30 --until 'g.ball.active && g.ballLive'`: it succeeds, so a new serve came.
- **Proof.** Run `court errors`. It reports `"count": 0`.

## Gotchas

- A point can end on the serve (an ace, a shank off the pass, or the user's own serve landing out or in the net) with no setter call in it. If the call step times out, check `court events` for an `outcome`, then step into the next rally and wait for the call there. Which call comes first depends on the rally's random stream: assert its shape, not the word.
- The autopilot is weaker here than in the drills. When this was written, as OH it swung late on every set (`MISS`, `Swung late`), as OPP it made no contact in 40 seconds, as MB it hit Perfect quicks when set, as L it passed and as S it set. A rally result is not a fixed number: assert the shape (a serve, an outcome, a score that matches the outcome), not who won.
- The setter does not set the player every time. In the recipe's rally the set goes to the outside hitter, so `events` may show no contact by `me`.
- `rally-defence` was measured with an all-AI probe (`g.autoUser = true`, the manual clock, 1000 s of rallies): about 7 dives, 2 side digs and 7 overhand passes for every 16 platform digs. In a short recipe there may be none: step on with `court step 30 --until 'window.__verify.events.some(e => e.note === "Dive")'` and take the `shot` straight after, while the athlete is on the floor (about 1 s).
- The call bubble is on screen for about 1.5 seconds of game time. Take the `shot` straight after the `step --until` that waits for it.
- The recipe starts on `their serve`. `your serve` needs the home team to win a point first. Who serves for the home team, and whether the player serves, was not driven when this was written. Add it to this file when you verify it.
- S and L have no set calls: the score line has no `call` part and `1` to `3` do nothing.
- A fast call (`Go`, `Shoot`, `Fast back`) only happens off a good pass. Out of system the bubble says `HIGH!` and the set is a high ball whatever was called.
- A hand-played rally on the manual clock is possible (`keydown`, `step`, `mouse`), but the ball does not wait. Plan each step against `court state` (`game.ball`, `game.me`).
