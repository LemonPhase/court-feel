/**
 * Court Feel — every tunable number lives here.
 *
 * Units: metres, seconds, kilograms, radians unless the name says otherwise.
 * Coordinate frame: Y up. Net plane is z = 0. The user's team plays on +z and
 * faces -z (towards the net). Facing -z, the player's right hand is +x.
 */

export const COURT = {
  length: 18,
  width: 9,
  halfLength: 9,
  halfWidth: 4.5,
  attackLine: 3,
  lineWidth: 0.05,
  netHeightMen: 2.43,
  netHeightWomen: 2.24,
  /** vertical size of the net mesh (top band to bottom band) */
  netDepth: 1.0,
  /** the net extends a little past the sidelines */
  netHalfLength: 5.0,
  /** antennae sit on the outer edge of the side bands, directly above the sidelines */
  antennaX: 4.5 + 0.05,
  antennaAboveNet: 0.8,
  antennaRadius: 0.005,
  postX: 5.5,
  postRadius: 0.055,
  /** free zone around the court that is still "floor" */
  freeZoneSide: 4,
  freeZoneEnd: 6.5,
  /** arena walls (ball dies when it reaches these) */
  arenaHalfX: 15,
  arenaHalfZ: 21,
  ceiling: 12.5,
} as const;

export const BALL = {
  radius: 0.105,
  mass: 0.27,
  gravity: 9.81,
  airDensity: 1.2,
  /** drag coefficient. Real volleyballs sit ~0.2-0.3 at spike Reynolds numbers: they are past the drag crisis, so not the 0.47 of a smooth sphere */
  dragCoefficient: 0.26,
  /** multiplier on the physically derived Magnus force (1 = Cl ~ r*w/v) */
  magnusScale: 1.0,
  /** spin decays with this time constant */
  spinDecayTime: 3.0,
  floorRestitution: 0.66,
  floorFriction: 0.32,
  /** The net is a soft mesh: the ball sinks into it, dies and drops down the net, as a ball
   * driven into a real net does (it comes out within about a metre of it, not bounced back off a
   * wall). The net is drawn static, so the give is kept within the ball's radius. */
  netGive: 0.08,
  /** the mesh's spring (rad/s) and its damping ratio (> 1: it eases the ball back out, no bounce) */
  netStiffness: 35,
  netDampingRatio: 1.5,
  /** ...and only part of that damping (this share) as it pushes the ball back out, so a hard ball pops
   * out a little (about half a metre) while a soft one drops down the net */
  netReturn: 0.3,
  /** what is left of the ball's speed into the net once the mesh is taut */
  netRestitution: 0.1,
  /** the mesh grips the ball: its sideways and upward speed die at this rate (1/s) while it is in */
  netGrip: 18,
  /** the top cable/tape is stiff from above (a ball can roll over it); hit from the side the net
   * swings back with it, so its bounce blends down to `netRestitution` */
  tapeRestitution: 0.38,
  tapeRadius: 0.035,
  antennaRestitution: 0.55,
  postRestitution: 0.5,
  wallRestitution: 0.4,
  /** if knuckle > 0, low-spin serves get a slight wobble */
  floatWobble: 0.9,
} as const;

export const SIM = {
  hz: 120,
  /** clamp for very long frames so we do not spiral */
  maxFrameDt: 0.1,
  /** how far ahead the ball predictor looks (s) */
  predictHorizon: 4.0,
};

export type PositionId = 'OH' | 'OPP' | 'MB' | 'S' | 'L';

export interface PositionStats {
  id: PositionId;
  name: string;
  short: string;
  blurb: string;
  height: number;
  /** jump (approach) height above standing reach */
  jump: number;
  /** standing jump as a fraction of approach jump */
  standingJumpFrac: number;
  /** top approach / sprint speed */
  approachSpeed: number;
  shuffleSpeed: number;
  accel: number;
  /** power multiplier for spikes */
  power: number;
  /** passing/defence skill (reduces pass error) */
  ballControl: number;
  /** jersey colour for libero override etc. */
  jersey?: number;
}

export const POSITIONS: Record<PositionId, PositionStats> = {
  OH: {
    id: 'OH',
    name: 'Outside Hitter',
    short: 'OH',
    blurb: 'Left-side attacker. High balls, big swings, passes serve too.',
    height: 1.95,
    jump: 0.86,
    standingJumpFrac: 0.66,
    approachSpeed: 5.3,
    shuffleSpeed: 3.3,
    accel: 15,
    power: 1.0,
    ballControl: 0.75,
  },
  OPP: {
    id: 'OPP',
    name: 'Opposite',
    short: 'OPP',
    blurb: 'Right-side weapon. Biggest jump and power, blocks the outside.',
    height: 1.99,
    jump: 0.9,
    standingJumpFrac: 0.66,
    approachSpeed: 5.2,
    shuffleSpeed: 3.2,
    accel: 14.5,
    power: 1.08,
    ballControl: 0.6,
  },
  MB: {
    id: 'MB',
    name: 'Middle Blocker',
    short: 'MB',
    blurb: 'Tallest. Quick tempo attacks and reading blocks along the net.',
    height: 2.04,
    jump: 0.82,
    standingJumpFrac: 0.72,
    approachSpeed: 4.8,
    shuffleSpeed: 3.6,
    accel: 16,
    power: 0.95,
    ballControl: 0.5,
  },
  S: {
    id: 'S',
    name: 'Setter',
    short: 'S',
    blurb: 'Runs the offence. Sets every second ball, dumps when it is open.',
    height: 1.9,
    jump: 0.74,
    standingJumpFrac: 0.7,
    approachSpeed: 5.0,
    shuffleSpeed: 3.6,
    accel: 17,
    power: 0.82,
    ballControl: 0.95,
  },
  L: {
    id: 'L',
    name: 'Libero',
    short: 'L',
    blurb: 'Back-row defender. Fastest feet, cleanest passing, different jersey.',
    height: 1.82,
    jump: 0.66,
    standingJumpFrac: 0.7,
    approachSpeed: 5.6,
    shuffleSpeed: 4.0,
    accel: 19,
    power: 0.75,
    ballControl: 1.0,
  },
};

