import * as THREE from 'three';
import type { PositionId } from '../../config';
import type { Athlete, Grade } from '../athlete';
import type { ContactEvent } from '../contact';
import type { Game } from '../game';
import type { Outcome } from '../judge';
import { repMark, type RankedRun } from '../ranked';
import { makeFadeTexture, makeRingTexture } from '../../world/textures';

export type ModeId = 'free' | 'spike' | 'block' | 'receive' | 'setter' | 'rally';

export const MODE_INFO: Record<ModeId, { title: string; blurb: string }> = {
  free: { title: 'Free Play', blurb: 'A ball machine feeds you. Practise anything: spike, pass, block, set, serve.' },
  spike: { title: 'Spike Drill', blurb: 'The setter sets you rep after rep. Timing, power and placement are scored.' },
  block: { title: 'Block Drill', blurb: 'An opposing hitter attacks. Read the set, move, time the block.' },
  receive: { title: 'Serve Receive / Dig', blurb: 'Pass serves and dig attacks to the setter target.' },
  setter: { title: 'Setter Drill', blurb: 'Run the offence: set your hitters and watch them finish.' },
  rally: { title: 'Mini Rally', blurb: 'Six-a-side rallies in your chosen position. Win the point.' },
};

/** a mode id from outside the type system (URL, storage): own keys of MODE_INFO only */
export const isModeId = (v: unknown): v is ModeId => typeof v === 'string' && Object.hasOwn(MODE_INFO, v);

/** A drill. Modes own their extra athletes and floor markers and clean them up. */
export abstract class Mode {
  abstract readonly id: ModeId;
  protected spawned: Athlete[] = [];
  protected objects: THREE.Object3D[] = [];
  score = 0;
  streak = 0;
  bestStreak = 0;
  reps = 0;

  constructor(
    protected g: Game,
    protected position: PositionId,
  ) {}

  abstract setup(): void;
  abstract step(dt: number): void;
  frame(_dt: number): void {}
  /** each frame of a replay (the simulation is frozen, the replay poses the scene): redraw overlays from it */
  replayFrame(): void {}
  onContact(_ev: ContactEvent): void {}
  onOutcome(_o: Outcome): void {}
  abstract hint(): string;
  /** N key: restart / skip the current rep */
  restartRep(): void {}
  /** no live play is going on (the ball is down or between reps): replays may be watched */
  ballDead(): boolean {
    const b = this.g.ball;
    return !b.active || b.state.rest;
  }
  passTarget?(a: Athlete): { x: number; y: number; z: number; apex: number };
  setOptions?(a: Athlete): import('../contact').SetOption[];
  canServe?(a: Athlete): boolean;

  teardown(): void {
    for (const a of this.spawned) this.g.removeAthlete(a);
    this.spawned = [];
    for (const o of this.objects) {
      this.g.scene.remove(o);
      o.traverse((c) => {
        const m = c as THREE.Mesh;
        if (m.geometry) m.geometry.dispose();
        const mat = m.material as (THREE.Material & { map?: THREE.Texture | null }) | undefined;
        if (mat) {
          mat.map?.dispose();
          mat.dispose();
        }
      });
    }
    this.objects = [];
    this.g.clearBrains();
  }

  protected add(o: THREE.Object3D): THREE.Object3D {
    this.g.scene.add(o);
    this.objects.push(o);
    return o;
  }

  protected bumpStreak(ok: boolean): void {
    this.streak = ok ? this.streak + 1 : 0;
    this.bestStreak = Math.max(this.bestStreak, this.streak);
    this.g.hud.setStreak(this.streak);
  }

  /** the ranked run being played (null in practice) */
  protected get ranked(): RankedRun | null {
    return this.g.ranked;
  }

  /**
   * A rep is about to start. In a ranked run its randomness (feed, AI errors) comes from the rep's
   * own seed, so it is the same ball for everyone; once every rep is played the run ends (false).
   */
  protected beginRep(): boolean {
    const r = this.ranked;
    if (!r) return true;
    if (r.done) {
      r.bestStreak = this.bestStreak;
      this.g.finishRanked();
      return false;
    }
    this.g.rng.reseed(r.seedFor(r.current));
    return true;
  }

  /** a rep was scored: a ranked run records it */
  protected logRep(points: number, label: string, grade: Grade | null = null, kmh: number | null = null): void {
    this.ranked?.record({ points, label, grade, kmh });
  }

  /** N before the rep is scored: practice throws the rep away, a ranked run counts it as 0 */
  protected skipRep(): void {
    const r = this.ranked;
    if (!r) return;
    this.reps++;
    this.bumpStreak(false);
    r.skip();
    this.g.hud.showBanner('SKIPPED  +0', 'bad');
  }

  /** redraw the scoreboard (a scored drill shows its score, the split and the run strip) */
  refreshScore(): void {}

  /** the scoreboard: score, split against your best and the run strip in a ranked run; `detail` is what the drill is doing now */
  protected showScore(detail: string[] = []): void {
    const r = this.ranked;
    this.g.hud.setScoreboard({
      points: this.score,
      split: r?.split ?? null,
      run: r ? { marks: r.reps.map(repMark), length: r.length } : null,
      status: r ? (r.unranked ? 'unranked' : 'ranked') : 'practice',
      detail: r ? (r.week ? ['this week', ...detail] : detail) : [`${this.reps} ${this.reps === 1 ? 'rep' : 'reps'}`, ...detail],
    });
  }

  /** the N key in the hints: in a ranked run it skips the rep for 0 points */
  protected resetHint(practice: string): string {
    return this.ranked ? `${kbd('N')} skip rep (scores 0)` : `${kbd('N')} ${practice}`;
  }
}

