# Court Feel — progress log

Read this first when resuming.

## Current milestone
M3 — animated character.

## Done
- **M1** Court, lighting, camera, FP/TP toggle, capsule movement.
  - Vite + TS + three r187 scaffold, `src/config.ts` holds every tunable.
  - Fixed 120 Hz simulation with render interpolation (`Game.advance`), hit-stop and time-scale hooks.
  - Arena: procedural maple floor (colour + roughness map, painted free zone), regulation lines,
    net with mesh texture, top/bottom/side bands, antennae, padded posts, referee stand,
    LED boards, tiered stands with ~2.5k instanced crowd sprites (1 draw call, shader bob),
    hanging scoreboard, PMREM-baked environment for floor sheen.
  - Camera rig: FP (eye anchored, no roll) / TP (orbit, spring-smoothed pivot, net/post
    occlusion test, ball framing dolly). Shared yaw/pitch so V keeps the aim direction.
  - Athlete kinematics: accel/decel-limited ground movement, direction-dependent top speed,
    Space = plant/load (hold to load), release = takeoff, apex hang, landing recovery.
  - F3 debug overlay skeleton.
  - Verified by Playwright screenshots (TP, FP, side) and a scripted approach jump (0.80 m).

- **M2** Ball physics with fixed timestep + tests.
  - `src/physics/ball.ts`: gravity, quadratic drag (Cd 0.26), Magnus (w x v, Cl capped 0.4), spin decay,
    float-serve knuckle wobble, floor restitution with friction/spin coupling (hollow-sphere inertia),
    soft net body, stiff top tape (let-serve rolls), antennae, padded posts, LED boards, walls, ceiling.
    Speed-based sub-stepping so a 35 m/s ball never tunnels the net.
  - `src/physics/predict.ts`: deterministic look-ahead with the same step (landing, apex, net crossing,
    descend-through-height queries). `src/physics/solve.ts`: fixed-time, apex and fixed-speed solvers.
  - Ball entity: interpolated position, spin-driven visual rotation, timing-cue blob shadow, shrinking
    landing ring, F3 trajectory gizmo. 17 vitest tests (set apex, spike landing, topspin dip, net,
    tape, antenna, women's net, floor bounce, determinism, 120 vs 480 Hz, predictor == live sim).

## Known issues
- Headless Chromium uses SwiftShader, so on-screen FPS in screenshots is not representative.

## Next steps
- M3 rigged character, procedural animation, IK.

## Decisions
- Home/user team on +z facing -z; facing -z the right hand is +x. (One frame for everything.)
- No external art: quaternius.com / kenney.nl are blocked by this environment's network policy,
  and no CC0 pack ships volleyball-specific motions anyway, so the athlete is a procedurally
  built skinned mesh with code-authored poses + IK (see CREDITS.md). Logged per the tech-stack rule.
- `PCFSoftShadowMap` was removed in three r187; using `PCFShadowMap` with shadow radius.
- Body yaw always follows camera yaw (both cameras): volleyball players face the play while
  shuffling, and it keeps the aim consistent.
- Ball drag Cd 0.26 (not 0.47): volleyballs at spike Reynolds numbers are past the drag crisis.
- Solvers integrate aerodynamics only; the live sim decides if the net gets in the way (honest physics).
- TP framing only dollies the camera, never rotates it, so the aim never moves without the mouse.
