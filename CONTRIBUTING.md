# Contributing to Court Feel

Thanks for helping. Every change to Court Feel, whether it's code, a number in
the config or an idea, is measured against one principle:

> **True to the court.**

[The principle](README.md#the-principle) in the README explains what that
means. This guide turns it into how we work.

## Ways to help

| You are... | Do this |
|---|---|
| A player (no code needed) | Play it at [court-feel.jackzxq.dev](https://court-feel.jackzxq.dev) and [write a feel report](https://github.com/LemonPhase/court-feel/issues/new?template=feel-report.yml) whenever something doesn't feel like the court. This is the most valuable contribution there is. |
| Someone who hit a problem | [Report a bug](https://github.com/LemonPhase/court-feel/issues/new?template=bug-report.yml): a crash, an error, controls that stop responding, a wrong score. |
| Someone with an idea | [Suggest it](https://github.com/LemonPhase/court-feel/issues/new?template=idea.yml): a drill, a mechanic, a setting. Start from the volleyball moment it's about. |
| A developer | Pick an issue, or open one first for anything big (see below), then send a pull request. |

### Writing a good feel report

A feel report is about the gap between the game and a real court, so the
most useful thing you can tell us is what happens on a real court. That
part comes from your own experience as a player.

* **What you were doing:** the drill, your position, the camera (first or
  third person) and your device.
* **What happened in the game.**
* **What happens on a real court.** For example: "On a real court a go set
  is at the pin before I finish my approach. Here I have to wait for it."
* **How often:** every time, sometimes, once.
* **Tip:** press **R** straight after the moment to replay it, and take a
  screenshot. **F3** shows the timing numbers (how early or late you were).

## Talk before big changes

* **Small things** (a bug fix, a typo, a clearer hint): just open a pull request.
* **Anything that changes how the game plays** (timing windows, physics
  constants, controls, AI decisions, a new drill or mechanic): open an issue
  first. We agree on what the real court does before anyone builds it, so
  nobody's work gets thrown away.

The maintainer ([LemonPhase](https://github.com/LemonPhase)) makes the final
call, and makes it against the principle. "Is it true to the court?" settles
most debates.

## Development setup

You need Node.js 22 (what CI uses) and a browser with WebGL.

```bash
npm install
npm run dev          # http://localhost:5173
```

```bash
npm run typecheck    # TypeScript, strict
npm test             # Vitest unit tests
npm run build        # production build in dist/
npm run e2e          # Playwright: plays every drill through the real input path
```

Shortcuts while developing:

* **URL parameters** skip the menu: `?mode=spike&pos=OH&cam=fp&bot=perfect`
  (modes: `free`, `spike`, `block`, `receive`, `setter`, `rally`; bots:
  `perfect`, `good`, `sloppy`, `tip`; `touch=1` forces the touch controls).
* **F3** opens the debug overlay: FPS, physics step time, ball state, the
  timing window and contact gizmos.
* `window.__court` in the browser console is the running game (the e2e and
  screenshot scripts drive it through this).

The [project layout](README.md#project-layout) in the README says where
things live. [PROGRESS.md](PROGRESS.md) is the project's memory: each
playtest round, what was reported, the cause and the fix, plus a
**Decisions** list. Read it before changing a mechanic. The reason it works
the way it does is probably written there.

## The court test

Reviewers check every pull request against these five questions, one for
each rule of the principle. Answer them in the pull request template.

1. **Does it match the real sport?** Say where the numbers come from: the
   rules, a measurement, a video, a coach, your own play. Put the source in
   the pull request, or in a comment next to the value if someone will
   wonder about it later. If you bend reality to make something playable,
   say so and say why.
2. **Is the skill still the volleyball skill?** Timing should reward what a
   coach would reward. Every input goes through `Input` (`src/core/input.ts`):
   keys, mouse, touch and the test bots all use the same path, so the timing
   windows are identical everywhere. Don't add a side door.
3. **Is the physics honest?** The ball goes where the contact sends it.
   Solvers plan, and the live simulation decides what actually happens
   (whether the net gets in the way, for example). Assist may help the
   player's body, never the ball, and it must be fully off at 0.
4. **Do effects amplify rather than replace?** Effects scale with the quality
   and power of the touch. They never hide the ball, and there are no
   full-screen flashes.
5. **Has someone played it?** Say how you played it (drill, position,
   camera, device). For changes to the feel, get a volleyball player to try
   the pull request's preview deployment before it's merged.

## Code conventions

* **Every tunable number lives in [`src/config.ts`](src/config.ts)**, in the
  section it belongs to, with a doc comment if the name doesn't say what it
  is. No magic numbers in game code.
* **Units and frame:** metres, seconds, kilograms and radians unless the
  name says otherwise (km/h is for display only). Y is up, the net is the
  plane z = 0, the home team plays on +z facing -z, and facing -z the right
  hand is +x.
* **`src/physics/` stays pure:** no three.js scene, no DOM, only `config`.
  That's what keeps it deterministic and testable.
* **Tests encode real-court facts.** A change to physics, timing, contacts
  or AI decisions comes with a unit test in `tests/` that states the fact,
  for example "the middle leaves the floor on the setter's touch" or "a pass
  2.6 m off the net is called high".
* **TypeScript strict**, no unused locals. `npm run typecheck` must pass.
* **Assets:** everything is generated by code so far. Don't add art, audio or
  libraries without a license compatible with MIT, and record them in
  [CREDITS.md](CREDITS.md).

## Docs that go with a change

* **README:** update it when controls, modes, settings or `config.ts`
  sections change. Each drill's key list in the menus (`src/ui/drillInfo.ts`) and the
  in-game hints say the same things, so keep them in step.
* **PROGRESS.md:** log changes to the feel as a section: what was reported,
  the root cause, the fix and how you measured it. Add to **Decisions** when
  you make a call that someone would otherwise argue about again later.
* **Screenshots** in `docs/screenshots/` are real frames from the game: no
  paint-overs and no camera angles the game doesn't have. If your change
  alters how one of those moments looks, retake the shot
  (`scripts/shot.mjs` shows how to drive the game headless).

## Pull requests

1. Branch from `main` and keep each pull request to one change. Name the
   branch **`<type>/<short-description>`**, in lowercase with hyphens, with
   a type from the table below: `feat/setter-calls-the-pass`,
   `fix/crash-screen-input`, `docs/pr-conventions`.
2. Write commit messages and the pull request title as
   [Conventional Commits](https://www.conventionalcommits.org/):
   **`type(area): what the player notices`**, in plain words. The area is a
   drill, a system or a screen, in lowercase. Leave it out when the change
   has no single area.

   | Type       | Use it for                                              |
   | ---------- | ------------------------------------------------------- |
   | `feat`     | something new the player can do, see, hear or feel      |
   | `fix`      | something that was wrong and is now right               |
   | `perf`     | the same behaviour, running faster or smoother          |
   | `refactor` | code reshaped, with nothing changed for the player      |
   | `test`     | unit tests or the end-to-end run only                   |
   | `docs`     | the README, PROGRESS.md, this guide, screenshots        |
   | `ci`       | the GitHub workflows                                    |
   | `chore`    | tooling, dependencies, agent files and other housework |

   Examples, from the history, in this format:
   * `feat(rally): the setter calls the pass (HIGH! when out of system)`
   * `feat(start): compact layout for portrait phones`
   * `fix(crash): input stays with the crash screen, and the game goes silent`
   * `test(e2e): fresh pages no longer wait for frames an earlier phase left queued`

   For `feat`, `fix` and `perf` the description says what the player
   notices. For the other types it says what changes for the next
   contributor. Commits from before this rule start with `Area:` and have
   no type. Leave them as they are.
3. Fill in the [pull request template](.github/pull_request_template.md).
4. Keep the branch up to date by rebasing it on `main`: `git fetch origin`,
   `git rebase origin/main`, then `git push --force-with-lease`. Merge `main`
   into the branch only when a rebase is not possible, for example when
   someone else has built on your branch or you cannot force-push.
5. CI runs typecheck, tests and the build on every pull request, and it must
   be green. Never skip or delete a test to get there.
6. Vercel builds a **preview deployment** for every pull request. Share the
   link with someone who plays: it's the quickest way to find out whether it
   feels like the court.
7. A pull request is merged once CI is green, it has been reviewed and, for
   changes to the feel, someone has played the preview. GitHub deletes the
   branch when the pull request is merged, so start the next change on a new
   branch from `main`.

## License

Court Feel is [MIT licensed](LICENSE). By contributing, you agree that your
contribution is released under the same license.

## Code of Conduct

Everyone taking part follows the [Code of Conduct](CODE_OF_CONDUCT.md).
