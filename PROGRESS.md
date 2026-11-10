# Court Feel — progress log

Read this first when resuming.

## Final summary
All ten milestones are done. Court Feel is a browser volleyball feel sandbox (TypeScript + Vite +
three.js r187) with six drills (Free Play with a ball machine and serve practice, Spike, Block,
Serve Receive/Dig, Setter, 6v6 Mini Rally), five positions, instant FP/TP switching, a 120 Hz
deterministic ball simulation, procedurally built and animated athletes with IK, graded timing
(Perfect / Good / Early / Late) with buffering and adjustable assist, a full juice package
(hit-stop, shake, streak sparks, fire trails, shockwave, dust, floor cracks, hand flashes,
slow-mo cinematic replay), synthesised Web Audio, AI teammates/opponents, and test tooling (55
unit tests + a Playwright e2e that plays every drill through the real input path).

### Acceptance criteria
- [x] **All 6 modes playable from a start screen with position select** — start screen with
  position cards + drill cards; e2e runs every drill with autopilots (no console errors).
- [x] **FP/TP toggle instant, mid-rally, no glitches** — shared yaw/pitch; FP view-model re-poses on
  the toggle frame even during hit-stop; TP pivot snaps; net/post occlusion test, occluders fade.
  Verified with a toggle sequence mid-rally (screenshots).
- [x] **Perfect spike triggers the full effects package in both cameras** — 70-105 ms hit-stop
  (longer the harder it was hit), FOV punch, shake, ball squash, spark burst, shock ring, fire
  trail, chime, shockwave + dust ring + crack decal + floor slam on impact, crowd surge, slow-mo
  replay. Screenshots: `scripts/out/10-15_*` (TP, FP, replay).
- [x] **Believable animation** — approach (run, step-step-plant, arms back), takeoff double-arm
  swing, bow-and-arrow, whip with hand IK onto the ball, follow-through, land absorb, block, pass,
  dig, set, serve toss; planted feet; head look-at. Side-view screenshot sheets checked.
- [x] **Realistic ball physics** — set apex, spike landing, topspin dip, net/tape/antenna, women's
  net, floor bounce, determinism and predictor tests; arcs and spike speeds (25-30 m/s) at 1:1 scale.
- [x] **60 fps target, no console errors, all tests pass** — 55/55 tests; e2e: no console errors;
  CPU frame median ~4.6 ms (p95 ~12 ms, from set-time AI planning) with 86 draw calls / 107k
  triangles; adaptive quality governor (MSAA → render scale → shadow size) protects weaker GPUs.
  No memory growth: 0 geometry/texture growth across repeated mode switches, JS heap flat over a
  300 s rally with forced GC (23.9 → 24.6 MB), 600 s soak clean. (GPU frame time cannot be
  measured in this headless SwiftShader container; see Known issues.)
- [x] **README** — controls, modes, how to run, how to tune (config sections), testing.
- [x] **PROGRESS.md** — this summary, the milestone log, decisions and ideas for later.

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

- **M7** AI teams, position selection, Mini Rally.
  - `src/ai/team.ts`: `TeamAI` coordinator per side (formations for receive / defense / offense,
    sticky first-ball receiver chosen by time-to-reach with libero priority and the user's zone,
    setter call biased 60% to the user when they are a front-row hitter, bad pass → high outside
    ball, wings/middle block only in their zone, free ball over on a failed third contact, touch
    counting with blocks excluded, four-touch fault). `TeamPlayer` executes jobs with the
    setter / hitter / blocker / server brains.
  - Mini Rally: 6v6, user in their chosen slot (OH→OH1, OPP, MB, S, L), AI serves, point banners
    with reasons (ace, kill, your kill, blocked, out, antenna, under the net, four touches),
    score, "Your ball!" cue (green landing marker), set-to-you cue, contextual hints.
  - 400 s all-AI soak: 31 points, 5.8 touches/point (max 12), 14 digs, 9 blocks, 5 tips, 16-16.
    With autopilots in the user's seat: libero passes, setter sets, middle 8/8 Perfect spikes.
  - AI attackers read the net (hit deeper/softer from low or deep contacts); users get honest physics.
  - Rally continuity pass: AI blockers lower their hands as soon as they land (a block action used
    to linger for seconds and pin the player to the blocker brain, so tips and deflections dropped
    behind them and front-row hitters never transitioned to attack); a ball off a team's own block
    is assigned a receiver (preferably not the blocker); receivers account for airborne / landing
    players, turn and run instead of backpedalling, sprint when a shuffle would be late, dig balls
    already under platform height where they land, and re-pick when the ball strays off the tape; a
    second ball the setter cannot run down is bumped by the closest player (decided once per ball);
    a set the hitter never went for is kept in play; stale unresolved set actions are dropped.

- **M8** Effects and audio (everything in "Juice").
  - `src/fx/particles.ts`: GPU velocity-aligned streak sparks (instanced, additive HDR) and soft
    sprite pools (dust, glows); `src/fx/trail.ts`: camera-facing ribbon, clean white-blue for normal
    spikes, flickering HDR fire for Perfect, faded near the lens; `src/fx/effects.ts`: event-driven
    director scaling everything by timing quality: Perfect spike = 70 ms hit-stop, shake, spark burst
    along the ball's new direction, fire trail, chime, shockwave + dust ring + floor crack decal and a
    heavy boom on impact, crowd surge, then a slow-mo (0.32x) replay from a broadcast side angle that
    glides to a low impact view (letterboxed, any key skips, events and pitched-down audio replayed).
    Normal spike = lighter white trail + solid thwack. Block = hand flashes on both palms, spark spray,
    shake, slap + boom on stuffs, 50 ms hit-stop for your stuffs. Dig/pass = dust puff + thud + crowd.
    Landings, takeoff squeaks, footsteps.
  - `src/audio/audio.ts`: all synthesised (Web Audio): thwack layers, sub boom, crack, pass thud,
    finger-set taps, block slap, floor thuds, net rustle, antenna tink, sneaker squeaks, footsteps,
    landing, two-tone whistle, Perfect chime, pink-noise crowd bed that swells with tension, cheers
    with formant wobble and claps; generated convolution reverb for the arena.
  - Bloom picks up only HDR effect colours (threshold 1.0). Smoke-tested every sound path (no errors).

- **M9** Feel and polish.
  - FP eye: follows crouch/landing dips, filters head sway to `CAMERA.fpBobScale`; TP camera snaps on
    teleports (no swoosh across the court); athletes standing in the TP camera's way fade out.
  - FP aim range tuned so looking at the ball gives a mid-court shot; trail fades near the lens; your
    own block flash is small in FP (it washed the screen white).
  - Arena static meshes merged (stands, trusses, screens, banners by colour) to cut draw calls.
  - Mode teardown disposes textures (floor-ring textures leaked one per drill start).
  - 19 more unit tests (36 total): per-position jump heights and hang time, acceleration/no
    snapping, centre line, predictAir, aim mapping, line judge, and timing grades through the real
    contact system (0 ms → Perfect, ±50 ms → Good, ±100 ms → Early/Late, wild → Miss, tap → tip).
  - `npm run e2e`: Vite + headless Chromium, every drill with the autopilots, FP/TP screenshots,
    console errors, frame time, draw calls and a soak. First run: no console errors; spike drill
    5/5 positions Perfect; CPU frame median 5.4 ms / p95 12.6 ms; heap flat.
  - Approach GO cue (the drill plans your ideal approach with the AI planner and pulses the ring when
    a perfect approach would start), jump-load ring meter, higher outside/opposite/pipe sets and
    closer lane starts so there is a learnable set-then-go beat.
  - Free Play feed 5: serve practice behind the end line with target zones.
  - Intervening touches cancel a spike's impact package (no cracks/replay for blocked spikes).
