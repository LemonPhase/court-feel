# Start screen

The start screen has four sections, switched from the top bar: Home, Train, Play and Learn. Home is one press back into the last drill, or the tutorial offer on a first visit. Train lists the five drills, Play the Mini Rally, and Learn the tutorial and every control. In Train and Play a player picks a position and a view, then starts with the gold `PLAY` button. The game remembers the last drill, position and view for the next visit.

## Sub-features

- `start-welcome` shows the welcome on Home on a first visit: `START THE TUTORIAL` or `Skip to the drills`, with the build label.
- `start-skip` declines the lesson with `Skip to the drills` and opens Train with Outside Hitter, Spike Drill and third person.
- `start-nav` switches between Home, Train, Play and Learn from the top bar, and from the three doors on Home.
- `start-drill` selects one of the five drill rows in Train.
- `start-position` selects one of the five positions with the `Play as` chips, and saves it at once.
- `start-view` chooses first or third person and saves it.
- `start-play` starts the section's drill in the selected position and view: the `PLAY` button, the Enter key or a double-click on a row.
- `start-continue` shows the last played drill, position and view on Home after a reload, with `CONTINUE`.
- `start-first-play` declines the tutorial offer when a first-time visitor starts a drill without `Skip to the drills`.

## How to get to it (user POV)

- Open the app with no parameters, or with a link whose `mode` is unknown. It opens on Home.
- Choose `Quit to menu` in the pause menu. It opens on the section the drill was started from.
- Switch sections with `Home`, `Train`, `Play` and `Learn` in the top bar, the `COURT FEEL` logo (Home), or the three doors on Home.
- Start a drill in three ways: the section's gold button (`PLAY` in Train and Play, `CONTINUE` on Home), the Enter key, or a double-click on a drill row.

## Driving it with court.mjs

Preconditions:

- A desktop session is running and `court doctor` ends with `HEALTHY`.

- **First visit.** Open the app as a new player. Run `court open --fresh`. The state line shows `"screen":"welcome"` and `"welcome":{"title":"First time here?","button":"START THE TUTORIAL"}`. Run `court state`: `build` reads `v<version> · <7-character commit>`, and `start`, `saved.menu` and `saved.tutorial` are `null`.
- **Skip to the drills.** Click `Skip to the drills`. Run `court click 'role=button[name="Skip to the drills"]'`. The state line shows `"screen":"start"` and `"start":{"section":"train","position":"OH","drill":"Spike Drill","camera":"Third person","button":"PLAY"}`. Run `court state`: `saved.tutorial` is `"skipped"`.
- **Home.** Click `Home` in the top bar. Run `court click 'role=button[name="Home"]'`. The state line shows `"section":"home"`, `"drill":"Spike Drill"` and `"button":"PLAY"`. Run `court shot start-home`: the card `A good place to start` with Spike Drill and the gold `PLAY`, and the three doors Train, Play and Learn under it.
- **Sections.** Open Play by its door, then Learn and Train from the top bar. Run `court click '.door:has(.door-t:text-is("Play"))'`: the state line shows `"section":"play"` and `"drill":"Mini Rally"`. Run `court click 'role=button[name="Learn"]'`: the state line shows `"start":{"section":"learn","position":"OH","drill":null,"camera":null,"button":"TAKE IT AGAIN"}`. Run `court click 'role=button[name="Train"]'`: the state line shows `"section":"train"` and `"drill":"Spike Drill"`.
- **Choose a drill.** Click the Block Drill row. Run `court click '.view.on .row:has(.row-t:text-is("Block Drill"))'`. The state line shows `"drill":"Block Drill"`.
- **Choose a position.** Click the `MB` chip under `Play as`. Run `court click 'role=button[name="Middle Blocker"]'`. The state line shows `"position":"MB"`. Run `court state`: `saved.menu` is `{"mode":"spike","pos":"MB","played":false}`: the position is saved at once, the drill only when it is started.
- **Choose the view.** Click `First person`. Run `court click 'role=button[name="First person"]'`. The state line shows `"camera":"First person"`. Run `court state`: `saved.settings.firstPerson` is `true`.
- **Proof of the selection.** Run `court shot start-selected`. The screenshot shows Train with the Block Drill row, the `MB` chip and the `First person` chip highlighted, the Block Drill panel with its three keys, and `MB Middle Blocker` in the pill at the top right.
- **Play with the button.** Click `PLAY`. Run `court click '.view.on .panel-foot .play-btn'`. The state line shows `"screen":"play"` and `"title":"Block Drill"`. Run `court state`: `game.mode` is `block`, `game.position` is `MB`, `game.camera` is `fp`, `game.pointerLocked` is `true`, `hud.camera` is `FIRST PERSON` and `saved.menu` is `{"mode":"block","pos":"MB","played":true}`.
- **Continue on Home.** Reload. Run `court open`. The state line shows `"screen":"start"` (the welcome does not come back) and `"start":{"section":"home","position":"MB","drill":"Block Drill","camera":"First person","button":"CONTINUE"}`. Run `court shot start-continue`: the card `Pick up where you left off` with `Block Drill`, `Middle Blocker · first person · men's net 2.43 m` and the gold `CONTINUE`.
- **Play with Enter.** Press Enter on the freshly loaded Home. Run `court key Enter`. The state line shows `"screen":"play"` and `"title":"Block Drill"`.
- **Play by double-click.** Reload, open Train and double-click the Setter Drill row. Run `court open`, `court click 'role=button[name="Train"]'` and `court dblclick '.view.on .row:has(.row-t:text-is("Setter Drill"))'`. The state line after the click shows `"section":"train"` and `"drill":"Block Drill"`, the remembered drill. The state line after the double-click shows `"screen":"play"` and `"title":"Setter Drill"`.
- **Play the Mini Rally.** Reload, open Play and press Enter. Run `court open`, `court click 'role=button[name="Play"]'` and `court key Enter`. The state line after the click shows `"section":"play"` and `"drill":"Mini Rally"`. The state line after Enter shows `"screen":"play"` and `"title":"Mini Rally · you are the Middle Blocker"`. Run `court state`: `saved.menu` is `{"mode":"rally","pos":"MB","played":true}`.
- **A first visit that goes straight to a drill.** Open as a new player, go to Train by the top bar and start. Run `court open --fresh` and `court click 'role=button[name="Train"]'`. The state line shows `"screen":"start"`, not `welcome`: the welcome is on Home only. Run `court state`: `saved.tutorial` is still `null`. Run `court click '.view.on .panel-foot .play-btn'` and `court state`: `saved.tutorial` is `"skipped"` and `saved.menu` is `{"mode":"spike","pos":"OH","played":true}`.
- **Proof.** Run `court shot start-played` and `court errors`. The screenshot shows the drill's HUD with no start screen over it. `errors` reports `"count": 0`.

