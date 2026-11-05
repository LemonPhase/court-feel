import { yawFromDir } from '../../core/mathx';
import { solveApex } from '../../physics/solve';
import { HitterBrain } from '../../ai/hitter';
import type { Game } from '../game';
import { SetterBrain } from '../../ai/setter';
import { SCORING, type PositionId } from '../../config';
import { Athlete } from '../athlete';
import type { ContactEvent } from '../contact';
import type { Outcome } from '../judge';
import { attackHeight, laneFor, quickSetFor, quickSpot, SETTER_SPOT, SETTER_TARGET, setterTouchY } from '../plays';
import { kbd, Mode } from './mode';

type Phase = 'intro' | 'feed' | 'live' | 'result';

/** where the user starts blocking, by position (x along the net, home side) */
/**
 * Base block position: every rep starts at the net in front of their middle
 * (where their quick is hit, in front of their setter), reading the set from there.
 */
const BASE = { x: quickSpot(-SETTER_TARGET.x, -1).x, z: 0.5 };
/** the hitter each position is responsible for at the net (gets the extra sets) */
const MY_HITTER: Record<PositionId, 'OH' | 'MB' | 'OPP'> = { OH: 'OPP', OPP: 'OH', MB: 'MB', S: 'OH', L: 'MB' };

/**
 * Block drill: the opponent setter sets one of three hitters; read the set,
 * shuffle, and time the jump + hands. Stuffs, soft blocks and touches score.
 */
export class BlockDrill extends Mode {
  readonly id = 'block' as const;
  private setter!: Athlete;
  private coach!: Athlete;
  private hitters: { a: Athlete; brain: HitterBrain; pos: 'OH' | 'MB' | 'OPP' }[] = [];
  private target: Athlete | null = null;
  private phase: Phase = 'intro';
  private t = 0;
  private tossed = false;
  private block: ContactEvent | null = null;
  private attacked = false;

  setup(): void {
    const g = this.g;
    g.placeUser(BASE.x, BASE.z, 0);
    // opponent setter (far side, faces +x = their left)
    const sx = -SETTER_SPOT.x;
    const sz = -SETTER_SPOT.z;
    this.setter = new Athlete('S', -1);
    this.setter.place(sx, sz, -Math.PI / 2);
    g.addAthlete(this.setter, 21);
    this.spawned.push(this.setter);
    const sb = new SetterBrain(this.setter, { x: sx, z: sz }, -Math.PI / 2);
    sb.shouldPlay = () => this.g.ball.lastTouch?.kind === 'feed';
    sb.call = () => {
      const h = this.pickHitter();
      this.target = h.a;
      if (h.pos === 'MB') return quickSetFor(h.a, this.g.simTime, this.g.ball.pos, h.brain.releaseAt);
      const lane = laneFor(h.pos, -1);
      const y = attackHeight(h.a);
      return { target: { x: lane.x, y, z: lane.z }, apex: y + lane.apexAbove, hitter: h.a };
    };
    g.setBrain(this.setter, sb);
    // three hitters
    let seed = 22;
    for (const pos of ['OH', 'MB', 'OPP'] as const) {
      const a = new Athlete(pos, -1);
      const lane = laneFor(pos, -1);
      a.place(lane.sx, lane.sz, Math.PI);
      g.addAthlete(a, seed++);
      this.spawned.push(a);
      const brain = new HitterBrain(a, lane);
      brain.isMySet = () => this.target === a && this.g.ball.lastTouch?.kind === 'set';
      brain.blockers = () => [this.g.me];
      // their middle runs a quick on every ball (a decoy when the set goes wide)
      if (pos === 'MB') brain.passToSetter = (gm) => this.feedToSetter(gm);
      g.setBrain(a, brain);
      this.hitters.push({ a, brain, pos });
    }
    // coach on their back court
    this.coach = new Athlete('OPP', -1);
    this.coach.place(-3.4, -6.6, Math.PI);
    g.addAthlete(this.coach, 4, 'coach');
    this.spawned.push(this.coach);
    this.coach.airIntent = 'neutral';
    g.hud.setTitle('Block Drill');
    this.beginRep();
    this.refreshScore();
    g.hud.message(
      this.position === 'MB'
        ? 'Their middle hits quicks: if they jump with the setter, jump with them · otherwise read the set'
        : 'Read the set · shuffle A/D · hold RMB for hands · Space to jump',
      3.6,
    );
    this.toPhase('intro');
  }

  private pickHitter() {
    // 45%: the hitter your position would block in a match, otherwise any of the three
    const mine = this.hitters.find((h) => h.pos === MY_HITTER[this.position]) ?? this.hitters[0];
    if (this.g.rng.next() < 0.45) return mine;
    return this.hitters[Math.floor(this.g.rng.next() * this.hitters.length)];
  }

  hint(): string {
    const me = this.g.me;
    if (me.state === 'air') return `hold ${kbd('RMB')} hands over the net`;
    return `${kbd('A')}${kbd('D')} shuffle · ${kbd('RMB')} hands up · ${kbd('Space')} block jump (vs the quick: go up with their middle) · ${kbd('V')} camera · ${this.resetHint('reset')}`;
  }

