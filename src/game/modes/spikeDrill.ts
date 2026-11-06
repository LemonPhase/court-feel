import * as THREE from 'three';
import { AI, COURT, SCORING, type PositionId } from '../../config';
import { R } from '../../physics/ball';
import { solveApex } from '../../physics/solve';
import { SetterBrain } from '../../ai/setter';
import { Athlete } from '../athlete';
import type { ContactEvent } from '../contact';
import { outcomeLabel, type Outcome } from '../judge';
import {
  attackHeight,
  laneFor,
  needsGoodPass,
  quickSetFor,
  quickSpot,
  SET_PLAYS,
  SETTER_SPOT,
  SETTER_TARGET,
  setterTouchY,
  type AttackLane,
  type SetPlay,
} from '../plays';
import { kbd, makeFloorRing, Mode, ZoneMarker } from './mode';
import { planApproach, planQuick, planToPoint, type ApproachPlan } from '../../ai/approach';
import { BlockerBrain, blockReach } from '../../ai/blocker';
import { blockShadowOnCourt, HANDS_WIDTH, type FloorPoly, type HandSpan } from '../blockShadow';
import { blockPlan, openZone, planSpans, type BlockPlan, type BlockTakes } from '../blockPlan';
import { spikeScript } from '../ranked';

/** block practice: nobody, one blocker fronting your lane, or that blocker plus a middle closing */
export type BlockLevel = 0 | 1 | 2;
const BLOCK_NAMES = ['off', 'single', 'double'] as const;
/** hands at your contact height or above: the shadow's wall is kept this far under the contact (a full-length shadow) */
const WALL_UNDER_CONTACT = 0.1;
/** the open-court canvas: pixels across their court (and down its length) */
const OPEN_RES = 128;
/** the shadow is at most two polygons (one per blocker, or one closed wall) of up to this many corners */
const SHADOW_POLYS = 2;
const SHADOW_CORNERS = 8;

export interface Zone {
  name: string;
  /** only a target when a block is up (the strip a cross-taking block leaves along the line) */
  blockOnly?: boolean;
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
  // against a block that takes the cross, the line is what is left: a strip along the sideline
  { name: 'Line past the block', x0: -4.5, x1: -3.8, z0: -8.5, z1: -4, blockOnly: true },
];

