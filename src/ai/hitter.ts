import * as THREE from 'three';
import { AI, COURT, TIMING } from '../config';
import { clamp, yawFromDir } from '../core/mathx';
import type { Athlete } from '../game/athlete';
import type { Game } from '../game/game';
import { quickSpot, type AttackLane } from '../game/plays';
import { planApproach, planQuick, type ApproachPlan } from './approach';
import { moveTo, netYaw, stop, type Brain } from './brain';

/**
 * AI attacker: waits at its approach start, reads a set meant for it, plans a
 * simulated approach (same kinematics as the user), jumps, picks a shot
 * (line / cross / seam / tip, steering away from the block) and swings with
 * a skill-based timing error through the same contact system as the user.
 */
export class HitterBrain implements Brain {
  phase: 'ready' | 'approach' | 'load' | 'air' | 'recover' = 'ready';
  plan: ApproachPlan | null = null;
  skill = AI.hitterSkill;
  /** is the ball in the air a set for me? */
  isMySet: (g: Game) => boolean = () => false;
  /** opposing blockers to read */
  blockers: () => Athlete[] = () => [];
  tipChance = 0.08;
  private swung = false;
  private err = 0;
  /** stay at the ready spot instead of the approach start (e.g. while defending) */
  holdSpot: { x: number; z: number } | null = null;
  /**
   * Quick hitters: while a pass is on its way to our setter, when and where
   * the setter will touch it (null otherwise). The middle runs on the pass and
   * leaves the floor with the setter's touch; if the set goes elsewhere the
   * jump was a decoy.
   */
  passToSetter: ((g: Game) => { t: number; x: number } | null) | null = null;
  private quickFor: unknown = null;
  enabled = true;
  lastShot = '';

  constructor(public athlete: Athlete, public lane: AttackLane) {}

  reset(): void {
    this.phase = 'ready';
    this.plan = null;
    this.swung = false;
    this.quickFor = null;
  }

  /** when this hitter will release its plant (for the setter's read), if planned */
  get releaseAt(): number | undefined {
    return this.plan && (this.phase === 'approach' || this.phase === 'load') ? this.plan.tPress + this.plan.hold : undefined;
  }

  step(_dt: number, g: Game): void {
    const a = this.athlete;
    const now = g.simTime;
    if (!this.enabled) return;
    const face = netYaw(a.side);
    switch (this.phase) {
      case 'ready': {
        const spot = this.holdSpot ?? { x: this.lane.sx, z: this.lane.sz };
        moveTo(a, spot.x, spot.z, { face, arrive: 0.5 });
        const lt = g.ball.lastTouch;
        if (this.lane.quick && this.passToSetter && g.ball.active && a.state === 'ground' && lt !== this.quickFor && lt?.athlete !== a) {
          const ps = this.passToSetter(g);
          if (ps && ps.t - now > 0.3) {
            this.quickFor = lt;
            const plan = planQuick(a, now, quickSpot(ps.x, a.side), ps.t, face, face);
            if (plan && plan.error < 0.6) {
              this.plan = plan;
              this.phase = 'approach';
              this.swung = false;
              this.err = g.rng.gauss() * (0.012 + (1 - this.skill) * 0.06);
              break;
            }
          }
        }
        if (g.ball.active && this.isMySet(g) && a.state === 'ground') {
          const pred = g.ball.ensurePrediction(g.env, now);
          const aim = this.chooseAim(g, pred.land.x);
          const airYaw = yawFromDir(aim.x - this.lane.x, aim.z - this.lane.z);
          this.plan = planApproach(a, pred, now, face, airYaw);
          if (this.plan) {
            this.phase = 'approach';
            this.swung = false;
            const s = 1 - this.skill;
            this.err = g.rng.gauss() * (0.012 + s * 0.06);
          }
        }
        break;
      }
      case 'approach': {
        const p = this.plan!;
        if (now >= p.tStart - 1e-6) {
          a.cmd.moveX = p.dir.x;
          a.cmd.moveZ = p.dir.z;
          a.cmd.sprint = true;
        } else stop(a);
        a.cmd.faceYaw = p.runYaw;
        if (now >= p.tPress - 1e-6) {
          a.jumpPress();
          this.phase = 'load';
        }
        break;
      }
      case 'load': {
        const p = this.plan!;
        stop(a, p.runYaw);
        if (now >= p.tPress + p.hold - 1e-6) {
          a.jumpRelease();
          this.phase = 'air';
        }
        break;
      }
      case 'air': {
        const p = this.plan!;
        stop(a, p.airYaw);
        // (a quick hitter jumps before the set: swing only if it came to us)
        if (!this.swung && a.state === 'air' && this.isMySet(g)) {
          const info = g.contact.ideal(a, now, 0.6);
          if (info && now >= info.t - TIMING.swingNominal + this.err - 1e-4) {
            const aim = this.chooseAim(g, info.ball.x);
            a.aiAim.copy(aim);
            const act = g.contact.startSwing(a, { aiErr: this.err });
            if (g.rng.next() < this.tipChance) {
              act.held = false;
              act.releaseT = now + 0.01;
              // tips go short, just over the block
              a.aiAim.set(clamp(aim.x * 0.5, -3.5, 3.5), aim.y, -a.side * (1.5 + g.rng.next() * 1.5));
              this.lastShot = 'tip';
            }
            this.swung = true;
          }
        }
        if (a.state !== 'air' && this.swung) this.phase = 'recover';
        if (a.state === 'ground' && !this.swung && a.stateT > 0.3) this.phase = 'recover';
        break;
      }
      case 'recover': {
        stop(a, face);
        if (a.state === 'ground' && a.stateT > 0.35) {
          if (a.action?.kind === 'swing' && a.action.resolved) a.endAction();
          this.phase = 'ready';
          this.plan = null;
        }
        break;
      }
    }
  }

  /** pick a shot: line, cross or seam, steering away from where the block is */
  chooseAim(g: Game, hitX: number): THREE.Vector3 {
    const a = this.athlete;
    const opp = -a.side; // the other court
    const hw = COURT.halfWidth;
    // line = straight down our sideline; cross = to the far corner
    const lineX = clamp(hitX, -hw + 0.6, hw - 0.6);
    const crossX = -Math.sign(hitX || 1) * (hw - 1.0);
    const options = [
      { x: lineX, z: opp * 7.6, w: 1, name: 'line' },
      { x: crossX, z: opp * 6.8, w: 1.2, name: 'cross' },
      { x: crossX * 0.9, z: opp * 3.6, w: 0.5, name: 'sharp' },
      { x: hitX * 0.15, z: opp * 6.5, w: 0.6, name: 'seam' },
    ];
    // avoid the block: penalise shots whose direction passes over a blocker's hands
    for (const b of this.blockers()) {
      if (Math.abs(b.pos.z) > 1.4) continue;
      for (const o of options) {
        // where does the line from the hitter to the target cross the net?
        const f = Math.abs(a.pos.z) / (Math.abs(a.pos.z) + Math.abs(o.z));
        const cx = hitX + (o.x - hitX) * f;
        if (Math.abs(cx - b.pos.x) < 0.9) o.w *= 0.15;
      }
    }
    const total = options.reduce((s, o) => s + o.w, 0);
    let r = g.rng.next() * total;
    for (const o of options) {
      r -= o.w;
      if (r <= 0) {
        this.lastShot = o.name;
        return new THREE.Vector3(o.x + g.rng.gauss() * 0.4, 0, o.z + g.rng.gauss() * 0.4);
      }
    }
    return new THREE.Vector3(crossX, 0, opp * 6.5);
  }
}
