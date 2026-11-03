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
  /** drag coefficient. Real volleyballs sit ~0.2-0.3 at spike Reynolds numbers */
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
    id: 'OH', name: 'Outside Hitter', short: 'OH',
    blurb: 'Left-side attacker. High balls, big swings, passes serve too.',
    height: 1.95, jump: 0.86, standingJumpFrac: 0.66, approachSpeed: 5.3, shuffleSpeed: 3.3, accel: 15,
    power: 1.0, ballControl: 0.75,
  },
  OPP: {
    id: 'OPP', name: 'Opposite', short: 'OPP',
    blurb: 'Right-side weapon. Biggest jump and power, blocks the outside.',
    height: 1.99, jump: 0.9, standingJumpFrac: 0.66, approachSpeed: 5.2, shuffleSpeed: 3.2, accel: 14.5,
    power: 1.08, ballControl: 0.6,
  },
  MB: {
    id: 'MB', name: 'Middle Blocker', short: 'MB',
    blurb: 'Tallest. Quick tempo attacks and reading blocks along the net.',
    height: 2.04, jump: 0.82, standingJumpFrac: 0.72, approachSpeed: 4.8, shuffleSpeed: 3.6, accel: 16,
    power: 0.95, ballControl: 0.5,
  },
  S: {
    id: 'S', name: 'Setter', short: 'S',
    blurb: 'Runs the offence. Sets every second ball, dumps when it is open.',
    height: 1.9, jump: 0.74, standingJumpFrac: 0.7, approachSpeed: 5.0, shuffleSpeed: 3.6, accel: 17,
    power: 0.82, ballControl: 0.95,
  },
  L: {
    id: 'L', name: 'Libero', short: 'L',
    blurb: 'Back-row defender. Fastest feet, cleanest passing, different jersey.',
    height: 1.82, jump: 0.66, standingJumpFrac: 0.7, approachSpeed: 5.6, shuffleSpeed: 4.0, accel: 19,
    power: 0.75, ballControl: 1.0,
  },
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
  /** airborne: max body rotation from the takeoff yaw, and its rate */
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
  /** ... and a more forgiving late side (releasing as the ball arrives is the natural instinct) */
  spikePerfectLate: 0.07,
  spikeGoodLate: 0.11,
  spikeOk: 0.15,
  /** attack button held shorter than this => tip/roll instead of a swing */
  tapThreshold: 0.09,
  /** wind-up hold (s) that reaches full swing power */
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
  blockHalfWidth: 0.38,
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

export const FX = {
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
};

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
};
