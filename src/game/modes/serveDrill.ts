import { COURT, SERVE, SERVE_DRILL, SERVE_KINDS, type ServeKind } from '../../config';
import { planApproach, simulateApproach } from '../approach';
import { SLOT_ROLE, TeamAI, type Slot } from '../../ai/team';
import { Athlete } from '../athlete';
import { aimPitchFor, type ContactEvent } from '../contact';
import type { Outcome } from '../judge';
import { BACKUP_TARGET } from '../plays';
import type { ApproachLine } from '../tutorial';
import { kbd } from '../../core/kbd';
import type { GuideMark } from './markers';
import { Mode } from './mode';
import { ratePass } from './receiveDrill';

/**
 * - `ready`: behind the end line with the ball, nothing tossed yet
 * - `toss`: the toss is up
 * - `flight`: the serve is on its way and nobody has played it
 * - `result`: the serve is rated (by their pass, an ace or a fault) and the ball is dead
 */
type Phase = 'ready' | 'toss' | 'flight' | 'result';

/**
 * Who the serve is served at: a three-player reception, the two outside hitters and the libero in
 * their receive spots. In a real reception those three take every serve while the setter, the
 * middle and the opposite stand out of the way (the team AI never gives them a serve either), so
 * the other three are left out: the rep ends on the pass, and nobody plays it on (turned down: the
 * receiving team playing the pass out to their attack, which made every rep wait for a rally).
 */
const RECEIVERS: readonly Slot[] = ['OH1', 'OH2', 'L'];

/**
 * How a serve is rated, the way coaches chart serves: by the pass it forces (0-4). Their pass is
 * rated 0-3 as in the Serve Receive drill (`ratePass`), and the serve scores the other end of it.
 */
export type ServeRating = 0 | 1 | 2 | 3 | 4;

/**
 * the serve's rating for a pass rated `pass` (0-3) or going `over` the net. A pass rated 0 (one
 * that leaves the court, where nobody can play it) is charted as an ace, as coaches chart a shank.
 */
export function rateServe(pass: number, over: boolean): { rating: ServeRating; label: string } {
  if (over) return { rating: 3, label: 'OVERPASS' };
  if (pass >= 3) return { rating: 1, label: 'PASSED TO TARGET' };
  if (pass === 2) return { rating: 2, label: 'PASSED OFF THE NET' };
  if (pass === 1) return { rating: 3, label: 'OUT OF SYSTEM' };
  return { rating: 4, label: 'ACE · SHANKED' };
}

/**
 * Serve drill: the player serves at a three-player reception, with the serve they picked (keys
 * 1-3: standing float, jump float, jump serve). Every serve is rated by the pass it forces, and the
 * rep ends there.
 */
export class ServeDrill extends Mode {
  readonly id = 'serve' as const;
  away!: TeamAI;
  private phase: Phase = 'ready';
  private t = 0;
  private kindIdx = 0;
  private last: { rating: ServeRating; label: string; kmh: number } | null = null;
  /** ratings so far, by serve */
  private sums: Record<ServeKind, { n: number; sum: number }> = {
    float: { n: 0, sum: 0 },
    jumpFloat: { n: 0, sum: 0 },
    jump: { n: 0, sum: 0 },
  };
  private kmh = 0;
  private guide!: GuideMark;
  /** where the feet should be when a jump float or a jump serve is hit, once its toss is up */
  private spot: { x: number; z: number } | null = null;
  private goAt = -1;
  private pulse = 0;
  /** the run-up under the toss, for a serve lesson (as the Spike Drill gives it for a set) */
  private line: ApproachLine = {
    tGo: -1,
    tPlant: -1,
    hold: 0,
    dirX: 0,
    dirZ: -1,
    yaw: 0,
    spot: { x: 0, z: 0 },
    start: { x: 0, z: 0 },
    plant: null,
  };
  /** a serve lesson has been told this rep's ball is in the server's hand */
  private fed = false;

  get kind(): ServeKind {
    return SERVE_KINDS[this.kindIdx];
  }

  /** where the drill stands the server for the serve picked */
  private get start(): { x: number; z: number } {
    return { x: SERVE_DRILL.x, z: COURT.halfLength + SERVE[this.kind].back };
  }

