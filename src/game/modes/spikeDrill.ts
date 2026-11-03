import * as THREE from 'three';
import { COURT, type PositionId } from '../../config';
import { R } from '../../physics/ball';
import { solveApex } from '../../physics/solve';
import { SetterBrain } from '../../ai/setter';
import { Athlete } from '../athlete';
import type { ContactEvent } from '../contact';
import { outcomeLabel, type Outcome } from '../judge';
import { attackHeight, laneFor, quickSetFor, quickSpot, SET_PLAYS, SETTER_SPOT, SETTER_TARGET, setterTouchY, type AttackLane, type SetPlay } from '../plays';
import { kbd, makeFloorRing, Mode, ZoneMarker } from './mode';
import { planApproach, planQuick, planToPoint, type ApproachPlan } from '../../ai/approach';

interface Zone {
  name: string;
  x0: number;
  x1: number;
  z0: number;
  z1: number;
}

/** opponent-court target zones (far side, z < 0) for a left-side attacker */
const ZONES: Zone[] = [
  { name: 'Deep line', x0: -4.5, x1: -1.8, z0: -9, z1: -6 },
  { name: 'Deep cross', x0: 1.8, x1: 4.5, z0: -9, z1: -6 },
  { name: 'Seam', x0: -1.5, x1: 1.5, z0: -7.5, z1: -4.5 },
  { name: 'Sharp cut', x0: 1.5, x1: 4.5, z0: -4.2, z1: -1.5 },
  { name: 'Line short', x0: -4.5, x1: -2, z0: -4.5, z1: -2 },
];

/** target zones for this position: mirrored for right-side attackers; a middle hits zone 1 or 5 */
function zonesFor(pos: PositionId): Zone[] {
  if (pos === 'MB') {
    return [
      { name: 'Zone 1 (deep left)', x0: -4.5, x1: -1.5, z0: -9, z1: -5.6 },
      { name: 'Zone 5 (deep right)', x0: 1.5, x1: 4.5, z0: -9, z1: -5.6 },
    ];
  }
  if (pos === 'OPP' || pos === 'S') return ZONES.map((z) => ({ ...z, x0: -z.x1, x1: -z.x0 }));
  return ZONES;
}

type Phase = 'intro' | 'feed' | 'live' | 'result';

/**
 * Spike drill: a coach tosses to the setter, the setter sets the user's lane,
 * the user approaches and attacks. Timing, power and placement are scored.
 */
export class SpikeDrill extends Mode {
  readonly id = 'spike' as const;
  private setter: Athlete | null = null;
  private coach!: Athlete;
  private phase: Phase = 'intro';
  private t = 0;
  private zone!: Zone;
  private zoneMarker = new ZoneMarker();
  private approachRing!: THREE.Mesh;
  private lastGrade: ContactEvent | null = null;
  private userTouched = false;
  private tossed = false;
  /** when a perfect approach would start for the current set (the GO cue) */
  private goAt = -1;
  private plannedFor: unknown = null;
  private ringPulse = 0;
  private tmp = { x: 0, y: 0, z: 0 };
  /** set calls for this position (keys 1-3), if it has any */
  private plays: SetPlay[] | null = null;
  private callIdx = 0;
  /** an approach planned before the set (quick / tempo balls) for the autopilot */
  earlyPlan: ApproachPlan | null = null;
  earlyFor: unknown = null;

  private get play(): SetPlay | null {
    return this.plays ? this.plays[this.callIdx] : null;
  }

  /** the lane of the current set call */
  private get lane(): AttackLane {
    return this.play?.lane ?? laneFor(this.position, 1);
  }

  /** choose the set call for the next ball (0-based) */
  selectCall(i: number): void {
    if (!this.plays || i < 0 || i >= this.plays.length) return;
    this.callIdx = i;
    const g = this.g;
    g.hud.setTitle('Spike Drill · ' + this.lane.label);
    g.hud.message(`Next set: ${i + 1} · ${this.plays[i].name}`, 1.6);
    this.updateScore();
    // not tossed yet: head to the new approach start
    if ((this.phase === 'intro' || this.phase === 'feed') && !this.tossed) {
      const l = this.lane;
      if (Math.hypot(g.me.pos.x - l.sx, g.me.pos.z - l.sz) > 0.6) g.returnUser(l.sx, l.sz, 0);
    }
  }

