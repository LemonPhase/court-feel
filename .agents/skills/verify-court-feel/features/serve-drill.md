# Serve Drill

In the Serve Drill you serve from behind the end line at six players in serve receive. You pick the serve before the toss (standing float, jump float, jump serve), toss it, and hit it with the spike's controls: a run-up and a jump for the two jump serves, then hold and release the attack button. Each serve is rated 0 to 4 by the pass it forces, and the receiving team plays its pass out. Faults are rated 0: in the net, out, a foot fault, a toss that was not hit.

## Sub-features

- `serve-pick` picks the serve with the keys `1`, `2`, `3` and walks you to where that serve starts.
- `serve-float` tosses with `q` and hits a standing float with the left mouse button.
- `serve-jump` runs in under the toss of a jump float or a jump serve, jumps and hits.
- `serve-float-moves` a float moves in the air as cleanly as it was hit, and the landing marker follows it late.
- `serve-rating` rates the serve by the pass it forces and keeps the average for the serve picked.
- `serve-toss-fault` calls a toss that comes down unhit, and a swing at a toss still on its way up misses.
- `serve-foot-fault` calls a serve hit from on or over the end line.
- `serve-reset` abandons the rep with `n`.

## How to get to it (user POV)

- On the start screen open Train, choose the Serve Drill row and a position, and start with `PLAY`, Enter or a double-click on the row.
- Open a quick-start link: `?mode=serve&pos=OH`, with `OH`, `OPP`, `MB`, `S` or `L`.
- In the pause menu of a running Serve Drill choose `Restart drill`.

## Driving it with court.mjs

Preconditions:

- A desktop session is running and `court doctor` ends with `HEALTHY`.
- The recipe uses the manual clock. The autopilot bullet uses `bot=perfect`. Both are test hooks: name them in the proof.

