# Pause and settings

Esc pauses a drill and opens the pause menu: resume, settings, restart the drill, quit to the start screen. The settings panel (also on the start screen) changes controls, camera, net height, assists, effects and "Your athlete" (hitting hand, and height, vertical jump and spike power per position). Every change applies at once and is saved in the browser.

## Sub-features

- `pause-open` pauses the drill with Esc and shows the pause menu with the build label.
- `pause-resume` resumes with the `RESUME` button, and with Esc in a drill that has not taken the mouse.
- `pause-restart` restarts the drill from rep 0.
- `pause-quit` returns to the start screen.
- `settings-open` opens the settings from the pause menu and from the start screen.
- `settings-change` changes a slider and a switch, applied immediately.
- `settings-athlete` sets the hitting hand and a custom body for one position.
- `settings-close` closes the settings with `DONE` or Esc, back to where they were opened.
- `settings-persist` keeps every setting after a reload.

## How to get to it (user POV)

- Press Esc while playing a drill.
- Click `Settings` on the start screen or in the pause menu.
- On a phone, tap the pause button at the top right (see [Touch controls](./touch-controls.md)).
- Leaving the tab while playing also pauses. The helper cannot hide the tab, so that path is not drivable here.

## Driving it with court.mjs

Preconditions:

- A desktop session is running and `court doctor` ends with `HEALTHY`.
- The recipe uses the manual clock and the autopilot for one rep (test hooks), `esc` for the Esc key in play and `set` for sliders (stand-ins). Name them in the proof.

- **Play a rep first.** Start the Spike Drill from the start screen and score one rep, so that a restart has something to reset. Run `court open --fresh`, `court click 'role=button[name="Skip to the drills"]'`, `court click 'role=button[name="PLAY"]'`, `court clock manual`, `court bot perfect` and `court step 20 --until 'g.mode.reps === 1'`. The state line shows a score starting `<points> pts · rep 1`.
- **Pause.** Press Esc. Run `court esc`. The state line shows `"screen":"paused"`. Run `court state`: `game.paused` is `true` and `game.pointerLocked` is `false`. Note `game.simTime`, then run `court step 0.5`: the state line reports the same `simTime`, so the game is not advancing. `pauseMenu.buttons` in `court state` is `["RESUME","Settings","Restart drill","Quit to menu"]`. Run `court shot paused`: the `Paused` box with those buttons and the build label.
- **Resume with the button.** Click `RESUME`. Run `court click 'role=button[name="RESUME"]'`. The state line shows `"screen":"play"`. Run `court state`: `game.paused` is `false` and `game.pointerLocked` is `true`.
- **Open the settings from the pause menu.** Pause again and click `Settings`. Run `court esc` and `court click 'role=button[name="Settings"]'`. The state line shows `"screen":"settings"`. Run `court state`: `settingsPanel.rows` lists every row with its current value, starting `"Mouse sensitivity": "1.00"` and including `"Field of view": "72°"` and `"Net height": "Men's 2.43 m"`.
- **Change a slider.** Set the field of view to 95. Run `court set '.set-row:has-text("Field of view") input' 95` and `court state`. `settingsPanel.rows` has `"Field of view": "95°"` and `saved.settings.fov` is `95`.
- **Change a switch.** Click the net height switch. Run `court click '.set-row:has-text("Net height") .chip'` and `court state`. The row reads `Women's 2.24 m`, `game.netTop` is `2.24` and `saved.settings.womenNet` is `true`.
- **Your athlete.** Make the player left-handed and the middle blocker 2.10 m tall. Run `court click '.set-row:has-text("Hitting hand") .chip'`, `court click '.body-tab:text-is("MB")'`, `court set '.body-set input[data-body="height"]' 2.1` and `court state`. The rows have `"Hitting hand": "Left"` and `"Height": "2.10 m · 6′11″"`, `settingsPanel.athleteTab` is `MB`, `settingsPanel.athlete` starts `Spike reach 3.48 m`, `game.hand` is `left`, and `saved.settings.bodies` is `{"MB":{"height":2.1,"jump":0.82,"power":0.95}}`. Run `court shot settings`.
- **Close with Esc.** Press Esc in the settings. Run `court key Escape`. The state line shows `"screen":"paused"`, not `play`: Esc closes the settings only.
- **Close with DONE.** Reopen and click `DONE`. Run `court click 'role=button[name="Settings"]'` and `court click 'role=button[name="DONE"]'`. The state line shows `"screen":"paused"`.
- **Restart the drill.** Click `Restart drill`. Run `court click 'role=button[name="Restart drill"]'`. The state line shows `"screen":"play"` and a score starting `0 pts · rep 0`.
- **Quit to the menu.** Pause and click `Quit to menu`. Run `court esc` and `court click 'role=button[name="Quit to menu"]'`. The state line shows `"screen":"start"`.
- **Settings survive a reload.** Reload and read them back. Run `court open` and `court state`: `saved.settings` still has `fov` 95, `womenNet` true, `hand` `left` and the MB body, and `game.netTop` is `2.24`. Run `court eval '[...document.querySelectorAll(".pos-h")].map(e => e.textContent)'`: the third entry (MB) is `2.10 m · custom · lefty` and the others end `· lefty`.
- **Open the settings from the start screen.** Run `court click 'role=button[name="Settings"]'` and `court state`. `"screen"` is `settings` and the rows show `95°`, `Women's 2.24 m` and `Left`. Close with `court click 'role=button[name="DONE"]'`: the state line shows `"screen":"start"`.
- **Pause and resume with Esc alone.** Open a drill by link, so the game has not taken the mouse, and press Esc twice. Run `court open '?mode=spike&pos=OH' --fresh`, then `court esc`: it prints `"esc":"Escape key"` and the state line shows `"screen":"paused"`. Run `court key Escape`: the state line shows `"screen":"play"`. Run `court state`: `game.paused` is `false` and `game.pointerLocked` is `true`.
- **Proof.** Run `court errors`. It reports `"count": 0`. The last bullet opened with `--fresh`, so the changed settings do not leak into the next recipe.

## Gotchas

- `court key Escape` does nothing while the game holds the mouse. Chrome itself takes that key press and releases the mouse, which is what pauses. Use `court esc` in play. In the pause menu and the settings the real key works, and the recipe uses it there.
- Esc in the pause menu resumes only while the game has not held the mouse in this page load. After `PLAY` or a click on the court, `court esc` followed by `court key Escape` leaves the pause menu up: headless Chromium does not hand the mouse back to a key press, and the game stays paused when it cannot get the mouse. Whether desktop Chrome does the same was not checked when this was written. After the game has held the mouse, resume with `RESUME`.
- Chromium refuses to hand the mouse back for about 1.25 seconds after it was released. `court esc` waits 1.5 seconds for that reason. The game also retries by itself after that delay; in headless Chromium the retry does not get the mouse, so a `RESUME` or `Restart drill` click that lands inside the window leaves the pause menu up. Do not release the mouse any other way (for example `court eval 'document.exitPointerLock()'`) and click straight after.
- A click on a slider moves it to the clicked point. Use `court set`, or click and then `court key ArrowRight` / `ArrowLeft`.
- There is no save button. A change is applied and saved when it is made. `DONE` only closes the panel.
- The height, jump and power sliders edit the position whose tab is selected. The tab starts on the position selected on the start screen or being played.
- The custom body applies to your player only. AI athletes keep the defaults.
- While paused, `court step` succeeds but the game does not advance. That is the pause working, not the clock failing.
- This recipe changes saved settings. If you stop part-way, run `court open --fresh` before another recipe.
