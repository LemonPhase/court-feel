import * as THREE from 'three';
import type { PositionId } from '../../config';
import type { Athlete } from '../athlete';
import type { ContactEvent } from '../contact';
import type { Game } from '../game';
import type { Outcome } from '../judge';
import { makeRingTexture } from '../../world/textures';

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

  constructor(protected g: Game, protected position: PositionId) {}

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
}

/** translucent target zone on the floor with a bright border */
export class ZoneMarker {
  readonly group = new THREE.Group();
  private fill: THREE.Mesh;
  private border: THREE.LineSegments;
  private t = 0;

  constructor(color = 0xffc23a) {
    this.fill = new THREE.Mesh(
      new THREE.PlaneGeometry(1, 1),
      new THREE.MeshBasicMaterial({ color, transparent: true, opacity: 0.16, depthWrite: false }),
    );
    this.fill.rotation.x = -Math.PI / 2;
    const edges = new THREE.EdgesGeometry(new THREE.PlaneGeometry(1, 1));
    this.border = new THREE.LineSegments(edges, new THREE.LineBasicMaterial({ color, transparent: true, opacity: 0.9 }));
    this.border.rotation.x = -Math.PI / 2;
    this.group.add(this.fill, this.border);
    this.group.position.y = 0.012;
    this.group.renderOrder = 2;
  }

  set(x0: number, x1: number, z0: number, z1: number): void {
    const w = Math.abs(x1 - x0);
    const d = Math.abs(z1 - z0);
    this.group.position.set((x0 + x1) / 2, 0.012, (z0 + z1) / 2);
    this.fill.scale.set(w, d, 1);
    this.border.scale.set(w, d, 1);
    this.group.visible = true;
  }

  update(dt: number): void {
    this.t += dt;
    (this.fill.material as THREE.MeshBasicMaterial).opacity = 0.12 + Math.sin(this.t * 4) * 0.05;
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