- **M10** Performance and robustness.
  - Quality governor: below ~50 fps on average it steps down MSAA, then render scale, then shadow
    resolution. Ideal-contact search made O(n); approach planner trimmed (3.5 ms per set).
  - Merged static arena meshes: 119 → 86 draw calls. Composer sized at start-up.
  - Leak checks with forced GC: zero GPU resource growth per mode switch; heap flat over long
    rallies; disposal fixed for drill floor rings and net-height toggles. WebGL context loss handled.
  - Production build (`npm run build`, 780 kB JS / 213 kB gzip) checked under `vite preview`.

- **Playtest round 1** (feedback from the first hands-on session).
  - *Black flash on contact*: the rep reset cut the screen to black; replaced by the athlete
    jogging back to the start spot (snap with a soft dip only if it takes too long). Also added a
    NaN/Inf sanitize pass before bloom, capped point-sprite size, kept the FP arm out of the near
    plane (lens clearance + 0.22 m FP near plane), and the quality governor now resizes before render.
  - *Audio "cutting off" at high frequency*: the master compressor pumped the crowd hiss on every
    hit. New mix: limiter on SFX only, crowd bypasses it, tanh soft clip on the master, smoother
    reverb tail, lower bright-band gains. Offline render: peaks 0.16-0.34, 0 clipped samples, crowd
    bed RMS identical before/after a spike.
  - *Outside sets too far inside*: OH/OPP now hit at the pins (x = -4.05 / 4.0, ~0.5 m inside the
    antennae) from approach starts outside the sideline; blockers and formations moved out to match.
  - *Middle too slow*: real first-tempo quick. The middle runs on the pass and leaves the floor as
    the setter touches the ball; the set is solved for a fixed flight time to where the hitter's hand
    will be at the top of the jump (`quickSetFor`, `predictJump`, `planQuick`). If the middle is not
    up the setter goes elsewhere (AI) or the quick comes late. AI middles act as decoys when the set
    goes wide; the block drill middle has to commit-jump with them. Rally probe: MB takeoff within
    0-20 ms of the setter's touch, contact ~0.42 s after the set.

- **Hold-to-charge spike** (playtest round 2). The attack button is now press-hold-release:
  pressing starts a wind-up (hitting arm draws back, chest turns, a ring around the crosshair fills),
  power builds with the hold (`TIMING.chargeFull` 0.32 s for full; a hold just past a tap gives
  `CONTACT.chargePowerMin` = 70% speed), and releasing starts the swing, which meets the ball at the
  best moment it can still reach. Timing is graded on the release (same windows as before). A hold
  shorter than `TIMING.tapThreshold` is a tip/roll; landing without releasing drops the wind-up.
  Perfect timing: tap = tip 32 km/h, 0.1 s = 78, 0.2 s = 99, 0.32 s+ = 108 km/h. The full Perfect
  effects package needs at least half charge. Applies to serves too. AI hitters wind up early in the
  jump (middles before the quick arrives, so decoys land with it dropped). Full-charge tick and a
  release swish in the audio; the grade line shows the power.

