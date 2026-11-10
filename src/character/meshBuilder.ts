import * as THREE from 'three';

/**
 * Geometry toolkit for the procedural athlete: a vertex/index accumulator with
 * skin weights, generalised-cylinder lofts ("tubes") with shaped cross-sections,
 * and smooth normals computed from the finished surface.
 */

/** [bone index, weight] pairs; the four heaviest are kept and normalised */
export type Weights = [number, number][];

/** atlas texel that is always transparent: vertices that carry no decal point here */
export const BLANK_UV: readonly [number, number] = [0.002, 0.002];

export class MeshBuilder {
  private pos: number[] = [];
  private col: number[] = [];
  private uv: number[] = [];
  private rough: number[] = [];
  private skinI: number[] = [];
  private skinW: number[] = [];
  private grp: number[] = [];
  private idx: number[] = [];
  private groups = 0;
  /** smoothing group for new vertices: normals blend across vertices that share a place and a group */
  group = 0;
  /** surface roughness for new vertices */
  roughness = 0.7;

  get count(): number {
    return this.pos.length / 3;
  }

  /** start a new smoothing group (a hard edge against everything built before) */
  newGroup(): number {
    this.group = ++this.groups;
    return this.group;
  }

  vert(p: THREE.Vector3, c: THREE.Color, w: Weights, uv: readonly [number, number] = BLANK_UV): number {
    const i = this.count;
    this.pos.push(p.x, p.y, p.z);
    this.col.push(c.r, c.g, c.b);
    this.uv.push(uv[0], uv[1]);
    this.rough.push(this.roughness);
    this.grp.push(this.group);
    const ws = w.length > 4 ? [...w].sort((a, b) => b[1] - a[1]).slice(0, 4) : w;
    let sum = 0;
    for (const x of ws) sum += x[1];
    if (sum <= 0) sum = 1;
    for (let k = 0; k < 4; k++) {
      this.skinI.push(ws[k] ? ws[k][0] : 0);
      this.skinW.push(ws[k] ? ws[k][1] / sum : 0);
    }
    return i;
  }

  tri(a: number, b: number, c: number): void {
    this.idx.push(a, b, c);
  }

  quad(a: number, b: number, c: number, d: number): void {
    this.idx.push(a, b, c, a, c, d);
  }

  /** area-weighted vertex normals, welded by position within a smoothing group */
  private normals(): Float32Array {
    const n = this.count;
    const pos = this.pos;
    const acc = new Float64Array(n * 3);
    // weld: vertices at the same place in the same group share one accumulator
    const slot = new Int32Array(n);
    const seen = new Map<string, number>();
    for (let i = 0; i < n; i++) {
      const key = `${this.grp[i]}|${Math.round(pos[i * 3] * 2e4)}|${Math.round(pos[i * 3 + 1] * 2e4)}|${Math.round(pos[i * 3 + 2] * 2e4)}`;
      const s = seen.get(key);
      if (s === undefined) {
        seen.set(key, i);
        slot[i] = i;
      } else slot[i] = s;
    }
    const idx = this.idx;
    for (let t = 0; t < idx.length; t += 3) {
      const a = idx[t] * 3;
      const b = idx[t + 1] * 3;
      const c = idx[t + 2] * 3;
      const ux = pos[b] - pos[a];
      const uy = pos[b + 1] - pos[a + 1];
      const uz = pos[b + 2] - pos[a + 2];
      const vx = pos[c] - pos[a];
      const vy = pos[c + 1] - pos[a + 1];
      const vz = pos[c + 2] - pos[a + 2];
      const nx = uy * vz - uz * vy;
      const ny = uz * vx - ux * vz;
      const nz = ux * vy - uy * vx;
      for (let k = 0; k < 3; k++) {
        const s = slot[idx[t + k]] * 3;
        acc[s] += nx;
        acc[s + 1] += ny;
        acc[s + 2] += nz;
      }
    }
    const out = new Float32Array(n * 3);
    for (let i = 0; i < n; i++) {
      const s = slot[i] * 3;
      const l = Math.hypot(acc[s], acc[s + 1], acc[s + 2]) || 1;
      out[i * 3] = acc[s] / l;
      out[i * 3 + 1] = acc[s + 1] / l;
      out[i * 3 + 2] = acc[s + 2] / l;
    }
    return out;
  }

