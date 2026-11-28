# Block Drill

In the Block Drill the opponent setter sets one of three hitters and you block: read the set, shuffle along the net, put your hands up and time the jump. Your hands press over the net with the jump, and the ball comes off them the way it met them: into the palms it is stuffed back down, off the fingertips it goes up and on into your court, off the outer edge of your outside hand it glances away and out. The grade line after a touch names the timing, the speed, what the touch was (Stuff!, Soft block, Tooled, Off the block) and where it met your block (palm, both hands, fingers, fingertips, hand's edge, forearms). Each rep is scored from where the ball lands.

## Sub-features

- `block-rep` plays one rep: their set, their attack, your block (or none), the outcome and the score.
- `block-touch` grades a block touch (Perfect, Good, Early, Late) and says what it was and where it met the hands, in the grade line.
- `block-score` scores a rep: a stuff that lands on their side (`STUFF BLOCK!` +150 off a Perfect jump, `BLOCK POINT` +100), a touch that stays in play (`SOFT BLOCK · TOUCH` +60), a ball off your hands and out (`TOOLED` +20), their error with no touch (`HITTER ERROR` +10), a kill (`KILLED`), no touch at all (`NO TOUCH`).
- `block-replay` replays the last rep with `r` once the ball is dead.

## How to get to it (user POV)

- On the start screen open Train, choose the Block Drill row and a position, and start with `PLAY`, Enter or a double-click on the row. [Start screen](./start-screen.md) drives this entry.
- Open a quick-start link: `?mode=block&pos=MB`, with `OH`, `OPP`, `MB` or `S`.
- In the pause menu of a running Block Drill choose `Restart drill`.

## Driving it with court.mjs

Preconditions:

- A desktop session is running and `court doctor` ends with `HEALTHY`.
- The recipe uses the manual clock and the autopilot (`bot=perfect`). Both are test hooks: name them in the proof. The autopilot jumps with their middle on every ball, so it only reaches the quicks (a pin set cannot be blocked from the drill's start spot: issue #54).

- **Enter by link.** Run `court open '?mode=block&pos=MB&bot=perfect' --fresh --manual`. The state line shows `"title":"Block Drill"`, `"score":"0 pts · rep 0"` and `"clock":"manual"`.
- **A block touch.** Run `court step 30 --until 'window.__verify.events.some(e => e.type === "contact" && e.who === "me")'`. The state line shows a grade such as `{"text":"PERFECT","sub":"60 km/h · Soft block · fingertips"}`: the timing, the ball's speed off your hands, what the touch was and where it met your block. Run `court shot block-touch`.
- **Score the rep.** Run `court step 6 --until 'g.mode.reps === 1'`. The state line shows the score and a banner that agrees with where the ball landed, such as `"banner":"SOFT BLOCK · TOUCH +60"`. Run `court events`: a `contact` by `MB (away)` with `"kind": "spike"`, a `contact` by `me` with `"kind": "block"` and its `note`, then an `outcome`.
- **Many reps.** Run `court step 200 --until 'g.mode.reps >= 25'`, then `court eval 'JSON.stringify(window.__verify.events.filter(e=>e.type==="contact" && e.kind==="block").map(e=>[e.grade,e.note,e.kmh]))'`. The touches differ: stuffs at different speeds and soft blocks, not one canned response.
- **Replay.** After a touched rep, run `court step 8 --until 'g.replayAvailable()'`, `court key r` and `court step 0.05`: the state line shows `"screen":"replay"`. Step through it with `court step 0.35` and `court shot block-replay-N` to see the hands pressed over the net at the touch.
- **Proof.** Run `court errors`. It reports `"count": 0`.

## Gotchas

- The grade line is up for a few seconds of game time. Read it from the state line of the `step` that reached the touch, or from `events`.
- The autopilot's middle lines up on their middle, not on the ball: a quick cut across the block passes its hands. A miss there is the ball going round the block, not a bug.
- The block's numbers (where on the hands, how firm, how far it presses) are in `BLOCK` in `src/config.ts`. A change there moves the speeds and the mix of outcomes; the shape of the result (a graded touch, a named part, a score that agrees with the landing) is the contract.
