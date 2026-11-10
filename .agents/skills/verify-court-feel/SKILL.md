---
name: verify-court-feel
description: Launch Court Feel (the 3D volleyball browser game in this repo) on a private Vite dev server and drive it in headless Chromium the way a player does (clicks, keys, mouse, touch), then capture screenshots and state as proof. Use it whenever a change to the game, its menus, HUD, drills, settings, quick-start links or touch controls has to be shown working in the real app, not only in unit tests, and when someone asks to run, screenshot or verify the app.
---

# Verify Court Feel

Court Feel is a client-only web app: a three.js canvas (the court) under DOM overlays (start screen, HUD, pause menu, settings, touch pad). There is no backend. All saved state is two `localStorage` keys in the browser profile (`courtfeel.settings.v1`, `courtfeel.menu`).

One helper does everything: `.agents/skills/verify-court-feel/court.mjs`. Run it from the repo root. It starts a dev server and a headless Chromium for this checkout, keeps the page alive between commands, and logs every command with the state it left behind.

`features/README.md` in this directory is the verification map: one file per user-facing feature with the exact commands and the observable result of each. Read it before you drive a feature. Update it when you learn something it lacks.

## Launch

Prerequisites, once per checkout:

```bash
source ~/.nvm/nvm.sh && nvm use          # Node 22, from .nvmrc. Every new shell needs this line.
npm ci                                   # only when node_modules is missing or package-lock.json changed
npx playwright install chromium          # only when doctor says Chromium is missing
```

Start a session:

```bash
.agents/skills/verify-court-feel/court.mjs launch            # desktop, 1280x720, mouse and keyboard
.agents/skills/verify-court-feel/court.mjs launch --touch    # phone, 844x390, touch screen
```

