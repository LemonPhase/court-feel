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
  /** soft mesh of the net eats most of the energy */
  netRestitution: 0.16,
  netDamping: 0.45,
  /** the top cable/tape is stiffer: lets roll over */
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
  /**
   * Sets: one press per ball. Press RMB as the ball reaches your hands (the catch), hold while it
   * loads in your hands (the bar fills), release at the top of the bar (the push). The ball sits
   * in the hands this long (game s) before the ideal push. A real set touch is shorter (under
   * 0.1 s); this is longer so the bar has room, and the set slow-mo stretches it on screen (it
   * fills in setLoad / ASSIST.setSlowmoLoad real seconds on every level). Levels: SET_LEVELS.
   */
  setLoad: 0.15,
  /** held this long (game s) past the top of the bar: the push goes anyway, late */
  setHoldMax: 0.1,
  /** a catch this early or more (game s, beyond the level's clean catch) costs the touch the most */
  setCatchEarly: 0.3,
  /** a catch this late or more (game s, beyond the clean catch) costs the touch the most (the ball is at your chin) */
  setCatchLate: 0.08,
  /** feet stopped this long before the ball arrives costs the touch nothing */
  setFeetReady: 0.3,
  /** slower than this (m/s) counts as stopped */
  setStillSpeed: 0.5,
  /** while it loads, the hands give with the ball at this speed (m/s) */
  setAbsorbSpeed: 0.6,
  /** block: fraction of max jump height at contact */
  blockPerfectHeight: 0.88,
  blockGoodHeight: 0.66,
  blockArmTime: 0.12,
};

export type SetLevel = 'easy' | 'normal' | 'hard' | 'elite';
export const SET_LEVEL_IDS: readonly SetLevel[] = ['easy', 'normal', 'hard', 'elite'];

/**
 * Set difficulty (Settings: Set difficulty). Every level has the same bar, the same slow-mo
 * (ASSIST.setSlowmoCatch / setSlowmoLoad) and the same top of the bar, so the timing you practise
 * on one carries to the next: a harder level only narrows the windows around it. Game seconds
 * throughout; on screen they are divided by the slow-mo (Easy's ±15 ms green is ±60 ms on screen
 * at quarter speed).
 * - `green`: the green half-window around the top of the bar, with your best and your worst touch
 * - `goodMul`: a good (white) set reaches this many green half-windows either side
 * - `catch`: a catch this close to the ball reaching your hands is clean (at the catch slow-mo)
 * The whole green never spans less than a 60 fps frame of game time (4.2 ms at quarter speed), so
 * there is always a frame that lands in it.
 */
export const SET_LEVELS: Record<SetLevel, { label: string; green: [number, number]; goodMul: number; catch: number }> = {
  easy: { label: 'Easy', green: [0.015, 0.007], goodMul: 3, catch: 0.08 },
  normal: { label: 'Normal', green: [0.0095, 0.0048], goodMul: 2.5, catch: 0.05 },
  hard: { label: 'Hard', green: [0.0055, 0.0033], goodMul: 2, catch: 0.03 },
  elite: { label: 'Elite', green: [0.003, 0.0023], goodMul: 1.5, catch: 0.015 },
};

