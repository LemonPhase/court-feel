import * as THREE from 'three';
import { AI, BALL, CONTACT, COURT } from '../config';
import { clamp, yawFromDir } from '../core/mathx';
import type { Athlete } from '../game/athlete';
import type { Game } from '../game/game';
import { quickSpot, type AttackLane } from '../game/plays';
import { planApproach, planQuick, type ApproachPlan } from './approach';
import { moveTo, netYaw, stop, type Brain } from './brain';
import { ContactSystem, type SetResult } from '../game/contact';
import { solveSpeedToFloor } from '../physics/solve';
import type { V3 } from '../physics/ball';

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
  /** a middle's call: how far along the net in front of the setter the quick is hit (shoot, back quick) */
  inFront: number | undefined = undefined;
  private quickFor: unknown = null;
  enabled = true;
  lastShot = '';

  constructor(
    public athlete: Athlete,
    public lane: AttackLane,
  ) {}

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

  /** run an approach planned before the set: a second-tempo call (on the last steps as the setter touches it) */
  runPlan(plan: ApproachPlan, g: Game): void {
    this.plan = plan;
    this.phase = 'approach';
    this.swung = false;
    this.err = g.rng.gauss() * (0.012 + (1 - this.skill) * 0.06);
  }

  /** the user's set this ball came from, if it is one (ContactSystem.lastSetResult) */
  private userSet(g: Game): SetResult | null {
    const r = g.contact.lastSetResult;
    const lt = g.ball.lastTouch;
    return r && lt?.kind === 'set' && lt.athlete === r.athlete && lt.t === r.t ? r : null;
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
            const plan = planQuick(a, now, quickSpot(ps.x, a.side, this.inFront), ps.t, face, face);
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
        // draw the arm back early in the jump (a middle does it before the set arrives)
        if (!this.swung && a.state === 'air' && a.stateT > 0.04 && !a.action) g.contact.beginWindup(a);
        // (a quick hitter jumps before the set: swing only if it came to us)
        if (!this.swung && a.state === 'air' && this.isMySet(g)) {
          const info = g.contact.ideal(a, now, 0.6);
          const w = a.action?.kind === 'windup' ? a.action : null;
          const lead = ContactSystem.swingLead(w ? ContactSystem.chargeFor(now - w.t0) : 1);
          // off your set: a green one is swung perfectly; a bad one is harder to time and gets tipped or rolled more
          const us = this.userSet(g);
          const err = us?.green ? 0 : us ? this.err * (1 + (AI.badSetErr - 1) * (1 - us.quality)) : this.err;
          const tipChance = us?.green ? 0 : us ? this.tipChance * (1 + (AI.badSetTip - 1) * (1 - us.quality)) : this.tipChance;
          if (info && now >= info.t - lead + err - 1e-4) {
            const aim = this.chooseAim(g, info.ball.x, us?.green ?? false, info.ball);
            a.aiAim.copy(aim);
            const tip = g.rng.next() < tipChance;
            if (tip) {
              // tips go short, just over the block
              a.aiAim.set(clamp(aim.x * 0.5, -3.5, 3.5), aim.y, -a.side * (1.5 + g.rng.next() * 1.5));
              this.lastShot = 'tip';
            }
            // release the wind-up (AI holds long enough for full power); no wind-up = full swing
            if (!g.contact.releaseWindup(a, { aiErr: err, tip })) g.contact.startSwing(a, { aiErr: err, tip });
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

  /**
   * Pick a shot: line, cross or seam (a middle: zone 1 or 5), steering away from where the block
   * is. Off a green set the hitter never swings through the block's hands.
   */
  chooseAim(g: Game, hitX: number, green = false, from?: V3): THREE.Vector3 {
    const a = this.athlete;
    const opp = -a.side; // the other court
    const hw = COURT.halfWidth;
    // line = straight down our sideline; cross = to the far corner
    const lineX = clamp(hitX, -hw + 0.6, hw - 0.6);
    const crossX = -Math.sign(hitX || 1) * (hw - 1.0);
    // the receiving team's right hand is +x for the home side, -x for the away side
    const zone1X = opp * (hw - 1.2);
    const options = this.lane.quick
      ? [
          // a middle hits the deep corners: zone 1 (their right back) or zone 5 (their left back)
          { x: zone1X, z: opp * 7.3, w: 1, name: 'zone 1' },
          { x: -zone1X, z: opp * 7.3, w: 1, name: 'zone 5' },
        ]
      : [
          { x: lineX, z: opp * 7.6, w: 1, name: 'line' },
          { x: crossX, z: opp * 6.8, w: 1.2, name: 'cross' },
          { x: crossX * 0.9, z: opp * 3.6, w: 0.5, name: 'sharp' },
          // a steep cut inside the block: risky, the shot when the block has closed
          { x: crossX * 0.92, z: opp * 2.8, w: 0.22, name: 'cut' },
          { x: hitX * 0.15, z: opp * 6.5, w: 0.6, name: 'seam' },
        ];
    // from behind the 3 m line (a pipe) the ball is hit deep: the short angles cannot come down
    // that soon (the spike would carry deep, over a different part of the net)
    if (Math.abs(a.pos.z) > COURT.attackLine - 0.5)
      for (let i = options.length - 1; i >= 0; i--) if (Math.abs(options[i].z) < 5) options.splice(i, 1);
    // off a green set, a controlled swing: only shots a full-speed spike from here can bring down in the court
    if (green && from) {
      const out = { x: 0, y: 0, z: 0 };
      const w = { x: 0, y: 0, z: 0 };
      const land = { x: 0, y: 0, z: 0 };
      const speed = CONTACT.spikePerfect * a.stats.power;
      for (let i = options.length - 1; i >= 0 && options.length > 1; i--) {
        const o = options[i];
        solveSpeedToFloor(from, o.x, o.z, speed, CONTACT.spikeSpinPerfect, out, w, land);
        if (Math.abs(land.x) > hw - 0.3 || Math.abs(land.z) > COURT.halfLength - 0.3) options.splice(i, 1);
      }
    }
    // avoid the block: penalise shots whose direction passes over a blocker's hands
    const up = this.blockers()
      .filter((b) => Math.abs(b.pos.z) < 1.4)
      .sort((p, q) => p.pos.x - q.pos.x);
    for (const b of up) {
      for (const o of options) {
        // where does the line from the hitter to the target cross the net?
        const f = Math.abs(a.pos.z) / (Math.abs(a.pos.z) + Math.abs(o.z));
        const cx = hitX + (o.x - hitX) * f;
        // off a green set: where the blocker's hands will be as the ball crosses (they may still be
        // moving; a spike travels ~20 m/s, so a pipe from the 3 m line gives the block longer)
        const bx = green ? b.pos.x + b.vel.x * (0.05 + Math.abs(a.pos.z) / 20) : b.pos.x;
        if (Math.abs(cx - bx) < CONTACT.blockHalfWidth + BALL.radius + (green ? 0.45 : 0.3)) o.w *= green ? 0 : 0.15;
      }
    }
    // a green set with every shot covered: take the one furthest from a blocker's hands
    if (green && options.every((o) => o.w === 0)) {
      let far = options[0];
      let farD = -1;
      for (const o of options) {
        const f = Math.abs(a.pos.z) / (Math.abs(a.pos.z) + Math.abs(o.z));
        const cx = hitX + (o.x - hitX) * f;
        const dmin = Math.min(...up.map((b) => Math.abs(cx - b.pos.x)));
        if (dmin > farD) {
          farD = dmin;
          far = o;
        }
      }
      far.w = 1;
    }
    // a double block that did not close: hit through the seam
    if (!this.lane.quick) {
      for (let i = 0; i + 1 < up.length; i++) {
        const gap = up[i + 1].pos.x - up[i].pos.x - 2 * CONTACT.blockHalfWidth;
        const gx = (up[i].pos.x + up[i + 1].pos.x) / 2;
        if (gap < 0.3 || Math.abs(gx - hitX) > 2.5) continue;
        // extend the line from the contact through the seam to a deep spot on their court
        const dz = Math.abs(a.pos.z);
        const k = (dz + 6.5) / Math.max(0.3, dz);
        const tx = hitX + (gx - hitX) * k;
        if (Math.abs(tx) < hw - 0.3) options.push({ x: tx, z: opp * 6.5, w: 1.1, name: 'seam' });
      }
    }
    const total = options.reduce((s, o) => s + o.w, 0);
    let r = g.rng.next() * total;
    for (const o of options) {
      r -= o.w;
      if (r <= 0) {
        this.lastShot = o.name;
        const x = o.x + g.rng.gauss() * 0.4;
        const z = o.z + g.rng.gauss() * 0.4;
        // off a green set the hitter takes a controlled swing: the shot stays inside the lines
        if (green) return new THREE.Vector3(clamp(x, -hw + 0.3, hw - 0.3), 0, opp * clamp(Math.abs(z), 1.5, COURT.halfLength - 0.5));
        return new THREE.Vector3(x, 0, z);
      }
    }
    return new THREE.Vector3(crossX, 0, opp * 6.5);
  }
}
