import * as THREE from 'three';
import { AI, BALL, CONTACT, COURT, PLAYER } from '../config';
import { clamp, yawFromDir } from '../core/mathx';
import type { Athlete } from '../game/athlete';
import type { Game } from '../game/game';
import { attackHeight, quickSpot, type AttackLane } from '../game/plays';
import { planApproach, planQuick, planToPoint, riseTime, type ApproachPlan } from './approach';
import { moveTo, netYaw, stop, type Brain } from './brain';
import { blockHands, ContactSystem, type SetResult } from '../game/contact';
import { solveSpeedToFloor } from '../physics/solve';
import type { V3 } from '../physics/ball';
import { openShot, type BlockHands, type Digger } from './openShot';

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
  /** everyone on the other side who could dig it (the hitter looks for the open spot) */
  defenders: () => Athlete[] = () => [];
  /** was the set we are about to hit run off a pass in system (the whole court in view)? */
  inSystem: () => boolean = () => true;
  tipChance = 0.08;
  private swung = false;
  private err = 0;
  /** stay at the ready spot instead of the approach start (e.g. while defending) */
  holdSpot: { x: number; z: number } | null = null;
  /**
   * Quick and fast-set hitters: while a pass is on its way to our setter, when and where
   * the setter will touch it (null otherwise). The middle runs on the pass and
   * leaves the floor with the setter's touch; a pin hitter on a fast set is mid-run then.
   * If the set goes elsewhere the run was a decoy.
   */
  passToSetter: ((g: Game) => { t: number; x: number } | null) | null = null;
  /** a middle's call: how far along the net in front of the setter the quick is hit (shoot, back quick) */
  inFront: number | undefined = undefined;
  private quickFor: unknown = null;
  /** this approach is a pin hitter's fast set, run before the setter touches the ball */
  tempo = false;
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
    this.pendingRun = null;
    this.tempo = false;
  }

  /**
   * A pin hitter running a fast set: where and when the hand will meet the ball (the setter
   * sends it there in that time, as for a quick). Null when not running one.
   */
  get tempoBall(): { t: number; contact: THREE.Vector3 } | null {
    const p = this.plan;
    if (!this.tempo || !p || (this.phase !== 'approach' && this.phase !== 'load' && this.phase !== 'air')) return null;
    return { t: p.tc, contact: p.contact };
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

  /** a called tempo run to make: meet the set at `contact` at `tc` (planned once off the net) */
  private pendingRun: { contact: THREE.Vector3; tc: number } | null = null;

  /**
   * Run a called tempo (a set not yet made): to meet it at `contact` at time `tc`. From the
   * approach start: a hitter still at the net (blocking a moment ago) backs off to it first,
   * and goes from wherever they are once their takeoff is near (AI.transitionLatest).
   */
  runTo(contact: THREE.Vector3, tc: number): void {
    this.pendingRun = { contact, tc };
  }

  /** off the net and at the approach start (AI.transitionReady), or out of time to get there before taking off at `tTakeoff` */
  private readyToRun(spot: { x: number; z: number }, now: number, tTakeoff: number): boolean {
    const a = this.athlete;
    return Math.hypot(a.pos.x - spot.x, a.pos.z - spot.z) < AI.transitionReady || tTakeoff - now < AI.transitionLatest;
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
        // a called run: off the net first, then the approach
        const run = this.pendingRun;
        // (a ball that went somewhere else, or a run there is no longer time for, is dropped)
        if (run && (!g.ball.active || run.tc - now < 0.3)) this.pendingRun = null;
        else if (run && a.state === 'ground' && this.readyToRun(spot, now, run.tc - riseTime(a.jumpMax))) {
          this.pendingRun = null;
          const plan = planToPoint(a, now, run.contact, run.tc, face, face);
          if (plan && plan.error < 0.6) {
            this.runPlan(plan, g);
            break;
          }
        }
        // (a quick or a fast set starts from off the net: one still at the net after a block keeps backing off)
        const offNet = Math.abs(a.pos.z) >= AI.transition.approachOff;
        if (this.passToSetter && offNet && g.ball.active && a.state === 'ground' && lt !== this.quickFor && lt?.athlete !== a) {
          const ps = this.passToSetter(g);
          // the middle backs off the net to its approach start before the quick (ps.t: its takeoff)
          if (ps && ps.t - now > 0.3 && this.readyToRun(spot, now, ps.t)) {
            this.quickFor = lt;
            // a pin hitter runs a fast set (a go, a fast back) on some good passes: already
            // running when the setter touches it, met AI.tempo.flight after the touch
            const fast = !this.lane.quick && g.rng.next() < AI.tempo.share;
            const contact = new THREE.Vector3(this.lane.x, attackHeight(a), this.lane.z);
            const plan = this.lane.quick
              ? planQuick(a, now, quickSpot(ps.x, a.side, this.inFront), ps.t, face, face)
              : fast
                ? planToPoint(a, now, contact, ps.t + AI.tempo.flight, face, face)
                : null;
            if (plan && plan.error < 0.6) {
              this.plan = plan;
              this.tempo = !this.lane.quick;
              this.phase = 'approach';
              this.swung = false;
              this.err = g.rng.gauss() * (AI.attackErr + (1 - this.skill) * 0.06);
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
            this.tempo = false;
            this.phase = 'approach';
            this.swung = false;
            const s = 1 - this.skill;
            this.err = g.rng.gauss() * (AI.attackErr + s * 0.06);
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
          // a late arm still swings (graded late through aiErr): a hitter never lets the set drop past
          if (info && now >= info.t - lead + Math.min(err, 0) - 1e-4) {
            const aim = this.chooseAim(g, info.ball.x, info.ball, info.t, us);
            a.aiAim.copy(aim);
            // a roll shot over a closed block is a soft swing (the contact rolls it when it goes deep)
            const roll = this.lastShot === 'roll';
            const push = this.lastShot === 'recycle';
            const tip = roll || push || g.rng.next() < tipChance;
            if (tip && !roll && !push) {
              // tips go short, just over the block
              a.aiAim.set(clamp(aim.x * 0.5, -3.5, 3.5), aim.y, -a.side * (1.5 + g.rng.next() * 1.5));
              this.lastShot = 'tip';
            }
            // release the wind-up (AI holds long enough for full power); no wind-up = full swing
            if (!g.contact.releaseWindup(a, { aiErr: err, tip, push })) g.contact.startSwing(a, { aiErr: err, tip, push });
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
   * The open spot for a full-speed spike from `from` (see openShot), against the defence as it
   * stands: they can move `read` s after the hit (a blocker in the air comes down first).
   */
  private openSpot(g: Game, from: V3, tHit: number, read: number, misread: boolean) {
    const a = this.athlete;
    const diggers: Digger[] = this.defenders().map((d) => {
      // a blocker in the air comes down first
      let down = 0;
      if (d.state === 'air') {
        const vy = d.vel.y;
        down = (vy + Math.sqrt(Math.max(0, vy * vy + 2 * BALL.gravity * d.pos.y))) / BALL.gravity + PLAYER.landRecover;
      } else if (d.state === 'land') down = Math.max(0, PLAYER.landRecover - d.stateT);
      return { x: d.pos.x, z: d.pos.z, ready: Math.max(read, down), speed: d.stats.approachSpeed };
    });
    // each blocker at the net: where their hands will be as the ball crosses, and how high: in the
    // air, the top of this jump; still on the floor, rising from a jump taken right now
    const blocks: BlockHands[] = this.blockers()
      .filter((b) => Math.abs(b.pos.z) < 1.4 && !(misread && b.isUser))
      .map((b) => {
        const hands = b.standReach + 0.04;
        const x = b.pos.x + b.reachX + b.vel.x * (0.05 + Math.abs(a.pos.z) / 20);
        if (b.state === 'air') {
          const top = hands + (b.vel.y > 0 ? b.pos.y + (b.vel.y * b.vel.y) / (2 * BALL.gravity) : b.pos.y);
          return { x, top: () => top };
        }
        const lead = Math.max(0, tHit - g.simTime) - (b.state === 'load' ? 0 : PLAYER.loadMin);
        const v0 = Math.sqrt(2 * BALL.gravity * b.jumpMax);
        const rise = (tau: number) => (tau <= 0 ? 0 : tau >= v0 / BALL.gravity ? b.jumpMax : v0 * tau - 0.5 * BALL.gravity * tau * tau);
        return { x, top: (t: number) => hands + rise(t + lead) };
      });
    const opp = -a.side as 1 | -1;
    return openShot(from, CONTACT.spikePerfect * a.stats.power, CONTACT.spikeSpinPerfect, opp, g.env, diggers, blocks, () => g.rng.next());
  }

  /**
   * Pick a shot. A hitter who sees the court (in system; out of system `AI.openShotOut` of the
   * time) hits the open spot if there is one: round the block or over it, where no defender gets a
   * platform under it in time. Otherwise their usual shots: line, cross, a sharp angle, the seam
   * (a middle: steep and short, behind the off-blocker), steering away from the block's hands;
   * against a closed block a roll shot over it or a wipe off the outside hand.
   * Off your set (`us`) your touch decides: off a green set their defence starts late, every spot
   * the hitter finds is open and it never swings through the block's hands or uses the block; off
   * an early or late one it doesn't look for the open spot.
   */
  chooseAim(g: Game, hitX: number, from?: V3, tHit = g.simTime, us: SetResult | null = null): THREE.Vector3 {
    const a = this.athlete;
    const opp = -a.side; // the other court
    const hw = COURT.halfWidth;
    const green = us?.green ?? false;
    const sees = this.inSystem();
    // (playability: now and then the user's block is misread, as if it weren't there)
    const userUp = this.blockers().some((b) => b.isUser && Math.abs(b.pos.z) < 1.4);
    const misread = userUp && g.rng.next() < AI.userBlockMisread;
    // off your early or late set there is no open spot: the setter's touch decides the point
    const badSet = !!us && !green && us.grade !== 'Good';
    if (from && !badSet && (green || sees || g.rng.next() < AI.openShotOut)) {
      // off your green set their defence starts late (AI.greenSetDigDelay) and the hitter takes any spot it finds
      const open = this.openSpot(g, from, tHit, green ? AI.greenSetDigDelay : AI.defence.hitReact, misread);
      // the hitter goes for the hardest spot to dig even when it isn't quite open
      if (open && (green || open.margin >= -AI.openShotStretch)) {
        this.lastShot = 'open';
        return new THREE.Vector3(open.x, 0, open.z);
      }
    }
    // line = straight down our sideline; cross = to the far corner
    const lineX = clamp(hitX, -hw + 0.6, hw - 0.6);
    const crossX = -Math.sign(hitX || 1) * (hw - 1.0);
    // the receiving team's right hand is +x for the home side, -x for the away side
    const zone1X = opp * (hw - 1.2);
    const options = this.lane.quick
      ? [
          // a middle is met right over the net: it hits down, steep and short, into the hole behind
          // the off-blocker and in front of the back row; now and then deep to zone 1 or 5
          { x: -zone1X, z: opp * AI.quickShot.cut, w: 1, name: 'cut' },
          { x: zone1X, z: opp * AI.quickShot.cut, w: 1, name: 'cut' },
          { x: hitX * 0.5, z: opp * AI.quickShot.down, w: 1, name: 'down' },
          { x: zone1X, z: opp * 7.3, w: AI.quickShot.deep, name: 'zone 1' },
          { x: -zone1X, z: opp * 7.3, w: AI.quickShot.deep, name: 'zone 5' },
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
      .filter((b) => Math.abs(b.pos.z) < 1.4 && !(misread && b.isUser))
      .sort((p, q) => p.pos.x - q.pos.x);
    for (const b of up) {
      for (const o of options) {
        // where does the line from the hitter to the target cross the net?
        const f = Math.abs(a.pos.z) / (Math.abs(a.pos.z) + Math.abs(o.z));
        const cx = hitX + (o.x - hitX) * f;
        // off a green set: where the blocker's hands will be as the ball crosses (they may still be
        // moving; a spike travels ~20 m/s, so a pipe from the 3 m line gives the block longer)
        const bx = b.pos.x + b.reachX + (green ? b.vel.x * (0.05 + Math.abs(a.pos.z) / 20) : 0);
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
        const dmin = Math.min(...up.map((b) => Math.abs(cx - (b.pos.x + b.reachX))));
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
        const xa = up[i].pos.x + up[i].reachX;
        const xb = up[i + 1].pos.x + up[i + 1].reachX;
        const gap = xb - xa - 2 * CONTACT.blockHalfWidth;
        const gx = (xa + xb) / 2;
        if (gap < 0.3 || Math.abs(gx - hitX) > 2.5) continue;
        // extend the line from the contact through the seam to a deep spot on their court
        const dz = Math.abs(a.pos.z);
        const k = (dz + 6.5) / Math.max(0.3, dz);
        const tx = hitX + (gx - hitX) * k;
        if (Math.abs(tx) < hw - 0.3) options.push({ x: tx, z: opp * 6.5, w: 1.1, name: 'seam' });
      }
    }
    // a closed block in front: wipe it off the outside hand, or roll it over into the court. Off a
    // bad pass (a high ball into a full block) the hitter uses the block every time it is up
    const covered = options.every((o) => o.w < 0.2);
    if (!green && (covered || !sees) && up.length && !this.lane.quick) {
      const outer = up.reduce((p, q) => (Math.abs(blockHands(q).x) > Math.abs(blockHands(p).x) ? q : p));
      const hx = blockHands(outer).x;
      const out = Math.sign(hx || 1);
      // through the outer edge of the outside hand, on to a spot just out past their sideline
      const edge = hx + out * CONTACT.blockHalfWidth * 0.85;
      const dz = Math.abs(a.pos.z);
      const tx = hitX + (edge - hitX) * ((dz + 6) / Math.max(0.3, dz));
      options.push({ x: tx, z: opp * 6, w: AI.toolShot, name: 'tool' });
      options.push({ x: hitX * 0.3, z: opp * 5.2, w: AI.rollShot, name: 'roll' });
      // or play it softly off the hands of the inside blocker, for our cover to pick up and go again
      const inner = up.reduce((p, q) => (Math.abs(blockHands(q).x) < Math.abs(blockHands(p).x) ? q : p));
      const ix = blockHands(inner).x;
      options.push({ x: ix, z: opp * 0.2, w: AI.recycleShot, name: 'recycle' });
    }
    const total = options.reduce((s, o) => s + o.w, 0);
    let r = g.rng.next() * total;
    for (const o of options) {
      r -= o.w;
      if (r <= 0) {
        this.lastShot = o.name;
        // (a push at the hands is aimed finely, just behind the net)
        const n = o.name === 'recycle' ? 0.1 : 0.4;
        const x = o.x + g.rng.gauss() * n;
        const z = o.z + g.rng.gauss() * n * (o.name === 'recycle' ? 0 : 1);
        // off a green set the hitter takes a controlled swing: the shot stays inside the lines
        if (green) return new THREE.Vector3(clamp(x, -hw + 0.3, hw - 0.3), 0, opp * clamp(Math.abs(z), 1.5, COURT.halfLength - 0.5));
        return new THREE.Vector3(x, 0, z);
      }
    }
    return new THREE.Vector3(crossX, 0, opp * 6.5);
  }
}
