import * as THREE from 'three';
import { AI, TIMING } from '../../config';
import { yawFromDir } from '../../core/mathx';
import { solveApex } from '../../physics/solve';
import { BlockerBrain } from '../../ai/blocker';
import { HitterBrain } from '../../ai/hitter';
import { Athlete } from '../athlete';
import { applyCalls, CALL_COLOR, callLane, callOptions, callSheet, callSpot, startCallRuns, type CallHitters } from '../callRuns';
import type { ContactEvent, SetOption } from '../contact';
import { outcomeLabel, type Outcome } from '../judge';
import { SETTER_SPOT, SETTER_TARGET, setterTouchY } from '../plays';
import { SETTER_KEYS, SetterCalls, type SetterKey } from '../setterCalls';
import { kbd, makeFloorRing, Mode } from './mode';
import type { Game } from '../game';

type Phase = 'intro' | 'feed' | 'live' | 'result';

/**
 * Setter drill: passes come in from the back court. Pick a hitter with 1-4 (outside, middle,
 * opposite, pipe), or just look at one; C opens the call sheet to change their calls. Get to the
 * spot, press RMB as the ball reaches your hands, hold while the bar fills and release in the
 * green: your touch sets how big the green is. Your hitters run their calls (the fast ones before
 * you touch it) and finish against a block. A green set beats it.
 */