  build(): THREE.BufferGeometry {
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(this.pos, 3));
    g.setAttribute('normal', new THREE.BufferAttribute(this.normals(), 3));
    g.setAttribute('color', new THREE.Float32BufferAttribute(this.col, 3));
    g.setAttribute('uv', new THREE.Float32BufferAttribute(this.uv, 2));
    g.setAttribute('aRough', new THREE.Float32BufferAttribute(this.rough, 1));
    g.setAttribute('skinIndex', new THREE.Uint16BufferAttribute(this.skinI, 4));
    g.setAttribute('skinWeight', new THREE.Float32BufferAttribute(this.skinW, 4));
    g.setIndex(this.idx);
    g.computeBoundingSphere();
    return g;
  }
}

/** colour of a ring vertex: `cs` is +1 on the ring's +side, `fr` is +1 at its front */
export type RingColor = THREE.Color | ((cs: number, fr: number) => THREE.Color);
export type RingWeights = Weights | ((p: THREE.Vector3) => Weights);

/** one cross-section of a tube */
export interface Ring {
  /** centre */
  c: THREE.Vector3;
  /** half-width along the side axis */
  rx: number;
  /** extent towards the front */
  rf: number;
  /** extent towards the back (defaults to `rf`) */
  rb?: number;
  /** superellipse exponent: 2 is an ellipse, larger is boxier */
  e?: number;
  color: RingColor;
  w: RingWeights;
  /** ring plane normal (defaults to the path tangent) */
  n?: THREE.Vector3;
  /** decal coordinates */
  uv?: (cs: number, fr: number, p: THREE.Vector3) => readonly [number, number];
  /** start a new smoothing group at this ring (a crease) */
  crease?: boolean;
}

export interface TubeOpts {
  /** reference axis that maps to a ring's x radius */
  side?: THREE.Vector3;
  /** which way "front" is */
  front?: THREE.Vector3;
  capStart?: boolean;
  capEnd?: boolean;
  /**
   * colour (and decal coordinates) per face column instead of per vertex: boundaries
   * between columns are sharp. Costs twice the vertices.
   */
  crisp?: boolean;
}

const X_AXIS = new THREE.Vector3(1, 0, 0);
const FRONT = new THREE.Vector3(0, 0, -1);

const spow = (v: number, e: number) => (v < 0 ? -1 : 1) * Math.pow(Math.abs(v), e);

/**
 * Loft rings along a path. Each ring lies in the plane perpendicular to the local
 * path tangent. Faces wind outwards whichever way the path runs.
 */
