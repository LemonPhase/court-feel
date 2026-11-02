# Court Feel — progress log

Read this first when resuming.

## Current milestone
M7 — AI teams, position selection, Mini Rally.

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

- **M3** Animated character with approach, jump, arm swing and IK.
  - `src/character/rig.ts`: 19-bone skeleton with anatomical proportions (shoulder 0.818H, eye 0.935H,
    arm 0.44H -> standing reach 2.47 m at 1.95 m), lofted skinned limbs/torso with blended joint
    weights, vertex-coloured kit (jersey, trim, shorts, knee pads, socks, shoes, hair styles).
  - `src/character/athleteView.ts`: procedural animator. Torso crouch/lean/twist; feet planted with
    stepping when idle, distance-driven gait (no sliding) when moving, two-step plant on jump load,
    body-relative tuck in the air, touch-down planting on landing; arms authored as wrist targets
    relative to the shoulders (ready, run swing, plant-back, double-arm swing up, bow-and-arrow cock,
    off-arm aims at the ball, Bezier whip to contact, follow-through across the body, block, platform,
    set, toss, land) solved with analytic two-bone IK; hitting hand IK-locked to the contact point;
    clavicle shrug; head look-at; FP view-model offsets so block/swing hands are visible.
  - Verified with side-on screenshot sheets (idle, run, plant, takeoff, cock, swing, contact, follow,
    land, block, pass) and FP sheets.

- **M4** Spike drill end to end with timing grades.
  - `src/game/contact.ts`: on click the swing starts immediately; the contact is scheduled at the
    predicted best moment (ball vs. the athlete's ideal contact point along its ballistic path),
    stretched/clamped to a 45–170 ms arm swing. Grade = click error (Perfect ≤30 ms, Good ≤70 ms,
    else Early/Late) downgraded for jump timing (contact below 72% of the jump) and reaching. Tap
    released before contact = tip (short) / roll shot (deep). Early sails long, Late drives into the
    net. Aim = camera yaw + pitch-mapped depth with a floor reticle. Air magnet + reach bonus scale
    with the aim-assist setting (0 disables both). Also pass/dig, set, block and serve-toss contacts.
  - `src/game/judge.ts` line judge (in/out, antenna, outside antennae, under the net).
  - Setter AI (reads the ball, gets under it, solved set to the hitter's lane), coach feeder,
    spike drill with target zones, score, streak and per-position lanes (OH 4, OPP red, MB 2, S
    attack-on-two, L pipe). HUD (grade popup, km/h, streak, score, key hints, crosshair), start
    screen with position + drill select, pause + settings panel, attract mode behind the menu.
  - `src/game/bot.ts` autopilot: plans the approach by forward-simulating the athlete's own
    kinematics, presses Space/LMB through the real input path. Perfect bot: 5/5 Perfect for every
    position; tip bot verified; sloppy bot produces Early/Late/Miss.

- **M5** Blocking and the block drill.
  - Block contact: hands volume above/over the net, extension ramps over 120 ms, penetrates
    further when airborne; grade from jump height fraction at contact (Perfect ≥ 88% → stuff,
    Good ≥ 66% → stuff/soft, else Early/Late → soft/tooled; feet on the floor = Late).
  - `src/ai/approach.ts`: the bot's simulation planner extracted for all AI hitters.
  - `src/ai/hitter.ts` (reads its set, simulated approach, shot choice line/cross/sharp/seam/tip
    steering away from blockers, skill-based timing error through the same contact system) and
    `src/ai/blocker.ts` (reads the set, shades the line, times the jump).
  - Block drill: opponent setter + OH/MB/OPP hitters + coach; scoring for stuff / soft block /
    tooled / hitter error / killed. BlockBot autopilot verified (stuffs MB and OH lanes), FP view
    shows your own hands over the net.

- **M6** Passing/digging, setting, serving.
  - Pass/dig (E): platform zone resolved at the ball's closest approach; graded on platform lead
    time (0.26 s ideal for serves, shrinking to 0.13 s for hard-driven digs) and centring; error to
    the setter target scales with grade and the position's ball control. Passes rated 0-3.
  - Set (RMB when the ball drops onto you from your side): hands zone at closest approach, graded
    on lead (0.18 s ideal); your gaze picks Outside / Quick / Back set.
  - Serve (Q toss, LMB hit): standing float (knuckles) or jump serve (topspin) when airborne; aim
    depth is "how deep into their court" so it works from the end line; floaters keep a tape margin.
  - Free Play ball machine (1-4: set / free ball / float serve / hard attack, F feed, T auto),
    Serve Receive/Dig drill (AI server + opponent attack at you, your setter and hitter finish),
    Setter Drill (three AI hitters vs one AI blocker, hitter highlighted by your gaze).
  - Pass/set autopilots verified: Perfect passes, Perfect sets to all three options, kills.

## Known issues
- Headless Chromium uses SwiftShader, so on-screen FPS in screenshots is not representative.

## Next steps
- M7 6v6 AI teams and the Mini Rally loop.

## Decisions
- Home/user team on +z facing -z; facing -z the right hand is +x. (One frame for everything.)
- No external art: quaternius.com / kenney.nl are blocked by this environment's network policy,
  and no CC0 pack ships volleyball-specific motions anyway, so the athlete is a procedurally
  built skinned mesh with code-authored poses + IK (see CREDITS.md). Logged per the tech-stack rule.
- Arm motion is authored as wrist positions + IK rather than joint angles: blends become spatial arcs
  and the contact-point IK falls out for free.
- Airborne body yaw is limited to ±0.35 rad from takeoff (the arm aims, not the hips); otherwise
  aiming cross-court mid-air swung the contact point away and made timing feel random.
- FP aim depth comes from pitch with a range that lets you look up at the ball (looking higher = deeper).
- Aim depth = depth into the opponent court (not distance from the hitter), so spikes and serves
  share one mapping and the reticle is always on their side.
- Zone contacts (pass/set) resolve at the closest approach, not first entry into the reach sphere.
- Back set (OPP) and quick (MB) are set a bit higher than elite tempo so they are reachable when
  reacting to the set; the MB quick is a "2" ball, not a "1".
- Key light nearly overhead (arena look, readable shadow under players, no floor hotspot).
- `PCFSoftShadowMap` was removed in three r187; using `PCFShadowMap` with shadow radius.
- Body yaw always follows camera yaw (both cameras): volleyball players face the play while
  shuffling, and it keeps the aim consistent.
- Ball drag Cd 0.26 (not 0.47): volleyballs at spike Reynolds numbers are past the drag crisis.
- Solvers integrate aerodynamics only; the live sim decides if the net gets in the way (honest physics).
- TP framing only dollies the camera, never rotates it, so the aim never moves without the mouse.
