import * as THREE from 'three';
import { AI, COURT } from '../config';
import { clamp, lerp, Rng, yawFromDir } from '../core/mathx';
import type { Athlete, Gesture, GestureKind } from '../game/athlete';
import type { AiHost } from '../game/brains';
import { moveTo, netYaw, stop } from './brain';

type Spot = { x: number; z: number };

/** how a team comes together after the whistle: a ring in the middle, round the scorer, or fives on the way back */
export type Style = 'huddle' | 'mob' | 'loose';

/** one AI player of the team, as the routine needs them */
export interface Member {
  a: Athlete;
  /** where they stand for the next serve (the service spot for the server) */
  spot: Spot;
  /** passes the serve: may wait bent over, hands on the knees */
  passer: boolean;
  /** the serving team's front row: shows the block behind its back */
  blocker: boolean;
  /** serves next */
  server: boolean;
}

/** how the point ended, for one team */
export interface PointEnd {
  won: boolean;
  /** a point of ours off our kill, block or ace */
  big: boolean;
  /** who won it for us (the kill, the block, the ace) */
  hero: Athlete | null;
  /** one of ours played the ball last and the point was theirs */
  culprit: Athlete | null;
  /** how long the rally was (s, from the serve) */
  rally: number;
  /** the referee's whistle for the next serve (sim time) */
  due: number;
  /** who serves next, on either team: the receivers watch them */
  server: Athlete | null;
}

type Phase = 'react' | 'gather' | 'ring' | 'back' | 'wait';

interface Plan {
  m: Member;
  phase: Phase;
  /** until when they watch the ball (or celebrate where they stand) */
  reactT: number;
  feel: GestureKind | null;
  /** in the ring or round the scorer: the angle of their place round its middle (null: straight back) */
  angle: number | null;
  /** the scorer of a mob: stays where they are and is come to */
  stay: boolean;
  /** a five on the way back, with whom, and whether it is done */
  mate: Athlete | null;
  fived: boolean;
  /** on their spot by then (sim time) */
  due: number;
  glanceT: number;
  fidgetT: number;
  readyT: number;
  /** a passer who waits for the serve bent over, hands on the knees */
  knees: boolean;
  /** where the eyes go (the athlete's `gaze`), and the athlete they are on (null: the point itself) */
  look: THREE.Vector3;
  eyesOn: Athlete | null;
}

/** a key of `w`, picked by weight */
function pickW<K extends string>(w: Readonly<Record<K, number>>, rng: Rng): K {
  const keys = Object.keys(w) as K[];
  let total = 0;
  for (const k of keys) total += w[k];
  let r = rng.next() * total;
  for (const k of keys) if ((r -= w[k]) < 0) return k;
  return keys[keys.length - 1];
}

const within = ([lo, hi]: readonly [number, number], rng: Rng) => rng.range(lo, hi);
const flat = (a: Athlete, b: { x: number; z: number }) => Math.hypot(a.pos.x - b.x, a.pos.z - b.z);

/**
 * Between points, for one team (`AI.between`). After the whistle every AI player watches the ball
 * down, turns to the team with what the point means to them (a fist, a roar, a clap, hands on the
 * hips, a hand up for their own error), comes together with the others (a ring in the middle, round
 * the scorer, or a five with whoever is near), and walks to their spot for the next serve, where
 * they wait as players do: the weight shifting, the eyes on the server and on each other, a passer
 * bent over with the hands on the knees until the whistle, a blocker showing the block behind
 * their back.
 *
 * It moves the players (it is their brain until the server tosses) and tells the animator what
 * the body says (`Athlete.relax`, `ready`, `tired`, `gesture`, `gaze`: drawn only, decision record
 * 0008). Nobody stands anywhere else at the serve for it, and the serve comes no later: it fills
 * the dead time the drill already has. Its dice are its own, so the rallies keep theirs.
 */
