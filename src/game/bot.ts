import * as THREE from 'three';
import { BALL, PLAYER, SIM, TIMING } from '../config';
import { Athlete } from './athlete';
import { clamp, yawFromDir } from '../core/mathx';
import type { V3 } from '../physics/ball';
import type { Game } from './game';

export type BotQuality = 'perfect' | 'good' | 'sloppy' | 'tip';

/**
 * Autopilot for the spike drill. It drives the user's athlete through the
 * same input path as a player for every action (Space plant/jump, mouse
 * swing), and steers movement through the athlete command. Used by the
 * Playwright checks and the attract mode behind the start screen.
 */
export class SpikeBot {
  private phase: 'wait' | 'approach' | 'load' | 'air' | 'done' = 'wait';
  private plan: {
    tc: number;
    tPress: number;
    tStart: number;
    dir: THREE.Vector3;
    hold: number;
    contact: THREE.Vector3;
    aim: THREE.Vector3;
  } | null = null;
  private pressAt = 0;
  private clickAt = -1;
  private releaseAt = -1;
  private b: V3 = { x: 0, y: 0, z: 0 };
  private offset = 0;
  clicks: { err: number; grade: string | null }[] = [];
  /** movement this frame (applied after the keyboard mapping) */
  private mx = 0;
  private mz = 0;
  private sprint = false;

  constructor(private g: Game, private quality: BotQuality = 'perfect') {}

  private release(): void {
    const inp = this.g.input;
    for (const k of ['Space', 'Mouse0', 'KeyW', 'ShiftLeft']) inp.up(k);
  }

  step(_dt: number): void {
    const g = this.g;
    const me = g.me;
    const ball = g.ball;
    const now = g.simTime;
    const lt = ball.lastTouch;
    // a set from the setter, or (setter's attack on two) the coach's pass
    const setForMe = ball.active && lt && lt.athlete !== me && (lt.kind === 'set' || (lt.kind === 'feed' && me.role === 'S'));
    if (!setForMe && this.phase !== 'air') {
      if (this.phase !== 'wait') this.release();
      this.phase = 'wait';
      this.plan = null;
      this.mx = this.mz = 0;
      this.sprint = false;
      g.rig.yaw = 0;
      g.rig.pitch = g.rig.mode === 'fp' ? 0.25 : -0.3;
      return;
    }
    if (this.phase === 'wait' && setForMe) this.makePlan();
    const plan = this.plan;
    if (!plan) return;
    // aim at the drill's target zone
    const aimYaw = yawFromDir(plan.aim.x - plan.contact.x, plan.aim.z - plan.contact.z);
    switch (this.phase) {
      case 'approach': {
        g.rig.yaw = 0;
        // open loop: the plan was found by simulating these exact inputs
        if (now >= plan.tStart - 1e-6) {
          this.mx = plan.dir.x;
          this.mz = plan.dir.z;
          this.sprint = true;
        } else {
          this.mx = this.mz = 0;
          this.sprint = false;
        }
        if (now >= plan.tPress - 1e-3) {
          g.input.down('Space');
          this.pressAt = now;
          this.phase = 'load';
        }
        break;
      }
      case 'load': {
        this.mx = this.mz = 0;
        if (now - this.pressAt >= plan.hold) {
          g.input.up('Space');
          this.phase = 'air';
        }
        break;
      }
      case 'air': {
        this.mx = this.mz = 0;
        const depth = Math.hypot(plan.aim.x - plan.contact.x, plan.aim.z - plan.contact.z);
        // invert the aim mapping (see aimTargetFromLook)
        const fp = g.rig.mode === 'fp';
        const lo = fp ? -0.55 : -0.75;
        const hi = fp ? 0.75 : 0.05;
        const t = clamp((depth - 2.4) / (11.5 - 2.4), 0, 1);
        g.rig.pitch = lo + (hi - lo) * t;
        g.rig.yaw = aimYaw;
        if (this.clickAt < 0) {
          const info = g.contact.ideal(me, now, 0.9);
          if (info) {
            const fire = info.t - TIMING.swingNominal + this.offset;
            if (now >= fire - 1e-4) {
              g.input.down('Mouse0');
              this.clickAt = now;
              this.releaseAt = now + (this.quality === 'tip' ? 0.03 : 0.25);
            }
          }
        } else if (this.releaseAt > 0 && now >= this.releaseAt) {
          g.input.up('Mouse0');
          this.releaseAt = -1;
          const act = me.action ?? me.lastAction;
          this.clicks.push({ err: act ? act.err : 0, grade: act ? act.grade : null });
        }
        if (me.state === 'land' || me.state === 'ground') {
          if (this.clickAt >= 0 && this.releaseAt < 0) this.phase = 'done';
        }
        break;
      }
      case 'done':
        this.mx = this.mz = 0;
        break;
    }
  }

  /** override the keyboard movement mapping */
  after(): void {
    const me = this.g.me;
    me.cmd.moveX = this.mx;
    me.cmd.moveZ = this.mz;
    me.cmd.sprint = this.sprint;
  }

