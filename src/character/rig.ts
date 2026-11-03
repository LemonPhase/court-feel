import * as THREE from 'three';

/**
 * Procedurally built athlete: a 19-bone skeleton and a skinned mesh made of
 * lofted tubes (limbs, torso) and ellipsoids (head, hands, feet) with
 * smoothly blended skin weights at the joints. Every bone has identity rest
 * rotation, so local rotations read in athlete space (x right, y up, -z fwd).
 */

export type BoneName =
  | 'hips'
  | 'spine'
  | 'chest'
  | 'neck'
  | 'head'
  | 'clavL'
  | 'upperArmL'
  | 'lowerArmL'
  | 'handL'
  | 'clavR'
  | 'upperArmR'
  | 'lowerArmR'
  | 'handR'
  | 'thighL'
  | 'shinL'
  | 'footL'
  | 'thighR'
  | 'shinR'
  | 'footR';

export const BONE_ORDER: BoneName[] = [
  'hips',
  'spine',
  'chest',
  'neck',
  'head',
  'clavL',
  'upperArmL',
  'lowerArmL',
  'handL',
  'clavR',
  'upperArmR',
  'lowerArmR',
  'handR',
  'thighL',
  'shinL',
  'footL',
  'thighR',
  'shinR',
  'footR',
];

export interface Kit {
  jersey: number;
  jerseyTrim: number;
  shorts: number;
  skin: number;
  hair: number;
  shoes: number;
  socks: number;
  pads: number;
  hairStyle: 0 | 1 | 2; // short, buzz, bun
}

export interface RigDims {
  H: number;
  hipY: number;
  hipJointY: number;
  hipJointX: number;
  spineLen: number;
  chestLen: number;
  neckLen: number;
  headLen: number;
  clavX: number;
  clavY: number;
  shoulderX: number;
  upperArm: number;
  foreArm: number;
  hand: number;
  thigh: number;
  shin: number;
  ankleY: number;
  footLen: number;
  heel: number;
}

export function dimsFor(H: number): RigDims {
  // anatomical proportions (fractions of standing height)
  return {
    H,
    hipY: 0.55 * H,
    hipJointY: 0.53 * H,
    hipJointX: 0.05 * H,
    spineLen: 0.12 * H, // spine bone (0.58H) -> chest (0.70H)
    chestLen: 0.135 * H, // chest -> neck base (0.835H)
    neckLen: 0.055 * H,
    headLen: 0.055 * H, // neck -> skull base (0.89H)
    clavX: 0.02 * H,
    clavY: 0.115 * H, // shoulder line at 0.815H
    shoulderX: 0.105 * H,
    upperArm: 0.186 * H,
    foreArm: 0.146 * H,
    hand: 0.108 * H,
    thigh: 0.245 * H,
    shin: 0.246 * H,
    ankleY: 0.039 * H,
    footLen: 0.14 * H,
    heel: 0.035 * H,
  };
}

/** standing reach implied by the rig (shoulder + arm + a little shrug) */
export function standingReach(H: number): number {
  const d = dimsFor(H);
  return d.hipY + 0.03 * H + d.spineLen + d.clavY + 0.003 * H + d.upperArm + d.foreArm + d.hand * 0.85 + 0.025 * H;
}

export interface Rig {
  root: THREE.Group;
  mesh: THREE.SkinnedMesh;
  bones: Record<BoneName, THREE.Bone>;
  dims: RigDims;
  material: THREE.MeshStandardMaterial;
}

// ------------------------------------------------------------------ builder

class MeshBuilder {
  pos: number[] = [];
  nor: number[] = [];
  col: number[] = [];
  skinI: number[] = [];
  skinW: number[] = [];
  idx: number[] = [];

  get count() {
    return this.pos.length / 3;
  }

  vert(p: THREE.Vector3, n: THREE.Vector3, c: THREE.Color, w: [number, number][]) {
    this.pos.push(p.x, p.y, p.z);
    this.nor.push(n.x, n.y, n.z);
    this.col.push(c.r, c.g, c.b);
    const ws = [...w].sort((a, b) => b[1] - a[1]).slice(0, 4);
    const sum = ws.reduce((s, x) => s + x[1], 0) || 1;
    for (let i = 0; i < 4; i++) {
      this.skinI.push(ws[i] ? ws[i][0] : 0);
      this.skinW.push(ws[i] ? ws[i][1] / sum : 0);
    }
  }

