// What the player sees and hears: the camera, the ball, the hall, the athletes, the effects, the sound. Owner: the display.
//
// What each section controls:
//
// `CAMERA`: FOV, approach FOV boost, sensitivity, TP distance/height/framing, shake
//
// `BALL_LOOK`: How deep the ball's seams look and how much it glows by itself
//
// `ARENA`: The hall: floor mirror (size, strength, blur), the stands (`bowl`: tiers, rows, seats,
// how brightly the crowd is lit), how the net mesh goes in with a ball that is in it and settles
// after, how the net's top shakes when the ball hits it (`netTop`) and how finely the antennae are
// drawn as the physics bends them (`antenna`), lights, the final grade
//
// `CHARACTER`: How athletes are drawn: rim and side fill light, the arm swing of a jump
// (`jumpSwing`), how early hands go to where the ball will be (`meet`), the passing stance and what
// the platform does after the touch (`pass`), hand shapes (`hand`: how the fingers curl and spread
// loose, flat, on the ball and closed), where a palm meets the ball, how far arms, head, knees and
// toes keep from the net (`netClear`), idle breathing, and what keeps an AI player's body from
// being rigid (`loose`: the ready stance and bounce with a ball in play, the lean into a push-off
// or a stop, the chest coming round after the hips)
//
// `FX`: The play wheel (`playWheel`); The set's catch ring, bar (and its pips, and its place in
// first person), floor spot, first-person dial (`setRadar`) and guide (the hitter marker and the
// set's arc, `setGuide`), the ring round a float where it breaks (`floatBreak`), the outline of the
// block's shadow (`blockShadow`), hit-stop lengths (and the extra at full power), FOV punch and
// camera kick, ball squash, shake amounts, spark count, crack life, replay timing, bloom

export const CAMERA = {
  fov: 72,
  /**
   * The field of view with the touch controls on (a phone held sideways, about 2.16 : 1). At 72°
   * the wide screen shows about 115° across, far more than a monitor; 62° shows about 105°, what
   * 72° shows on a 16:9 monitor. Its own setting, so old saves (72° for everyone) don't carry over.
   */
  touchFov: 62,
  fovApproachBoost: 6,
  near: 0.04,
  /** FP clips anything closer than this (your own shoulder beside the eye) */
  fpNear: 0.22,
  far: 140,
  sensitivity: 0.0022,
  fpEyeForward: 0.09,
  /** FP lens never gets closer to the net plane than fpNear + this (the net stays in view at the net) */
  fpNetGap: 0.1,
  fpBobScale: 0.35,
  fpPitchMin: -1.35,
  fpPitchMax: 1.35,
  tpDistance: 3.7,
  tpDistanceMax: 5.6,
  tpHeight: 1.55,
  tpShoulder: 0.45,
  /** TP look pitch range (negative = looking down) */
  tpPitchMin: -1.1,
  tpPitchMax: 0.45,
  tpFollowStiffness: 14,
  tpFrameBall: 0.7,
  shakeMaxAngle: 0.035,
  shakeMaxOffset: 0.09,
  shakeDecay: 2.6,
  fpShakeScale: 0.45,
};

/** how the ball is drawn: how deep its seams look, and how much it glows by itself (it has to read against the dark roof) */
export const BALL_LOOK = {
  seamDepth: 2.2,
  glow: 0.2,
};

