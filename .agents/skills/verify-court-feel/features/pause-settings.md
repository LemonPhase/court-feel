# Pause and settings

Esc pauses a drill and opens the pause menu: resume, restart the drill, settings, quit to the start screen, with the keys for the drill and three quick settings beside them. Settings and Athlete are full-screen sheets that open over the pause menu or the start screen. Settings has five tabs (Controls, Camera, Assists and hints, Sound, Court). Athlete has the five position cards, the hitting hand, and height, vertical jump and spike power per position. Every change applies at once and is saved in the browser.

## Sub-features

- `pause-open` pauses the drill with Esc and shows the pause menu: the drill and position, its buttons, the keys for the drill, quick settings and the build label.
- `pause-resume` resumes with the `RESUME` button, and with Esc in a drill that has not taken the mouse.
- `pause-quick` changes the view, the sensitivity or the volume from the pause menu.
- `pause-restart` restarts the drill from rep 0.
- `pause-quit` returns to the start screen.
- `settings-open` opens the Settings sheet from the pause menu and from the start screen.
- `settings-change` changes a slider, an on/off switch and a chip choice in their tabs, applied immediately.
- `settings-reset` puts every tab back to the defaults in two presses and leaves the athlete alone.
- `athlete-body` sets the hitting hand and a custom body for one position.
- `athlete-position` changes and saves the position from a card when the sheet is opened from the start screen. From the pause menu a card only picks whose body the sliders edit.
- `settings-close` closes a sheet with `DONE` or Esc, back to where it was opened.
- `settings-persist` keeps every setting after a reload.

## How to get to it (user POV)

- Press Esc while playing a drill.
- Click `Settings` in the top bar of the start screen or in the pause menu. On the start screen the `Change` link in Train's panel and `Sensitivity and touch settings` in Learn open it too.
- Click the Athlete pill at the top right of the start screen (it shows the position, for example `OH Outside Hitter`), or `Edit athlete` beside `Play as`.
- In either sheet, the button beside `DONE` switches to the other one. That is the only way to Athlete from the pause menu.
- On a phone, tap the pause button at the top right (see [Touch controls](./touch-controls.md)).
- Leaving the tab while playing also pauses. The helper cannot hide the tab, so that path is not drivable here.

## Driving it with court.mjs

Preconditions:

- A desktop session is running and `court doctor` ends with `HEALTHY`.
- The recipe uses the manual clock and the autopilot for one rep (test hooks), `esc` for the Esc key in play and `set` for sliders (stand-ins). Name them in the proof.

