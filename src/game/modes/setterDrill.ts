import { AI, CONTACT, TIMING } from '../../config';
import { yawFromDir } from '../../core/mathx';
import { solveApex } from '../../physics/solve';
import { HitterBrain } from '../../ai/hitter';
import { SLOT_ROLE, TeamAI, type Slot } from '../../ai/team';
import { Athlete } from '../athlete';
import {
  applyCalls,
  askFast,
  CALL_COLOR,
  callLane,
  callOptions,
  callSheet,
  callSpot,
  canAskFast,
  dumpOption,
  holdForHigh,
  passToUser,
  startCallRuns,
  stripKeys,
  syncRuns,
  type CallHitters,
} from '../callRuns';
import type { ContactEvent, SetOption } from '../contact';
import { outcomeLabel, type Outcome } from '../judge';
import { SETTER_SPOT, SETTER_TARGET } from '../plays';
import { DEFAULT_PICK, SETTER_KEYS, SetterCalls, type SetPick, type SetterKey } from '../setterCalls';
import { kbd } from '../../core/kbd';
import type { RingMark } from './markers';
import { Mode } from './mode';
import type { AiHost } from '../brains';

type Phase = 'intro' | 'feed' | 'live' | 'result';

/**
 * Setter drill: passes come in from the back court. Pick a hitter with 1-4 (outside, middle,
 * opposite, pipe; no key: the outside); press the picked one again for their next set, or call
 * a whole combination on the play wheel (C). Get to the spot, press RMB as the ball reaches your
 * hands, hold while the bar fills and release in the green: your touch sets how big the green
 * is. Your hitters run their calls (the fast ones before you touch it) and finish against their
 * six: three blockers and three diggers. Off a green set your hitter finds the open spot; off a
 * bad one they roll it or swing into the defence. Off a pass far off the net everything goes up
 * high, unless you ask a hitter for their fast set in time. G puts you in the front row: the
 * opposite then hits the D from the back row, and 5 is your dump.
 */
export class SetterDrill extends Mode {
  readonly id = 'setter' as const;
  private passer!: Athlete;
  private hitters: CallHitters<HitterBrain> = new Map();
  /**
   * Their six, as in the Mini Rally: a front row that blocks (the middle reads your set and
   * closes on the pin blocker; off your green set it goes with a hitter you did not set) and a
   * back row that digs what your hitter puts in play.
   */
  private defence!: TeamAI;
  private phase: Phase = 'intro';
  private t = 0;
  private set: ContactEvent | null = null;
  /** your set this rep was a lift (held too long) */
  private lifted = false;
  private setFor: Athlete | null = null;
  private attacked = false;
  private markers = new Map<SetterKey, RingMark>();
  /** where your dump lands, on their floor (front row only) */
  private dumpMarker!: RingMark;
  private tossed = false;
  /** your picks and calls (keys 1-4) */
  readonly calls = new SetterCalls();
  /** this rep's pass is too far off the net for the fast calls: everything goes up high */
  private outOfSystem = false;
  /** how long this rep's result stays up (TIMING.setterDrill: shorter after a ball nobody played) */
  private resultFor = 0;

