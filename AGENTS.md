# Court Feel

A 3D volleyball feel sandbox that runs in the browser: TypeScript, Vite and three.js, client-only, no backend. Every change is judged against one principle, **true to the court**: would someone who has played on a real court recognise it? Fun but wrong is a bug. [README.md](README.md#the-principle) explains the principle and [CONTRIBUTING.md](CONTRIBUTING.md) is the full contributor guide. This file is the short version for coding agents.

## Commands

```bash
source ~/.nvm/nvm.sh && nvm use   # Node 22 (.nvmrc). The default shell may be on another version.
npm ci                            # when node_modules is missing or package-lock.json changed
npm run dev                       # http://localhost:5173
npm run check                     # typecheck, lint, format check, unit tests. Run before every commit.
npm test                          # unit tests only (Vitest, tests/)
npm run format                    # fix formatting with Prettier
npm run e2e                       # every drill in headless Chromium, several minutes, writes scripts/out/
```

Run `npm run e2e` when a change touches a drill, the autopilots, input, touch controls or the menus. First time: `npx playwright install chromium`.

## Show it working in the app

Passing tests do not prove a change to the game, its menus, HUD or controls. Drive the real app and capture evidence with the verification skill: read [.agents/skills/verify-court-feel/SKILL.md](.agents/skills/verify-court-feel/SKILL.md), then the feature map in its `features/` directory. When a change adds or alters user-facing behaviour, update the matching feature file in the same pull request.

## Rules the tools do not enforce

- **Every tunable number lives in `src/config.ts`**, in its section, with a doc comment when the name does not say what it is. No magic numbers in game code, so the feel can be tuned in one place.
- **`src/physics/` stays pure**: no three.js scene, no DOM, only `config`. That keeps it deterministic and testable.
- **All input goes through `Input`** (`src/core/input.ts`). Keys, mouse, touch and the autopilots share that path, so timing windows are identical everywhere. Do not add a side door.
- **Assist may help the player's body, never the ball**, and it must be fully off at 0.
- **A change to physics, timing, contacts or AI decisions comes with a unit test that states the real-court fact**, for example "the middle leaves the floor on the setter's touch".
- **Units and frame:** metres, seconds, kilograms, radians. Y is up, the net is the plane z = 0, the home team plays on +z facing -z.

## Before changing a mechanic

Read the **Decisions** list at the end of [PROGRESS.md](PROGRESS.md) and search it for the mechanic. The reason it works the way it does is usually written there. Then check the change against [the court test](CONTRIBUTING.md#the-court-test).

## Docs that move with a change

- README: controls, modes, settings and `config.ts` sections. The start screen's key list (`src/ui/menu.ts`) and the in-game hints say the same things, so keep them in step.
- PROGRESS.md: a section for each change to the feel (what was reported, the cause, the fix, how it was measured), and a line in Decisions for a call someone would otherwise argue about again.
- `docs/screenshots/`: real frames only. Retake a shot when the moment it shows changes.

## Git

- Branch from `main`. One change per pull request. Fill in `.github/pull_request_template.md`.
- Name the branch `<type>/<short-description>`, in lowercase with hyphens: `feat/setter-calls-the-pass`, `fix/crash-screen-input`. If your tool will only push to a branch it named itself (`claude/…`, `cursor/…`), keep that name.
- Commit and pull request titles are Conventional Commits, `type(area): what the player notices`, in plain words: `feat(rally): the setter calls the pass (HIGH! when out of system)`. The types are `feat`, `fix`, `perf`, `refactor`, `test`, `docs`, `ci` and `chore`. [CONTRIBUTING.md](CONTRIBUTING.md#pull-requests) says when to use each.
- Update a branch by rebasing it on `origin/main` and pushing with `--force-with-lease`. If the rebase or the force-push is not possible, merge `main` in and say so in the pull request.
- GitHub deletes a branch when its pull request is merged. Start the next change on a new branch from `main`.

## Boundaries

- **Always:** run `npm run check` before committing, and verify user-facing changes in the app.
- **Ask first:** anything that changes how the game plays (timing windows, physics constants, controls, AI decisions, a new drill or mechanic), a new dependency, and any art or audio asset. Assets need an MIT-compatible licence and an entry in [CREDITS.md](CREDITS.md).
- **Never:** skip, weaken or delete a test to get CI green, or commit directly to `main`.

## Agent conventions

Keep agent workflow files generic where possible, so every coding agent can use them:

- Project instructions go in this file, not in `CLAUDE.md` or another tool's equivalent.
- Skills go in `.agents/skills/<name>/SKILL.md`. `.claude/skills` is a symlink to that directory so Claude Code registers the same skills. Do not put real files under it.
- If a tool or plugin tells you to write to its own directory (`.claude/`, `.cursor/` and the like), use the generic location and add a symlink only when the tool cannot read it otherwise.
- Helper scripts under `.agents/` are linted and formatted like `scripts/`.
