import { COURT, SERVE, SERVE_DRILL, SERVE_KINDS, type ServeKind } from '../../config';
import { planApproach } from '../../ai/approach';
import { SLOT_ROLE, SLOTS, TeamAI } from '../../ai/team';
import { ApproachGuide } from '../../fx/approachGuide';
import { Athlete } from '../athlete';
import { aimPitchFor, type ContactEvent } from '../contact';
import type { Outcome } from '../judge';
import { BACKUP_TARGET } from '../plays';
import { kbd, Mode } from './mode';
import { ratePass } from './receiveDrill';

/**
 * - `ready`: behind the end line with the ball, nothing tossed yet
 * - `toss`: the toss is up
 * - `flight`: the serve is on its way and nobody has played it
 * - `play`: they passed it; what the pass was worth is not settled yet (a shank may still drop)
 * - `result`: the serve is rated
 */
type Phase = 'ready' | 'toss' | 'flight' | 'play' | 'result';

/**
 * How a serve is rated, the way coaches chart serves: by the pass it forces (0-4). Their pass is
 * rated 0-3 as in the Serve Receive drill (`ratePass`), and the serve scores the other end of it.
 */
export type ServeRating = 0 | 1 | 2 | 3 | 4;

/** the serve's rating for a pass rated `pass` (0-3), `over` the net, or played a second time (`second`) */
export function rateServe(pass: number, over: boolean, second: boolean): { rating: ServeRating; label: string } {
  if (over) return { rating: 3, label: 'OVERPASS' };
  if (pass >= 3) return { rating: 1, label: 'PASSED TO TARGET' };
  if (pass === 2) return { rating: 2, label: 'PASSED OFF THE NET' };
  if (pass === 1 || second) return { rating: 3, label: 'OUT OF SYSTEM' };
  return { rating: 4, label: 'ACE · SHANKED' };
}

/**
 * Serve drill: the player serves at a team in serve receive, with the serve they picked (keys
 * 1-3: standing float, jump float, jump serve). Every serve is rated by the pass it forces.
 */
