import * as THREE from 'three';
import { smoothstep } from '../core/mathx';
import { FACE, faceUV, numberUV } from './kitTexture';
import { MeshBuilder, radial, tube, type Ring, type Weights } from './meshBuilder';
import type { BoneName, Kit, RigDims } from './rig';

/**
 * The athlete's surface, sculpted in the rest pose (arms down, palms to the
 * thighs; x right, y up, -z forward). Body parts are lofted tubes with
 * anatomical cross-sections; clothes are separate shells with real hems, so
 * nothing shows through at a sleeve or a short leg; the head is one sculpted
 * surface under a hair shell. Every number is a fraction of standing height.
 */

/** surface roughness per material */
const ROUGH = { skin: 0.56, cloth: 0.84, shoe: 0.46, sole: 0.72, hair: 0.62, pad: 0.9, tape: 0.8 };

const V = (x: number, y: number, z: number) => new THREE.Vector3(x, y, z);
const lerpV = (a: THREE.Vector3, b: THREE.Vector3, t: number) => a.clone().lerp(b, t);
const shade = (c: THREE.Color, k: number) => c.clone().multiplyScalar(k);

export function sculptBody(d: RigDims, kit: Kit, idx: (n: BoneName) => number, wp: (n: BoneName) => THREE.Vector3): THREE.BufferGeometry {
  const H = d.H;
  /** body radii carry the athlete's build */
  const B = kit.build;
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

  const Hi = idx('hips');
  const Sp = idx('spine');
  const Ch = idx('chest');
  const Nk = idx('neck');
  const Hd = idx('head');

  /** ring radii in H, scaled by build */
  const ring = (
    c: THREE.Vector3,
    rx: number,
    rf: number,
    rb: number,
    color: Ring['color'],
    w: Ring['w'],
    extra: Partial<Ring> = {},
  ): Ring => ({
    c,
    rx: rx * H * B,
    rf: rf * H * B,
    rb: rb * H * B,
    color,
    w,
    ...extra,
  });
  /** the same cross-section a little larger or smaller (a cloth shell over skin, or the lip that closes it) */
  const grown = (r: Ring, by: number, over: Partial<Ring> = {}): Ring => ({
    ...r,
    rx: r.rx + by * H,
    rf: r.rf + by * H,
    rb: (r.rb ?? r.rf) + by * H,
    crease: false,
    ...over,
  });

  // ================================================================ legs
  for (const s of [-1, 1] as const) {
    const L = s < 0 ? 'L' : 'R';
    const T = idx(`thigh${L}` as BoneName);
    const S = idx(`shin${L}` as BoneName);
    const F = idx(`foot${L}` as BoneName);
    const hip = wp(`thigh${L}` as BoneName);
    const knee = wp(`shin${L}` as BoneName);
    const ankle = wp(`foot${L}` as BoneName);
    const th = (t: number) => lerpV(hip, knee, t);
    const sh = (t: number) => lerpV(knee, ankle, t);
    const kneeW = (kT: number): Weights => [
      [T, kT],
      [S, 1 - kT],
    ];

    // ---- skin, from under the shorts to the ankle
    b.roughness = ROUGH.skin;
    b.newGroup();
    const leg: Ring[] = [
      ring(th(0.3), 0.047, 0.0495, 0.049, skin, [[T, 1]]),
      ring(th(0.5), 0.0435, 0.047, 0.0445, skin, [[T, 1]]),
      ring(th(0.7), 0.038, 0.0405, 0.0385, skin, [[T, 1]]),
      ring(th(0.84), 0.0338, 0.0345, 0.0335, skin, kneeW(0.92)),
      ring(th(0.93), 0.0318, 0.0335, 0.031, skin, kneeW(0.74)),
      ring(th(1.0), 0.031, 0.0338, 0.0292, skin, kneeW(0.5)),
      ring(sh(0.07), 0.0298, 0.0315, 0.03, skin, kneeW(0.26)),
      ring(sh(0.16), 0.0292, 0.0282, 0.0338, skin, kneeW(0.08)),
      ring(sh(0.3), 0.0288, 0.0264, 0.0382, skin, [[S, 1]]),
      ring(sh(0.46), 0.0255, 0.0242, 0.0335, skin, [[S, 1]]),
      ring(sh(0.64), 0.021, 0.0214, 0.0246, skin, [[S, 1]]),
      ring(sh(0.84), 0.018, 0.0192, 0.02, skin, [[S, 1]]),
      ring(sh(1.0), 0.0176, 0.019, 0.0202, skin, [
        [S, 0.6],
        [F, 0.4],
      ]),
    ];
    tube(b, leg, 16);

    // ---- knee pad: a sleeve with a thicker front
    b.roughness = ROUGH.pad;
    b.newGroup();
    const padRings = [leg[3], leg[4], leg[5], leg[6], leg[7]].map((r, i) =>
      grown(r, 0.0042, { color: pads, rf: r.rf + (0.0042 + [0.002, 0.0065, 0.0085, 0.0065, 0.002][i]) * H }),
    );
    tube(
      b,
      [
        grown(padRings[0], -0.0045),
        padRings[0],
        { ...padRings[0], crease: true },
        ...padRings.slice(1),
        { ...padRings[4], crease: true },
        grown(padRings[4], -0.0045),
      ],
      16,
    );

    // ---- sock: over the calf to the shoe
    b.roughness = ROUGH.cloth;
    b.newGroup();
    const sockTop = ring(sh(0.6), 0.0222, 0.0222, 0.0266, socks, [[S, 1]]);
    tube(
      b,
      [
        grown(sockTop, -0.0026),
        grown(sockTop, 0.0012),
        grown(sockTop, 0.0012, { crease: true }),
        grown(ring(sh(0.63), 0.0213, 0.0216, 0.025, socks, [[S, 1]]), 0.0018),
        grown(leg[11], 0.0018, { color: socks }),
        grown(leg[12], 0.0018, { color: socks }),
      ],
      16,
    );

    // ---- shoe: lofted from heel to toe, flat sole, collar round the ankle
    b.newGroup();
    const floor = -d.ankleY;
    const sole = C(kit.sole);
    const midsole = C(0xf1f1ee);
    const accent = C(kit.shoeAccent);
    // [z, half width, top, toe spring, squareness]
    const stations: [number, number, number, number, number][] = [
      [0.0445, 0.011, -0.012, 0.007, 2.3],
      [0.0425, 0.0195, 0.002, 0.003, 2.5],
      [0.036, 0.0245, 0.012, 0.0005, 2.7],
      [0.02, 0.0268, 0.0185, 0, 2.8],
      [0.002, 0.0276, 0.0185, 0, 2.8],
      [-0.016, 0.0288, 0.0115, 0, 2.8],
      [-0.034, 0.03, 0.001, 0, 2.9],
      [-0.054, 0.031, -0.0085, 0.0005, 3.0],
      [-0.074, 0.031, -0.0135, 0.0015, 3.0],
      [-0.089, 0.0292, -0.016, 0.003, 2.9],
      [-0.0995, 0.0252, -0.018, 0.005, 2.7],
      [-0.106, 0.0175, -0.021, 0.0075, 2.5],
      [-0.1085, 0.009, -0.0245, 0.0095, 2.3],
    ];
    // every stretch between two stations is coloured as one piece (stations are doubled), so panels have sharp edges
    const shoe: Ring[] = [];
    stations.forEach(([z, w, top, spring, e], i) => {
      const bot = floor / H + spring;
      const mid = (top + bot) / 2;
      const at = (zc: number): Ring => ({
        c: V(ankle.x, ankle.y + mid * H, ankle.z + z * H),
        rx: w * H,
        rf: (top - mid) * H,
        rb: (mid - bot) * H,
        e,
        // outsole, a white midsole, then the upper: toe cap and heel counter in the accent, a dark tongue
        color: (cs: number, fr: number) => {
          const y = mid + fr * (fr > 0 ? top - mid : mid - bot);
          if (y < bot + 0.0045) return sole;
          if (y < bot + 0.0125) return midsole;
          if (zc < -0.089 || zc > 0.036) return accent;
          if (fr > 0.9 && zc < -0.016 && zc > -0.074) return shade(shoes, 0.5);
          return shoes;
        },
        w: [[F, 1]] as Weights,
      });
      if (i > 0) shoe.push(at((z + stations[i - 1][0]) / 2));
      if (i < stations.length - 1) shoe.push(at((z + stations[i + 1][0]) / 2));
    });
    b.roughness = ROUGH.shoe;
    tube(b, shoe, 16, { front: V(0, 1, 0), capStart: true, capEnd: true, crisp: true });

    // ---- shorts leg: loose over the thigh, a real hem
    b.roughness = ROUGH.cloth;
    b.newGroup();
    const stripe = (cs: number, fr: number) => (cs * s > 0.9 && Math.abs(fr) < 0.45 ? trim : shorts);
    const hem = ring(th(0.44), 0.0508, 0.0525, 0.0535, trim, [[T, 1]]);
    const short: Ring[] = [
      ring(th(0.02).add(V(-s * 0.006 * H, 0, 0)), 0.04, 0.05, 0.057, stripe, [[Hi, 1]]),
      ring(th(0.1).add(V(-s * 0.002 * H, 0, 0)), 0.0478, 0.0525, 0.0585, stripe, [
        [Hi, 0.62],
        [T, 0.38],
      ]),
      ring(th(0.24), 0.0502, 0.053, 0.056, stripe, [
        [Hi, 0.16],
        [T, 0.84],
      ]),
      ring(th(0.4), 0.0508, 0.0525, 0.054, stripe, [[T, 1]]),
      ring(th(0.4), 0.0508, 0.0525, 0.054, trim, [[T, 1]]),
      hem,
      { ...hem, crease: true, color: shade(shorts, 0.45) },
      grown(ring(th(0.425), 0.0448, 0.048, 0.0462, shade(shorts, 0.45), [[T, 1]]), 0.0006),
    ];
    tube(b, short, 16, { crisp: true });
  }

  // ================================================================ pelvis (shorts)
  {
    b.roughness = ROUGH.cloth;
    b.newGroup();
    const y = (v: number) => V(0, v * H, 0.003 * H);
    const wHip: Weights = [[Hi, 1]];
    tube(
      b,
      [
        ring(y(0.6), 0.0745, 0.053, 0.0545, shorts, [
          [Hi, 0.55],
          [Sp, 0.45],
        ]),
        ring(y(0.565), 0.081, 0.0555, 0.059, shorts, wHip),
        ring(y(0.535), 0.089, 0.058, 0.0645, shorts, wHip),
        ring(y(0.505), 0.094, 0.059, 0.0675, shorts, wHip),
        ring(y(0.485), 0.091, 0.057, 0.064, shorts, wHip),
        ring(y(0.47), 0.074, 0.049, 0.055, shorts, wHip),
        ring(y(0.461), 0.042, 0.034, 0.038, shorts, wHip),
      ].reverse(),
      24,
      { capStart: true },
    );
  }

  // ================================================================ torso (jersey)
  {
    b.roughness = ROUGH.cloth;
    b.newGroup();
    const ClL = idx('clavL');
    const ClR = idx('clavR');
    const wT = (p: THREE.Vector3): Weights => {
      const y = p.y / H;
      const x = Math.abs(p.x) / H;
      const t1 = smoothstep(0.555, 0.63, y);
      const t2 = smoothstep(0.685, 0.765, y);
      const cl = smoothstep(0.045, 0.095, x) * smoothstep(0.772, 0.815, y) * 0.7;
      const nk = smoothstep(0.852, 0.872, y) * 0.4 * (1 - smoothstep(0.03, 0.06, x));
      const ch = t2 * (1 - cl) * (1 - nk);
      return [
        [Hi, 1 - t1],
        [Sp, t1 * (1 - t2)],
        [Ch, ch],
        [p.x < 0 ? ClL : ClR, t2 * cl],
        [Nk, t2 * (1 - cl) * nk],
      ];
    };
    // the number: small on the chest, large on the back
    const num = (cs: number, fr: number, p: THREE.Vector3): readonly [number, number] =>
      fr > 0 ? numberUV(-p.x / (0.036 * H), (p.y - 0.752 * H) / (0.0325 * H)) : numberUV(p.x / (0.066 * H), (p.y - 0.735 * H) / (0.06 * H));
    const body = (cs: number) => (Math.abs(cs) > 0.93 ? trim : jersey);
    // [y, rx, rf, rb, colour, forward tilt of the ring (collar), z]
    const rows: [number, number, number, number, Ring['color'], number?, number?][] = [
      [0.526, 0.0965, 0.0635, 0.0695, body],
      [0.56, 0.0905, 0.061, 0.0665, body],
      [0.6, 0.082, 0.0578, 0.0592, body],
      [0.645, 0.0815, 0.0585, 0.058, body],
      [0.695, 0.0885, 0.0645, 0.0605, body],
      [0.74, 0.095, 0.0692, 0.0645, body],
      [0.772, 0.0985, 0.0676, 0.0665, body],
      [0.772, 0.0985, 0.0676, 0.0665, jersey],
      [0.8, 0.102, 0.063, 0.0662, jersey],
      [0.822, 0.1045, 0.0565, 0.064, jersey, 0.05],
      [0.8375, 0.0985, 0.049, 0.0585, jersey, 0.12],
      [0.849, 0.078, 0.0425, 0.0505, jersey, 0.2],
      [0.857, 0.056, 0.0375, 0.043, jersey, 0.27],
      [0.8625, 0.0425, 0.0348, 0.039, jersey, 0.31],
      [0.8625, 0.0425, 0.0348, 0.039, trim, 0.31],
      [0.869, 0.0385, 0.0328, 0.0362, trim, 0.33],
    ];
    const mk = ([y, rx, rf, rb, color, tilt = 0]: (typeof rows)[number], over: Partial<Ring> = {}): Ring => ({
      ...ring(V(0, y * H, 0.003 * H), rx, rf, rb, color, wT, { e: 2.35, uv: num }),
      n: V(0, Math.cos(tilt), -Math.sin(tilt)),
      ...over,
    });
    const hemIn = shade(jersey, 0.45);
    const top = rows[rows.length - 1];
    tube(
      b,
      [
        // hem: closed up to the shorts underneath
        mk([0.53, 0.09, 0.0585, 0.065, hemIn], { uv: undefined }),
        mk([0.526, 0.0965, 0.0635, 0.0695, hemIn], { uv: undefined }),
        mk(rows[0], { crease: true }),
        ...rows.slice(1).map((r) => mk(r)),
        // collar: rolled over, then down inside to the neck
        mk(top, { crease: true, color: shade(trim, 0.6), uv: undefined }),
        mk([0.857, 0.0318, 0.0288, 0.0316, shade(trim, 0.6), 0.33], { uv: undefined }),
      ],
      32,
      { crisp: true },
    );
  }

  // ================================================================ arms
  for (const s of [-1, 1] as const) {
    const L = s < 0 ? 'L' : 'R';
    const U = idx(`upperArm${L}` as BoneName);
    const Lo = idx(`lowerArm${L}` as BoneName);
    const Ha = idx(`hand${L}` as BoneName);
    const Fi = idx(`fingers${L}` as BoneName);
    const shd = wp(`upperArm${L}` as BoneName);
    const elb = wp(`lowerArm${L}` as BoneName);
    const wr = wp(`hand${L}` as BoneName);
    const ua = (t: number) => lerpV(shd, elb, t);
    const fa = (t: number) => lerpV(elb, wr, t);
    const elbW = (kU: number): Weights => [
      [U, kU],
      [Lo, 1 - kU],
    ];

    // ---- skin, from under the sleeve to the wrist
    b.roughness = ROUGH.skin;
    b.newGroup();
    const arm: Ring[] = [
      ring(ua(0.22), 0.0282, 0.0286, 0.0296, skin, [[U, 1]]),
      ring(ua(0.42), 0.0274, 0.03, 0.0288, skin, [[U, 1]]),
      ring(ua(0.62), 0.0252, 0.0274, 0.0266, skin, [[U, 1]]),
      ring(ua(0.8), 0.022, 0.0234, 0.0236, skin, elbW(0.92)),
      ring(ua(0.92), 0.0204, 0.021, 0.0224, skin, elbW(0.74)),
      ring(ua(1.0), 0.02, 0.0204, 0.0224, skin, elbW(0.5)),
      ring(fa(0.08), 0.021, 0.0212, 0.0218, skin, elbW(0.26)),
      ring(fa(0.18), 0.0222, 0.0218, 0.0214, skin, elbW(0.08)),
      ring(fa(0.32), 0.0224, 0.0212, 0.021, skin, [[Lo, 1]]),
      ring(fa(0.55), 0.0192, 0.0184, 0.0182, skin, [[Lo, 1]]),
      ring(fa(0.78), 0.0152, 0.0158, 0.0156, skin, [[Lo, 1]]),
      ring(fa(0.93), 0.0124, 0.0154, 0.0153, skin, [
        [Lo, 0.7],
        [Ha, 0.3],
      ]),
      ring(fa(1.0), 0.0114, 0.0152, 0.015, skin, [
        [Lo, 0.4],
        [Ha, 0.6],
      ]),
    ];
    tube(b, arm, 14);

    // ---- sleeve: a ball at the shoulder joint (it turns with the arm and never opens), a cuff with a hem
    b.roughness = ROUGH.cloth;
    b.newGroup();
    const R = 0.0325;
    // flatter than a ball on top, so the shoulder line runs from the neck over the joint without a bump
    const dome = (k: number) => {
      const r = R * Math.sqrt(Math.max(0, 1 - k * k));
      return ring(V(shd.x, shd.y + k * 0.0225 * H * B, shd.z), r, r, r, jersey, [[U, 1]]);
    };
    const cuff = ring(ua(0.4), 0.0322, 0.034, 0.0334, trim, [[U, 1]]);
    tube(
      b,
      [
        dome(0.985),
        dome(0.92),
        dome(0.76),
        dome(0.52),
        dome(0.24),
        ring(ua(0.015), 0.0325, 0.0325, 0.0325, jersey, [[U, 1]]),
        ring(ua(0.1), 0.0336, 0.0338, 0.034, jersey, [[U, 1]]),
        ring(ua(0.22), 0.0334, 0.0344, 0.0344, jersey, [[U, 1]]),
        ring(ua(0.34), 0.0324, 0.034, 0.0334, jersey, [[U, 1]]),
        ring(ua(0.34), 0.0324, 0.034, 0.0334, trim, [[U, 1]]),
        cuff,
        { ...cuff, crease: true, color: shade(jersey, 0.45) },
        grown(ring(ua(0.385), 0.0276, 0.0296, 0.0288, shade(jersey, 0.45), [[U, 1]]), 0.0005),
      ],
      16,
      { capStart: true },
    );

    // ---- hand. Local frame: fingers along -y, thumb forward (-z), palm facing the body (-s x)
    b.roughness = ROUGH.skin;
    b.newGroup();
    const hp = (x: number, y: number, z: number) => V(wr.x + x * H, wr.y + y * H, wr.z + z * H);
    const wHa: Weights = [[Ha, 1]];
    const palmRing = (y: number, rx: number, rf: number, rb: number, x = 0): Ring => ({
      c: hp(x, y, 0),
      rx: rx * H,
      rf: rf * H,
      rb: rb * H,
      e: 2.7,
      color: skin,
      w: wHa,
    });
    tube(
      b,
      [
        palmRing(0.006, 0.0108, 0.0146, 0.0144),
        palmRing(-0.006, 0.0112, 0.0182, 0.017),
        palmRing(-0.02, 0.0126, 0.0232, 0.0205, -s * 0.0008),
        palmRing(-0.036, 0.0118, 0.0236, 0.0222),
        palmRing(-0.0485, 0.0102, 0.0228, 0.022),
        palmRing(-0.0545, 0.0074, 0.0212, 0.0204),
        palmRing(-0.0575, 0.0034, 0.018, 0.0172),
      ],
      14,
      { capEnd: true },
    );
    // fingers: index, middle, ring, little. Slightly spread, a relaxed curl towards the palm.
    const knY = -d.knuckle / H;
    const fingers: [number, number, number, number][] = [
      // [z at the knuckle, length, radius, splay (rad, + = towards the little finger)]
      [-0.0162, 0.0375, 0.0052, -0.1],
      [-0.0054, 0.0415, 0.0054, -0.025],
      [0.0054, 0.0385, 0.005, 0.05],
      [0.0158, 0.0305, 0.0044, 0.14],
    ];
    const tape = C(0xf2efe6);
    fingers.forEach(([z0, len, rad, splay], fi) => {
      const taped = kit.tape > 0 && (fi === 1 || (kit.tape > 1 && fi === 2));
      const rings: Ring[] = [];
      const pos = V(0, knY + 0.004, z0);
      const n = 6;
      let curl = 0.05;
      for (let k = 0; k <= n; k++) {
        const t = k / n;
        // direction of this stretch of the finger: down, splayed, curling to the palm
        const dir = V(-s * Math.sin(curl), -Math.cos(curl) * Math.cos(splay), Math.cos(curl) * Math.sin(splay));
        const r = rad * (k === n ? 0.5 : k === n - 1 ? 0.86 : 1 - 0.14 * t);
        const wF: Weights =
          k === 0
            ? [
                [Ha, 0.75],
                [Fi, 0.25],
              ]
            : k === 1
              ? [
                  [Ha, 0.2],
                  [Fi, 0.8],
                ]
              : [[Fi, 1]];
        rings.push({
          c: hp(pos.x, pos.y, pos.z),
          rx: r * 0.92 * H,
          rf: r * H,
          rb: r * H,
          color: taped && k >= 1 && k <= 3 ? tape : skin,
          w: wF,
          n: dir.clone(),
        });
        const step = (k === n - 1 ? 0.5 : 1) * (len / (n - 0.5));
        pos.addScaledVector(dir, step);
        curl += 0.085;
      }
      b.roughness = taped ? ROUGH.tape : ROUGH.skin;
      tube(b, rings, 8, { capEnd: true });
    });
    b.roughness = ROUGH.skin;
    // thumb: from the heel of the palm, forward and across
    {
      const rings: Ring[] = [];
      const pos = V(-s * 0.002, -0.014, -0.017);
      let dir = V(-s * 0.3, -0.62, -0.72).normalize();
      const radii = [0.0078, 0.0074, 0.0066, 0.006, 0.0054, 0.0046, 0.0026];
      for (let k = 0; k < radii.length; k++) {
        rings.push({
          c: hp(pos.x, pos.y, pos.z),
          rx: radii[k] * H,
          rf: radii[k] * H,
          rb: radii[k] * H,
          color: skin,
          w: wHa,
          n: dir.clone(),
        });
        pos.addScaledVector(dir, (k >= radii.length - 2 ? 0.0032 : 0.0068) * 1);
        // the tip turns back towards the fingers
        dir = dir.add(V(-s * 0.06, -0.12, 0.1)).normalize();
      }
      tube(b, rings, 8, { capEnd: true });
    }
  }

  // ================================================================ neck
  const hc = wp('head').add(V(0, 0.049 * H, -0.007 * H));
  {
    b.roughness = ROUGH.skin;
    b.newGroup();
    const nb = wp('neck');
    const hd = wp('head');
    tube(
      b,
      [
        ring(V(nb.x, nb.y - 0.016 * H, nb.z - 0.002 * H), 0.0318, 0.0288, 0.0312, skin, [
          [Ch, 0.7],
          [Nk, 0.3],
        ]),
        ring(V(nb.x, nb.y + 0.012 * H, nb.z - 0.002 * H), 0.0298, 0.0282, 0.0298, skin, [
          [Ch, 0.25],
          [Nk, 0.75],
        ]),
        ring(lerpV(nb, hd, 0.55), 0.0282, 0.028, 0.029, skin, [[Nk, 1]]),
        ring(V(hd.x, hd.y + 0.006 * H, hd.z - 0.002 * H), 0.0282, 0.0284, 0.029, skin, [
          [Nk, 0.5],
          [Hd, 0.5],
        ]),
        ring(V(hd.x, hd.y + 0.026 * H, hd.z - 0.004 * H), 0.027, 0.027, 0.028, skin, [[Hd, 1]]),
      ],
      14,
    );
  }

  // ================================================================ head
  {
    const a = 0.0432 * H;
    const hb = 0.065 * H;
    const c = 0.054 * H;
    const wH: Weights = [[Hd, 1]];
    const g = (dx: number, dy: number, sx: number, sy: number) => Math.exp(-((dx / sx) ** 2) - (dy / sy) ** 2);
    /** the skull and face surface for a direction from the head centre */
    const skull = (dir: THREE.Vector3, out: THREE.Vector3) => {
      let x = dir.x * a;
      let y = dir.y * hb;
      let z = dir.z * c;
      const front = smoothstep(0.2, -0.35, dir.z);
      const back = smoothstep(-0.1, 0.5, dir.z);
      const low = smoothstep(0.05, -0.9, dir.y);
      // jaw narrower than the cranium, chin narrower still
      x *= 1 - 0.2 * low - 0.1 * low * low * front;
      // temples: the forehead is narrower than the cranium behind it
      x *= 1 - 0.05 * front * smoothstep(0.2, 0.7, dir.y);
      // the face is flatter than a ball, and the chin comes forward under it
      z *= 1 - 0.06 * front * (1 - Math.abs(dir.y));
      z *= 1 + 0.26 * front * smoothstep(-0.3, -0.95, dir.y);
      // the skull tucks in above the neck at the back
      z *= 1 - 0.34 * back * smoothstep(-0.2, -1, dir.y);
      // a flat underside to the jaw
      y *= 1 - 0.09 * smoothstep(-0.72, -1, dir.y);
      // features, in face coordinates (head half-heights)
      const X = x / hb;
      const Y = y / hb;
      const aX = Math.abs(X);
      let push = 0;
      push += 0.0098 * g(X, Y - (FACE.noseY + 0.15), 0.075, 0.21); // bridge
      push += 0.0082 * g(X, Y - FACE.noseY, 0.095, 0.085); // tip
      push += 0.0034 * g(aX - 0.085, Y - (FACE.noseY - 0.035), 0.055, 0.055); // wings
      push += 0.0034 * g(X, Y - (FACE.browY + 0.02), 0.6, 0.07); // brow ridge
      push -= 0.0046 * g(aX - FACE.eyeX, Y - FACE.eyeY, 0.13, 0.085); // eye sockets
      push += 0.0022 * g(aX - 0.42, Y + 0.2, 0.2, 0.17); // cheekbones
      push += 0.0034 * g(X, Y - (FACE.mouthY + 0.005), 0.21, 0.07); // lips
      push -= 0.0016 * g(X, Y - (FACE.mouthY - 0.13), 0.2, 0.05); // under the lower lip
      push += 0.0036 * g(X, Y + 0.85, 0.24, 0.12); // chin
      z -= push * H * front;
      out.set(hc.x + x, hc.y + y, hc.z + z);
    };
    // more columns across the face than round the back
    const lon = (u: number) => 1.5 * Math.PI + 2 * Math.PI * (u - 0.5) - 0.62 * Math.sin(2 * Math.PI * (u - 0.5));
    b.roughness = ROUGH.skin;
    b.newGroup();
    const buzz = kit.hairStyle === 1;
    radial(
      b,
      44,
      40,
      skull,
      (dir, p) => {
        // the face decal is projected from the front; behind the ears it is pushed off the painted area
        let X = -(p.x - hc.x) / hb;
        let Y = (p.y - hc.y) / hb;
        if (dir.z > 0) {
          const r = Math.max(0.05, Math.hypot(X / FACE.halfWidth, Y));
          const k = Math.min(1.12, 2 - r) / r;
          X *= k;
          Y *= k;
        }
        return { color: skin, w: wH, uv: faceUV(X, Y) };
      },
      lon,
    );

    // ---- ears
    for (const s of [-1, 1]) {
      b.newGroup();
      const ec = V(hc.x + s * a * 0.94, hc.y - 0.006 * H, hc.z + 0.008 * H);
      radial(
        b,
        10,
        8,
        (dir, out) => {
          // a shallow shell, tilted back, the lobe a little narrower
          const k = 1 - 0.3 * smoothstep(0, -1, dir.y);
          out.set(
            ec.x + (dir.x * 0.0042 + s * Math.max(0, dir.z) * 0.0038) * H,
            ec.y + dir.y * 0.0142 * H,
            ec.z + (dir.z * 0.0082 * k + dir.y * 0.0028) * H,
          );
        },
        () => ({ color: skin, w: wH }),
      );
    }

    // ---- hair: a shell that grows out of the scalp along the hairline
    const style = kit.hairStyle;
    const hairCol = buzz ? skin.clone().lerp(hair, 0.82) : hair;
    b.roughness = ROUGH.hair;
    b.newGroup();
    /** hairline height (direction y) round the head: `az` is 0 at the front centre, pi at the back */
    const line = (az: number): number => {
      const nodes: [number, number][] = [
        [0, 0.5],
        [35, 0.48],
        [56, 0.38],
        [70, 0.12],
        [79, -0.04],
        [88, 0.19],
        [101, 0.17],
        [113, -0.22],
        [132, -0.5],
        [180, -0.58],
      ];
      const deg = (az * 180) / Math.PI;
      for (let i = 1; i < nodes.length; i++) {
        if (deg <= nodes[i][0]) {
          const t = (deg - nodes[i - 1][0]) / (nodes[i][0] - nodes[i - 1][0]);
          return nodes[i - 1][1] + (nodes[i][1] - nodes[i - 1][1]) * (t * t * (3 - 2 * t));
        }
      }
      return nodes[nodes.length - 1][1];
    };
    const thick = (dir: THREE.Vector3): number => {
      const topness = smoothstep(0.15, 0.85, dir.y);
      const az = Math.atan2(dir.x, -dir.z);
      const lumps = Math.sin(9 * az + dir.y * 6) * Math.sin(8 * dir.y - 2 * az);
      if (style === 1) return 0.0016;
      if (style === 2 || style === 3) return 0.0052 + 0.002 * topness;
      if (style === 4) return (0.0125 + 0.009 * topness) * (1 + 0.16 * lumps);
      // short crop: fuller on top, a lift at the front
      return (0.0056 + 0.0042 * topness + 0.004 * smoothstep(0.3, 0.75, dir.y) * smoothstep(0.1, -0.6, dir.z)) * (1 + 0.07 * lumps);
    };
    // rows run from the hairline up to the crown, so the edge of the hair is a clean curve
    {
      const nrm = new THREE.Vector3();
      const sk = new THREE.Vector3();
      const dir = new THREE.Vector3();
      const p = new THREE.Vector3();
      const colsH = 56;
      const rowsH = 14;
      const base = b.count;
      const rise = style === 4 ? 0.3 : 0.16;
      for (let j = 0; j <= rowsH; j++) {
        // more rows near the hairline, where the shell leaves the scalp
        const t = Math.pow(j / rowsH, 1.6);
        for (let i = 0; i <= colsH; i++) {
          const az = (i / colsH) * Math.PI * 2 - Math.PI; // 0 = front centre
          const y0 = line(Math.abs(az)) - 0.05;
          const y = y0 + (1 - y0) * t;
          const rr = Math.sqrt(Math.max(0, 1 - y * y));
          dir.set(Math.sin(az) * rr, y, -Math.cos(az) * rr);
          skull(dir, sk);
          nrm.set(dir.x / a, dir.y / hb, dir.z / c).normalize();
          const off = -0.003 + (thick(dir) + 0.003) * smoothstep(0, rise, y - y0 - 0.05);
          p.copy(sk).addScaledVector(nrm, off * H);
          b.vert(p, shade(hairCol, 0.86 + 0.26 * smoothstep(0.2, 1, dir.y)), wH);
        }
      }
      for (let j = 0; j < rowsH; j++) {
        for (let i = 0; i < colsH; i++) {
          const q = base + j * (colsH + 1) + i;
          const n = q + colsH + 1;
          // az runs clockwise seen from above: wind the faces outwards
          b.tri(q, n, q + 1);
          if (j < rowsH - 1) b.tri(q + 1, n, n + 1);
        }
      }
    }
    if (style === 2) {
      // bun, high on the back of the head
      b.newGroup();
      const bc = V(hc.x, hc.y + 0.031 * H, hc.z + 0.052 * H);
      radial(
        b,
        14,
        10,
        (dir, out) => out.set(bc.x + dir.x * 0.0225 * H, bc.y + dir.y * 0.021 * H, bc.z + dir.z * 0.0215 * H),
        () => ({ color: hair, w: wH }),
      );
    }
    if (style === 3) {
      // ponytail: tied at the back, hanging to the shoulders
      b.newGroup();
      const tail: [number, number, number, number][] = [
        [0.012, 0.047, 0.006, 1],
        [0.014, 0.058, 0.013, 1],
        [0.002, 0.07, 0.0158, 1],
        [-0.022, 0.076, 0.0152, 0.85],
        [-0.05, 0.075, 0.0132, 0.7],
        [-0.078, 0.07, 0.0102, 0.6],
        [-0.1, 0.064, 0.0062, 0.55],
        [-0.112, 0.061, 0.0022, 0.55],
      ];
      tube(
        b,
        tail.map(([y, z, r, wHead]) => ({
          c: V(hc.x, hc.y + y * H, hc.z + z * H),
          rx: r * H,
          rf: r * 0.85 * H,
          rb: r * 0.85 * H,
          color: hair,
          w: [
            [Hd, wHead],
            [Ch, 1 - wHead],
          ] as Weights,
        })),
        10,
        { capStart: true, capEnd: true },
      );
    }
  }

  return b.build();
}
