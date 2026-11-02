import * as THREE from 'three';
import { yawFromDir } from '../../core/mathx';
import type { PositionId } from '../../config';
import { solveApex } from '../../physics/solve';
import { HitterBrain } from '../../ai/hitter';
import { ServerBrain } from '../../ai/server';
import { SetterBrain } from '../../ai/setter';
import { Athlete } from '../athlete';
import type { ContactEvent } from '../contact';
import type { Outcome } from '../judge';
import { attackHeight, laneFor, SETTER_SPOT, SETTER_TARGET } from '../plays';
import { kbd, makeFloorRing, Mode } from './mode';
import type { Game } from '../game';

/** where the user receives from, by position */
const RECEIVE_SPOT: Record<PositionId, { x: number; z: number }> = {
  OH: { x: -2.4, z: 6.4 },
  L: { x: 0, z: 6.6 },
  OPP: { x: 2.4, z: 6.4 },
  MB: { x: -0.8, z: 5.6 },
  S: { x: 1.6, z: 6.2 },
};

type Phase = 'intro' | 'feed' | 'live' | 'result';

/** 0-3 pass rating from where the ball will come down near the setter */
export function ratePass(g: Game, side: 1 | -1): { rating: number; dist: number; over: boolean } {
  const pred = g.ball.ensurePrediction(g.env, g.simTime);
  const t = pred.descendThrough(2.35, g.simTime);
  const target = { x: SETTER_TARGET.x * side, z: SETTER_TARGET.z * side };
  if (pred.netCrossT > 0 && (t < 0 || pred.netCrossT < t)) return { rating: 0, dist: 99, over: true };
  if (t < 0) return { rating: 0, dist: 99, over: false };
  const p = { x: 0, y: 0, z: 0 };
  pred.posAt(t, p);
  const dist = Math.hypot(p.x - target.x, p.z - target.z);
  const playable = Math.abs(p.x) < 5.5 && p.z * side > -0.2 && p.z * side < 9.5;
  const rating = dist <= 0.9 ? 3 : dist <= 1.9 ? 2 : playable ? 1 : 0;
  return { rating, dist, over: false };
}

/**
 * Serve receive / dig: alternating float serves and attacks from the far
 * side; pass (E) to the setter target. Passes are rated 0-3 like real stats,
 * and your setter + outside hitter finish good passes.
 */
export class ReceiveDrill extends Mode {
  readonly id = 'receive' as const;
  private server!: Athlete;
  private serverBrain!: ServerBrain;
  private oppSetter!: Athlete;
  private oppHitter!: Athlete;
  private oppHitterBrain!: HitterBrain;
  private coach!: Athlete;
  private setter!: Athlete;
  private hitter!: Athlete;
  private phase: Phase = 'intro';
  private t = 0;
  private kind: 'serve' | 'attack' = 'serve';
  private passed: { rating: number; grade: string } | null = null;
  private targetRing!: THREE.Mesh;
  private targetHalo!: THREE.Mesh;
  private tossed = false;
  private attackTarget = new THREE.Vector3();