export class BetweenPoints {
  private readonly rng: Rng;
  private readonly plans = new Map<Athlete, Plan>();
  private end: PointEnd | null = null;
  style: Style = 'loose';
  /** the middle of the ring (or where the scorer is, for a mob) */
  readonly centre = new THREE.Vector3();
  private hero: Athlete | null = null;
  private radius = 0;
  /** when the ring breaks (null: not everyone is in it yet) */
  breakT: number | null = null;
  private latestT = 0;
  private handsIn = false;
  private user: Athlete | null = null;
  /** the user is in the ring, and the gesture the routine last gave the user's arms */
  private userIn = false;
  private userGest: Gesture | null = null;
  /** the ring, in order round it (the user too, when in it) */
  ring: Athlete[] = [];
  private ticked = -1;

  constructor(
    private readonly side: 1 | -1,
    seed: number,
  ) {
    this.rng = new Rng(seed);
  }

  /** the routine has the team (from the whistle to the toss) */
  get active(): boolean {
    return this.end !== null;
  }

  /** the phase a player is in, for tests and the debug overlay (null: not in the routine) */
  phaseOf(a: Athlete): Phase | null {
    return this.plans.get(a)?.phase ?? null;
  }

  /**
   * The whistle: the point is over. `members` are the AI players (with their spots for the next
   * serve), `user` the user's athlete when they are on this team (never moved: team-mates come to
   * them, and their arms meet a five).
   */
  start(end: PointEnd, members: readonly Member[], user: Athlete | null, now: number): void {
    this.stop();
    const B = AI.between;
    const rng = this.rng;
    this.end = end;
    this.user = user;
    this.breakT = null;
    this.latestT = now + B.huddle.latest;
    this.hero = end.won && end.big ? end.hero : null;
    this.ring = [];
    this.userIn = false;
    // the team's middle, drawn towards the middle of its court
    let mx = 0;
    let mz = 0;
    const all = members.map((m) => m.a).concat(user ? [user] : []);
    for (const a of all) {
      mx += a.pos.x / all.length;
      mz += a.pos.z / all.length;
    }
    const H = B.huddle;
    const s = this.side;
    this.centre.set(clamp(lerp(mx, 0, H.pull), -H.x, H.x), 0, s * clamp(lerp(mz * s, H.z, H.pull), H.near, H.far));
    const style = end.won ? (this.hero ? B.style.big : B.style.won) : B.style.lost;
    this.style = pickW(style, rng);
    // how hard the rally was
    const tired = clamp(end.rally / B.tired, 0, 1);
    for (const m of members) {
      const a = m.a;
      const hero = a === this.hero;
      let feel: GestureKind | null;
      if (hero) feel = pickW(B.feel.hero, rng);
      else {
        const f = end.won ? pickW(B.feel.won, rng) : a === end.culprit ? pickW(B.feel.error, rng) : pickW(B.feel.lost, rng);
        feel = f === 'none' ? null : f;
      }
      a.tired = tired;
      // after a long rally some are bent over, catching their breath, before they go anywhere
      if (!hero && end.rally > B.tired * B.knees && rng.next() < B.kneesShare) feel = 'knees';
      // the server goes for the ball at once: whatever they feel, they show it on the way
      if (m.server && (feel === 'roar' || feel === 'armsUp' || feel === 'knees')) feel = 'fist';
      const reactT = now + (hero || m.server ? B.heroReact : within(B.react, rng));
      this.plans.set(a, {
        m,
        phase: 'react',
        reactT,
        feel,
        angle: null,
        stay: false,
        mate: null,
        fived: false,
        due: end.due - B.settle,
        glanceT: 0,
        fidgetT: 0,
        readyT: end.due + within(m.server ? B.serverReady : B.wait.ready, rng),
        knees: m.passer && rng.next() < B.wait.passerKnees,
        look: new THREE.Vector3(),
        eyesOn: null,
      });
      // a hand still out for a ball that never came is put away
      if (a.action && a.state !== 'air' && a.state !== 'load') a.endAction();
    }
    if (this.style === 'mob' && !this.mob()) this.style = 'huddle';
    if (this.style === 'huddle' && !this.huddle(now)) this.style = 'loose';
    if (this.style === 'loose') this.pairUp();
  }