  setup(): void {
    const g = this.g;
    g.placeUser(SETTER_SPOT.x, SETTER_SPOT.z + 0.3, Math.PI / 2);
    g.rig.pitch = 0.25;
    let seed = 41;
    for (const k of SETTER_KEYS) {
      const lane = callLane(this.calls, k, false);
      // the pipe is hit by a back-row outside
      const a = new Athlete(k === 'PIPE' ? 'OH' : k, 1);
      a.place(lane.sx, lane.sz, 0);
      g.addAthlete(a, seed++);
      this.spawned.push(a);
      const brain = new HitterBrain(a, lane);
      brain.isMySet = () => this.setFor === a && this.g.ball.lastTouch?.kind === 'set';
      brain.blockers = () => this.defence.frontRow();
      brain.defenders = () => [...this.defence.players.values()];
      brain.skill = 0.82;
      g.setBrain(a, brain);
      // a hitter whose call is a quick goes on the pass, timed to your touch
      this.hitters.set(k, { a, brain, read: (gm) => this.passToMe(gm, k) });
      this.markers.set(k, g.markers.ring(CALL_COLOR[k], 1.0));
    }
    // a passer in the back court feeding the setter target
    this.passer = new Athlete('L', 1);
    this.passer.place(-1.0, 6.8, 0);
    g.addAthlete(this.passer, 6, 'coach');
    this.spawned.push(this.passer);
    this.passer.airIntent = 'neutral';
    this.defence = new TeamAI(-1, g);
    // between points they stand in base defence
    this.defence.serving = true;
    let dseed = 47;
    for (const slot of ['OH1', 'MB', 'OPP', 'S', 'L', 'OH2'] as Slot[]) {
      const d = new Athlete(SLOT_ROLE[slot], -1);
      g.addAthlete(d, dseed++);
      this.spawned.push(d);
      this.defence.add(slot, d, false);
    }
    this.defence.place('defense');
    this.dumpMarker = g.markers.ring(CALL_COLOR.DUMP, 0.9);
    this.dumpMarker.visible = false;
    // off a bad pass a hitter can still be asked for their fast set, if they hear it in time
    this.calls.canAsk = (k) => canAskFast(g, g.me, this.calls, k);
    this.calls.onAsk = (k) => askFast(g, g.me, this.hitters, this.calls, k);
    this.calls.canHold = (k) => holdForHigh(this.hitters, k);
    g.hud.setTitle('Setter Drill');
    this.updateScore();
    g.hud.message('RMB as the ball reaches your hands, release in the green · 1-4 pick a hitter', 3.2);
    this.toPhase('intro');
  }

  /**
   * While the pass is coming: when the ball leaves your hands (the catch plus the load) and
   * where. None off a bad pass (no quick), unless you asked `k` for it.
   */
  private passToMe(g: AiHost, k: SetterKey): { t: number; x: number } | null {
    const lt = g.ball.lastTouch;
    if (!g.ball.active || lt?.athlete !== this.passer || lt.kind !== 'pass') return null;
    if (this.outOfSystem && !this.calls.asksFast(k)) return null;
    return passToUser(g, this.g.me);
  }

  setOptions(a: Athlete): SetOption[] {
    const oos = this.outOfSystem || Math.hypot(a.pos.x - SETTER_SPOT.x, a.pos.z - SETTER_SPOT.z) > AI.outOfSystem;
    const opts = callOptions(this.g, this.hitters, this.calls, oos);
    const dump = dumpOption(this.calls, a, this.g.env.netTop);
    if (dump) opts.push(dump);
    return opts;
  }

  setterPicks(): readonly SetPick[] {
    return stripKeys(this.calls);
  }

  /** until the pass you can call a play (from the moment the last rep ended): the wheel opens on your calls */
  playCalls(): SetterCalls | null {
    return this.calls.locked ? null : this.calls;
  }

  /** the pass is in the air until your set: the ball is yours to set */
  userSetsNext(): boolean {
    return this.phase === 'live' && this.g.ball.lastTouch?.athlete === this.passer;
  }

  setPick(a: Athlete): SetPick | null {
    return a === this.g.me ? this.calls.pick : null;
  }

  /** what can't be set this ball: the middle off a bad pass once it is too late to ask, the dump from too far off the net */
  private off(): SetPick[] {
    const off: SetPick[] = [];
    if (this.phase !== 'live') return off;
    const c = this.calls;
    if (this.outOfSystem && !c.asksFast('MB') && !canAskFast(this.g, this.g.me, c, 'MB')) off.push('MB');
    if (c.frontRow && !dumpOption(c, this.g.me, this.g.env.netTop)) off.push('DUMP');
    return off;
  }

  /** where your set goes: your pick, else the outside (the outside too when the pick is off) */
  private setTo(): SetPick {
    const k = this.calls.target();
    if (k === 'MB' && this.outOfSystem && !this.calls.asksFast('MB')) return DEFAULT_PICK;
    return this.off().includes(k) ? DEFAULT_PICK : k;
  }

  hint(): string {
    const dump = this.calls.frontRow ? ` · ${kbd('5')} dump` : '';
    // the pass is in the air: only what your hands do now
    if (this.phase === 'live' && !this.set) {
      const again = this.outOfSystem ? 'again: their fast set' : 'again: high';
      // the jump set: your body goes up by itself (Settings: Auto jump set), or it is yours
      const jump = this.g.settings.autoJumpSet ? '' : ` · ${kbd('Space')} jump set`;
      return `${kbd('WASD')} to the spot · ${kbd('RMB')} as it reaches your hands, release in the green${jump} · ${kbd('1')}-${kbd('4')} who · ${again}${dump}`;
    }
    return `${kbd('1')}-${kbd('4')} pick a hitter · again: their next set · ${kbd('C')} plays · ${kbd('G')} ${this.calls.frontRow ? 'back' : 'front'} row${dump}`;
  }