  private sim: Athlete | null = null;
  private aimYawGuess = 0;

  /**
   * Forward-simulate the approach with the athlete's own kinematics: wait
   * until tStart, sprint along dir, plant at tPress (hold), then fly until tc.
   * Returns the feet position and height at tc.
   */
  private simulate(tStart: number, tPress: number, hold: number, dir: THREE.Vector3, tc: number) {
    const g = this.g;
    const me = g.me;
    if (!this.sim || this.sim.role !== me.role) this.sim = new Athlete(me.role, me.side);
    const a = this.sim;
    a.pos.copy(me.pos);
    a.vel.copy(me.vel);
    a.yaw = me.yaw;
    a.state = me.state;
    a.stateT = me.stateT;
    a.action = null;
    a.onStep = a.onLand = a.onTakeoff = null;
    a.airNudge.set(0, 0, 0);
    const dt = 1 / SIM.hz;
    let t = g.simTime;
    let pressed = false;
    let released = false;
    while (t < tc - 1e-9) {
      const running = t >= tStart && !pressed;
      a.cmd.moveX = running ? dir.x : 0;
      a.cmd.moveZ = running ? dir.z : 0;
      a.cmd.sprint = running;
      a.cmd.faceYaw = a.state === 'air' ? this.aimYawGuess : 0;
      if (!pressed && t >= tPress - 1e-9) {
        a.jumpPress();
        pressed = true;
      }
      if (pressed && !released && t >= tPress + hold - 1e-9) {
        a.jumpRelease();
        released = true;
      }
      t += dt;
      a.step(dt, t);
    }
    return { x: a.pos.x, y: a.pos.y, z: a.pos.z, jumpH: a.jumpH, state: a.state };
  }

  private makePlan(): void {
    const g = this.g;
    const me = g.me;
    const pred = g.ball.ensurePrediction(g.env, g.simTime);
    const now = g.simTime;
    const hold = PLAYER.loadMax - 0.02;
    const off = new THREE.Vector3();
    const prevYaw = me.yaw;
    me.yaw = 0;
    me.idealContact(off, new THREE.Vector3(0, 0, 0));
    me.yaw = prevYaw;
    off.y = me.standReach - 0.16;
    let H = me.jumpMax;
    const aim = new THREE.Vector3(2.5, 0, -7);
    const zone = (g.mode as any)?.zone;
    if (zone) aim.set((zone.x0 + zone.x1) / 2, 0, (zone.z0 + zone.z1) / 2);
    let best: { tStart: number; tPress: number; tc: number; contact: THREE.Vector3; dir: THREE.Vector3 } | null = null;
    for (let iter = 0; iter < 3; iter++) {
      const hc = off.y + H * 0.97;
      const tc = pred.descendThrough(hc, now);
      if (tc < 0) return;
      pred.posAt(tc, this.b);
      const contact = new THREE.Vector3(this.b.x, this.b.y, this.b.z);
      this.aimYawGuess = yawFromDir(aim.x - contact.x, aim.z - contact.z);
      const feet = new THREE.Vector3(contact.x - off.x, 0, contact.z - off.z);
      const dir = new THREE.Vector3(feet.x - me.pos.x, 0, feet.z - me.pos.z);
      const total = dir.length();
      dir.normalize();
      // rise time for this jump height (with apex hang)
      const g0 = BALL.gravity;
      const b = PLAYER.apexBand;
      const sc = PLAYER.apexGravityScale;
      const vy = Math.sqrt(Math.max(2 * g0 * H + b * b * (1 - 1 / sc), b * b + 0.01));
      const tUp = (vy - b) / g0 + b / (g0 * sc);
      const tPress = Math.max(now + 0.02, tc - tUp - hold);
      // later start = shorter run: binary search the start time for the right distance
      let lo = now;
      let hi = tPress;
      let r = this.simulate(lo, tPress, hold, dir, tc);
      for (let i = 0; i < 14; i++) {
        const mid = (lo + hi) / 2;
        r = this.simulate(mid, tPress, hold, dir, tc);
        const along = (r.x - me.pos.x) * dir.x + (r.z - me.pos.z) * dir.z;
        if (along > total) lo = mid;
        else hi = mid;
      }
      r = this.simulate(lo, tPress, hold, dir, tc);
      best = { tStart: lo, tPress, tc, contact, dir };
      if (Math.abs(r.jumpH - H) < 0.01) break;
      H = r.jumpH;
    }
    if (!best) return;
    this.plan = { tc: best.tc, tPress: best.tPress, tStart: best.tStart, dir: best.dir, hold, contact: best.contact, aim };
    this.phase = 'approach';
    this.clickAt = -1;
    this.releaseAt = -1;
    const q = this.quality;
    const rnd = g.rng.next() * 2 - 1;
    this.offset = q === 'perfect' ? 0 : q === 'good' ? rnd * 0.05 : rnd * 0.13;
  }
}
