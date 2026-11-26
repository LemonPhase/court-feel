// The skills: the timing windows, the block's hands, what a touch does to the ball, the serves, the plays, what assist does for the body. Owner: the simulation.
//
// What each section controls:
//
// `TIMING`: Perfect/Good windows, swing time and stretch, tap threshold, wind-up time to full
// charge (`chargeFull`), pass/dig lead times, the set (how long the ball loads in the hands,
// `setLoad`; how long it can be held; how an early or late catch costs the touch; the feet ready
// time), block height thresholds, the Setter Drill's pace (`setterDrill`: how long the result stays
// up, when the next pass leaves), input buffer
//
// `SET_LEVELS`: The set difficulty levels: the green window (best and worst touch), the good
// multiple, the clean catch, whether hands up early are free (`handsEarly`, Easy) (the slow-mo is
// the same on every level, in `ASSIST`)
//
// `BLOCK`: The block's hands: how big a hand is with the fingers spread and the gap between the
// thumbs, how far the arms press over the net with the jump (`press`, `wrist`, the torso's `lean`,
// from `pressFrom` of the jump; the shoulders no nearer the net than `shoulderOff`; never under the
// tape, `tapeClear`), how far the hands turn about the forearms to the attacker (`face`) and a pin
// blocker's outside hand turns in (`turnIn`, `pinTurn`), the aim assist's wider hands
// (`assistWiden`); how the ball comes off them: the arm's mass behind the palm, the fingers, the
// little finger's edge and a forearm (`massPalm`, `massTip`, `fingers`, `edge`, `massArm`; the
// forearms no further apart than a ball, `forearmWidth`), the ball's restitution by impact speed
// and what the hand keeps of it (`ballRest`, `restPalm`, `restTip`, `restArm`), the skin's grip
// (`friction`), hands put up on the floor (`floorFirm`), one block as one touch (`chain`), two
// hands taking a ball together (`together`); what a touch is called (`stuffSpeed`); the AI's hands
// (`ai`: how firm, how far the outside hand turns in, against your attack, and off your green set)
//
// `CONTACT`: The setter's dump (`dump`: how near the net, where it lands, how high over the tape)
// and how hard a fast set off the net is (`setTouch.oosFast`); A stuff kept up comes off the arms
// anywhere (`covered.stuff`) while a recycled ball keeps its shape; an AI hitter's mistimed swing
// still meets the ball (`aiSwingShift`); Reach radii, spike/tip/serve speeds and spin, power at
// minimum charge (`chargePowerMin`), pass error by grade and how much it grows with ball speed and
// a moving passer (`passSpeedErr`, `passMoveErr`), the lunge at a hard-driven ball (`digLunge`),
// what a dive does with the ball (`diveOut`: one arm's extra reach, how high and which way a ball
// met at full stretch goes, how much under control reads Good), how hard a pass can be
// (`passPower`) and how much of a fast third ball sent over goes the way it bounces
// (`overControl`), shanks (`shank`, `shankGood`, `shankSpeed`, `shankTurn`; an AI dig of the user's
// hard spike `userSpikeShank`), how much lower a block reaching sideways is (`blockReachDrop`) and
// how wide one blocker's hands are as the AI reads them (`blockHalfWidth`, from `BLOCK`), a jump
// serve met early loses its topspin (`serveEarlySpin`; the player's three serves are under
// `SERVE`), the side dig, the dive and the overhand first ball (`sideReach`, `sideErr`, `diveLow`,
// `diveErr`, `handsErr`, `handsMaxSpeed`), the AI hitter's push into the hands (`pushSpeed`,
// `pushDrop`), how a ball off their block comes off the cover's arms (`covered`: how much of it the
// coverer controls, by the ball's speed, the platform's timing, its edge, moving feet and reaching;
// the rest pops up near them), the AI's serves always in (`serveSafe`, and `serveSafeApex` for one
// its aim cannot get over the tape; `floatSafe`, `floatSafeTries`, `floatSafeCut`, `floatSafeMin`
// for its float), how much a float floats by the grade of its contact (`floatClean`), what shrinks
// the set window (`setTouch`; each kind of set's share of a high ball's green, `setTouch.window`; a
// jump set's balance, `airDrift` and `offTop`) and how a set misses (spread, short / long, apex)
//
// `SERVE`: The player's three serves: each one's toss (how far ahead, how high) and where the Serve
// Drill stands you (`back`), the jump float's speed and the run-up that gives it (`jumpFloatSpeed`,
// `floatRun`), a jump serve hit off the floor (`standingSpin`), the foot fault (`foot`), no hitting
// a toss on its way up (`tossRising`), how the hold on Q sets the toss's height (`hold`) and how
// much further ahead a higher jump toss comes down (each serve's `ahead`). `SERVE_DRILL`: the
// drill's start spot and its timings
//
// `ASSIST`: How slow the game runs while the play wheel is open (`playWheelSlow`); how much wider
// your set's windows are set by feel, with the ring and bar off (`setByFeel`); Default aim assist,
// the aim assist of an athlete nobody plays (`ai`: a little more reach for an AI player's swing,
// pass and block), air magnet strength, reach bonus, the set's footwork (`setStep`: how near the
// spot your body takes the last steps, how it arrives), slow-mo assist, the set slow-mo (when it
// starts, how slow for the catch and while the ball loads)
//
// `PLAYBOOK`: The play designer: how far apart two front-row hitters' sets must be hit, and the
// longest name

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
  /** an AI's overhand first ball: ideal lead between starting the touch and the ball reaching the hands */
  setLead: 0.18,
  /**
   * Sets: one press per ball. Press RMB as the ball reaches your hands (the catch), hold while it
   * loads in your hands (the bar fills), release at the top of the bar (the push). The ball sits
   * in the hands this long (game s) before the ideal push. A real set touch is shorter (under
   * 0.1 s); this is longer so the bar has room, and the set slow-mo stretches it on screen (it
   * fills in setLoad / ASSIST.setSlowmoLoad real seconds on every level). Levels: SET_LEVELS.
   */
  setLoad: 0.15,
  /**
   * Held this long (game s) past the top of the bar: the ball has come to rest in the hands, a
   * lift (the point is theirs). Longer than Easy's late good band; setting by feel
   * (ASSIST.setByFeel) it is that much longer too, like the band
   */
  setHoldMax: 0.13,
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
  /**
   * The Setter Drill's pace (game s). Your picks and calls for the next ball open as soon as a rep
   * ends, so the whole wait is time to choose: the result stays up `result` s after a rally your
   * hitter played out, only `resultMiss` s after a ball that was never set or never hit (nothing
   * to watch), and the next pass leaves `feed` s into the rep (the passer's arms `wind` s before
   * it). That is 2.7 s to choose after a rally and 2.0 s after a miss; it was 0.55 s, after a
   * 2.2 s wait with the keys locked. The pass waits while the play wheel is open or you jog back
   * to your spot, then comes `settle` s later. `intro` is the wait before the first rep, and a
   * ball still in play after `live` s ends the rep.
   */
  setterDrill: { intro: 0.6, feed: 1.2, wind: 0.15, settle: 0.4, result: 1.5, resultMiss: 0.8, live: 9 },
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
 * throughout; on screen they are divided by the slow-mo (Easy's ±60 ms green is ±240 ms on screen
 * at quarter speed). Wider than a real setter's margin on purpose: the user's playtest (2026-11-15)
 * found the release far too tight, so every level was widened about 2.5-3x, then by half again.
 * These are a high ball's windows: a harder set gets a share of them (CONTACT.setTouch.window).
 * - `green`: the green half-window around the top of the bar, with your best and your worst touch
 * - `goodMul`: a good (white) set reaches this many green half-windows either side. It stays under
 *   TIMING.setHoldMax, so a set held on until it is a lift was never a good one
 * - `catch`: a catch this close to the ball reaching your hands is clean (at the catch slow-mo)
 * - `handsEarly`: hands up before the ball comes cost nothing (Easy). It is what coaches teach,
 *   and it leaves a beginner one thing to time, the release; from Normal up the catch is timed too
 * The whole green never spans less than a 60 fps frame of game time (4.2 ms at quarter speed), so
 * there is always a frame that lands in it.
 */