  build(): THREE.BufferGeometry {
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(this.pos, 3));
    g.setAttribute('normal', new THREE.Float32BufferAttribute(this.nor, 3));
    g.setAttribute('color', new THREE.Float32BufferAttribute(this.col, 3));
    g.setAttribute('skinIndex', new THREE.Uint16BufferAttribute(this.skinI, 4));
    g.setAttribute('skinWeight', new THREE.Float32BufferAttribute(this.skinW, 4));
    g.setIndex(this.idx);
    g.computeBoundingSphere();
    return g;
  }
}

interface Ring {
  c: THREE.Vector3;
  rx: number;
  rz: number;
  color: THREE.Color;
  w: [number, number][];
  /** optional offset of the ellipse centre along the local "z" axis (belly/calf bulge) */
  oz?: number;
}

/**
 * Loft rings along a path. Each ring's plane is perpendicular to the local
 * path tangent; `side` is the reference axis that maps to the ring's x radius.
 */
function loft(b: MeshBuilder, rings: Ring[], seg: number, side: THREE.Vector3, capStart = true, capEnd = true) {
  const base = b.count;
  const tan = new THREE.Vector3();
  const u = new THREE.Vector3();
  const v = new THREE.Vector3();
  const p = new THREE.Vector3();
  const n = new THREE.Vector3();
  for (let i = 0; i < rings.length; i++) {
    const r = rings[i];
    const a = rings[Math.max(0, i - 1)].c;
    const c = rings[Math.min(rings.length - 1, i + 1)].c;
    tan.subVectors(c, a);
    if (tan.lengthSq() < 1e-10) tan.set(0, 1, 0);
    tan.normalize();
    u.copy(side).addScaledVector(tan, -side.dot(tan)).normalize();
    v.crossVectors(tan, u).normalize();
    for (let k = 0; k <= seg; k++) {
      const th = (k / seg) * Math.PI * 2;
      const cs = Math.cos(th);
      const sn = Math.sin(th);
      p.copy(r.c)
        .addScaledVector(u, cs * r.rx)
        .addScaledVector(v, sn * r.rz + (r.oz ?? 0) * Math.max(0, sn));
      n.copy(u)
        .multiplyScalar(cs / r.rx)
        .addScaledVector(v, sn / r.rz)
        .normalize();
      b.vert(p, n, r.color, r.w);
    }
  }
  const stride = seg + 1;
  for (let i = 0; i < rings.length - 1; i++) {
    for (let k = 0; k < seg; k++) {
      const a0 = base + i * stride + k;
      const a1 = a0 + 1;
      const b0 = a0 + stride;
      const b1 = b0 + 1;
      b.idx.push(a0, b0, a1, a1, b0, b1);
    }
  }
  const cap = (ri: number, flip: boolean) => {
    const r = rings[ri];
    const ci = b.count;
    const nn = new THREE.Vector3().subVectors(rings[ri].c, rings[flip ? ri + 1 : ri - 1].c).normalize();
    b.vert(r.c, nn, r.color, r.w);
    for (let k = 0; k < seg; k++) {
      const a0 = base + ri * stride + k;
      if (flip) b.idx.push(ci, a0, a0 + 1);
      else b.idx.push(ci, a0 + 1, a0);
    }
  };
  if (capStart) cap(0, true);
  if (capEnd) cap(rings.length - 1, false);
}

