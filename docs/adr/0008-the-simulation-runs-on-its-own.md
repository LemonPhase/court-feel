# The simulation runs on its own, and every import points down

`Game` built the renderer, the HUD and the effects, and was handed whole to
every brain, drill and effect. No test could build a real one, and `ai/` and
`game/` imported each other. The decision: the simulation (athletes, ball,
contacts, judge, the drills' rules, the AI) is a layer with no DOM and no
renderer. It imports only `physics`, `core`, `config` and three.js maths
types. `ui`, `render` and `input` sit above it: they may read it, it never
imports them, and it tells them what happened only through events. A human
reaches it only as a command through a seat, the same door the autopilots
use. `app` is the one place that sees every part. This is so that a real
simulation can be built in a unit test, a drill can be replayed from a seed,
and a second player is one more source of commands.

## Considered options

* **Keep `Game` and only narrow what callers see of it.** Turned down: the
  simulation would still construct its own display, so it still could not run
  without a browser.
* **Plain `{x, y, z}` data in the simulation instead of three.js vectors.**
  Turned down for now: a large rewrite that changes nothing for the player.
  The snapshot converts to plain data at the edge.

## Consequences

The code gets there in steps, each one a `refactor` with nothing changed for
the player. Two tests hold the ground as it is won. One reads the imports
under `src/` and names those that still break this rule; that list only gets
shorter. The other plays every drill from a seed with an autopilot and
compares the result with a recorded trace, so a step that changes the play
fails.