  setup(): void {
    const g = this.g;
    const spot = RECEIVE_SPOT[this.position];
    g.placeUser(spot.x, spot.z, 0);
    // far side: server, setter, hitter, coach
    this.server = this.spawn('OPP', -1, 0, -10, 31);
    this.serverBrain = new ServerBrain(this.server);
    g.setBrain(this.server, this.serverBrain);
    this.oppSetter = this.spawn('S', -1, -SETTER_SPOT.x, -SETTER_SPOT.z, 32);
    const osb = new SetterBrain(this.oppSetter, { x: -SETTER_SPOT.x, z: -SETTER_SPOT.z }, -Math.PI / 2);
    osb.shouldPlay = () => this.kind === 'attack' && this.g.ball.lastTouch?.kind === 'feed';
    osb.call = () => {
      const lane = laneFor('OH', -1);
      const y = attackHeight(this.oppHitter);
      return { target: { x: lane.x, y, z: lane.z }, apex: y + lane.apexAbove, hitter: this.oppHitter };
    };
    g.setBrain(this.oppSetter, osb);
    this.oppHitter = this.spawn('OH', -1, laneFor('OH', -1).sx, laneFor('OH', -1).sz, 33);
    this.oppHitterBrain = new HitterBrain(this.oppHitter, laneFor('OH', -1));
    this.oppHitterBrain.isMySet = () => this.g.ball.lastTouch?.kind === 'set' && this.g.ball.lastTouch.side === -1;
    this.oppHitterBrain.tipChance = 0.05;
    this.oppHitterBrain.chooseAim = () => {
      // attack at you (dig drill): within ~1.5 m
      const me = this.g.me;
      this.attackTarget.set(me.pos.x + this.g.rng.gauss() * 0.9, 0, me.pos.z + this.g.rng.gauss() * 0.8);
      return this.attackTarget.clone();
    };
    this.oppHitterBrain.skill = 0.85;
    g.setBrain(this.oppHitter, this.oppHitterBrain);
    this.coach = this.spawn('MB', -1, -3.2, -6.8, 5, 'coach');
    this.coach.airIntent = 'neutral';
    // our side: setter + outside hitter to finish good passes
    this.setter = this.spawn('S', 1, SETTER_SPOT.x, SETTER_SPOT.z, 34);
    this.setter.yaw = Math.PI / 2;
    const sb = new SetterBrain(this.setter, SETTER_SPOT, Math.PI / 2);
    sb.shouldPlay = () => {
      const lt = this.g.ball.lastTouch;
      return !!lt && lt.athlete === this.g.me && (lt.kind === 'pass' || lt.kind === 'dig') && (this.passed?.rating ?? 0) >= 1;
    };
    sb.call = () => {
      const lane = laneFor('OH', 1);
      const y = attackHeight(this.hitter);
      return { target: { x: lane.x, y, z: lane.z }, apex: y + lane.apexAbove, hitter: this.hitter };
    };
    g.setBrain(this.setter, sb);
    if (this.position !== 'OH') {
      this.hitter = this.spawn('OH', 1, laneFor('OH', 1).sx, laneFor('OH', 1).sz, 35);
    } else {
      this.hitter = this.spawn('OPP', 1, laneFor('OPP', 1).sx, laneFor('OPP', 1).sz, 35);
    }
    const hb = new HitterBrain(this.hitter, laneFor(this.hitter.role === 'OH' ? 'OH' : 'OPP', 1));
    hb.isMySet = () => this.g.ball.lastTouch?.kind === 'set' && this.g.ball.lastTouch.side === 1;
    if (this.hitter.role === 'OPP') {
      sb.call = () => {
        const lane = laneFor('OPP', 1);
        const y = attackHeight(this.hitter);
        return { target: { x: lane.x, y, z: lane.z }, apex: y + lane.apexAbove, hitter: this.hitter };
      };
    }
    g.setBrain(this.hitter, hb);

    // setter target marker
    this.targetRing = makeFloorRing(0x7dff9b, 1.8);
    this.targetRing.position.set(SETTER_TARGET.x, 0.011, SETTER_TARGET.z);
    this.add(this.targetRing);
    this.targetHalo = new THREE.Mesh(
      new THREE.TorusGeometry(0.45, 0.025, 8, 40),
      new THREE.MeshBasicMaterial({ color: new THREE.Color(0.5, 1.4, 0.7), transparent: true, opacity: 0.55 }),
    );
    this.targetHalo.position.set(SETTER_TARGET.x, 2.35, SETTER_TARGET.z);
    this.targetHalo.rotation.x = Math.PI / 2;
    this.add(this.targetHalo);
    g.hud.setTitle('Serve Receive / Dig');
    this.updateScore();
    g.hud.message('Get behind the ball · press E early to form the platform', 3);
    this.toPhase('intro');
  }

  private spawn(role: PositionId, side: 1 | -1, x: number, z: number, seed: number, kit: 'team' | 'coach' = 'team'): Athlete {
    const a = new Athlete(role, side);
    a.place(x, z, side === 1 ? 0 : Math.PI);
    this.g.addAthlete(a, seed, kit);
    this.spawned.push(a);
    return a;
  }

  passTarget(a: Athlete) {
    const s = a.side;
    return { x: SETTER_TARGET.x * s, y: 2.35, z: SETTER_TARGET.z * s, apex: 4.0 };
  }

  canServe(a: Athlete): boolean {
    return a === this.server && this.phase === 'live' && this.kind === 'serve' && (!this.g.ball.active || this.g.ball.state.rest || this.g.ball.lastTouch?.athlete === a);
  }

  hint(): string {
    return `${kbd('WASD')} get behind the ball · ${kbd('E')} pass / dig (press early, hold) · ${kbd('V')} camera · ${kbd('R')} reset`;
  }

  private updateScore(): void {
    this.g.hud.setScore(`${this.score} pts · rep ${this.reps}${this.reps ? ` · avg ${(this.ratingSum / this.reps).toFixed(2)}` : ''}`);
  }
  private ratingSum = 0;

  restartRep(): void {
    this.nextRep();
  }

