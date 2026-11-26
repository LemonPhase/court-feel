# Verification

How Court Feel keeps a change from breaking the game, and how to decide where a
new rule should live. [AGENTS.md](../AGENTS.md) says what to do; this says why
the checks are arranged the way they are. The list of every test and what it
fails on is in the [README](../README.md#testing).

## The principle

**Hold each rule in the cheapest layer that can hold it.**

There are five places a rule can live. They are ordered by what each costs
every time a change is made:

| Layer | What it is | What it costs |
|---|---|---|
| 1. The codebase | The structure makes the wrong thing awkward or impossible to write | Paid once |
| 2. Static analysis | Types, lint, the architecture test, unit tests, CI | Seconds, every change |
| 3. Verification | Running the game and comparing what happens | Minutes, every change |
| 4. Prose | `AGENTS.md`, decision records, skills | Has to be read, remembered and followed |
| 5. Human review | A person looks | A person, every time |

A rule that lives only in prose is a rule that will be broken by someone who
did not read it, person or agent. A rule that lives only in review is paid for
with attention on every pull request. So when a rule is added, or broken, ask
how high up the table it can go.

The order is Lauren Tan's pyramid ("how do I trust my agents more?").

## Where a new rule goes

Ask these in order and stop at the first yes.

1. **Can the structure make it impossible?** A brain is handed an `AiHost`, so
   it cannot reach the HUD: there is nothing to forbid. A `Simulation` has no
   renderer, so a test can build one. This is the best answer when it exists.
2. **Can a check hold it without running the game?** A type, a lint rule, a
   rule in `tests/architecture.test.ts`, a unit test that states the fact.
3. **Can a run show it?** The trace comparison for "nothing changed", a
   property test for "true for every input", the end-to-end run for "it still
   works in the browser".
4. **Only then prose.** Write it in `AGENTS.md`, and say there why no check
   holds it.
5. **Review is for what only a person can judge:** the feel, a decision, a
   change to the checks themselves.

## What holds what

### 1. The codebase

- **Every import points down** a fixed order of layers
  ([decision record 0010](adr/0010-the-simulation-runs-on-its-own.md)). The
  table is `tests/architecture.layers.json`.
- **The simulation runs on its own**: no DOM, no renderer, three.js for maths
  only. `src/game/simulation.ts`.
- **Narrow hosts.** Code is handed the few things it needs, not the object that
  has everything: `AiHost` for the brains, `SimulationHooks` for the simulation.
- **Physics is pure**: `config` and itself.

### 2. Static analysis

- **TypeScript, strict.** ESLint and Prettier.
- **The layer rule in the editor.** ESLint flags an import that points up a
  layer while it is being typed, from the same table as the test.
- **The architecture test** (`tests/architecture.test.ts`), which is the
  authority. It fails on an import that points up, on two files that import each
  other in a circle, on physics importing anything but `config`, on a brain
  importing `Game`, on a simulation file that touches the DOM or builds scene
  objects, on a clock or dice in the simulation (`Math.random`, `Date.now`,
  `performance.now`), on a test that fakes the game with a cast, on a test that
  writes a stand-in for the game by hand (below), on a new folder with no
  layer, and on a `src/config.ts` put back beside `src/config/`: the type
  checker and the build would read the file for every import of `config`, and
  the folder would be dead code.
- **A test of the play is built on a real simulation** (`tests/scene.ts`). The
  scene builder puts athletes, seats, teams and a ball in a real `Simulation`
  and steps it in the game's own order, the invariants checked at every step.
  The architecture test fails on four shapes of a stand-in, read from a test's
  text: a ball of its own (anything that defines `ensurePrediction`), a host for
  the contact system (any use of the `ContactHost` type), a contact system of
  its own (`new ContactSystem`), and a stub written over the simulation's dice
  or its contact system (an assignment to a member of `rng` or `contact`, apart
  from the state the game leaves there). The last is `tests/scene.ts`'s alone:
  its two knobs, fixed dice and "no touches", are the only things a test may
  hold still, each use with a comment saying what it isolates. The scan reads
  text, so it does not see a stub written through another name
  (`const cs = sim.contact; cs.tryPass = ...`), a stub on a brain or a team, a
  ball faked with no `ensurePrediction` at all, or a host faked through
  `as any`. Those are for review, and the last for lint.
- **The autopilots roll their own dice** (`tests/architecture.autopilot.test.ts`).
  An autopilot stands in for a player, and a player's hands are not part of the
  simulation: it fails when one reads the simulation's random stream.
- **Input has one door** (`tests/architecture.input.test.ts`). It lists the files
  that may listen for keys, the mouse, the pointer or touch, with the reason for
  each, and fails when another file starts to. Nothing in the simulation may: it
  is handed an intent.
- **Each layer reads the numbers it owns** (`tests/architecture.config.test.ts`,
  [decision record 0014](adr/0014-config-is-one-folder-with-a-file-for-each-owner.md)).
  Config is a folder with a file for each owner. The test fails when a file
  outside the folder imports one inside it (config has one door, its index),
  when a config file imports one listed after it in the index or is left out
  of it, when physics reads more of config than the court and the ball, when
  the simulation, the brains or a drill reads a number of the display or the
  app, and when a config file reads a clock, rolls dice or touches the page.
  The files of the simulation that still read one are on a known list that
  only gets shorter. It goes by the names a file imports
  from config, so it does not see a number handed on by the code that read it:
  a drill reads the app's settings through its host (`DrillHost.settings`),
  and the test sees that as one import of the type.
- **Numbers live in config** (`tests/architecture.numbers.test.ts`). The count of
  numbers each file in physics, the simulation, the brains and the drills holds
  of its own is written down, file by file, in
  `tests/architecture.numbers.json` and only goes down. A new one fails until
  it has a name in `src/config/`. It does not move the ones already there:
  that is the work the count is the measure of.
- **Unit tests that state a real-court fact**, in the test's name.
- **The verification map** (`tests/verification.map.json`, held by
  `tests/verification.map.test.ts`). For each drill and the position it is
  played as, each serve, lesson, setting, graphics level and venue, and each
  section of config, it names the unit tests, trace runs and end-to-end checks
  that hold it, or says `manual` and why no check can. The test reads what
  exists from the code and fails when something has no entry, and when an entry
  names a check that is not there. So a new setting or drill cannot arrive
  without saying what holds it, and what still needs a person is the map's
  `manual` lines, counted and not remembered. What it cannot tell: whether a
  check that is named holds the thing as well as the entry says.
- **CI on every pull request.**

### 3. Verification

- **The repeat check** (`npm run trace`), on every pull request: it is CI's
  `trace` job. It plays every drill twice with a seeded autopilot and the two
  runs have to be the same: the whole simulation after every frame, then what is
  drawn and shown: every call the HUD gets, the camera, the ball, every
  athlete's pose, the floor markers. The four lessons are taken the same way
  with scripted hands, down to what a lesson stores in the browser. The same
  start has to give the same play.
- **The trace comparison** (`npm run trace:compare`), on every pull request: the
  same job goes on to play every drill on the branch and on the commit it goes
  into, and compares the two the same way. Only a `feat` or a `fix` may differ:
  what is printed is then its difference, to be read against what the pull
  request says it changes. Every other type (`refactor`, `perf`, `test`, `docs`,
  `ci`, `chore`) says of itself that nothing changes for the player, and fails
  unless it prints `same play` (`scripts/same-play-as-base.mjs`). So a `docs`
  change that moves a number is caught, and so is a dependency that plays
  differently. Nothing is stored in the repo, so a feature that changes the play
  on purpose has nothing to re-record. What it cannot tell: it only speaks for
  what the runs play, the first run that differs is the only one it explains,
  and a `feat` that changed more than it meant to passes with its difference
  printed. A change to the autopilots plays differently in every run, so it is
  a `feat` or a `fix` too.
- **The title starts with its type** (`scripts/title-has-a-type.mjs`, in the
  `check` job): one of the eight in `AGENTS.md`. The comparison above and the
  gate below read the kind of change off the title, so a title with no type
  fails, with the command that retitles it. An edit of a title starts no run:
  the failure gives the command that runs the whole run again, since two jobs
  read the title and each has to judge the new one. What it cannot tell:
  whether the type is the true one. A change to the play titled `chore` is
  caught by the comparison where a run reaches it, and by nothing where none
  does.
- **The hands replay** (a pass of both). The game logs every frame's intent
  (`Game.handsLog`). Each drill is then played again from that
  log alone, with no autopilot and no key pressed, and has to give the same
  play. It fails when the simulation takes something from a player that is not
  in the intent: a key read on the side, a camera read for aim, an autopilot
  rolling the simulation's dice. A second player rests on this (docs/adr/0011).
- **A person's keys** (a pass of both). An autopilot says where its feet go
  outright and is never late, so what the game does for a person never runs in
  a drill it plays: the last steps onto a set, the jump set, the walk back when
  the player jumps, takes the stick or is not back in time. So the trace also
  plays runs with no autopilot (`KEY_RUNS` in `scripts/trace.mjs`): real keys go
  down and come up in `Input`, pressed by habits (what a player does about what
  is on the screen: runs off their spot, keeps jumping while they are walked
  back, looks away with the mouse, runs under a ball that is theirs and sets
  it), by scripts and by dice of the run's own. They play the Setter Drill, the Mini Rally, the other
  drills, the four lessons with the rep started again part-way, and the start
  screen's demo from the moment its page loads. They share a page of their own,
  and the simulation, the player's move command, the walk back, the camera and
  every call the HUD gets are compared after every frame. A run where what is
  shown is part of the rule (the demo, a walk back that ends with a dip, a
  lesson) is played a whole frame at a time; the others with the keys and the
  simulation only, which costs a fifteenth. Each run also counts
  what it reached, from outside (a screen dip, a step with no key down), and
  fails when it no longer reaches what it is in the list for: a run that stopped
  getting to its rule would be the same on two builds for the wrong reason.
  That count fails on any pull request, so a few of them are plain facts too:
  no step is taken for the player at Set aim assist 0, the body stays down with
  Auto jump set off, the screen dips when a walk back runs out of time, and a
  player who had looked away is then left looking where their spot faces (in
  the Setter Drill that is across the court, the one spot that does not face
  down it).
- **One painted frame** (the last pass of both). The Spike Drill with a double
  block on is stopped three seconds in, and that one frame is painted eight
  times in a page of its own. Nothing moves between the paints, so it has to be
  one picture. More than one means the GPU decided something the game did not,
  as it did with the outline of the block's shadow (#108).
- **Every drill with nobody watching** (`tests/drills.test.ts`). A real simulation
  and a real drill in Node, with no renderer, no DOM, no HUD and no camera
  (`tests/headlessGame.ts`), invariants checked at every step. It fails the
  moment a drill needs the browser to play, and it is where a test of a drill's
  rules can now be written without faking the game. The headless game keeps no
  copy of a rule of the play: a clean touch arms the judge, an AI player has its
  aim assist, and the player is walked back between reps, steps onto a set and
  goes up for it, all by the simulation and the seat, with the settings a new
  player has.
- **Two players in one simulation** (`tests/seats.test.ts`): two seats, each
  handed its own intents, and the game replays from the log of both.
- **What the game does for a player, on a bare seat** (`tests/seatRules.test.ts`):
  the last steps onto a set, the walk back between reps and the auto jump set,
  in a simulation with no app. These rules are held twice. The runs with a
  person's keys (above) hold them in the app, as the same play on two builds.
  These tests state each one as a fact, guard by guard: legs off the floor are
  asked for no step, the steps go to where a hop takes off from, the feet are
  left alone once the ball is in the hands, a body in the air is not jogged, a
  player who took the stick is never put anywhere. They are also the only
  check of the two rules no key can reach: the walk back giving way to feet
  that something else is already moving, and every seat being stepped (the app
  has one).
- **Property tests** (`tests/properties.test.ts`). A fact that must hold for
  every input, tried on hundreds of seeded ones. They are for the bugs nobody
  wrote a case for. The inputs are seeded, so the tests are as repeatable as any
  other and a failure prints the input that broke.
- **Invariants** (`tests/invariants.ts`). What is true of the simulation after
  every step: every number finite, nobody under the floor, the clock moving one
  step at a time. A rare bug fails at the step it happens.
- **The end-to-end run** (`npm run e2e`): every drill in a real browser through
  the real input path. It also states, with nobody playing for the player, the
  facts of the help a person gets that hold whatever the code looks like: hands
  off, the feet step onto a pass in reach and the hands are under it when it
  arrives; at Set aim assist 0 nothing moves the body; with Auto jump set on
  the body goes up for a pass in system, and with it off it stays down; a player
  who is not back on their spot in time is put there and the screen dips once;
  one who took the stick is never put anywhere; the Mini Rally waits less long
  than a drill. They were written while these rules were in `Game`, which only
  a browser can build. The rules are the seat's now, and
  `tests/seatRules.test.ts` states them in the cheaper place. These stay as
  the check that the app, with its settings and a person's keys, still brings
  them to the player. Where a unit test can reach a rule, it is the cheaper
  place.
- **The block sweep** (`node scripts/block-sweep.mjs`): a measurement, not a pass or a
  fail. It sends attacks at a blocker through the real block, across hitters,
  angles, speeds, jump timing and where along the hands the ball crosses the
  net, and writes what the block did with each (`scripts/out/block-sweep/`):
  how wide it is by angle, what a touch turns into by timing and by where on
  the hands, where stuffs and block-outs go. Run it before and after a change
  to the block and compare the two.
- **Driving the app.** The `verify-court-feel` skill lets an agent run the game
  and look, before it says a change works.

### 4. Prose

- **[AGENTS.md](../AGENTS.md)**: the working guide. Its rules that have no check
  yet are [listed below](#rules-with-no-check-yet).
- **[Decision records](adr/README.md)**: why a call was made and what was
  turned down.
- **How to work on a change**, in `AGENTS.md`: the approach before the code,
  the test first, stop after three failed attempts.

### 5. Human review

- **The feel.** No check can say whether a spike feels right. A change that
  touches the game is its developer's to play on the preview, suggested and not
  enforced, and an agent that hands one over ends its message with what to play
  there. The play-test that gates is before a release: `main` is not production.
- **Decisions**, and **changes to the checks**.

## The checks cannot be loosened by the change they judge

A check is worth nothing if the change it judges can rewrite it.

- **CI runs the architecture rules as they are on the branch a pull request
  goes into**, as well as the pull request's own (`scripts/rules-from-base.mjs`).
  A pull request that loosens the test still has to pass the old one.
- **The known lists only get shorter.** `tests/architecture.known.ts` names
  every breach that still exists. A new entry fails CI, unless the list ends up
  shorter than it was: a refactor that moves a breach nearer to where it ends
  puts entries in and takes more out. Fix new code; do not list it.
- **The files that judge every change** are listed in
  [.github/CODEOWNERS](../.github/CODEOWNERS). A change to one of them is the
  owner's to approve. A check that a change needs (a new guard, a shorter list,
  a lower count) rides with that change, in a commit of its own. Loosening one
  (raising a count, lengthening a known list, weakening or removing a test) is
  never part of the change it would let through: it is a
  pull request of its own, for the owner to approve.
- **A test is never skipped, weakened or deleted to get CI green.**

## What a passing run does not tell you

Say these out loud in a pull request when they apply.

- **The trace proves what the autopilots and the runs with a person's keys
  play**, in the repeat check and in the comparison. A change they never reach
  passes. It does not cover the menus, touch input (the stick is a way to steer
  that no run has), effects or sound, and a lesson is covered as far as its
  scripted hands get: the spike and the float lesson to the end, the two jump
  serves to their last rep.
- **Two rules for a person that no key reaches**, so no run can: the walk back
  giving way to feet that something else is already moving (with a keyboard a
  move key is the only thing that moves them, and a move key already makes the
  walk back the player's), and every seat being stepped (the app has one seat).
  A unit test on a bare seat holds each (`tests/seatRules.test.ts`: "feet
  already going somewhere are left to it", "every seat's player goes up for
  their own set"). A run that prints `same play` says nothing about them.
- **First person is never played.** Every pass of the trace sets the camera to
  third person. Where a walk back that runs out of time leaves the player
  looking is held in third person (two runs look away first). What the same
  placement does to the first-person view (the eye is started again from the
  new spot, in `Game.userPlaced`) is held by nothing: a refactor that drops it
  prints `same play`. The seat's half is tested: it tells whoever runs the game
  of every placement and whether it was a snap. Until a run plays in first
  person, the rest is a look by a person: look away, get put back on the spot,
  in first person.
- **The trace sees one painted frame**, of the Spike Drill with a block on, and
  only that eight paints of it are one picture. It does not say the picture is
  the right one, and no other drill or moment is painted.
- **The end-to-end run checks that things work, not that they are unchanged.**
- **A property test proves its property**, on the inputs it generates. A fact
  nobody stated is not tested.
- **Passing tests do not prove a change to what the player sees.** Drive the
  app.

## A change to the play brings a check, or says why not

The rule: a change that alters the feel, or adds something a player can feel,
adds or updates the check that holds it, and if no check can hold it the pull
request says why. It was prose, and review was its only reader. Now the `check`
job holds it (`scripts/brings-a-check.mjs`), for a pull request whose title
starts with `feat` or `fix`:

- **It says how it is held.** Its description has the template's sections "How
  it is held" and "What no check holds", each with more in it than the
  template's comment.
- **It touches the play** (physics, the simulation, the brains, the drills, the
  input door, the gameplay files of config). Then one of the tests it adds or
  changes fails on the code of the branch it goes into, or it changes the
  trace's runs, or a line `Unchecked: <reason>` stands under "What no check
  holds". `scripts/red-on-base.mjs` is what tries the tests: this checkout, with
  `src/` as it is on the base. A test of a function the base does not have
  cannot run there, and that is red too. So is a test that does not end there:
  the run is stopped after two minutes and the file is named, because a fix for
  a loop that never ends comes with the test that states it.
- **It touches only what is shown and heard** (the HUD, the menus, effects,
  sound, the camera, the world, the look and sound files of config). Then a
  test, the end-to-end run, a `verify-court-feel` feature file or a trace run
  changed with it, or the same line stands.

Which path is in which tier is one table (`TIERS` in
`scripts/brings-a-check.rule.mjs`), and a file of config or a folder of `src/`
that nobody has listed is the play. The decision is a pure function of the
title, the changed paths, the tests that are red on the base and the
description, and `tests/bringsACheck.test.ts` holds it case by case. Like the
architecture rules, the gate that judges a pull request is the base branch's.
Every failure says what to do and ends with how to have the gate look again: a
push, when a test or a run mends it, or the command that runs the whole run
again, when the description does (an edit to a description starts no run).

What it cannot tell:

- **Whether the test states the fact.** For the play, any test that fails on
  the base passes it: one that only calls a new function is red there. For what
  is shown and heard, any changed test passes it, an empty one too. What a test
  holds is still found by breaking the line it is there for.
- **Whether the reason is a good one.** `Unchecked: no time` passes, on purpose:
  the reason is then written where the owner sees it, in the description and in
  the job's summary, and not left unsaid.
- **Whether a trace run was added.** A run taken out of the list changes the
  list too.
- **Anything about another title.** A change to the play that is called a
  `chore` is asked nothing here. The comparison with the base catches it where
  a run of the trace reaches it, and a title with no type fails its own check.
- **What a line is.** It goes by path, so a comment changed in a file of the
  play is a change to the play.

## Rules with no check yet

A rule that lives in prose only is the one most likely to be broken. List it
here with the layer it should move to, and move it up this page when it gets a
check. The last one that was listed alone, that a changed mechanic comes with a
test that states the real-court fact, is held by the gate above as far as a
check can hold it.

| Rule | Where it should go |
|---|---|
| A test holds nothing of the game still but the scene builder's two knobs | The architecture test sees a stub on `rng` or `contact` by name. A stub through another name, or on a brain or a team, is seen by review only. `as any` in tests wants a lint rule |
