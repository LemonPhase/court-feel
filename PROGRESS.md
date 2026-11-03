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

## Known issues
- This container renders with SwiftShader (software GL, ~1 fps), so GPU frame time at 1080p on a
  real laptop could not be measured here. CPU-side frame time, draw calls and triangle counts are
  well within a 16.7 ms budget, and the quality governor degrades gracefully if the GPU is slow.
- Pointer lock can be refused in some embedded browsers; the game falls back to drag-to-look.
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
- Contact feedback for a Perfect is a freeze frame you can read (squashed ball, sparks, then a
  ring and the trail), not a flash: no full-screen flashes of any kind.