/** how the arena is drawn and lit (never how the game plays) */
export const ARENA = {
  /** the floor mirrors the players, the net and the boards */
  reflection: {
    /** how bright the mirror image is at a grazing angle, and the fraction of that seen straight down */
    strength: 0.8,
    facing: 0.09,
    /** blur of the mirror image (mip levels): on the glossiest board, and extra per unit of roughness */
    blur: 0.6,
    blurRough: 2.4,
    /** nothing in the mirror image counts as brighter than this (a white shirt is about 1) */
    max: 1.1,
    /** a board this rough (as 1 / roughness) shows no mirror image at all */
    roughFade: 0.9,
  },
  /** the stands: a lower tier behind the boards, a walkway, an upper tier on a balcony (metres) */
  bowl: {
    /** from the edge of the free zone to the front wall of the stands */
    setback: 2.2,
    /** rows, how deep each is, how much higher than the one in front, and the height of the front row */
    lower: { rows: 9, depth: 0.85, rise: 0.46, base: 1.05 },
    walkway: 2.4,
    /** `lift`: from the walkway up to the first row of the balcony */
    upper: { rows: 7, depth: 0.85, rise: 0.58, lift: 2.9 },
    /** how far the balcony's front hangs over the walkway */
    overhang: 1.2,
    seatPitch: 0.52,
    /** seats between two aisles, and how many seats wide an aisle is */
    aisleEvery: 16,
    aisleSeats: 2,
    /** fraction of seats left empty */
    empty: 0.08,
    seatColor: 0x1d2c52,
    /** how brightly the crowd is lit, from the front row to the back of each tier (the court is 1) */
    light: { front: 0.78, back: 0.5, upperFront: 0.4, upperBack: 0.24 },
    /** the cool cast of the hall on the crowd */
    crowdTint: 0xdfe6ff,
    /**
     * brightness of the balcony's LED ribbon, the doorway glow and the lamps under the roof (1 = white; above 1
     * blooms). The lamps stay below it: you look up at a set against them, and a glow there would hide the ball.
     */
    ribbon: 0.62,
    doorGlow: 0.36,
    lamp: 0.93,
    doorEvery: 9,
  },
  /**
   * The net's mesh is drawn going with a ball that is in it (as far as the ball has sunk: `BALL.netGive`),
   * in a bulge `spread` (m) wide, held only close to the tapes (`pin`: how sharply). Once the ball lets go
   * it swings back at `swing` (rad/s) and dies away at `damping` (1/s), with hardly any overshoot: the
   * ball is still beside it, dropping down the net. Shown for `life` (s); `hits` can settle at once.
   */
  net: { spread: 0.25, pin: 3, swing: 12, damping: 6, life: 1.2, hits: 4 },
  /**
   * The net's top shakes when the ball hits it: pushed away from the ball by `perImpact` m per m/s of the
   * hit (at most `max`; a hit lower in the mesh moves it `body` of that), most within `spread` m of
   * the hit, held at the posts. It swings back at `swing` (rad/s, about 4 Hz) and dies away at
   * `damping` (1/s). Shown for `life` s; `hits` can shake it at once; it is drawn through
   * `samples` points along it. By eye, from match video (no measurement found): a hard ball into the
   * tape moves it a hand's width and it settles within a second.
   */
  netTop: { perImpact: 0.008, max: 0.1, body: 0.4, spread: 1.5, swing: 26, damping: 3.5, life: 1.5, hits: 6, samples: 45 },
  /** the antennae are drawn in `segments` along their length, bent as the physics bends them (`BALL.antenna`) */
  antenna: { segments: 24 },
  /** the finished picture: darker corners (0 = none), an S-curve of contrast (0 = none), saturation (1 = as rendered) */
  grade: { vignette: 0.32, contrast: 0.16, saturation: 1.06 },
  /** how deep the grit of a painted outdoor court reads in a low light (the bump scale; by eye, on the seaside court at golden hour) */
  paintGrit: 0.5,
  /** light on the court: sky and floor-bounce fill, the key from the roof, and two soft fills from the long sides */
  light: {
    hemi: 0.5,
    key: 2.0,
    fill: 0.5,
    /** how strongly the hall's reflection lights everything */
    env: 0.5,
  },
};