export class ServeDrill extends Mode {
  readonly id = 'serve' as const;
  away!: TeamAI;
  private phase: Phase = 'ready';
  private t = 0;
  private kindIdx = 0;
  /** the pass they made of this serve, until it is settled */
  private pass: { rating: number; over: boolean } | null = null;
  private last: { rating: ServeRating; label: string; kmh: number } | null = null;
  /** ratings so far, by serve */
  private sums: Record<ServeKind, { n: number; sum: number }> = {
    float: { n: 0, sum: 0 },
    jumpFloat: { n: 0, sum: 0 },
    jump: { n: 0, sum: 0 },
  };
  private kmh = 0;
  private guide!: ApproachGuide;
  /** where the feet should be when a jump float or a jump serve is hit, once its toss is up */
  private spot: { x: number; z: number } | null = null;
  private goAt = -1;
  private pulse = 0;
  /** when, in the result phase, the receiving team's play on the pass was over (s) */
  private doneAt = 0;

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
    for (const slot of SLOTS) {
      const a = new Athlete(SLOT_ROLE[slot], -1);
      g.addAthlete(a, seed++);
      this.spawned.push(a);
      this.away.add(slot, a, false);
    }
    this.guide = new ApproachGuide();
    this.add(this.guide.group);
    g.serveKind = this.kind;
    g.placeUser(this.start.x, this.start.z, 0);
    if (!g.settings.firstPerson) g.rig.pitch = aimPitchFor(SERVE_DRILL.lookDepth, false);
    this.reset();
    g.hud.setTitle('Serve Drill');
    this.updateScore();
    // (on touch the key names become the buttons': "toss: Q" reads "toss: TOSS")
    g.hud.message('Pick your serve: 1 2 3 · toss: Q · serve at the seams', 3.5);
  }

  /** pick the serve for the next toss (0-based: standing float, jump float, jump serve) */
  selectCall(i: number): void {
    if (i < 0 || i >= SERVE_KINDS.length || i === this.kindIdx) return;
    this.kindIdx = i;
    const g = this.g;
    g.serveKind = this.kind;
    g.hud.message(`Serve ${i + 1}: ${SERVE[this.kind].name}`, 1.6);
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
    this.pass = null;
    this.spot = null;
    this.goAt = -1;
    this.toPhase('ready');
  }

  private updateScore(): void {
    const k = this.sums[this.kind];
    const avg = k.n ? ` · avg ${(k.sum / k.n).toFixed(2)} of 4` : '';
    const last = this.last ? ` · last ${this.last.rating}${this.last.kmh ? ` (${this.last.kmh.toFixed(0)} km/h)` : ''}` : '';
    this.g.hud.setScore(`Serve ${this.kindIdx + 1}: ${SERVE[this.kind].name}${avg} · rep ${this.reps}${last}`);
  }

  hint(): string {
    const pick = `${kbd('1')}${kbd('2')}${kbd('3')} serve`;
    // a hard topspin serve aimed short is in the net: it is aimed at the back of their court
    const deep = this.kind === 'jump' ? ' · aim deep' : '';
    if (this.phase === 'ready') {
      if (this.g.userReturning) return `Back behind the end line · ${pick}`;
      return this.kind === 'float'
        ? `${kbd('Q')} toss · hold ${kbd('LMB')}, release as the ball comes down · aim with the mouse · ${pick}`
        : `${kbd('Q')} toss · ${kbd('Shift')}+${kbd('W')} run in under it · ${kbd('Space')} jump · hold/release ${kbd('LMB')}${deep} · ${pick}`;
    }
    if (this.phase === 'toss')
      return this.kind === 'float'
        ? `Hold ${kbd('LMB')}, release as the ball comes down`
        : `${kbd('Shift')}+${kbd('W')} run in · ${kbd('Space')} jump behind the line · hold/release ${kbd('LMB')}${deep}`;
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
    return a === this.g.me && this.phase === 'ready' && !this.g.userReturning;
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

  frame(dt: number): void {
    const g = this.g;
    for (let i = 0; i < SERVE_KINDS.length; i++) if (g.input.consumePress('Digit' + (i + 1))) this.selectCall(i);
    this.guide.update(
      {
        spot: g.settings.landingMarker && this.phase === 'toss' ? this.spot : null,
        from: null,
        plant: null,
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
        if (g.contact.serving === g.me) this.tossed();
        break;
      case 'toss': {
        // GO: when a full run-up under this toss would start
        if (this.goAt > 0 && g.simTime >= this.goAt) {
          this.goAt = -1;
          if (g.settings.landingMarker) {
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
      case 'play':
        // the pass is settled by their second touch, or by the floor (onOutcome)
        if (this.away.touches >= 2) this.settle(true);
        else if (this.t > SERVE_DRILL.playMax) this.settle(false);
        break;
      case 'result': {
        // they play the pass out: what your serve let them run is the other half of its rating.
        // Once their third ball is on its way over (or it has taken too long) the rep is done
        const lt = g.ball.lastTouch;
        const over = lt?.side === this.away.side && (this.away.touches >= 3 || g.ball.pos.z > 0);
        if (g.ballLive && (over || g.ball.state.rest || this.t > SERVE_DRILL.playOn)) {
          g.ballLive = false;
          this.doneAt = this.t;
        }
        if (!g.ballLive && this.t > Math.max(SERVE_DRILL.result, this.doneAt + SERVE_DRILL.after)) {
          this.reset();
          this.toStart();
        }
        break;
      }
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
  }

  onContact(ev: ContactEvent): void {
    const g = this.g;
    if (ev.athlete === g.me) {
      if (this.phase !== 'toss' || ev.kind !== 'serve') return;
      this.kmh = ev.speed * 3.6;
      if (ev.footFault) {
        this.finish(0, 'FOOT FAULT');
        return;
      }
      g.ballLive = true;
      this.toPhase('flight');
      return;
    }
    // their first touch of the serve: the pass it forced
    if (this.phase === 'flight' && ev.athlete.side === this.away.side && ev.grade !== 'Miss') {
      const r = ratePass(g, this.away.side);
      this.pass = { rating: r.rating, over: r.over };
      // a pass the setter can play, or one going straight back over, is settled now; a shank is an ace unless somebody saves it
      if (r.over || r.rating >= 1) this.settle(false);
      else this.toPhase('play');
    }
  }

  onOutcome(o: Outcome): void {
    const g = this.g;
    if (this.phase === 'result' && g.ballLive) {
      // their play on the pass has ended (a kill into the empty court, a ball they dropped)
      g.ballLive = false;
      this.doneAt = this.t;
    } else if (this.phase === 'flight') {
      const lt = g.ball.lastTouch;
      if (lt?.kind !== 'serve') return;
      if (o.kind === 'in' && o.side === this.away.side) this.finish(4, 'ACE');
      else if (o.netTouch && (o.kind === 'under-net' || o.kind === 'in')) this.finish(0, 'IN THE NET');
      else this.finish(0, o.kind === 'in' || o.kind === 'under-net' ? 'SHORT' : 'OUT');
    } else if (this.phase === 'play') this.settle(false);
  }

  /** their pass is settled: `second`, somebody got a second touch on it */
  private settle(second: boolean): void {
    const p = this.pass;
    if (!p) return;
    const r = rateServe(p.rating, p.over, second);
    this.finish(r.rating, r.label);
  }

  private finish(rating: ServeRating, label: string): void {
    const g = this.g;
    if (this.phase === 'result') return;
    const fault = rating === 0;
    // a serve that is a fault is dead: nobody plays it
    if (fault || rating === 4) g.ballLive = false;
    g.contact.serving = null;
    this.doneAt = 0;
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
  }

  private toPhase(p: Phase): void {
    this.phase = p;
    this.t = 0;
  }
}