- **Enter from Train.** Run `court open --fresh`, `court click 'role=button[name="Skip to the drills"]'`, `court click '.view.on .row:has(.row-t:text-is("Serve Drill"))'` (the state line shows `"drill":"Serve Drill"`), `court clock manual` and `court click '.view.on .panel-foot .play-btn'`. The state line shows `"title":"Serve Drill"`, a score of `Serve 1: Standing float · rep 0` and the message `Pick your serve: 1 2 3 · toss: Q · serve at the seams`.
- **Standing float by hand.** Toss, wait for the ball to top out, hold the left button, release as it comes down. Run `court step 0.3`, `court key q`, `court step 0.55`, `court mouse down left`, `court step 0.36`, `court mouse up left` and `court step 0.2`. The state line shows `"grade":{"text":"PERFECT","sub":"62 km/h · full power"}`. Run `court step 6 --until 'g.mode.reps === 1'`: the score reads `Serve 1: Standing float · avg 1.00 of 4 · rep 1 · last 1 (62 km/h)` and the banner is `PASSED TO TARGET · 1`. Run `court events`: a `contact` by `me` with `"kind": "serve"`, then a `pass` by an away player.
- **A swing at a rising toss.** Run `court step 20 --until '!g.fx.replaying && g.mode.canServe(g.me)'`, `court key q`, `court step 0.05`, `court mouse down left`, `court step 0.03`, `court mouse up left` and `court step 0.2`. The state line shows `"grade":{"text":"MISS","sub":"Swung early"}`. Run `court step 6 --until 'g.mode.reps === 2'`: the banner is `TOSS NOT HIT · one toss only · 0`.
- **A toss let go.** Run `court step 20 --until '!g.fx.replaying && g.mode.canServe(g.me)'`, `court key q` and `court step 6 --until 'g.mode.reps === 3'`. The banner is `TOSS NOT HIT · one toss only · 0` and the average has dropped.
- **Foot fault.** Walk onto the end line, toss and hit. Run `court step 20 --until '!g.fx.replaying && g.mode.canServe(g.me)'`, `court keydown w`, `court step 3 --until 'g.me.pos.z < 9.1'`, `court keyup w`, `court step 0.4`, `court key q`, `court step 0.55`, `court mouse down left`, `court step 0.36`, `court mouse up left` and `court step 0.25`. The state line shows the grade of the hit and the banner `FOOT FAULT · 0`.
- **Pick the jump serve.** Run `court step 20 --until '!g.fx.replaying && g.mode.canServe(g.me)'`, `court key 3` and `court step 0.05`. The state line shows a score starting `Serve 3: Jump serve` and the message `Serve 3: Jump serve`. Run `court step 20 --until 'g.mode.canServe(g.me)'` and `court eval 'g.me.pos.z.toFixed(1)'`: `12.3`, the jump serve's start, 3.4 m behind the end line (the walk back stops within 0.1 m of it).
- **Jump serve by hand.** Toss, run in, plant and wind up, take off, release. Run `court key q`, `court step 0.24`, `court keydown Shift`, `court keydown w`, `court step 0.47`, `court keydown Space`, `court mouse down left`, `court step 0.28`, `court keyup Space`, `court keyup w`, `court keyup Shift`, `court step 0.33`, `court mouse up left` and `court step 0.1`. The state line shows `"grade":{"text":"PERFECT","sub":"95 km/h · full power"}`. Run `court shot serve-jump`: the server is in the air behind the end line with the ball over the hitting hand. Run `court step 8 --until 'g.mode.reps === 5'`: a banner with the rating (`OUT OF SYSTEM · 3` when this was written). Run `court eval '(g.me.takeoffPos.z - 9).toFixed(2)'`: about `0.96`, the take-off was behind the line.
- **Jump float by hand.** Run `court step 20 --until '!g.fx.replaying && g.mode.canServe(g.me)'`, `court key 2`, `court step 0.05`, `court step 20 --until 'g.mode.canServe(g.me)'`, then `court key q`, `court step 0.16`, `court keydown Shift`, `court keydown w`, `court step 0.24`, `court keydown Space`, `court mouse down left`, `court step 0.28`, `court keyup Space`, `court keyup w`, `court keyup Shift`, `court step 0.33`, `court mouse up left` and `court step 0.2`. The state line shows `"grade":{"text":"PERFECT","sub":"73 km/h · full power"}`.
- **The float moves.** Serve the jump float of the bullet above again, but stop 0.12 s after the release: replace its last `court step 0.2` with `court step 0.12`. Run `court eval '(()=>{const s=g.ball.state; window.L={x:s.p.x,z:s.p.z,vx:s.v.x,vz:s.v.z}; return s.knuckle})()'`: `1` (a Perfect contact; `0.55` for Good). Then three times `court step 0.26` and `court eval '(()=>{const s=g.ball.state,L=window.L; const p=g.ball.ensurePrediction(g.env,g.simTime); return (s.p.x-L.x-L.vx*(s.p.z-L.z)/L.vz).toFixed(2)+" off the line, marker "+p.land.x.toFixed(2)+","+p.land.z.toFixed(2)})()'`. The first number grows away from 0 (0.02, 0.15, 0.36 when this was written) and the marker moves after it (from `2.17,-8.65` to `2.72,-8.50`): the ball left the line it was hit on, and the marker shows where it was heading a fifth of a second before.
- **Reset the rep.** Toss and press `n` before the ball comes down. Run `court step 20 --until '!g.fx.replaying && g.mode.canServe(g.me)'`, `court eval 'g.mode.reps'`, `court key q`, `court step 0.3`, `court key n`, `court step 0.05` and `court state`. `game.ball` is `null` and `game.score.reps` is the number `eval` printed: the rep was abandoned, not rated.
- **Many serves, autopilot.** Run `court open '?mode=serve&pos=OH&bot=perfect' --fresh --manual`, `court key 3`, `court step 0.1` and `court step 60 --until 'g.mode.reps >= 5'`. The score shows `Serve 3: Jump serve · avg <n> of 4 · rep 5`. Run `court events`: five `serve` contacts by `me` at 95 km/h, each followed by an away `dig` or `pass`, or by an `outcome` on the away side (an ace).
- **Proof.** Run `court errors`. It reports `"count": 0`.

## Gotchas

- The hold times in the by-hand bullets are for an Outside Hitter from where the drill stands them. Another position, or a start after walking, needs other times: step and read `g.contact.ideal(g.me, g.simTime, 0.9)` to find the contact.
- A Perfect serve that hits the floor (an ace, or a foot-faulted serve that lands) starts the automatic replay. Keys pressed during it only skip it. Wait on `!g.fx.replaying` before pressing drill keys, as the recipe does.
- `1`, `2`, `3` only move you to the new start while nothing is tossed. Wait on `g.mode.canServe(g.me)` before `q`: the toss is refused while you are walking back.
- A full-power jump serve aimed shorter than about 7 m into their court goes into the net. The drill starts a third-person camera aimed deep. After `look`, or in first person without looking up at the toss, `IN THE NET · 0` on a Perfect contact is the aim, not a bug.
- Which way a float breaks is drawn for each serve. Only a run that starts with `--fresh --manual` and repeats the same commands gives the same drift, marker and rating. A jump serve (`3`) does not float: `g.ball.state.knuckle` is `0`.
- The rating of a clean serve depends on the pass the AI makes of it, which is a roll of the seeded dice. Assert the shape (`<label> · <0-4>`), not the number, unless the run starts with `--fresh --manual` and repeats the same commands.
- The autopilot steers the feet directly. The by-hand bullets are the proof for Shift and W.
- On a touch session the serve is picked with the `SERVE` chips at the top left (`.touch [data-btn="d1"]`, `d2`, `d3`) and tossed with `.t-toss`.