/** how the athletes are drawn (never how they play) */
export const CHARACTER = {
  /** soft light on the edges of a figure that face up and away from the camera (0 = off) */
  rim: 0.55,
  /**
   * light from the sides of the hall (boards, stands, the floor's bounce) on upright surfaces: it is what
   * reaches a face under roof lighting. Part of the athletes' own shading, so it puts no glare on the floor.
   */
  sideFill: 0.2,
  /** how strongly the arena reflects in skin, cloth and shoes */
  envIntensity: 0.7,
  /** first person: your own body starts to show this far (m) from the lens and is whole from `to` (m) */
  fpFade: { from: 0.22, to: 0.265 },
  /**
   * Standing and waiting: the chest rises and falls `chest` (rad) at `breath` (Hz, a player between rallies
   * breathes about every two and a half seconds), and the weight shifts at `sway` (Hz): the hips `bob`
   * (body heights) and the trunk `lean` (rad). Each athlete is out of step with the others.
   */
  idle: { breath: 0.4, chest: 0.014, sway: 0.23, bob: 0.004, lean: 0.012 },
  /**
   * A body that isn't rigid (AI players; cosmetic only, decision record 0008: nothing here is read
   * back by the play. Your own body is left alone: in first person your eyes ride on it).
   * - With a ball in play nobody stands flat-footed: a player standing still sits `readyDrop` (body
   *   heights) lower with the chest `readyLean` rad further over the knees, and bounces on the balls
   *   of the feet, `bounce` body heights at about `bounceHz` (each player at their own tempo, within
   *   `tempo` of it). Between rallies they stand up and breathe (`idle`).
   * - The trunk leans into the acceleration, `accLean` rad per m/s² and at most `accMax` rad: forward
   *   as they push off, back as they brake, into a sidestep.
   * - The chest follows the hips into a turn `turnLag` s late (at most `turnMax` rad): the feet turn
   *   first, the shoulders come round after.
   * - How fast each follows (damp rates, 1/s): the ready stance `readyRate`, the acceleration
   *   `accRate`, the turn `turnRate`.
   * - A body that goes faster than `placed` m/s from one frame to the next (twice a sprint) was put
   *   on its spot between rallies, not moved there: it starts still, with nothing to lean into.
   */
  loose: {
    readyDrop: 0.03,
    readyLean: 0.1,
    bounce: 0.014,
    bounceHz: 1.8,
    tempo: 0.15,
    accLean: 0.012,
    accMax: 0.18,
    turnLag: 0.08,
    turnMax: 0.3,
    readyRate: 5,
    accRate: 8,
    turnRate: 10,
    placed: 15,
  },
  /**
   * Between points (an AI player's body, `Athlete.relax`, `tired`; drawn only, decision record 0008).
   * - Off the ball they stand up: the hips `drop` (body heights) less low, the trunk `spine` rad more
   *   upright, the arms hang (`relaxed` arm key). Eased in and out at `rate` (1/s).
   * - After a long rally (`tired` 1) the chest heaves: it breathes `faster` times quicker and `chest`
   *   rad deeper, the shoulders rising `shrug` (rad) with each breath.
   */
  relax: { drop: 0.03, spine: 0.12, rate: 3, faster: 0.9, chest: 0.035, shrug: 0.06 },
  /**
   * What a gesture between points does to a body (`Athlete.gesture`, src/character/gestures.ts; drawn
   * only). Arm positions are the wrist's offset from the shoulder in the body frame (out to the arm's
   * own side, up, forward), in body heights; poles are where the elbow points (the same frame); keys
   * are [time through the gesture 0..1, out, up, forward]. Trunk angles are rad (spine and chest:
   * negative bends forward), sinks body heights, hops metres. From watching volleyball between
   * rallies, not from a measurement.
   * - Each gesture is given a size between `size` (its own dice: no two fist pumps are the same). It
   *   eases in over `in` (`slowIn` for the slow ones: hands to the hips, the knees) and out over `out`
   *   (s). The arm follows at `rate` (`fastRate` for a punch or a slap, `slowRate`, `clapRate`), 1/s.
   * - fist: a fist up in front and pulled down to the hip (the body crunches into it over `pull`, of
   *   the gesture's time, turning `turn` to its side); both fists from a size of `both`.
   * - roar: both fists by the chest, sinking and bending forward, the head up, the fists shaking.
   * - armsUp: both arms up in a V on the toes, and from a size of `jumpFrom` a little jump or two.
   * - clap: the hands meet at the chest (`mid` puts the wrists a hand's thickness off the middle, from
   *   `apart` apart); `phase` is where each clap starts in its swing.
   * - five: the hands meet at `high` (overhead) or `low` (the hip) of the two players' height, after
   *   at least `minRaise` s coming up; the hand goes `through` m past it, `hold` s, then down over
   *   `after`; the wrist is cocked back `cock` and snaps `snap` (rad).
   * - pat: a hand on the team-mate's near shoulder (`up` of their height, `out` m towards us).
   * - huddle: leaning in; a hand in the middle at `handsUp` of the height, stacked `stackStep` m a
   *   hand (`stack` high), or the arms on the neighbours' backs at `shoulder` of their height, `across`
   *   m past their middle and `behind` m round towards their back, once the neighbour is within
   *   `near` m (coming in from `far` m). A ring that won bounces.
   * - hips, knees (`crouch`: the passer's ready, head up; `tired`: bent over, breathing), sorry (an
   *   open hand up: "mine"), signal (behind the back), wipe (palms down the shorts), shake (the hands
   *   shaken loose), bounce (on the toes).
   */
  gesture: {
    size: [0.8, 1.2] as [number, number],
    in: 0.15,
    slowIn: 0.4,
    out: 0.3,
    rate: 10,
    fastRate: 22,
    slowRate: 6,
    clapRate: 40,
    fist: {
      pull: [0.22, 0.42] as [number, number],
      crunch: 0.22,
      turn: 0.18,
      sink: 0.025,
      both: 0.8,
      keys: [
        [0, 0.02, -0.18, 0.12],
        [0.22, 0.03, -0.02, 0.14],
        [0.42, 0.05, -0.17, 0.06],
        [0.85, 0.05, -0.16, 0.06],
        [1, 0.02, -0.2, 0.08],
      ],
      pole: [0.35, -1, -0.5],
    },
    roar: {
      sink: 0.07,
      bend: 0.35,
      chest: 0.22,
      shakeHz: 5,
      shake: 0.008,
      keys: [
        [0, 0.03, -0.16, 0.12],
        [0.18, 0.05, -0.07, 0.15],
        [0.82, 0.05, -0.07, 0.15],
        [1, 0.03, -0.18, 0.1],
      ],
      pole: [0.6, -1, -0.2],
    },
    armsUp: {
      chest: 0.18,
      back: 0.1,
      hopHz: 2.2,
      jumpFrom: 0.55,
      hop: 0.12,
      palm: 0.6,
      keys: [
        [0, 0.03, -0.18, 0.1],
        [0.09, 0.14, -0.02, 0.1],
        [0.2, 0.12, 0.29, 0.06],
        [0.82, 0.12, 0.29, 0.06],
        [1, 0.04, -0.18, 0.08],
      ],
      pole: [1, 0, -0.3],
    },
    clap: { phase: 0.5, after: 0.2, mid: -0.112, apart: 0.14, up: -0.08, fwd: 0.2, pole: [1, -0.6, -0.2] },
    five: {
      high: 1.08,
      low: 0.52,
      minRaise: 0.2,
      through: 0.06,
      hold: 0.05,
      after: 0.35,
      cock: 0.4,
      snap: 0.5,
      rise: 0.012,
      back: 0.08,
      lowSink: 0.03,
      lowBend: 0.15,
      w: [0.05, 0.28, 0.15],
      lowW: -0.2,
      pole: [1, -0.3, -0.5],
      lowPole: [0.8, -0.2, -0.8],
    },
    pat: { out: 0.12, up: 0.8, hz: 3, lift: 0.03, w: [-0.02, 0, 0.25], pole: [1, -0.4, -0.3], palm: 0 },
    huddle: {
      lean: 0.32,
      sink: 0.04,
      bounceFrom: 0.6,
      bounce: 0.015,
      bounceHz: 2,
      inMiddle: 0.12,
      handsUp: 0.6,
      stack: 3,
      stackStep: 0.04,
      inW: [-0.05, -0.08, 0.28],
      inPole: [1, -0.5, -0.3],
      inPalm: 0.3,
      near: 0.7,
      far: 1.0,
      across: 0.12,
      shoulder: 0.72,
      behind: 0.1,
      armW: [0.15, 0, 0.1],
      armPole: [0.2, -1, 0.2],
      armPalm: 1,
    },
    hips: { back: 0.05, head: 0.12, w: [0, -0.21, -0.03], pole: [1, 0.15, -0.15], palm: 0, flex: 0.3 },
    knees: {
      crouch: { sink: 0.1, bend: 0.8, head: 0.05 },
      tired: { sink: 0.07, bend: 1.05, head: 0 },
      above: 0.05,
      front: 0.03,
      w: [-0.02, -0.33, 0.18],
      pole: [1, 0.2, -0.3],
      palm: 0,
    },
    sorry: { head: 0.1, waveHz: 1.5, wave: 0.01, w: [0.03, 0.27, 0.06], pole: [1, -0.3, -0.5] },
    signal: { both: 0.5, w: [-0.09, -0.24, -0.09], pole: [1, 0, -0.3] },
    wipe: {
      bend: 0.35,
      sink: 0.02,
      keys: [
        [0, 0.02, -0.2, 0.1],
        [0.3, -0.02, -0.25, 0.08],
        [0.6, -0.02, -0.33, 0.06],
        [0.8, -0.02, -0.28, 0.07],
        [1, 0.02, -0.24, 0.06],
      ],
      pole: [1, 0, -0.6],
    },
    shake: { hz: 4, lat: 0.02, flex: 0.5, offset: 1.3, w: [0.02, -0.27, 0.05], pole: [0.3, 0, -1] },
    bounce: { hz: 2.4, hop: 0.04, sink: 0.015 },
  },
  /**
   * The two-arm swing of a jump. On the plant the arms go back behind the hips: `backStanding` (rad from
   * hanging straight down) for a standing jump, up to `backRun` after a run-up of `fullRun` (m/s) or more,
   * within `backTime` (s). From `upStart` (s) after the plant began they swing down past the hips and up in
   * front to `top` (rad) over `upTime` (s), so after a full load they pass the shoulders about as the feet
   * leave the floor. `radius` is the hand's distance from the shoulder, in body heights. From watching
   * approaches, not from a measurement.
   */
  jumpSwing: { backStanding: 0.45, backRun: 1.2, fullRun: 3.5, backTime: 0.08, upStart: 0.1, upTime: 0.3, top: 2.75, radius: 0.3 },
  /**
   * Hand shapes (rad). `knuckle` and `mid` curl the four fingers at their two joints, `spread` fans them
   * apart (the index and the little finger take all of it), `cup` bends the outer fingers further at the
   * knuckle than the inner ones (a ball curves away sideways too), `thumbOut` opens the thumb away from the
   * fingers and `thumbCurl` bends it in towards the palm. `rate` is how fast a hand changes shape (1/s).
   *  - relaxed: a loose hand, running or waiting.
   *  - firm: flat with the fingers apart: a block, a hand drawn back to hit.
   *  - onBall: laid round the ball for a spike, a set or a block touch. Solved for a ball 21 cm across
   *    under a palm 3 cm thick: the knuckles bend to bring the fingers down onto the surface, the middle
   *    joints to keep them on it.
   *  - fist: closed, one hand in the other, for a pass.
   */
  hand: {
    relaxed: { knuckle: 0.35, mid: 0.5, spread: 0.05, cup: 0, thumbOut: 0, thumbCurl: 0.15 },
    firm: { knuckle: 0.04, mid: 0.06, spread: 0.2, cup: 0, thumbOut: 0.2, thumbCurl: 0.05 },
    onBall: { knuckle: 0.59, mid: 0.25, spread: 0.2, cup: 0.11, thumbOut: 0.5, thumbCurl: 0.3 },
    fist: { knuckle: 1.15, mid: 1.3, spread: 0, cup: 0, thumbOut: -0.15, thumbCurl: 0.6 },
    rate: 18,
  },
  /** how far (rad) the trunk bends away from the hitting arm at contact, lifting the hitting shoulder */
  reachTilt: 0.36,
  /** a spiking palm meets the ball this far over the top of it (0 = square behind the line it leaves on) */
  palmOverTop: 0.3,
  /** a pass meets the forearms this far up from the wrists (fraction of the forearm); forearm thickness in body heights */
  platformContact: 0.42,
  forearmRadius: 0.018,
  /**
   * Hands and forearms are put where the ball is going, and wait: they start to move `from` seconds before
   * it arrives and are there `by` seconds before. The arrival is looked for up to `horizon` (s) ahead in
   * steps of `step` (s).
   */
  meet: { from: 0.5, by: 0.16, horizon: 0.7, step: 1 / 60 },
  /**
   * After a set the arms extend `reach` (m) along the line the ball left on, at `speed` (m/s, an arm's, far
   * slower than the ball: the hands push through, they do not carry), then open over `time` (s).
   */
  setFollow: { reach: 0.16, speed: 2.6, time: 0.22 },
  /**
   * A set jump has no arm swing: on the plant the hands come up in front of the chest, close to
   * the body, and over `rise` (s) after the feet leave the floor they go up to above the forehead.
   * `rate` is how fast the arms follow (1/s). From watching setters, not from a measurement.
   */
  setJumpArms: { rise: 0.2, rate: 40 },
  /**
   * After a pass the platform stays where it met the ball. A ball slower than `firmFrom` (m/s) is lifted
   * through: `lift` (m) over `liftTime` (s). One faster than `firmTo` is taken firm: the platform gives
   * `give` (m) and comes back within `giveTime` (s). The arms hold for `hold` (s), then let go over
   * `release` (s). A free ball arrives at 5 to 8 m/s, a serve at 17 to 25.
   */
  pass: {
    firmFrom: 6,
    firmTo: 14,
    lift: 0.09,
    liftTime: 0.2,
    give: 0.035,
    giveTime: 0.12,
    hold: 0.22,
    release: 0.2,
    /** the passing stance: how far the hips drop (body heights) and the trunk leans (rad, negative is forward) */
    crouch: 0.2,
    lean: -0.34,
    /** each wrist's distance from the platform's centre line (body heights): together, not touching through each other */
    wristApart: 0.013,
  },
  /**
   * blocking hands go to a ball hit at them (faster than `minSpeed`, m/s) once it will pass within `near` (m)
   * of them, at most `pull` (m) from where the block was set
   */
  blockReach: { near: 0.3, pull: 0.16, minSpeed: 8 },
  /**
   * Arms and the net. Below the tape a wrist stays `wrist` (m) and the fingertips `fingers` (m) on the
   * athlete's own side. From `above` (m) over the tape a hand may reach across, `reachPerHeight` metres
   * for each metre of height. Nothing applies further than `pastPost` (m) outside the net's ends.
   * The clearances are a hand's thickness and a finger's: close enough to read as "at the net", never in it.
   */
  netClear: {
    wrist: 0.09,
    fingers: 0.035,
    above: 0.04,
    reachPerHeight: 1.6,
    pastPost: 0.25,
    /**
     * Feet and knees and the centre line: the toes stop `toes` (m) short of it and the middle of the knee
     * `knee` (m), which leaves the kneecap and its pad a couple of centimetres on their own side. The hips
     * sit back from the net as far as that takes, and come forward again at `sitRate` per second. A foot
     * wholly over the line is a fault, and a blocker loads with the hips back, not with the knees under the net.
     */
    toes: 0.02,
    knee: 0.1,
    sitRate: 8,
    /** the head keeps this far (m) from the net: a forward lean is cut short. Its height and its lever over the hips, in body heights. */
    head: 0.17,
    headHeight: 0.86,
    headLever: 0.36,
  },
};

