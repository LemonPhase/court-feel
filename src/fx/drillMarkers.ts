import * as THREE from 'three';
import { FX } from '../config';
import type { FloorPoly } from '../game/blockShadow';
import type {
  ApproachGuideState,
  DrillMarkers,
  GuideMark,
  HaloMark,
  MachineMark,
  RingMark,
  ShadowMark,
  ZoneMark,
} from '../game/modes/markers';
import { makeRingTexture } from '../world/textures';
import { ApproachGuide } from './approachGuide';

/** the most patches of floor a block's shadow has, and the most corners of one (a quad clipped to the court) */
const SHADOW_POLYS = 2;
const SHADOW_CORNERS = 8;

/** translucent target zone on the floor with a bright border */
class ZoneMarker {
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

function makeFloorRing(color: number, size: number): THREE.Mesh {
  const m = new THREE.Mesh(
    new THREE.PlaneGeometry(size, size),
    // the court is pulled towards the camera with a polygon offset: pull the ring further, or the court draws over it
    new THREE.MeshBasicMaterial({
      map: makeRingTexture(0.18),
      color,
      transparent: true,
      opacity: 0.7,
      depthWrite: false,
      polygonOffset: true,
      polygonOffsetFactor: -4,
      polygonOffsetUnits: -4,
    }),
  );
  m.rotation.x = -Math.PI / 2;
  m.position.y = 0.011;
  m.renderOrder = 2;
  return m;
}

function makeMachine(): { group: THREE.Group; barrel: THREE.Group; lamp: THREE.Mesh } {
  const group = new THREE.Group();
  const dark = new THREE.MeshStandardMaterial({ color: 0x2b2f3a, roughness: 0.5, metalness: 0.5 });
  const accent = new THREE.MeshStandardMaterial({ color: 0xff9f1c, roughness: 0.4, metalness: 0.2 });
  const base = new THREE.Mesh(new THREE.BoxGeometry(0.6, 0.12, 0.6), dark);
  base.position.y = 0.06;
  group.add(base);
  const mast = new THREE.Mesh(new THREE.CylinderGeometry(0.05, 0.05, 0.9, 10), dark);
  mast.position.y = 0.55;
  group.add(mast);
  const barrel = new THREE.Group();
  barrel.position.y = 1.05;
  const drum = new THREE.Mesh(new THREE.CylinderGeometry(0.2, 0.2, 0.22, 18), accent);
  drum.rotation.z = Math.PI / 2;
  barrel.add(drum);
  const tube = new THREE.Mesh(new THREE.CylinderGeometry(0.13, 0.13, 0.45, 16, 1, true), dark);
  tube.rotation.x = Math.PI / 2;
  tube.position.z = -0.25;
  barrel.add(tube);
  group.add(barrel);
  const hopper = new THREE.Mesh(
    new THREE.CylinderGeometry(0.22, 0.12, 0.3, 14, 1, true),
    new THREE.MeshStandardMaterial({ color: 0x9fb4d8, transparent: true, opacity: 0.45, side: THREE.DoubleSide }),
  );
  hopper.position.set(0, 1.35, 0.1);
  group.add(hopper);
  const lamp = new THREE.Mesh(
    new THREE.SphereGeometry(0.05, 10, 8),
    new THREE.MeshBasicMaterial({ color: new THREE.Color(0.4, 2.2, 0.6) }),
  );
  lamp.position.set(0, 1.25, -0.12);
  group.add(lamp);
  group.traverse((o) => ((o as THREE.Mesh).castShadow = true));
  return { group, barrel, lamp };
}

/**
 * The markers a drill asks for, as three.js objects in the scene. It owns them: a drill holds only
 * the handles (src/game/modes/markers.ts), and `clear` takes everything off the court and frees it.
 */
export class SceneMarkers implements DrillMarkers {
  readonly objects: THREE.Object3D[] = [];

  constructor(private scene: THREE.Scene) {}

  private add<T extends THREE.Object3D>(o: T): T {
    this.scene.add(o);
    this.objects.push(o);
    return o;
  }

  ring(color: number, size: number): RingMark {
    const m = this.add(makeFloorRing(color, size));
    const mat = m.material as THREE.MeshBasicMaterial;
    return {
      get visible() {
        return m.visible;
      },
      set visible(on: boolean) {
        m.visible = on;
      },
      place: (x, z) => m.position.set(x, 0.011, z),
      colour: (hex) => mat.color.setHex(hex),
      fade: (to, dt) => {
        mat.opacity += (to - mat.opacity) * Math.min(1, dt * 10);
      },
    };
  }

  halo(x: number, y: number, z: number): HaloMark {
    const m = new THREE.Mesh(
      new THREE.TorusGeometry(0.45, 0.025, 8, 40),
      new THREE.MeshBasicMaterial({ color: new THREE.Color(0.5, 1.4, 0.7), transparent: true, opacity: 0.55 }),
    );
    m.position.set(x, y, z);
    m.rotation.x = Math.PI / 2;
    this.add(m);
    return {
      turn: (angle) => {
        m.rotation.z += angle;
      },
    };
  }

  zone(): ZoneMark {
    const marker = new ZoneMarker();
    this.add(marker.group);
    return marker;
  }

