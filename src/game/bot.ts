import * as THREE from 'three';
import { BALL, PLAYER, SIM, TIMING } from '../config';
import { Athlete } from './athlete';
import { AIM_DEPTH, aimPitchFor, aimPitchRange, ContactSystem } from './contact';
import { clamp, yawFromDir } from '../core/mathx';
import type { V3 } from '../physics/ball';
import type { Game } from './game';
import { planApproach, planQuick, type ApproachPlan } from '../ai/approach';
import { quickSpot, setterTouchY } from './plays';
import type { TeamAI } from '../ai/team';

/**
 * What the autopilots read from the current drill, when it has it: the Mini Rally's team
 * coordinator, the spike drill's target zone and its early (fast-set) approach plan, the
 * setter drill's options. Drills do not implement this on purpose (the bots are test and
 * attract-mode tooling), so every field is optional.
 */
interface DrillView {
  home?: Pick<TeamAI, 'setFor' | 'receiver' | 'touches' | 'passToSetter'>;
  zone?: { x0: number; x1: number; z0: number; z1: number };
  earlyPlan?: ApproachPlan | null;
  earlyFor?: unknown;
  setOptions?(a: Athlete): { target: V3 }[];
  canServe?(a: Athlete): boolean;
}
const drillView = (g: Game): DrillView | null => g.mode as unknown as DrillView | null;