export const SET_LEVELS: Record<
  SetLevel,
  { label: string; green: [number, number]; goodMul: number; catch: number; handsEarly?: boolean }
> = {
  easy: { label: 'Easy', green: [0.06, 0.03], goodMul: 2, catch: 0.08, handsEarly: true },
  normal: { label: 'Normal', green: [0.0375, 0.0195], goodMul: 2.5, catch: 0.05 },
  hard: { label: 'Hard', green: [0.0225, 0.0135], goodMul: 2, catch: 0.03 },
  elite: { label: 'Elite', green: [0.0135, 0.009], goodMul: 1.5, catch: 0.015 },
};

/** a kind of set, by how hard it is to put on the spot (CONTACT.setTouch.window) */
export type SetTier = 'high' | 'hut' | 'quick' | 'backQuick' | 'backQuickOpp' | 'tempo' | 'push' | 'inside';

/**
 * The block's hands (src/game/blockHands.ts places them, src/physics/handContact.ts is the ball
 * meeting one). A blocker is two hands: each a flat plate the size of an open hand with the
 * fingers spread, on the end of an arm that pivots at the shoulder. The ball is touched where it
 * passes within its radius of a hand and comes off it as a ball comes off a hand: the part of its
 * speed into the hand bounces back (less what the hand and the ball soak up), the part along it
 * goes on, slowed by the skin's grip, which also changes its spin. Where on the hand it lands
 * decides how much is bounced back: the heel of a pressing hand has the arm behind it, the
 * fingertips bend back. Nothing is rolled for the outcome: a stuff, a soft block, a block-out and
 * a ball recycled to the hitter's side are what the bounce does, named afterwards from where the
 * ball goes (`stuffSpeed`). Before this (until 0.2.x) the hands were a box 0.66 m wide and 0.75 m
 * deep and the outcome was a dice table: a cross shot met hands twice as wide as a line shot,
 * balls that had cleared the fingertips were caught behind the net, and every block-out flew
 * 3-4 m past the end line whatever was hit (measured: `node scripts/block-sweep.mjs`).
 *
 * The hands' place:
 * - `handWidth`: one hand, fingers spread (m). An adult man's hand is 8.5 cm wide at the knuckles
 *   and 18.3 cm long (median; 95th percentile 9.1 and 19.9 cm: Chaurand et al. 2007); spread for a
 *   block it is about as wide as it is long. Its length is the body's (`proportions.ts`: 0.108 x
 *   height, 21 cm for a 1.97 m middle).
 * - `thumbGap`: between the thumbs (m). Under a ball's width (0.21 m): coaches teach that the ball
 *   must not fit between a blocker's hands, so a ball there meets both.
 * - `thickness`: of a hand (m); the ball meets its surface, not its middle.
 * - `reachTop`: the fingertips over the standing reach with the arms straight up (m), as the
 *   standing reach is measured to the middle finger's first joint.
 * - `press` (rad): the arms lean forward from the shoulders over the net at a full press (about 23
 *   degrees off vertical) and the wrists bend back a little (`wrist`, rad, < 0: back), so the palms
 *   face the hitter's floor at about 20 degrees off vertical; the shoulders come forward `lean` m
 *   with it (the torso leaning in about 15 degrees, and the shrug of a reach). Together they put the
 *   fingertips about 10 cm over the net for a middle standing 0.45 m off it, for about 7 cm of height.
 *   The palms stay near upright: a spike comes down at 15-25 degrees, so it meets a palm tilted that
 *   much plus the tilt off square, and past about 40 degrees a ball aimed at a 20 cm palm meets the
 *   fingertips first (tried: 34 degrees of tilt sent hard spikes into the middle of the hands off the
 *   tips). Tried and turned down: a 0.3 m lean (a 30-degree lean no blocker holds, and the drawn body
 *   could not follow it: in first person the hands went out of sight above), and arms 29 degrees
 *   over (9.5 cm of height lost: fewer stuffs, as many spikes went over the fingertips). A press costs
 *   height, which is why a hitter can go over a block that penetrates and not over one that only
 *   reaches (JSSM 10:452, the swing block: more height and more penetration). The shoulders lean in
 *   no closer than `shoulderOff` m to the net's plane (the chest is about 12 cm in front of the
 *   shoulder joints, and it stays off the net): a blocker standing at the net leans less and is over
 *   it further with the arms. (Before this limit a blocker at `FEET_OFF_NET` leaned its shoulders
 *   onto the net's plane, and an arm from there could only clear the tape straight up: no press.)
 * - `pressFrom`: the press comes with the jump: none below this share of the jump's height, all of
 *   it at the top. A late blocker's hands are still going up, square to the net; an early one's are
 *   coming down.
 * - `tapeClear`: the arms never pass under the tape (that is a net fault and a broken arm): where
 *   an arm crosses the net's plane it is at least this far (m) over it, so a blocker whose
 *   shoulders are low cannot reach over, however hard it presses.
 * - `face`, `faceMax`: the hands turn toward the attacker, `face` of the way, at most `faceMax` rad:
 *   a blocker squares its hands to the hitter's arm, not to the line the ball then takes (turned to
 *   the ball's line, one blocker took a 45-degree cross over 40% more net than a line shot). The
 *   hands turn about the forearms; the arms and the shoulders press straight over the net (pressing
 *   along the facing slid the hands up to 9 cm sideways toward a hitter off to one side: a free
 *   reach that widened every block).
 * - `turnIn`, `pinTurn`: a pin blocker turns its outside hand in (rad, a turn of the forearm), so a
 *   ball off it goes into the court and not off it and out: from `pinTurn[0]` m along the net to
 *   all of it at `pinTurn[1]` m (Volleyball Canada, blocking: "hands wide open and slightly
 *   turned"). The inside hand of the block stays square.
 * - `assistWiden`: the aim assist's reach for a user blocker (m of each hand's half-width at full
 *   assist): a body helped, never the ball; 0 assist is no help.
 *
 * The hands' give:
 * - `massPalm`, `massTip` (kg): how much of the arm is behind the hand where the ball meets it. The
 *   ISO 10218-2 body model gives the hand 0.6 kg, the forearm 2 kg and the upper arm 3 kg for a
 *   free arm; a pressing block locks the elbows and braces the shoulders, so the heel of the hand
 *   carries the forearm and most of the upper arm. At the tips only the fingers, which bend back.
 *   `fingers` (0 the heel, 1 the tips): from here the mass falls to the tips' (a blocker's spread
 *   fingers are braced: they give at their outer third). `edge`: the little finger's side of a hand is fingers too (this share of the mass at the
 *   very edge), from `edgeFrom` of the way out from the middle of the hand; the thumbs are braced
 *   against each other. A ball that meets both hands at once (within `together` m of its path:
 *   between the thumbs) has both arms behind it.
 * - `massArm`, `restArm`, `forearmWidth`: under the hands are the forearms (7-8 cm across): a ball
 *   met there has the whole braced arm behind it and comes off less lively than off a palm, but
 *   firmer than off the fingers. They run up to under the middle of each hand as it is before the
 *   aim assist spreads the fingers, so the gap between them is narrower than a ball at any assist
 *   (with the assist spreading them too, at the default a ball went between them untouched), and a
 *   ball whose line is in that gap is met by both, as between the thumbs.
 * - `ballRest`: a ball's own restitution against a rigid surface at `ballRestSpeed[0]` and
 *   `[1]` m/s: it falls as the impact gets harder (a pressurised tennis ball: 0.8 at 3 m/s to 0.6
 *   at 20 m/s, Haake / Sheffield; a volleyball at 0.3 kg/cm2 is softer and is taken a little lower).
 * - `restPalm`, `restTip`: what the hand keeps of that (its soft tissue and its give soak up the
 *   rest), at the palm and at the fingers.
 * - `friction`: skin on the ball's synthetic leather. Palm skin on smooth surfaces measures from
 *   about 0.8 (aluminium) to over 1 (rubber), less with sweat; taken a little under.
 * - `floorFirm`: hands put up with the feet on the floor are this firm (share of the masses):
 *   there is no jump to press from. `armTime`-early hands (arms still going up,
 *   `TIMING.blockArmTime`) are firm by how far up they are.
 * - `chain`: one block is one touch (FIVB 14.4.1): within this long (s) of a blocker's touch the
 *   ball can still meet a team-mate's hands, as part of the same block.
 * - `armsUp`: the hands block once the arms are this far up (`TIMING.blockArmTime`), and only a
 *   blocker within `netMax` m of the net blocks at all.
 * - `sweepStep`, `sweepIters`: how finely the ball's path through a step is searched for a hand
 *   (m between looks; halvings to find the moment it meets it). A spike moves 25 cm a step: without
 *   the search it would pass through a hand 3 cm thick.
 *
 * What the touch is called (for the HUD, the drills' scores, the sound and the cover), and where it
 * met the block (the HUD says it after the call: the palm, both hands, the fingers, from `tipsFrom`
 * of the way up the fingertips and of the way across the hand's edge, the forearms):
 * - `stuffSpeed`: a ball off the block that comes down on the hitter's side, in, and leaves the
 *   hands at this speed (m/s) or more is a stuff, driven down; slower it is off the block for their
 *   cover (recycled: about where `CONTACT.covered.easy` says a cover still controls a ball). Out on
 *   either side is a block-out; in on the blocker's side, a soft block.
 *
 * The AI blockers (playability, bent on purpose): their skill is how firm their hands are
 * (`ai.firm`) and how far they turn the outside hand in (`ai.turnIn`), at `AI.blockerSkill`. They
 * press as far as you do: pressing is a trade (over the net a falling spike is met higher, so a
 * press touches fewer high balls and stops more steep ones), and a blocker that pressed less than
 * you would touch more than you (measured: 52% of a sweep of attacks for an AI pressing three
 * quarters as far, 48% for you). Against the user's attack their hands are less firm (`ai.userFirm`
 * of it: the Spike Drill's perfect autopilot, hitting its zone straight into a closed double block,
 * was stuffed 9 times in 40 without it, 7 with it, 2 with the old dice table; its kills stayed at
 * 20-22) and they do not seal the outside hand:
 * it is left a little open, turned toward the antenna (`ai.userTurnIn` of a turn in: below 0 is
 * out), and its fingers not spread as wide (`ai.userWidth` of the width, the thumb's edge where it
 * was), the blocking fault coaches warn of, so your spike off the outer hand gets off it more
 * often: stuffed over less of the hand, off it over more (it was a separate dice roll, before the
 * hands: the defence is strong and hitting is hard enough). Off your green set their hands are not set (`ai.green`: the
 * share of a press and of their firmness): the set beat them, they are reacting, and the hitter
 * swings high off them (it was a rule: never a stuff).
 */