export class SetterDrill extends Mode {
  readonly id = 'setter' as const;
  private passer!: Athlete;
  private hitters: CallHitters = new Map();
  private blocker!: Athlete;
  private phase: Phase = 'intro';
  private t = 0;
  private set: ContactEvent | null = null;
  private setFor: Athlete | null = null;
  private attacked = false;
  private markers = new Map<SetterKey, THREE.Mesh>();
  private tossed = false;
  /** your picks and calls (keys 1-4, C the call sheet) */
  readonly calls = new SetterCalls();
  /** this rep's pass is too far off the net for the fast calls: everything goes up high */
  private outOfSystem = false;

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
      brain.blockers = () => [this.blocker];
      brain.skill = 0.82;
      // the middle goes on the pass, timed to your touch
      if (k === 'MB') brain.passToSetter = (gm) => this.passToMe(gm);
      g.setBrain(a, brain);
      this.hitters.set(k, { a, brain });
      const m = makeFloorRing(CALL_COLOR[k], 1.0);
      this.add(m);
      this.markers.set(k, m);
    }
    // a passer in the back court feeding the setter target
    this.passer = new Athlete('L', 1);
    this.passer.place(-1.0, 6.8, 0);
    g.addAthlete(this.passer, 6, 'coach');
    this.spawned.push(this.passer);
    this.passer.airIntent = 'neutral';
    // one opposing middle blocker reading your set
    this.blocker = new Athlete('MB', -1);
    this.blocker.place(0, -0.5, Math.PI);
    g.addAthlete(this.blocker, 47);
    this.spawned.push(this.blocker);
    const bb = new BlockerBrain(this.blocker, 0, 3.6);
    bb.skill = 0.55;
    g.setBrain(this.blocker, bb);
    g.hud.setTitle('Setter Drill');
    this.updateScore();
    g.hud.message('1-4 pick a hitter · RMB as the ball reaches your hands, release in the green', 3.2);
    this.toPhase('intro');
  }

  /** while the pass is coming: when the ball leaves your hands (the catch plus the load) and where (none off a bad pass: no quick) */
  private passToMe(g: Game): { t: number; x: number } | null {
    const lt = g.ball.lastTouch;
    if (!g.ball.active || lt?.athlete !== this.passer || lt.kind !== 'pass' || this.outOfSystem) return null;
    const pred = g.ball.ensurePrediction(g.env, g.simTime);
    const t = pred.descendThrough(setterTouchY(g.me), g.simTime);
    if (t < 0) return null;
    const p = { x: 0, y: 0, z: 0 };
    pred.posAt(t, p);
    return { t: t + TIMING.setLoad, x: p.x };
  }

  setOptions(a: Athlete): SetOption[] {
    const oos = this.outOfSystem || Math.hypot(a.pos.x - SETTER_SPOT.x, a.pos.z - SETTER_SPOT.z) > AI.outOfSystem;
    return callOptions(this.g, this.hitters, this.calls, oos);
  }

  /** the pass is in the air until your set: the ball is yours to set */
  userSetsNext(): boolean {
    return this.phase === 'live' && this.g.ball.lastTouch?.athlete === this.passer;
  }

  setPick(a: Athlete): SetterKey | null {
    return a === this.g.me ? this.calls.pick : null;
  }

  hint(): string {
    if (this.calls.editing) return `CALL SHEET · ${kbd('1')}${kbd('2')}${kbd('3')} change a hitter's call · ${kbd('C')} done`;
    return `${kbd('1')}-${kbd('4')} pick (again: high) · ${kbd('C')} calls · ${kbd('WASD')} to the spot · ${kbd('RMB')} as it reaches your hands, release in the green · ${kbd('V')} camera`;
  }

  private updateScore(): void {
    this.g.hud.setScore(`${this.score} pts · rep ${this.reps}`);
  }

  restartRep(): void {
    this.nextRep();
  }

  frame(dt: number): void {
    // the floor rings: each hitter's spot for their call; the picked one lit (no pick: the one you look at)
    const g = this.g;
    const me = g.me;
    let lit = this.calls.pick;
    if (!lit) {
      let bestD = 1e9;
      for (const o of this.setOptions(me)) {
        const oy = yawFromDir(o.target.x - me.pos.x, o.target.z - me.pos.z);
        const d = Math.abs(((oy - g.rig.yaw + Math.PI * 3) % (Math.PI * 2)) - Math.PI);
        if (d < bestD) {
          bestD = d;
          lit = o.key ?? null;
        }
      }
    }
    for (const [k, m] of this.markers) {
      const spot = callSpot(this.calls, k, this.outOfSystem);
      m.position.set(spot.x, 0.011, spot.z + 0.15);
      const mat = m.material as THREE.MeshBasicMaterial;
      mat.opacity += ((k === lit ? 0.95 : 0.25) - mat.opacity) * Math.min(1, dt * 10);
    }
    g.hud.setCallSheet(callSheet(this.calls, SETTER_KEYS, lit));
  }

  step(dt: number): void {
    const g = this.g;
    this.t += dt;
    this.calls.readKeys(g.input);
    // before the pass the hitters walk to the start of their call's run
    if (!this.calls.locked) applyCalls(this.hitters, this.calls, false);
    switch (this.phase) {
      case 'intro':
        if (this.t > 1.2) this.toPhase('feed');
        break;
      case 'feed':
        if (g.userReturning) {
          this.t = 0;
          break;
        }
        if (!this.tossed && this.t > 0.4) {
          this.tossed = true;
          this.passer.startAction('pass', g.simTime);
        }
        if (this.tossed && this.t > 0.55) {
          this.passer.endAction();
          // passes vary: sometimes tight, sometimes off the net
          const off = this.reps % 4 === 3 ? 1.6 : 0.6;
          const tgt = { x: SETTER_TARGET.x + g.rng.gauss() * off * 0.6, y: 2.35, z: SETTER_TARGET.z + Math.abs(g.rng.gauss()) * off };
          const from = { x: this.passer.pos.x, y: 0.85, z: this.passer.pos.z - 0.4 };
          const v = { x: 0, y: 0, z: 0 };
          solveApex(from, tgt, 4.2 + g.rng.next() * 0.6, { x: 0, y: 0, z: 0 }, v);
          g.ball.launch(from, v, { x: 2, y: 0, z: 0 }, 0, g.simTime);
          g.ball.lastTouch = { athlete: this.passer, kind: 'pass', t: g.simTime, side: 1 };
          this.set = null;
          this.setFor = null;
          this.attacked = false;
          // the pass is played: the tempos lock and the fast calls start running
          this.calls.lock();
          this.outOfSystem = startCallRuns(g, g.me, this.hitters, this.calls);
          if (this.outOfSystem) g.hud.message('Off the net · HIGH · no middle, every call goes up high', 1.8);
          this.toPhase('live');
        }
        break;
      case 'live':
        if (g.ball.state.rest || this.t > 9) this.finish(null);
        break;
      case 'result':
        if (this.t > 2.2) this.nextRep();
        break;
    }
    this.passer.cmd.faceYaw = yawFromDir(SETTER_TARGET.x - this.passer.pos.x, SETTER_TARGET.z - this.passer.pos.z);
  }

  onContact(ev: ContactEvent): void {
    const g = this.g;
    if (ev.athlete === g.me && ev.kind === 'set') {
      this.set = ev;
      this.setFor = g.contact.lastSet?.hitter ?? null;
    }
    if (ev.kind === 'spike' || ev.kind === 'tip') this.attacked = true;
  }

  onOutcome(o: Outcome): void {
    if (this.phase !== 'live') return;
    if (!this.set || this.attacked || o.side === 1) this.finish(o);
  }

  private finish(o: Outcome | null): void {
    const g = this.g;
    if (this.phase === 'result') return;
    this.toPhase('result');
    this.reps++;
    let pts = 0;
    let label = 'NO SET';
    let good = false;
    if (this.set) {
      pts += this.set.grade === 'Perfect' ? 100 : this.set.grade === 'Good' ? 60 : 25;
      if (o && this.attacked) {
        const r = outcomeLabel(o, 1);
        if (o.kind === 'in' && o.side === -1) {
          pts += 50;
          label = 'KILL';
          good = this.set.grade === 'Perfect' || this.set.grade === 'Good';
          g.crowd(0.7);
        } else label = r === 'DOWN' ? 'BLOCKED' : r;
      } else label = 'SET';
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
    this.calls.nextBall();
    for (const [k, h] of this.hitters) {
      h.brain.reset();
      const lane = callLane(this.calls, k, false);
      h.brain.lane = lane;
      h.a.place(lane.sx, lane.sz, 0);
    }
    this.blocker.place(0, -0.5, Math.PI);
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