  setup(): void {
    const g = this.g;
    const me = g.me;
    this.plays = SET_PLAYS[this.position] ?? null;
    this.callIdx = 0;
    const lane = this.lane;
    g.placeUser(lane.sx, lane.sz, 0);
    // setter (unless the user is the setter: then the coach passes straight to you)
    if (this.position !== 'S') {
      const s = new Athlete('S', 1);
      s.place(SETTER_SPOT.x, SETTER_SPOT.z, Math.PI / 2);
      g.addAthlete(s, 11);
      this.spawned.push(s);
      this.setter = s;
      const b = new SetterBrain(s, SETTER_SPOT, Math.PI / 2);
      b.shouldPlay = () => !this.userTouched && this.g.ball.lastTouch?.kind === 'feed';
      b.call = () => {
        // a quick meets you at the top of your jump if you went with the setter's touch
        const play = this.play;
        if (play?.inFront !== undefined) return quickSetFor(me, this.g.simTime, this.g.ball.pos, undefined, play.inFront);
        const target = this.lane;
        const y = attackHeight(me);
        return { target: { x: target.x, y, z: target.z }, apex: y + target.apexAbove, hitter: me };
      };
      g.setBrain(s, b);
    }
    // coach on the right-back of our court, tossing to the setter
    this.coach = new Athlete('OPP', 1);
    this.coach.place(3.6, 6.4, 0.35);
    g.addAthlete(this.coach, 3, 'coach');
    this.spawned.push(this.coach);
    this.coach.airIntent = 'neutral';

    this.add(this.zoneMarker.group);
    this.approachRing = makeFloorRing(0x6fe3ff, 0.9);
    this.add(this.approachRing);
    this.pickZone();
    g.hud.setTitle('Spike Drill · ' + lane.label);
    this.updateScore();
    this.phase = 'intro';
    this.t = 0;
    g.hud.message(
      this.position === 'MB'
        ? 'Quick: run on the pass · jump as the setter touches it · hold LMB, release to hit · 1-3 set call'
        : this.plays
          ? 'Approach: Shift + W · plant: Space · hold LMB, release to hit · 1-3 set call'
          : 'Approach: Shift + W · plant: Space · hold LMB to wind up, release to hit',
      3.6,
    );
  }

  private pickZone(): void {
    const prev = this.zone;
    const zones = zonesFor(this.position);
    do this.zone = zones[Math.floor(this.g.rng.next() * zones.length)];
    while (prev && this.zone === prev && zones.length > 2);
    const z = this.zone;
    this.zoneMarker.set(z.x0, z.x1, z.z0, z.z1);
  }

  private updateScore(): void {
    const call = this.play ? ` · set ${this.callIdx + 1}: ${this.play.name}` : '';
    this.g.hud.setScore(`${this.score} pts · rep ${this.reps}${call} · target: ${this.zone.name}`);
  }

  hint(): string {
    const me = this.g.me;
    if (me.state === 'air' || me.action?.kind === 'windup') return `hold ${kbd('LMB')} = wind up (longer = harder) · release = hit · tap = tip &nbsp; aim with the mouse`;
    if (me.state === 'load') return `release ${kbd('Space')} to jump`;
    const calls = this.plays ? ` · ${kbd('1')}${kbd('2')}${kbd('3')} set call` : '';
    if (this.play?.inFront !== undefined) return `${kbd('Shift')}+${kbd('W')} run on the pass · ${kbd('Space')} jump with the setter's touch${calls} · ${kbd('V')} camera · ${kbd('N')} reset rep`;
    return `${kbd('Shift')}+${kbd('W')} approach · ${kbd('Space')} plant & jump${calls} · ${kbd('V')} camera · ${kbd('N')} reset rep`;
  }