/** the user's own body, customisable per position in the settings: height, vertical (approach) jump and spike power */
export interface BodyOverride {
  height: number;
  jump: number;
  power: number;
}

/** slider ranges for the custom body (values outside are clamped, also when loaded from storage) */
export const BODY = {
  height: { min: 1.6, max: 2.2, step: 0.01 },
  /** approach jump above standing reach (the position's standing jump keeps its fraction of it) */
  jump: { min: 0.4, max: 1.1, step: 0.01 },
  /** spike power multiplier: 1 = a Perfect full-power spike leaves the hand at CONTACT.spikePerfect */
  power: { min: 0.6, max: 1.3, step: 0.01 },
};

export const PLAYER = {
  /** ground movement */
  decel: 20,
  backpedalScale: 0.72,
  sideScale: 0.92,
  airControl: 0.6,
  /** fraction of horizontal approach speed kept through the plant */
  plantCarry: 0.38,
  /** two players meet at this distance (m, centre to centre) when their shoulders touch: team-mates at the net (a closing middle drifting into its pin blocker) stop there */
  shoulder: 0.5,
  /** jump load (Space hold) */
  loadMin: 0.09,
  loadMax: 0.3,
  /** jump height weighting: how much comes from approach speed vs load */
  jumpFromApproach: 0.55,
  jumpFromLoad: 0.45,
  /** gravity multiplier near the apex: a little hang time */
  apexGravityScale: 0.82,
  apexBand: 1.1,
  landRecover: 0.2,
  /**
   * A dive (AI defenders, at a ball the platform can't reach on foot): the body goes hands-first
   * along the floor at `diveSpeed` m/s or the run's speed, sliding to a stop at `diveDecel` m/s²; the
   * hands are at full stretch, `diveArm` m past the feet and `CONTACT.diveLow` m off the floor,
   * `diveDown` s after it starts, and the player is up again after `diveTime` s. With a run-up that
   * is a ball about 2-2.5 m away dug off the floor (a sprawl or a pancake).
   */
  diveSpeed: 3.5,
  diveDecel: 6,
  diveArm: 1.0,
  diveDown: 0.3,
  diveTime: 1.1,
  bodyTurnRate: 14,
  /**
   * airborne: max body rotation from the takeoff yaw, and its rate. In the air the arm aims,
   * not the hips: with a free turn, aiming cross-court swung the contact point away from the
   * ball and the timing felt random.
   */
  airTurnMax: 0.35,
  airTurnRate: 4,
};

export const TIMING = {
  /** input buffer for actions pressed slightly early */
  bufferWindow: 0.12,
  /** spike: swing time from release to contact for an uncharged arm */
  swingNominal: 0.1,
  /** a fully drawn arm whips through faster: the ideal release is a little later */
  swingCharged: 0.09,
  swingMin: 0.045,
  swingMax: 0.17,
  /** spike grade windows on the release error: early side ... */
  spikePerfect: 0.03,
  spikeGood: 0.07,
  /**
   * ... and a more forgiving late side: releasing as the ball arrives is the natural instinct,
   * and a browser's input and display latency lands on that side too
   */
  spikePerfectLate: 0.07,
  spikeGoodLate: 0.11,
  spikeOk: 0.15,
  /** attack button held shorter than this => tip/roll instead of a swing */
  tapThreshold: 0.09,
  /**
   * wind-up hold (s) that reaches full swing power: short enough that a full-power swing fits
   * in any jump. Power comes from the hold and timing from the release. Holding longer is never
   * penalised directly: the risk is holding until the ball is out of reach, or landing first.
   */
  chargeFull: 0.32,
  /** lookahead for the ideal contact search */
  contactLookahead: 0.55,
  /** passing: ideal time between pressing E and the ball arriving */
  passLead: 0.26,
  passPerfect: 0.1,
  passGood: 0.2,
  /** digs (fast incoming balls): shorter ideal lead, similar windows */
  digLead: 0.13,
  digPerfect: 0.07,
  digGood: 0.15,
  setLead: 0.18,
  setPerfect: 0.08,
  setGood: 0.16,
  /** block: fraction of max jump height at contact */
  blockPerfectHeight: 0.88,
  blockGoodHeight: 0.66,
  blockArmTime: 0.12,
};

