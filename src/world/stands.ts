import * as THREE from 'three';
import { ARENA, COURT } from '../config';
import { Rng } from '../core/mathx';
import { boxBetween, mergeGeometries } from './geo';
import { makeCrowdAtlas, makeRibbonTexture, makeWallTexture } from './textures';

/**
 * The bowl round the court: a lower tier behind the boards, a walkway, an
 * upper tier on a balcony, seats, the crowd, the walls and the roof.
 * Everything is a rectangle round the free zone, so a row is four straight runs.
 */

export interface Bowl {
  crowd: THREE.ShaderMaterial;
  /** half-size and height of the hall */
  halfX: number;
  halfZ: number;
  height: number;
}

interface Seat {
  x: number;
  y: number;
  z: number;
  rot: number;
  /** how brightly this part of the stands is lit */
  light: number;
}

export function buildBowl(group: THREE.Group): Bowl {
  const B = ARENA.bowl;
  const X0 = COURT.halfWidth + COURT.freeZoneSide + B.setback;
  const Z0 = COURT.halfLength + COURT.freeZoneEnd + B.setback;
  const concrete: THREE.BufferGeometry[] = [];
  const dark: THREE.BufferGeometry[] = [];
  const rails: THREE.BufferGeometry[] = [];
  const seats: Seat[] = [];
  const rng = new Rng(5);

  /** four boxes that make a rectangular ring `d0`..`d1` out from the court zone, between two heights */
  const ring = (out: THREE.BufferGeometry[], d0: number, d1: number, y0: number, y1: number) => {
    for (const s of [-1, 1]) {
      out.push(boxBetween(s * (X0 + d0), y0, -(Z0 + d1), s * (X0 + d1), y1, Z0 + d1));
      out.push(boxBetween(-(X0 + d0), y0, s * (Z0 + d0), X0 + d0, y1, s * (Z0 + d1)));
    }
  };

  /** seats along the four runs of one row: the long sides take the corners, the ends fit between them */
  const seatRow = (d: number, y: number, depth: number, light: number) => {
    const at = d + depth * 0.5;
    const runs: { len: number; place: (along: number) => Seat }[] = [];
    for (const s of [-1, 1]) {
      runs.push({ len: 2 * (Z0 + at), place: (a) => ({ x: s * (X0 + at), y, z: a, rot: s > 0 ? -Math.PI / 2 : Math.PI / 2, light }) });
      runs.push({ len: 2 * (X0 + at) - 1.2, place: (a) => ({ x: a, y, z: s * (Z0 + at), rot: s > 0 ? Math.PI : 0, light }) });
    }
    const block = B.aisleEvery + B.aisleSeats;
    for (const run of runs) {
      const n = Math.floor(run.len / B.seatPitch);
      // aisles sit symmetrically about the middle of the run
      const shift = Math.floor((n % block) / 2) + Math.floor(B.aisleEvery / 2);
      for (let i = 0; i < n; i++) {
        if ((i + block - shift) % block >= B.aisleEvery) continue;
        seats.push(run.place(-run.len / 2 + (i + 0.5) * (run.len / n)));
      }
    }
  };

  // ---------------------------------------------------------------- lower tier
  const L = B.lower;
  for (let r = 0; r < L.rows; r++) {
    const y = L.base + r * L.rise;
    ring(r % 2 ? concrete : dark, r * L.depth, (r + 1) * L.depth + 0.01, 0, y);
    seatRow(r * L.depth, y, L.depth, lerp(B.light.front, B.light.back, r / (L.rows - 1)));
  }
  // rail on the front wall
  ring(rails, -0.04, 0.02, L.base, L.base + 0.07);
  const dL = L.rows * L.depth;
  const yL = L.base + (L.rows - 1) * L.rise;
  // walkway behind the lower tier, and the wall at its back (under the balcony)
  ring(concrete, dL, dL + B.walkway + 0.4, 0, yL);
  const U = B.upper;
  const dU = dL + B.walkway;
  const yU = yL + U.lift;
  ring(dark, dU, dU + 0.4, yL, yU);
  // ---------------------------------------------------------------- upper tier, on a balcony that overhangs the walkway
  for (let r = 0; r < U.rows; r++) {
    const y = yU + r * U.rise;
    ring(r % 2 ? concrete : dark, dU + r * U.depth - (r === 0 ? B.overhang : 0), dU + (r + 1) * U.depth + 0.01, yU - 0.5, y);
    seatRow(dU + r * U.depth, y, U.depth, lerp(B.light.upperFront, B.light.upperBack, r / (U.rows - 1)));
  }
  // parapet, and the hall wall behind the top row
  ring(dark, dU - B.overhang - 0.12, dU - B.overhang, yU - 0.9, yU + 0.55);
  ring(rails, dU - B.overhang - 0.14, dU - B.overhang + 0.02, yU + 0.55, yU + 0.62);
  const dTop = dU + U.rows * U.depth;
  const halfX = X0 + dTop + 0.6;
  const halfZ = Z0 + dTop + 0.6;
  const height = Math.max(COURT.ceiling + 4.5, yU + U.rows * U.rise + 3.2);

  // the dark structure and the seats are left out of the floor's mirror image (they would cost a second
  // drawing of every seat for almost nothing: the crowd, the ribbon and the boards are what shows in the varnish)
  const structure = [
    new THREE.Mesh(mergeGeometries(concrete), new THREE.MeshStandardMaterial({ color: 0x3a4152, roughness: 0.9 })),
    new THREE.Mesh(mergeGeometries(dark), new THREE.MeshStandardMaterial({ color: 0x232838, roughness: 0.9 })),
    new THREE.Mesh(mergeGeometries(rails), new THREE.MeshStandardMaterial({ color: 0xaab2c2, roughness: 0.35, metalness: 0.7 })),
  ];
  for (const m of structure) m.userData.noMirror = true;
  group.add(...structure);

  // ---------------------------------------------------------------- LED ribbon on the balcony front
  {
    const tex = makeRibbonTexture();
    const geos: THREE.BufferGeometry[] = [];
    const d = dU - B.overhang - 0.13;
    const y0 = yU - 0.72;
    const y1 = yU + 0.3;
    for (const s of [-1, 1]) {
      const a = new THREE.PlaneGeometry(2 * (Z0 + d), y1 - y0);
      scaleU(a, (2 * (Z0 + d)) / 16);
      a.rotateY((-s * Math.PI) / 2);
      a.translate(s * (X0 + d), (y0 + y1) / 2, 0);
      const b = new THREE.PlaneGeometry(2 * (X0 + d), y1 - y0);
      scaleU(b, (2 * (X0 + d)) / 16);
      if (s > 0) b.rotateY(Math.PI);
      b.translate(0, (y0 + y1) / 2, s * (Z0 + d));
      geos.push(a, b);
    }
    const mat = new THREE.MeshBasicMaterial({ map: tex, color: new THREE.Color().setScalar(B.ribbon) });
    group.add(new THREE.Mesh(mergeGeometries(geos), mat));
  }

  // ---------------------------------------------------------------- doorways off the walkway (lit from the concourse behind)
  {
    const geos: THREE.BufferGeometry[] = [];
    const d = dU - 0.02;
    const h = Math.min(2.3, U.lift - 0.5);
    const door = (len: number, place: (g: THREE.BufferGeometry, along: number) => void) => {
      const n = Math.max(1, Math.round(len / B.doorEvery));
      for (let i = 0; i < n; i++) {
        const g = new THREE.PlaneGeometry(1.7, h);
        place(g, -len / 2 + (i + 0.5) * (len / n));
        geos.push(g);
      }
    };
    for (const s of [-1, 1]) {
      door(2 * Z0, (g, a) => {
        g.rotateY((-s * Math.PI) / 2);
        g.translate(s * (X0 + d), yL + h / 2, a);
      });
      door(2 * X0, (g, a) => {
        if (s > 0) g.rotateY(Math.PI);
        g.translate(a, yL + h / 2, s * (Z0 + d));
      });
    }
    group.add(
      new THREE.Mesh(
        mergeGeometries(geos),
        new THREE.MeshBasicMaterial({ color: new THREE.Color(0.95, 0.7, 0.42).multiplyScalar(B.doorGlow) }),
      ),
    );
  }

  // ---------------------------------------------------------------- seats
  {
    const pan = new THREE.BoxGeometry(0.44, 0.07, 0.4);
    pan.translate(0, 0.36, 0.02);
    const back = new THREE.BoxGeometry(0.44, 0.46, 0.06);
    back.translate(0, 0.6, -0.21);
    const geo = mergeGeometries([pan, back]);
    const mesh = new THREE.InstancedMesh(geo, new THREE.MeshStandardMaterial({ color: 0xffffff, roughness: 0.55 }), seats.length);
    const m = new THREE.Matrix4();
    const q = new THREE.Quaternion();
    const up = new THREE.Vector3(0, 1, 0);
    const one = new THREE.Vector3(1, 1, 1);
    const p = new THREE.Vector3();
    const c = new THREE.Color();
    const tint = new THREE.Color(B.seatColor);
    seats.forEach((s, i) => {
      // seats face the court: the back is behind the sitter
      q.setFromAxisAngle(up, s.rot);
      m.compose(p.set(s.x, s.y, s.z), q, one);
      mesh.setMatrixAt(i, m);
      mesh.setColorAt(i, c.copy(tint).multiplyScalar(0.85 + 0.3 * rng.next()));
    });
    mesh.frustumCulled = false;
    mesh.userData.noMirror = true;
    group.add(mesh);
  }

  // ---------------------------------------------------------------- crowd
  const crowd = buildCrowd(
    group,
    seats.filter(() => rng.next() > B.empty),
  );

  // ---------------------------------------------------------------- hall: walls, roof, lights, scoreboard
  {
    const wall = new THREE.Mesh(
      new THREE.BoxGeometry(halfX * 2, height, halfZ * 2),
      new THREE.MeshBasicMaterial({ map: makeWallTexture(), side: THREE.BackSide }),
    );
    wall.position.y = height / 2 - 0.01;
    group.add(wall);
    // roof trusses with the light banks hung under them
    const trussMat = new THREE.MeshStandardMaterial({ color: 0x2a2e38, roughness: 0.6, metalness: 0.4 });
    const trusses: THREE.BufferGeometry[] = [];
    const banks: THREE.BufferGeometry[] = [];
    const cans: THREE.BufferGeometry[] = [];
    const lg = new THREE.PlaneGeometry(2.2, 0.6);
    lg.rotateX(Math.PI / 2);
    const yTruss = height - 1.1;
    for (let i = -3; i <= 3; i++) {
      trusses.push(boxBetween(-halfX, yTruss, i * 5 - 0.16, halfX, yTruss + 0.38, i * 5 + 0.16));
      trusses.push(boxBetween(-halfX, yTruss + 0.9, i * 5 - 0.1, halfX, yTruss + 1.05, i * 5 + 0.1));
      for (const sx of [-6, -2, 2, 6]) {
        const g = lg.clone();
        g.translate(sx, yTruss - 0.32, i * 5);
        banks.push(g);
        cans.push(boxBetween(sx - 1.2, yTruss - 0.3, i * 5 - 0.38, sx + 1.2, yTruss, i * 5 + 0.38));
      }
    }
    for (const sx of [-2, 2])
      for (const s of [-1, 1]) trusses.push(boxBetween(s * 4 + sx - 0.12, yTruss, -17, s * 4 + sx + 0.12, yTruss + 0.3, 17));
    const roof = new THREE.Mesh(mergeGeometries([...trusses, ...cans]), trussMat);
    roof.userData.noMirror = true;
    group.add(roof);
    // (the lamps are left out of the floor's mirror image: seen in the varnish they would glare over the court)
    const lamps = new THREE.Mesh(mergeGeometries(banks), new THREE.MeshBasicMaterial({ color: new THREE.Color().setScalar(B.lamp) }));
    lamps.userData.noMirror = true;
    group.add(lamps);
    // centre-hung scoreboard
    const sbY = height - 4.4;
    const sb = new THREE.Mesh(
      new THREE.BoxGeometry(4.6, 2.6, 4.6),
      new THREE.MeshStandardMaterial({ color: 0x0c0e14, roughness: 0.5, metalness: 0.6 }),
    );
    sb.position.set(0, sbY, 0);
    group.add(sb);
    const screens: THREE.BufferGeometry[] = [];
    for (let k = 0; k < 4; k++) {
      const a = (k * Math.PI) / 2;
      const g = new THREE.PlaneGeometry(4.2, 2.2);
      scaleU(g, 4.2 / 16);
      g.rotateY(a);
      g.translate(Math.sin(a) * 2.32, sbY, Math.cos(a) * 2.32);
      screens.push(g);
    }
    group.add(
      new THREE.Mesh(
        mergeGeometries(screens),
        new THREE.MeshBasicMaterial({ map: makeRibbonTexture(), color: new THREE.Color().setScalar(B.ribbon * 1.2) }),
      ),
    );
    for (const s of [-1, 1]) for (const t of [-1, 1]) group.add(cable(s * 2, t * 2, sbY + 1.3, yTruss));
    // banners over the long sides, hung from the roof in front of the upper tier
    const colors = [0xd23a2a, 0x2456c8, 0xf2b632, 0x22a06b, 0xe8e8e8];
    const brng = new Rng(3);
    const byColor = new Map<number, THREE.BufferGeometry[]>();
    for (const s of [-1, 1]) {
      for (let i = -4; i <= 4; i++) {
        const c = colors[Math.floor(brng.next() * colors.length)];
        const g = new THREE.PlaneGeometry(1.5, 3.4);
        g.rotateY((-s * Math.PI) / 2);
        g.translate(s * (X0 + dU + 1.2), height - 3.1, i * 4.4);
        if (!byColor.has(c)) byColor.set(c, []);
        byColor.get(c)!.push(g);
      }
    }
    for (const [c, geos] of byColor) {
      group.add(
        new THREE.Mesh(mergeGeometries(geos), new THREE.MeshStandardMaterial({ color: c, roughness: 0.9, side: THREE.DoubleSide })),
      );
    }
  }

  return { crowd, halfX, halfZ, height };
}