export const BOT_QUALITIES = ['perfect', 'good', 'sloppy', 'tip'] as const;
export type BotQuality = (typeof BOT_QUALITIES)[number];
export const isBotQuality = (v: unknown): v is BotQuality => BOT_QUALITIES.includes(v as BotQuality);

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
  private holding = false;
  private recorded = false;
  private b: V3 = { x: 0, y: 0, z: 0 };
  private offset = 0;
  clicks: { err: number; grade: string | null }[] = [];
  /** movement this frame (applied after the keyboard mapping) */
  private mx = 0;
  private mz = 0;
  private sprint = false;

  constructor(
    private g: Game,
    private quality: BotQuality = 'perfect',
  ) {}

  private release(): void {
    const inp = this.g.input;
    for (const k of ['Space', 'KeyW', 'ShiftLeft']) inp.up(k);
    // planting or in the air with no ball to hit (a decoy): keep holding; landing drops the wind-up
    const st = this.g.me.state;
    if (st === 'ground' || st === 'land') inp.up('Mouse0');
  }
  private committed = false;

  step(_dt: number): void {
    const g = this.g;
    const me = g.me;
    const ball = g.ball;
    const now = g.simTime;
    const lt = ball.lastTouch;
    // a set from the setter, or (setter's attack on two) the coach's pass
    const drill = drillView(g);
    const team = drill?.home;
    // a middle goes on the pass (the drill's toss, or a team-mate's pass to our setter)
    const quickCue =
      me.role === 'MB' &&
      ball.active &&
      lt &&
      lt.athlete !== me &&
      lt.side === me.side &&
      (lt.kind === 'feed' || (!!team && (lt.kind === 'pass' || lt.kind === 'dig') && !!team.passToSetter(g)));
    // the spike drill plans fast sets (quicks, go balls) from the pass: follow that plan
    const drillEarly = !!drill?.earlyPlan && lt?.kind === 'feed' && drill.earlyFor === lt;
    const setForMe =
      quickCue ||
      drillEarly ||
      (ball.active &&
        lt &&
        lt.athlete !== me &&
        lt.side === me.side &&
        (lt.kind === 'set' || (lt.kind === 'feed' && me.role === 'S')) &&
        (!team || team.setFor === me));
    // a run started before the set (a quick) is seen through to the landing: the "pass to the
    // setter" read can drop out in the last frames before the touch, and resetting there would
    // let go of the plant and the wind-up mid-run
    const committed =
      this.committed && (this.phase === 'approach' || this.phase === 'load' || (this.phase === 'air' && me.state !== 'ground'));
    if (!setForMe && !committed && (this.phase !== 'air' || me.state === 'ground')) {
      if (this.phase !== 'wait') this.release();
      this.phase = 'wait';
      this.plan = null;
      this.committed = false;
      // let go of the attack button only on the floor (in the plant or the air it would swing)
      if ((me.state === 'ground' || me.state === 'land') && g.input.isDown('Mouse0')) g.input.up('Mouse0');
      this.holding = false;
      this.mx = this.mz = 0;
      this.sprint = false;
      g.rig.yaw = 0;
      g.rig.pitch = g.rig.mode === 'fp' ? 0.25 : -0.3;
      return;
    }
    if (this.phase === 'wait' && setForMe) {
      this.makePlan();
      this.committed = this.phase !== 'wait' && (quickCue || drillEarly);
    }
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
        // start the wind-up on the plant: a late takeoff then still has a real swing (not a tap)
        if (this.quality !== 'tip' && !this.holding) {
          g.input.down('Mouse0');
          this.holding = true;
        }
        if (now - this.pressAt >= plan.hold) {
          g.input.up('Space');
          this.phase = 'air';
        }
        break;
      }
      case 'air': {
        this.mx = this.mz = 0;
        // invert the aim mapping (see aimTargetFromLook): depth into their court
        const [lo, hi] = aimPitchRange(g.rig.mode === 'fp');
        const t = clamp((Math.abs(plan.aim.z) - AIM_DEPTH[0]) / (AIM_DEPTH[1] - AIM_DEPTH[0]), 0, 1);
        g.rig.pitch = lo + (hi - lo) * t;
        g.rig.yaw = aimYaw;
        // hold the attack button from early in the jump (wind-up), release on the timing
        // (a tip is a short tap at the same moment)
        const tip = this.quality === 'tip';
        if (!tip && !this.holding && this.clickAt < 0 && me.state === 'air') {
          g.input.down('Mouse0');
          this.holding = true;
        }
        // on quicks we are up before the set: read the ball once it leaves the setter's hands
        // (only a set meant for us: a decoy jump just lands)
        const mine = (lt?.kind === 'set' && (!team || team.setFor === me)) || (me.role === 'S' && lt?.kind === 'feed');
        if (this.clickAt < 0 && mine) {
          const info = g.contact.ideal(me, now, 0.9);
          if (info) {
            const w = me.action?.kind === 'windup' ? me.action : null;
            const fire = info.t - ContactSystem.swingLead(w ? ContactSystem.chargeFor(now - w.t0) : 0) + this.offset;
            if (tip && !this.holding && now >= fire - 0.05 - 1e-4) {
              g.input.down('Mouse0');
              this.holding = true;
            }
            if (now >= fire - 1e-4) {
              g.input.up('Mouse0');
              this.holding = false;
              this.clickAt = now;
            }
          }
        } else if (this.clickAt >= 0 && !this.recorded) {
          const act = me.action?.kind === 'swing' ? me.action : me.lastAction;
          if (act && act.kind === 'swing' && act.resolved) {
            this.clicks.push({ err: act.err, grade: act.grade });
            this.recorded = true;
          }
        }
        if (me.state === 'land' || me.state === 'ground') {
          if (this.clickAt >= 0 && this.recorded) this.phase = 'done';
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
    a.copyBody(me);
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
    const drill = drillView(g);
    const zone = drill?.zone;
    if (zone && typeof zone.x0 === 'number' && typeof zone.z0 === 'number') aim.set((zone.x0 + zone.x1) / 2, 0, (zone.z0 + zone.z1) / 2);
    let best: { tStart: number; tPress: number; tc: number; contact: THREE.Vector3; dir: THREE.Vector3 } | null = null;
    const early: ApproachPlan | null = drill?.earlyPlan && drill.earlyFor === g.ball.lastTouch ? drill.earlyPlan : null;
    const quick = !early && me.role === 'MB' && g.ball.lastTouch?.kind !== 'set';
    if (early) {
      this.aimYawGuess = 0;
      best = { tStart: early.tStart, tPress: early.tPress, tc: early.tc, contact: early.contact, dir: early.dir };
    } else if (quick) {
      // middle quick: leave the floor as the setter touches the pass
      const team = drill?.home;
      let tSet = -1;
      let sx = 0;
      if (team) {
        const ps = team.passToSetter(g);
        if (ps) {
          tSet = ps.t;
          sx = ps.x;
        }
      } else {
        tSet = pred.descendThrough(setterTouchY(null), now);
        pred.posAt(tSet, this.b);
        sx = this.b.x;
      }
      if (tSet < 0) return;
      this.aimYawGuess = 0;
      const p = planQuick(me, now, quickSpot(sx, me.side), tSet, 0, 0, hold);
      if (p) best = { tStart: p.tStart, tPress: p.tPress, tc: p.tc, contact: p.contact, dir: p.dir };
    }
    for (let iter = 0; iter < 3 && !quick && !early; iter++) {
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
      for (let i = 0; i < 14; i++) {
        const mid = (lo + hi) / 2;
        const m = this.simulate(mid, tPress, hold, dir, tc);
        const along = (m.x - me.pos.x) * dir.x + (m.z - me.pos.z) * dir.z;
        if (along > total) lo = mid;
        else hi = mid;
      }
      const r = this.simulate(lo, tPress, hold, dir, tc);
      best = { tStart: lo, tPress, tc, contact, dir };
      if (Math.abs(r.jumpH - H) < 0.01) break;
      H = r.jumpH;
    }
    if (!best) return;
    this.plan = { tc: best.tc, tPress: best.tPress, tStart: best.tStart, dir: best.dir, hold, contact: best.contact, aim };
    this.phase = 'approach';
    this.clickAt = -1;
    this.holding = false;
    this.recorded = false;
    const q = this.quality;
    const rnd = g.rng.next() * 2 - 1;
    this.offset = q === 'perfect' ? 0 : q === 'good' ? rnd * 0.05 : rnd * 0.13;
  }
}