  private updateScore(): void {
    this.g.hud.setScore(`${this.score} pts · rep ${this.reps}`);
  }

  restartRep(): void {
    this.nextRep();
  }

  frame(dt: number): void {
    // the floor rings (Settings: Hitter spots on the floor): each hitter's spot for their call; the one your set goes to lit
    const g = this.g;
    const lit = this.setTo();
    for (const [k, m] of this.markers) {
      m.visible = g.settings.hitterSpots;
      const spot = callSpot(this.calls, k, this.outOfSystem);
      m.place(spot.x, spot.z + 0.15);
      m.fade(k === lit ? 0.95 : 0.25, dt);
    }
    // the dump's spot on their floor
    const D = CONTACT.dump;
    const spot = this.calls.dumpDeep ? D.deep : D.short;
    this.dumpMarker.visible = this.calls.frontRow;
    this.dumpMarker.place(spot.x, spot.z);
    this.dumpMarker.fade(lit === 'DUMP' ? 0.95 : 0.25, dt);
    g.hud.setCallSheet(callSheet(this.calls, stripKeys(this.calls), lit, this.off()));
  }

  /** G: you are front row (the opposite hits the D from the back row, and you may dump) or back row */
  private toggleRow(): void {
    const c = this.calls;
    c.frontRow = !c.frontRow;
    if (!c.frontRow && c.pick === 'DUMP') c.pick = null;
    this.g.hud.setTitle(c.frontRow ? 'Setter Drill · front row' : 'Setter Drill');
    this.g.hud.message(
      c.frontRow ? 'Front row · the opposite hits the D · 5 is your dump' : 'Back row · three hitters at the net · no dump',
      2.2,
      false,
    );
  }

  step(dt: number): void {
    const g = this.g;
    this.t += dt;
    this.calls.readKeys(this.keys);
    if (this.calls.takeLate()) g.hud.message('Too late to change it · they are committed', 1.2, false);
    if (g.keyPressed('KeyG') && !this.calls.locked) this.toggleRow();
    // before the pass the hitters walk to the start of their call's run
    if (!this.calls.locked) applyCalls(this.hitters, this.calls, false);
    syncRuns(this.hitters, this.calls);
    const D = TIMING.setterDrill;
    switch (this.phase) {
      case 'intro':
        if (this.t > D.intro) this.toPhase('feed');
        break;
      case 'feed':
        // the ball waits while you jog back, and while you call a play: then it comes after a moment to settle
        if (g.userReturning || g.wheelOpen) {
          this.t = Math.min(this.t, D.feed - D.settle);
          break;
        }
        if (!this.tossed && this.t > D.feed - D.wind) {
          this.tossed = true;
          this.passer.startAction('pass', g.simTime);
        }
        if (this.tossed && this.t > D.feed) {
          this.passer.endAction();
          // passes vary: sometimes tight, sometimes off the net
          const off = this.reps % 4 === 3 ? 1.6 : 0.6;
          const tgt = { x: SETTER_TARGET.x + g.rng.gauss() * off * 0.6, y: 2.35, z: SETTER_TARGET.z + Math.abs(g.rng.gauss()) * off };
          const from = { x: this.passer.pos.x, y: 0.85, z: this.passer.pos.z - 0.4 };
          const v = { x: 0, y: 0, z: 0 };
          solveApex(from, tgt, 4.2 + g.rng.next() * 0.6, { x: 0, y: 0, z: 0 }, v);
          g.ball.launch(from, v, { x: 2, y: 0, z: 0 }, 0, g.simTime);
          g.ball.lastTouch = { athlete: this.passer, kind: 'pass', t: g.simTime, side: 1 };
          g.ballLive = true;
          // a pass you never touch is over when it lands, not when it stops rolling
          g.judge.arm(g.ball);
          this.set = null;
          this.lifted = false;
          this.setFor = null;
          this.attacked = false;
          // the pass is played: the tempos lock and the fast calls start running
          this.outOfSystem = startCallRuns(g, g.me, this.hitters, this.calls);
          if (this.outOfSystem) g.hud.message('Off the net · HIGH · a hitter’s key again asks for their fast set', 2);
          this.toPhase('live');
        }
        break;
      case 'live':
        this.defence.step();
        if (g.ball.state.rest || this.t > D.live) this.finish(null);
        break;
      case 'result':
        if (this.t > this.resultFor) this.nextRep();
        break;
    }
    this.passer.cmd.faceYaw = yawFromDir(SETTER_TARGET.x - this.passer.pos.x, SETTER_TARGET.z - this.passer.pos.z);
  }