export const BLOCK = {
  handWidth: 0.18,
  thumbGap: 0.1,
  thickness: 0.03,
  reachTop: 0.04,
  press: 0.4,
  wrist: -0.05,
  lean: 0.22,
  shoulderOff: 0.18,
  pressFrom: 0.4,
  tapeClear: 0.05,
  face: 0.5,
  faceMax: 0.4,
  turnIn: 0.35,
  pinTurn: [2.0, 3.5] as [number, number],
  assistWiden: 0.06,
  massPalm: 3.5,
  massTip: 0.25,
  massArm: 4,
  restArm: 0.75,
  forearmWidth: 0.08,
  together: 0.06,
  fingers: 0.7,
  edge: 0.4,
  ballRest: [0.75, 0.5] as [number, number],
  ballRestSpeed: [3, 30] as [number, number],
  restPalm: 0.85,
  restTip: 0.6,
  friction: 0.7,
  floorFirm: 0.5,
  chain: 0.15,
  edgeFrom: 0.6,
  tipsFrom: 0.95,
  armsUp: 0.35,
  netMax: 1.3,
  sweepStep: 0.02,
  sweepIters: 10,
  stuffSpeed: 8,
  ai: { firm: 0.85, turnIn: 0.7, userFirm: 0.7, userTurnIn: -0.5, userWidth: 0.75, green: 0.2 },
};