  /** the spots are final (each player's own habit for the rally is known): walk to these */
  retarget(a: Athlete, spot: Spot): void {
    const p = this.plans.get(a);
    if (p && !p.m.server) p.m.spot = spot;
  }

  /**
   * The server has tossed (or the rally is called off): everyone is the team's again, and the
   * bodies stop saying anything.
   */
  stop(): void {
    for (const a of this.plans.keys()) this.calm(a);
    this.plans.clear();
    if (this.user && this.userGest && this.user.gesture === this.userGest) this.user.gesture = null;
    this.userGest = null;
    this.end = null;
  }

  private calm(a: Athlete): void {
    a.relax = 0;
    a.ready = 0;
    a.tired = 0;
    a.gesture = null;
    a.gaze = null;
  }

  /**
   * The routine moves `a` this step (`job` is the one the team gave them). A server who is on the
   * service spot when the serve is theirs, and has taken their moment at the line, is let go: the
   * toss is the server's own.
   */
  drives(a: Athlete, job: string, now: number): boolean {
    const p = this.plans.get(a);
    if (!p) return false;
    if (job === 'serve' && p.phase === 'wait' && now >= p.readyT) {
      this.calm(a);
      this.plans.delete(a);
      return false;
    }
    return true;
  }

  /** in the ring, or on the way into it: keeps its line (nobody steps round a team-mate in a huddle) */
  holds(a: Athlete): boolean {
    const ph = this.plans.get(a)?.phase;
    return ph === 'gather' || ph === 'ring';
  }

  // ------------------------------------------------------------ coming together
  /** round the scorer: the scorer stays, the others near enough come to them */
  private mob(): boolean {
    const hero = this.hero;
    // (an ace: the server is on the way to serve again, and is clapped from where the team stands)
    if (!hero || this.plans.get(hero)?.m.server) return false;
    this.radius = AI.between.mob.radius;
    let n = 0;
    for (const p of this.plans.values()) {
      const a = p.m.a;
      if (a === hero) {
        p.stay = true;
        continue;
      }
      if (!this.canJoin(p, hero.pos)) continue;
      p.angle = Math.atan2(a.pos.z - hero.pos.z, a.pos.x - hero.pos.x);
      n++;
    }
    return n > 0;
  }

  /** a player joins if they can walk (`jog` at most) to their spot in time from the ring, however late it breaks */
  private canJoin(p: Plan, at: { x: number; z: number }): boolean {
    const B = AI.between;
    const a = p.m.a;
    // (the server goes for the ball; one bent over catching their breath comes after, straight to their spot)
    if (p.m.server || p.feel === 'knees' || flat(a, at) > B.huddle.reach) return false;
    return Math.hypot(at.x - p.m.spot.x, at.z - p.m.spot.z) <= (p.due - this.latestT) * B.jog;
  }