- **Play a rep first.** Start the Spike Drill from the start screen and score one rep, so that a restart has something to reset. Run `court open --fresh`, `court click 'role=button[name="Skip to the drills"]'`, `court click '.view.on .panel-foot .play-btn'`, `court clock manual`, `court bot perfect` and `court step 20 --until 'g.mode.reps === 1'`. The state line shows a score starting `<points> pts · rep 1`.
- **Pause.** Press Esc. Run `court esc`. The state line shows `"screen":"paused"`. Run `court state`: `game.paused` is `true` and `game.pointerLocked` is `false`. Note `game.simTime`, then run `court step 0.5`: the state line reports the same `simTime`, so the game is not advancing. In `court state`, `pauseMenu.sub` is `Spike Drill · Outside Hitter`, `pauseMenu.buttons` is `["RESUME","Restart drill","Settings","Quit to menu"]`, `pauseMenu.keys` starts `"Shift + W: Approach"` and `pauseMenu.quick` is `{"View":"Third person","Mouse sensitivity":"1.00","Volume":"80%"}`. Run `court shot paused`: the `Paused` box with those buttons and the build label on the left, `Keys for this drill` and `Quick settings` on the right.
- **Resume with the button.** Click `RESUME`. Run `court click '.pause .play-btn'`. The state line shows `"screen":"play"`. Run `court state`: `game.paused` is `false` and `game.pointerLocked` is `true`.
- **Quick settings.** Pause again and click `First person` in the pause menu. Run `court esc`, `court click 'role=button[name="First person"]'` and `court state`. `pauseMenu.quick.View` is `First person`, `game.camera` is `fp` and `saved.settings.firstPerson` is `true`.
- **Open the settings from the pause menu.** Click `Settings`. Run `court click 'role=button[name="Settings"]'`. The state line shows `"screen":"settings"`, `"sheet":"settings"` and `"tab":"Controls"`. Run `court state`: `settingsPanel.rows` lists the rows of the tab in view with their values, `{"Mouse sensitivity":"1.00","Invert Y":"Off","Touch controls":"Auto","Touch aim sensitivity":"1.00"}`.
- **Change a slider.** Open the Camera tab and set the field of view to 95. Run `court click 'role=tab[name="Camera"]'`: the state line shows `"tab":"Camera"`. Run `court set '.set-row:has-text("Field of view") input' 95` and `court state`. `settingsPanel.rows` is `{"View":"First person","Field of view":"95°","Camera shake":"100%","Perfect-spike replays":"On"}` and `saved.settings.fov` is `95`.
- **Change a switch.** Turn the replays off. Run `court click 'role=switch[name="Perfect-spike replays"]'` and `court state`. The row reads `Off` and `saved.settings.replays` is `false`.
- **Change a choice.** Open the Court tab and choose the women's net. Run `court click 'role=tab[name="Court"]'`, `court click '.set-row:has-text("Net height") .chip:has-text("Women")'` and `court state`. `settingsPanel.rows` is `{"Net height":"Women's 2.24 m"}`, `game.netTop` is `2.24` and `saved.settings.womenNet` is `true`. Run `court shot settings`.
- **Athlete.** Switch to the Athlete sheet, make the player left-handed and the middle blocker 2.10 m tall. Run `court click '.sheet-head .ghost-btn'`: the state line shows `"screen":"settings"` and `"sheet":"athlete"`. Run `court state`: `settingsPanel.athlete.position` is `OH`, the position being played. Run `court click 'role=button[name="Left"]'`, `court click '.pos-card:has(.pos-short:text-is("MB"))'`, `court set '.body-set input[data-body="height"]' 2.1` and `court state`. `settingsPanel.rows` is `{"Hitting hand":"Left","Height":"2.10 m · 6′11″","Vertical jump":"82 cm · 32″","Spike power":"103 km/h"}`, `settingsPanel.athlete.position` is `MB`, `settingsPanel.athlete.reach` is `3.48 m`, `settingsPanel.athlete.cards.MB` is `2.10 m · custom · lefty` and the other cards end `· lefty`. `game.hand` is `left` and `saved.settings.bodies` is `{"MB":{"height":2.1,"jump":0.82,"power":0.95}}`. `game.position` is still `OH` and `saved.menu.pos` is still `OH`: from the pause menu a card does not change the position. Run `court shot athlete`.
- **Close with Esc.** Press Esc in the sheet. Run `court key Escape`. The state line shows `"screen":"paused"`, not `play`: Esc closes the sheet only.
- **Change the venue.** On the Court tab choose a venue. Run `court click '.sheet .set-row:has-text("Venue") .chip:has-text("Rooftop")'` and `court state`. `saved.settings.venue` is `rooftop`. Run `court eval 'g.env.ceiling'`: `null` for Seaside and Rooftop (no ceiling outdoors), `12.5` for Club hall, Games arena and After hours. The court behind the sheet is rebuilt at once: the drill, the score and the athletes are untouched. The chips are `Club hall`, `Games arena`, `Seaside`, `After hours`, `Rooftop`. After a reload (`court open`) the venue is still the chosen one.
- **Close with DONE.** Reopen and click `DONE`. Run `court click 'role=button[name="Settings"]'`: the state line shows `"tab":"Court"`, the tab that was left. Run `court click 'role=button[name="DONE"]'`. The state line shows `"screen":"paused"`.
- **Restart the drill.** Click `Restart drill`. Run `court click 'role=button[name="Restart drill"]'`. The state line shows `"screen":"play"` and a score starting `0 pts · rep 0`.
- **Quit to the menu.** Pause and click `Quit to menu`. Run `court esc` and `court click 'role=button[name="Quit to menu"]'`. The state line shows `"screen":"start"` and `"section":"train"`, the section the drill was started from.
- **Settings survive a reload.** Reload and read them back. Run `court open` and `court state`: `saved.settings` still has `fov` 95, `replays` false, `womenNet` true, `firstPerson` true, `hand` `left` and the MB body, and `game.netTop` is `2.24`.
- **Athlete from the start screen.** Click the Athlete pill and then the MB card. Run `court click '[aria-label^="Athlete:"]'`: the state line shows `"screen":"settings"` and `"sheet":"athlete"`. Run `court click '.pos-card:has(.pos-short:text-is("MB"))'` and `court state`: `settingsPanel.athlete.position` is `MB`, the Height row reads `2.10 m · 6′11″` and `saved.menu` is `{"mode":"spike","pos":"MB","played":true}`. Here the card changed the position and saved it.
- **Settings from the start screen.** Switch to Settings, read the Camera tab and close. Run `court click '.sheet-head .ghost-btn'`: the state line shows `"sheet":"settings"` and `"tab":"Controls"`. Run `court click 'role=tab[name="Camera"]'` and `court state`: the rows show `First person`, `95°` and `Off`. Run `court click 'role=button[name="DONE"]'`: the state line shows `"screen":"start"` and `"position":"MB"`.
- **Reset to defaults.** Open Settings and press the reset button twice. Run `court click 'role=button[name="Settings"]'`: the state line shows `"tab":"Camera"`. Run `court click 'role=button[name="Reset to defaults"]'`, `court click 'role=button[name="Reset every group?"]'` and `court state`. `settingsPanel.rows` is `{"View":"Third person","Field of view":"72°","Camera shake":"100%","Perfect-spike replays":"On"}`. `saved.settings` has `fov` 72, `replays` true, `womenNet` false and `firstPerson` false again, and still has `hand` `left` and the MB body. Close with `court key Escape`: the state line shows `"screen":"start"`.
- **Pause and resume with Esc alone.** Open a drill by link, so the game has not taken the mouse, and press Esc twice. Run `court open '?mode=spike&pos=OH' --fresh`, then `court esc`: it prints `"esc":"Escape key"` and the state line shows `"screen":"paused"`. Run `court key Escape`: the state line shows `"screen":"play"`. Run `court state`: `game.paused` is `false` and `game.pointerLocked` is `true`.
- **Proof.** Run `court errors`. It reports `"count": 0`. The last bullet opened with `--fresh`, so the changed settings do not leak into the next recipe.

