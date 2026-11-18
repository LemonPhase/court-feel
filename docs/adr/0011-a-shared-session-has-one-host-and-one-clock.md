# A shared session has one host and one clock

Multiplayer is planned and not built; this is the shape it will take, so the
code around it can be made ready ([0010](0010-the-simulation-runs-on-its-own.md)).
One machine runs the simulation, a player's browser at first. The others send
it commands, receive snapshots and predict their own athlete, so their timing
still feels local. A shared session also has one clock: whatever slows or
rewinds time for one player (the first-run lesson, the slow-mo assist, taking
a rally back to an earlier touch) is for solo play only, and hit-stop freezes
everyone together. If a shared freeze does not play well, a shared session
goes without hit-stop. Solo play keeps all of them exactly as they are. They
belong to the frame loop, which turns real time into ticks; the simulation
only counts ticks.

## Considered options

* **Every machine simulates and only commands are exchanged.** Turned down:
  it needs the same arithmetic in every browser, and JavaScript does not
  promise that for `Math.sin`, `Math.cos` and `Math.exp`, which the ball's
  flight uses.
* **Slow-mo, a rewind or hit-stop for one player in a shared session.**
  Turned down: one player's time cannot run slower than the other's, or go
  back while the other's goes on.

## Consequences

* The first milestone is plain: two players on different machines play in
  the same working game. Everything else about a shared session comes after.
* The transport will be browser-to-browser data channels (WebRTC) behind a
  small interface, because a late snapshot can be dropped and need not hold
  up the fresh one. It needs a small service that introduces two browsers:
  a server-side piece and a network dependency of its own,
  so it is asked about again when it is built.
* The host has no latency and the guest has some. The first shared mode is
  therefore a two-player drill on the same side of the net (one sets, one
  hits), where that matters least.
* Until then nothing is added for it. The refactor leaves four things in
  place: seats in place of the single user, commands that carry a seat and a
  tick, athlete ids handed out by the simulation, and a plain-data snapshot.