export function tube(b: MeshBuilder, rings: Ring[], seg: number, opts: TubeOpts = {}): void {
  const side = opts.side ?? X_AXIS;
  const front = opts.front ?? FRONT;
  const crisp = !!opts.crisp;
  const tan = new THREE.Vector3();
  const u = new THREE.Vector3();
  const v = new THREE.Vector3();
  const p = new THREE.Vector3();
  const starts: number[] = [];
  const colorOf = (r: Ring, cs: number, fr: number) => (typeof r.color === 'function' ? r.color(cs, fr) : r.color);
  const weightsOf = (r: Ring, q: THREE.Vector3) => (typeof r.w === 'function' ? r.w(q) : r.w);
  for (let i = 0; i < rings.length; i++) {
    const r = rings[i];
    if (r.crease) b.newGroup();
    if (r.n) tan.copy(r.n);
    else {
      // tangent from the neighbours that are not at the same place (a doubled ring is a colour seam)
      let a = i;
      let c = i;
      while (a > 0 && rings[a].c.distanceToSquared(r.c) < 1e-12) a--;
      while (c < rings.length - 1 && rings[c].c.distanceToSquared(r.c) < 1e-12) c++;
      tan.subVectors(rings[c].c, rings[a].c);
      if (tan.lengthSq() < 1e-12) tan.set(0, 1, 0);
    }
    tan.normalize();
    u.copy(side).addScaledVector(tan, -side.dot(tan)).normalize();
    v.crossVectors(tan, u).normalize();
    const fs = v.dot(front) < 0 ? -1 : 1;
    const ex = 2 / (r.e ?? 2);
    const rb = r.rb ?? r.rf;
    starts.push(b.count);
    const at = (th: number) => {
      const cs = Math.cos(th);
      const sn = Math.sin(th);
      const fr = sn * fs;
      p.copy(r.c)
        .addScaledVector(u, spow(cs, ex) * r.rx)
        .addScaledVector(v, spow(sn, ex) * (fr > 0 ? r.rf : rb));
      return [cs, fr] as const;
    };
    if (crisp) {
      for (let k = 0; k < seg; k++) {
        const thm = ((k + 0.5) / seg) * Math.PI * 2;
        const csm = Math.cos(thm);
        const frm = Math.sin(thm) * fs;
        const col = colorOf(r, csm, frm);
        for (let e = 0; e < 2; e++) {
          at(((k + e) / seg) * Math.PI * 2);
          b.vert(p, col, weightsOf(r, p), r.uv ? r.uv(csm, frm, p) : BLANK_UV);
        }
      }
    } else {
      for (let k = 0; k <= seg; k++) {
        const [cs, fr] = at((k / seg) * Math.PI * 2);
        b.vert(p, colorOf(r, cs, fr), weightsOf(r, p), r.uv ? r.uv(cs, fr, p) : BLANK_UV);
      }
    }
  }
  for (let i = 0; i < rings.length - 1; i++) {
    if (rings[i + 1].crease) continue; // the crease ring repeats its predecessor's place: no faces between them
    for (let k = 0; k < seg; k++) {
      const a0 = starts[i] + (crisp ? k * 2 : k);
      const b0 = starts[i + 1] + (crisp ? k * 2 : k);
      b.tri(a0, a0 + 1, b0);
      b.tri(a0 + 1, b0 + 1, b0);
    }
  }
  const cap = (ri: number, start: boolean) => {
    const r = rings[ri];
    const ci = b.vert(r.c, colorOf(r, 1, 0), weightsOf(r, r.c));
    for (let k = 0; k < seg; k++) {
      const a0 = starts[ri] + (crisp ? k * 2 : k);
      if (start) b.tri(ci, a0 + 1, a0);
      else b.tri(ci, a0, a0 + 1);
    }
  };
  if (opts.capStart) cap(0, true);
  if (opts.capEnd) cap(rings.length - 1, false);
}

/**
 * A closed surface from a direction -> point function, sampled on a
 * latitude/longitude grid (poles on +y / -y). `lon` may warp the longitudes
 * (to spend more columns where the detail is).
 */
export function radial(
  b: MeshBuilder,
  cols: number,
  rows: number,
  point: (d: THREE.Vector3, out: THREE.Vector3) => void,
  attrs: (d: THREE.Vector3, p: THREE.Vector3) => { color: THREE.Color; w: Weights; uv?: readonly [number, number] },
  lon: (u: number) => number = (u) => u * Math.PI * 2,
  /** keep only the grid cells whose four corners pass (an open shell) */
  keep?: (d: THREE.Vector3) => boolean,
): void {
  const d = new THREE.Vector3();
  const p = new THREE.Vector3();
  const base = b.count;
  const ok: boolean[] = [];
  for (let j = 0; j <= rows; j++) {
    const phi = (j / rows) * Math.PI;
    for (let i = 0; i <= cols; i++) {
      const th = lon(i / cols);
      d.set(Math.sin(phi) * Math.cos(th), Math.cos(phi), Math.sin(phi) * Math.sin(th));
      point(d, p);
      const a = attrs(d, p);
      b.vert(p, a.color, a.w, a.uv ?? BLANK_UV);
      ok.push(keep ? keep(d) : true);
    }
  }
  for (let j = 0; j < rows; j++) {
    for (let i = 0; i < cols; i++) {
      const o = j * (cols + 1) + i;
      const a = base + o;
      const c = a + cols + 1;
      if (keep && !(ok[o] && ok[o + 1] && ok[o + cols + 1] && ok[o + cols + 2])) continue;
      if (j > 0) b.tri(a, a + 1, c);
      if (j < rows - 1) b.tri(a + 1, c + 1, c);
    }
  }
}
