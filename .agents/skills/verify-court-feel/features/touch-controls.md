# Touch controls

On a phone or tablet the game shows on-screen controls: a joystick under the left thumb, drag-to-aim on the right, hold buttons for JUMP, HIT, BLOCK and PASS, and a top row for pause, camera, reset, set calls and the opposing block. Touches go through the same input path as keys, so timing is identical. A setting (Auto, On, Off) and the `touch=1` link parameter control whether they show.

## Sub-features

- `touch-auto` turns the controls on by itself on a touch screen, with button names in the hints.
- `touch-menus` works the start screen, pause menu and settings by tapping.
- `touch-stick` moves the athlete with the left-thumb stick, and runs the approach when pushed out to the ring.
- `touch-jump` loads a jump while JUMP is held and takes off on release.
- `touch-hit` winds up while a finger is down on the right half in the air, aims by dragging, and swings on release.
- `touch-top-row` calls a set, switches the camera, toggles the opposing block and pauses.
- `touch-setting` cycles Settings > Touch controls through Auto, On and Off.

## How to get to it (user POV)

- Open the app on a touch screen. The controls appear when a drill starts.
- On a hybrid device, touch the screen once: in Auto the first touch turns them on.
- Settings > `Touch controls`: `Auto (touch screens)`, `On`, `Off`.
- Add `touch=1` to a link to force them on a desktop. [Quick-start links](./quick-start-links.md) drives that entry.

## Driving it with court.mjs

Preconditions:

- A touch session is running: `court launch --touch` (844x390, touch screen). If a desktop session is also running, launch this one as `COURT_SESSION=phone` and prefix every `court` command in this recipe the same way.
- `court doctor` ends with `HEALTHY` and its page line says `touch session`.
- The recipe uses the manual clock (a test hook). Name it in the proof.

- **Start by tapping.** Open the app as a new player and start the Spike Drill with taps. Run `court open --fresh`, `court tap 'role=button[name="Skip to the drills"]'`, `court tap '.mode-card:has(.mode-t:text-is("Spike Drill"))'` and `court tap 'role=button[name="PLAY"]'`. The state line shows `"screen":"play"` and `"message":"Approach: the stick out · plant: JUMP · hold HIT, release to hit · 1-3 set call"`. Run `court state`: `game.touchControls` is `true`, `game.pointerLocked` is `false` and `hud.hint` names buttons (`JUMP`, `CAM`, `RESET`), not keys.
- **Freeze the clock.** Run `court clock manual` and `court shot touch-layout`: the stick ring at the bottom left, PASS, BLOCK, JUMP and HIT at the bottom right, set-call chips `1 2 3` and `VS BLOCK` at the top left, pause, `CAM` and `RESET` at the top right.
- **Call a set.** Tap chip `2`. Run `court touch start 4 '.touch [data-btn="d2"]'`, `court touch end 4` and `court step 0.05`. The state line shows `"title":"Spike Drill · Outside go"`.
- **Stick.** Put the left thumb down and push it up to the ring. Run `court touch start 1 160 300`, `court touch move 1 160 210`, `court step 0.3` and `court state`. `game.stick` is `{"x":0,"y":1,"sprint":true}` and `game.me.z` is lower than before: the athlete is running at the net.
- **Jump.** Hold JUMP, then let go. Run `court touch start 2 .t-jump`, `court step 0.1` and `court state`: `game.me.state` is `load` and `game.held` is `["Space"]`. Run `court touch end 2`, `court step 0.05` and `court state`: `game.me.state` is `air`.
- **Hit.** In the air the whole right half is HIT. Put a finger down there, drag to aim, then lift. Run `court touch start 3 560 140`, `court touch move 3 640 150`, `court step 0.05` and `court state`: `game.me.action` is `windup`, `game.held` is `["Mouse0"]` and `game.yaw` is no longer `0`. Run `court shot touch-windup`. Run `court touch end 3`, `court step 0.05` and `court state`: `game.me.action` is `swing`. Lift the stick thumb: `court touch end 1`.
- **Camera.** Tap `CAM`. Run `court touch start 4 '.touch [data-btn="cam"]'`, `court touch end 4`, `court step 0.05` and `court state`. `hud.camera` is `FIRST PERSON`.
- **Opposing block.** Tap `VS BLOCK`. Run `court touch start 4 '.touch [data-btn="vsblock"]'`, `court touch end 4` and `court step 0.05`. The state line shows a title ending `· block: single`.
- **Pause.** Tap the pause button. Run `court touch start 5 .t-pause` and `court touch end 5`. The state line after the first command shows `"screen":"paused"`.
- **Setting.** Open the settings and tap the `Touch controls` switch three times, reading `court state` after each. Run `court tap 'role=button[name="Settings"]'`, then `court tap '.set-row:has-text("Touch controls") .chip'` and `court state`, three times. The row reads `On` with `game.touchControls` `true`, then `Off` with `game.touchControls` `false` and `saved.settings.touchControls` `"off"`, then `Auto (touch screens)` with `game.touchControls` `true` again.
- **Resume.** Run `court tap 'role=button[name="DONE"]'` and `court tap 'role=button[name="RESUME"]'`. The state line shows `"screen":"play"`.
- **Proof.** Run `court errors`. It reports `"count": 0`.

## Gotchas

- `REPLAY` (`.touch [data-btn="replay"]`) is shown only while the last attempt can be replayed (`g.replayAvailable()`), misses included. The hint then ends `REPLAY last attempt`. Press it with `court touch start 4 '.touch [data-btn="replay"]'` and `court touch end 4`; any later touch skips the replay.
- `court tap` works on menu controls only. The pad's buttons take no pointer events of their own (the pad reads every touch by position), so `court tap .t-jump` times out. Use `court touch start <id> <selector>` and `court touch end <id>`.
- The set-call chips and the other top-row buttons for a drill are built on the first frame after it starts. On the manual clock, run the recipe's `court shot` (or a `court step`) before touching them, or `court touch start` finds no chip.
- Touch ids are fingers. A finger stays down across commands until its `end`. `court open` lifts them all. Reuse an id only after its `end`.
- Coordinates in the recipe are for the 844x390 session. Selectors do not depend on the size.
- The stick reads the thumb's movement on the next `court step`, like a key.
- The hit swing in the recipe meets no ball. It proves the controls, not a graded contact. A graded touch rep needs the timing of a real approach.
- On the ground a finger on the right half aims without hitting. Only while loading or in the air is the whole right half HIT. On the ground, hit with `court touch start <id> .t-hit`.
- The helper cannot rotate the phone, so the "Turn your phone sideways" message in portrait is not drivable. Haptics and fullscreen cannot be observed here.
- With `Touch controls` set to `Off` the pad is gone but the menus still take taps. The recipe leaves the setting on Auto.