/** target zones for this position: mirrored for right-side attackers; a middle hits zone 1 or 5 */
export function zonesFor(pos: PositionId): Zone[] {
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
  /** opposing block (key B): off / single / double */
  blockLevel: BlockLevel = 0;
  /** the side the block takes away this rep (the target is on the other side) */
  takes: BlockTakes = 'line';
  private blockers: { a: Athlete; brain: BlockerBrain }[] = [];
  /** their floor the block leaves open, in green (a canvas: the court minus the shadow) */
  private openCourt!: THREE.Mesh;
  private openCanvas: HTMLCanvasElement | null = null;
  private openKey = '';
  /** the block's shadow on their floor: where a straight ball from your contact cannot go */
  private shadow!: THREE.Mesh;
  private shadowEdge!: THREE.LineSegments;
  private shadowPos = new Float32Array(SHADOW_POLYS * SHADOW_CORNERS * 3);
  private shadowIdx = new Uint16Array(SHADOW_POLYS * (SHADOW_CORNERS - 2) * 3);
  private shadowEdgePos = new Float32Array(SHADOW_POLYS * SHADOW_CORNERS * 2 * 3);

  private get play(): SetPlay | null {
    return this.plays ? this.plays[this.callIdx] : null;
  }

  /** the lane of the current set call */
  private get lane(): AttackLane {
    return this.play?.lane ?? laneFor(this.position, 1);
  }

  /** B: cycle the opposing block off → single → double */
  cycleBlock(): void {
    this.setBlock(((this.blockLevel + 1) % 3) as BlockLevel);
  }

  setBlock(level: BlockLevel): void {
    this.blockLevel = level;
    this.ensureBlockers();
    this.placeBlockers();
    if (!this.tossed) this.pickZone();
    this.refreshScore();
    const what =
      level === 0
        ? 'Block off'
        : level === 1
          ? 'Block: single · it takes the line or the cross: hit the side it leaves open'
          : 'Block: double · closed on high balls, late on fast sets: find the open side';
    this.g.hud.message(what, 1.8);
  }

  /** spawn the two opposing blockers the first time the block is turned on */
  private ensureBlockers(): void {
    if (this.blockers.length || this.blockLevel === 0) return;
    const g = this.g;
    const specs: { role: PositionId; range: number; closeInside: number; seed: number }[] = [
      // a pin blocker fronting your lane (far enough to follow an inside set from its usual spot),
      // and a middle closing next to them
      { role: 'OPP', range: 2.6, closeInside: 0, seed: 47 },
      { role: 'MB', range: 4.6, closeInside: AI.drillBlock.closeGap, seed: 48 },
    ];
    for (const sp of specs) {
      const a = new Athlete(sp.role, -1);
      a.place(0, -0.5, Math.PI);
      g.addAthlete(a, sp.seed);
      this.spawned.push(a);
      const brain = new BlockerBrain(a, 0, sp.range);
      brain.closeInside = sp.closeInside;
      // the setter position attacks the coach's toss straight away: that is the ball to read
      brain.readFeed = this.position === 'S';
      g.setBrain(a, brain);
      this.blockers.push({ a, brain });
    }
  }

  /** where you will hit this rep: the call's spot along the net (a quick's is in front of the setter) */
  private attackSpot(): { x: number; z: number; quick: boolean } {
    const play = this.play;
    if (play?.inFront !== undefined) {
      const q = quickSpot(SETTER_TARGET.x, 1, play.inFront);
      return { x: q.x, z: q.z, quick: true };
    }
    return { x: this.lane.x, z: this.lane.z, quick: false };
  }

  /** this rep's block: the side it takes, formed before the set on pin sets, the middle late on fast sets */
  private planBlock(): BlockPlan | null {
    if (!this.blockLevel) return null;
    const spot = this.attackSpot();
    const inside = spot.quick || Math.abs(spot.x) < AI.drillBlock.insideX;
    const fast = spot.quick || this.lane.apexAbove < 1.0;
    return blockPlan(spot.x, this.takes, this.blockLevel, { inside, fast, normalX: laneFor(this.position, 1).x });
  }

  /** each rep: the active blockers where the block starts (formed, or at their usual spot), the rest parked in the free zone */
  private placeBlockers(): void {
    const plan = this.planBlock();
    this.blockers.forEach((b, i) => {
      const spot = i === 0 ? plan?.pin : plan?.middle;
      const active = i < this.blockLevel && !!spot;
      b.brain.enabled = active;
      b.brain.reset();
      b.a.endAction();
      if (active && spot) {
        b.brain.homeX = spot.start;
        b.brain.holdX = spot.hold ? spot.end : null;
        b.brain.takeShift = (this.takes === 'line' ? 1 : -1) * AI.drillBlock.takeShift;
        b.a.place(spot.start, -0.5, Math.PI);
      } else b.a.place(i === 0 ? -6.3 : 6.3, -2.5, Math.PI);
    });
  }

  /**
   * The block's wall height for its shadow: how high the active blockers' hands reach at the top of
   * their jump. Hands as high as your contact cover the whole court behind them (a straight ball can't
   * clear them anywhere), so the wall is then kept just under the contact.
   */
  private wallTop(contactY: number): number {
    const active = this.blockers.slice(0, this.blockLevel);
    const reach = active.length ? Math.max(...active.map((b) => blockReach(b.a))) : this.g.env.netTop;
    return Math.min(reach, contactY - WALL_UNDER_CONTACT);
  }

  /** the blockers who are in play */
  private activeBlockers(): Athlete[] {
    return this.blockers.slice(0, this.blockLevel).map((b) => b.a);
  }

  private buildShadow(): void {
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(this.shadowPos, 3));
    geo.setIndex(new THREE.BufferAttribute(this.shadowIdx, 1));
    geo.setDrawRange(0, 0);
    // the court floor is pulled towards the camera with a polygon offset: pull the overlay further, or
    // it loses the depth test at grazing angles (the far court seen from behind the hitter)
    const offset = { polygonOffset: true, polygonOffsetFactor: -4, polygonOffsetUnits: -4 };
    this.shadow = new THREE.Mesh(
      geo,
      new THREE.MeshBasicMaterial({
        color: 0xff4a3a,
        transparent: true,
        opacity: 0.3,
        depthWrite: false,
        side: THREE.DoubleSide,
        ...offset,
      }),
    );
    this.shadow.renderOrder = 2;
    this.shadow.visible = false;
    this.add(this.shadow);
    const egeo = new THREE.BufferGeometry();
    egeo.setAttribute('position', new THREE.BufferAttribute(this.shadowEdgePos, 3));
    egeo.setDrawRange(0, 0);
    this.shadowEdge = new THREE.LineSegments(
      egeo,
      new THREE.LineBasicMaterial({ color: 0xff7a68, transparent: true, opacity: 0.85, ...offset }),
    );
    this.shadowEdge.renderOrder = 3;
    this.shadowEdge.visible = false;
    this.add(this.shadowEdge);
    // their court in green, the shadow cut out of it: what the block leaves open
    this.openCanvas = document.createElement('canvas');
    this.openCanvas.width = this.openCanvas.height = OPEN_RES;
    const tex = new THREE.CanvasTexture(this.openCanvas);
    this.openCourt = new THREE.Mesh(
      new THREE.PlaneGeometry(COURT.halfWidth * 2, COURT.halfLength).rotateX(-Math.PI / 2),
      new THREE.MeshBasicMaterial({ map: tex, color: 0x7dff9b, transparent: true, opacity: 0.14, depthWrite: false, ...offset }),
    );
    this.openCourt.position.set(0, 0.0125, -COURT.halfLength / 2);
    this.openCourt.renderOrder = 1;
    this.openCourt.visible = false;
    this.add(this.openCourt);
  }

  /** where your contact will be (the set when it is up, otherwise the lane) */
  private contactPoint(out: { x: number; y: number; z: number }): void {
    const g = this.g;
    const me = g.me;
    const play = this.play;
    const quick = play?.inFront !== undefined;
    const spot = quick ? quickSpot(SETTER_TARGET.x, 1, play!.inFront) : this.lane;
    out.x = spot.x;
    out.y = attackHeight(me);
    out.z = spot.z;
    const lt = g.ball.lastTouch;
    const setUp = g.ball.active && lt && (lt.kind === 'set' || (this.position === 'S' && lt.kind === 'feed'));
    if (setUp) {
      const pred = g.ball.ensurePrediction(g.env, g.simTime);
      const tc = pred.descendThrough(out.y, g.simTime);
      if (tc > 0) pred.posAt(tc, out);
    }
  }

  /** redraw the block shadow from where the blockers are right now */
  private updateShadow(): void {
    const show = this.blockLevel > 0 && this.phase !== 'intro';
    if (show) this.contactPoint(this.tmp);
    this.drawShadow(show, this.tmp, show ? this.activeBlockers().map((a) => a.pos.x) : []);
  }

  /** during a replay: the shadow of the replayed block (where it is in the replay) from the replayed contact */
  replayFrame(): void {
    const xs: number[] = [];
    for (const a of this.activeBlockers()) {
      const v = this.g.views.get(a);
      // a blocker the replay hides was not there yet at this point of it
      if (v && v.root.visible) xs.push(v.root.position.x);
    }
    this.drawShadow(this.blockLevel > 0, this.g.fx.replay.contact, xs);
  }

  /** the shadow on their floor of hands at these x along the net, for a ball hit from `contact` */
  private drawShadow(show: boolean, contact: { x: number; y: number; z: number }, handsX: number[]): void {
    this.shadow.visible = show;
    this.shadowEdge.visible = show;
    this.openCourt.visible = show;
    if (!show) return;
    const spans: HandSpan[] = handsX.map((x) => ({ x0: x - HANDS_WIDTH / 2, x1: x + HANDS_WIDTH / 2 }));
    const polys = blockShadowOnCourt(contact, spans, this.wallTop(contact.y), COURT.halfWidth, COURT.halfLength);
    this.drawOpenCourt(polys);
    const P = this.shadowPos;
    const I = this.shadowIdx;
    const E = this.shadowEdgePos;
    const y = 0.013;
    let nv = 0;
    let ni = 0;
    let ne = 0;
    for (const poly of polys.slice(0, SHADOW_POLYS)) {
      const n = Math.min(poly.length, SHADOW_CORNERS);
      const base = nv;
      for (let k = 0; k < n; k++) {
        P[nv * 3] = poly[k][0];
        P[nv * 3 + 1] = y;
        P[nv * 3 + 2] = poly[k][1];
        nv++;
        // edge k -> k+1
        const nx = poly[(k + 1) % n];
        E.set([poly[k][0], y, poly[k][1], nx[0], y, nx[1]], ne * 3);
        ne += 2;
      }
      // triangle fan
      for (let k = 1; k < n - 1; k++) {
        I[ni++] = base;
        I[ni++] = base + k;
        I[ni++] = base + k + 1;
      }
    }
    const geo = this.shadow.geometry;
    (geo.getAttribute('position') as THREE.BufferAttribute).needsUpdate = true;
    geo.index!.needsUpdate = true;
    geo.setDrawRange(0, ni);
    geo.computeBoundingSphere();
    const egeo = this.shadowEdge.geometry;
    (egeo.getAttribute('position') as THREE.BufferAttribute).needsUpdate = true;
    egeo.setDrawRange(0, ne);
    egeo.computeBoundingSphere();
  }

  /** their court in green with the shadow cut out (redrawn only when the shadow has moved) */
  private drawOpenCourt(polys: FloorPoly[]): void {
    const c = this.openCanvas;
    if (!c) return;
    const key = polys.map((p) => p.map(([x, z]) => `${x.toFixed(2)},${z.toFixed(2)}`).join(' ')).join('|');
    if (key === this.openKey) return;
    this.openKey = key;
    const ctx = c.getContext('2d');
    if (!ctx) return;
    // canvas x: court x from -halfWidth; canvas y: the net (z = 0) at the top, the end line at the bottom
    const sx = OPEN_RES / (COURT.halfWidth * 2);
    const sz = OPEN_RES / COURT.halfLength;
    ctx.globalCompositeOperation = 'source-over';
    ctx.clearRect(0, 0, OPEN_RES, OPEN_RES);
    ctx.fillStyle = '#fff';
    ctx.fillRect(0, 0, OPEN_RES, OPEN_RES);
    ctx.globalCompositeOperation = 'destination-out';
    for (const poly of polys) {
      ctx.beginPath();
      poly.forEach(([x, z], i) => (i ? ctx.lineTo : ctx.moveTo).call(ctx, (x + COURT.halfWidth) * sx, -z * sz));
      ctx.closePath();
      ctx.fill();
    }
    ((this.openCourt.material as THREE.MeshBasicMaterial).map as THREE.Texture).needsUpdate = true;
  }

  /** choose the set call for the next ball (0-based) */
  selectCall(i: number): void {
    if (!this.plays || i < 0 || i >= this.plays.length) return;
    this.callIdx = i;
    const g = this.g;
    g.hud.message(`Next set: ${i + 1} · ${this.plays[i].name}`, 1.6);
    this.refreshScore();
    // not tossed yet: head to the new approach start
    if ((this.phase === 'intro' || this.phase === 'feed') && !this.tossed) {
      const l = this.lane;
      if (Math.hypot(g.me.pos.x - l.sx, g.me.pos.z - l.sz) > 0.6) g.returnUser(l.sx, l.sz, 0);
      this.placeBlockers();
      this.pickZone();
    }
  }

  /**
   * Every rep, the setter calls the set as the coach tosses: a bubble over their head and a shout
   * ("GO!", "1!", "HIGH!"), early enough to start a fast approach off the pass.
   */
  private callSet(): void {
    const s = this.setter;
    if (!s) return;
    const play = this.play;
    const word = play ? `${play.short.toUpperCase()}!` : this.position === 'L' ? 'PIPE!' : 'HIGH!';
    const fast = !!play && needsGoodPass(play);
    this.g.hud.call(
      'SETTER',
      word,
      play ? play.name : this.lane.label,
      'in',
      (out) => out.set(s.rpos.x, s.rpos.y + s.height + 0.42, s.rpos.z),
      1.8,
    );
    this.g.events.emit('setterCall', { athlete: s, call: 'in', word: fast ? 'go' : 'high' });
  }

  /** ranked run: the script picks the call and the block for the coming rep (the keys are locked) */
  private followScript(): void {
    const r = this.ranked;
    if (!r) return;
    const s = spikeScript(r.current, r.seedFor(r.current), this.plays?.length ?? 0);
    this.callIdx = s.call;
    this.blockLevel = s.block;
    this.takes = s.takes;
    this.ensureBlockers();
  }

  /** practice: the block takes a side at random each rep (a ranked run's script picks it) */
  private rollTakes(): void {
    if (!this.ranked) this.takes = this.g.rng.next() < 0.5 ? 'line' : 'cross';
  }

  setup(): void {
    const g = this.g;
    const me = g.me;
    this.plays = SET_PLAYS[this.position] ?? null;
    this.callIdx = 0;
    this.beginRep();
    this.followScript();
    this.rollTakes();
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
    this.buildShadow();
    this.placeBlockers();
    this.pickZone();
    g.hud.setTitle('Spike Drill');
    this.refreshScore();
    this.phase = 'intro';
    this.t = 0;
    if (this.ranked)
      g.hud.message(`Ranked run · ${this.ranked.length} reps · ${this.setter ? 'the setter calls each set' : 'attack on two'}`, 3);
    else
      g.hud.message(
        this.position === 'MB'
          ? 'Quick: run on the pass · jump as the setter touches it · hold LMB, release to hit · 1-3 set call'
          : this.plays
            ? 'Approach: Shift + W · plant: Space · hold LMB, release to hit · 1-3 set call'
            : 'Approach: Shift + W · plant: Space · hold LMB to wind up, release to hit',
        3.6,
      );
  }

  /** the target: any zone without a block; with one, a zone on the side it leaves open */
  private pickZone(): void {
    const prev = this.zone;
    const zones = zonesFor(this.position);
    const plan = this.planBlock();
    if (plan) {
      const spot = this.attackSpot();
      const contact = { x: spot.x, y: attackHeight(this.g.me), z: spot.z };
      const spans = planSpans(plan, AI.drillBlock.handsMargin);
      this.zone = openZone(zones, contact, spans, this.wallTop(contact.y), () => this.g.rng.next(), prev);
    } else {
      const free = zones.filter((z) => !z.blockOnly);
      do this.zone = free[Math.floor(this.g.rng.next() * free.length)];
      while (prev && this.zone === prev && free.length > 2);
    }
    const z = this.zone;
    this.zoneMarker.set(z.x0, z.x1, z.z0, z.z1);
  }

  refreshScore(): void {
    const block = this.blockLevel ? `block ${BLOCK_NAMES[this.blockLevel]} takes ${this.takes}` : 'block off';
    this.showScore([this.play?.name ?? this.lane.label, block, `target ${this.zone.name}`]);
  }

  hint(): string {
    const me = this.g.me;
    if (me.state === 'air' || me.action?.kind === 'windup')
      return `hold ${kbd('LMB')} = wind up (longer = harder) · release = hit · tap = tip &nbsp; aim with the mouse`;
    if (me.state === 'load') return `release ${kbd('Space')} to jump`;
    // a ranked run follows its script: no set call or block keys
    const calls = this.plays && !this.ranked ? ` · ${kbd('1')}${kbd('2')}${kbd('3')} set call` : '';
    const block = this.ranked ? '' : ` · ${kbd('B')} block: ${BLOCK_NAMES[this.blockLevel]}`;
    const reset = this.resetHint('reset rep');
    if (this.play?.inFront !== undefined)
      return `${kbd('Shift')}+${kbd('W')} run on the pass · ${kbd('Space')} jump with the setter's touch${calls}${block} · ${kbd('V')} camera · ${reset}`;
    return `${kbd('Shift')}+${kbd('W')} approach · ${kbd('Space')} plant & jump${calls}${block} · ${kbd('V')} camera · ${reset}`;
  }

  restartRep(): void {
    if (this.phase !== 'result') this.skipRep();
    this.nextRep();
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
          this.callSet();
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
    this.updateShadow();
  }

  frame(dt: number): void {
    this.zoneMarker.update(dt);
    if (this.plays) {
      for (let i = 0; i < this.plays.length; i++)
        if (this.g.input.consumePress('Digit' + (i + 1))) {
          if (this.ranked) this.lockedKeys();
          else this.selectCall(i);
        }
    }
    if (this.g.input.consumePress('KeyB')) {
      if (this.ranked) this.lockedKeys();
      else this.cycleBlock();
    }
  }

  private lockedKeys(): void {
    this.g.hud.message('Ranked run: the set call and the block follow the script', 1.8);
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

  private endRep(o: Outcome | null): void {
    const g = this.g;
    this.toPhase('result');
    this.reps++;
    const ev = this.lastGrade;
    let pts = 0;
    let label = 'NO ATTACK';
    let good = false;
    // the opposing block touched your ball: stuffed back onto our floor, or tooled off their hands
    const lt = g.ball.lastTouch;
    const blockTouch = this.blockLevel > 0 && lt?.kind === 'block' && lt.side === -1;
    let tooled = false;
    const S = SCORING.spike;
    if (ev && ev.grade !== 'Miss' && blockTouch) {
      if (o && o.kind === 'in' && o.side === 1) label = 'BLOCKED';
      else {
        tooled = true;
        pts += (ev.grade === 'Perfect' ? S.perfect : ev.grade === 'Good' ? S.good : S.other) + S.tooled;
        label = 'TOOLED';
      }
    } else if (ev && ev.grade !== 'Miss') {
      const gradePts = ev.grade === 'Perfect' ? S.perfect : ev.grade === 'Good' ? S.good : S.other;
      pts += gradePts;
      const kmh = ev.speed * 3.6;
      pts += Math.max(0, Math.round(kmh - S.kmhFloor));
      if (o) {
        label = outcomeLabel(o, 1);
        if (o.kind === 'in' && o.side === -1) {
          pts += S.kill;
          const z = this.zone;
          const inZone = o.x >= z.x0 - R && o.x <= z.x1 + R && o.z >= z.z0 - R && o.z <= z.z1 + R;
          if (inZone) {
            pts += S.onTarget;
            label = 'KILL · ON TARGET';
            this.zoneMarker.hit();
          } else if (this.blockLevel > 0) {
            // not where the target was, but past a block that was up: still a hitter's shot
            pts += S.aroundBlock;
            label = 'KILL · AROUND THE BLOCK';
          } else label = 'KILL';
          good = ev.grade === 'Perfect' || ev.grade === 'Good';
        }
      }
    } else if (ev && ev.grade === 'Miss') {
      label = 'WHIFF';
    }
    this.score += pts;
    if (!tooled) this.bumpStreak(good);
    this.logRep(pts, label, ev?.grade ?? null, ev && ev.grade !== 'Miss' ? ev.speed * 3.6 : null);
    g.hud.showBanner(
      pts > 0 ? `${label}  +${pts}` : label,
      good ? 'good' : tooled || (o && o.kind === 'in' && o.side === -1) ? 'neutral' : 'bad',
    );
    g.crowd(good ? (ev?.perfect ? 1 : 0.6) : 0.1, good);
    this.refreshScore();
  }

  private nextRep(): void {
    if (!this.beginRep()) return;
    const g = this.g;
    g.judge.disarm();
    this.followScript();
    this.rollTakes();
    const lane = this.lane;
    const me = g.me;
    g.ball.hide();
    if (this.setter) this.setter.place(SETTER_SPOT.x, SETTER_SPOT.z, Math.PI / 2);
    this.placeBlockers();
    this.pickZone();
    this.refreshScore();
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
