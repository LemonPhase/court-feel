# Quick-start links

A link with a `mode` parameter skips the start screen and starts that drill directly. Players share these links, so every value is checked: a bad drill opens the start screen, a bad position falls back to Outside Hitter, and a bad camera, autopilot or hand is ignored.

## Sub-features

- `link-mode` starts the drill named by `mode`: `free`, `spike`, `block`, `receive`, `setter`, `rally`.
- `link-pos` plays the position named by `pos`: `OH`, `OPP`, `MB`, `S`, `L`.
- `link-cam` overrides the camera with `cam=fp` or `cam=tp`.
- `link-hand` overrides the hitting hand with `hand=left` or `hand=right`.
- `link-bot` turns on the autopilot with `bot=perfect`, `good`, `sloppy` or `tip`.
- `link-touch` forces the touch controls on a desktop with `touch=1`.
- `link-bad-values` handles unknown values without an error.

## How to get to it (user POV)

- Open the app URL with a query string, for example `?mode=spike&pos=OH&cam=fp`.

## Driving it with court.mjs

Preconditions:

- A desktop session is running and `court doctor` ends with `HEALTHY`.

- **Drill, position, camera and hand.** Open a block drill as a left-handed middle in first person. Run `court open '?mode=block&pos=MB&cam=fp&hand=left' --fresh`. The state line shows `"screen":"play"` and `"title":"Block Drill"`. Run `court state`: `game.mode` is `block`, `game.position` is `MB`, `game.camera` is `fp`, `hud.camera` is `FIRST PERSON` and `game.hand` is `left`.
- **The link does not take the mouse.** In the same `court state` output `game.pointerLocked` is `false`. Click the court as a player would. Run `court click '#app > canvas'` and `court state`: `game.pointerLocked` is `true`.
- **Bad position.** Open a mistyped position. Run `court open '?mode=spike&pos=OHH' --fresh`. The state line shows `"screen":"play"` and `"title":"Spike Drill · Outside high ball (4)"`. Run `court state`: `game.position` is `OH`.
- **Bad drill.** Open a mistyped drill. Run `court open '?mode=spikey' --fresh`. The state line shows `"screen":"start"`.
- **Bad camera, autopilot and hand.** Run `court open '?mode=spike&pos=OPP&cam=side&bot=great&hand=both' --fresh`. The state line shows `"screen":"play"` and `"title":"Spike Drill · Opposite back set (red)"`. Run `court state`: `game.camera` is `tp`, `game.autopilot` is `false` and `game.hand` is `right`, the defaults.
- **Autopilot.** Open the receive drill with the autopilot on the manual clock. Run `court open '?mode=receive&pos=L&bot=perfect' --fresh --manual`. Run `court state`: `game.autopilot` is `true`. Run `court step 30 --until 'window.__verify.events.some(e => e.who === "me")'`, then `court events`: the last entry is a `contact` by `me` with `"kind": "pass"`.
- **Touch controls on a desktop.** Run `court open '?mode=spike&pos=OH&touch=1' --fresh`. Run `court state`: `game.touchControls` is `true` and `hud.message` names buttons, not keys: `Approach: the stick out · plant: JUMP · hold HIT, release to hit · 1-3 set call`. Run `court shot link-touch`: the stick ring at the bottom left and the JUMP, HIT, BLOCK and PASS buttons at the bottom right.
- **Proof.** Run `court errors`. It reports `"count": 0`.

## Gotchas

- A link starts the drill without a click, so the game does not hold the mouse. `court look` fails until `court click '#app > canvas'`. Keys and mouse buttons work at once.
- `cam` and `hand` from a link apply to this page load. They reach `saved.settings` only when something else saves the settings (the `v` key, the settings panel). Check `game.camera` and `game.hand`, not `saved`.
- The link leaves the remembered start-screen selection (`saved.menu`) alone.
- `bot` is test tooling that ships in the app. It proves the link parameter works, not that a human can make the contact.
- `touch=1` on a desktop session shows the touch layout, but the session has no touch screen: `court tap` and `court touch` need `court launch --touch`. See [Touch controls](./touch-controls.md).
- A drill opened without `--manual` runs on the real clock at once, at well below real speed. Add `--manual` when the recipe plays a ball.