function ellipsoid(
  b: MeshBuilder,
  center: THREE.Vector3,
  rx: number,
  ry: number,
  rz: number,
  colorFn: (n: THREE.Vector3, p: THREE.Vector3) => THREE.Color,
  w: [number, number][],
  ws = 18,
  hs = 12,
  rotate?: THREE.Quaternion,
) {
  const base = b.count;
  const p = new THREE.Vector3();
  const n = new THREE.Vector3();
  const local = new THREE.Vector3();
  for (let j = 0; j <= hs; j++) {
    const phi = (j / hs) * Math.PI;
    for (let i = 0; i <= ws; i++) {
      const th = (i / ws) * Math.PI * 2;
      local.set(Math.sin(phi) * Math.cos(th), Math.cos(phi), Math.sin(phi) * Math.sin(th));
      n.set(local.x / rx, local.y / ry, local.z / rz).normalize();
      p.set(local.x * rx, local.y * ry, local.z * rz);
      if (rotate) {
        p.applyQuaternion(rotate);
        n.applyQuaternion(rotate);
      }
      const col = colorFn(local, p);
      p.add(center);
      b.vert(p, n, col, w);
    }
  }
  for (let j = 0; j < hs; j++) {
    for (let i = 0; i < ws; i++) {
      const a = base + j * (ws + 1) + i;
      const c = a + ws + 1;
      b.idx.push(a, c, a + 1, a + 1, c, c + 1);
    }
  }
}