  refreshScore(): void {
    this.showScore();
  }

  restartRep(): void {
    if (this.phase !== 'result') this.skipRep();
    this.nextRep();
  }

  step(dt: number): void {
    const g = this.g;
    this.t += dt;
    this.coach.cmd.faceYaw = yawFromDir(-SETTER_TARGET.x - this.coach.pos.x, -SETTER_TARGET.z - this.coach.pos.z);
    switch (this.phase) {
      case 'intro':
        if (this.t > 1.2) this.toPhase('feed');
        break;
      case 'feed':
        if (g.userReturning) {
          this.t = 0;
          break;
        }
        if (!this.tossed && this.t > 0.3) {
          this.coach.startAction('toss', g.simTime);
          this.tossed = true;
        }
        if (this.tossed && this.t > 0.57) {
          this.coach.endAction();
          const from = { x: this.coach.pos.x + 0.1, y: 1.35, z: this.coach.pos.z + 0.3 };
          const v = { x: 0, y: 0, z: 0 };
          solveApex(from, { x: -SETTER_TARGET.x, y: 2.1, z: -SETTER_TARGET.z }, SETTER_TARGET.height + 0.4, { x: 0, y: 0, z: 0 }, v);
          g.ball.launch(from, v, { x: 3, y: 0, z: 0 }, 0, g.simTime);
          g.ball.lastTouch = { athlete: this.coach, kind: 'feed', t: g.simTime, side: -1 };
          this.block = null;
          this.attacked = false;
          this.toPhase('live');
        }
        break;
      case 'live':
        if (g.ball.state.rest || this.t > 8) this.finish(null);
        break;
      case 'result':
        if (this.t > 2.0) this.nextRep();
        break;
    }
  }

  private feedToSetter(g: Game): { t: number; x: number } | null {
    const lt = g.ball.lastTouch;
    if (!g.ball.active || lt?.kind !== 'feed' || lt.side !== -1) return null;
    const pred = g.ball.ensurePrediction(g.env, g.simTime);
    const t = pred.descendThrough(setterTouchY(this.setter), g.simTime);
    if (t < 0) return null;
    const p = { x: 0, y: 0, z: 0 };
    pred.posAt(t, p);
    return { t, x: p.x };
  }

  onContact(ev: ContactEvent): void {
    if (ev.kind === 'spike' || ev.kind === 'tip') this.attacked = true;
    if (ev.athlete === this.g.me && ev.kind === 'block') this.block = ev;
  }

  onOutcome(o: Outcome): void {
    if (this.phase !== 'live' || !this.attacked) return;
    this.finish(o);
  }

  private finish(o: Outcome | null): void {
    const g = this.g;
    this.toPhase('result');
    this.reps++;
    const b = this.block;
    let pts = 0;
    let label: string;
    let good = false;
    const lastByMe = g.ball.lastTouch?.athlete === g.me;
    const S = SCORING.block;
    if (b && o && o.kind === 'in' && o.side === -1) {
      pts = b.grade === 'Perfect' ? S.stuff : S.point;
      label = b.grade === 'Perfect' ? 'STUFF BLOCK!' : 'BLOCK POINT';
      good = true;
      g.crowd(b.grade === 'Perfect' ? 1.2 : 0.8);
    } else if (b && (!o || o.kind === 'in')) {
      pts = S.soft;
      label = 'SOFT BLOCK · TOUCH';
      good = true;
      g.crowd(0.3);
    } else if (b && lastByMe) {
      pts = S.tooled;
      label = 'TOOLED';
    } else if (!b && o && o.kind !== 'in') {
      pts = S.hitterError;
      label = 'HITTER ERROR';
    } else if (!b && o && o.kind === 'in' && o.side === 1) {
      label = 'KILLED';
    } else {
      label = 'NO TOUCH';
    }
    this.score += pts;
    this.bumpStreak(good);
    this.logRep(pts, label, b?.grade ?? null);
    g.hud.showBanner(pts > 0 ? `${label}  +${pts}` : label, good ? 'good' : 'bad');
    this.refreshScore();
  }

  private nextRep(): void {
    if (!this.beginRep()) return;
    const g = this.g;
    g.judge.disarm();
    g.ball.hide();
    this.refreshScore();
    for (const h of this.hitters) {
      h.brain.reset();
      const lane = laneFor(h.pos, -1);
      h.a.place(lane.sx, lane.sz, Math.PI);
    }
    this.setter.place(-SETTER_SPOT.x, -SETTER_SPOT.z, -Math.PI / 2);
    this.target = null;
    const me = g.me;
    // always back to the same base spot so every read starts from the same place
    if (Math.hypot(me.pos.x - BASE.x, me.pos.z - BASE.z) > 0.15 || me.state !== 'ground') g.returnUser(BASE.x, BASE.z, 0);
    this.toPhase('feed');
  }

  private toPhase(p: Phase): void {
    this.phase = p;
    this.t = 0;
    if (p === 'feed') this.tossed = false;
  }
}