  /** a ring in the middle of the court, each in the place nearest where they come from */
  private huddle(now: number): boolean {
    const H = AI.between.huddle;
    const c = this.centre;
    const user = this.user;
    const joining = [...this.plans.values()].filter((p) => this.canJoin(p, c));
    this.userIn = !!user && flat(user, c) <= H.you;
    const n = joining.length + (this.userIn ? 1 : 0);
    if (joining.length < H.min) return false;
    this.radius = H.spacing / (2 * Math.sin(Math.PI / n));
    // you are in it where you stand: the ring is put round you
    if (this.userIn && user) {
      const dx = c.x - user.pos.x;
      const dz = c.z - user.pos.z;
      const d = Math.hypot(dx, dz) || 1;
      c.set(user.pos.x + (dx / d) * this.radius, 0, user.pos.z + (dz / d) * this.radius);
    }
    const people = joining.map((p) => p.m.a);
    if (this.userIn && user) people.push(user);
    const angleOf = (a: Athlete) => Math.atan2(a.pos.z - c.z, a.pos.x - c.x);
    people.sort((p, q) => angleOf(p) - angleOf(q));
    const step = (2 * Math.PI) / n;
    let base: number;
    const ui = user ? people.indexOf(user) : -1;
    if (this.userIn && user && ui >= 0) base = angleOf(user) - ui * step;
    else {
      // the circular mean of where each would start the ring from
      let sx = 0;
      let sz = 0;
      people.forEach((a, i) => {
        const t = angleOf(a) - i * step;
        sx += Math.cos(t);
        sz += Math.sin(t);
      });
      base = Math.atan2(sz, sx);
    }
    people.forEach((a, i) => {
      const p = this.plans.get(a);
      if (p) p.angle = base + i * step;
    });
    this.ring = people;
    this.handsIn = this.rng.next() < H.middle;
    this.latestT = Math.min(this.latestT, now + H.latest);
    return true;
  }

  /** walking back with no huddle: team-mates near each other pair up for a five */
  private pairUp(): void {
    const F = AI.between.five;
    const rng = this.rng;
    // (not the server: on the way to serve)
    const free = new Set<Athlete>([...this.plans.values()].filter((p) => !p.m.server).map((p) => p.m.a));
    if (this.user) free.add(this.user);
    const order = [...this.plans.values()];
    for (let i = order.length - 1; i > 0; i--) {
      const j = Math.floor(rng.next() * (i + 1));
      [order[i], order[j]] = [order[j], order[i]];
    }
    for (const p of order) {
      const a = p.m.a;
      if (!free.has(a)) continue;
      let best: Athlete | null = null;
      let bd = F.pair;
      for (const o of free) {
        if (o === a) continue;
        const d = flat(a, o.pos);
        if (d < bd) {
          bd = d;
          best = o;
        }
      }
      if (!best || rng.next() >= F.share) continue;
      free.delete(a);
      free.delete(best);
      p.mate = best;
      const q = this.plans.get(best);
      if (q) q.mate = a;
    }
  }

  /** where `p` stands in the ring or round the scorer, now */
  private placeOf(p: Plan, out: Spot): Spot {
    const c = this.style === 'mob' && this.hero ? this.hero.pos : this.centre;
    const t = p.angle ?? 0;
    out.x = c.x + Math.cos(t) * this.radius;
    out.z = c.z + Math.sin(t) * this.radius;
    return out;
  }

  // ------------------------------------------------------------ every step
  /** the team's part, once a step: when the ring breaks */
  private tick(now: number): void {
    if (this.ticked === now) return;
    this.ticked = now;
    if (this.style === 'loose' || this.breakT !== null) return;
    let all = true;
    for (const p of this.plans.values()) if (p.angle !== null && p.phase !== 'ring' && p.phase !== 'back') all = false;
    if (all) this.breakT = Math.min(now + within(AI.between.huddle.hold, this.rng), this.latestT);
    else if (now >= this.latestT) this.breakT = now;
  }

  step(a: Athlete, _dt: number, g: AiHost): void {
    const p = this.plans.get(a);
    if (!p) return;
    const B = AI.between;
    const now = g.simTime;
    this.tick(now);
    const ready = p.phase === 'wait' && now >= p.readyT;
    a.relax = ready ? 0 : 1;
    a.ready = ready ? 1 : 0;
    // still in the air, or on the floor after a dive: up first
    if (a.state !== 'ground' && a.state !== 'land') {
      stop(a);
      p.reactT = Math.max(p.reactT, now + B.getUp);
      return;
    }
    // back on the floor: a block (or any hand still out) from the rally is put away
    if (a.action) a.endAction();
    switch (p.phase) {
      case 'react':
        this.react(p, now);
        break;
      case 'gather':
        this.gather(p, now);
        break;
      case 'ring':
        this.inRing(p, now);
        break;
      case 'back':
        this.back(p, now);
        break;
      case 'wait':
        this.wait(p, now);
        break;
    }
  }

