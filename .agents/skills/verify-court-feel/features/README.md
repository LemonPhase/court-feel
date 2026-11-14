# Court Feel verification map

This directory is the maintained source for verifying the user-facing behaviour of Court Feel. Read this index before driving the app, then use the matching feature file as the recipe. `../SKILL.md` explains the helper, the clocks and the proof standards.

## Baseline preconditions

- You are in the repo root, on Node 22 (`source ~/.nvm/nvm.sh && nvm use`).
- A session you launched is running and `court doctor` ends with `HEALTHY`.
- Desktop recipes need a session from `court launch`. Touch recipes need one from `court launch --touch`. A recipe says which.
- Never drive a session that this verification run did not start.
- Every recipe starts with its own `court open ...`. Recipes that do not test persistence open with `--fresh`, which is a first visit with default settings. Without a link, a first visit shows the welcome on Home. Recipes that need the drills click `Skip to the drills` first, which opens Train with Outside Hitter, Spike Drill and third person selected.

## Driving conventions

- `court <args>` in a recipe means `.agents/skills/verify-court-feel/court.mjs <args>`, run from the repo root. Keep the quoting exactly as written.
- Run the bullets of a recipe in order. Later bullets build on the state of earlier ones.
- "The state line" is the `state {...}` line the command prints. `court state` prints the full snapshot, with fields such as `start.section`, `start.position`, `settingsPanel.rows`, `hud.camera`, `game.pointerLocked` and `saved.settings.fov`.
- Recipes that play a ball use the manual clock. After a `key` in play, the next `court step` is what makes the game read it.
- In `--until` expressions `g` is the running game and `window.__verify.events` is the recorded list that `court events` prints.
- Prefer the handles in the recipes (ARIA roles and names, the row, chip and card selectors) over coordinates.
- The start screen keeps the sections that are not showing in the page, and a sheet keeps the screen under it. Use the recipes' selectors as written: where one starts with `.view.on`, `.sheet` or `.pause`, a shorter one matches a hidden copy too.
- Numbers in the expected results (points, km/h, target zone) are what a `--fresh --manual` run gives at the time of writing. A change to tuning in `src/config.ts` can move them. The shape of the result is the contract, not the number.

## Proof and skip reporting

- Capture the action and the resulting state, not only the final screen: quote the state line or the `events` entry, and take a `court shot` after the step that matters.
- A setting or selection is proven when it shows in the UI, in `saved` in `court state`, and again after a reload with `court open`.
- A played rep is proven by its `events` entries (contact, grade, km/h, outcome) and the HUD score.
- End with `court errors` and report its count.
- Record the feature ID and the entry point with every artifact, for example `spike-set-call via key 2`.
- Name the hooks and stand-ins the proof used: manual clock, autopilot, `look`, `esc`, `set`.
- Report an unreachable path with the command you tried and what it printed.
- Do not report a skipped entry point as verified through a different one.

## Feature entry contract

Each feature file starts with an H1 title and one paragraph describing the user-visible behaviour. It then uses exactly four H2 sections in this order.

1. `Sub-features` lists short IDs with one line for each behaviour.
2. `How to get to it (user POV)` lists every user entry point.
3. `Driving it with court.mjs` starts with `Preconditions:` and uses labelled bullets that pair each user action with an exact command and the observable result.
4. `Gotchas` lists traps that can waste or invalidate a verification run.

Keep implementation details out of the map. Name only user paths, stable handles, required state, commands and observable proof.

## Features

- [Start screen](./start-screen.md) covers the first-visit welcome and skipping it, the Home, Train, Play and Learn sections, choosing a drill, a position and a view, the three ways to start, and Continue with the remembered selection.
- [Spike Drill](./spike-drill.md) covers a scored rep, set calls, the opposing block, replays, the camera toggle and resetting a rep.
- [Pause and settings](./pause-settings.md) covers pausing, resuming, restarting, quitting, the quick settings, the Settings sheet and its tabs, the Athlete sheet, resetting to defaults, and persistence.
- [Quick-start links](./quick-start-links.md) covers the URL parameters and their fallbacks for bad values.
- [Serve Drill](./serve-drill.md) covers picking one of the three serves, the toss, serving a float, a jump float and a jump serve by hand, the 0 to 4 rating by the pass forced, and the toss and foot faults.
- [Mini Rally](./mini-rally.md) covers the 6 v 6 rally: the serve, your set call, the point and the score, and re-serving.
- [Touch controls](./touch-controls.md) covers the phone layout: the stick, the hold buttons, aiming, the top-row buttons and the setting that turns them on.

## Not mapped yet

These are user-facing and have no feature file. A proof that touches one must say the map does not cover it, and should add the file.

- The first-run tutorial: `START THE TUTORIAL` on the welcome, the three guided balls (together, slow motion, full speed), `Skip tutorial`, the lesson's button under Learn (`START`, `CONTINUE`, `TAKE IT AGAIN`), `CONTINUE THE TUTORIAL` on the welcome of a lesson left part-way, the end dialog (`KEEP HITTING`, `Choose another drill`) and `?tutorial=N` links. `court state` reports it under `tutorial` and `saved.tutorial`, but no recipe drives it yet.
- Learn's controls list and its `Keyboard and mouse` and `Touch` chips.
- Free Play: feed types `1` to `4`, `f` feed now, `t` auto-feed, a toss of your own with `q`.
- Block Drill: reading the set, the block jump, stuff and touch scoring.
- Serve Receive / Dig: pass ratings 0 to 3, the setter and hitter finishing a good pass.
- Setter Drill: looking at a hitter and setting with the right mouse button.
- Crash screen and error reports: `RELOAD`, `Copy details`, the lost-graphics-context message.
- Debug overlay (`F3`).
- Keyboard-only menus (Tab order, the arrow keys between Settings tabs, focus returning to the button that opened a sheet) and reduced motion.
- The production build (`npm run build`, `npm run preview`) and Vercel preview deployments. The helper only drives the dev server.