export const CONTACT = {
  /** sphere around the ideal contact point that still lets you hit */
  spikeReach: 0.38,
  spikeReachStretch: 0.62,
  passRadius: 0.55,
  setRadius: 0.48,
  /**
   * half-width of the block's hands along the net (ball centre within this + ball radius).
   * Matches the pose: wrists ~0.15 m off the midline plus a palm, so the gap between the
   * arms is under one ball wide and the ball goes round, not through, a block that misreads.
   */
  blockHalfWidth: 0.22,
  blockHeight: 0.55,
  /** a blocker reaching sideways (`Athlete.reachX`) gets its hands this much (m) lower per metre of reach */
  blockReachDrop: 0.5,
  /**
   * A ball that meets a block past `toolEdge` of the hands' half-width, on the side away from the
   * middle of the court, is wiped off the block (tooled wide) `toolEdgeP` of the time, however
   * well the block was timed: hitters aim at the outside hand for it.
   */
  toolEdge: 0.6,
  toolEdgeP: 0.7,
  /**
   * Playability (bent on purpose; the defence is strong and hitting is hard enough): the user's
   * spike is wiped off an AI block more often, from `userToolEdge` of the hands' half-width out,
   * `userToolEdgeP` of the time.
   */
  userToolEdge: 0.45,
  userToolEdgeP: 0.85,
  /** speeds (m/s) */
  spikePerfect: 30,
  spikeGood: 26,
  spikeOk: 19,
  /** topspin (rad/s) */
  spikeSpinPerfect: 70,
  spikeSpinGood: 55,
  spikeSpinOk: 35,
  rollSpin: 45,
  /** swing power at the shortest (just past a tap) wind-up; full charge = 1 */
  chargePowerMin: 0.7,
  serveFloatSpeed: 17,
  serveJumpSpeed: 24,
  serveJumpSpin: 50,
  /**
   * a jump serve met early (the hand under the ball) keeps its line and speed but loses its
   * topspin: it flies flat and sails long rather than looping up (this share of `serveJumpSpin` is left)
   */
  serveEarlySpin: 0.35,
  /** pass target error (m) by grade */
  passErrPerfect: 0.15,
  passErrGood: 0.6,
  passErrOk: 1.6,
  /**
   * The pass error grows with the ball's speed (x (1 + `passSpeedErr`) for a ball arriving at 22 m/s
   * or more, from 12 m/s up) and with the passer still moving (x (1 + `passMoveErr`) at a full run):
   * faster jump serves give clearly worse receptions (pro men, Masaryk University 2024).
   */
  passSpeedErr: 1.5,
  passMoveErr: 1.0,
  /** a hard-driven ball (passing or digging) gives this much extra reach (m): a lunge, the same for the AI and you */
  digLunge: 0.12,
  /**
   * Pass forms other than the platform in front. Sideways: the arms swing the platform out to one
   * side (`sideReach` m) without the feet getting there; it is never Perfect and its error is x
   * `sideErr`. A dive digs the ball `diveLow` m off the floor, never better than Good, error x
   * `diveErr` (the ball goes up, roughly at the setter: keeping it alive is the job). Overhand (the
   * hands, a first ball that comes down at head height): x `handsErr` the platform's error, and a
   * ball faster than `handsMaxSpeed` m/s is too hard to play with the hands (the AI digs it).
   */
  /**
   * Recycling: a soft ball (under `recycleSpeed` m/s: a roll shot, a tip, an easy swing) played into
   * a well-formed block (Good or Perfect, not off the outer edge) comes back off the hands to the
   * hitter's side `recycleP` of the time (off a mistimed block `recyclePLate`), slow and up, for their
   * cover to pick up and attack again.
   * A covered ball (one off the other team's block) is dug up high (`covered.apex` m) to the middle
   * of the court `covered.off` m off the net (+ up to `covered.depth`), `covered.spread` m either way:
   * out of system, never Perfect. Keeping it alive is the job; the set off it is a high ball.
   */
  recycleSpeed: 14,
  recycleP: 0.75,
  recyclePLate: 0.45,
  /** an AI hitter playing it off the block pushes it at the hands at `pushSpeed` m/s, `pushDrop` m below the contact */
  pushSpeed: 7,
  pushDrop: 0.4,
  covered: { off: 3.2, depth: 1.5, spread: 1.6, apex: 5.8 },
  /**
   * The AI never misses a serve (no serve out, none in the net): a mistimed AI serve is a slower,
   * easier serve that still lands `serveSafe` m inside the lines. Only the user can fault a serve.
   * One its aim still can't get over the tape goes up `serveSafeApex` m above the contact or the
   * tape, whichever is higher: slower, but over.
   */
  serveSafe: 0.6,
  serveSafeApex: 1.0,
  sideReach: 0.6,
  sideErr: 1.4,
  diveLow: 0.25,
  diveErr: 2.2,
  handsErr: 0.7,
  handsMaxSpeed: 15,
  /**
   * Shanks: a ball arriving at 22 m/s or more (from 12 m/s up) off a mistimed platform (Late / Early;
   * `shankGood` as likely off a Good one), or off the edge of it, is shanked `shank` of the time: it
   * leaves the arms at a bad angle, at `shankSpeed` times the speed it came in, usually out of play:
   * still going the way the ball came, up to `shankTurn` rad off its line either way (straight on
   * into the stands behind, or wide to the side).
   * Playability (bent on purpose): an AI defender who gets to the user's hard spike (over 14 m/s)
   * shanks it at least `userSpikeShank` of the time, however well timed. Real defenders dig more of
   * them, but with the strong AI defence the user's kills were too hard to come by.
   */
  shank: 0.15,
  shankGood: 0.3,
  shankSpeed: [0.35, 0.6] as [number, number],
  shankTurn: 1.7,
  userSpikeShank: 0.6,
};

export const ASSIST = {
  /** 0..1 default aim assist strength */
  aim: 0.55,
  /** max horizontal mid-air nudge (m/s) at assist 1 */
  airMagnet: 1.2,
  /** reach bonus (m) at assist 1 */
  reachBonus: 0.22,
  /** slow-mo assist (settings toggle): timescale while lining up a contact, and how early it kicks in */
  slowmoScale: 0.55,
  slowmoWindow: 0.35,
};