  setup(): void {
    const g = this.g;
    this.away = new TeamAI(-1, g);
    let seed = 70;
    for (const slot of RECEIVERS) {
      const a = new Athlete(SLOT_ROLE[slot], -1);
      g.addAthlete(a, seed++);
      this.spawned.push(a);
      this.away.add(slot, a, false);
    }
    this.guide = g.markers.approachGuide();
    // a serve lesson teaches one serve: it is picked for the player and the keys stay quiet
    const lesson = g.tutorial.serving ? SERVE_KINDS.indexOf(g.tutorial.lesson as ServeKind) : -1;
    if (lesson >= 0) this.kindIdx = lesson;
    g.serveKind = this.kind;
    g.placeUser(this.start.x, this.start.z, 0);
    if (!g.settings.firstPerson) g.rig.pitch = aimPitchFor(SERVE_DRILL.lookDepth, false);
    this.reset();
    g.hud.gradeAside = true;
    this.refreshHud();
    // (on touch the key names become the buttons': "toss: Q" reads "toss: TOSS")
    // the lesson speaks through the coach line: the drill's own intro stays down
    if (!g.tutorial.serving) g.hud.message('Pick your serve: 1 2 3 · hold to toss higher: Q · serve at the seams', 3.5);
  }

  refreshHud(): void {
    this.g.hud.setTitle(this.g.tutorial.serving ? `Serve Drill · ${SERVE[this.kind].name}` : 'Serve Drill');
    this.updateScore();
  }

  /** the run-up under the toss in the air (a serve lesson reads it) */
  approachLine(): ApproachLine {
    return this.line;
  }

  /** pick the serve for the next toss (0-based: standing float, jump float, jump serve) */
  selectCall(i: number): void {
    if (this.g.tutorial.serving) return;
    if (i < 0 || i >= SERVE_KINDS.length || i === this.kindIdx) return;
    this.kindIdx = i;
    const g = this.g;
    g.serveKind = this.kind;
    g.hud.message(`Serve ${i + 1}: ${SERVE[this.kind].name}`, 1.6, false);
    this.updateScore();
    // nothing tossed yet: walk to where this serve starts
    if (this.phase === 'ready') this.toStart();
  }

  private toStart(): void {
    const g = this.g;
    const s = this.start;
    if (Math.hypot(g.me.pos.x - s.x, g.me.pos.z - s.z) > SERVE_DRILL.startSlack || g.me.state !== 'ground') g.returnUser(s.x, s.z, 0);
  }

  /** a new rep: the receiving team back in its formation, the ball back in the server's hand */
  private reset(): void {
    const g = this.g;
    g.ballLive = false;
    g.judge.disarm();
    g.ball.hide();
    g.contact.serving = null;
    this.away.serving = false;
    this.away.place('receive');
    this.spot = null;
    this.goAt = -1;
    this.line.tGo = this.line.tPlant = -1;
    this.line.plant = null;
    this.fed = false;
    this.toPhase('ready');
  }

  private updateScore(): void {
    if (this.g.tutorial.serving) {
      // the lesson's line leaves off the average: one serve, one story
      const rep = this.phase === 'result' ? this.reps : this.reps + 1;
      this.g.hud.setScore(`${SERVE[this.kind].name} · rep ${rep}`);
      return;
    }
    const k = this.sums[this.kind];
    const avg = k.n ? ` · avg ${(k.sum / k.n).toFixed(2)} of 4` : '';
    const last = this.last ? ` · last ${this.last.rating}${this.last.kmh ? ` (${this.last.kmh.toFixed(0)} km/h)` : ''}` : '';
    this.g.hud.setScore(`Serve ${this.kindIdx + 1}: ${SERVE[this.kind].name}${avg} · rep ${this.reps}${last}`);
  }