export const CONTACT = {
  /** sphere around the ideal contact point that still lets you hit */
  spikeReach: 0.38,
  spikeReachStretch: 0.62,
  /**
   * An AI hitter's mistimed swing still meets the ball: its contact moves at most this long (s)
   * off the best moment (a set dropping at about 6 m/s is then within 0.25 m of the hand, inside
   * `spikeReachStretch`). How wrong the timing was decides where the ball goes (early sails long,
   * late goes into the net), never whether it is hit: a hitter going up for their own setter's
   * ball does not swing through thin air. Before, a swing about 3 sd off (`AI.attackErr`) was moved
   * so far off the ball that it missed it altogether: 1 set in 100-200 dropped untouched beside a
   * hitter in the air (MatusGib, 2026-11-15: misconnections between the AI setter and hitter).
   */
  aiSwingShift: 0.04,
  passRadius: 0.55,
  setRadius: 0.48,
  /**
   * A button pressed with no ball near is not a rep: an action that never met the ball counts as
   * an attempt only if the ball came this close to where it would have met it (m, about one step and a reach)
   */
  attemptRange: 3,
  /** how far ahead (s) a setter looks for the ball coming down onto the hands: a pass is in the air about 1-1.5 s */
  setLook: 1.6,
  /**
   * Your touch scales the set's green window: each part multiplies it, down to these floors.
   * Feet still moving, an early or late catch, the ball off-centre on the hands (beyond
   * `setCentreOk` m, up to the edge of the reach), the kind of set (`window`), and a pass far
   * off the net (`AI.outOfSystem`).
   */
  setTouch: {
    feetMin: 0.65,
    catchMin: 0.5,
    centreMin: 0.6,
    /**
     * How hard each kind of set is to put on the spot: its share of a high ball's green. A high
     * ball leaves the hitter time to go to it, and the 1 is a short ball straight up in front of
     * the setter. The faster and flatter the set, the less room: the hitter is already running to
     * a spot. `hut` the lower outside ball; `backQuick` the middle's quick behind the setter, and
     * `backQuickOpp` the opposite's (coming in from the pin, behind the setter's back); `tempo`
     * the second-tempo sets to a pin and the bic (go, fast back); `push` the middle's quick pushed
     * along the net (push 1, shoot); `inside` the combination balls (3, 2, X, back 2, the pipe
     * behind the setter). The user's call (2026-11-15).
     */
    window: { high: 1, hut: 0.9, quick: 1, backQuick: 0.85, backQuickOpp: 0.6, tempo: 0.7, push: 0.7, inside: 0.6 },
    /**
     * A jump set has no feet on the floor: its balance is the feet's share. Drifting through the
     * touch faster than TIMING.setStillSpeed costs it, the most (`feetMin`) at `airDrift` m/s; so
     * does a ball met off the top of the jump, the body rising or falling faster than `offTop[0]`
     * m/s, the most at `offTop[1]`.
     */
    airDrift: 2,
    offTop: [1.2, 3] as [number, number],
    outOfSystem: 0.75,
    /** a fast set (a quick, a go, a fast back) off a pass far off the net: on top of both of those. Very hard */
    oosFast: 0.5,
  },
  /**
   * The setter's dump (front row only): the second ball sent over the net, from no more than
   * `maxOff` m off it. `short` lands just behind the block, `deep` in the far corner (home-side
   * coordinates, mirrored for the other side); it peaks `apexShort` / `apexDeep` m above the
   * tape, and a green or a good one clears the tape by at least `clear` m.
   */
  dump: { maxOff: 1.6, short: { x: -1.2, z: -1.7 }, deep: { x: -3.4, z: -7.6 }, apexShort: 0.5, apexDeep: 1.0, clear: 0.1 },
  setCentreOk: 0.15,
  /** set spread (m, 1 sd along the net; off the net and in height are smaller): green, then good from best to worst */
  setSpreadGreen: 0.03,
  setSpreadGood: [0.1, 0.4] as [number, number],
  /** early / late: the set comes up short (early) or flat and long (late) by up to this much (m), plus this spread */
  setMissShift: 1.3,
  setMissSpread: 0.5,
  /** early / late: the apex is this much (m) lower at worst (pushed before the ball loaded, or taken low) */
  setMissApexDrop: 0.6,
  /**
   * half the width of one blocker's hands along the net (`BLOCK`: half the gap between the thumbs
   * and one hand), as the AI's hitters and the drills' block shadows read it
   */
  blockHalfWidth: BLOCK.thumbGap / 2 + BLOCK.handWidth,
  /** a blocker reaching sideways (`Athlete.reachX`) gets its hands this much (m) lower per metre of reach */
  blockReachDrop: 0.5,
  /** speeds (m/s) */
  spikePerfect: 30,
  spikeGood: 26,
  spikeOk: 19,
  /** topspin (rad/s) */
  spikeSpinPerfect: 70,
  spikeSpinGood: 55,
  spikeSpinOk: 35,
  rollSpin: 45,
  /** an AI hitter's tip always goes over: however it was timed it is aimed at least this far (m) into the other court (the user's is graded like any swing) */
  tipOver: 0.6,
  /** swing power at the shortest (just past a tap) wind-up; full charge = 1 */
  chargePowerMin: 0.7,
  /**
   * Serve speeds (m/s) for a Good contact at full power, before the athlete's power: a float hit
   * with the feet on the floor, and a topspin jump serve. The jump float's is `SERVE.jumpFloatSpeed`.
   */
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
  /** an AI hitter playing it off the block pushes it at the hands at `pushSpeed` m/s, `pushDrop` m below the contact */
  pushSpeed: 7,
  pushDrop: 0.4,
  /**
   * A covered ball (one off the other team's block, dug by the attacking side) is a reaction touch:
   * no two come off the same, never Perfect. The share of it the coverer controls (0 to `best`)
   * falls as the ball comes harder (none left from `easy` to `hard` m/s at the platform: a recycled
   * ball drops slowly, a stuff is driven down), off a platform not set in time (x `late`), off its
   * edge (down by `edge` at the rim), with the feet still moving (down by `moving` at a full run),
   * reaching to the side or diving (x `reach`). That share goes to the setter like any pass; the
   * rest pops up `pop` m from the coverer, on from the way the ball came (up to `turn` rad either
   * side; a ball dropping nearly straight down, under `still` m/s along the floor, is taken as coming
   * from the net), `up` m above the contact, as far as `wide` m outside the sidelines. So a slow ball off
   * the block is in system about half the time and a stuff that is kept up rarely is (MatusGib,
   * 2026-11-14). The same for the user and the AI: the user's timing is their platform.
   *
   * `stuff`: any ball off their block that was not recycled (it did not come back softly off the
   * hands, slower than `BLOCK.stuffSpeed`), kept off the floor. That touch is mostly luck. At most `best` of it is
   * controlled, times a roll between the two `luck` values (where on the arms it landed); the
   * rest goes anywhere (`turn`: any direction), `pop` m away and `up` m above the contact (its arc
   * is solved down to `floor` m, not to the setter's hands: a pass's arc can't peak below them,
   * which is why every cover used to go up at least 2.4 m): from a ball that barely leaves the
   * floor, fast and flat, to one that goes up high beside the coverer. So no two come off the same in height, speed or direction, and most are a scramble,
   * not a pass (MatusGib, 2026-11-15: the covers were all too high and too good; measured before:
   * 5 of 6 were set, every apex 1.7-3.5 m). The recycled ball keeps the numbers above.
   */
  covered: {
    best: 0.9,
    easy: 7.5,
    hard: 12,
    late: 0.5,
    edge: 0.5,
    moving: 0.5,
    reach: 0.6,
    pop: [0.8, 4.0] as [number, number],
    turn: 2.4,
    still: 0.5,
    up: [0.6, 3.6] as [number, number],
    wide: 1.5,
    stuff: {
      best: 0.45,
      luck: [0.1, 1] as [number, number],
      pop: [0.5, 5.5] as [number, number],
      turn: Math.PI,
      up: [0.3, 3.0] as [number, number],
      floor: 0.3,
    },
  },
  /**
   * The AI never misses a serve (no serve out, none in the net): a mistimed AI serve is a slower,
   * easier serve that still lands `serveSafe` m inside the lines. Only the user can fault a serve.
   * One its aim still can't get over the tape goes up `serveSafeApex` m above the contact or the
   * tape, whichever is higher: slower, but over.
   */
  serveSafe: 0.6,
  /** an AI attack pushed deeper to clear the tape stays this far (m) inside the end line (an AI serve: `serveSafe`) */
  deepIn: 0.3,
  serveSafeApex: 1.0,
  /**
   * How much a float serve floats (`BallState.knuckle`, see `BALL.float`), by the grade of the
   * contact: a mishit (Early or Late), Good, Perfect. A float needs a clean hit through the middle
   * of the ball with no spin; any spin kills it.
   */
  floatClean: [0, 0.2, 0.55, 1],
  /**
   * The AI's float still never misses (`serveSafe`): the way it breaks is drawn again, up to
   * `floatSafeTries` times and then with `floatSafeCut` of the float each time (none once it is
   * under `floatSafeMin`), until its real flight clears the tape by `floatSafe` m and lands that
   * far inside the lines.
   */
  floatSafe: 0.15,
  floatSafeTries: 6,
  floatSafeCut: 0.5,
  floatSafeMin: 0.1,
  sideReach: 0.6,
  sideErr: 1.4,
  diveLow: 0.25,
  diveErr: 2.2,
  /**
   * What a dive does with the ball. Its reach is the platform's (`passRadius`) and `reach` m more: one
   * arm out, the hand flat on the floor (a pancake). How much of the ball the diver controls falls
   * with the square of how far out on the arms it is met (0 in the middle, 1 at the fingertips):
   * controlled, it goes where it was aimed; at full stretch it goes up only `barely` m (between the
   * two, at random) and along the floor the way the dive and the ball were going, `body` of the
   * diver's own speed and `rebound` of the ball's coming back off the arm, turned up to `turn` rad
   * at random. A real dive at the edge of the reach is a scrape: up, but nobody chose where
   * (MatusGib, 2026-11-20: "very inaccurate when diving at close to max reach you should only be
   * able to barely get it up and the direction to be a bit random ... adjusted for the path of
   * travel"). The numbers are our own judgement, not a measurement. The touch reads Good only with
   * `good` of the ball or more under control (met within about 0.3 of the way out), Late otherwise:
   * what the player sees is what the ball did.
   */
  diveOut: { reach: 0.3, barely: [0.4, 1.0] as [number, number], body: 0.6, rebound: 0.3, turn: 1.2, good: 0.5 },
  /**
   * How hard a pass can send the ball (m/s): the platform standing `platform`, swung out to the side
   * `side`, the hands `hands`, from a dive `dive`; a platform down at the floor only `low` of it (no
   * legs under it), and `rebound` of the ball's own speed on top (a hard ball comes off the arms
   * hard). Faster than that, the contact sends it the same way, slower: a ball dug off the floor in
   * the back court, or from a dive, does not reach the other side. A free ball over from the back
   * court needs about 11-12 m/s; a pass to the setter about 9-11. Our own estimates (a strong
   * forearm free ball is 12-15 m/s; a pancake pops the ball up a metre or two).
   */
  passPower: { platform: 15, side: 11, hands: 14, dive: 6, low: 0.7, rebound: 0.3 },
  /**
   * A ball sent over the net (in Mini Rally only ever the third) that comes in faster than `easy`
   * m/s across the floor is harder to redirect: by `hard` m/s `loss` of it comes off the arms the way
   * it bounces (the part of it into the platform comes back at `rebound` of its speed, the part
   * across it goes on at `slide`, and a part already going the aim's way carries on), not where it
   * was aimed. A hard deflection flying across the court goes on across it, not over the net
   * (MatusGib, 2026-11-20: on three, a ball "travelling quickly at them they might not always be
   * able to get"). Only the speed across the floor counts: a high ball comes down at 10-13 m/s from
   * its height alone, and it is the easiest one to get under. Our own estimates.
   */
  overControl: { easy: 10, hard: 20, loss: 0.8, rebound: 0.5, slide: 0.7 },
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

/** the three serves, in the order of the keys that pick them (1-3) */
export type ServeKind = 'float' | 'jumpFloat' | 'jump';

export const SERVE_KINDS: readonly ServeKind[] = ['float', 'jumpFloat', 'jump'];

/**
 * Serving. The serve is picked before the toss (keys 1-3), as on a court: it decides where you
 * stand and how you toss, and everything after the toss is the body's work, with the spike's
 * controls and the spike's timing windows.
 *
 * Each serve has its own toss: `toss` m forward (where the ball would be back at the height it
 * left the hand) and `tossHigh` m over the standing reach at its top. `back` is where the Serve
 * drill stands you, m behind the end line; you may toss from anywhere behind it.
 *
 * The player sets the height of each toss: Q is held and let go. A tap tosses `hold.low` of the
 * serve's `tossHigh`, a hold of `hold.full` s or longer `hold.high` of it, evenly in between, so
 * the serve's own height is a hold of 0.36 s. A higher toss is in the air longer, and a jump
 * server tosses it further ahead to fill that time with run-up: how far ahead it comes down is
 * scaled by the height's share of the serve's own to the power `ahead`, 0.5 for the jump float
 * and the jump serve (the toss's time in the air grows as the square root of its height, and the
 * run covers ground at the same pace), 0 for the standing float, whose toss comes down in front
 * of the hitting shoulder however high it goes. The highest jump serve toss comes down 5.1 m
 * ahead instead of 4.0: from the drill's start that is 3.2 m of run-up, with the take-off
 * 0.2 m behind the end line; a tap's comes down 2.8 m ahead, 1.2 m of run-up. The first
 * version had one toss per serve and no meter (a server grooves a toss; a different height each
 * rep is an error, not a choice, and a meter puts a fourth timing in front of the run, the jump
 * and the swing). The two were played against each other on the preview and the held toss was
 * kept: timing your own toss is part of serving, and a held button is how the swing and the
 * jump are already played. The AI's tosses are not held: they are the serve's own.
 *
 * - `float`: a low toss in front of the hitting shoulder (0.8 m over the contact, in the air
 *   0.95 s), hit with the feet on the floor. Both floats move in the air as cleanly as they were
 *   hit (`BALL.float`, `CONTACT.floatClean`).
 * - `jumpFloat`: a low toss two steps ahead (0.85 m over the contact, 1.1 s), met at the top of
 *   a short run-up that starts 0.15 s after the ball leaves the hand: little time to fix anything.
 * - `jump`: the high toss far ahead that a full spike approach runs under (1.75 m over the
 *   contact, 1.4 s; the run-up starts a quarter of a second after the toss). From `back` a clean
 *   one takes off a metre behind the end line and lands in the court. The AI's own toss is lower
 *   and longer (`AI.serve.jumpToss`): it starts its run-up on the step the ball leaves the hand,
 *   and a person needs a beat to see the toss first.
 *
 * (Measured with tests/serveRun.ts, an Outside Hitter, a full run-up and jump.)
 *
 * The ball's spin comes from the serve picked (`spin`), its height and pace from the body: a
 * float hit off a jump is a jump float, a jump serve hit off the floor is a slow topspin serve.
 * Speeds are for a Good contact at full power. The top speeds measured in men's international
 * play are 63 km/h for the float, 73 km/h for the jump float and 125 km/h for the jump serve
 * (Häyrinen et al. 2007, read in a secondary source); a Perfect contact here gives about 62, 73
 * and 95 km/h for an Outside Hitter.
 */
export const SERVE = {
  float: { name: 'Standing float', back: 1.1, toss: 0.25, tossHigh: 0.8, ahead: 0, spin: false },
  jumpFloat: { name: 'Jump float', back: 2.3, toss: 2.0, tossHigh: 1.7, ahead: 0.5, spin: false },
  jump: { name: 'Jump serve', back: 3.4, toss: 4.0, tossHigh: 2.8, ahead: 0.5, spin: true },
  hold: { full: 0.8, low: 0.5, high: 1.6 },
  /** a float hit in the air off a full run-up (m/s); `CONTACT.serveFloatSpeed` with no run-up at all */
  jumpFloatSpeed: 20,
  /** the run-up that gives a jump float its full pace: this share of the athlete's approach speed at the plant */
  floatRun: 0.5,
  /** a jump serve hit with the feet on the floor keeps this share of its pace (and so of its spin) */
  standingSpin: 0.7,
  /**
   * Foot fault (FIVB rule 12.4.3): at the hit, or at the take-off of a jump serve, the server
   * touches neither the court (the end line is part of it) nor the floor outside the service
   * zone, which is as wide as the court. The athlete is a point at the middle of the feet, so the
   * toes are taken to be `foot` m ahead of it. Landing in the court after the hit is allowed.
   * Only the player is called for it: the AI never misses a serve (`CONTACT.serveSafe`).
   */
  foot: 0.15,
  /**
   * A toss is hit at its top or on its way down: while it still rises faster than this (m/s) the
   * hand does not meet it (a swing then is a swing too early). Without it the ball passed through
   * the contact point on its way up, 0.1 s after it left the hand, and a swing there was a serve.
   */
  tossRising: 0.5,
} as const;

export const ASSIST = {
  /** 0..1 default aim assist strength */
  aim: 0.55,
  /**
   * The aim assist of an athlete nobody plays, whatever the player's settings say. It reaches the
   * three touches an AI player makes through the contact system, as a little more reach: a swing
   * (a spike or a serve) meets a ball `ai * reachBonus` further from the hand (6.6 cm), a pass or
   * a dig one 7.5 cm further from the arms, and a block's hands are 3.6 cm wider to each side
   * (`ContactSystem.reach`, `tryPass`, `tryBlock`). It does not reach an AI setter's set, which is
   * not played through the contact system, and it gives no mid-air nudge: that is for a player's
   * athlete only (`Simulation.step`). The one exception is a player's athlete that a drill hands to
   * a brain (`autoUser`): it keeps its seat, so its nudge is at this strength.
   * A number of the play, not a setting. Tuned by play, first seen in 9dee160 (2026-11-02), with
   * no reason recorded.
   */
  ai: 0.3,
  /** max horizontal mid-air nudge (m/s) at assist 1 */
  airMagnet: 1.2,
  /** reach bonus (m) at assist 1 */
  reachBonus: 0.22,
  /** slow-mo assist (settings toggle): timescale while lining up a contact, and how early it kicks in */
  slowmoScale: 0.55,
  slowmoWindow: 0.35,
  /** how fast the play eases into and out of every assist slow-mo (1/s): the speed never jumps. Tuned by play */
  slowmoEase: 12,
  /**
   * set slow-mo (settings toggle, on by default), the same on every level so the bar always looks
   * the same: from `setSlowmoWindow` s before the ball reaches your hands the game runs at
   * `setSlowmoCatch`; while the ball loads in your hands, at `setSlowmoLoad` (the bar fills in
   * TIMING.setLoad / setSlowmoLoad = 0.6 s on screen)
   */
  setSlowmoWindow: 0.35,
  setSlowmoCatch: 0.5,
  setSlowmoLoad: 0.25,
  /**
   * Set by feel (Settings: Set ring and bar off): with no timing cue on screen or in your ears,
   * the green, the good band and the clean catch are this much wider, so playing without the
   * cues pays (the user's call, 2026-11-18)
   */
  setByFeel: 1.2,
  /**
   * the play wheel is open (Setter Drill, before the pass): the game runs at this speed while you
   * choose. The Mini Rally never slows for it (its serve waits instead; in a rally only your set's
   * own slow-mo slows the game: the user's call, 2026-11-19)
   */
  playWheelSlow: 0.2,
  /**
   * The set's footwork (aim assist, `src/game/setAssist.ts`): while the ball is yours to set and
   * your feet are within `radius` m (at assist 1) of the spot, your body takes the last steps
   * onto it: at full shuffle pace from `slow` m out, easing to a stop within `stop` m. While you
   * push the stick (past `deadzone`) the pull is only `pull` of that, so you can walk off it.
   */
  setStep: { radius: 1.2, slow: 0.5, stop: 0.03, pull: 0.5, deadzone: 0.1 },
};

/**
 * The play designer (start screen, Plays). Two front-row hitters can't be given sets hit less
 * than `minGap` m apart along the net (a back quick for the middle and the opposite, a 2 and an
 * X): they would run into each other. The tandem and the X leave 0.75-0.9 m, at two tempos.
 * `nameMax`: the longest name that fits the wheel. `hutTop`: a set that peaks less than this many m
 * over the tape is a hut (medium tempo) on the route strip, higher a high ball; the hut peaks at
 * 1.15 m, the high balls at 1.45-1.65 m (`LANES` in game/plays.ts).
 */
export const PLAYBOOK = { minGap: 0.6, nameMax: 16, hutTop: 1.4 } as const;
