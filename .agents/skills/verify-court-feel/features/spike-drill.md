# Spike Drill

In the Spike Drill a coach tosses to your setter, the setter sets your lane, and you approach, jump and swing. Each contact is graded (Perfect, Good, Early, Late, Miss) and each rep is scored on timing, power, the kill and hitting the highlighted target zone. You can call the set, put an opposing block up, watch replays, switch camera and reset the rep.

## Sub-features

- `spike-rep` plays one rep: toss, set, your graded contact, the outcome, the score.
- `spike-set-call` changes the next set with the keys `1`, `2`, `3` (outside hitter: high ball, go, 3 ball).
- `spike-block` cycles the opposing block off, single, double with `b`.
- `spike-replay-auto` replays a Perfect spike that hits the floor, in slow motion, and any key skips it.
- `spike-replay-key` replays the last attempt with `r` once the ball is dead: a contact of any grade, a miss, or a set left to drop.
- `spike-camera` switches first and third person with `v`.
- `spike-reset` abandons the current rep with `n`.
- `spike-hand-input` moves, jumps and swings the athlete from the keyboard and mouse.

## How to get to it (user POV)

- On the start screen choose a position, choose the Spike Drill card (or press `2`) and start with `PLAY`, Enter or a double-click on the card.
- Open a quick-start link: `?mode=spike&pos=OH`, with `OH`, `OPP`, `MB`, `S` or `L`.
- In the pause menu of a running Spike Drill choose `Restart drill`.

## Driving it with court.mjs

Preconditions:

- A desktop session is running and `court doctor` ends with `HEALTHY`.
- The recipe uses the manual clock and, for the rep, the autopilot (`bot=perfect`). Both are test hooks: name them in the proof.

- **Enter by link.** Open the drill as an outside hitter with the clock frozen. Run `court open '?mode=spike&pos=OH&bot=perfect' --fresh --manual`. The state line shows `"title":"Spike Drill · Outside high ball (4)"`, a score of `0 pts · rep 0 · set 1: High ball · target: <zone>`, `"clock":"manual"` and `"simTime":0`.
- **Call the set.** Press `2`. Run `court key 2` and `court step 0.05`. The state line shows `"title":"Spike Drill · Outside go"`, a score containing `set 2: Go (fast to the pin)` and `"message":"Next set: 2 · Go (fast to the pin)"`.
- **Play the rep.** Let the autopilot approach, jump and swing. Run `court step 20 --until 'window.__verify.events.some(e => e.type === "contact" && e.who === "me")'`. The state line shows `"grade":{"text":"PERFECT","sub":"<speed> km/h · full power"}`. Run `court shot spike-contact`: the hitter is at the net with the grade on screen.
- **Score the rep.** Run `court step 5 --until 'g.mode.reps === 1'`. The state line shows a score starting `<points> pts · rep 1` and a banner starting `KILL`. Run `court events`: a `contact` by `me` with `"kind": "spike"` and `"grade": "Perfect"`, then an `outcome` with `"kind": "in"`, `"side": "away"`, `"winner": "home"`.
- **Automatic replay.** Keep stepping until the replay starts. Run `court step 5 --until 'g.fx.replaying'`. The state line shows `"screen":"replay"`. Run `court step 1.2` and `court shot spike-replay`: a letterboxed frame with `REPLAY` at the top left.
- **Skip the replay.** Press any key. Run `court key x` and `court step 0.05`. The state line shows `"screen":"play"`.
- **Replay key.** Wait for the ball to go dead, then press `r`. Run `court step 6 --until 'g.replayAvailable()'`, then `court state`: `hud.hint` ends with `R replay last attempt`. Run `court key r` and `court step 0.05`. The state line shows `"screen":"replay"`. Run `court step 20 --until '!g.fx.replaying'`. The state line shows `"screen":"play"` with the same `simTime` as before the replay: the drill did not move on while it played.
- **Replay a miss.** Open the drill without the autopilot and let the set drop. Run `court open '?mode=spike&pos=OH' --fresh --manual` and `court step 12 --until 'g.replayAvailable()'`. Run `court eval 'g.fx.lastAttempt.kind'`: `untouched`. Run `court key r`, `court step 0.05` (the state line shows `"screen":"replay"`), `court step 2.5` and `court shot spike-replay-miss`: a letterboxed frame with your hitter standing at the start spot and the ball coming down near the net. Run `court step 20 --until '!g.fx.replaying'`: the state line shows `"screen":"play"`, the same `simTime` and the score still `0 pts · rep 1`. For a whiff, play the hand-input bullet first: its `MISS` makes `g.fx.lastAttempt.kind` `whiff`.
- **Block.** Press `b` three times, with a step after each. Run `court key b` and `court step 0.05`: the title ends `· block: single` and the message is `Block: single · hit around it`. Run both again: the title ends `· block: double` and the message is `Block: double · line or cross, or over the top`. Run both again: the title has no `block:` part and the message is `Block off`.
- **Camera.** Press `v`. Run `court key v`, `court step 0.05` and `court state`. `hud.camera` is `FIRST PERSON`, `game.camera` is `fp` and `saved.settings.firstPerson` is `true`. Press `v` again the same way to return to `THIRD PERSON`.
- **Reset the rep.** Step until a ball is in the air, then press `n`. Run `court step 10 --until 'g.ball.active'`, `court key n`, `court step 0.05` and `court state`. `game.ball` is `null` and `game.score.reps` is unchanged: the rep was abandoned, not scored.
- **Hand input.** Open the drill without the autopilot and play the keys yourself. Run `court open '?mode=spike&pos=OH' --fresh --manual`, `court keydown Shift`, `court keydown w`, `court step 0.5`, then `court state`: `game.me.z` is lower than its starting `3.7` (the athlete ran towards the net) and `game.held` lists `ShiftLeft` and `KeyW`. Run `court keydown Space`, `court step 0.2`, `court keyup Space`, `court mouse down left`, `court step 0.2`, then `court state`: `game.me.state` is `air` and `game.me.action` is `windup`. Run `court mouse up left`, `court step 0.05`, then `court state`: `game.me.action` is `swing`. Release the keys: `court keyup w` and `court keyup Shift`.
- **Proof.** Run `court errors`. It reports `"count": 0`.

## Gotchas

- The autopilot presses jump and swing through the game's input layer but steers the feet directly. A bot rep does not prove WASD or Shift. The hand-input bullet does.
- The hand-input bullet proves the keys reach the athlete, not a graded hit. Its swing meets no ball, so a `MISS` grade there is expected.
- The target zone is picked at random for each rep. Only a run that starts with `--fresh --manual` repeats the same zones and points.
- Set calls exist for OH, OPP and MB. As S or L the keys `1` to `3` do nothing and the score line has no `set` part.
- The automatic replay needs the `Perfect-spike replays` setting on (the default) and a Perfect spike that lands. `--fresh` restores the default.
- During a replay any key press skips it, including the key you meant for the drill. Step until `!g.fx.replaying` before pressing drill keys.
- `r` only works once the ball is dead and while the attempt is still in the replay buffer (the last 8 seconds of live play). Wait on `g.replayAvailable()`, as the recipe does.
- With the block up the autopilot can be stuffed (`BLOCKED`) or score off the hands (`TOOLED`). Do not assert a kill against a block.
- `v` saves the camera. A later recipe that expects third person must open with `--fresh`.