  hint(): string {
    const pick = `${kbd('1')}${kbd('2')}${kbd('3')} serve`;
    // you aim where you look. In first person the higher the look the deeper the aim (level is at the foot of the net);
    // a hard topspin serve aimed short is in the net, so it goes at the back of their court
    const fp = this.g.rig.mode === 'fp';
    const aim = fp ? 'the higher you look, the deeper you aim' : this.kind === 'jump' ? 'aim deep' : 'aim with the mouse';
    if (this.phase === 'ready') {
      if (this.g.userReturning) return `Back behind the end line · ${pick}`;
      return this.kind === 'float'
        ? `hold ${kbd('Q')}: longer is a higher toss · hold ${kbd('LMB')}, release as the ball comes down · ${aim} · ${pick}`
        : `hold ${kbd('Q')}: longer is a higher toss · ${kbd('Shift')}+${kbd('W')} run in under it · ${kbd('Space')} jump · hold/release ${kbd('LMB')} · ${aim} · ${pick}`;
    }
    if (this.phase === 'toss')
      return this.kind === 'float'
        ? `Hold ${kbd('LMB')}, release as the ball comes down · ${aim}`
        : `${kbd('Shift')}+${kbd('W')} run in · ${kbd('Space')} jump behind the line · hold/release ${kbd('LMB')} · ${aim}`;
    return `${pick} · ${kbd('N')} next serve · ${kbd('V')} camera`;
  }

  /** the ball is the player's only while it is their own toss: what the other side does with the serve is not their rep */
  userBall(): boolean {
    const lt = this.g.ball.lastTouch;
    return !!lt && lt.athlete === this.g.me && lt.kind === 'feed';
  }

  ballDead(): boolean {
    return this.phase === 'ready' || this.phase === 'result' || super.ballDead();
  }

  canServe(a: Athlete): boolean {
    const g = this.g;
    // a lesson's welcome, and the coach's line about the last serve, hold the toss
    return a === g.me && this.phase === 'ready' && !g.userReturning && !g.tutorial.holdingFeed() && !g.tutorial.holdingResult();
  }

  passTarget(a: Athlete) {
    const team = this.away;
    const s = a.side;
    if (s === team.side) {
      if (a.state === 'dive') return team.diveUpTarget(this.g.ball.pos);
      if (team.touches === 0) return team.firstBallTarget(a);
      if (team.touches >= 2) return team.freeOverTarget();
    }
    return { x: BACKUP_TARGET.x * s, y: BACKUP_TARGET.y, z: BACKUP_TARGET.z * s, apex: BACKUP_TARGET.apex };
  }

  restartRep(): void {
    this.reset();
    this.toStart();
  }

  teardown(): void {
    this.g.hud.gradeAside = false;
    super.teardown();
  }

  frame(dt: number): void {
    const g = this.g;
    for (let i = 0; i < SERVE_KINDS.length; i++) if (g.keyPressed('Digit' + (i + 1))) this.selectCall(i);
    const teach = g.tutorial.serving;
    const toss = this.phase === 'toss' && !!this.spot;
    this.guide.update(
      {
        spot: (g.settings.runUpGuide || teach) && toss ? this.spot : null,
        from: teach && toss && g.tutorial.showPath() ? this.line.start : null,
        plant: teach && toss ? this.line.plant : null,
        feet: g.me.rpos,
        pulse: this.pulse,
        urge: false,
      },
      dt,
    );
  }

  step(dt: number): void {
    const g = this.g;
    this.t += dt;
    this.away.step();
    this.pulse = Math.max(0, this.pulse - dt * 2.5);
    switch (this.phase) {
      case 'ready':
        // a serve lesson's rep starts once the ball is in the server's hand and the coach is quiet
        if (!this.fed && g.tutorial.serving && this.canServe(g.me)) {
          this.fed = true;
          g.tutorial.noteFeed();
        }
        if (g.contact.serving === g.me) this.tossed();
        break;
      case 'toss': {
        // GO: when a full run-up under this toss would start
        if (this.goAt > 0 && g.simTime >= this.goAt) {
          this.goAt = -1;
          if (g.settings.runUpGuide || g.tutorial.serving) {
            g.hud.go();
            this.pulse = 1;
          }
        }
        // one toss (FIVB rule 12.4.2): a toss that comes down unhit is a fault
        if (g.ball.events.some((e) => e.kind === 'floor')) this.finish(0, 'TOSS NOT HIT · one toss only');
        break;
      }
      case 'flight':
        if (this.t > SERVE_DRILL.flightMax) this.finish(0, 'OUT');
        break;
      case 'result':
        // the ball is dead (the pass flies on, nobody plays it); a serve lesson's next toss also
        // waits until the coach's line about this serve has been read
        if (!g.tutorial.holdingResult() && this.t > SERVE_DRILL.result) {
          this.reset();
          this.toStart();
        }
        break;
    }
  }

