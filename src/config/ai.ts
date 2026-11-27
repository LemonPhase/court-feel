// How the AI players read, decide and err. Owner: the brains.
//
// What each section controls:
//
// `AI`: How long a jump set with the dump on holds their middle (`middle.dumpHold`); A pin hitter
// going inside: how far off square the run is, how much speed is kept through the plant and how
// much of it goes into the ball (`insideRun`); Your green set: who their middle bites on
// (`greenBite`, `greenBlockGuess`) and your hitter's bounce (`greenBounce`); how much an AI
// hitter's run across the court curves (`approach`); how late a hitter can still be asked for a
// fast set out of system (`oosAsk`); How often the pipe's hitter looks for the open spot
// (`pipe.open`), the 3 m line kept clear by a back-row hitter's take-off and the libero's hand set
// (`backRow`), where a scramble's ups go (`up`, `diveUp`), no approach for a set out of reach
// (`approachMiss`), no overhand free ball from deep (`freeOver.bumpFrom`); Reaction time and skill
// of hitters, blockers, defenders, setter accuracy; the Mini Rally middle blocker (`middle`: its
// reaction and read of the set, how often it commits on the quick or cheats to a pin, how close it
// closes on the pin blocker, how late it still jumps and how far it reaches sideways) and pin
// blockers (`wing`: how late a pin still goes up, how far out it goes at the antenna); how much
// room team-mates give each other (`giveWay`) and when the defence split-steps (`splitStep`); who
// the setter sets (`setWeight`) and how often the pipe (`pipe`); an overpass (`overpass`), an AI
// hitter misreading the user's block (`userBlockMisread`), who takes a ball (`pick`: first there
// takes it, the seam goes to the libero or you, the setter only when nobody else is close, a second
// ball the libero gets to is the libero's, and in defence (their attack, a tip, a free ball, a ball
// off a block) every ball it gets its platform to in time (`AI.digReach` from its feet):
// `liberoDig`; serve receive by lanes; no HELP call on a ball that is down `dive` s before anyone
// arrives); a block only from the net (`blockNet`), what players without the ball do in each of the
// ten situations (`sit`: the back row moving along the net with the ball, pin blockers fronting
// their hitters, the serve-receive transition and back-up, following the pass, waiting deeper out
// of system, closing on a scramble, each player's own offset for the rally), arriving on the
// hitter's contact instead of early (`pace`), turning to run a ball down (`chase`); where an AI
// free ball over goes (`freeOver`: a deep corner or short, wherever they aren't); perimeter defence
// read spots and reaction times (`defence`), early transition and the front row's transition off
// the net after a block (`transition`, `approachOff`: no quick from the net) and covering our
// hitter in the real 3-2 spots (`cover`: when, the middle at the net, the setter on the 3 m line,
// the back row behind and deep, how fast a coverer reads a ball off the block); when the setter
// calls the pass (`setterRead`), how far off the net is out of system (`outOfSystem`) and how much
// higher an out-of-system set goes (`outOfSystemApex`); the AI's serves (`serve`: jump share,
// run-up, toss, error, where they aim); the attack: swing timing error (`attackErr`), the open spot
// (`openShot*`, `digReach`, `digTop`, `blockReachBand`), where a quick goes (`quickShot`), how
// often the setter goes to the middle (`quickWeight`), fast sets to the pins (`tempo`), tool, roll
// and recycle shots (`toolShot`, `rollShot`, `recycleShot`), what a hitter under the ball does
// instead of a weak swing (`offSpeed`: a wipe off the block, a tip, a roll to the open court, or a
// hard swing through it); a backup's set off a hard ball (`backupSet`: the libero's or anyone's,
// how hard it is by time, distance and the run under it, how much it misses, the one barely reached
// that is bumped instead; never a set to the user), what an AI dive does with the ball (`diveUp`: a
// bit up, toward the middle) and when a free ball is aimed (`freeOver.aimSpeed`), a setter too late
// for the hands digging it (`lateSet`); how far out a ball must land before a receiver lets it go
// (`outJudge`) and how much a hard ball rushes an AI passer's timing (`passPressure`); first balls
// overhand (`overhand`), dives (`dive`, `stretch`: a last-ditch dive at a ball just past the hands;
// `anyway`, `anywayFar`: now and then a dive at one out of reach; `react`: none before a reaction
// to the touch; `back`, `chase`, `quick`: backwards only at the end of a chase, at a ball that
// isn't fast) and a second player running at a ball the first may not reach (`scramble`); your
// green set as a point (their middle's wrong guess, the wings' late read, the diggers' late start:
// `greenSet*`, `greenBlockGuess`) and how much harder your bad set is to hit (`badSetErr`,
// `badSetTip`); when a hitter backing off the net is ready for a called tempo run
// (`transitionReady`, `transitionLatest`); how often an AI setter runs a play from the wheel, on a
// free ball and off a perfect serve-receive pass (`plays`); what the players do between points
// (`between`: watching the ball down, the huddle, the celebration, the fives, the walk to the next
// spots, waiting for the serve)

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
    /**
     * The line digger's lane: from its sideline this far in (m). It stands in the middle of it
     * (`lineIn`), so a ball landing there is one it plays without a run; one landing further in is
     * the cross digger's or the middle back's (the seam, zone 6), and a coach calls it cross. Our
     * scouting reads line or cross by it (`AI.wing.scout`), so the block's read and the digger's lane
     * agree. Our own geometry (twice `lineIn`), not a measurement.
     */
    lineLane: 2.0,
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
    /**
     * our blockers on a pin set: the pin blocker lines up on the attack, shaded at most this far off it
     * (`pinShade`: outside against a hitter who hits line, inside against one who hits cross; the middle
     * closes `AI.middle.closeGap` inside it); a blocker's hands reach this far either side
     */
    shade: 0.25,
    handHalf: 0.325,
    /** against the quick: the middle back cheats up a little, to this depth */
    quickMiddleBack: 7.5,
    /** against a pipe (all three at the net block it, `AI.wing`): the corners step in and forward to here (x from the middle, depth), the middle back to this depth */
    pipeCornerX: 2.2,
    pipeCornerZ: 5.3,
    pipeMiddleBack: 8.0,
  },
  /**
   * Early transition: on an easy first ball (their free ball over, or our block softening their
   * attack to under `softSpeed` m/s) that our passer reaches with `spare` s to spare, the setter
   * releases to the net and the front row leaves it to approach, `read` s after the touch. Once
   * they have started they keep going: nobody turns back to the net half way.
   *
   * The back-row setter also releases to the net on its own on every ball coming over that someone
   * else is playing (their attack, a tip, a free ball or an overpass, a ball off either block), as
   * soon as it has read the touch (`AI.defence.hitReact`; `AI.cover.react` for a setter covering
   * our hitter), without waiting to see how good the first ball will be (MatusGib, 2026-11-14: a
   * setter still standing in defence when the pass is plainly going to be in system).
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
   * to spare: it calls off whoever was sent (a real libero takes every one of those it can). In
   * defence (their attack, a tip, a free ball) every ball an AI libero gets to in time, with
   * `liberoDig` s to spare (its platform there, `AI.digReach` from its feet, not its feet under the
   * ball), is the libero's and it calls off whoever was sent ("the libero should
   * always take the ball if he can": MatusGib, 2026-11-20; before, it needed 0.3 s to spare on a
   * free ball and claimed nothing of their attack, and 8 of 30 free balls it could reach went to a
   * pin hitter getting ready to attack). A ball off a block it takes on the same terms (with its
   * feet under the ball, a soft block beside a hitter landing at the net went to the hitter: "the
   * libero does not always take the ball even though they are in time", MatusGib, 2026-11-20; 9 of
   * 200 block balls coming down in our court in 16 x 600 s of all-AI rally went to the outside, 0
   * after). It calls "MINE!" on a free ball it takes and on a ball it takes from a team-mate who gets
   * there first. Only a ball down `mine` s or more after the libero is sent is called off an AI
   * team-mate, or reached for with its arms past one: a hard-driven ball goes to the libero only when
   * its feet get there in time (it takes the seam), otherwise to whoever it comes at, with no time to
   * shout (a word and a team-mate backing off: our own judgement; a 100 km/h spike to the back court
   * is down in 0.4 s, a roll shot, a tip, a free ball or a soft block in 1 s or more). A ball first
   * called the user's that the libero takes is always called, however soon it is down: never taken
   * off the user without a word. Serve
   * receive still goes by lanes. And between the user and an AI libero, any first ball the libero gets
   * to (with `libero` s to spare) is the libero's ("if the libero can take it, it takes it":
   * MatusGib, 2026-11-14); a serve only in the seam (the libero there within `seam` s of the
   * user, lanes counted as below): a serve in the user's lane is theirs (MatusGib, 2026-11-18;
   * measured before: the libero took 7 of 63 serves meant for an outside user, every one landing
   * 0.2-1.4 m from them, 0.5-1.1 s nearer the user). A ball is called early: once it has been the
   * user's for `call` s the libero no longer takes it off them. The setter calls HELP only on a ball
   * somebody can still get to: one that will be down more than `dive` s before the first of them
   * arrives (a shank into the stands) is the other team's point, and nothing is called. A serve is
   * received in lanes: a passer's run forward, to a ball coming down in front of them, counts only
   * `lane` of its length when choosing who takes it, so a serve short of the middle passer is theirs
   * and not the passer's two metres to the side of it (MatusGib, 2026-11-15: "it is right in front
   * of them").
   */
  pick: { seam: 0.15, setter: 0.2, shuffle: 1.5, libero: 0.1, liberoDig: 0, mine: 0.8, call: 0.4, dive: 0.5, lane: 0.3 },
  /**
   * An AI free ball over (a third ball nobody can attack) goes where it is hard to play: deep to a
   * back corner (`deep` m off the net, `side` m off the middle) or short, just over the net (`short`
   * m), whichever spot their nearest player is furthest from (plus up to `guess` m of guesswork).
   * `apex`/`shortApex`: the arcs. From further than `bumpFrom` m off the net it is always bumped,
   * never played overhand: nobody pushes a ball 12 m with the fingers (MatusGib, 2026-11-15).
   */
  freeOver: { deep: 7.3, short: 2.0, side: 2.8, apex: 5.0, shortApex: 4.0, guess: 1.0, aimSpeed: 2.0, bumpFrom: 6.0 },
  /**
   * A backup set (the setter dug the first ball or can't get to it: the libero sets, or whoever is
   * closest when the libero can't get there either) is as good as the ball lets it be: out of
   * system a team nearly always still puts a high ball up to a pin, just a rougher one (MatusGib,
   * 2026-11-14). Its difficulty (0-1, never under `base` for the libero, `otherBase` for anyone
   * else) grows as the time to spare drops under `easy` s, as it is played further than `offEasy`
   * m from the setter's spot (1 at `offEasy` + `offHard` m), and with the run under it: beyond
   * `runEasy` m, up to `run` at `runEasy` + `runHard` m, plus up to `away` more the more that run
   * goes away from the net (the set then goes back over the shoulder). Only over `noSet` (give or
   * take half of `noSetJitter`: a ball barely reached) is no set tried: it is bumped up high to the
   * 3 m line. A set that is tried misses its target by `miss` m (along the net, off the net, apex:
   * one sigma) times the difficulty, but never peaks lower than `minApex` m above the hitter's
   * contact: however rough, it is a high ball its hitter has time to get to, not a line drive
   * over the net. A set to the user is always clean (playability: the user's sets stay perfect).
   */
  backupSet: {
    base: 0.2,
    otherBase: 0.35,
    easy: 0.8,
    offEasy: 3.0,
    offHard: 6.0,
    runEasy: 1.5,
    runHard: 5.0,
    run: 0.5,
    away: 0.5,
    noSet: 0.95,
    noSetJitter: 0.1,
    miss: { x: 1.2, z: 0.5, apex: 0.8 },
    minApex: 1.2,
  },
  /**
   * An AI dive (Mini Rally) keeps the ball alive and no more: it goes between the two `apex` values
   * (m) above the hands and between the two `carry` values (m) toward
   * the middle of the court, up to `turn` rad to either side of that line, for a team-mate running
   * with the diver to play: no two dives pop it up to the same place. (A free ball over is aimed,
   * `freeOver`, only by a player moving slower than `freeOver.aimSpeed` m/s: one still scrambling
   * just gets it over.) The highest is what a dive can send a soft ball (`CONTACT.passPower.dive`
   * and some of the ball's own speed, about 6.5-7 m/s): a pancake pops it up a metre or two. It was
   * aimed 2-3.8 m up (with a metre more for any dive), then cut back to what the dive could do,
   * short of where it was aimed.
   */
  diveUp: { carry: [0.8, 3.5] as [number, number], apex: [1.0, 1.8] as [number, number], turn: 1.0 },
  /**
   * A scramble's second ball: one nobody could set (the setter called HELP, the libero could not
   * get under it either) is just kept up by an AI player, somewhere a team-mate can get to:
   * between `near` and `far` m from where it was played, towards the middle of our court give or
   * take `turn` rad, peaking between the two `apex` values (m) and at least `over` m above where it
   * was played, no nearer than `net` m to the net
   * and at most `out` m outside the lines. It used to go to one spot every time (the middle of
   * the court on the 3 m line, 5.2 m high), so every scramble ended with the same free ball from
   * the same place (MatusGib, 2026-11-15: far more randomness in where the ups go). The third
   * ball is then played from wherever that is. (The sizes are inferred.)
   */
  up: { near: 1.0, far: 5.5, turn: 1.3, apex: [3.0, 6.5] as [number, number], over: 1.0, net: 1.5, out: 0.5 },
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
   * the block in `react` s (a defender reading a hit: 0.3 s), still so `hold` s after the cover ends.
   */
  cover: { read: 0.2, net: 1.2, inside: 1.3, line: 3.0, behind: 2.5, deep: 6.3, react: 0.12, hold: 0.6 },
  /**
   * An AI hitter's swing timing is off by this much (s, 1 sd) plus 0.06 x (1 - skill): Early sails
   * long, Late goes into the net, Good scatters the shot. Men's pros still miss: about 62% kills at
   * 47% efficiency off a perfect pass (PlusLiga), so with ~10% of attacks blocked, roughly 5-8% are
   * hit out or into the net.
   */
  attackErr: 0.06,
  /**
   * An approach is only run for a ball the hitter gets to: one whose simulated run ends more than
   * this far (m, the feet) from where the ball must be met is not jumped for. A called run (a
   * quick, a go) that far off is not started and the hitter waits for a high ball; a set that far
   * out of reach (too tight, too flat, too far along the net) is left to whoever can keep it in
   * play. A hitter never goes up beside a ball it can't touch (MatusGib, 2026-11-15:
   * misconnections between the AI setter and hitter; measured: a flat backup set, the hitter in
   * the air 2.3 m from it).
   */
  approachMiss: 0.6,
  /**
   * A block goes up at the net: a blocker further than this (m) off it does not jump. One caught
   * off the net (it left to approach, and the ball came straight back) runs in and goes up late
   * from the net, or not at all: nobody blocks from 2 m out in the court.
   */
  blockNet: 0.9,
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
    /**
     * The setter's own attack holds it: off a jump set by a front-row setter who could have dumped
     * it (the dump was on, src/game/callRuns.ts), it reads the set this much (s) later. A middle has to
     * honour a setter in the air at the net until the ball leaves the hands; a setter on the
     * floor, or in the back row, holds nobody. A starting value, not yet tuned on seam counts.
     */
    dumpHold: 0.05,
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
  /**
   * The Mini Rally pin blockers (`BlockerBrain.wing`, `wingSpot`). Each blocks every attack on its
   * half of the net, wherever its hitter goes: a pin set, inside or out, on the hitter's hitting
   * shoulder taking the line (out to `outMax` at most); an inside ball (a 3, a shoot) beside the
   * middle, a double, if it can get there in time (a quick in front of the setter is the middle's).
   * A back-row attack (the pipe) is blocked by all three at the net, both wings closing on the
   * middle's shoulders (MatusGib, 2026-11-17: "Pipe block should be attempted by all players at the
   * net"). Beside the middle a wing closes on the middle it sees, not on its read of the ball; on its
   * own hitter it lines up on its read (`AI.blockerSkill`).
   *
   * A block goes up together: beside our middle a wing jumps with it, when the middle presses for
   * this ball (no more than `together` s before the wing's own time, or later), and waits up to
   * `wait` s for it (never past the hit) before going on its own. A middle late on the ball (it went
   * up with another hitter, then went again for this one) takes the whole block up late with it. On
   * its own hitter, and beside you, a wing goes on its own time.
   *
   * Late, a wing still goes up on time from up to `lateReach` m short of its spot, never once the
   * ball is hit, and in the air its hands keep going for the spot, up to `AI.middle.reach` m to the
   * side (a side block: "last second adjust to the set"). On time they are over it already, so a pin
   * blocker's block on a set it reads is what it was.
   *
   * Out at the pin its body goes no further than `outMax` m from the middle of the net (0.2 m inside
   * the antenna), as the pin blockers always have: on a set wide of the antenna it lines up there,
   * since the ball has to come back inside it. Sealing the antenna exactly (the outside hand on it,
   * 4.175 m) moved the pin 0.1-0.25 m inside on the usual set (met 3.9-4.2 m out) and cut the AI's
   * pin kills from 38-44% to 30-35% (all-AI Mini Rally, 2 seeds): a balance call for the players.
   *
   * Its own pin hitter going inside (met nearer than `insideX` m to the middle of the net: a 3, a 2,
   * an X, a back 2) it follows in, always (MatusGib, 2026-11-17: "they should follow the pin more
   * than they do currently, a lot of the time they just stand still"): beside the middle if the
   * middle is on the ball (within `onBall` m of it), else to the hitter, and goes up from up to
   * `chase` m short, its hands reaching for the ball. One it does not expect is late: `surprise` s
   * on top of its reaction, less the more that hitter has gone inside before. Every set to a pin
   * hitter moves our wings' read of them `learn` of the way to inside (1) or out at the pin (0),
   * so the first inside ball after a run of pin sets is the one that beats them.
   *
   * Along the net a wing faces the net: side steps, or a crossover (hips turned `hips` rad into the
   * run) with more than `crossover` m to cover on the floor; never a turn and a sprint. Closing in
   * (beside the middle, the pipe, its own hitter inside) it holds its read until its last steps run
   * into the jump, and the jump carries it the rest of the way, its hands reaching into the middle
   * (a drift block: "one side step and then jump with their hands into the middle"). Late, it still
   * steps into it: it plants once the jump's drift carries it the rest of the way, or at the last
   * moment that has its hands out at the hit. Out at the line it gets there and goes straight up.
   *
   * On a pin set it blocks the hitter (MatusGib, 2026-11-20: "when setting to the pin the pin
   * blocker should primarily try to block you"), never sliding in to close the gap to the middle (a
   * seam is the middle being late): it lines up on the ball, shaded `AI.defence.shade` at most to
   * the side that hitter hits ("if you hit line a lot he should block line, if you hit cross a lot
   * he should block cross"), and its hands stay on that line-up in the air. Our whole team scouts
   * their hitters (`Scout`, `TeamAI.scout`), whoever of ours is at the net, the user too, and both
   * wings, the middle and the perimeter defence play the same report: every pin spike of theirs
   * moves its read of that hitter `scout` of the way to line (0: it would land in our line digger's
   * lane, `AI.defence.lineLane`, or out wide of it) or cross (1: anywhere inside that), from
   * `scoutStart` (square on the ball: a hitter it has not seen). `scout` and `scoutStart` are a
   * choice for the top level, not a measurement: a top side adjusting to a hitter within a set,
   * which is what the report asked for (three line shots and it is taking the line). At lower levels
   * a block scouts slower or not at all (issue #137: Rec and Club never do), so `scout` becomes a
   * level number with the levels of play (issue #60).
   *
   * Its line-up on the set sharpens as the ball comes (its misread shrinks with the square of the
   * flight left, as `BallRead`): a pin blocker fronting its hitter sees where they will meet it. It
   * never sharpens past what its skill leaves it: down to `readFloor` × (1 − skill) of the misread
   * it started with, and its hands carry what is left. So a pin block's quality comes from the
   * blocker's skill, for the levels to turn: a good blocker (skill 1) has its hands on the ball at
   * the hit; a poor one (skill 0) is about a hand-width off on average (`readFloor` is picked for
   * that: as far off as every blocker's hands were before the read sharpened, 0.35 m mean on a high
   * pin set, 60 seeds).
   */
  wing: {
    lateReach: 1.2,
    outMax: 4.3,
    together: 0.15,
    wait: 0.4,
    insideX: 3.0,
    onBall: 1.0,
    chase: 2.0,
    surprise: 0.25,
    learn: 0.4,
    crossover: 1.5,
    hips: 0.6,
    scout: 0.35,
    scoutStart: 0.5,
    readFloor: 0.6,
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
   * not much more), and one arm reaches `CONTACT.diveOut.reach` m further than that. A ball further
   * out than that (up to `anywayFar` m beyond the hands), run at flat out, is dived for anyway
   * `anyway` of the time: they mostly don't get it, but nobody watches a ball drop (MatusGib,
   * 2026-11-14; 2026-11-20: they "should still try to dive and fully run and get balls they might
   * not be able to get", so it went from half the time to three in four).
   * A dive is the whole body thrown at the ball, so it waits for a real reaction to the touch: none
   * starts sooner than `react` s after it, and a ball only a dive started sooner would have reached
   * is not dived for (MatusGib, 2026-11-20: no dive at a hard hit "not within realistic reaction
   * time"; a coverer could dive at a ball off the block 0.08 s after it). A simple reaction to a
   * light is about 0.2 s (`reactionTime`); a defender's first move
   * on a hit is about 0.3 s (`cover`), and a dive commits the whole body, so 0.3 s is the soonest
   * (an estimate from those, not a measurement).
   * Nobody dives backwards at a serve or a spike: a dive that would go more than `back` (the share
   * of it pointing away from the net: 0.3 is about 17 degrees behind straight sideways) backwards
   * isn't made, and the ball is played on the feet or not at all. Forwards and sideways only; a
   * ball going over them is run down like any other (MatusGib, 2026-11-14). At any other ball, a
   * dive backwards is only the end of a chase: the player has turned to it (facing within about 45
   * degrees of the dive's way, the cosine over `chase`) and is running flat out that way (faster
   * than a shuffle), at a ball no faster than `quick` m/s. Never at a hard ball or a fast deflection
   * coming at them, whoever touched it (MatusGib, 2026-11-20: "diving backwards should only be
   * possible when chasing a ball and you are running then you dive to get it, never when defending
   * any hard hit or very quick ball"). A ball dropping out of a high flight comes down at 10-13 m/s;
   * a spike leaves the hand at 17-28 m/s, and a deflection off the block keeps much of that.
   * Nor does anyone dive into the net: a ball coming down within `net` m of it, or beyond it, is not
   * dived for or run at through the net (MatusGib, 2026-11-15: a setter diving into the net after a
   * pass that went over).
   */
  dive: {
    late: 0.9,
    minDist: 1.0,
    fit: 0.35,
    stretch: 0.6,
    anyway: 0.75,
    anywayFar: 2.5,
    react: 0.3,
    back: 0.3,
    chase: 0.7,
    quick: 14,
    net: 0.6,
  },
  /** a platform put out for a ball the player is no longer sent to is dropped after this long (s) */
  passDrop: 0.35,
  /**
   * A pass that comes down to the setter's hands within `tightPass` m of the net's plane (or over
   * it) is out of system whatever its place along the net: a save at the tape, no quick. (The ball
   * is 0.1 m wide either side of its centre: at 0.3 m its edge is a hand's width off the net.)
   */
  tightPass: 0.3,
  /**
   * Situations (src/ai/situation.ts; F3 shows the one each team is in). Players with no job of
   * their own move with the play instead of waiting on a fixed formation spot:
   * - the ball on their side (`ourServe`, `ourAttack`, `theirFirstBall`): the back row's base
   *   defence shifts along the net by `ballSide` of the ball's distance from the middle of the
   *   court, at most `ballSideMax` m; once they have the ball a pin blocker fronts its hitter,
   *   standing between `frontMin` and `frontMax` m from the middle (USA Volleyball and GMS blocking
   *   basics: "front your hitter"; the back row's shift and its size are inferred);
   * - `theirServe`: `serveRead` s after the serve the players it is not going to are on their way:
   *   the setter to the target and the front row to their approach starts, and the passers beside
   *   the receiver step `backUp` of the way towards it (at most `backUpMax` m, never nearer than
   *   `backUpKeep` m) to back it up (not when it is the user's ball: nobody steps at a ball that
   *   is yours). Before that, their server's toss for a jump serve is read: the three passers
   *   step `jumpBack` m back for it (a jump serve comes in hard and deep, and it is easier to
   *   move forward to a ball than back; the size is inferred);
   * - `ourFirstBall`: the back row follows the pass, `follow` of the way towards where it comes
   *   down (at most `followMax` m); called out of system, the hitters wait `outDeep` m deeper for
   *   the high ball (a full approach);
   * - `scramble` (a ball off a block, a ball the setter calls HELP on): everyone not playing it
   *   closes `chase` of the way on where it comes down (at most `chaseMax` m), never nearer than
   *   `chaseKeep` m to it: the next option and the back-up, without crowding.
   * `personal`: every player stands a little off the book spot, their own habit for the rally (m,
   * 1 sd, rolled once a rally): no two rallies line up exactly the same. 0 turns a rule off.
   */
  sit: {
    ballSide: 0.25,
    ballSideMax: 1.2,
    frontMin: 2.2,
    frontMax: 3.9,
    serveRead: 0.35,
    jumpBack: 1.0,
    backUp: 0.3,
    backUpMax: 1.5,
    backUpKeep: 1.5,
    follow: 0.3,
    followMax: 1.5,
    outDeep: 0.6,
    chase: 0.35,
    chaseMax: 3.0,
    chaseKeep: 2.5,
    personal: 0.15,
  },
  /**
   * Arriving on the cue. A defender reading their set, and a team-mate covering our hitter, has
   * to be set by the hitter's contact, not before: it shuffles there at the pace that arrives
   * `early` s ahead of the contact (stopped and balanced for it), never slower than `min` of a
   * shuffle's top speed, instead of sprinting there and standing. If a shuffle would be late it
   * goes as fast as it takes. (Real defenders move with the set and stop for the hit: "be stopped
   * and balanced at contact", the read sequence in section 9 of the AI movement notes.)
   */
  pace: { early: 0.25, min: 0.3 },
  /**
   * Running a ball down: further than `turn` m from where they will play it (or from a spot they
   * were sent to in a hurry: running with a team-mate at a ball, the setter releasing to the net)
   * a player turns and runs, facing where they are going, flat out and upright; nearer, they
   * square up to the net (or to their set). Shuffling sideways at the net's angle is for short
   * moves ("turn and run" beyond a couple of steps: blocking and defence footwork, section 8 of
   * the AI movement notes).
   */
  chase: { turn: 1.5 },
  /**
   * The 3 m line. A back-row player may attack above the net only after taking off behind the
   * attack line, and a libero's overhand set from the front zone can't be attacked above the net;
   * the line is part of the front zone (FIVB rules 13.2.3, 19.3.1.4, 1.3.4). So an AI back-row
   * hitter (the pipe, the D) plants with the middle of its body at least `clear` m behind the line
   * (the feet are ahead of it in the plant, and a shoe is about 0.3 m long), and an AI libero
   * hand-sets only from that far behind it: nearer, it bump-sets. (MatusGib, 2026-11-15: the pipe
   * hitter and the libero setting overhand sometimes stepped on the line. Measured before: the
   * pipe took off 2-15 cm behind the line every time, 13 of 13.)
   */
  backRow: { clear: 0.25 },
  /** an AI setter whose ball has dropped this far (m) below their standing hands, not under them, digs it instead (platform or dive) */
  lateSet: 0.15,
  /** a ball the defender sent for would reach with less than this (s) to spare: a team-mate runs at it too */
  scramble: 0.1,
  /**
   * The pipe. How much the setter likes it against `setWeight` (`inSystem` off a good pass,
   * `outOfSystem` off a bad one). From behind the 3 m line the hitter looks for the open spot only
   * `open` of the time in system; otherwise it takes one of its usual deep shots (line, cross, the
   * seam). It used to go to the same corner (MatusGib, 2026-11-15; measured before: 9 of 11
   * shots at the open spot, 6 of them the same deep corner).
   */
  pipe: { inSystem: 0.35, outOfSystem: 0.1, open: 0.4 },
  /**
   * Mini Rally serves (`src/ai/server.ts`). `jump` of the serves are jump serves: the server starts
   * `jumpBack` m behind the end line, walks `jumpStep` m into the toss, tosses the ball `jumpTossHigh` m over their standing reach
   * (about 1.3 m over the contact: the toss drops into a three-step run-up, not out of the sky) and
   * `jumpToss` m forward (where it would come back down to toss height), runs in, takes off behind
   * the line and lands in the court (FIVB rule 12.4.3); the rest are standing floats (`SERVE.float`'s toss). The player's own
   * jump serve toss is higher (`SERVE.jump`). The target is the seam between two passers,
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
   * and CONTACT.digLunge at a hard-driven ball) once it is below `digTop` m (the libero's claim on a
   * ball in defence, `pick.liberoDig`, counts the same reach). In system an AI hitter
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
   * Combination plays (COMBOS, the play wheel) run by an AI setter. On their free ball ("FREE!")
   * the setter calls one `free` of the time, and it runs off any pass in system. Before their serve
   * the setter signals one `receive` of the time, and it runs only off a perfect pass (within
   * `quickWeight.perfectOff` m of the setter's spot): off anything less the play is off and the
   * setter runs the base sets (the user's call, 2026-11-18: a team drilled on a free ball, careful
   * in serve receive). Out of system every set goes up high, play or not. Each team draws its plays
   * from its own dice (`seed`, home and away), so calling plays never shifts the rally's own draws.
   */
  plays: { free: 0.6, receive: 0.25, seed: { home: 4101, away: 4102 } },
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
  /**
   * An AI hitter under the ball (its swing would be graded Early) never sends a light ball sailing
   * out past the end line: a light ball is a choice (MatusGib, 2026-11-14). `adjust` of the time it
   * feels it and plays the ball off-speed, its timing error cut to x `timing` (a soft touch needs
   * little timing): pushed at the outer edge (`wipeEdge` of the hand's half-width) of the outside
   * hand of a block within `blockNear` m in front (weight `wipe`: off it and out, aimed `wipeZ` m
   * past the net), tipped short over the block (`tip`, aimed `tipZ` m past it), or rolled (`roll`)
   * to whichever of the deep corners (`deep` m off the net; `lineIn` m in from the sideline down the
   * line, `crossIn` m cross court), the middle of the court (`middle`) and the short cross-court angle (`short`) their
   * nearest player is furthest from (plus up to `guess` m of guesswork). The rest of the time it
   * swings through it, a full swing: hard, and long (the hitting error of a real match: about
   * 5-8% of attacks hit out or into the net, see `attackErr`).
   */
  offSpeed: {
    adjust: 0.3,
    timing: 0.3,
    wipe: 1.0,
    tip: 0.6,
    roll: 1.2,
    wipeEdge: 0.85,
    wipeZ: 0.2,
    tipZ: 2.0,
    lineIn: 0.8,
    crossIn: 1.2,
    blockNear: 1.6,
    deep: 7.4,
    middle: 5.2,
    short: 3.3,
    guess: 1.0,
  },
  /** an AI player lets a ball go that will land more than this (m) out; closer to the line it is too close to call and played */
  outJudge: 0.2,
  /** an AI passer's platform timing error grows by this factor at a ball arriving at 22 m/s or more (from 12 m/s up): less time to read it */
  passPressure: 1.0,
  /** a pass the setter takes further than this (m) from their spot is out of system: high balls only, no quick */
  outOfSystem: 1.6,
  /**
   * Out of system the user setter can still ask a hitter for their fast set, if they hear it in
   * time: a quick this long (s) before the ball leaves the setter's hands, a second-tempo run
   * (a go, a fast back) this long. Later than that they stay for the high ball.
   */
  oosAsk: { quick: 0.6, tempo: 0.75 },
  /**
   * Transition: a hitter still at the net when their team digs (they were blocking) backs off to
   * their approach start before a tempo run (the quick, a called go / 3 / fast back / back 2).
   * Within `transitionReady` m of it they are ready to run; with less than `transitionLatest` s to
   * their takeoff left they go from wherever they are (the quick and a fast set still need
   * `transition.approachOff` m off the net: never a standing quick).
   */
  transitionReady: 0.5,
  transitionLatest: 0.95,
  /** an out-of-system set (and a backup's set, when the setter played the first ball) goes this much (m) higher */
  outOfSystemApex: 0.4,
  /**
   * An AI hitter's run across the court curves (src/game/approach.ts, bendFor): a run more than
   * `straight` rad off square to the net bends by `share` of the excess, at most `maxBend` rad,
   * leaving that much flatter along the net and arriving that much squarer to it. Runs shorter
   * than `minRun` m stay straight. The turn is done over the first `ground` of the way (the run
   * on the floor); the rest is the jump, flown straight off the last step. A real hitter loops
   * in on an X or a 2; a straight diagonal line at the spot is what nobody does. The bent run
   * still starts at least `towardNet` rad (about 5°) off along the net: never heading away from it.
   */
  approach: { straight: 0.35, share: 0.8, maxBend: 0.42, minRun: 1.5, ground: 0.6, towardNet: 0.08 },
  /**
   * A pin hitter going inside (the 3, the 2, the X, the back 2): a run more than `angle` rad off
   * square to the net, at least `minRun` m long. They wait where their pin sets start and break
   * inside as late as the sprint allows, and they do not brake for the jump: `carry` of the run's
   * speed is kept through the plant (a standing plant keeps PLAYER.plantCarry), so the jump is a
   * broad jump along the run and the ball is met on the move. They hit where they are going: the
   * swing is along the run, and `swing` of the body's speed along the shot goes into the ball (a
   * hand moves with the body it is on). Off your green set that is the bounce, along the run.
   * A broad jump leaves the floor sooner, so the run's turn (`approach`) is done over the first
   * `ground` of the way.
   */
  insideRun: { angle: 0.7, minRun: 2.5, carry: 0.62, swing: 1, ground: 0.45 },
  /**
   * Your green set is a point (the user's call, playtest 2026-11-08: a green set always scores,
   * a bad one very rarely). An exact set at the called tempo gives the block nothing early, so
   * their middle goes on what it sees and never gets to the ball (`greenBite`, `greenFooled`);
   * the pin blockers block as on any set, so your hitter has one block to beat and bounces it
   * past them (`greenBounce`); their diggers start late (`greenSetDigDelay`). Off a pass out of
   * system a high ball to a pin fools nobody: their middle closes the block, and it is a full
   * swing at two blockers, not always a kill. No block stuffs an attack off a green set: it comes
   * off the hands soft or wide, and off a late or early block always wide (ContactSystem.tryBlock).
   * The numbers are the browser probes' (the set bot, 96 green sets in system, 96 points).
   *
   * The drills' `BlockerBrain` middle, with nobody else going, guesses a side: on a pin set it
   * stays home for the quick, on the quick or the pipe it steps this far (m) towards a pin
   * (about half the way from the middle of the net to a pin hitter's spot).
   */
  greenBlockGuess: 2.2,
  /**
   * The Mini Rally middle goes up with a hitter you did not set (src/ai/greenBite.ts): one within
   * `maxOff` m of the net (an approach start is about 4 m off it) and up, or running in faster
   * than `runSpeed` m/s (a walk is slower); one who is up comes first (a runner counts as
   * `runPenalty` m further away), and it leads a runner by `lead` s. A runner is one coming in
   * at the net at more than `toNet` m/s, not jogging back to base.
   */
  greenBite: { maxOff: 4.5, runSpeed: 2, runPenalty: 3, lead: 0.2, toNet: 1 },
  /**
   * How your green set fools their Mini Rally middle (src/ai/middle.ts) without it ever moving
   * away from where its block belongs, bar a route's width (playtest, 2026-11-17: a middle in the
   * right place that ran off the other way looked like a coin flip). Already within `near` m of
   * that spot, it stays and guesses wrong there: up with a hitter you did not set beside it; or up
   * for the next route, `shift` m along the net (a route's width: the push is 0.7 m from the quick),
   * on their hitter's jump: on a push or a shoot it goes for the quick in front of the setter, on
   * that quick for the push; or, on a pin set, with its hands `shift` m inside the block, off the
   * line; it sees the attack only when it is hit. Further away it goes up with a quick within
   * `near` m of it (a combination), or holds, until it sees where the set is going, once `realise`
   * of its flight is gone. Then it does all it can to block it anyway (playtest, same day): its
   * hands in the air go for the attack, it runs at it, and while the ball is still to be hit and
   * it is near enough (AI.middle.lateReach) it goes up again: after a quick it bit on, for the
   * pipe or an inside ball; after a hold, for the pin. That jump is `late` s after the one that
   * would have blocked it, a beat behind what it never expected: its hands are coming up as the
   * ball goes by, and the hitter puts it past them.
   */
  greenFooled: { near: 1.5, shift: 0.7, realise: 0.45, late: 0.25 },
  /**
   * Off your green set the hitter bounces it (HitterBrain.bounce): a full swing, as steep as the
   * net allows: the nearest spot, at one of `depths` m from the net, that a full-speed spike brings
   * down within `fit` m of it and `lineIn` m inside the lines, and that clears the tape by `clear`
   * m. The spots across the court are `edgeIn` m inside the sidelines. It crosses the net at
   * least `hands` m clear of a blocker's hands (`reach` m clear of them where they reach over the
   * net or hang behind it). A blocker still running along the net faster than `closing` m/s
   * counts as up where it is going: where its hands will be as the ball crosses, `lead.react` s
   * plus the spike's flight to the net at `lead.speed` m/s (a spike travels about 20 m/s, so a
   * pipe from the 3 m line gives the block longer). Any other shot off a green set (the hitter's
   * usual choice, when there is no bounce) passes `wide` m clear of the hands, against 0.3 m on
   * an ordinary set, and lands `lineIn` m inside the lines.
   */
  greenBounce: {
    depths: [2.4, 2.9, 3.4, 4.0, 4.8, 5.8],
    clear: 0.05,
    hands: 0.35,
    reach: 0.2,
    closing: 1,
    fit: 0.5,
    lineIn: 0.3,
    edgeIn: 0.9,
    lead: { react: 0.05, speed: 20 },
    wide: 0.45,
  },
  /** off your green set their diggers start this late (s): the hitter hid the shot until the hand (the user's call, playtest 2026-11-08) */
  greenSetDigDelay: 0.5,
  /**
   * From behind the 3 m line (a pipe: within `line` m of it or deeper) an AI hitter aims at least
   * `deep` m from the net: the short angles cannot come down that soon (the spike would carry
   * deep, over a different part of the net than the one planned)
   */
  backRowAim: { line: 0.5, deep: 5 },
  /**
   * A bad set (your early / late push) is harder to hit: your hitter's timing error grows by up
   * to this factor and they tip or roll it this many times more often.
   */
  badSetErr: 3.5,
  badSetTip: 4,
  /**
   * Between points in the Mini Rally (`src/ai/betweenPoints.ts`). On a real court nobody stands
   * still after the whistle: the team comes together (a huddle in the middle of the court, the
   * scorer mobbed after a big point, or fives with whoever is near on the way back), then walks to
   * the spots for the next serve, and waits there shifting their weight, wiping their hands,
   * looking at the server and at each other. It fills the dead time the drill already has
   * (`MINI_RALLY.timing`): nobody is on a different spot at the serve and the serve comes no later.
   * - `seed`: each team's own dice for it (home, away), apart from the simulation's: the rallies
   *   keep the random stream they had.
   * - `react` (s): after the whistle a player watches where the ball went for this long (uniform
   *   between the two), and only then turns to the team; one still in the air or on the floor
   *   after a dive first gets up (and stands `getUp` s). The one who won the point reacts at once
   *   (`heroReact` s).
   * - `walk`, `jog` (m/s): the pace back to the spots is a walk when there is time and a jog at
   *   most; only a player who would be late runs (a relaxed adult walk is 1.3 to 1.5 m/s). They
   *   mean to be on the spot (within `arrive` m) `settle` s before the whistle, the server too, who
   *   then takes a moment at the line (`serverReady` s, uniform: a breath, a look at where it goes)
   *   before their own wait and toss. The serve comes when it did when the server walked out at
   *   the whistle (the time from one point to the next serve is unchanged).
   *   A walk slows only over its last `stop` m (a step or so), not from far out.
   * - `style`: how the team comes together, weighted. `big`: after our kill, block or ace (the
   *   scorer is mobbed, a huddle, or fives on the way back); `won`: any other point of ours;
   *   `lost`: a point of theirs.
   * - `huddle`: the ring stands `spacing` m between neighbours (shoulder to shoulder) round a point
   *   `pull` of the way from the team's middle to (0, `z`) m in their court; a player more than
   *   `reach` m from it walks straight back instead. Once the last is in it holds for `hold` s
   *   (uniform), and breaks `latest` s after the whistle at the latest, whoever is still coming (a
   *   player joins only if they can still be on their spot in time from a ring that breaks then, at
   *   a jog). They come in at a brisk walk (`gather` m/s) at least, quicker if it takes that to be in
   *   before the ring has to break. `middle` of the huddles have the hands in the middle, the rest
   *   the arms round the shoulders. A ring is
   *   counted from `min` players, and its middle stays within `x` m of the middle of the court and
   *   between `near` and `far` m from the net. You are in it when you stand within `you` m of it.
   * - `mob`: team-mates come round the scorer `radius` m off, and slap their hands.
   * - `five`: walking back without a huddle, team-mates within `pair` m of each other pair up for a
   *   five (`share` of the pairs), meet `apart` m from each other (an arm's length each) with the
   *   hand up `raise` s before; `high` of the fives after a point won are high (the rest at the hip;
   *   after a point lost they are all at the hip). A pair still `slack` m further apart than that
   *   keeps closing; one that has not met `giveUp` s before the whistle leaves it.
   * - `feel`: what each player's body does as they turn away, weighted. `hero`: the one who won
   *   the point (fist, roar, arms up); `won`: the others; `error`: after a point their own error
   *   gave away (one of ours touched it last); `lost`: the others after a point lost.
   * - `lasts` (s): how long each of those takes (`clap` is one clap, `claps` how many, uniform);
   *   `five` is how long the hand takes to come down after the slap.
   * - `tired` (s): a rally this long leaves everyone breathing hard; a longer one, hands on the
   *   knees (after `knees` of it, for `kneesShare` of the players).
   * - `wait`: on the spot, the eyes move every `glance` s (to `look`, weighted: the server, a
   *   team-mate, across the net) and a fidget comes every `fidget` s (uniform; `fidgets`, weighted:
   *   wiping the hands, shaking them out, a bounce on the toes). Passers wait bent over with their
   *   hands on their knees `passerKnees` of the time, and sit into the passing stance `ready` s
   *   after the whistle (uniform); the serving team's front row shows the block behind its back
   *   from `signal` s before the whistle until the server tosses. The eyes are `eye` of a player's
   *   height up.
   * From watching club and international matches (rally to serve), not from a measurement.
   */
  between: {
    seed: { home: 5201, away: 5202 },
    react: [0.2, 0.6] as [number, number],
    getUp: 0.15,
    heroReact: 0.08,
    walk: 1.4,
    gather: 2.0,
    serverReady: [0.9, 1.8] as [number, number],
    jog: 2.8,
    arrive: 0.12,
    settle: 0.3,

    stop: 0.4,
    style: {
      big: { mob: 0.5, huddle: 0.35, loose: 0.15 },
      won: { mob: 0, huddle: 0.55, loose: 0.45 },
      lost: { mob: 0, huddle: 0.45, loose: 0.55 },
    },
    huddle: {
      spacing: 0.58,
      pull: 0.5,
      z: 4.0,
      reach: 4.2,
      hold: [0.3, 0.65] as [number, number],
      latest: 2.2,
      middle: 0.4,
      min: 3,
      x: 3.0,
      near: 1.8,
      far: 6.5,
      you: 1.5,
    },
    mob: { radius: 0.85 },
    five: { pair: 3.2, share: 0.75, apart: 0.9, raise: 0.32, high: 0.6, slack: 0.2, giveUp: 1.2 },
    feel: {
      hero: { fist: 0.35, roar: 0.35, armsUp: 0.3 },
      won: { clap: 0.35, fist: 0.25, armsUp: 0.1, none: 0.3 },
      error: { sorry: 0.65, hips: 0.2, none: 0.15 },
      lost: { hips: 0.3, clap: 0.3, none: 0.4 },
    },
    lasts: {
      fist: 0.9,
      roar: 1.1,
      armsUp: 1.2,
      clap: 0.34,
      sorry: 1.1,
      hips: 2.4,
      knees: 1.6,
      wipe: 0.9,
      shake: 0.8,
      bounce: 0.7,
      pat: 0.8,
      five: 0.5,
    },
    claps: [2, 4] as [number, number],
    tired: 14,
    knees: 0.75,
    kneesShare: 0.5,
    wait: {
      glance: [0.7, 2.0] as [number, number],
      look: { server: 0.55, mate: 0.25, across: 0.2 },
      fidget: [1.4, 3.2] as [number, number],
      fidgets: { wipe: 0.35, shake: 0.25, bounce: 0.25, none: 0.15 },
      passerKnees: 0.6,
      ready: [0.15, 0.5] as [number, number],
      signal: 1.8,
      eye: 0.93,
    },
  },
};