/**
 * Block-drill autopilot: reads the set, shuffles along the net, raises the
 * hands (RMB) and presses Space so the block peaks as the ball crosses.
 */
export class BlockBot {
  private jumped = false;
  private mx = 0;
  private b: V3 = { x: 0, y: 0, z: 0 };
  private offset = 0;
  results: string[] = [];

  constructor(
    private g: Game,
    private quality: BotQuality = 'perfect',
  ) {}

  step(_dt: number): void {
    const g = this.g;
    const me = g.me;
    const ball = g.ball;
    const now = g.simTime;
    const lt = ball.lastTouch;
    const theirSet = ball.active && lt && lt.side !== me.side && lt.kind === 'set';
    g.rig.yaw = 0;
    g.rig.pitch = g.rig.mode === 'fp' ? 0.1 : -0.15;
    this.mx = 0;
    // commit block: their middle leaving the floor in front of us before the set is a quick
    // (too fast to read off the setter's hands), so go up with them
    if (!theirSet && ball.active && lt && lt.side !== me.side && lt.kind !== 'spike' && !this.jumped && me.state === 'ground') {
      const mb = g.athletes.find((a) => a.side !== me.side && a.role === 'MB' && a.state === 'air' && a.vel.y > 0);
      if (mb && Math.abs(mb.pos.x - me.pos.x) < 1.3) {
        g.input.down('Mouse2');
        g.input.down('Space');
        this.jumped = true;
        return;
      }
    }
    if (this.jumped && me.state === 'load') g.input.up('Space');
    if (!theirSet) {
      if (me.state === 'ground' && !(this.jumped && ball.active && lt && lt.side !== me.side)) {
        g.input.up('Mouse2');
        g.input.up('Space');
        this.jumped = false;
      }
      return;
    }
    const pred = ball.ensurePrediction(g.env, now);
    const tc = pred.descendThrough(3.25, now);
    if (tc < 0) return;
    pred.posAt(tc, this.b);
    const tx = this.b.x + Math.sign(this.b.x) * 0.2;
    const dx = tx - me.pos.x;
    if (Math.abs(dx) > 0.08 && me.state === 'ground') this.mx = Math.sign(dx) * Math.min(1, Math.abs(dx) / 0.4);
    if (!this.jumped) {
      if (this.offset === 0 && this.quality !== 'perfect') this.offset = (g.rng.next() * 2 - 1) * (this.quality === 'good' ? 0.06 : 0.16);
      // standing block jump: load min + rise to peak
      const H = me.jumpMax * me.stats.standingJumpFrac;
      const vy = Math.sqrt(2 * BALL.gravity * H);
      const tUp = (vy - PLAYER.apexBand) / BALL.gravity + PLAYER.apexBand / (BALL.gravity * PLAYER.apexGravityScale);
      const tJump = tc + 0.1 - tUp - PLAYER.loadMin + this.offset;
      if (now >= tJump - 0.25) g.input.down('Mouse2');
      if (now >= tJump) {
        g.input.down('Space');
        this.jumped = true;
      }
    } else {
      g.input.up('Space');
    }
  }

  after(): void {
    const me = this.g.me;
    me.cmd.moveX = this.mx;
    me.cmd.moveZ = 0;
    me.cmd.sprint = false;
  }
}

/**
 * Pass / set autopilot: moves so the platform (or hands) meets the ball's
 * predicted path and presses E / RMB the ideal lead time before arrival.
 */