  private tossed(): void {
    const g = this.g;
    this.toPhase('toss');
    this.spot = null;
    this.goAt = -1;
    if (this.kind === 'float') return;
    // where the feet should be at the hit, and when the run-up starts (as the Spike Drill shows for a set)
    const plan = planApproach(g.me, g.ball.ensurePrediction(g.env, g.simTime), g.simTime, 0, 0);
    if (!plan) return;
    this.spot = { x: plan.feet.x, z: plan.feet.z };
    this.goAt = plan.tStart;
    // the same run for a serve lesson: when it starts and plants, which way, and where it plants
    const l = this.line;
    const me = g.me;
    l.tGo = plan.tStart;
    l.tPlant = plan.tPress;
    l.hold = plan.hold;
    l.dirX = plan.dir.x;
    l.dirZ = plan.dir.z;
    l.yaw = plan.runYaw;
    l.spot.x = plan.feet.x;
    l.spot.z = plan.feet.z;
    l.start.x = me.pos.x;
    l.start.z = me.pos.z;
    const at = simulateApproach(me, g.simTime, plan.tStart, plan.tPress, plan.hold, plan.dir, plan.runYaw, plan.airYaw, plan.tPress);
    l.plant = { x: at.pos.x, z: at.pos.z };
  }

  onContact(ev: ContactEvent): void {
    const g = this.g;
    if (ev.athlete === g.me) {
      if (this.phase !== 'toss') return;
      // (a swing at a toss still going up is a Miss, and the lesson hears about it too)
      if (ev.grade) g.tutorial.noteContact(ev.grade, ev.note ?? '');
      if (ev.kind !== 'serve') return;
      this.kmh = ev.speed * 3.6;
      if (ev.footFault) {
        this.finish(0, 'FOOT FAULT');
        return;
      }
      g.ballLive = true;
      this.toPhase('flight');
      return;
    }
    // their first touch of the serve: the pass it forced, and the end of the rep (a whiffed pass
    // carries on to the floor: an ace)
    if (this.phase === 'flight' && ev.athlete.side === this.away.side && ev.grade !== 'Miss') {
      const p = ratePass(g, this.away.side);
      const r = rateServe(p.rating, p.over);
      this.finish(r.rating, r.label);
    }
  }

  onOutcome(o: Outcome): void {
    const g = this.g;
    if (this.phase === 'flight') {
      const lt = g.ball.lastTouch;
      if (lt?.kind !== 'serve') return;
      if (o.kind === 'in' && o.side === this.away.side) this.finish(4, 'ACE');
      else if (o.netTouch && (o.kind === 'under-net' || o.kind === 'in')) this.finish(0, 'IN THE NET');
      else this.finish(0, o.kind === 'in' || o.kind === 'under-net' ? 'SHORT' : 'OUT');
    }
  }

  private finish(rating: ServeRating, label: string): void {
    const g = this.g;
    if (this.phase === 'result') return;
    const fault = rating === 0;
    // the rep ends here: the ball is dead, nobody plays it on, and where the pass lands is not judged
    g.ballLive = false;
    if (this.phase === 'flight') g.judge.disarm();
    g.contact.serving = null;
    this.toPhase('result');
    this.reps++;
    this.score += rating;
    const k = this.sums[this.kind];
    k.n++;
    k.sum += rating;
    this.last = { rating, label, kmh: fault ? 0 : this.kmh };
    this.bumpStreak(!fault);
    g.hud.showBanner(`${label} · ${rating}`, rating >= 3 ? 'good' : rating === 0 ? 'bad' : 'neutral');
    if (rating >= 3) g.crowd(rating === 4 ? 0.8 : 0.4);
    this.updateScore();
    g.tutorial.noteRepEnd(!fault, fault ? label.split(' · ')[0] : '');
  }

  private toPhase(p: Phase): void {
    this.phase = p;
    this.t = 0;
  }
}