  onContact(ev: ContactEvent): void {
    const g = this.g;
    // held too long: a lift, the rep is over
    if (ev.athlete === g.me && ev.fault === 'lift') {
      this.lifted = true;
      if (this.phase === 'live') this.finish(null);
      return;
    }
    // your set, or your dump (a tip over the net on the second ball)
    if (ev.athlete === g.me && (ev.kind === 'set' || ev.kind === 'tip')) {
      this.set = ev;
      this.setFor = g.contact.lastSet?.hitter ?? null;
    }
    // (our attack: their spike off a ball you overset is not)
    if ((ev.kind === 'spike' || ev.kind === 'tip') && ev.athlete.side === g.me.side) this.attacked = true;
    // their back row got a platform under your attack: no kill (unless it went round the antenna:
    // it was out already, and the judge calls it OUT (ANTENNA) in this same step)
    if (
      this.phase === 'live' &&
      this.attacked &&
      ev.athlete.side === -1 &&
      (ev.kind === 'pass' || ev.kind === 'dig') &&
      g.judge.outWide !== g.me.side
    )
      this.finish(null, true);
  }

  onOutcome(o: Outcome): void {
    // the ball is down: the rep is over, whoever did or did not play it
    if (this.phase === 'live') this.finish(o);
  }

  private finish(o: Outcome | null, dug = false): void {
    const g = this.g;
    if (this.phase === 'result') return;
    this.toPhase('result');
    g.ballLive = false;
    this.reps++;
    // a ball nobody played leaves nothing to watch: the next one comes sooner
    this.resultFor = this.attacked ? TIMING.setterDrill.result : TIMING.setterDrill.resultMiss;
    // the next ball is yours to call from now: the keys and the wheel open while the result is up
    this.calls.nextBall(g.settings.keepSetPick);
    let pts = 0;
    let label = this.lifted ? 'LIFT' : 'NO SET';
    let good = false;
    if (this.set) {
      pts += this.set.grade === 'Perfect' ? 100 : this.set.grade === 'Good' ? 60 : 25;
      if (o && this.attacked) {
        const r = outcomeLabel(o, 1);
        if (o.kind === 'in' && o.side === -1) {
          pts += 50;
          // off your green set your hitter bounced it: say so
          const shot = [...this.hitters.values()].find((h) => h.a === this.setFor)?.brain.lastShot;
          label = shot === 'bounce' ? 'BOUNCE' : 'KILL';
          good = this.set.grade === 'Perfect' || this.set.grade === 'Good';
          g.crowd(0.7);
        } else label = r === 'DOWN' ? 'BLOCKED' : r;
      } else label = dug ? 'DUG' : 'SET';
    }
    this.score += pts;
    this.bumpStreak(good);
    g.hud.showBanner(pts ? `${label}  +${pts}` : label, good ? 'good' : 'neutral');
    this.updateScore();
  }

  private nextRep(): void {
    const g = this.g;
    g.judge.disarm();
    g.ball.hide();
    this.tossed = false;
    this.outOfSystem = false;
    for (const [k, h] of this.hitters) {
      h.brain.reset();
      const lane = callLane(this.calls, k, false);
      h.brain.lane = lane;
      h.a.place(lane.sx, lane.sz, 0);
    }
    this.defence.place('defense');
    const me = g.me;
    if (Math.hypot(me.pos.x - SETTER_SPOT.x, me.pos.z - SETTER_SPOT.z - 0.3) > 1.0 || me.state !== 'ground')
      g.returnUser(SETTER_SPOT.x, SETTER_SPOT.z + 0.3, Math.PI / 2);
    this.toPhase('feed');
  }

  private toPhase(p: Phase): void {
    this.phase = p;
    this.t = 0;
  }
}