- **Playtest round 3.**
  - *Middle shots*: AI middles only hit the deep corners (zone 1 / zone 5), steering away from the
    block; the spike drill's targets for a middle are zone 1 and 5. The drill's line/cross zones are
    now mirrored for right-side attackers (they were absolute, so an opposite's "line" was cross).
  - *Hit sound follows power*: the spike/serve sound is driven by the outgoing ball speed (12 m/s =
    0, 30 m/s = 1): hand slap and body thump always, a leather crack on real swings, and above ~30%
    a deep pitch-dropping boom (through a saturator so it carries on laptop speakers) with more arena
    reverb. Offline: peak 0.06 soft -> 0.30 full, ~24x the low-end energy, no clipping. Quieter
    with distance from the camera.
  - *Set calls in the spike drill (keys 1-3)*: OH high / go / inside 3 ball; MB 1 / shoot (31) /
    back quick; OPP back set / fast back / back 2 (`SET_PLAYS` in plays.ts). Quicks reuse the
    adaptive quick (offset along the net from the setter, negative = behind); tempo balls (apex less
    than 1 m above contact) plan the approach and the GO cue from the pass with the setter's solved
    arc. Bot probe: all nine calls Perfect; middles take off within ~15 ms of the setter's touch.

- **Playtest round 4: more forgiving late releases.** Full-power swings released a touch late were
  graded Late. Three changes: (1) the grade window is asymmetric, Perfect -30/+70 ms and Good
  -70/+110 ms around the ideal release (`spikePerfectLate`, `spikeGoodLate`); (2) a fully drawn arm
  swings through in 0.09 s instead of 0.1 s (`swingCharged`), so its ideal release is 10 ms later;
  (3) late releases are measured against the real closest approach the wind-up tracked, not the
  start of the forward search window (which clamped every late release to about +78 ms).
  Full charge, by release time before contact: -170 ms Early, -150..-130 Good, -120..-25 Perfect
  (was -130..-70), -20..+20 Good, +30..+50 Late, +70 Miss.

- **Playtest round 5: block drill base and FP at the net.**
  - Every block rep starts at the net in front of their middle (their quick spot, `BASE` in
    blockDrill.ts), not at a per-position spot (the outside blocker started left of their setter).
    The hitter your position blocks in a match gets 45% of the sets. The jog back between reps
    always runs and now arrives within 0.1 m (was 0.3 m, and skipped within 0.6 m).
  - FP at the net: the eye follows the feet (0.22 m from the centre line at the closest) and the lens
    sat 0.09 m ahead of it, inside the 0.22 m near plane's reach of the net, so the net and tape were
    clipped away and you seemed to look from their side. The FP lens now never gets closer to the net
    plane than near plane + 0.1 m (`CAMERA.fpNetGap`).
  - Test bot: once it starts a quick run it sees it through to the landing (the "pass to our setter"
    read can drop out just before the touch, and resetting there let go of the plant and the
    wind-up). 4-minute rally as middle: 12/12 Perfect quicks.

- **Juice pass: a Perfect, full-power spike should feel (and sound) like one.** Playtest note: the
  hand contact and the floor impact were still not "boom" enough.
  - *Hit sound* (`AudioEngine.spike`), all continuous in the ball speed: a sub-10 ms leather crack,
    the hand slap, a fast-dropping 340 -> 120 Hz "pop" (the part of the boom laptop speakers can
    play), the body thump, and above ~25% power a 120 -> 33 Hz boom, a 240 Hz "whump" band, air
    pushed out of the ball, a falling whoosh as a fast ball rips away and an arena slap-back.
    Layers start a few ms apart so their peaks don't stack. A full swing's release whoosh now
    swells upward into the contact.
  - *Floor slam* (`AudioEngine.floor(impact, slam)`): `slam` 0..1 comes from the attack's speed
    (it was a heavy/not-heavy flag, so 26 and 30 m/s spikes sounded the same): leather slap on the
    hardwood + crack, two short floor "knock" modes, a low thud, a whump of air, and above ~30% a
    room boom with rumble. Ordinary bounces are unchanged.
  - *Mix*: the boom bus saturator now spans its whole input range (tanh, drive 3.4, then a
    1.1 kHz lowpass); before, its input went past +-1 and was hard-clipped into a square-ish buzz.
    New early-reflection bus (83 / 151 / 236 ms taps, darkening, panned) that only hard hits feed.
    Bigger reverb sends on the boom layers. Limiter / crowd routing untouched.
  - *Offline measurements* (`OfflineAudioContext`, master 0.8, crowd muted for the per-sound
    numbers; before -> after). Full-power spike: peak 0.66 -> 0.67, RMS(0-300 ms) 0.161 -> 0.251
    (+3.8 dB), 100-300 Hz punch 0.238 -> 0.374 (+3.9 dB), sub < 90 Hz 0.090 -> 0.133 (+3.4 dB),
    1-5 kHz crack 0.035 -> 0.048 (+2.6 dB), arena tail (0.4-1.2 s) 0.005 -> 0.016 (+9.8 dB). Soft
    swing (power 0): RMS 0.028 -> 0.032 (a soft hit stays soft). Floor slam of a 30 m/s spike:
    peak 0.64 -> 0.58, RMS 0.127 -> 0.297 (+7.4 dB), sub +8.3 dB, punch +4.6 dB, slap (1-5 kHz)
    0.010 -> 0.039 (+12.1 dB), tail +10 dB; 19 / 26 / 30 m/s slams now 0.088 / 0.213 / 0.297 RMS
    (were 0.067 / 0.127 / 0.127). Whole Perfect sequence with the crowd (contact + chime + slam):
    peak 0.74 -> 0.70, 0 clipped samples (|x| >= 0.99), crowd bed RMS 0.0055 before and 0.0044
    after the hit, identical to a crowd-only render, and render(hit + crowd) - render(crowd) -
    render(hit) = 5e-8 RMS (a linear mix: nothing ducks or pumps). Replay (rate 0.55): peak
    0.72 -> 0.74, 0 clipped.
  - *Animation* (`athleteView.ts`): the wind-up draws a deeper bow with the charge (chest turned
    further, back arched, heels pulled up and back); the swing is a kinetic chain (hips open first,
    chest follows, then the arm); the arm whips through a "lag" pose (elbow drives up and forward
    while the hand still hangs behind the head) on a cubic path with a late ease; the wrist is
    cocked back in the wind-up and snaps over the ball through contact; the off arm pulls down
    first; a full-power follow-through finishes by the opposite hip with the body folded
    (jackknife: spine flexes, knees snap up in front) and is held until landing. Fixed: after the
    follow-through the hitting arm used to go back up to the cocked pose while still in the air
    (new test).
  - *FX / camera*: Perfect hit-stop 70 ms + up to 35 ms at full power (105 ms at 108 km/h); FOV
    punch-in (4.5 deg TP, 55% of it in FP) that holds on the freeze frame and springs back with a
    small overshoot; a camera nod along the spike; the ball squashes ~26% along the hit direction
    (held through the freeze, then wobbles back) and ~22% on the floor slam; a thin shock ring in
    the air square to the ball's new path; ~30% more, faster sparks. Floor slam of your own
    Perfect: a fast inner ring, a short flash on the boards, wood chips, a vertical camera jolt and
    a 35 ms freeze. All sized/dimmed by camera distance; the punch and kick follow the camera
    shake setting (0 turns them off). Tried and dropped: an extra HDR flash on the hand (it
    bloomed into a white disc that hid the squashed ball, and in FP into a screen-wide haze).
  - Tests: 55 (camera punch holds while frozen and settles, the kick's size, shake 0 disables both;
    the spike animation: hand on the ball at contact, no re-cocking in the air after the hit).

- **Playtest round 6: the setter calls the pass.** Note: calling a quick / go in the Mini Rally,
  you sometimes got a high ball instead, with no way to tell in time (a dig looks in system until
  it isn't). Cause: `TeamAI.callSet` judged "out of system" only at the instant of the set, from
  where the setter stood, and silently swapped a fast call for a high ball.
  - The setter now reads every pass `AI.setterRead` (0.2 s) after it is played: where they will
    take it (the ball's predicted point at their touch height) against `AI.outOfSystem` (1.6 m from
    their spot). The read is the decision (`TeamAI.read`), and `callSet` follows it: in system your
    call stands; out of system everything goes up high and the quick is off entirely (before, an AI
    middle kept a 5% quick and a user middle who jumped still got one); `help` when the setter
    cannot get there and someone else bumps it. Re-read only if the ball is knocked off its path
    (tape / net), and only ever downgraded.
  - Shown to hitters (OH, MB, OPP): a speech bubble over the setter's head (`Hud.call`, projected
    every frame; pinned to the screen edge with an arrow when they are off screen, above the thumb
    buttons on touch screens): **HIGH!** out of system, the call confirmed (**GO!**, **1!**...) in
    system when it needs the good pass, **HELP!**. The key hint says the same. Voiced by a
    formant-synthesised shout (`AudioEngine.shout`: a sawtooth through three bandpass formants
    gliding "ah" -> "ee" for "high"); levels next to the whistle (peak 0.15, RMS 0.055): high
    0.27 / 0.044, go 0.17 / 0.034, help 0.20 / 0.040. Dry formant peaks: high 700 / 1175 Hz ->
    400 / 2100-2300 Hz.
  - Found on the way: a perfect pass is not "coming to us" by the floor test (left untouched it would
    drop at the net), so the read must not be gated on it.
  - Measured over 4-minute rallies (OH and OPP calling the fast set, MB): every home set followed a
    read made on its pass; the call came 1.1-1.4 s before the setter's touch; called fast sets in
    system arrived 0.42-0.46 m above the contact height (as called); no quick out of system.
  - Tests: +4, 89 in all (a stand-in Game drives the real team coordinator: a pass to the target is called in
    system once, 0.2 s after the pass; a pass 2.6 m off the net is called high; a called go is fast in
    system and a high ball out of system; the setter running down a bad pass keeps the high call).
- **Production hardening** (from a code audit: the game is now played by a whole club).
  - *Untrusted inputs*: quick-start links (`src/core/launch.ts`) and stored settings
    (`sanitizeSettings` in `src/core/settings.ts`) are validated. A mistyped `?pos=` used to throw
    on load and leave a screen with no menu; a stored setting of the wrong type threw in the
    settings panel and put a string into the camera FOV. Slider ranges moved to `SETTING_RANGES`
    in config (the panel and the loader share them). Menu restore uses own-key guards.
  - *Errors*: `ErrorReporter` (`src/core/errors.ts`) + crash screen (`src/ui/crashScreen.ts`). The
    render loop catches frame errors: a one-off is reported and play goes on, 10 failing frames
    in a row stop the game and show the crash screen (Reload / Copy details). Start-up failures
    (no WebGL) get the screen too. Event-bus listeners are isolated (an FX/audio bug no longer
    aborts the simulation step). Optional `VITE_ERROR_REPORT_URL` sends reports. The build
    (version + commit, injected by vite.config.ts) is shown in the menus and in reports.
  - *Accessibility*: Input only swallows Tab / Space / arrows during play (they were blocked in the
    menus too, so menus could not be used from the keyboard); cards expose `aria-pressed`, focus
    moves to the pause / settings panels and back; Enter on a card plays (once). Reduced motion:
    first-visit defaults without shake and auto replays, still menu camera, no CSS animations.
  - *Robustness*: hidden tab suspends audio and pauses play; audio set-up failure no longer retries
    (and leaks a context) on every key press; resume() rejections are caught.
  - *Tooling*: LICENSE (MIT), Node 22 pinned (`.nvmrc`, `engines`), ESLint (typescript-eslint
    recommended, clean) and Prettier (width 140; CSS and Markdown left hand-formatted), vite config
    and Node-side typecheck, `npm run check`. The bot reads drill state through one typed
    `DrillView` instead of `as any`, and its approach planner no longer runs a wasted simulation.
  - *Verification*: the e2e asserts (drill contacts and grades, rally points, distinct set-call
    plays, replay start, touch controls, robustness probes, keyboard capture, GPU resources flat
    over the soak) and runs in CI as its own job with the screenshots as an artifact. New unit
    tests for settings / launch validation, the reporter and event isolation.

- **Playtest round 7: our own serve.** Notes: in the Mini Rally the setter shouted **HIGH!** on
  every one of our serves; a serve that hit the net and dropped back could be played on and over;
  and after serving, the front row ran off the net as if to attack, then came back to block.
  - Cause: `TeamAI` treated the serving team's own serve as its first touch (`touches` = 1), so
    while it flew the team ran its "second ball" logic: the setter read the serve as a pass (always
    far off their spot, so "out"), went to set it (and did, off the net), and the team switched to
    the offense formation with the hitters walking to their approach starts until the other side
    passed.
  - Fix (`src/ai/team.ts`): our serve in the air is its own state. It is not one of our touches,
    nobody is sent to play it, and the team settles into base defence (front row at the net to
    block) while the server walks in. Any touch on it by the serving team, the user included,
    before the other side has played it is a service fault (`TeamAI.serveFault`); the Mini Rally
    gives the point away as **SERVE FAULT**. A serve that hits the net and drops back or under it
    is called **SERVE IN THE NET** (was BALL DOWN / UNDER THE NET).
  - Measured in the browser (all-AI rally, both sides serving): the front row stays 0.7 m off the
    net from the serve to the receiving team's pass (was backing off to 2.8-3.7 m), jobs `base`
    only (was `attack`); 0 setter calls over 30 home serves (was one per serve); 16/16 forced net
    serves called right on both sides (left alone: SERVE IN THE NET, dug up by the serving team:
    SERVE FAULT, the point to the receiver every time, no AI touches). A 300 s soak scores the same
    as before the change, with no console errors.
  - Tests: +8, 123 in all (`tests/serve.test.ts`, for both sides: the serve is not a touch and gets
    no setter call; base defence while it flies; a net serve is left alone and touching it is a
    fault; after the other side plays it our touches are ordinary).
- **Playtest round 8: when the setter digs** (#23). Notes: after the setter digs, he still runs
  to set it; the libero then sets from the net, even a go to the pin, which a libero can't do;
  and does the libero bump or hand-set inside the 3 m line?
  - Cause: the second-ball logic in `TeamAI.step` handed the libero the setter's whole job: the
    read judged against `SETTER_SPOT` (a dig to the setter target read **in** system) and `callSet`
    offered everything, the user's fast call included. The setter got no job for that ball, so
    the offense formation sent him to `SETTER_SPOT`. Every first ball, the setter's own dig too,
    was aimed at `SETTER_TARGET`, and the AI libero always hand-set (`SetterBrain`), with no 3 m
    line check. With the user as the libero nobody was assigned at all.
  - Fix: a setter who played the first ball goes back to his defence spot. His dig goes high to
    the middle at the 3 m line (`BACKUP_TARGET`: 0.5 m right of centre, 3.4 m off the net, apex
    5.2 m; `TeamAI.firstBallTarget`). The libero backs up: the read is always **out** (shown as
    **LIBERO: HIGH!**), and the set is a high ball to a pin (+`AI.outOfSystemApex`), with no quick,
    no pipe and the user's go / fast back going up high. `handSetAllowed`: a libero hand-sets only
    from behind the 3 m line (the line is the front zone), and in front of it the AI libero
    bump-sets (`SetterBrain.bump`: platform height, forearm-pass pose, still a set for the
    hitters). The user as the libero gets the ball (`TeamAI.secondBy`): "Your set!", the green
    marker, a hint, and high-ball set options only.
  - Measured in the browser by injecting a down-ball at the setter (right back) during live
    all-AI rallies, before -> after (12 digs): the setter's closest approach to `SETTER_SPOT`
    0.04-0.08 m -> 5.8 m; the libero's second ball 0.67-0.83 m off the net, read `in` -> a hand
    set 3.1-3.4 m off the net, read `out`; pin sets +1.65 / +1.55 m above contact -> +2.05 /
    +1.95 m, attacked by the AI hitters. A dig forced to 2 m off the net: 10/10 bump sets 1.2-2.2 m
    off the net, high, attacked. User OH calling a go: the libero's set to them 0.45 m -> 2.05 m
    above contact, HIGH! instead of GO!. User libero: 0/4 -> 4/4 second balls assigned to the
    user with the cue, no AI sent. A 300 s all-AI soak (no setter digs in it) scores exactly as
    before, with no console errors.
  - Not done: a user libero hand-setting in front of the 3 m line isn't judged yet (#23's open
    question: a fault when the hitter attacks above the net, or RMB becomes a bump set there).
  - Tests: +6, 137 in all (`tests/setterCall.test.ts`: the dig target; the setter goes back to
    defend and the libero sets; out of system, a called go goes up high; pins only, no quick or
    pipe; `handSetAllowed`; the user libero's ball).

## Known issues
- This container renders with SwiftShader (software GL, ~1 fps), so GPU frame time at 1080p on a
  real laptop could not be measured here. CPU-side frame time, draw calls and triangle counts are
  well within a 16.7 ms budget, and the quality governor degrades gracefully if the GPU is slow.
- Pointer lock can be refused in some embedded browsers; if it never works, the game falls back to
  drag-to-look (see "Pause and pointer lock" below for refusals after it has worked).
- Athletes don't physically collide with each other (AI spacing keeps it rare).
- No rotation in the Mini Rally: positions are fixed slots (a sandbox, not a match).

## Ideas for later
- Real rotations and libero substitutions in the rally; a full scoring mode.
- Approach paths with curved slide / broad-jump attacks for middles and opposites; back-row D/pipe.
- Jump-set and setter dump decisions for the AI; AI blockers that commit on quicks; slides; AI
  teams using the go / shoot / back-quick calls in rallies.
- Dive / sprawl animations for desperate digs; overhead (hands) passing of free balls.
- Ghost replays of your best spike, and a "timing trainer" overlay that shows your click history.
- Per-player handedness (lefties), body-type variety, jersey numbers and names.
- Gamepad support with analogue approach speed and trigger-pressure for power.
- Tunable difficulty presets for the AI and assist; accessibility options (colour-blind cues).
- Audio: stereo panning by position, crowd chants, PA announcer stingers.
- Mobile/touch layout.

## Next steps
- `main` holds the current playable build (all playtest rounds merged). If resuming: pick from
  "Ideas for later" or the next round of playtest notes.

## Touch controls (phones / tablets)
- The game was unplayable on a phone: no pointer lock, so no look, and taps turned into emulated
  mouse clicks. Now `src/core/touchPad.ts` (pure model, unit tested) turns touches into the same
  Input codes and look deltas the keys and mouse produce, so every contact / timing / buffer rule is
  untouched. `src/ui/touchControls.ts` is the overlay: floating joystick (left), aim by dragging
  (right), hold buttons JUMP / HIT / BLOCK-or-SET / PASS (+ TOSS in Free Play), pause / camera /
  reset, and the drill's set calls or feed types as chips. HUD hints and messages name the buttons.
- Design, in one line: the left thumb is the feet, the right thumb is the arm and the eyes.
  - Stick deflection is analog speed; pushing it to the ring is the approach (Shift), with hysteresis.
  - Every held button also aims once the thumb travels past a small dead zone, so you wind up
    and aim with one thumb like LMB + mouse.
  - While loading or in the air the whole right half of the screen is HIT (the thumb that just
    released JUMP is already there), and rolling the thumb from JUMP onto HIT without lifting is
    "take off, wind up" in one motion.
  - BLOCK = hands up + load a jump (release to take off, hands stay up until landing); when the ball
    is dropping onto you from your side the same button reads SET and sets without a jump.
- Tunables in `TOUCH` (config). Settings: Touch controls Auto / On / Off, Touch aim sensitivity.
  `?touch=1` forces the layer on a desktop (used by the e2e touch section and the phone script).
- Verified with Playwright phone emulation (844x390, DPR 2, real multi-touch through CDP): run,
  load, take off, air wind-up with an aim drag, swing, block latch, camera toggle, pause / resume,
  fullscreen request, no console errors. Not yet tried on real hardware: iOS Safari quirks
  (no fullscreen, haptics), real thumb ergonomics and the right look sensitivity need a phone.
- Ideas for later: gyro aim (turn the phone to look, with the iOS permission prompt), a left-side
  JUMP option for players who prefer the two-thumb split, button size / layout scale setting,
  a short on-screen tutorial on the first touch session.

## Custom body (settings: height, vert, spike power)
- Settings → **Your athlete**: per position (OH / OPP / MB / S / L tabs, the tab opens on the
  position you picked or are playing) sliders for height (1.60-2.20 m), vertical = approach jump
  (40-110 cm) and spike power (x0.60-1.30, shown as the top speed of a Perfect full-power spike,
  65-140 km/h), the resulting spike reach, the position's defaults and a reset. Stored in
  `settings.bodies` (only customised positions; sanitised and clamped on load). Only the user's
  athlete uses it: AI players keep the position defaults. Speed, ball control and the standing-jump
  fraction stay the position's.
- `src/game/body.ts` resolves a body (`bodyStats`, clamped to `BODY` in config); `Athlete` takes
  `{ body }` and has `setBody` / `copyBody`. Changes apply live, also mid-drill: stats at once, and a
  new height rebuilds the user's model (same kit, same view slot) on the next frame and restarts
  the replay buffer (it recorded the old model).
- The forward-simulation copies (autopilot planner, `simulateApproach`, `predictJump`) now copy
  the whole body, not only the jump: with a custom height the quick set was solved for the default
  body's hand and missed a taller middle's hand by ~10 cm (test).
- Position cards on the start screen show the custom height / jump / power bars, tagged "custom".
- Tests: 79 (custom vert = the approach jump you get, standing jump keeps its fraction; height moves
  the reach and contact point; power scales the same Perfect swing's speed; a quick meets a taller,
  higher-jumping middle's hand; clamping, sanitising stored values, dropping a default entry).

## Pause and pointer lock
- Playtest report: "Esc has to be pressed twice to pause, the first one only frees the mouse; and
  sometimes the mouse is free and doesn't steer." Reproduced in headful Chromium with real OS key
  presses (XTest under Xvfb; CDP key events skip the browser's Esc handling, so they can't show it).
- Root cause: any refused `requestPointerLock` switched on the drag-look fallback for good. Chrome
  refuses a re-lock for ~1.25 s after the user's Esc ("Pointer lock cannot be acquired immediately
  after the user has exited the lock"), so a quick Resume after Esc left the game unpaused with a
  free mouse that didn't steer, and clicking the court didn't recapture it. A later lock still
  worked, but with the flag on, losing it didn't pause: the first Esc only freed the mouse, and
  the second (now a page keydown) paused.
- Fix (`src/core/input.ts`, `src/main.ts`): drag-look only when the lock is refused before it has
  ever worked; a granted lock clears it. A refusal after that keeps the game paused with the menu
  up and retries once Chrome's window has passed (the Resume click still counts as the gesture),
  so a quick Resume just takes a moment. Esc on the pause menu resumes through the lock request
  instead of unpausing with a free mouse; key repeats and the releasing press itself are ignored.
  Firefox / Safari (no promise from `requestPointerLock`) report refusals via `pointerlockerror`.
- Tests: `tests/pointerLock.test.ts` (scripted browser: fallback only before the first grant,
  Chrome's cooldown refusal keeps lock mode, a grant clears the fallback, unadjustedMovement retry,
  event-only browsers).

## Replay with the opposing block (Spike Drill, B)
- Report: "replay in spike drills with blocks is not really working". Reproduced in the browser
  (bot spike into a double block, then R): the replay had 3 of the 5 athletes. The two blockers
  stood frozen where they were when R was pressed (feet on the floor, the middle 3 m from where it
  closed), the ball bounced off empty air, the touch was silent, and the red shadow stayed as drawn live.
- Root cause: the replay takes its athlete list once at mode start (`setViews`); the blockers are
  spawned later, on the first B press, so they were never recorded or posed.
- Fix: `Game.addAthlete` registers every new view with the replay (`Replay.addView`), keeping the
  buffer. Each slot remembers its first recorded frame, and a replay hides an athlete for the part of
  the recording from before it was there (B pressed after the spike, then R): no stale or empty slot
  data is ever posed. Blocks are replay events now (slowed sound, hand flashes on the replayed hands,
  spray, the trail ending on the hands), and the spike drill redraws the block shadow on each replay
  frame from the replayed blockers and the replayed contact point (`Mode.replayFrame`).
- Tests: `tests/replay.test.ts` (an athlete added mid-recording is replayed where it was, hidden before
  it existed, and shown again when the replay ends, is skipped or the buffer is reset). Browser check:
  replayed blocker positions within 0.08 m of the live ones over the whole replay (was 3.9 m).

## Tutorial v3: the ball waits for you (first-run lesson, #25)
- Report (Jack, playing v2): "If I hold jump first at the indication, I'm not supposed to jump. I have to re-click again, and the
  entire experience is not very smooth." And: "the indicator on the floor is not present."
- Causes, measured in headless Chrome through the real input path:
  - **The re-click.** v2 froze the world at each decision and waited for a fresh *press*. A press before the freeze was swallowed
    (`onJumpPress` returned `block`), so Space held 0.6 s early left the world frozen for good (2 s later: still `jump-load`, sim
    time unchanged) until it was released and pressed again. The attack button had the same hole.
  - **Back-to-back stops.** v2 stopped four times in about 0.6 s of game time; the arm freeze came 3 cm after takeoff.
  - **The floor ring.** `makeFloorRing` had no polygon offset. The court is pulled towards the camera (offset -2), so it drew over
    the ring: only the half over the blue free zone showed. The Spike Drill's own ring had the same cut on `main`.
  - **Where to plant.** The ring marks where your feet are at *contact*. The plant starts about 1.5 m before it (1 m of run, then the
    plant slides 0.9 m and the jump drifts 0.6 m: a broad jump), so "stop on the ring, then jump" taught a standing jump, and the
    one solo rep after it was the first time the approach appeared, at full speed.
  - **First person.** Looking level, a Perfect goes into the net (the look aims: level is a 2.5 m deep shot).
- Fix:
  - **Held, not pressed.** In the together rep the lesson reads the buttons as held state (`UserActions` leaves the edges alone while
    `tutorial.ownsButtons()`), and does the plant, the wind-up and the swing itself at their moments.
  - **Waits only if you are late.** Time eases down into a moment you have not acted on yet (`TUTORIAL.easeLead`, `crawl`) and stops
    there. The game never simulates past a moment the ball waits at (`Tutorial.stopAt`, checked per fixed step with the same
    `reached()` the director uses), so the plant and the release land on the same step at 12 fps and at 144.
  - **Run and jump are separate beats.** Time runs while you hold the sprint, then while you hold Space; the load fills in game time
    and the jump leaves the floor at the planned hold. Letting go half way stops time instead of jumping early.
  - **Early release costs nothing in rep 1.** The arm stays drawn, the coach says "not yet", and a click at the gold swings.
  - **Help fades.** Together (waits) → slow motion (cues, nothing waits) → full speed (strip only). One tip after each ball.
  - **Floor guide** (`fx/approachGuide.ts`): the spot uses the look of the Setter Drill's stand-here spot from #33 (MatusGib): white
    ring and disc over a dark outline, polygon offset -4, green under your feet. The lesson adds arrows down the run and a line
    where to plant. The Spike Drill uses the same spot now, and `makeFloorRing` (Serve Receive, Setter Drill) has the offset too.
  - The ball's landing ring is hidden during the lesson (two rings side by side on the floor), and in the together rep the coach
    aims the swing 6.5 m deep down your line. If good timing misses their court later, the tip is about the aim.
- Measured (headless Chrome, manual stepping at 60 fps unless said):
  - Everything held from before the set: 0 frames waited before the gold; release there: **Perfect**, KILL.
  - A first-timer who acts 0.4 s after each stop: four stops (run, jump, draw, hit), **Perfect**, in first and third person.
  - Real time under software rendering (12 fps): the together rep is still **Perfect**.
  - The whole lesson with a scripted player on the real controls: together Perfect → slow Perfect → full speed Good (it ran
    straight at the net instead of down the arrows: "reaching"), flag `done`.

## Tutorial entry: a first visit opens on a welcome (#25)
- Report (Jack): "I'm not sure this is offered to people who have never visited this website, because I have."
- What a new visitor got: the full start screen (five positions, six drills, the controls), one 12 px line saying PLAY teaches a
  spike, and a PLAY that started the lesson whatever position and drill they had picked (Mini Rally as libero → the Outside
  spike lesson). "Replay tutorial" was offered to people who had never taken it. Quitting to the menu part-way left the lesson
  running: the next drill started with its HUD and its rules.
- Fix:
  - While the lesson is still on offer (`tutorialOffer`: never visited, or left part-way) the start screen is a welcome with two
    buttons, **Start the tutorial** (Enter) and **Skip to the drills**. Skipping is remembered. Left part-way: **Continue**.
  - PLAY always plays what you picked. The start screen's button is **Tutorial**.
  - Quit to menu leaves the lesson (`Tutorial.leave`), keeping the saved step; Restart drill in the lesson restarts its rep.
  - Taking the lesson again once it is done or skipped does not write the flag, so quitting a replay does not bring the welcome back.
- Checked in headless Chrome with a clean profile: welcome → Enter → lesson; quit → "Welcome back", Continue; Skip → drills,
  flag `skipped`, then Mini Rally as libero plays Mini Rally as libero; a `done` profile opens on the drills.

## Tutorial end: the game says it is done and offers what next (#25)
- Report (Jack): after the third ball the player is just left in the Spike Drill. Say the tutorial is finished, offer to keep
  trying or go elsewhere, and say that the Spike Drill and the tutorial can always be found again.
- Before: a title, "You're on the court.", for 2.6 s, then the drill carried on with no word about what had happened or where
  anything was.
- Fix: when the coach's line about the third ball is done, the drill pauses and the pause dialog comes up as the end of the
  lesson (`Menu.showFinished`, from `Game.onTutorialDone`): one line about it (clean hit, or "the timing comes with reps"),
  **Keep hitting** (the Spike Drill you are standing in), **Choose another drill** (the start screen), and a note that the Spike
  Drill and the Tutorial are always on the start screen. It is the pause dialog, so Esc, the pointer lock and touch behave as
  they do there. The lesson ends at that moment (no hand-off timer), and the drill's own title and score line come back.
- Checked in headless Chrome: a clean third ball → the prompt → Keep hitting → the next rep plays as the plain drill; two
  third balls that did not come off → the prompt → Choose another drill → the start screen with the drills; the ordinary pause
  menu afterwards is unchanged.

## Left-handed players (settings: hitting hand, #19)
- Report (a player): "I'm a lefty and my athlete always hits with the right hand." Everything one-handed
  assumed a right hand: the contact point (`Athlete.idealContact`), the hitting arm in the animator, the
  wind-up twist, the two-step plant, the ready stance, the serve toss and the third-person camera.
- Change: Settings → Your athlete → **Hitting hand: Right / Left**, one value for every position, saved
  with the settings (anything but `"left"` loads as right) and applied live; the start screen's position
  cards say "lefty". `?hand=left` for testing. `Athlete.hand` (+1 / -1) and `hitSide()`: the contact point
  mirrors across the line the athlete faces, which moves the cyan feet ring, the quick set to the middle's
  hand, the approach planner and the autopilot with it (`copyBody` copies the hand to planner copies).
  The serve toss goes up in front of the hitting shoulder. AI athletes stay right-handed.
- Animator: the arm keys were already authored per arm (x times the arm's side), so a lefty only swaps
  roles: the left arm cocks, whips and follows through, the right arm tosses, points at the ball and pulls
  down. The attack twists of the chest and hips (authored for a righty) turn the other way, the plant is
  left-right, the hitting-side foot is back in the ready stance and tucks most in the air. First person
  needed nothing more: the same per-arm keys put the cocked left hand on the left of the view. Replays
  record bone rotations and show the left hand as is. The only palm flashes in the FX are the block's,
  on both hands, so there was nothing hand-specific to change there.
- Third person: the camera follows the hitting shoulder (`CameraRig.shoulderSide`). At 25 ms before a
  lefty's contact at the left pin, over the left shoulder the ball and hitting hand sit inside the head,
  towards the crosshair (screen x +0.058 / +0.044, head +0.068); over the right shoulder they sit outside
  it (-0.074 / -0.100, head -0.068). Over the hitting shoulder is the mirror of a righty's frame, so it stays.
- Measured in the browser (dev server, `?mode=spike&bot=perfect&hand=left`, 90 s of sim each): OH 12/12
  Perfect (108 km/h), OPP 13/13 (116), MB quick 15/15 (102), S attack on two 19/19 (88), L pipe 13/13 (81).
  Every one is hit by the left hand: its palm 0.23-0.27 m from the ball against 1.01-1.12 m for the right,
  on the last drawn frame before the contact. A righty OH, same run: 13/13, 108 km/h, 0.25 / 1.11 m.
  In first person, on the contact frame, the left palm is 0.06 m from the ball.
- Serves (Free Play feed 5, OPP, through the input path: Q, hold LMB 0.45 s, release on the ideal): the
  lefty's toss leaves 0.13 m left of the body, the right hand up (palm 2.17 m) and the left cocked. Float
  serve Perfect 60 km/h; jump serves (Space 0.35 / 0.45 / 0.55 s after the toss) Perfect 93, Perfect 81,
  Good 63 km/h. The righty's are the same grades and speeds, with the palms swapped.
- Lanes, checked and left as they are: with the hitting-side contact offset, a righty's run to the left
  pin is 13° off straight and to the right pin 21°; a lefty's is 21° to the left pin and 13° to the
  right. The off-hand pin already gets the wider run for both hands. A lefty setter's attack on two is
  met in front of the left shoulder, 0.02 m from straight ahead of the lane start (a righty's is 0.32 m
  to the left).
- Tests: +8, 123 in all (`tests/gameplay.test.ts`, `tests/settings.test.ts`): the contact point mirrors; the left hand meets the ball and
  stays down until the landing; the same release gives the same grade and speed (tips differ only by
  the distance to the target); a quick meets a lefty middle's hand; a lefty's toss goes left and the
  same timing serves just as well; the plant is left-right; in first person the left hand is drawn back
  beside the head with the left shoulder turned away; the stored hand is sanitised.

## The e2e on a slow CI runner: fresh pages and the GPU queue
The "End-to-end (headless Chromium)" job failed on slow GitHub runners (9-10 Nov 2026: PR #27 twice
at the touch page's `waitForFunction`, 30 s; PR #35 three times at the first robustness probe's, 60 s)
and passed on a re-run with no change. It was the script, not the game.
- **Why the first fresh page after a heavy phase is slow.** WebGL does not wait for the software GPU:
  a draw call only queues work for the browser's GPU process, which draws a frame in 0.6 s on a good
  machine and 2 s on a slow runner. The perf phase stops with frames still queued, and the soak's
  renders (38 with CI's `SOAK=30`) are all still queued when it returns: it takes a few seconds, its
  frames take 25 s to draw here and 66 to 100 s at a slow runner's speed. Two things then wait for
  the whole queue, whoever filled it:
  - a page's first drawn frame: it compiles every shader, and the page's main thread is blocked
    until the GPU has caught up. No evaluate is answered meanwhile, and a wait that polls on
    animation frames needs the first frame *and* the second.
  - closing a browser context: the browser's own main thread waits for the GPU process to tear the
    page's window down (`Compositor::destructor` → `DestroyCompositorFrameSink` in a trace: 73 s and
    173 s on one core), and that waits for everything queued. Until then nothing that goes through
    the browser moves: a new context, a navigation, an answer from any page.
  So the first page opened (or the first context closed) after such a phase paid for that phase's
  frames out of its own limit, and the pages after it found the queue empty. That is why only the
  first probe timed out and the later ones took ~13 s.
- **Reproduced locally** by taking CPU away, which a 2-core pin alone does not do: two cores shared
  with two busy loops each (`taskset -c 1,2`, plus `while :; do :; done` twice per core) gives
  `swiftshaderWallMsPerFrame` 2009, the failing runs' number, and the old script fails at the touch
  page with the same `Timeout 30000ms exceeded`. With that limit lifted, the soak's queue landed on
  the second probe's `browser.newContext()`: 100 s. In CI it landed on the first probe's wait instead;
  which call is the victim depends on timing, the queue is the same. (That last step, the exact
  victim in CI, is inferred, not observed.)
- **What the script does now** (`scripts/e2e.mjs`, "fresh pages on a software GPU"):
  - every fresh page (main, touch, probes) holds rendering until it is up, and is waited for with
    timer polling and one generous limit (`FRESH_PAGE_MS`, 120 s, for the navigation too); pages that
    draw are then released and waited for until their first two frames are drawn;
  - after the warm-up, the perf frames and the soak, once a probe's page is up, and before any
    context is closed, the script waits for the GPU to finish (`gpuIdle`: a WebGL fence, polled; `gl.finish()` returns at once
    here, with 40 s of frames still queued). The wait is printed (`gpu queue after the soak: 66 s`), so a slow run's log says where
    its time went;
  - the touch page's screenshots wait for the GPU before capturing, so their 90 s limit covers the
    capture (it was at 60 s of it at CI's slow speed).
  No check was removed or loosened: the predicates are the same, only where the waiting happens and
  how long it may take changed. Throttled as above the whole suite now passes, at 1.9 s a
  frame in 10.6 min and at 2.6 s a frame in 15.9 min, with every fresh page up in under a second after
  its navigation. On a good machine it costs about a tenth (264 to 287 s over three runs, against
  244 s for the old script on the same machine, `SOAK=30`).
- Found on the way: with the default 120 s soak (`npm run e2e` without CI's `SOAK=30`) two soak checks
  failed, geometries 113 → 115 and textures 49 → 50, on the old script and the new one alike. Explained
  and fixed in the next section (objects kept from start-up but not drawn yet, not a leak).
- Not covered: a runner about three times slower than the slowest seen runs into the job's own
  30-minute limit first. On a single core (about 5 s a frame) the old script also ran out of its
  screenshots' 90 s limit; that was not looked into.

## The e2e in under half the time
The suite spent most of its time on the software GPU, and a good part of that drawing frames nobody
looked at. Same machine, CI's settings, before → after: **235 s → 94 s** (start-up 37.5 → 9.6,
screenshots 15.4 → 14.9, drills 4.8 → 4.4, perf 88.3 → 25.1, touch 48.7 → 17.4, soak 22.3 → 7.2, probes
15.2 → 14.3; the script prints this line itself now: `seconds per phase`). Throttled to a slow runner's
speed (2.4 s a frame) it passes in 251 s, where it took 635 to 955 s. No check was removed.
- **Frames are paced to the GPU** (`paceRendering` in `scripts/e2e.mjs`): a page that draws by itself
  ran some twenty frames ahead of SwiftShader, and every screenshot, every wait for the GPU and the
  closing of the page then waited for that queue (22 s after the warm-up, 13 s after the perf frames,
  about 30 s in the touch test). Now an animation frame is skipped while two rendered frames are still
  undrawn, the way a busy display holds a real page back. This alone: 235 → 176 s. The touch test's
  steps now each wait for real frames (0.7 s here, 2 s throttled), so their limit went from 4 s to 30 s.
- **The soak draws small frames** (320 × 180): it renders to make three.js build and free resources,
  and what gets built does not depend on the picture's size.
- **The soak's first sample no longer depends on the rally before it.** A resource is counted when
  it is first drawn, and the aim ring (built at start-up, kept) is only drawn once the athlete first
  winds up. With fewer perf frames that moment moved inside the measured window and read as growth
  (112 → 113 geometries, 48 → 49 textures). The warm-up now draws every object in the scene once,
  hidden or not, before the first sample. With that the default 120 s soak passes too (122 / 50 / 36
  before and after, six mode switches): the failure noted above was this, not a leak.
- **`PERF_FRAMES`** (default 120, CI 30) sets how many frames the perf numbers are taken over, like
  `SOAK`. They are reported, not asserted. `swiftshaderWallMsPerFrame` now counts frames really
  drawn, so it reads 10 to 25% higher than before on the same machine (670 to 800 against 630 here);
  compare new runs with new runs.
- The fixed 6 s of warm-up frames is gone: the two frames the script already waits for are the ones
  that compile the shaders.
- CI installs only Chromium's headless shell (`--only-shell`), which is what a headless run launches
  (checked here by launching with nothing else installed; not yet run on a GitHub runner).
- With default settings (`npm run e2e`: 120 s soak, 120 perf frames) the suite takes 153 s and passes.
- What is left, largest first: the perf frames (25 s for 30), the touch page (17 s, mostly its first
  frame's shaders and two screenshots), the screenshots (15 s for 12) and the probes (14 s: every
  fresh page bakes the environment map, about 2 s of GPU each).

## Decisions
- First-run tutorial v3 (issue #25) is a coach layer on Spike Drill, not a seventh mode: Outside, block off, three balls with less help each time. **Together:** the ball waits for you. At each moment (run, jump, draw, hit) time eases down and stops until you do it; on time, nothing stops. Buttons are read as held, never as fresh presses, so a button already down when its moment comes counts. The coach runs the hitter down the planned line and aims the ball: what you hold decides whether time runs. **Slow motion:** you drive at 0.6 speed with the same cues, nothing waits, the result is real. **Full speed:** the drill, with the contact dip. After each ball the coach says one thing (the first thing that went wrong); a rep is retried once, then the lesson moves on. After the third ball the game says the tutorial is done and offers to keep hitting or choose another drill. A timing collar around the charge ring (gold / cyan / wood from the real spike windows) is on in the lesson and, after it, whenever Settings → Hints is on. This replaces v2's hard freezes (below, "Tutorial v3") and the tip stays out of the lesson.
- Home/user team on +z facing -z; facing -z the right hand is +x. (One frame for everything.)
- No external art: quaternius.com / kenney.nl are blocked by this environment's network policy,
  and no CC0 pack ships volleyball-specific motions anyway, so the athlete is a procedurally
  built skinned mesh with code-authored poses + IK (see CREDITS.md). Logged per the tech-stack rule.
- Arm motion is authored as wrist positions + IK rather than joint angles: blends become spatial arcs
  and the contact-point IK falls out for free.
- Airborne body yaw is limited to ±0.35 rad from takeoff (the arm aims, not the hips); otherwise
  aiming cross-court mid-air swung the contact point away and made timing feel random.
- FP aim depth comes from pitch with a range that lets you look up at the ball (looking higher = deeper).
- FP aim pitch range [-0.25, 1.15]: looking at the ball while hitting gives a mid-court shot, so
  the natural FP behaviour keeps the contact (arm, sparks) in view.
- Aim depth = depth into the opponent court (not distance from the hitter), so spikes and serves
  share one mapping and the reticle is always on their side.
- Zone contacts (pass/set) resolve at the closest approach, not first entry into the reach sphere.
- The spike timing window is wider on the late side: players release as the ball arrives, and the
  extra input/display latency of a browser lands on that side too.
- Spike power comes from the wind-up hold, timing from the release: holding longer is never
  penalised directly, the risk is holding past the moment the ball is in reach (you can only release
  so late) or landing first. Full charge caps at 0.32 s so a full-power swing fits in any jump.
- Back set (OPP) is set a bit higher than elite tempo so it is reachable when reacting to the set.
- The MB quick is a true "1": the hitter jumps with the setter's touch and the set adapts to the
  hitter (fixed flight time to the predicted hand position at the top of the jump), because a quick
  timed off the set is unhittable at real tempo.
- Pin sets are met ~0.5 m inside the antenna; AI hitters still read a single block and go around it.
- Key light nearly overhead (arena look, readable shadow under players, no floor hotspot).
- `PCFSoftShadowMap` was removed in three r187; using `PCFShadowMap` with shadow radius.
- Body yaw always follows camera yaw (both cameras): volleyball players face the play while
  shuffling, and it keeps the aim consistent.
- Ball drag Cd 0.26 (not 0.47): volleyballs at spike Reynolds numbers are past the drag crisis.
- Solvers integrate aerodynamics only; the live sim decides if the net gets in the way (honest physics).
- TP framing only dollies the camera, never rotates it, so the aim never moves without the mouse.
- Hit sounds are layers started a few ms apart (crack, then pop, then boom) so their peaks don't
  stack: loudness comes from density and the room (saturated low-mids, slap-back, reverb), not from
  a higher peak. Everything scales with the ball speed, never with a heavy/light switch.
- The Mini Rally setter's out-of-system call is made early on the pass and binds the set (never a
  silent swap at the touch): a hitter can only adjust a fast approach if they know ~1 s ahead.
- A team's own serve is not one of its three touches, and the serving team may not play it until
  the other side has (a touch is a service fault). While it flies the team is in base defence.
- When the setter plays the first ball, the libero is the backup setter (not whoever is closest),
  and that second ball is always out of system. A libero hand-sets only from behind the 3 m line;
  in front of it they bump-set (an attack above the net off a libero's front-zone finger set is a
  fault).
- Contact feedback for a Perfect is a freeze frame you can read (squashed ball, sparks, then a
  ring and the trail), not a flash: no full-screen flashes of any kind.
- The hitting hand is one setting for the player, not per position, and only the user's athlete
  has it: timing windows, power and reach are identical for both hands, so both share one leaderboard.
- Lefties keep the same attack lanes: they already mirror (a lefty's left pin is a righty's right pin,
  21° off straight). If players want the off-hand approach straighter, that is one lane change for both
  hands, not a lefty special case.
