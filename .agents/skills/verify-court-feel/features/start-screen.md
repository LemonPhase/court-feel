# Start screen

The start screen is where a player picks one of five positions, one of six drills and a camera, then starts the drill. The game remembers the last position, drill and camera for the next visit.

## Sub-features

- `start-first-visit` shows Outside Hitter, Spike Drill and third person on a first visit, with the build label.
- `start-position` selects one of the five position cards.
- `start-drill` selects one of the six drill cards, by click or by the keys `1` to `6`.
- `start-camera` chooses first or third person and saves it.
- `start-play` starts the selected drill in the selected position and camera.
- `start-remember` preselects the last played position and drill after a reload.

## How to get to it (user POV)

- Open the app with no parameters, or with a link whose `mode` is unknown.
- Choose `Quit to menu` in the pause menu.
- Start a drill from here in three ways: the `PLAY` button, the Enter key, or a double-click on a drill card.

## Driving it with court.mjs

Preconditions:

- A desktop session is running and `court doctor` ends with `HEALTHY`.

- **First visit.** Open the app as a new player. Run `court open --fresh`. The state line shows `"screen":"start"` and `"start":{"position":"OH","drill":"Spike Drill","camera":"Third person"}`. Run `court state`: `build` reads `v<version> · <7-character commit>` and `saved.menu` is `null`.
- **Choose a position.** Click the Middle Blocker card. Run `court click '.pos-card:has(.pos-short:text-is("MB"))'`. The state line shows `"position":"MB"`.
- **Choose a drill by click.** Click the Block Drill card. Run `court click '.mode-card:has(.mode-t:text-is("Block Drill"))'`. The state line shows `"drill":"Block Drill"`.
- **Choose a drill by key.** Press `6`. Run `court key 6`. The state line shows `"drill":"Mini Rally"`. The keys follow the numbers on the cards: 1 Free Play, 2 Spike Drill, 3 Block Drill, 4 Serve Receive / Dig, 5 Setter Drill, 6 Mini Rally.
- **Choose the camera.** Click `First person`. Run `court click 'role=button[name="First person"]'`. The state line shows `"camera":"First person"`. Run `court state`: `saved.settings.firstPerson` is `true`.
- **Proof of the selection.** Run `court shot start-selected`. The screenshot shows the MB card, the Mini Rally card and the `First person` chip highlighted.
- **Play with the button.** Click `PLAY`. Run `court click 'role=button[name="PLAY"]'`. The state line shows `"screen":"play"` and `"title":"Mini Rally · you are the Middle Blocker"`. Run `court state`: `game.mode` is `rally`, `game.position` is `MB`, `game.camera` is `fp`, `game.pointerLocked` is `true`, `hud.camera` is `FIRST PERSON` and `saved.menu` is `{"mode":"rally","pos":"MB"}`.
- **Selection remembered.** Reload. Run `court open`. The state line shows `"start":{"position":"MB","drill":"Mini Rally","camera":"First person"}`.
- **Play with Enter.** Press Enter on the freshly loaded start screen. Run `court key Enter`. The state line shows `"screen":"play"` and the same Mini Rally title.
- **Play by double-click.** Reload, then double-click the Setter Drill card. Run `court open` and `court dblclick '.mode-card:has(.mode-t:text-is("Setter Drill"))'`. The state line shows `"screen":"play"` and `"title":"Setter Drill"`.
- **Proof.** Run `court shot start-played` and `court errors`. The screenshot shows the drill's HUD with no start screen over it. `errors` reports `"count": 0`.

## Gotchas

- A spike drill plays behind the start screen. While `screen` is `start`, `game.mode` is `spike` and `game.autopilot` is `true` whatever is selected. Read `start.*`.
- Enter starts the drill only while focus is on the page, a position card or a drill card. After a click on a camera chip or `Settings`, Enter presses that control again. Reload with `court open` before `court key Enter`, as the recipe does.
- The digit keys select drills only while the start screen is visible and the settings are closed.
- At 1280x720 the build label is below the visible part of the start screen. Read it from `build` in `court state`, not from a screenshot. The pause menu shows it on screen.
- `PLAY`, Enter and double-click hand the mouse to the game (`game.pointerLocked` is `true`). A drill opened by link does not.
- The remembered drill and position are saved when a drill starts, not when a card is clicked. The camera is saved as soon as its chip is clicked.