export const CONTACT = {
  /** sphere around the ideal contact point that still lets you hit */
  spikeReach: 0.38,
  spikeReachStretch: 0.62,
  passRadius: 0.55,
  setRadius: 0.48,
  /**
   * Your touch scales the set's green window: each part multiplies it, down to these floors.
   * Feet still moving, an early or late catch, the ball off-centre on the hands (beyond
   * `setCentreOk` m, up to the edge of the reach), and a hard set: a back set, a long set (per
   * metre beyond `setLongFrom`), a fast tempo, a pass far off the net (`AI.outOfSystem`).
   */
  setTouch: {
    feetMin: 0.65,
    catchMin: 0.5,
    centreMin: 0.6,
    backSet: 0.85,
    fastTempo: 0.85,
    longPerM: 0.05,
    longMin: 0.8,
    outOfSystem: 0.75,
  },
  setCentreOk: 0.15,
  setLongFrom: 3,
  /** set spread (m, 1 sd along the net; off the net and in height are smaller): green, then good from best to worst */
  setSpreadGreen: 0.03,
  setSpreadGood: [0.1, 0.4] as [number, number],
  /** early / late: the set comes up short (early) or flat and long (late) by up to this much (m), plus this spread */
  setMissShift: 1.3,
  setMissSpread: 0.5,
  /** early / late: the apex is this much (m) lower at worst (pushed before the ball loaded, or taken low) */
  setMissApexDrop: 0.6,
  /**
   * half-width of the block's hands along the net (ball centre within this + ball radius).
   * Matches the pose: wrists ~0.15 m off the midline plus a palm, so the gap between the
   * arms is under one ball wide and the ball goes round, not through, a block that misreads.
   */
  blockHalfWidth: 0.22,
  blockHeight: 0.55,
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
  /** pass target error (m) by grade */
  passErrPerfect: 0.15,
  passErrGood: 0.6,
  passErrOk: 1.6,
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
  /**
   * set slow-mo (settings toggle, on by default), the same on every level so the bar always looks
   * the same: from `setSlowmoWindow` s before the ball reaches your hands the game runs at
   * `setSlowmoCatch`; while the ball loads in your hands, at `setSlowmoLoad` (the bar fills in
   * TIMING.setLoad / setSlowmoLoad = 0.6 s on screen)
   */
  setSlowmoWindow: 0.35,
  setSlowmoCatch: 0.5,
  setSlowmoLoad: 0.25,
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

export const FX = {
  /**
   * The set's timing ring (Settings: Set timing ring): it closes onto the ball and is `atContact`
   * ball radii across as the ball reaches your hands (just outside the ball, so nothing covers it).
   * Its radius is that times e^(perSecond x time to go), shown from `showFor` s before; the green
   * band is your window, the faint band your good one; no band is drawn over the ball itself.
   */
  setRing: { perSecond: 4, atContact: 1.6, showFor: 0.9, greenOpacity: 0.32, goodOpacity: 0.12 },
  /**
   * The set bar beside the ball (2K's meter): px tall and wide, the gap (px) from the ball's edge,
   * where the top of the bar (the ideal push) sits as a fraction of its height, and how long
   * (real s) it stays up after the push.
   */
  setBar: { height: 96, width: 10, gap: 18, target: 0.8, linger: 0.7 },
  /** where to stand for the set: a floor spot this wide (m), green once your feet are within `CONTACT.setCentreOk` */
  setSpot: { radius: 0.32 },
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
  /** opponent hitter skill 0..1 */
  hitterSkill: 0.8,
  blockerSkill: 0.5,
  defenderSkill: 0.7,
  setterAccuracy: 0.15,
  /**
   * Mini Rally: the setter reads the pass this long (s) after it is played and calls it
   * ("HIGH!" when it is out of system). The call is the decision: the set follows it, and is
   * never swapped silently at the touch. A hitter can only adjust a fast approach if they
   * know about a second ahead.
   */
  setterRead: 0.2,
  /** a pass the setter takes further than this (m) from their spot is out of system: high balls only, no quick */
  outOfSystem: 1.6,
  /** an out-of-system set (and a backup's set, when the setter played the first ball) goes this much (m) higher */
  outOfSystemApex: 0.4,
  /**
   * Your green set beats the block: their block starts its read this much (s) later, misreads
   * this many times more and jumps this much (s) late (an exact set at the called tempo gives the
   * block nothing early), and your hitter swings perfectly, never through the block's hands and
   * never out. The back row can still dig it.
   */
  greenSetReadDelay: 0.3,
  greenSetReadErr: 2.5,
  greenSetJumpLate: 0.12,
  /**
   * A bad set (your early / late push) is harder to hit: your hitter's timing error grows by up
   * to this factor and they tip or roll it this many times more often.
   */
  badSetErr: 3.5,
  badSetTip: 4,
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
  /** time slows for your set's catch and release (on by default; the same on every level) */
  setSlowmo: boolean;
  /** the timing ring that closes on the ball as it reaches your hands when you set */
  setRing: boolean;
  /** set difficulty: how wide the green, the good band and the clean catch are (SET_LEVELS) */
  setLevel: SetLevel;
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
  setSlowmo: true,
  setRing: true,
  setLevel: 'easy',
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
