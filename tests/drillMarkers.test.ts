import { describe, expect, it } from 'vitest';
import * as THREE from 'three';
import { FX } from '../src/config';
import type { FloorPoly } from '../src/game/blockShadow';
import { SceneMarkers } from '../src/fx/drillMarkers';

/** every vertex a geometry draws, as points */
function drawn(geo: THREE.BufferGeometry): THREE.Vector3[] {
  const pos = geo.getAttribute('position');
  const out: THREE.Vector3[] = [];
  for (let i = geo.drawRange.start; i < geo.drawRange.start + geo.drawRange.count; i++)
    out.push(new THREE.Vector3().fromBufferAttribute(pos, geo.index ? geo.index.getX(i) : i));
  return out;
}

/** how far (m) a point of the floor is from the nearest side of a polygon */
function toSide(poly: FloorPoly, x: number, z: number): number {
  let best = Infinity;
  for (let k = 0; k < poly.length; k++) {
    const [ax, az] = poly[k];
    const [bx, bz] = poly[(k + 1) % poly.length];
    const t = Math.max(0, Math.min(1, ((x - ax) * (bx - ax) + (z - az) * (bz - az)) / ((bx - ax) ** 2 + (bz - az) ** 2)));
    best = Math.min(best, Math.hypot(x - (ax + t * (bx - ax)), z - (az + t * (bz - az))));
  }
  return best;
}

describe("the block's shadow on their floor", () => {
  // a double block's shadow seen from the left pin: a patch from the net to the sideline, and a sliver beside it
  const patch: FloorPoly = [
    [-4.5, -0.35],
    [-4.375, 0],
    [-3.725, 0],
    [-1.2, -4.1],
    [-4.5, -4.1],
  ];
  const sliver: FloorPoly = [
    [1.1, 0],
    [1.75, 0],
    [4.5, -1.9],
    [4.5, -2.6],
  ];
  const build = () => {
    const scene = new THREE.Scene();
    const markers = new SceneMarkers(scene);
    const shadow = markers.blockShadow();
    markers.zone();
    shadow.draw([patch, sliver]);
    scene.updateMatrixWorld(true);
    const meshes: THREE.Mesh[] = [];
    scene.traverse((o) => {
      if ((o as THREE.Mesh).isMesh && markers.objects.includes(o)) meshes.push(o as THREE.Mesh);
    });
    return { scene, markers, shadow, fill: meshes[0], outline: meshes[1] };
  };

  // A depth offset (polygon offset) is defined for surfaces only. What a line does with one is up to the GPU:
  // by the OpenGL rules it is left out, and the software one the end-to-end run draws on gave a different
  // answer on every draw, so the outline was in front of an athlete's legs in one frame and under the floor
  // in the next.
  it('asks no line and no point for a depth offset: only a surface has one', () => {
    const { scene } = build();
    const asked: string[] = [];
    scene.traverse((o) => {
      const line = o as THREE.Line;
      if (!line.isLine && !(o as THREE.Points).isPoints) return;
      if ((line.material as THREE.Material).polygonOffset) asked.push(o.type);
    });
    expect(asked).toEqual([]);
  });

  it('is outlined with a surface: a band on the floor along every side of every patch', () => {
    const { fill, outline } = build();
    expect(outline).toBeDefined();
    const band = drawn(outline.geometry);
    const floorY = drawn(fill.geometry)[0].y;
    // two triangles a side
    expect(band.length).toBe((patch.length + sliver.length) * 6);
    const reach = Math.hypot(FX.blockShadow.edge / 2, FX.blockShadow.edge / 2) + 1e-6;
    for (const p of band) {
      expect(p.y).toBeCloseTo(floorY, 6);
      expect(Math.min(toSide(patch, p.x, p.z), toSide(sliver, p.x, p.z))).toBeLessThanOrEqual(reach);
    }
    // and every corner of both patches is under it
    for (const [x, z] of [...patch, ...sliver]) expect(band.some((p) => Math.hypot(p.x - x, p.z - z) <= reach)).toBe(true);
  });

  it('lies in the picture where its patch does: over the floor, behind anyone standing nearer the camera', () => {
    const { fill, outline } = build();
    const a = fill.material as THREE.MeshBasicMaterial;
    const b = outline.material as THREE.MeshBasicMaterial;
    for (const m of [a, b]) {
      // tested against the athletes' depth, and leaving none behind for what is drawn after it
      expect(m.depthTest).toBe(true);
      expect(m.depthWrite).toBe(false);
      expect(m.polygonOffset).toBe(true);
    }
    expect([b.polygonOffsetFactor, b.polygonOffsetUnits]).toEqual([a.polygonOffsetFactor, a.polygonOffsetUnits]);
    // the outline over its patch, both before a faded athlete (src/character/rig.ts: GHOST_ORDER)
    expect(outline.renderOrder).toBeGreaterThan(fill.renderOrder);
    expect(outline.renderOrder).toBeLessThan(10);
  });

  it('is gone, outline and all, when there is no block', () => {
    const { shadow, fill, outline } = build();
    shadow.draw(null);
    expect(fill.visible).toBe(false);
    expect(outline.visible).toBe(false);
  });
});