export class TouchBot {
  private mx = 0;
  private mz = 0;
  private pressed = false;
  private b: V3 = { x: 0, y: 0, z: 0 };
  private offset = 0;
  /** setter: which option to aim at (cycles) */
  private pick = 0;

  constructor(
    private g: Game,
    private kind: 'pass' | 'set',
    private quality: BotQuality = 'perfect',
  ) {}

  step(_dt: number): void {
    const g = this.g;
    const me = g.me;
    const ball = g.ball;
    const now = g.simTime;
    const lt = ball.lastTouch;
    this.mx = this.mz = 0;
    const key = this.kind === 'pass' ? 'KeyE' : 'Mouse2';
    const team = drillView(g)?.home;
    const incoming =
      ball.active &&
      !ball.state.rest &&
      lt &&
      lt.athlete !== me &&
      (this.kind === 'pass' ? lt.side !== me.side || lt.kind === 'feed' : lt.side === me.side) &&
      (!team || (this.kind === 'pass' ? team.receiver === me : team.touches === 1));
    if (!incoming) {
      if (this.pressed) g.input.up(key);
      this.pressed = false;
      this.offset = 0;
      return;
    }
    const pred = ball.ensurePrediction(g.env, now);
    let yaw = 0;
    if (this.kind === 'set') {
      const opts = drillView(g)?.setOptions?.(me);
      if (opts && opts.length) {
        const o = opts[this.pick % opts.length].target;
        yaw = yawFromDir(o.x - me.pos.x, o.z - me.pos.z);
      } else yaw = Math.PI / 2;
    }
    g.rig.yaw = yaw;
    g.rig.pitch = this.kind === 'set' ? 0.3 : -0.1;
    const fx = -Math.sin(yaw);
    const fz = -Math.cos(yaw);
    const h = this.kind === 'pass' ? me.height * 0.34 + 0.05 : me.height + 0.17;
    const fwd = this.kind === 'pass' ? 0.45 : 0.14;
    const tArr = pred.descendThrough(h, now);
    if (tArr < 0) return;
    pred.posAt(tArr, this.b);
    const sx = this.b.x - fx * fwd;
    const sz = this.b.z - fz * fwd;
    const dx = sx - me.pos.x;
    const dz = sz - me.pos.z;
    const d = Math.hypot(dx, dz);
    if (d > 0.05 && !this.pressed) {
      const m = Math.min(1, d / 0.5);
      this.mx = (dx / d) * m;
      this.mz = (dz / d) * m;
    }
    if (this.offset === 0 && this.quality !== 'perfect') this.offset = (g.rng.next() * 2 - 1) * (this.quality === 'good' ? 0.08 : 0.25);
    const spd = ball.speed();
    const fast = Math.min(1, Math.max(0, (spd - 12) / 10));
    const lead = this.kind === 'pass' ? TIMING.passLead + (TIMING.digLead - TIMING.passLead) * fast : TIMING.setLead;
    if (!this.pressed && now >= tArr - lead + this.offset) {
      g.input.down(key);
      this.pressed = true;
      this.pick++;
    }
  }

  after(): void {
    const me = this.g.me;
    me.cmd.moveX = this.mx;
    me.cmd.moveZ = this.mz;
    me.cmd.sprint = Math.hypot(this.mx, this.mz) > 0.9;
  }
}

/** where the serve autopilot aims, in turn: deep to zone 5, deep to zone 1, the middle of the court */
const SERVE_AIMS: readonly { x: number; z: number }[] = [
  { x: -3, z: -7.3 },
  { x: 3, z: -7.3 },
  { x: 0, z: -6.5 },
];

/**
 * Serve-drill autopilot: tosses (Q) the serve the drill has picked, and for a jump float or a jump
 * serve runs in under the toss and jumps (Space), then holds and releases the attack button so
 * the hand meets the ball as it comes down. Every button goes through Input, as a player's do.
 */
export class ServeBot {
  private phase: 'wait' | 'toss' | 'approach' | 'load' | 'air' | 'done' = 'wait';
  private t = 0;
  private plan: ApproachPlan | null = null;
  private pressAt = 0;
  private holding = false;
  private fired = false;
  private offset = 0;
  private served = 0;
  private aim = SERVE_AIMS[0];
  private mx = 0;
  private mz = 0;
  private sprint = false;

  constructor(
    private g: Game,
    private quality: BotQuality = 'perfect',
  ) {}