`launch` starts a supervisor process that runs `vite` on a free loopback port (this checkout's working tree, never port 5173) and a headless Chromium with a new, empty profile. It then loads the app and returns only when the start screen is up. A new profile is a first visit, so that screen is the welcome (`First time here?`). It takes 10 to 20 seconds. It prints the URL, the build label and the evidence directory. Ready means the last line starts with `ready`. On failure it prints the supervisor log and leaves nothing running.

Isolation:

- One session per checkout. A second `launch` refuses while one runs. If two launches overlap, the later one gets the session and the earlier one fails and cleans up after itself.
- Never drive a session you did not start. If `launch` says one is already running and it is not yours, start your own: prefix every command with `COURT_SESSION=<name>`. Sessions do not share ports, profiles or evidence.
- A desktop and a touch session can run side by side the same way: `COURT_SESSION=phone .agents/skills/verify-court-feel/court.mjs launch --touch`.
- A developer's own `npm run dev` on port 5173 is not touched and is not what you drive.

## Doctor

```bash
.agents/skills/verify-court-feel/court.mjs doctor
```

Read-only. Run it first, and again whenever a result looks off. It exits 0 when the session is worth driving. It checks Node against `.nvmrc`, installed dependencies and Chromium, that the supervisor and the dev server are the processes `launch` started and run from this checkout, that the dev server answers with Court Feel, the build label in the menus against `git HEAD`, the screen the page is on, a crash screen, a page reload you did not ask for, and console errors.

| Doctor says | Do this |
|---|---|
| `no session` | `launch` |
| `supervisor pid ... is gone` | `stop` (clears what it left), then `launch` |
| `the page did not answer`, or `a command has been running for N s` | The page is stuck, usually in an endless loop in the code under test or in an `eval`. `stop`, then `launch`. |
| `dependencies missing` / `Chromium missing` | the command it names |
| `the page reloaded since your last open` | You or someone edited a source file. Game state and the clock were reset. `open` again. |
| `still loading or has no game` | Wait 3 seconds, then `open` |
| `crash screen` | `state` shows the error details. Fix the cause, then `open`. |
| `menus show build X but HEAD is Y` | Only the label is stale. `stop` and `launch` if the proof must show the new commit. |

## Drive

`court.mjs help` lists every command. The ones you will use most:

| Command | What it does |
|---|---|
| `open [query] [--fresh] [--manual]` | Load the app. `open '?mode=spike&pos=OH'` uses a quick-start link. `--fresh` clears everything the app saved, so it is a first visit: without a link the app opens on its welcome. `--manual` starts on the manual clock. On the real clock a load takes 5 to 20 seconds, and the result's `took` says where the time went. |
| `click <selector>`, `dblclick <selector>` | Real mouse click. Playwright selectors: CSS, `text=`, `role=button[name="PLAY"]`. |
| `key <Key>`, `keydown <Key>`, `keyup <Key>` | Real key events. `Enter`, `Escape`, `Space`, `Tab`, `F3`, `Shift`, `ArrowRight`, letters `v`, digits `1`. |
| `mouse <down\|up> [left\|right]` | Attack (left) and block or set (right) buttons. |
| `look <dx> <dy>` | Mouse movement in pixels while in play. Right and down are positive. |
| `esc` | The Esc key as Chrome treats it in play: it releases the pointer, which pauses. |
| `set <selector> <value>` | Set a settings slider. |
| `tap <selector>`, `touch <start\|move\|end> <id> ...` | Touch session only. |
| `clock <manual\|real>`, `step <sec> [--until <js>]`, `wait <js>` | Time. See below. |
| `state`, `events`, `errors`, `shot <name>`, `eval <js>` | Observation. |
| `bot <perfect\|good\|sloppy\|tip\|off>` | Autopilot. A test hook. See below. |

A command that gets no answer from the page fails after 60 seconds (`open` 330, `shot` 120, `step` 900, `wait` its `--timeout` plus 10), so one stuck command cannot block the session. `doctor` and `stop` never wait behind a running command.

Every action command prints its result and one `state` line: the screen (`welcome`, `start`, `play`, `paused`, `settings`, `replay`, `crash`), the HUD title and score, and any grade, banner, message or call on screen. `state unchanged` means the same as after the previous command. A failed command prints `FAILED` and exits 1.

A minimal run:

```bash
.agents/skills/verify-court-feel/court.mjs open --fresh
.agents/skills/verify-court-feel/court.mjs click 'role=button[name="Skip to the drills"]'
.agents/skills/verify-court-feel/court.mjs click '.mode-card:has(.mode-t:text-is("Block Drill"))'
.agents/skills/verify-court-feel/court.mjs click 'role=button[name="PLAY"]'
.agents/skills/verify-court-feel/court.mjs shot block-drill-started
.agents/skills/verify-court-feel/court.mjs errors
```

### Time: use the manual clock for anything that plays

Headless Chromium renders with software WebGL, at about 10 to 30 frames a second. On the real clock the game then runs well below real speed (about a quarter when this was written), the speed varies with the machine, and after a few seconds the game lowers its render quality by itself. Menus and settings are fine on the real clock. Anything with a ball is not.

On the real clock the page can also fall seconds behind the software GPU, because WebGL does not wait for it. A click or a page load then takes 5 to 15 seconds to answer. That is the renderer, not the game hanging: the helper waits up to 30 seconds for a click, and `open` first lets the GPU finish the old page's frames.

- `open ... --manual` or `clock manual` freezes the game. Nothing moves until you `step`.
- `step 0.05` advances 0.05 s of game time at a fixed 60 Hz. A key you pressed is read on the next step, so every `key` in play needs a `step` after it.
- `step 20 --until '<js>'` stops as soon as the expression is true and fails if it never is. In `<js>`, `g` is the running game (`window.__court`) and `window.__verify.events` is the recorded event list.
- Hold a key for an exact time: `keydown Space`, `step 0.2`, `keyup Space`.
- A run that starts with `open --fresh --manual` and uses the same commands gives the same numbers every time.
- `wait '<js>'` is the real-clock equivalent of `step --until`. Use it only for things that are not game time, such as the crash screen.

### Real input and test hooks

Real input, the path a player's hardware takes: `click`, `dblclick`, `key`, `keydown`, `keyup`, `mouse`, `tap`, `touch`, and quick-start links in `open`. A proof of user-facing behaviour is built from these.

Stand-ins for what headless Chromium lacks. They are faithful, but name them in the proof:

- `look` sends the relative mouse movement as a DOM `mousemove`. Headless Chromium reports garbage movement while the game holds the pointer, so the helper drops the browser's own `mousemove` events in that state.
- `esc` releases the pointer the way Chrome does when you press Esc in play, then waits 1.5 seconds, because Chromium will not hand the pointer back sooner than that. A plain `key Escape` does nothing while the game holds the pointer. When the pointer is free (menus, pause, a drill opened by link), `esc` sends the real key.
- `set` writes a slider's value and fires its `input` event. The keyboard path is `click` on the slider, then `key ArrowRight`.

Test hooks. They are not user input. Say so when a proof uses one:

- `clock manual` and `step` use the game's `manual`, `holdRender` and `play()` hooks, the same ones `scripts/e2e.mjs` uses. They change how time passes, not what the game does with input.
- `bot` and `&bot=` in a link turn on the autopilot. It presses Space and the mouse buttons through the game's input layer, but it steers the feet directly, not through WASD and Shift. A change to movement keys needs hand input (`keydown Shift`, `keydown w`).
- `eval` can call anything. Use it to read. Starting a drill, changing a setting or moving an athlete through `eval` proves nothing about the user path.

### Stable handles

| What | Selector or key |
|---|---|
| Welcome (first visit) | `role=button[name="Skip to the drills"]`, `role=button[name="START THE TUTORIAL"]` |
| Position card | `.pos-card:has(.pos-short:text-is("MB"))` with `OH`, `OPP`, `MB`, `S`, `L` |
| Drill card | `.mode-card:has(.mode-t:text-is("Spike Drill"))`, or keys `1` to `6` on the start screen |
| Camera choice | `role=button[name="First person"]`, `role=button[name="Third person"]` |
| Play, settings, tutorial | `role=button[name="PLAY"]`, `role=button[name="Settings"]`, `role=button[name="Tutorial"]` |
| Pause menu | `role=button[name="RESUME"]`, `role=button[name="Restart drill"]`, `role=button[name="Quit to menu"]` |
| Settings row | `.set-row:has-text("Field of view") input` for a slider, `.set-row:has-text("Net height") .chip` for a switch, `role=button[name="DONE"]` |
| Your athlete | `.body-tab:text-is("MB")`, `.body-set input[data-body="height"]` with `height`, `jump`, `power` |
| The court | `#app > canvas` |
| Touch pad | `.t-jump`, `.t-hit`, `.t-block`, `.t-pass`, `.t-pause`, `.touch [data-btn="cam"]` with `cam`, `reset`, `replay`, `d1`, `d2`, `d3`, `vsblock` |
| Crash screen | `role=alertdialog`, `role=button[name="RELOAD"]`, `role=button[name="Copy details"]` |

In-play keys: `w a s d`, `Shift`, `Space`, `e` pass, `q` toss, `v` camera, `r` replay, `n` reset rep, `b` block (Spike Drill), `1 2 3` set call, `f` and `t` (Free Play), `F3` debug overlay.

## Evidence

Everything goes to the evidence directory `launch` printed: `shots/verify/<YYYYMMDD-HHMMSS>-<session>/`. Git ignores `shots/`.

- `NN-<name>.png`: one per `shot`, numbered in order.
- `actions.jsonl`: every command, its arguments, its result and the full `state` snapshot after it. This is the action-and-result trace. You do not have to build it by hand.
- `console.jsonl`: every console message, page error and page load, with timestamps.
- `supervisor.log`, `vite.log`: copied in by `stop`.

Proof standards:

- Drive the real user path: the control the player uses, by the handle in the feature map. A drill started with `eval` or a setting written to `localStorage` is not proof.
- Capture the action and the state it produced. Take a `shot` after the step that matters, and quote the `state` line or the `events` entry that shows the result. A final screenshot alone is not proof.
- Verify side effects. A changed setting must show in `state` under `saved.settings` and must survive `open` (a reload). A played rep must show in `events` (contact, grade, speed, outcome) and in the HUD score.
- HUD grades, banners, messages and call bubbles stay up for a few seconds of game time at most. Read them from the `state` line of the command that produced them, or from `events`. Do not rely on catching them later.
- End every proof with `errors`. It exits 1 if the page logged an error or a warning since the last `open`.
- Name every hook and stand-in the proof used (manual clock, autopilot, `look`, `esc`, `set`).
- A feature has several entry points in the map. Drive the ones your change touches. Report the ones you skipped as skipped, never as verified.
- This harness cannot verify sound, haptics, real-GPU frame rate, a real phone, the production build (`npm run build`) or a Vercel preview. Say so if the change touches one of them.

`npm run check` (types, lint, format, unit tests) and `npm run e2e` (the repo's own regression run of every drill, several minutes, writes `scripts/out/`) are separate from this skill. They answer "did I break something", this skill answers "does the thing I changed work in the app".

## Cleanup

```bash
.agents/skills/verify-court-feel/court.mjs stop
```

`stop` shuts down the supervisor and the dev server that `launch` recorded, and the browser with them. It identifies each by process id and start time, so a recycled pid from a dead session is never signalled. It removes the scratch state in `shots/verify/.sessions/<session>/` (browser profile, logs) and prints the evidence directory, which it never deletes. Run it when you are done, and after a failed run too. Stop each named session with the same `COURT_SESSION` it was launched with. After `stop`, list the evidence directory to confirm the proof is there.

Do not kill `vite`, `node` or `chrome` by name: a developer's own dev server and browser may be running.

## Helpers

`.agents/skills/verify-court-feel/court.mjs` is the only script. It is executable, needs nothing beyond the repo's dev dependencies (Playwright), and `court.mjs help` prints its full command list.

```bash
.agents/skills/verify-court-feel/court.mjs help
.agents/skills/verify-court-feel/court.mjs launch [--touch]
.agents/skills/verify-court-feel/court.mjs doctor
.agents/skills/verify-court-feel/court.mjs <open|click|dblclick|key|keydown|keyup|mouse|look|esc|set|tap|touch|clock|step|wait|state|events|errors|shot|eval|bot> ...
.agents/skills/verify-court-feel/court.mjs stop
```

## Gotchas

- Deleting `shots/verify/` or a session's folder under `shots/verify/.sessions/` ends that session: its supervisor notices within a few seconds and shuts everything down.
- Editing a file under `src/` while a session runs reloads the page a few seconds later. The game goes back to wherever the URL puts it and the clock goes back to real. `open` again after every edit. Doctor warns when this happened.
- A drill opened by link does not hold the pointer, because no click happened. `look` fails until you `click '#app > canvas'`. Keys and mouse buttons work without it.
- The start screen plays a spike drill in the background. While `screen` is `start`, `game.mode` in `state` is that background drill, not a selection. Read `start.position` and `start.drill`.
- Screenshots can show a grade or a banner fading out that `state` no longer reports. CSS fades run in real time even on the manual clock. `state` is the truth.
- The first `shot` after `open --manual` takes a few seconds, because it draws the first frame and compiles the shaders.
- The autopilot is reliable in the drills. In Mini Rally it sometimes misses. Assert on what `events` shows, not on a kill.
- Saved settings persist across `open` inside a session. Start a recipe with `open --fresh` unless it is about persistence.
- After `open --fresh` with no link the app shows the welcome, not the positions and drills. Click `Skip to the drills` to get to them. `state` then shows `saved.tutorial` as `skipped`, and later loads without `--fresh` go straight to the start screen. A quick-start link starts its drill directly, welcome or not.