  restartRep(): void {
    this.endRep(null, true);
  }

  step(dt: number): void {
    const g = this.g;
    this.t += dt;
    // coach faces the setter
    this.coach.cmd.faceYaw = Math.atan2(-(SETTER_TARGET.x - this.coach.pos.x), -(SETTER_TARGET.z - this.coach.pos.z));
    switch (this.phase) {
      case 'intro':
        if (this.t > 1.2) this.toPhase('feed');
        break;
      case 'feed': {
        if (g.userReturning) {
          this.t = 0;
          break;
        }
        if (!this.tossed && this.t > 0.35) {
          this.coach.startAction('toss', g.simTime);
          this.tossed = true;
        }
        if (this.tossed && this.t > 0.62) {
          this.coach.endAction();
          this.feedBall();
          this.toPhase('live');
        }
        break;
      }
      case 'live': {
        const ball = g.ball;
        if (ball.state.rest || this.t > 7) this.endRep(null);
        break;
      }
      case 'result':
        if (this.t > 1.9) this.nextRep();
        break;
    }
    // approach ring: where your feet should be when you hit (fades once the set is up)
    const lane = this.lane;
    const me = g.me;
    const play = this.play;
    const quick = play?.inFront !== undefined;
    // fast sets (quicks, go / fast back) need the run to start before the set: plan them from the pass
    const early = !!play && (quick || lane.apexAbove < 1.0);
    const off = new THREE.Vector3();
    me.idealContact(off, new THREE.Vector3(0, 0, 0)).setY(0);
    const spot = quick ? quickSpot(SETTER_TARGET.x, 1, play!.inFront) : lane;
    this.approachRing.position.set(spot.x - off.x, 0.011, spot.z - off.z);
    // GO cue: when a perfect approach would start
    const lt = g.ball.lastTouch;
    const setUp = g.ball.active && lt && (early ? lt.kind === 'feed' : lt.kind === 'set' || (this.position === 'S' && lt.kind === 'feed'));
    if (setUp && lt !== this.plannedFor && me.state === 'ground') {
      this.plannedFor = lt;
      const pred = g.ball.ensurePrediction(g.env, g.simTime);
      let plan: ApproachPlan | null = null;
      if (early) {
        const tSet = pred.descendThrough(setterTouchY(this.setter), g.simTime);
        if (tSet > 0) {
          pred.posAt(tSet, this.tmp);
          if (quick) plan = planQuick(me, g.simTime, quickSpot(this.tmp.x, 1, play!.inFront), tSet, 0, 0);
          else {
            // where and when the set will meet you (the setter's solved arc)
            const y = attackHeight(me);
            const contact = new THREE.Vector3(lane.x, y, lane.z);
            const v = { x: 0, y: 0, z: 0 };
            const arc = solveApex({ ...this.tmp }, contact, y + lane.apexAbove, { x: 0, y: 0, z: 0 }, v);
            plan = planToPoint(me, g.simTime, contact, tSet + arc.T, 0, 0);
          }
        }
        this.earlyPlan = plan;
        this.earlyFor = lt;
      } else plan = planApproach(me, pred, g.simTime, 0, 0);
      this.goAt = plan && plan.error < 0.6 ? plan.tStart : -1;
    }
    if (this.goAt > 0 && g.simTime >= this.goAt) {
      this.goAt = -1;
      if (g.settings.landingMarker) {
        g.hud.go();
        this.ringPulse = 1;
      }
    }
    this.ringPulse = Math.max(0, this.ringPulse - dt * 2.5);
    const mat = this.approachRing.material as THREE.MeshBasicMaterial;
    mat.opacity = g.settings.landingMarker ? 0.45 + this.ringPulse * 0.55 : 0;
    this.approachRing.scale.setScalar(1 + this.ringPulse * 0.6);
  }