## Gotchas

- `role=button[name="PLAY"]` finds nothing on a desktop session. The gold buttons carry an `ENTER` key cap, so their accessible names are `PLAY ENTER` and `CONTINUE ENTER`, and on a touch session, where the cap is hidden, `PLAY` and `CONTINUE`. `.view.on .panel-foot .play-btn` (Train and Play) and `.continue .play-btn` (Home) work on both.
- Train and Play each have their own `Play as` chips and view chips, and the section that is not showing stays in the page. `role=` selectors skip the hidden copy. A CSS selector such as `.pos-chip[aria-label="Middle Blocker"]` matches both and fails: start it with `.view.on`.
- `screen` is `welcome` only while the welcome itself is showing, which is on Home. A first-time visitor on Train, Play or Learn reads `"screen":"start"`, and the offer is still open until `saved.tutorial` is set.
- On the welcome, Enter starts the tutorial, not a drill. In Learn, Enter does nothing: the lesson's button (`START`, `CONTINUE` or `TAKE IT AGAIN`, `.lesson .play-btn`) has no key and starts the tutorial only by a click. The map does not cover the lesson yet (see the index).
- The number keys do nothing on the start screen. Select a drill by its row.
- A spike drill plays behind the start screen. While `screen` is `start`, `game.mode` is `spike` and `game.autopilot` is `true` whatever is selected. Read `start.*`.
- `start.drill` and `start.camera` are what the section in view would start: the Continue card's drill on Home, the selected row in Train, Mini Rally in Play. In Learn both are `null`.
- Enter presses the gold button of Home, Train or Play while focus is on the page, a drill row, a chip or the top-bar button of the section in view. Other focused controls keep Enter: after `Settings` is closed the focus is back on its pill, and Enter opens it again. The recipe presses Enter straight after `court open` or a click on a section's top-bar button.
- A click on a row in Train changes what `PLAY` starts, but it is saved only when a drill starts or a position is chosen. A `Play as` chip saves the position at once, together with the drill selected at that moment and `played` unchanged. The view is saved as soon as its chip is clicked.
- `PLAY`, Enter and double-click hand the mouse to the game (`game.pointerLocked` is `true`). A drill opened by link does not.
- The Athlete pill at the top right opens the Athlete sheet, where a card also changes the position. [Pause and settings](./pause-settings.md) drives it.