function cable(x: number, z: number, y0: number, y1: number): THREE.Mesh {
  const m = new THREE.Mesh(new THREE.CylinderGeometry(0.02, 0.02, y1 - y0, 6), new THREE.MeshBasicMaterial({ color: 0x15171c }));
  m.position.set(x, (y0 + y1) / 2, z);
  return m;
}

/** repeat a plane's texture `n` times along its width */
function scaleU(g: THREE.BufferGeometry, n: number): void {
  const uv = g.attributes.uv as THREE.BufferAttribute;
  for (let i = 0; i < uv.count; i++) uv.setX(i, uv.getX(i) * n);
}

const lerp = (a: number, b: number, t: number) => a + (b - a) * t;

/** every fan is one quad from a sprite atlas, drawn in one call; they sway, and jump when the crowd is excited */
function buildCrowd(group: THREE.Group, seats: Seat[]): THREE.ShaderMaterial {
  const { tex, cols, rows } = makeCrowdAtlas();
  const w = 0.56;
  const h = 0.84;
  const geo = new THREE.PlaneGeometry(w, h);
  geo.translate(0, h / 2 + 0.3, 0);
  const inst = new THREE.InstancedBufferGeometry();
  inst.index = geo.index;
  inst.attributes.position = geo.attributes.position;
  inst.attributes.uv = geo.attributes.uv;
  const n = seats.length;
  const offsets = new Float32Array(n * 4); // x y z rot
  const params = new Float32Array(n * 4); // atlas idx, phase, light, energy
  const rng = new Rng(77);
  seats.forEach((s, i) => {
    offsets.set([s.x, s.y, s.z, s.rot + rng.range(-0.12, 0.12)], i * 4);
    params.set(
      [Math.floor(rng.next() * cols * rows), rng.range(0, Math.PI * 2), s.light * rng.range(0.8, 1.15), rng.range(0.4, 1.2)],
      i * 4,
    );
  });
  inst.setAttribute('aOffset', new THREE.InstancedBufferAttribute(offsets, 4));
  inst.setAttribute('aParams', new THREE.InstancedBufferAttribute(params, 4));
  inst.instanceCount = n;
  const mat = new THREE.ShaderMaterial({
    uniforms: {
      uTex: { value: tex },
      uGrid: { value: new THREE.Vector2(cols, rows) },
      uTime: { value: 0 },
      uExcite: { value: 0 },
      uTint: { value: new THREE.Color(ARENA.bowl.crowdTint) },
    },
    vertexShader: /* glsl */ `
      attribute vec4 aOffset;
      attribute vec4 aParams;
      uniform float uTime;
      uniform float uExcite;
      uniform vec2 uGrid;
      varying vec2 vUv;
      varying float vLight;
      void main() {
        float idx = aParams.x;
        float col = mod(idx, uGrid.x);
        float row = floor(idx / uGrid.x);
        vUv = (uv + vec2(col, uGrid.y - 1.0 - row)) / uGrid;
        vLight = aParams.z;
        float idle = sin(uTime * (1.3 + aParams.w) + aParams.y) * 0.015;
        float jump = max(0.0, sin(uTime * (7.0 + aParams.w * 3.0) + aParams.y)) * 0.28 * uExcite * aParams.w;
        vec3 p = position;
        p.y += idle + jump;
        float c = cos(aOffset.w), s = sin(aOffset.w);
        vec3 r = vec3(p.x * c + p.z * s, p.y, -p.x * s + p.z * c);
        vec3 world = r + aOffset.xyz;
        gl_Position = projectionMatrix * viewMatrix * vec4(world, 1.0);
      }
    `,
    fragmentShader: /* glsl */ `
      uniform sampler2D uTex;
      uniform vec3 uTint;
      varying vec2 vUv;
      varying float vLight;
      void main() {
        vec4 c = texture2D(uTex, vUv);
        if (c.a < 0.5) discard;
        // the stands sit in the spill of the court lights: dimmer than the floor, cooler, a little washed out
        float l = dot(c.rgb, vec3(0.3, 0.6, 0.1));
        vec3 rgb = mix(vec3(l), c.rgb, 0.78) * uTint;
        gl_FragColor = vec4(rgb * vLight, 1.0);
        #include <colorspace_fragment>
      }
    `,
  });
  const mesh = new THREE.Mesh(inst, mat);
  mesh.frustumCulled = false;
  group.add(mesh);
  return mat;
}