## Gotchas

- `court key Escape` does nothing while the game holds the mouse. Chrome itself takes that key press and releases the mouse, which is what pauses. Use `court esc` in play. In the pause menu and the sheets the real key works, and the recipe uses it there.
- Esc in the pause menu resumes only while the game has not held the mouse in this page load. After `PLAY` or a click on the court, `court esc` followed by `court key Escape` leaves the pause menu up: headless Chromium does not hand the mouse back to a key press, and the game stays paused when it cannot get the mouse. Whether desktop Chrome does the same was not checked when this was written. After the game has held the mouse, resume with `RESUME`.
- Chromium refuses to hand the mouse back for about 1.25 seconds after it was released. `court esc` waits 1.5 seconds for that reason. The game also retries by itself after that delay; in headless Chromium the retry does not get the mouse, so a `RESUME` or `Restart drill` click that lands inside the window leaves the pause menu up. Do not release the mouse any other way (for example `court eval 'document.exitPointerLock()'`) and click straight after.
- `role=button[name="RESUME"]` finds nothing on a desktop session: the button carries an `ESC` key cap, so its accessible name is `RESUME ESC`. `.pause .play-btn` works on desktop and touch. `pauseMenu.buttons` reports the label without the cap.
- Both sheets report `"screen":"settings"`. `sheet` in the state line says which one is open, `settings` or `athlete`. `settingsPanel.rows` has only the rows on screen: one tab of Settings, or the hitting hand and the three body sliders of Athlete. Click the tab before reading or setting a row in it.
- A switch is `role=switch` with the setting's name, and its row reads `On` or `Off`. A choice (View, Touch controls, Net height, Venue) is a chip for each option, and its row reads the chip that is on. Click the chip you want: a click on the chip that is already on changes nothing.
- With a sheet open over the start screen, the start screen stays in the page under it. `role=button[name="Settings"]` then matches the pill under the sheet as well as the sheet's own button and fails. Use `.sheet-head .ghost-btn` for the button to the other sheet.
- With the Athlete sheet open over the start screen, `start.position` in the state line is the screen under the sheet and follows only when the sheet closes. Read `settingsPanel.athlete.position` and `saved.menu.pos` while it is open.
- Settings reopens on the tab that was left, until the page is reloaded. A reload goes back to Controls.
- `Reset to defaults` needs two presses, and the second must be the next thing pressed: the button goes back to `Reset to defaults` when it loses the focus. The reset rebuilds the sheet, on the same tab.
- A click on a slider moves it to the clicked point. Use `court set`, or click and then `court key ArrowRight` / `ArrowLeft`.
- There is no save button. A change is applied and saved when it is made. `DONE` only closes the sheet.
- The height, jump and power sliders edit the position whose card is selected. The sheet opens on the position being played, or on the one selected on the start screen.
- The custom body applies to your player only. AI athletes keep the defaults.
- While paused, `court step` succeeds but the game does not advance. That is the pause working, not the clock failing.
- This recipe changes saved settings. If you stop part-way, run `court open --fresh` before another recipe.