  machine(): MachineMark {
    const machine = makeMachine();
    this.add(machine.group);
    return {
      place: (x, z, scale) => {
        machine.group.position.set(x, 0, z);
        machine.group.scale.setScalar(scale);
      },
      lamp: (r, g, b) => (machine.lamp.material as THREE.MeshBasicMaterial).color.setRGB(r, g, b),
      aim: (pitch, yaw) => machine.barrel.rotation.set(pitch, yaw - machine.group.rotation.y, 0, 'YXZ'),
    };
  }

  blockShadow(): ShadowMark {
    const pos = new Float32Array(SHADOW_POLYS * SHADOW_CORNERS * 3);
    const idx = new Uint16Array(SHADOW_POLYS * (SHADOW_CORNERS - 2) * 3);
    // the outline: a quad along each side
    const edgePos = new Float32Array(SHADOW_POLYS * SHADOW_CORNERS * 4 * 3);
    const edgeIdx = new Uint16Array(SHADOW_POLYS * SHADOW_CORNERS * 6);
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    geo.setIndex(new THREE.BufferAttribute(idx, 1));
    geo.setDrawRange(0, 0);
    // The court floor is pulled towards the camera with a polygon offset: pull the overlay further, or
    // it loses the depth test at grazing angles (the far court seen from behind the hitter). It is still
    // tested against depth and writes none, so anyone standing nearer the camera hides it.
    const overlay = (color: number, opacity: number) =>
      new THREE.MeshBasicMaterial({
        color,
        transparent: true,
        opacity,
        depthWrite: false,
        side: THREE.DoubleSide,
        polygonOffset: true,
        polygonOffsetFactor: -4,
        polygonOffsetUnits: -4,
      });
    const shadow = new THREE.Mesh(geo, overlay(0xff4a3a, 0.3));
    shadow.renderOrder = 2;
    shadow.visible = false;
    this.add(shadow);
    // The outline is a surface too, a thin band, and not a line (`LineSegments`, which it was). A polygon
    // offset is defined for surfaces only, and what a line does with one is up to the GPU. By the OpenGL
    // rules it is left out, and the line then loses to the floor (measured: gone from behind the hitter,
    // 8 m away). The software GPU the end-to-end run draws on (SwiftShader) gave the line a different
    // depth on every draw: the same frame showed it over an athlete's legs, on the floor or not at all.
    // A band takes the patch's own offset on every GPU.
    const egeo = new THREE.BufferGeometry();
    egeo.setAttribute('position', new THREE.BufferAttribute(edgePos, 3));
    egeo.setIndex(new THREE.BufferAttribute(edgeIdx, 1));
    egeo.setDrawRange(0, 0);
    const edge = new THREE.Mesh(egeo, overlay(0xff7a68, 0.85));
    edge.renderOrder = 3;
    edge.visible = false;
    this.add(edge);
    const half = FX.blockShadow.edge / 2;
    return {
      draw: (polys: readonly FloorPoly[] | null) => {
        shadow.visible = !!polys;
        edge.visible = !!polys;
        if (!polys) return;
        const y = 0.013;
        let nv = 0;
        let ni = 0;
        let ev = 0;
        let ei = 0;
        for (const poly of polys.slice(0, SHADOW_POLYS)) {
          const n = Math.min(poly.length, SHADOW_CORNERS);
          const base = nv;
          for (let k = 0; k < n; k++) {
            const [ax, az] = poly[k];
            pos[nv * 3] = ax;
            pos[nv * 3 + 1] = y;
            pos[nv * 3 + 2] = az;
            nv++;
            // side k -> k+1: a quad centred on it, and half its width past both ends so the corners close
            const [bx, bz] = poly[(k + 1) % n];
            const len = Math.hypot(bx - ax, bz - az);
            if (len === 0) continue;
            const ux = ((bx - ax) / len) * half;
            const uz = ((bz - az) / len) * half;
            edgePos.set(
              [ax - ux - uz, y, az - uz + ux, ax - ux + uz, y, az - uz - ux, bx + ux + uz, y, bz + uz - ux, bx + ux - uz, y, bz + uz + ux],
              ev * 3,
            );
            edgeIdx.set([ev, ev + 1, ev + 2, ev, ev + 2, ev + 3], ei);
            ev += 4;
            ei += 6;
          }
          // triangle fan
          for (let k = 1; k < n - 1; k++) {
            idx[ni++] = base;
            idx[ni++] = base + k;
            idx[ni++] = base + k + 1;
          }
        }
        (geo.getAttribute('position') as THREE.BufferAttribute).needsUpdate = true;
        geo.index!.needsUpdate = true;
        geo.setDrawRange(0, ni);
        geo.computeBoundingSphere();
        (egeo.getAttribute('position') as THREE.BufferAttribute).needsUpdate = true;
        egeo.index!.needsUpdate = true;
        egeo.setDrawRange(0, ei);
        egeo.computeBoundingSphere();
      },
    };
  }

  approachGuide(): GuideMark {
    const guide = new ApproachGuide();
    this.add(guide.group);
    return { update: (s: ApproachGuideState, dt: number) => guide.update(s, dt) };
  }

  clear(): void {
    for (const o of this.objects) {
      this.scene.remove(o);
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
    this.objects.length = 0;
  }
}