  step(dt: number): void {
    const g = this.g;
    this.t += dt;
    this.targetHalo.rotation.z += dt * 1.2;
    switch (this.phase) {
      case 'intro':
        if (this.t > 1.2) this.toPhase('feed');
        break;
      case 'feed':
        if (g.userReturning) break;
        this.kind = this.reps % 3 === 2 ? 'attack' : 'serve';
        this.passed = null;
        this.toPhase('live');
        if (this.kind === 'serve') {
          const me = g.me;
          const tgt = new THREE.Vector3(me.pos.x + g.rng.gauss() * 1.0, 0, me.pos.z + g.rng.gauss() * 0.9);
          this.serverBrain.serve(tgt, g.rng.range(-3, 3));
          g.hud.message('Serve!', 1);
        } else g.hud.message('Attack: dig it!', 1);
        break;
      case 'live':
        if (this.kind === 'attack' && !this.tossed && this.t > 0.6) {
          this.tossed = true;
          this.coach.startAction('toss', g.simTime);
          const from = { x: this.coach.pos.x + 0.1, y: 1.35, z: this.coach.pos.z + 0.3 };
          const v = { x: 0, y: 0, z: 0 };
          solveApex(from, { x: -SETTER_TARGET.x, y: 2.1, z: -SETTER_TARGET.z }, SETTER_TARGET.height + 0.4, { x: 0, y: 0, z: 0 }, v);
          g.ball.launch(from, v, { x: 3, y: 0, z: 0 }, 0, g.simTime);
          g.ball.lastTouch = { athlete: this.coach, kind: 'feed', t: g.simTime, side: -1 };
        }
        if (this.coach.action?.kind === 'toss' && g.simTime - this.coach.action.t0 > 0.4) this.coach.endAction();
        if (this.t > 11 || (g.ball.state.rest && this.t > 2)) this.finish(null);
        break;
      case 'result':
        if (this.t > 2.4) this.nextRep();
        break;
    }
    this.coach.cmd.faceYaw = yawFromDir(-SETTER_TARGET.x - this.coach.pos.x, -SETTER_TARGET.z - this.coach.pos.z);
  }

  onContact(ev: ContactEvent): void {
    const g = this.g;
    if (ev.athlete === g.me && (ev.kind === 'pass' || ev.kind === 'dig')) {
      const r = ratePass(g, 1);
      this.passed = { rating: r.rating, grade: ev.grade ?? '' };
      const label = r.over ? 'OVERPASS' : `${r.rating}-PASS`;
      g.hud.showBanner(`${label}${r.rating === 3 ? ' · PERFECT TO TARGET' : ''}`, r.rating >= 2 ? 'good' : r.rating === 1 ? 'neutral' : 'bad');
      g.crowd(r.rating >= 2 ? 0.35 : 0.05);
    }
  }

  onOutcome(o: Outcome): void {
    if (this.phase !== 'live') return;
    const lt = this.g.ball.lastTouch;
    // the rally ends: either our attack finished, or the ball got through
    if (this.passed || (lt && lt.side === -1) || o.side === 1) this.finish(o);
  }

  private finish(_o: Outcome | null): void {
    const g = this.g;
    if (this.phase === 'result') return;
    this.toPhase('result');
    this.reps++;
    const p = this.passed;
    const rating = p ? p.rating : 0;
    this.ratingSum += rating;
    const pts = [0, 20, 60, 100][rating];
    this.score += pts;
    this.bumpStreak(rating >= 2);
    if (!p) g.hud.showBanner(this.kind === 'serve' ? 'ACE' : 'NO DIG', 'bad');
    else g.hud.message(`+${pts}`, 1.2);
    this.updateScore();
  }

  private nextRep(): void {
    const g = this.g;
    g.judge.disarm();
    g.ball.hide();
    this.tossed = false;
    this.serverBrain.phase = 'idle';
    this.server.endAction();
    this.server.place(0, -10, Math.PI);
    this.oppHitterBrain.reset();
    this.oppHitter.place(laneFor('OH', -1).sx, laneFor('OH', -1).sz, Math.PI);
    this.oppSetter.place(-SETTER_SPOT.x, -SETTER_SPOT.z, -Math.PI / 2);
    this.setter.place(SETTER_SPOT.x, SETTER_SPOT.z, Math.PI / 2);
    const hb = g.brains.get(this.hitter) as HitterBrain | undefined;
    hb?.reset();
    const lane = laneFor(this.hitter.role === 'OH' ? 'OH' : 'OPP', 1);
    this.hitter.place(lane.sx, lane.sz, 0);
    const spot = RECEIVE_SPOT[this.position];
    const me = g.me;
    if (Math.hypot(me.pos.x - spot.x, me.pos.z - spot.z) > 1.2) g.returnUser(spot.x, spot.z, 0);
    this.toPhase('feed');
  }

  private toPhase(p: Phase): void {
    this.phase = p;
    this.t = 0;
  }
}