  /** watching the ball down (the eyes are on it: no gaze of their own), then what the point means to them */
  private react(p: Plan, now: number): void {
    const a = p.m.a;
    const B = AI.between;
    const L = B.lasts;
    // a celebration or a breath taken where they stand holds them there
    const g = a.gesture;
    const rooted = !!g && (g.kind === 'roar' || g.kind === 'armsUp' || g.kind === 'knees') && now < g.t0 + g.dur;
    stop(a);
    if (p.stay) this.lookAtMates(p);
    if (now < p.reactT || rooted) return;
    if (p.feel) {
      const f = p.feel;
      p.feel = null;
      const rng = this.rng;
      const count = f === 'clap' ? Math.round(within(B.claps, rng)) : 0;
      const dur = f === 'clap' ? count * L.clap : L[f as keyof typeof L];
      this.give(a, f, now, dur, { count });
      if (f === 'roar' || f === 'armsUp' || f === 'knees') return;
    }
    p.phase = p.stay ? 'ring' : p.angle !== null ? 'gather' : 'back';
  }

  /** on the way into the ring (or round the scorer) */
  private gather(p: Plan, now: number): void {
    const a = p.m.a;
    const B = AI.between;
    if (this.breakT !== null && now >= this.breakT) {
      p.phase = 'back';
      return;
    }
    const at = this.placeOf(p, _spot);
    const d = flat(a, at);
    const c = this.style === 'mob' && this.hero ? this.hero.pos : this.centre;
    const faceIn = yawFromDir(c.x - a.pos.x, c.z - a.pos.z);
    // in at the pace that gets them there before the ring has to break, a walk at least, a jog at most
    const left = Math.max(B.settle, this.latestT - B.huddle.hold[1] - now);
    const pace = clamp(d / left, B.gather, B.jog);
    moveTo(a, at.x, at.z, {
      face: d > this.radius ? yawFromDir(at.x - a.pos.x, at.z - a.pos.z) : faceIn,
      arrive: B.stop,
      sprintDist: Infinity,
      urgency: pace / a.stats.shuffleSpeed,
    });
    this.lookAt(p, null, c.x, a.height * B.wait.eye, c.z);
    if (d < B.arrive * 2) {
      p.phase = 'ring';
      if (this.style === 'huddle') {
        const i = this.ring.indexOf(a);
        const n = this.ring.length;
        this.give(a, 'huddle', now, this.latestT - now + B.huddle.hold[1], {
          with: this.ring[(i + n - 1) % n],
          with2: this.ring[(i + 1) % n],
          at: this.centre,
          low: this.handsIn,
        });
      }
    }
  }

  /** in the ring: arms round the neighbours (or a hand in the middle), or a five for the scorer */
  private inRing(p: Plan, now: number): void {
    const a = p.m.a;
    const B = AI.between;
    const c = this.style === 'mob' && this.hero ? this.hero.pos : this.centre;
    if (p.stay) {
      // the scorer: celebrating, then turning to whoever comes
      stop(a);
      this.lookAtMates(p);
    } else {
      const at = this.placeOf(p, _spot);
      // (holding the place: a step in if the ring moved, the scorer walked)
      moveTo(a, at.x, at.z, {
        face: yawFromDir(c.x - a.pos.x, c.z - a.pos.z),
        arrive: B.stop,
        sprintDist: Infinity,
        urgency: B.walk / a.stats.shuffleSpeed,
      });
      this.lookAt(p, this.style === 'mob' ? this.hero : null, c.x, a.height * B.wait.eye, c.z);
      // round the scorer: a five as they get there (a hand on the shoulder if the scorer is busy)
      if (this.style === 'mob' && this.hero && !p.fived) {
        p.fived = true;
        const h = this.hero;
        const hg = h.gesture;
        const busy = !!hg && now < hg.t0 + hg.dur;
        if (busy) this.give(a, 'pat', now, B.lasts.pat, { with: h });
        else this.fiveWith(a, h, now, true);
      }
    }
    if (this.breakT !== null && now >= this.breakT) {
      p.phase = 'back';
      // the ring breaks together: one clap, and off
      if (this.style === 'huddle') this.give(a, 'clap', now, B.lasts.clap, { count: 1 });
    }
  }