  private to(phase: ServeBot['phase']): void {
    this.phase = phase;
    this.t = 0;
  }

  /** look where the serve is aimed, from `from` (the feet, or the ball once the arm is swinging) */
  private look(from: { x: number; z: number }): void {
    const g = this.g;
    g.rig.pitch = aimPitchFor(Math.abs(this.aim.z), g.rig.mode === 'fp');
    g.rig.yaw = yawFromDir(this.aim.x - from.x, this.aim.z - from.z);
  }

  /** wind up as the ball comes into reach and release so the hand meets it; true once released */
  private swing(): boolean {
    const g = this.g;
    const me = g.me;
    const now = g.simTime;
    const info = g.contact.ideal(me, now, 0.9);
    if (!info) return false;
    this.look(me.pos);
    // a full wind-up, started in time for it
    if (!this.holding && info.t - now < TIMING.chargeFull + 0.15) {
      g.input.down('Mouse0');
      this.holding = true;
    }
    const w = me.action?.kind === 'windup' ? me.action : null;
    const fire = info.t - ContactSystem.swingLead(w ? ContactSystem.chargeFor(now - w.t0) : 0) + this.offset;
    if (this.holding && now >= fire - 1e-4) {
      g.input.up('Mouse0');
      this.holding = false;
      return true;
    }
    return false;
  }

  step(dt: number): void {
    const g = this.g;
    const me = g.me;
    const now = g.simTime;
    const inp = g.input;
    this.t += dt;
    this.mx = this.mz = 0;
    this.sprint = false;
    const standing = g.serveKind === 'float';
    switch (this.phase) {
      case 'wait': {
        // behind the end line, standing still, with the ball in hand
        if (!drillView(g)?.canServe?.(me) || me.state !== 'ground' || me.speed > 0.2) {
          this.t = 0;
          break;
        }
        this.aim = SERVE_AIMS[this.served % SERVE_AIMS.length];
        // a standing serve is tossed the way it will be hit; a run-up goes straight in and aims in the air
        if (standing) this.look(me.pos);
        else g.rig.yaw = 0;
        if (this.t > 0.5) {
          inp.down('KeyQ');
          const q = this.quality;
          const rnd = g.rng.next() * 2 - 1;
          this.offset = q === 'perfect' ? 0 : q === 'good' ? rnd * 0.05 : rnd * 0.13;
          this.fired = false;
          this.plan = null;
          this.to('toss');
        }
        break;
      }
      case 'toss': {
        inp.up('KeyQ');
        if (g.contact.serving !== me) {
          // the toss was not taken (or has come down): start again
          if (this.t > 0.3) this.to('done');
          break;
        }
        if (standing) {
          if (this.swing()) {
            this.fired = true;
            this.to('done');
          }
          break;
        }
        this.plan = planApproach(me, g.ball.ensurePrediction(g.env, now), now, 0, 0);
        if (this.plan) this.to('approach');
        break;
      }
      case 'approach': {
        const plan = this.plan!;
        g.rig.yaw = 0;
        if (now >= plan.tStart - 1e-6) {
          this.mx = plan.dir.x;
          this.mz = plan.dir.z;
          this.sprint = true;
        }
        if (now >= plan.tPress - 1e-3) {
          inp.down('Space');
          this.pressAt = now;
          this.to('load');
        }
        break;
      }
      case 'load':
        // the wind-up starts on the plant, as for a spike
        if (!this.holding) {
          inp.down('Mouse0');
          this.holding = true;
        }
        if (now - this.pressAt >= this.plan!.hold) {
          inp.up('Space');
          this.to('air');
        }
        break;
      case 'air':
        if (!this.fired && me.state === 'air' && this.swing()) this.fired = true;
        if (this.t > 0.2 && (me.state === 'land' || me.state === 'ground')) this.to('done');
        break;
      case 'done':
        for (const k of ['KeyQ', 'Space', 'Mouse0']) inp.up(k);
        this.holding = false;
        if (this.fired) this.served++;
        this.fired = false;
        this.to('wait');
        break;
    }
    // a serve that never came off (a plan the feet could not keep): let go of everything and start again
    if (this.phase !== 'wait' && this.t > 4) this.to('done');
  }

  /** override the keyboard movement mapping */
  after(): void {
    const me = this.g.me;
    me.cmd.moveX = this.mx;
    me.cmd.moveZ = this.mz;
    me.cmd.sprint = this.sprint;
  }
}