export const CAMERA = {
  fov: 72,
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

/** touch controls (phones / tablets): a joystick for the feet, the right half of the screen for the aim, hold buttons for the body */
export const TOUCH = {
  /** aim: a thumb travels far less than a mouse, so a drag turns this many times faster than mouse pixels (times the touch sensitivity setting) */
  lookScale: 2.6,
  /** a touch that starts on a button has to travel this far (px) before it also drags the aim */
  lookDeadZone: 7,
  /** joystick radius (px) for full deflection; a floating stick appears under the thumb */
  stickRadius: 56,
  /** deflection below this is a dead zone */
  stickDead: 0.1,
  /** push the stick past this deflection to approach / sprint (the outer ring), drop below `sprintOff` to stop running */
  sprintOn: 0.84,
  sprintOff: 0.6,
  /** while loading a jump or in the air, a touch anywhere on the right half winds up the arm (the thumb does not have to find HIT) */
  airHitAnywhere: true,
  /** rolling the thumb from JUMP onto HIT without lifting takes off and starts the wind-up */
  rollToHit: true,
  /** a hands-up block also loads a jump (release to take off); when the ball is dropping onto you the same button sets instead */
  blockJumps: true,
};

/**
 * The first-run lesson (game/tutorial.ts). Three reps of the Outside high ball, with less help
 * each time: together (the ball waits for you), slow motion (you drive, nothing waits), full
 * speed. Speeds are fractions of real time. None of this touches the grading windows.
 */
export const TUTORIAL = {
  /** the welcome line, before the first toss (s, real time; any key moves on) */
  welcome: 2.2,
  /** the coach's line after a rep (s, real time; any key moves on after `resultMin`) */
  result: 3.6,
  resultMin: 1,
  /** together: the set in flight before your run, your run, the plant, and in the air */
  watchScale: 0.6,
  runScale: 0.7,
  plantScale: 0.5,
  airScale: 0.35,
  /** together: time eases down over this long (s, game time) into a moment you have not acted on yet, to no slower than `crawl` of the speed */
  easeLead: 0.16,
  crawl: 0.25,
  /** a cue shows this long (s, game time) before its moment */
  cueLead: 0.45,
  /** when you drive, a cue shows a reaction time (s, game time) before its moment, so acting on it is on time */
  reactLead: 0.12,
  /** together: you rise this long (s, game time) before the arm cue */
  drawDelay: 0.07,
  /** together: the ball is held this late (s) in the Perfect window for your release */
  sweetErr: 0.015,
  /** together: the coach aims your swing this deep (m) into their court, straight down your line */
  aimDepth: 6.5,
  /** slow motion rep: the speed from the set to your landing */
  slowScale: 0.6,
  /** tries at the together rep, the slow rep and the full-speed rep before the lesson moves on anyway */
  tries: 2,
  /** back from a pause, a release of the attack button within this long (s, real time) is the click that took the pointer back, not a swing */
  resumeGrace: 0.4,
  /** nothing pressed for this long (s, real time) while the ball waits: the cue pulses harder and Skip lights up */
  nudge: 6,
  /** a rep where you moved less than this (m) from the start never ran */
  ranDist: 1,
};

/** how the athletes are drawn (never how they play) */
export const CHARACTER = {
  /** soft light on the edges of a figure that face up and away from the camera (0 = off) */
  rim: 0.55,
  /** how strongly the arena reflects in skin, cloth and shoes */
  envIntensity: 0.7,
  /** finger curl at the knuckles (rad): loose hand, cupped for a set, flat on the ball, closed for a pass */
  fingerCurl: { relaxed: 0.5, cupped: 0.28, firm: 0.04, fist: 1.15 },
  /** a spiking palm meets the ball this far over the top of it (0 = square behind the line it leaves on) */
  palmOverTop: 0.3,
  /** a pass meets the forearms this far up from the wrists (fraction of the forearm); forearm thickness in body heights */
  platformContact: 0.42,
  forearmRadius: 0.018,
  /** a setter's hands follow the ball this far (m) after the release, for this long (s) */
  setFollow: { reach: 0.2, time: 0.2 },
  /** blocking hands go to the ball once it is within `near` (m) of them, at most `pull` (m) from where the block was set */
  blockReach: { near: 0.3, pull: 0.16 },
  /**
   * Arms and the net. Below the tape a wrist stays `wrist` (m) and the fingertips `fingers` (m) on the
   * athlete's own side. From `above` (m) over the tape a hand may reach across, `reachPerHeight` metres
   * for each metre of height. Nothing applies further than `pastPost` (m) outside the net's ends.
   */
  netClear: {
    wrist: 0.09,
    fingers: 0.035,
    above: 0.04,
    reachPerHeight: 1.6,
    pastPost: 0.25,
    /** the head keeps this far (m) from the net: a forward lean is cut short. Its height and its lever over the hips, in body heights. */
    head: 0.17,
    headHeight: 0.86,
    headLever: 0.36,
  },
};

export const FX = {
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
  trailLength: 28,
  crackLife: 7,
  replayEnabled: true,
  replaySlow: 0.32,
  replayPre: 0.7,
  replayPost: 0.55,
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
  /**
   * A button pressed with no ball near is not a rep: an action that never met the ball counts as
   * an attempt only if the ball came this close to where it would have met it (m, about one step and a reach)
   */
  attemptRange: 3,
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
};

export const AI = {
  reactionTime: 0.18,
  /**
   * Mini Rally team-mates give way (`src/ai/giveWay.ts`): a player walking to a spot keeps `room` m
   * (centre to centre) from the others, looking `ahead` s along both paths, steering off with up to
   * `push` times its own command, and never steps towards a team-mate closer than `touch` m. Whoever
   * plays the ball (or the user) keeps their line; two walkers share it, passing on the right.
   */
  giveWay: { room: 0.9, ahead: 0.5, push: 1.5, touch: 0.6 },
  /**
   * Mini Rally defenders split-step on the other team's set: a `dip` s load, then `air` s off the floor
   * (0.2 s is a ~5 cm hop), landing on their hitter's contact into a deeper stance for `settle` s
   * (tennis players reached a ball ~0.1 s sooner with one). For now it is only the body's movement,
   * not a faster reaction.
   */
  splitStep: { dip: 0.08, air: 0.2, settle: 0.3 },
  /**
   * Mini Rally perimeter defence (`src/ai/defence.ts`): where each defender reads to as their set
   * flies, in metres. Coaching sources give the line digger ~1 m inside the sideline and ~6 m deep,
   * and the off-blocker "10 x 10 ft" (~3 m off the net, ~3 m in); the rest is inferred (AI-movement
   * notes, section 9). Defenders act on the set `react` s after it (± `reactSd`), with a read of
   * where it goes that starts `readErr` m off, and on a hit `hitReact` s after it (± `hitReactSd`).
   */
  defence: {
    react: 0.25,
    reactSd: 0.05,
    readErr: 0.9,
    hitReact: 0.22,
    hitReactSd: 0.04,
    /** a pin attack is further than this from the middle of the net; a back-row one further than `backOff` off the net */
    pinX: 1.6,
    backOff: 1.6,
    /** line digger: this far inside the sideline, this deep */
    lineIn: 1.0,
    digDepth: 5.75,
    /** cross digger: this far outside the inside blocker's shadow, and at least `sideIn` inside the sideline */
    crossOutside: 0.5,
    sideIn: 1.0,
    /**
     * Middle back: against a closed block it stays deep at `middleBack` (the end line is 9 m: feet
     * just inside), `middleBackCross` m to the cross side of the block's inside edge, no further than
     * `middleBackMaxX` from the middle (MatusGib: deeper, around 9 m, beside a closed block). Against a
     * block that leaves a seam it steps up onto the seam's line at `middleBackSeam`: a ball through a
     * seam is a hard, straight ball that lands shorter than a deep cross shot over a closed block
     * (MatusGib, 2026-11-10).
     */
    middleBack: 8.8,
    middleBackSeam: 7.0,
    middleBackCross: 1.0,
    middleBackMaxX: 3.0,
    /** off-blocker: this far off the net, this far in from its sideline */
    offOff: 3.0,
    offIn: 3.0,
    /** our blockers on a pin set: the pin blocker shades this far outside the attack (the middle closes `AI.middle.closeGap` inside it); a blocker's hands reach this far either side */
    shade: 0.25,
    handHalf: 0.325,
    /** against the quick: the middle back cheats up a little, to this depth */
    quickMiddleBack: 7.5,
    /** against a pipe: the corners step in and forward to here (x from the middle, depth), the middle back to this depth */
    pipeCornerX: 2.2,
    pipeCornerZ: 5.3,
    pipeMiddleBack: 8.0,
  },
  /**
   * Early transition: on an easy first ball (their free ball over, or our block softening their
   * attack to under `softSpeed` m/s) that our passer reaches with `spare` s to spare, the setter
   * releases to the net and the front row leaves it to approach, `read` s after the touch.
   *
   * On their hard attack (a spike or tip) the back-row setter also releases to the net on its own,
   * as soon as it has read the hit (`AI.defence.hitReact`) and our dig is assigned to someone else
   * "The setter releases from their defensive position immediately to run the offense"
   * (FreeCoachingDrills, transition attack tempo drill).
   *
   * The front row transitions after every block: once a blocker is back on the floor and has read
   * the hit (`AI.defence.hitReact`), a ball that stays on our side (by the block, off it, a tip)
   * sends every front-row player who isn't playing it off the net to their approach start; one
   * our block sends back over keeps them at the net to block again. A hitter starts a quick or a
   * fast set only from at least `approachOff` m off the net: a middle who blocked gets off the net
   * first and comes in with a real approach, never a standing quick ("land, turn and get off the
   * net": USA Volleyball, blocking transition footwork).
   */
  transition: { read: 0.3, softSpeed: 10, spare: 0.3, approachOff: 2.0 },
  /**
   * An overpass: our first ball comes down to the setter's hands `overpass` m or more into their
   * court. The setter reads it as it goes up, doesn't chase it and calls nothing; the front row
   * waits at the net for their play on it. (A tight pass just over the tape is still played.)
   */
  overpass: 0.25,
  /**
   * Who takes a ball (serve receive, a dig, a free ball): the team-mate who gets there first. The
   * first `shuffle` m are shuffled, the rest run, so further away is never quicker. A ball in the
   * seam (one that two get to within `seam` s of each other, about 0.7 m of running) is the
   * libero's or the user's: one preference, never both added up, so the user is never sent to a
   * ball a team-mate is standing next to. The setter is sent only when nobody else gets there
   * within `setter` s of it: a ball at its feet it digs, and someone else sets. A ball off a block,
   * or a second ball the setter can't get to, is the libero's whenever it gets there with `libero` s
   * to spare: it calls off whoever was sent (a real libero takes every one of those it can).
   */
  pick: { seam: 0.15, setter: 0.2, shuffle: 1.5, libero: 0.1 },
  /**
   * An AI free ball over (a third ball nobody can attack) goes where it is hard to play: deep to a
   * back corner (`deep` m off the net, `side` m off the middle) or short, just over the net (`short`
   * m), whichever spot their nearest player is furthest from (plus up to `guess` m of guesswork).
   * `apex`/`shortApex`: the arcs.
   */
  freeOver: { deep: 7.3, short: 2.0, side: 2.8, apex: 5.0, shortApex: 4.0, guess: 1.0, aimSpeed: 2.0 },
  /**
   * The libero's set (a backup set: the setter dug the first ball or can't get to it) is as good as
   * the ball lets it be. Its difficulty (0-1, never under `base`) grows as the time to spare drops
   * under `easy` s and as it is played further than `offEasy` m from the setter's spot (1 at
   * `offEasy` + `offHard` m). Over `noSet` (give or take half of `noSetJitter`) it doesn't try a
   * set: it bumps the ball up high to the 3 m line. A set it does try misses its target by `miss`
   * m (along the net, off the net, apex: one sigma) times the difficulty. A set to the user is always
   * clean (playability: the user's sets stay perfect).
   */
  backupSet: { base: 0.2, easy: 0.8, offEasy: 3.0, offHard: 6.0, noSet: 0.7, noSetJitter: 0.3, miss: { x: 1.2, z: 0.5, apex: 0.8 } },
  /**
   * An AI dive (Mini Rally) keeps the ball alive and no more: it goes `apex` m above the hands (plus
   * the dive's own metre) and `carry` m toward the middle of the court, for a team-mate running with
   * the diver to play. (A free ball over is aimed, `freeOver`, only by a player moving slower than
   * `freeOver.aimSpeed` m/s: one still scrambling just gets it over.)
   */
  diveUp: { carry: 2.0, apex: 1.8 },
  /**
   * Covering our hitter, `read` s after our setter sets, low and facing the net, so a ball blocked
   * straight down is dug back up. The spots are the real ones (3-2 coverage: CoachingVB, hitter
   * coverage strategy; US Sports Camps, how to cover your hitter). On an attack from a pin the
   * three close are the middle at the net (`net` m off it, `inside` m inside the hitter), the
   * setter on the 3 m line (`line` m) between them, and the back-row player on that side `behind`
   * m behind the hitter by the sideline (on the right the setter has left right back, so the middle
   * back comes over); the other two split the deep court (`deep` m), one down the line, one cross
   * court. A middle attack is covered like a middle attack is defended: the setter close behind,
   * the two pins on the 3 m line either side, the back row stays. A back-row attack: the middle
   * under the block, the setter and the left back close. They hold it until the attack is over the
   * net, then go back to base defence. Low and watching the hands, a coverer reacts to a ball off
   * the block in `react` s (a defender reading a hit: 0.3 s).
   */
  cover: { read: 0.2, net: 1.2, inside: 1.3, line: 3.0, behind: 2.5, deep: 6.3, react: 0.12 },
  /**
   * An AI hitter's swing timing is off by this much (s, 1 sd) plus 0.06 x (1 - skill): Early sails
   * long, Late goes into the net, Good scatters the shot. Men's pros still miss: about 62% kills at
   * 47% efficiency off a perfect pass (PlusLiga), so with ~10% of attacks blocked, roughly 5-8% are
   * hit out or into the net.
   */
  attackErr: 0.06,
  /** opponent hitter skill 0..1 */
  hitterSkill: 0.8,
  blockerSkill: 0.5,
  /**
   * The Mini Rally middle blocker (`src/ai/middle.ts`). It acts on a touch (their pass, their set)
   * `react` s after it (± `reactSd`, 1 sd). Its read of where the set is going is `readErr` m off
   * along the net at the setter's touch (1 sd), an error that shrinks to nothing as the ball gets to
   * the hitter. It watches the setter's hands (coaching: the middle's eyes are on the setter), so it is
   * off 0.12 s after the touch: at 0.24 s an in-system high ball left a 0.12-0.65 m seam 11 times in
   * 12, at 0.12 s 2 times in 12, 1-5 cm wide (AI movement 4, in the pull request).
   */
  middle: {
    react: 0.12,
    reactSd: 0.04,
    readErr: 0.9,
    /** on a good pass with their middle coming in: how often it commits on the quick (jumps with their middle), or cheats towards a pin */
    commit: 0.1,
    cheat: 0.1,
    /** how far (m) a cheat leans towards the guessed pin before the set */
    cheatShift: 0.8,
    /** lines up across from their middle, no further than this (m) from the middle of the net (a spread block: both pins in reach) */
    lineUpMax: 0.3,
    /**
     * An attack further than this (m) from the middle of the net is a pin set: the middle closes on
     * our pin blocker, `closeGap` m inside it (centre to centre). A blocker's hands stop a ball within
     * `AI.defence.handHalf` (0.325 m) of them, so 0.6 leaves no seam: a seam is the middle being late.
     */
    pinX: 1.6,
    closeGap: 0.6,
    /** late, it still jumps from up to this far (m) from where it wanted to be (a block with a gap); further away it stays down */
    lateReach: 2.2,
    /** in the air its hands stretch towards where it wanted to block, up to this far (m) to the side of the body, getting there in about `reachTime` s */
    reach: 0.4,
    reachTime: 0.12,
  },
  defenderSkill: 0.7,
  setterAccuracy: 0.15,
  /**
   * Mini Rally: the setter reads the pass this long (s) after it is played and calls it
   * ("HIGH!" when it is out of system). The call is the decision: the set follows it, and is
   * never swapped silently at the touch. A hitter can only adjust a fast approach if they
   * know about a second ahead.
   */
  setterRead: 0.2,
  /**
   * Who the Mini Rally setter sets (weights, the hitters who can take a set): the outside most,
   * then the opposite, the middle's quick off a good pass (`quickWeight`), the pipe now and then,
   * hardly ever off a bad pass. Elite men put about half their attacks through zone 4, a quarter
   * through zone 2, an eighth through the middle and a tenth from the back row (2011 World League,
   * Laporta et al. 2015, J Hum Kinet 47: zone 4 52%, zone 2 26%, zone 3 12%, back row 9%;
   * NCAA DI men 2025-26: quicks 13%, the pipe 5%, the D ball 9%). Measured on the all-AI rally:
   * outside 52%, opposite 25%, middle 15%, pipe 8% (213 attacks; in the pull request).
   */
  setWeight: { outside: 2.0, opposite: 1.0 },
  /**
   * AI first balls overhand: a ball still under `maxSpeed` m/s when it comes down at head height (a
   * free ball, a float serve, a soft block) is played with the hands `share` of the time, if the player
   * can get under it: within `maxRun` m, at no more than `pace` x their top speed. A float serve comes
   * down through head height a couple of metres in front of where it would be dug, so the passer steps
   * up to it and takes it high (legal: FIVB rule 9.2.3.2 lets a team's first hit touch the body more
   * than once in one action). Harder or further balls take the platform.
   */
  overhand: { share: 0.7, maxSpeed: 15, maxRun: 2.6, pace: 0.6 },
  /**
   * an AI defender runs at a ball and dives for it when the platform would need over `late` x their
   * top speed to get there in time and it is over `minDist` m away (closer, the platform swings out to it).
   * The dive starts when the hands would land within `fit` m of where the ball comes down low, or
   * up to `stretch` m short of it: a last-ditch dive at a ball just beyond the hands, which the
   * contact system grades by how close it really got (at the edge of the platform: a scrape, up and
   * not much more).
   */
  dive: { late: 0.9, minDist: 1.0, fit: 0.35, stretch: 0.6 },
  /** an AI setter whose ball has dropped this far (m) below their standing hands, not under them, digs it instead (platform or dive) */
  lateSet: 0.15,
  /** a ball the defender sent for would reach with less than this (s) to spare: a team-mate runs at it too */
  scramble: 0.1,
  pipe: { inSystem: 0.35, outOfSystem: 0.1 },
  /**
   * Mini Rally serves (`src/ai/server.ts`). `jump` of the serves are jump serves: the server starts
   * `jumpBack` m behind the end line, walks `jumpStep` m into the toss, tosses the ball `jumpTossHigh` m over their standing reach
   * (about 1.3 m over the contact: the toss drops into a three-step run-up, not out of the sky) and
   * `jumpToss` m forward (where it would come back down to toss height), runs in, takes off behind
   * the line and lands in the court (FIVB rule 12.4.3); the rest are standing floats. The target is the seam between two passers,
   * deep in zone 1 or 5 (`deepIn` m inside the corner), short (`shortZ` m off the net, floats only)
   * or at a passer, weighted `seam` / `deep` / `short` / `body`, `spread` m (1 sd) around it before
   * the server's own error: their swing timing is off by `floatErr` / `jumpErr` s (1 sd), never more
   * than `errMax` s (a server always gets a hand on their own toss: a mistimed serve is hit early,
   * long, or late, into the net, it is not whiffed). The jump
   * serve is the riskiest serve: it misses most (FIVB beach: over 20% of jump serves are errors;
   * men's indoor studies: the jump serve has the highest error rate).
   */
  serve: {
    jump: 0.6,
    jumpBack: 4.5,
    jumpStep: 0.8,
    jumpToss: 4.6,
    jumpTossHigh: 2.0,
    floatErr: 0.07,
    jumpErr: 0.1,
    errMax: 0.14,
    seam: 0.45,
    deep: 0.25,
    short: 0.1,
    body: 0.2,
    deepIn: 1.0,
    shortZ: 3.5,
    spread: 0.6,
  },
  /**
   * The open spot (ai/openShot.ts): a hitter who sees the court hits round the block or over its
   * hands (with `openShotBlockGap` m to spare, wherever they reach: `blockReachBand` m either side of
   * the net), where nobody gets a platform under it in time. A defender digs a ball within
   * `digReach` m of their feet (they turn to it: the platform 0.45 m in front, CONTACT.passRadius
   * and CONTACT.digLunge at a hard-driven ball) once it is below `digTop` m. In system an AI hitter
   * looks for the spot every time, out of system `openShotOut` of the time (a high ball from off
   * the net: less of the court in view); their defence moves `AI.defence.hitReact` after the hit.
   */
  openShotBlockGap: 0.25,
  blockReachBand: 0.45,
  digReach: 1.1,
  digTop: 1.45,
  /** a spot is open when the quickest defender is this much (s) late; several open: one at random */
  openShotMargin: 0.05,
  openShotOut: 0.45,
  /**
   * Playability (bent on purpose): with the user up in the block, an AI hitter misreads the user's
   * hands `userBlockMisread` of the time and aims as if they weren't there, so the user gets more
   * balls into the block. AI blockers are read as before.
   */
  userBlockMisread: 0.3,
  /** the hitter takes the best spot even if the quickest defender gets there up to this much (s) in time: the hardest ball to dig */
  openShotStretch: 0.15,
  /**
   * Where an AI middle hits its quick: steep and short, a sharp cut `cut` m off the net to either
   * side or down the middle `down` m off it (behind the off-blocker, in front of the back row);
   * deep to zone 1 or 5 with weight `deep` (the cut and the down shot: 1 each).
   */
  quickShot: { cut: 3.5, down: 4.5, deep: 0.4 },
  /** how much the setter likes the quick: off a pass within `perfectOff` m of the setter's spot `perfect`, else `good` (against `setWeight`) */
  quickWeight: { good: 0.5, perfect: 0.8, perfectOff: 0.8 },
  /**
   * Fast sets to the pins in system (a go, a fast back): on a good pass a pin hitter is
   * already running when the setter touches it (`share` of good passes), and the set meets the
   * hand `flight` s later. In the 2021 Olympic men's final the set to zone 4 flew 0.97 s on
   * average, down from 1.12 s in 2000 (Offensive pass tactics of setters in Olympic finals,
   * Papers on Anthropology 2023); a faster set gives the block and the defence less time.
   * The setter sends it only if the hand is due `minT`-`maxT` s after the touch.
   */
  tempo: { share: 0.5, flight: 0.95, minT: 0.6, maxT: 1.2 },
  /**
   * Against a closed block (every usual shot into the hands), and off a bad pass whenever a block
   * is up, an AI pin hitter wipes it off the outside hand (weight `toolShot`) or rolls it over
   * (`rollShot`). Out of system the high ball goes into a full block, and coaches teach hitters to
   * use it: high hands and off the block (USA Volleyball, "Tips for tooling the block").
   */
  toolShot: 1.0,
  rollShot: 0.3,
  /**
   * ...or plays it softly into the inside blocker's hands (weight `recycleShot`), so it comes back
   * off the block for the cover to pick up and attack again (recycling: `CONTACT.recycleSpeed`).
   */
  recycleShot: 0.8,
  /** an AI player lets a ball go that will land more than this (m) out; closer to the line it is too close to call and played */
  outJudge: 0.2,
  /** an AI passer's platform timing error grows by this factor at a ball arriving at 22 m/s or more (from 12 m/s up): less time to read it */
  passPressure: 1.0,
  /** a pass the setter takes further than this (m) from their spot is out of system: high balls only, no quick */
  outOfSystem: 1.6,
  /** an out-of-system set (and a backup's set, when the setter played the first ball) goes this much (m) higher */
  outOfSystemApex: 0.4,
};

/** the hand you spike, tip and serve with; passing, setting and blocking use both hands */
export type Hand = 'right' | 'left';

/** user-adjustable settings (persisted) */
export interface Settings {
  sensitivity: number;
  fov: number;
  invertY: boolean;
  womenNet: boolean;
  slowmoAssist: boolean;
  aimAssist: number;
  landingMarker: boolean;
  replays: boolean;
  shake: number;
  volume: number;
  firstPerson: boolean;
  showHints: boolean;
  /** touch controls: auto (on touch screens), always on, or off */
  touchControls: 'auto' | 'on' | 'off';
  /** touch aim sensitivity multiplier */
  touchSensitivity: number;
  /** your custom body per position (absent = the position's defaults); only your athlete uses it, never the AI */
  bodies: Partial<Record<PositionId, BodyOverride>>;
  /** your hitting hand, one for every position (the AI stays right-handed); timing, power and reach are the same for both */
  hand: Hand;
}

export const DEFAULT_SETTINGS: Settings = {
  sensitivity: 1.0,
  fov: CAMERA.fov,
  invertY: false,
  womenNet: false,
  slowmoAssist: false,
  aimAssist: ASSIST.aim,
  landingMarker: true,
  replays: true,
  shake: 1.0,
  volume: AUDIO.master,
  firstPerson: false,
  showHints: true,
  touchControls: 'auto',
  touchSensitivity: 1.0,
  bodies: {},
  hand: 'right',
};

export type NumericSettingKey = { [K in keyof Settings]: Settings[K] extends number ? K : never }[keyof Settings];
export type BooleanSettingKey = { [K in keyof Settings]: Settings[K] extends boolean ? K : never }[keyof Settings];

/**
 * Ranges of the numeric settings. The settings panel builds its sliders from these and the
 * loader clamps stored values to them, so the two can never disagree.
 */
export const SETTING_RANGES: Record<NumericSettingKey, { min: number; max: number; step: number }> = {
  sensitivity: { min: 0.2, max: 3, step: 0.05 },
  touchSensitivity: { min: 0.3, max: 3, step: 0.05 },
  fov: { min: 55, max: 100, step: 1 },
  aimAssist: { min: 0, max: 1, step: 0.05 },
  shake: { min: 0, max: 1.5, step: 0.05 },
  volume: { min: 0, max: 1, step: 0.05 },
};

export const TOUCH_CONTROL_MODES: readonly Settings['touchControls'][] = ['auto', 'on', 'off'];

/** a position id from outside the type system (URL, storage): own keys of POSITIONS only */
export const isPositionId = (v: unknown): v is PositionId => typeof v === 'string' && Object.hasOwn(POSITIONS, v);