/** the target zone's solid edge band (m) */
const ZONE_EDGE = 0.15;
/** its light walls rise this high (m), fading out upwards: they make the zone readable from a hitter's low angle */
const ZONE_WALL = 0.9;
/** fill and wall opacity: base and pulse */
const ZONE_FILL = [0.3, 0.08] as const;
const ZONE_GLOW = [0.5, 0.12] as const;
/** the court floor is pulled towards the camera with a polygon offset: the zone is pulled further, or it loses the depth test at grazing angles */
const ZONE_OFFSET = { polygonOffset: true, polygonOffsetFactor: -4, polygonOffsetUnits: -4 };

/** a target zone hit: it shows in this green (the game's "good" colour) until the next target is set */
const ZONE_HIT = 0x7dff9b;

/** a target zone on the floor: a tinted fill, a solid edge band and low light walls that fade upwards */
export class ZoneMarker {
  readonly group = new THREE.Group();
  private base: THREE.Color;
  /** a ball landed in it: green, brighter, until the next `set` */
  private lit = false;
  private fill: THREE.Mesh;
  /** edge bands: near, far, left, right */
  private edges: THREE.Mesh[] = [];
  private walls: THREE.Mesh[] = [];
  private glow: THREE.MeshBasicMaterial;
  private t = 0;

  constructor(color = 0xffc23a) {
    this.base = new THREE.Color(color);
    const floor = new THREE.PlaneGeometry(1, 1).rotateX(-Math.PI / 2);
    this.fill = new THREE.Mesh(
      floor,
      new THREE.MeshBasicMaterial({ color, transparent: true, opacity: ZONE_FILL[0], depthWrite: false, ...ZONE_OFFSET }),
    );
    const band = new THREE.MeshBasicMaterial({
      color,
      transparent: true,
      opacity: 0.95,
      depthWrite: false,
      toneMapped: false,
      ...ZONE_OFFSET,
    });
    for (let i = 0; i < 4; i++) this.edges.push(new THREE.Mesh(floor, band));
    this.glow = new THREE.MeshBasicMaterial({
      color,
      map: makeFadeTexture(),
      transparent: true,
      opacity: ZONE_GLOW[0],
      depthWrite: false,
      side: THREE.DoubleSide,
      blending: THREE.AdditiveBlending,
      toneMapped: false,
    });
    // a unit wall standing on the floor, facing +z
    const wall = new THREE.PlaneGeometry(1, 1).translate(0, 0.5, 0);
    for (let i = 0; i < 4; i++) this.walls.push(new THREE.Mesh(wall, this.glow));
    this.group.add(this.fill, ...this.edges, ...this.walls);
    this.group.position.y = 0.012;
    this.group.renderOrder = 2;
    for (const w of this.walls) w.renderOrder = 3;
  }

  set(x0: number, x1: number, z0: number, z1: number): void {
    const w = Math.abs(x1 - x0);
    const d = Math.abs(z1 - z0);
    this.group.position.set((x0 + x1) / 2, 0.012, (z0 + z1) / 2);
    this.fill.scale.set(w, 1, d);
    const e = ZONE_EDGE;
    const [near, far, left, right] = this.edges;
    near.scale.set(w, 1, e);
    near.position.set(0, 0.001, d / 2 - e / 2);
    far.scale.set(w, 1, e);
    far.position.set(0, 0.001, -d / 2 + e / 2);
    left.scale.set(e, 1, d - 2 * e);
    left.position.set(-w / 2 + e / 2, 0.001, 0);
    right.scale.set(e, 1, d - 2 * e);
    right.position.set(w / 2 - e / 2, 0.001, 0);
    this.paint(this.base);
    this.lit = false;
    const [wn, wf, wl, wr] = this.walls;
    wn.scale.set(w, ZONE_WALL, 1);
    wn.position.set(0, 0, d / 2);
    wf.scale.set(w, ZONE_WALL, 1);
    wf.position.set(0, 0, -d / 2);
    wl.scale.set(d, ZONE_WALL, 1);
    wl.rotation.y = Math.PI / 2;
    wl.position.set(-w / 2, 0, 0);
    wr.scale.set(d, ZONE_WALL, 1);
    wr.rotation.y = Math.PI / 2;
    wr.position.set(w / 2, 0, 0);
    this.group.visible = true;
  }

  /** the ball landed in the zone: it lights up green (and stays lit until the next target) */
  hit(): void {
    this.lit = true;
    this.paint(new THREE.Color(ZONE_HIT));
  }

  private paint(c: THREE.Color): void {
    (this.fill.material as THREE.MeshBasicMaterial).color.copy(c);
    (this.edges[0].material as THREE.MeshBasicMaterial).color.copy(c);
    this.glow.color.copy(c);
  }

  update(dt: number): void {
    this.t += dt;
    const p = Math.sin(this.t * 4);
    // lit: a brighter fill and glow, the same pulse
    const k = this.lit ? 1.6 : 1;
    (this.fill.material as THREE.MeshBasicMaterial).opacity = (ZONE_FILL[0] + p * ZONE_FILL[1]) * k;
    this.glow.opacity = (ZONE_GLOW[0] + p * ZONE_GLOW[1]) * k;
  }
}

export function makeFloorRing(color: number, size: number): THREE.Mesh {
  const m = new THREE.Mesh(
    new THREE.PlaneGeometry(size, size),
    new THREE.MeshBasicMaterial({ map: makeRingTexture(0.18), color, transparent: true, opacity: 0.7, depthWrite: false }),
  );
  m.rotation.x = -Math.PI / 2;
  m.position.y = 0.011;
  m.renderOrder = 2;
  return m;
}

export function kbd(...keys: string[]): string {
  return keys.map((k) => `<kbd>${k}</kbd>`).join('');
}