  /** walking to the spot for the next serve, at the pace that gets them there in time */
  private back(p: Plan, now: number): void {
    const a = p.m.a;
    const B = AI.between;
    const F = B.five;
    let to: Spot = p.m.spot;
    const mate = p.mate;
    if (mate && !p.fived) {
      const g = a.gesture;
      const giveUp = now > (this.end?.due ?? now) - F.giveUp;
      const d = flat(a, mate.pos);
      const slapping = g?.kind === 'five' && g.with === mate;
      // the hands have met (or there is no time left for it): on to the spot
      if (slapping ? now > g.meet : giveUp) this.fivedWith(p, mate);
      else {
        if (!slapping && d <= F.apart + F.slack) this.fiveWith(a, mate, now, !!this.end?.won && this.rng.next() < F.high);
        // towards the team-mate, to an arm's length of them, until the hands meet
        if (d > F.apart / 2) {
          _spot.x = mate.pos.x + ((a.pos.x - mate.pos.x) / d) * F.apart;
          _spot.z = mate.pos.z + ((a.pos.z - mate.pos.z) / d) * F.apart;
          to = _spot;
        }
      }
    }
    const d = flat(a, to);
    const left = Math.max(B.settle, p.due - now);
    const need = d / left;
    const top = a.stats.shuffleSpeed;
    const pace = clamp(need, B.walk, Math.max(B.jog, Math.min(need, top)));
    // a short way back is walked facing the net; a longer one facing where they go
    const longWay = to === p.m.spot && d > COURT.attackLine / 2;
    moveTo(a, to.x, to.z, {
      face: longWay ? yawFromDir(to.x - a.pos.x, to.z - a.pos.z) : netYaw(a.side),
      arrive: B.stop,
      sprintDist: need > top ? 0 : Infinity,
      urgency: Math.min(1, pace / top),
    });
    if (mate && !p.fived) this.lookAt(p, mate, 0, 0, 0);
    else {
      // eyes where they are going, a little down
      const k = d > 0 ? COURT.attackLine / d : 0;
      this.lookAt(p, null, a.pos.x + (to.x - a.pos.x) * k, a.height * B.wait.eye * B.huddle.pull, a.pos.z + (to.z - a.pos.z) * k);
    }
    if (to === p.m.spot && d < B.arrive) {
      p.phase = 'wait';
      p.glanceT = now;
      p.fidgetT = now + within(B.wait.fidget, this.rng);
    }
  }