  frame(dt: number): void {
    this.zoneMarker.update(dt);
    if (this.plays) {
      for (let i = 0; i < this.plays.length; i++) if (this.g.input.consumePress('Digit' + (i + 1))) this.selectCall(i);
    }
  }

  private feedBall(): void {
    const g = this.g;
    const from = { x: this.coach.pos.x - 0.1, y: 1.35, z: this.coach.pos.z - 0.3 };
    let target: { x: number; y: number; z: number };
    let apex: number;
    if (this.position === 'S') {
      // pass straight to the setter's attack spot
      const lane = laneFor('S', 1);
      const y = attackHeight(g.me);
      target = { x: lane.x, y, z: lane.z };
      apex = y + lane.apexAbove + 0.6;
    } else {
      target = { x: SETTER_TARGET.x, y: 2.1, z: SETTER_TARGET.z };
      apex = SETTER_TARGET.height + 0.4;
    }
    const v = { x: 0, y: 0, z: 0 };
    solveApex(from, target, apex, { x: 0, y: 0, z: 0 }, v);
    g.ball.launch(from, v, { x: -3, y: 0, z: 0 }, 0, g.simTime);
    g.ball.lastTouch = { athlete: this.coach, kind: 'feed', t: g.simTime, side: 1 };
    g.judge.arm(g.ball);
    this.userTouched = false;
    this.lastGrade = null;
  }

  onContact(ev: ContactEvent): void {
    if (ev.athlete !== this.g.me) return;
    this.userTouched = true;
    this.lastGrade = ev;
    if (ev.grade === 'Miss') {
      this.score += 0;
    }
  }

  onOutcome(o: Outcome): void {
    if (this.phase !== 'live') return;
    this.endRep(o);
  }

  private endRep(o: Outcome | null, silent = false): void {
    const g = this.g;
    if (silent) {
      this.nextRep();
      return;
    }
    this.toPhase('result');
    this.reps++;
    const ev = this.lastGrade;
    let pts = 0;
    let label = 'NO ATTACK';
    let good = false;
    if (ev && ev.grade !== 'Miss') {
      const gradePts = ev.grade === 'Perfect' ? 100 : ev.grade === 'Good' ? 60 : 30;
      pts += gradePts;
      const kmh = ev.speed * 3.6;
      pts += Math.max(0, Math.round(kmh - 70));
      if (o) {
        label = outcomeLabel(o, 1);
        if (o.kind === 'in' && o.side === -1) {
          pts += 50;
          const z = this.zone;
          const inZone = o.x >= z.x0 - R && o.x <= z.x1 + R && o.z >= z.z0 - R && o.z <= z.z1 + R;
          if (inZone) {
            pts += 100;
            label = 'KILL · ON TARGET';
          } else label = 'KILL';
          good = ev.grade === 'Perfect' || ev.grade === 'Good';
        }
      }
    } else if (ev && ev.grade === 'Miss') {
      label = 'WHIFF';
    }
    this.score += pts;
    this.bumpStreak(good);
    g.hud.showBanner(pts > 0 ? `${label}  +${pts}` : label, good ? 'good' : o && o.kind === 'in' && o.side === -1 ? 'neutral' : 'bad');
    g.crowd(good ? (ev?.perfect ? 1 : 0.6) : 0.1, good);
    this.updateScore();
  }

  private nextRep(): void {
    const g = this.g;
    g.judge.disarm();
    const lane = this.lane;
    const me = g.me;
    g.ball.hide();
    if (this.setter) this.setter.place(SETTER_SPOT.x, SETTER_SPOT.z, Math.PI / 2);
    this.pickZone();
    this.updateScore();
    // jog back to the approach start; the next toss waits for you
    if (Math.hypot(me.pos.x - lane.sx, me.pos.z - lane.sz) > 0.6 || me.state !== 'ground') g.returnUser(lane.sx, lane.sz, 0);
    this.toPhase('feed');
  }

  private toPhase(p: Phase): void {
    this.phase = p;
    this.t = 0;
    if (p === 'feed') this.tossed = false;
  }
}

export { COURT };
