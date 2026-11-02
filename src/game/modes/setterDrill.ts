import * as THREE from 'three';
import { yawFromDir } from '../../core/mathx';
import { solveApex } from '../../physics/solve';
import { BlockerBrain } from '../../ai/blocker';
import { HitterBrain } from '../../ai/hitter';
import { Athlete } from '../athlete';
import type { ContactEvent, SetOption } from '../contact';
import { outcomeLabel, type Outcome } from '../judge';
import { attackHeight, laneFor, SETTER_SPOT, SETTER_TARGET } from '../plays';
import { kbd, makeFloorRing, Mode } from './mode';

type Phase = 'intro' | 'feed' | 'live' | 'result';
type Lane = 'OH' | 'MB' | 'OPP';

/**
 * Setter drill: passes come in from the back court; move under them, look at
 * the hitter you want (left = outside, at the middle = quick, behind = back
 * set) and press RMB as the ball drops. Your hitters finish against a block.
 */
export class SetterDrill extends Mode {
  readonly id = 'setter' as const;
  private passer!: Athlete;
  private hitters = new Map<Lane, { a: Athlete; brain: HitterBrain }>();
  private blocker!: Athlete;
  private phase: Phase = 'intro';
  private t = 0;
  private set: ContactEvent | null = null;
  private setFor: Athlete | null = null;
  private attacked = false;
  private markers = new Map<Lane, THREE.Mesh>();
  private tossed = false;

  setup(): void {
    const g = this.g;
    g.placeUser(SETTER_SPOT.x, SETTER_SPOT.z + 0.3, Math.PI / 2);
    g.rig.pitch = 0.25;
    let seed = 41;
    for (const pos of ['OH', 'MB', 'OPP'] as Lane[]) {
      const lane = laneFor(pos, 1);
      const a = new Athlete(pos, 1);
      a.place(lane.sx, lane.sz, 0);
      g.addAthlete(a, seed++);
      this.spawned.push(a);
      const brain = new HitterBrain(a, lane);
      brain.isMySet = () => this.setFor === a && this.g.ball.lastTouch?.kind === 'set';
      brain.blockers = () => [this.blocker];
      brain.skill = 0.82;
      g.setBrain(a, brain);
      this.hitters.set(pos, { a, brain });
      const m = makeFloorRing(pos === 'OH' ? 0xffc23a : pos === 'MB' ? 0x6fe3ff : 0xff6fb0, 1.0);
      m.position.set(lane.x, 0.011, lane.z + 0.15);
      this.add(m);
      this.markers.set(pos, m);
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
    g.hud.message('Look at a hitter · press RMB as the ball drops onto your hands', 3.2);
    this.toPhase('intro');
  }

  setOptions(a: Athlete): SetOption[] {
    const out: SetOption[] = [];
    for (const [pos, h] of this.hitters) {
      const lane = laneFor(pos, a.side);
      const y = attackHeight(h.a);
      out.push({ target: { x: lane.x, y, z: lane.z }, apex: y + lane.apexAbove, hitter: h.a, label: pos === 'OH' ? 'Outside' : pos === 'MB' ? 'Quick' : 'Back set' });
    }
    return out;
  }

  hint(): string {
    return `${kbd('WASD')} get under it · look at a hitter · ${kbd('RMB')} set (press just before it lands on your hands) · ${kbd('V')} camera`;
  }

  private updateScore(): void {
    this.g.hud.setScore(`${this.score} pts · rep ${this.reps}`);
  }

  restartRep(): void {
    this.nextRep();
  }

  frame(dt: number): void {
    // highlight the hitter the aim would choose
    const g = this.g;
    const me = g.me;
    const opts = this.setOptions(me);
    let best: Lane = 'OH';
    let bestD = 1e9;
    const yaw = g.rig.yaw;
    for (const o of opts) {
      const oy = yawFromDir(o.target.x - me.pos.x, o.target.z - me.pos.z);
      let d = Math.abs(((oy - yaw + Math.PI * 3) % (Math.PI * 2)) - Math.PI);
      if (d < bestD) {
        bestD = d;
        best = (o.hitter?.role as Lane) ?? 'OH';
      }
    }
    for (const [pos, m] of this.markers) {
      const mat = m.material as THREE.MeshBasicMaterial;
      mat.opacity += ((pos === best ? 0.95 : 0.25) - mat.opacity) * Math.min(1, dt * 10);
    }
  }

  step(dt: number): void {
    const g = this.g;
    this.t += dt;
    switch (this.phase) {
      case 'intro':
        if (this.t > 1.2) this.toPhase('feed');
        break;
      case 'feed':
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
    for (const [pos, h] of this.hitters) {
      h.brain.reset();
      const lane = laneFor(pos, 1);
      h.a.place(lane.sx, lane.sz, 0);
    }
    this.blocker.place(0, -0.5, Math.PI);
    const me = g.me;
    if (Math.hypot(me.pos.x - SETTER_SPOT.x, me.pos.z - SETTER_SPOT.z) > 2.2 || me.state !== 'ground') g.hud.fade(() => g.placeUser(SETTER_SPOT.x, SETTER_SPOT.z + 0.3, Math.PI / 2));
    this.toPhase('feed');
  }

  private toPhase(p: Phase): void {
    this.phase = p;
    this.t = 0;
  }
}