export function buildRig(H: number, kit: Kit): Rig {
  const d = dimsFor(H);
  const bones = {} as Record<BoneName, THREE.Bone>;
  const mk = (name: BoneName, parent: THREE.Bone | null, x: number, y: number, z: number) => {
    const bn = new THREE.Bone();
    bn.name = name;
    bn.position.set(x, y, z);
    if (parent) parent.add(bn);
    bones[name] = bn;
    return bn;
  };
  const hips = mk('hips', null, 0, d.hipY, 0);
  const spine = mk('spine', hips, 0, 0.03 * H, 0);
  const chest = mk('chest', spine, 0, d.spineLen, 0);
  const neck = mk('neck', chest, 0, d.chestLen, 0.008 * H);
  mk('head', neck, 0, d.headLen, -0.004 * H);
  for (const s of [-1, 1] as const) {
    const L = s < 0 ? 'L' : 'R';
    const clav = mk(`clav${L}` as BoneName, chest, s * d.clavX, d.clavY, 0);
    const ua = mk(`upperArm${L}` as BoneName, clav, s * (d.shoulderX - d.clavX), 0.003 * H, 0.004 * H);
    const la = mk(`lowerArm${L}` as BoneName, ua, 0, -d.upperArm, 0);
    mk(`hand${L}` as BoneName, la, 0, -d.foreArm, 0);
    const th = mk(`thigh${L}` as BoneName, hips, s * d.hipJointX, d.hipJointY - d.hipY, 0);
    const sh = mk(`shin${L}` as BoneName, th, 0, -d.thigh, 0);
    mk(`foot${L}` as BoneName, sh, 0, -d.shin, 0);
  }
  const idx = (n: BoneName) => BONE_ORDER.indexOf(n);
  hips.updateMatrixWorld(true);
  const wp = (n: BoneName) => bones[n].getWorldPosition(new THREE.Vector3());

  const C = (hex: number) => new THREE.Color(hex);
  const skin = C(kit.skin);
  const jersey = C(kit.jersey);
  const trim = C(kit.jerseyTrim);
  const shorts = C(kit.shorts);
  const socks = C(kit.socks);
  const shoes = C(kit.shoes);
  const pads = C(kit.pads);
  const hair = C(kit.hair);

  const b = new MeshBuilder();
  const X = new THREE.Vector3(1, 0, 0);

  // ---------------- legs (hip -> knee -> ankle)
  for (const s of [-1, 1] as const) {
    const L = s < 0 ? 'L' : 'R';
    const T = idx(`thigh${L}` as BoneName);
    const S = idx(`shin${L}` as BoneName);
    const F = idx(`foot${L}` as BoneName);
    const hip = wp(`thigh${L}` as BoneName);
    const knee = wp(`shin${L}` as BoneName);
    const ankle = wp(`foot${L}` as BoneName);
    const at = (a: THREE.Vector3, bb: THREE.Vector3, t: number) => a.clone().lerp(bb, t);
    const hipW: [number, number][] = [
      [T, 0.75],
      [idx('hips'), 0.25],
    ];
    const rings: Ring[] = [
      {
        c: at(hip, knee, -0.12).add(new THREE.Vector3(-s * 0.006 * H, 0, 0)),
        rx: 0.05 * H,
        rz: 0.052 * H,
        color: shorts,
        w: [
          [idx('hips'), 0.7],
          [T, 0.3],
        ],
      },
      { c: at(hip, knee, 0.05), rx: 0.046 * H, rz: 0.048 * H, color: shorts, w: hipW },
      { c: at(hip, knee, 0.42), rx: 0.04 * H, rz: 0.042 * H, color: shorts, w: [[T, 1]] },
      { c: at(hip, knee, 0.42), rx: 0.04 * H, rz: 0.042 * H, color: skin, w: [[T, 1]] },
      { c: at(hip, knee, 0.72), rx: 0.034 * H, rz: 0.035 * H, color: skin, w: [[T, 1]] },
      {
        c: at(hip, knee, 0.84),
        rx: 0.032 * H,
        rz: 0.033 * H,
        color: skin,
        w: [
          [T, 0.85],
          [S, 0.15],
        ],
      },
      // knee pad band
      {
        c: at(hip, knee, 0.84),
        rx: 0.035 * H,
        rz: 0.037 * H,
        color: pads,
        w: [
          [T, 0.85],
          [S, 0.15],
        ],
      },
      {
        c: at(hip, knee, 1.0),
        rx: 0.036 * H,
        rz: 0.04 * H,
        color: pads,
        w: [
          [T, 0.5],
          [S, 0.5],
        ],
        oz: -0.004 * H,
      },
      {
        c: at(knee, ankle, 0.12),
        rx: 0.034 * H,
        rz: 0.036 * H,
        color: pads,
        w: [
          [S, 0.85],
          [T, 0.15],
        ],
      },
      {
        c: at(knee, ankle, 0.12),
        rx: 0.03 * H,
        rz: 0.031 * H,
        color: skin,
        w: [
          [S, 0.85],
          [T, 0.15],
        ],
      },
      { c: at(knee, ankle, 0.3), rx: 0.03 * H, rz: 0.033 * H, color: skin, w: [[S, 1]], oz: 0.006 * H },
      { c: at(knee, ankle, 0.55), rx: 0.025 * H, rz: 0.026 * H, color: skin, w: [[S, 1]] },
      { c: at(knee, ankle, 0.55), rx: 0.0255 * H, rz: 0.0265 * H, color: socks, w: [[S, 1]] },
      { c: at(knee, ankle, 0.85), rx: 0.019 * H, rz: 0.02 * H, color: socks, w: [[S, 1]] },
      {
        c: at(knee, ankle, 1.02),
        rx: 0.019 * H,
        rz: 0.021 * H,
        color: socks,
        w: [
          [S, 0.4],
          [F, 0.6],
        ],
      },
    ];
    loft(b, rings, 14, X, false, true);
    // shoe: rounded box from heel to toe
    const shoeC = ankle.clone().add(new THREE.Vector3(0, -0.022 * H, -(d.footLen - d.heel) * 0.5 + d.heel * 0.25));
    ellipsoid(b, shoeC, 0.026 * H, 0.024 * H, d.footLen * 0.58, (n) => (n.y < -0.55 ? C(0xf2f2f2) : shoes), [[F, 1]], 14, 8);
  }

  // ---------------- torso (pelvis -> chest -> shoulders)
  {
    const Hi = idx('hips');
    const Sp = idx('spine');
    const Ch = idx('chest');
    const y0 = d.hipJointY - 0.045 * H;
    const hy = d.hipY;
    const rows: [number, number, number, THREE.Color, [number, number][], number?][] = [
      // [y, rx, rz, color, weights, zOffset]
      [y0, 0.074 * H, 0.058 * H, shorts, [[Hi, 1]]],
      [hy - 0.01 * H, 0.083 * H, 0.062 * H, shorts, [[Hi, 1]]],
      [
        hy + 0.03 * H,
        0.079 * H,
        0.058 * H,
        shorts,
        [
          [Hi, 0.75],
          [Sp, 0.25],
        ],
      ],
      [
        hy + 0.03 * H,
        0.079 * H,
        0.058 * H,
        trim,
        [
          [Hi, 0.75],
          [Sp, 0.25],
        ],
      ],
      [
        hy + 0.042 * H,
        0.078 * H,
        0.057 * H,
        trim,
        [
          [Hi, 0.6],
          [Sp, 0.4],
        ],
      ],
      [
        hy + 0.042 * H,
        0.078 * H,
        0.057 * H,
        jersey,
        [
          [Hi, 0.6],
          [Sp, 0.4],
        ],
      ],
      [
        hy + 0.09 * H,
        0.074 * H,
        0.054 * H,
        jersey,
        [
          [Sp, 0.9],
          [Ch, 0.1],
        ],
      ],
      [
        hy + 0.14 * H,
        0.08 * H,
        0.059 * H,
        jersey,
        [
          [Sp, 0.5],
          [Ch, 0.5],
        ],
      ],
      [hy + 0.19 * H, 0.09 * H, 0.066 * H, jersey, [[Ch, 1]]],
      [hy + 0.235 * H, 0.1 * H, 0.066 * H, jersey, [[Ch, 1]]],
      [hy + 0.262 * H, 0.098 * H, 0.06 * H, jersey, [[Ch, 1]]],
      [
        hy + 0.278 * H,
        0.075 * H,
        0.046 * H,
        jersey,
        [
          [Ch, 0.9],
          [idx('neck'), 0.1],
        ],
      ],
      [
        hy + 0.287 * H,
        0.032 * H,
        0.03 * H,
        trim,
        [
          [Ch, 0.5],
          [idx('neck'), 0.5],
        ],
      ],
    ];
    const rings: Ring[] = rows.map(([y, rx, rz, color, w, oz]) => ({ c: new THREE.Vector3(0, y, 0.004 * H), rx, rz, color, w, oz }));
    loft(b, rings, 20, X, true, true);
  }
  // shoulders (deltoids) and arms
  for (const s of [-1, 1] as const) {
    const L = s < 0 ? 'L' : 'R';
    const U = idx(`upperArm${L}` as BoneName);
    const Lo = idx(`lowerArm${L}` as BoneName);
    const Ha = idx(`hand${L}` as BoneName);
    const Cl = idx(`clav${L}` as BoneName);
    const sh = wp(`upperArm${L}` as BoneName);
    const el = wp(`lowerArm${L}` as BoneName);
    const wr = wp(`hand${L}` as BoneName);
    const at = (a: THREE.Vector3, bb: THREE.Vector3, t: number) => a.clone().lerp(bb, t);
    ellipsoid(
      b,
      sh.clone().add(new THREE.Vector3(-s * 0.004 * H, -0.006 * H, 0)),
      0.036 * H,
      0.034 * H,
      0.036 * H,
      () => jersey,
      [
        [U, 0.55],
        [Cl, 0.3],
        [idx('chest'), 0.15],
      ],
      14,
      10,
    );
    const rings: Ring[] = [
      {
        c: at(sh, el, 0.02),
        rx: 0.03 * H,
        rz: 0.031 * H,
        color: jersey,
        w: [
          [U, 0.8],
          [Cl, 0.2],
        ],
      },
      { c: at(sh, el, 0.38), rx: 0.027 * H, rz: 0.028 * H, color: jersey, w: [[U, 1]] },
      { c: at(sh, el, 0.38), rx: 0.0255 * H, rz: 0.027 * H, color: skin, w: [[U, 1]] },
      { c: at(sh, el, 0.62), rx: 0.023 * H, rz: 0.025 * H, color: skin, w: [[U, 1]] },
      {
        c: at(sh, el, 0.9),
        rx: 0.019 * H,
        rz: 0.02 * H,
        color: skin,
        w: [
          [U, 0.8],
          [Lo, 0.2],
        ],
      },
      {
        c: at(sh, el, 1.0),
        rx: 0.0185 * H,
        rz: 0.0195 * H,
        color: skin,
        w: [
          [U, 0.5],
          [Lo, 0.5],
        ],
      },
      {
        c: at(el, wr, 0.12),
        rx: 0.0195 * H,
        rz: 0.02 * H,
        color: skin,
        w: [
          [Lo, 0.85],
          [U, 0.15],
        ],
      },
      { c: at(el, wr, 0.35), rx: 0.02 * H, rz: 0.019 * H, color: skin, w: [[Lo, 1]] },
      { c: at(el, wr, 0.8), rx: 0.0155 * H, rz: 0.013 * H, color: skin, w: [[Lo, 1]] },
      {
        c: at(el, wr, 1.0),
        rx: 0.0145 * H,
        rz: 0.012 * H,
        color: skin,
        w: [
          [Lo, 0.5],
          [Ha, 0.5],
        ],
      },
    ];
    loft(b, rings, 12, X, false, false);
    // mitten hand (palm faces the thigh at rest)
    const hc = wr.clone().add(new THREE.Vector3(0, -d.hand * 0.42, 0));
    ellipsoid(b, hc, 0.012 * H, d.hand * 0.5, 0.026 * H, () => skin, [[Ha, 1]], 12, 8);
    // thumb
    ellipsoid(
      b,
      wr.clone().add(new THREE.Vector3(-s * 0.004 * H, -d.hand * 0.32, -0.02 * H)),
      0.007 * H,
      0.02 * H,
      0.008 * H,
      () => skin,
      [[Ha, 1]],
      8,
      6,
    );
  }
  // ---------------- neck and head
  {
    const N = idx('neck');
    const Hd = idx('head');
    const nb = wp('neck');
    const hd = wp('head');
    const rings: Ring[] = [
      {
        c: nb.clone().add(new THREE.Vector3(0, -0.012 * H, 0)),
        rx: 0.031 * H,
        rz: 0.031 * H,
        color: skin,
        w: [
          [N, 0.6],
          [idx('chest'), 0.4],
        ],
      },
      { c: nb.clone().lerp(hd, 0.5), rx: 0.027 * H, rz: 0.028 * H, color: skin, w: [[N, 1]] },
      {
        c: hd.clone().add(new THREE.Vector3(0, 0.012 * H, 0)),
        rx: 0.027 * H,
        rz: 0.028 * H,
        color: skin,
        w: [
          [N, 0.4],
          [Hd, 0.6],
        ],
      },
    ];
    loft(b, rings, 12, X, false, false);
    const headC = hd.clone().add(new THREE.Vector3(0, 0.046 * H, -0.006 * H));
    const hr = kit.hairStyle;
    ellipsoid(
      b,
      headC,
      0.044 * H,
      0.062 * H,
      0.054 * H,
      (n) => {
        // hair cap: top and back of the head
        const hairLine = hr === 1 ? 0.55 : 0.25;
        if (n.y > hairLine - n.z * 0.55 && !(n.z < -0.55 && n.y < 0.62)) return hair;
        return skin;
      },
      [[Hd, 1]],
      20,
      14,
    );
    if (hr === 2)
      ellipsoid(
        b,
        headC.clone().add(new THREE.Vector3(0, 0.035 * H, 0.05 * H)),
        0.022 * H,
        0.022 * H,
        0.022 * H,
        () => hair,
        [[Hd, 1]],
        10,
        8,
      );
    // eyes + brows give the head a readable facing
    for (const ex of [-1, 1]) {
      ellipsoid(
        b,
        headC.clone().add(new THREE.Vector3(ex * 0.017 * H, 0.008 * H, -0.05 * H)),
        0.0055 * H,
        0.004 * H,
        0.003 * H,
        () => C(0x1a1410),
        [[Hd, 1]],
        6,
        4,
      );
    }
    // nose
    ellipsoid(
      b,
      headC.clone().add(new THREE.Vector3(0, -0.006 * H, -0.054 * H)),
      0.006 * H,
      0.011 * H,
      0.008 * H,
      () => skin,
      [[Hd, 1]],
      6,
      4,
    );
    // ears
    for (const ex of [-1, 1]) {
      ellipsoid(
        b,
        headC.clone().add(new THREE.Vector3(ex * 0.046 * H, 0.0, 0.004 * H)),
        0.006 * H,
        0.014 * H,
        0.01 * H,
        () => skin,
        [[Hd, 1]],
        6,
        4,
      );
    }
  }

  const geo = b.build();
  const material = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.62, metalness: 0.0, envMapIntensity: 0.6 });
  const mesh = new THREE.SkinnedMesh(geo, material);
  const skeleton = new THREE.Skeleton(BONE_ORDER.map((n) => bones[n]));
  mesh.add(hips);
  hips.updateMatrixWorld(true);
  mesh.bind(skeleton);
  mesh.castShadow = true;
  mesh.receiveShadow = false;
  mesh.frustumCulled = false;
  const root = new THREE.Group();
  root.add(mesh);
  return { root, mesh, bones, dims: d, material };
}
