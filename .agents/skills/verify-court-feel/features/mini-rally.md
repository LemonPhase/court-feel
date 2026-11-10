# Mini Rally

Mini Rally is 6 v 6 with the player in their chosen position. The AI serves, receives, sets, attacks, blocks and digs around them. The HUD keeps the score and says who serves, a hitter can call their set with `1`, `2`, `3`, the setter calls the pass in a speech bubble, and `n` re-serves.

## Sub-features

- `rally-start` puts twelve athletes on court with the score at 0 : 0 and the opponents serving.
- `rally-set-call` changes your set call with `1`, `2`, `3` (OH, OPP and MB), shown on the score line.
- `rally-serve` starts each point with a serve.
- `rally-setter-call` shows the setter's call on the pass (for example `SHOOT!` in system, `HIGH!` out of system) in a bubble.
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
- **The setter calls the pass.** Step until the call. Run `court step 10 --until 'window.__verify.events.some(e => e.type === "setterCall")'`. The state line shows `"call":{"who":"SETTER","word":"SHOOT!","sub":"in system"}`. Run `court shot rally-setter-call`: the bubble over the setter.
- **Point.** Step until the ball is down. Run `court step 30 --until 'window.__verify.events.some(e => e.type === "outcome")'`. The state line shows a banner `POINT YOU · <reason>` or `POINT THEM · <reason>` and a score of `YOU 1 : 0 THEM · your serve ...` or `YOU 0 : 1 THEM · their serve ...` to match. Run `court events`: the last entry is an `outcome` whose `winner` is `home` for a point to YOU and `away` for a point to THEM. Run `court shot rally-point`.
- **Re-serve.** Step into the next rally, then press `n`. Run `court step 30 --until 'g.ball.active && g.ballLive'`, `court key n`, `court step 0.05` and `court state`. `game.ball` is `null` and `game.score.home` and `game.score.away` are unchanged. Run `court step 30 --until 'g.ball.active && g.ballLive'`: it succeeds, so a new serve came.
- **Proof.** Run `court errors`. It reports `"count": 0`.

## Gotchas

- The autopilot is weaker here than in the drills. When this was written, as OH it swung late on every set (`MISS`, `Swung late`), as OPP it made no contact in 40 seconds, as MB it hit Perfect quicks when set, as L it passed and as S it set. A rally result is not a fixed number: assert the shape (a serve, an outcome, a score that matches the outcome), not who won.
- The setter does not set the player every time. In the recipe's rally the set goes to the outside hitter, so `events` may show no contact by `me`.
- The call bubble is on screen for about 1.5 seconds of game time. Take the `shot` straight after the `step --until` that waits for it.
- The recipe starts on `their serve`. `your serve` needs the home team to win a point first. Who serves for the home team, and whether the player serves, was not driven when this was written. Add it to this file when you verify it.
- S and L have no set calls: the score line has no `call` part and `1` to `3` do nothing.
- A fast call (`Go`, `Shoot`, `Fast back`) only happens off a good pass. Out of system the bubble says `HIGH!` and the set is a high ball whatever was called.
- A hand-played rally on the manual clock is possible (`keydown`, `step`, `mouse`), but the ball does not wait. Plan each step against `court state` (`game.ball`, `game.me`).