  /** on the spot, waiting for the serve */
  private wait(p: Plan, now: number): void {
    const a = p.m.a;
    const B = AI.between;
    const W = B.wait;
    const rng = this.rng;
    const s = p.m.spot;
    moveTo(a, s.x, s.z, { face: netYaw(a.side), arrive: B.stop, sprintDist: Infinity, urgency: B.walk / a.stats.shuffleSpeed });
    const end = this.end;
    const due = end?.due ?? now;
    const g = a.gesture;
    const busy = !!g && now < g.t0 + g.dur;
    // the serving team's front row shows the block behind its back until the toss
    if (p.m.blocker && now >= due - W.signal && g?.kind !== 'signal')
      this.give(a, 'signal', now, Infinity, { low: rng.next() < B.huddle.middle });
    else if (p.knees && now < p.readyT && g?.kind !== 'knees') this.give(a, 'knees', now, p.readyT - now, { low: true });
    else if (!busy && !p.m.blocker && now >= p.fidgetT) {
      p.fidgetT = now + within(W.fidget, rng);
      const f = pickW(W.fidgets, rng);
      const dur = f === 'none' ? 0 : B.lasts[f];
      // (nothing the hands are still doing as the server gets ready)
      if (f !== 'none' && now + dur < p.readyT) this.give(a, f, now, dur, {});
    }
    if (now >= p.glanceT) {
      p.glanceT = now + within(W.glance, rng);
      const server = end?.server ?? null;
      const what = pickW(W.look, rng);
      if (what === 'server' && server && server !== a) this.lookAt(p, server, 0, 0, 0);
      else if (what !== 'across') {
        const mates = [...this.plans.keys()].filter((o) => o !== a);
        if (this.user) mates.push(this.user);
        this.lookAt(p, mates.length ? rng.pick(mates) : null, 0, a.height * W.eye, 0);
      } else
        this.lookAt(
          p,
          null,
          rng.range(-COURT.halfWidth, COURT.halfWidth),
          a.height * W.eye,
          -a.side * rng.range(COURT.attackLine, COURT.halfLength),
        );
    } else this.lookAt(p, p.eyesOn, p.look.x, p.look.y, p.look.z);
  }

  // ------------------------------------------------------------ the body
  /** the eyes on `on` (their head), or on a point */
  private lookAt(p: Plan, on: Athlete | null, x: number, y: number, z: number): void {
    const a = p.m.a;
    p.eyesOn = on;
    if (on) p.look.set(on.pos.x, on.pos.y + on.height * AI.between.wait.eye, on.pos.z);
    else p.look.set(x, y, z);
    a.gaze = p.look;
  }

  /** the scorer looks at the team-mate nearest them */
  private lookAtMates(p: Plan): void {
    const a = p.m.a;
    let best: Athlete | null = null;
    let bd = Infinity;
    for (const o of this.plans.keys()) {
      const d = flat(a, o.pos);
      if (o !== a && d < bd) {
        bd = d;
        best = o;
      }
    }
    if (best) this.lookAt(p, best, 0, 0, 0);
  }

  private give(a: Athlete, kind: GestureKind, now: number, dur: number, o: Partial<Gesture>): Gesture {
    const g: Gesture = {
      kind,
      t0: now,
      dur,
      hand: a.hand,
      k: this.rng.next(),
      with: null,
      with2: null,
      meet: 0,
      at: null,
      low: false,
      count: 0,
      ...o,
    };
    a.gesture = g;
    if (a === this.user) this.userGest = g;
    return g;
  }

  /** a five between `a` and `b`: the hands meet `raise` s from now (the user's arm too) */
  private fiveWith(a: Athlete, b: Athlete, now: number, high: boolean): void {
    const F = AI.between.five;
    const meet = now + F.raise;
    const dur = F.raise + AI.between.lasts.five;
    // a low five is given with the hand on the side of the other
    const side = (x: Athlete, y: Athlete): 1 | -1 => {
      const rx = Math.cos(x.yaw);
      const rz = -Math.sin(x.yaw);
      return (y.pos.x - x.pos.x) * rx + (y.pos.z - x.pos.z) * rz >= 0 ? 1 : -1;
    };
    this.give(a, 'five', now, dur, { with: b, meet, low: !high, hand: high ? a.hand : side(a, b) });
    if (b.isUser || this.plans.has(b)) this.give(b, 'five', now, dur, { with: a, meet, low: !high, hand: high ? b.hand : side(b, a) });
  }

  private fivedWith(p: Plan, mate: Athlete): void {
    p.fived = true;
    const q = this.plans.get(mate);
    if (q && q.mate === p.m.a) q.fived = true;
  }
}

const _spot: Spot = { x: 0, z: 0 };