export const FX = {
  /**
   * The set's timing ring (Settings: Set timing ring): it closes onto the ball and is `atContact`
   * ball radii across as the ball reaches your hands (just outside the ball, so nothing covers it).
   * Its radius is that times e^(perSecond x time to go), shown from `showFor` s before; the green
   * band is your window, the faint band your good one; no band is drawn over the ball itself:
   * the ring and the bands stay `clear` ball radii out, a band at least `minBand` wide. The ring
   * is a line `line` of its radius thick at `lineOpacity`: `waiting` until you press, `pressed`
   * once you have; the green band is `green`.
   */
  setRing: {
    perSecond: 4,
    atContact: 1.6,
    showFor: 0.9,
    greenOpacity: 0.32,
    goodOpacity: 0.12,
    clear: 1.05,
    minBand: 0.05,
    line: 0.07,
    lineOpacity: 0.95,
    waiting: 0xffb54a,
    pressed: 0xffffff,
    green: 0x3ddc84,
  },
  /**
   * The set bar beside the ball (2K's meter): px tall and wide, the gap (px) from the ball's edge,
   * where the top of the bar (the ideal push) sits as a fraction of its height, and how long
   * (real s) it stays up after the push. `waiting` is its opacity while the pass comes down
   * (empty, showing the window your touch earns); `pipsWidth` (px) is the room the three pips
   * (feet, centred, catch) take to its right. In first person the ball comes down onto your
   * face, so the bar has a fixed place instead: `fpX` px right of the crosshair, its green line
   * level with it.
   */
  // target 0.55: the room above the line (0.12 s of game time) shows Easy's whole late good band (SET_LEVELS)
  setBar: { height: 96, width: 10, gap: 18, target: 0.55, linger: 0.7, waiting: 0.8, pipsWidth: 64, fpX: 56 },
  /**
   * The play wheel (`src/ui/playWheel.ts`): `size` px across with a `hole` px wide centre; the
   * mouse picks a slice once it has moved `dead` px from where the wheel opened, and its pull
   * is capped at `reach` px so a small move back changes the pick.
   */
  playWheel: { size: 384, hole: 184, dead: 24, reach: 80 },
  /**
   * How long (real s) a grade stays up: `perfect` and `other` after most touches. After your own
   * pass or dig (serve receive, defence) it is `pass`, and so is the Receive Drill's pass banner:
   * the play goes on at once and the setter's touch comes about a second later, and the grade sat
   * over it. The player who reported it (2026-11-22) said it "gets in the way of the play".
   */
  grade: { perfect: 1.6, other: 1.2, pass: 0.6 },
  /**
   * Where to stand for the set in first person (`src/ui/setRadar.ts`): a dial `size` px across,
   * `below` px under the crosshair, showing the floor `range` m around your feet.
   */
  setRadar: { size: 92, range: 0.7, below: 86 },
  /**
   * Who your set goes to (`src/fx/setGuide.ts`): a marker `above` (m) the hitter's head, and the
   * set as `points` dots `size` px across, from `skip` of the way along its flight (clear of your
   * hands) to the hitter. It comes up in `fadeIn` s and, once the ball has left your hands, fades
   * over `fadeOut` s (real time) so a set that missed is seen leaving it.
   */
  setGuide: { points: 22, size: 8, skip: 0.14, opacity: 0.8, above: 0.42, fadeIn: 0.15, fadeOut: 0.9 },
  /**
   * Where to stand for the set: a floor spot this wide (m), green once your feet are within
   * `CONTACT.setCentreOk`. When your body is going to jump for it (the jump set) a second ring
   * stands round it, `jumpRing` times as wide, at `jumpOpacity`. The ring is `ring` times its
   * radius across, its line `ringLine` of the texture; a dark outline (`outline` across, `dark` at
   * `darkOpacity`) keeps it readable on bright wood; the disc inside shows at `disc` (off, on the
   * spot) opacity. It is white, `on` once your feet are on it, and fades in and out at `fade`/s.
   */
  setSpot: {
    radius: 0.32,
    jumpRing: 1.5,
    jumpOpacity: 0.6,
    ring: 2.4,
    ringLine: 0.2,
    outline: 2.6,
    dark: 0x05070c,
    darkOpacity: 0.55,
    disc: [0.2, 0.55] as [number, number],
    on: 0x3ddc84,
    fade: 10,
  },
  /**
   * A float breaking (`BALL.float`): a ring pops round the ball where it turns, as wide (m) and
   * as bright as this for the hardest break of a Perfect float, less for a weaker one. From
   * behind the server the ball is 15 m away and a break moves it a ball or two on the screen:
   * the ring says when.
   */
  floatBreak: { size: 0.9, strength: 0.6 },
  /**
   * The block's shadow on their floor (Spike Drill): how wide (m) the outline of each patch is. Picked
   * by eye against the one-pixel line it replaces (src/fx/drillMarkers.ts says why it is not a line):
   * from behind the hitter, some 8 m away, it is about two pixels of a 720-line picture. A court line
   * is 0.05 m, and the outline is thinner so it reads as the patch's edge and not as a line of the court.
   */
  blockShadow: { edge: 0.03 },
  /** where your feet go (the plant spot of an approach): ring radius (m), and the lesson's arrows towards it */
  floorSpot: {
    radius: 0.36,
    /** feet within this far (m) of the spot light it green */
    on: 0.45,
    /** the lesson's arrows from the start of the run to the spot */
    arrows: 5,
    arrowSize: 0.42,
    /** the line to jump from: its size (m), and how close the feet are (m) when it lights green */
    line: { width: 1.1, depth: 0.11, on: 0.4 },
  },
  hitStopPerfect: 0.07,
  /** extra hit-stop for a Perfect at full power (scaled by the ball speed) */
  hitStopPower: 0.035,
  /** a short freeze when a Perfect spike slams the floor */
  hitStopImpact: 0.035,
  hitStopBlock: 0.05,
  /** FOV punch-in (degrees) on a Perfect full-power contact; first person uses fpPunchScale of it */
  fovPunch: 4.5,
  fpPunchScale: 0.55,
  /** camera nod (rad) along the spike on contact, and drop (m) when it slams the floor */
  kickContact: 0.022,
  kickImpact: 0.05,
  /** ball squash (fraction of its diameter) at a Perfect full-power contact / floor slam */
  squashContact: 0.26,
  squashImpact: 0.22,
  shakePerfect: 0.75,
  shakeGood: 0.35,
  shakeBlock: 0.6,
  shakeLand: 0.15,
  sparkCount: 70,
  crackLife: 7,
  replayEnabled: true,
  replaySlow: 0.32,
  /**
   * A replayed sound's playback rate while the replay runs at `replaySlow`: pitched down with the
   * picture (the rate the slow-motion replay always had). At real speed it plays at 1, and in
   * between it follows the replay's speed, so a dig at real speed or REAL SPEED (S) is not pitched down.
   */
  replaySoundSlow: 0.55,
  /** the close angle on a hit (TV, and the last attempt's replay): this far from the hitter (m), with this field of view (degrees) */
  replayClose: { dist: 5.0, fov: 50 },
  replayPre: 0.7,
  replayPost: 0.55,
  /**
   * The replay buffer (s): a whole Mini Rally point fits, serve to ball down (a rally ends by itself
   * at 25 s, `LONG RALLY`). Sized for 70 frames a second, the most `Replay.record` keeps: about 10 MB for
   * twelve athletes.
   */
  replaySeconds: 32,
  /** R held this long (s, real time) replays the whole point; let go sooner, the last attempt */
  replayHold: 0.4,
  /**
   * The whole point (Mini Rally): from `pre` s before the serve's toss (the TV on the server from the
   * first frame: opening earlier, it panned over from the other side of the net) to the ball down, at real
   * speed, slowing to `replaySlow` only for the hits (a spike, a serve) within `slowHold` s of the
   * contact, and back up to speed over `slowRamp` s. Slowing for every dig and landing too made a
   * 7 s rally take 23 s to watch (the player's call: slow for the hits only, and short).
   */
  replayPoint: { pre: 0.1, slowHold: 0.12, slowRamp: 0.3 },
  /**
   * The whole point's TV view: a broadcast camera just past the boards on the long side (`x` m out,
   * `y` m up), panning along the court with the ball (`follow` of its z), with `fov`; and for each
   * attack the close angle beside the hitter (the one R uses) from `attackPre` s before the hit to
   * `attackPost` s after it. The camera glides from one spot to the next at `glide`/s and its aim eases
   * after the ball at `ease`/s: cutting straight there jumped it 13 to 22 m across the hall in a frame.
   */
  replayTv: { x: 10.5, y: 4.5, follow: 0.55, glide: 5, ease: 6, fov: 50, attackPre: 0.6, attackPost: 0.8 },
  /**
   * Your eyes in a replay: from your recorded eye, following the ball like a head turning on a neck,
   * critically damped at `rate` rad/s and never faster than `maxTurn` rad/s (a quick head turn is
   * 200 to 400 degrees a second), so a hard spike gets a moment ahead of it. Exactly where you looked
   * left the ball out of the frame about half the time (the eyes drop on the approach); the player
   * picked this over eyes that keep the ball centred with quick catch-up turns.
   */
  replayEyes: { rate: 9, maxTurn: 6 },
  /** a miss is replayed from further back than a highlight: the plant, the jump and the ball coming in (s) */
  replayMissPre: 1.3,
  /** and for this long after it: the ball going down (s) */
  replayMissPost: 1.0,
  /** the replay of a miss: camera distance beside the player (m) */
  replayMissDist: 5.5,
  /** plus this much per metre the ball was from them (a serve that lands across the court) */
  replayMissSpan: 0.5,
  /** it stands on the side away from the ball when the ball was at least this far to one side (m) */
  replayMissSide: 0.5,
  /** and never further out than this (m): in front of the boards (x = 9.1) */
  replayMissMaxX: 8.8,
  /** it looks at the player's chest (fraction of their height) ... */
  replayMissChest: 0.6,
  /** ... leaning this share of the way to the ball ... */
  replayMissLeadShare: 0.5,
  /** ... but no further than this (m): the player never leaves the frame */
  replayMissLead: 1.5,
  /** the most of that lead that may be upwards (m): their feet stay in the frame under a high ball */
  replayMissLeadUp: 0.5,
  /** a press this soon after the player's own touch is a habit (a double click), not a new attempt (s) */
  attemptOwnGap: 1,
  bloomStrength: 0.85,
  bloomRadius: 0.55,
  bloomThreshold: 1.0,
  intensity: 1.0,
};

export const AUDIO = {
  master: 0.8,
  sfx: 1.0,
  crowd: 0.55,
  /**
   * Your set loading in your hands: a soft tone rising from `f0` to `f1` (Hz) with the bar,
   * reaching `f1` as the bar reaches the green line, so the push can be timed by ear. `gain` is
   * its level at the top (it starts at `start` of that); held past the top it dies away within
   * `over` of the load again.
   */
  setLoad: { f0: 392, f1: 784, gain: 0.035, start: 0.35, over: 0.4 },
  /** the referee's whistle that lets the server serve: a short blast (s held), against the rally's end */
  whistleShort: 0.16,
  /**
   * Hands between points: a clap and a five's slap, each a burst of noise through a band-pass at
   * `f` (Hz, sharpness `q`) dying away over `dur` s, at `gain` for a player beside you (quieter the
   * further away: gone at `far` m). A five is sharper and louder than a clap (two hands flat, hit
   * hard); a cupped clap is lower. Tuned by ear.
   */
  hands: {
    clap: { f: 1350, q: 1.3, dur: 0.07, gain: 0.22 },
    five: { f: 2100, q: 0.9, dur: 0.055, gain: 0.34 },
    far: 22,
  },
};
