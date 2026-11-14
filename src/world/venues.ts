import * as THREE from 'three';
import { COURT, type VenueSpec } from '../config';
import { Rng } from '../core/mathx';
import { boxBetween, mergeGeometries } from './geo';
import { buildBowl, HALL_BOWL } from './stands';

/**
 * What stands round the court in each venue. Everything is built or painted here (no asset files) and
 * nothing here is read by the game: the court, the net and the walls where a ball goes dead stay `COURT`.
 */

function paint(w: number, h: number, draw: (ctx: CanvasRenderingContext2D) => void, repeat = true): THREE.CanvasTexture {
  const c = document.createElement('canvas');
  c.width = w;
  c.height = h;
  draw(c.getContext('2d')!);
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  if (repeat) t.wrapS = t.wrapT = THREE.RepeatWrapping;
  t.anisotropy = 4;
  return t;
}

const lit = (color: number, roughness = 0.85) => new THREE.MeshStandardMaterial({ color, roughness });
const glow = (r: number, g: number, b: number) => new THREE.MeshBasicMaterial({ color: new THREE.Color(r, g, b) });

function add(
  group: THREE.Group,
  geos: THREE.BufferGeometry[],
  mat: THREE.Material,
  opts: { shadow?: boolean; mirror?: boolean } = {},
): THREE.Mesh {
  const m = new THREE.Mesh(mergeGeometries(geos), mat);
  m.castShadow = !!opts.shadow;
  m.receiveShadow = true;
  if (!opts.mirror) m.userData.noMirror = true;
  group.add(m);
  return m;
}

/** a plane lying on the ground */
function ground(x0: number, z0: number, x1: number, z1: number, y: number): THREE.BufferGeometry {
  const g = new THREE.PlaneGeometry(Math.abs(x1 - x0), Math.abs(z1 - z0));
  g.rotateX(-Math.PI / 2);
  g.translate((x0 + x1) / 2, y, (z0 + z1) / 2);
  return g;
}

const EDGE_X = COURT.arenaHalfX;
const EDGE_Z = COURT.arenaHalfZ;

export function buildVenue(group: THREE.Group, env: VenueSpec): THREE.ShaderMaterial | null {
  switch (env.build) {
    case 'hall':
      return buildBowl(group).crowd;
    case 'games':
      return gamesArena(group, env);
    case 'seaside':
      return seaside(group, env);
    case 'gym':
      gym(group);
      return null;
    case 'rooftop':
      return rooftop(group, env);
  }
}

// -------------------------------------------------------------------- games arena
function gamesArena(group: THREE.Group, env: VenueSpec): THREE.ShaderMaterial {
  // one look for the whole building: deep indigo, a coral-to-magenta sweep, warm white, and one motif (rising bands)
  const INDIGO = '#141a5c';
  const sweep = (ctx: CanvasRenderingContext2D, w: number, h: number) => {
    const g = ctx.createLinearGradient(0, 0, w, 0);
    g.addColorStop(0, '#f2765a');
    g.addColorStop(0.5, '#e0457a');
    g.addColorStop(1, '#f2765a');
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, w, h);
  };
  /** the motif: slanted bands that thin out to one side */
  const bands = (ctx: CanvasRenderingContext2D, x0: number, w: number, h: number, color: string, n = 7) => {
    ctx.fillStyle = color;
    for (let i = 0; i < n; i++) {
      const bw = (w / n) * (0.75 - (0.6 * i) / n);
      const x = x0 + (i * w) / n;
      ctx.beginPath();
      ctx.moveTo(x, h);
      ctx.lineTo(x + h * 0.6, 0);
      ctx.lineTo(x + h * 0.6 + bw, 0);
      ctx.lineTo(x + bw, h);
      ctx.fill();
    }
  };
  const FONT = '800 {px}px system-ui, "Helvetica Neue", Arial, sans-serif';
  const ribbonTex = paint(2048, 64, (ctx) => {
    ctx.fillStyle = INDIGO;
    ctx.fillRect(0, 0, 2048, 64);
    for (const x of [0, 1024]) {
      ctx.save();
      ctx.beginPath();
      ctx.rect(x, 0, 420, 64);
      ctx.clip();
      sweep(ctx, 2048, 64);
      ctx.restore();
      bands(ctx, x + 420, 260, 64, '#e0457a');
      ctx.fillStyle = '#ffffff';
      ctx.font = FONT.replace('{px}', '30');
      ctx.textBaseline = 'middle';
      ctx.fillText(x ? 'VOLLEYBALL · FINAL' : 'THE GAMES', x + 30, 34);
    }
    ctx.fillStyle = 'rgba(0,0,0,0.16)';
    for (let y = 0; y < 64; y += 4) ctx.fillRect(0, y, 2048, 1);
  });
  const bowl = buildBowl(group, {
    ...HALL_BOWL,
    crowdLight: env.crowd,
    crowdTint: 0xcdbcff,
    upperRows: 18,
    upperRise: 0.68,
    bareFrom: 7,
    sparkle: 900,
    scoreboard: 0,
    headroom: 8.5,
    lamps: false,
    empty: 0.02,
    seatColor: 0x1c2060,
    ribbonTex,
    ribbonTint: 0xffffff,
    banners: [],
    concrete: 0x262b5c,
    dark: 0x12163a,
  });
  const H = bowl.height;
  const fzX = COURT.halfWidth + COURT.freeZoneSide;
  const fzZ = COURT.halfLength + COURT.freeZoneEnd;

  // the light: one frame hung over the edge of the field of play. The sky over the court itself stays dark and
  // empty, so a set is read against nothing. Kept just under the bloom threshold, like the hall's lamps.
  const ringY = H - 9;
  const rx = fzX + 0.6;
  const rz = fzZ - 1.2;
  const lightGeo: THREE.BufferGeometry[] = [];
  const frame: THREE.BufferGeometry[] = [];
  const strip = (x0: number, z0: number, x1: number, z1: number) => {
    const g = ground(x0, z0, x1, z1, ringY);
    g.rotateZ(Math.PI); // faces down
    g.translate(0, 2 * ringY, 0);
    lightGeo.push(g);
    frame.push(boxBetween(x0 - 0.25, ringY + 0.02, z0 - 0.25, x1 + 0.25, ringY + 0.9, z1 + 0.25));
  };
  const wRing = 1.5;
  for (const s of [-1, 1]) {
    strip(Math.min(s * rx, s * (rx + wRing)), -rz, Math.max(s * rx, s * (rx + wRing)), rz);
    strip(-rx - wRing, Math.min(s * rz, s * (rz + wRing)), rx + wRing, Math.max(s * rz, s * (rz + wRing)));
    for (const t of [-1, 1]) {
      const c = new THREE.CylinderGeometry(0.03, 0.03, H - ringY - 1, 6);
      c.translate(s * (rx + wRing / 2), (H + ringY - 1) / 2 + 0.5, t * (rz - 4));
      frame.push(c);
    }
  }
  add(group, lightGeo, glow(0.95, 0.95, 0.93));
  add(group, frame, new THREE.MeshStandardMaterial({ color: 0x14162a, roughness: 0.5, metalness: 0.5 }));
  // the look carried round the top of the bowl: a band of the motif under the roof, and a line of light above it
  const crownTex = paint(1024, 128, (ctx) => {
    ctx.fillStyle = INDIGO;
    ctx.fillRect(0, 0, 1024, 128);
    bands(ctx, 0, 1024, 128, '#2a318f', 9);
    bands(ctx, 520, 500, 128, '#e0457a', 6);
  });
  const crown: THREE.BufferGeometry[] = [];
  const cove: THREE.BufferGeometry[] = [];
  const wallBand = (len: number, h: number, y: number, out: THREE.BufferGeometry[], place: (g: THREE.BufferGeometry) => void, tile = 0) => {
    const g = new THREE.PlaneGeometry(len, h);
    if (tile) {
      const uv = g.attributes.uv as THREE.BufferAttribute;
      for (let i = 0; i < uv.count; i++) uv.setX(i, (uv.getX(i) * len) / tile);
    }
    g.translate(0, y, 0);
    place(g);
    out.push(g);
  };
  for (const s of [-1, 1]) {
    const px = (g: THREE.BufferGeometry) => g.rotateY((-s * Math.PI) / 2).translate(s * (bowl.halfX - 0.05), 0, 0);
    const pz = (g: THREE.BufferGeometry) => (s > 0 ? g.rotateY(Math.PI) : g).translate(0, 0, s * (bowl.halfZ - 0.05));
    wallBand(bowl.halfZ * 2, 2.0, H - 7, crown, px, 24);
    wallBand(bowl.halfX * 2, 2.0, H - 7, crown, pz, 24);
    wallBand(bowl.halfZ * 2, 0.16, H - 0.95, cove, px);
    wallBand(bowl.halfX * 2, 0.16, H - 0.95, cove, pz);
  }
  add(group, crown, new THREE.MeshBasicMaterial({ map: crownTex, color: new THREE.Color().setScalar(0.5) }));
  add(group, cove, glow(0.95, 0.5, 0.6));
  // a framed screen on each end wall, over the top rows: far off and high, clear of the sky a hitter sets into
  const wallTex = paint(
    1024,
    256,
    (ctx) => {
      ctx.fillStyle = INDIGO;
      ctx.fillRect(0, 0, 1024, 256);
      ctx.save();
      ctx.beginPath();
      ctx.rect(0, 0, 300, 256);
      ctx.clip();
      sweep(ctx, 600, 256);
      ctx.restore();
      bands(ctx, 300, 300, 256, '#e0457a');
      ctx.fillStyle = '#ffffff';
      ctx.textBaseline = 'middle';
      ctx.font = FONT.replace('{px}', '86');
      ctx.fillText('THE GAMES', 440, 100);
      ctx.font = FONT.replace('{px}', '44');
      ctx.fillStyle = '#ffd9c9';
      ctx.fillText('VOLLEYBALL · FINAL', 444, 182);
      ctx.fillStyle = 'rgba(0,0,0,0.14)';
      for (let y = 0; y < 256; y += 4) ctx.fillRect(0, y, 1024, 1);
    },
    false,
  );
  const screens: THREE.BufferGeometry[] = [];
  const bezels: THREE.BufferGeometry[] = [];
  for (const s of [-1, 1]) {
    const z = s * (bowl.halfZ - 0.6);
    const g = new THREE.PlaneGeometry(22, 4.6);
    if (s > 0) g.rotateY(Math.PI);
    g.translate(0, H - 3.4, z);
    screens.push(g);
    bezels.push(boxBetween(-11.3, H - 5.95, z + s * 0.05, 11.3, H - 0.85, z + s * 0.5));
  }
  add(group, screens, new THREE.MeshBasicMaterial({ map: wallTex, color: new THREE.Color().setScalar(0.7) }));
  add(group, bezels, lit(0x0c0e1c, 0.5));
  // the front wall of the stands, behind the boards, in the sweep
  const fascia: THREE.BufferGeometry[] = [];
  const fx = fzX + 2.2 - 0.03;
  const fz = fzZ + 2.2 - 0.03;
  for (const s of [-1, 1]) {
    wallBand(fz * 2, 1.0, 0.52, fascia, (g) => g.rotateY((-s * Math.PI) / 2).translate(s * fx, 0, 0));
    wallBand(fx * 2, 1.0, 0.52, fascia, (g) => (s > 0 ? g.rotateY(Math.PI) : g).translate(0, 0, s * fz));
  }
  const fasciaTex = paint(256, 16, (ctx) => sweep(ctx, 256, 16), false);
  add(group, fascia, new THREE.MeshBasicMaterial({ map: fasciaTex, color: new THREE.Color().setScalar(0.42) }), { mirror: true });
  // the wordmark painted on the free zone behind each end line, the way a games court carries it (both read from the home end)
  const markTex = paint(
    1024,
    160,
    (ctx) => {
      ctx.clearRect(0, 0, 1024, 160);
      bands(ctx, 0, 200, 160, 'rgba(255,255,255,0.9)', 5);
      ctx.fillStyle = 'rgba(255,255,255,0.92)';
      ctx.textBaseline = 'middle';
      ctx.font = FONT.replace('{px}', '120');
      ctx.fillText('THE GAMES', 250, 88);
    },
    false,
  );
  const marks: THREE.BufferGeometry[] = [];
  for (const s of [-1, 1]) {
    const g = new THREE.PlaneGeometry(7.2, 1.12);
    g.rotateX(-Math.PI / 2);
    g.translate(0, 0.005, s * (COURT.halfLength + 3.9));
    marks.push(g);
  }
  const markMat = new THREE.MeshStandardMaterial({ map: markTex, transparent: true, roughness: 0.6, depthWrite: false });
  markMat.polygonOffset = true;
  markMat.polygonOffsetFactor = -4;
  markMat.polygonOffsetUnits = -4;
  add(group, marks, markMat);
  // camera platforms at the corners of the field of play: a riser, a tripod, a long lens
  const risers: THREE.BufferGeometry[] = [];
  const metal: THREE.BufferGeometry[] = [];
  const px = COURT.halfWidth + COURT.freeZoneSide - 1.1;
  const pz = COURT.halfLength + COURT.freeZoneEnd - 1.0;
  for (const sx of [-1, 1]) {
    for (const sz of [-1, 1]) {
      const x = sx * px;
      const z = sz * pz;
      risers.push(boxBetween(x - 0.75, 0, z - 0.75, x + 0.75, 0.32, z + 0.75));
      for (const [dx, dz] of [
        [-0.28, -0.2],
        [0.28, -0.2],
        [0, 0.3],
      ]) {
        const leg = new THREE.CylinderGeometry(0.018, 0.018, 1.25, 5);
        leg.rotateZ(-dx * 0.7);
        leg.rotateX(dz * 0.7);
        leg.translate(x + dx * 0.55, 0.32 + 0.6, z + dz * 0.55);
        metal.push(leg);
      }
      const body = new THREE.BoxGeometry(0.3, 0.3, 0.75);
      const lens = new THREE.CylinderGeometry(0.1, 0.13, 0.5, 10);
      lens.rotateX(Math.PI / 2);
      lens.translate(0, 0, -0.6);
      for (const g of [body, lens]) {
        // aimed at the middle of the net
        g.rotateY(Math.atan2(x, z));
        g.translate(x, 1.72, z);
        metal.push(g);
      }
    }
  }
  add(group, risers, lit(0x10142c, 0.7), { shadow: true, mirror: true });
  add(group, metal, new THREE.MeshStandardMaterial({ color: 0x2a2d36, roughness: 0.45, metalness: 0.6 }), { shadow: true, mirror: true });
  return bowl.crowd;
}

// -------------------------------------------------------------------- seaside
function seaside(group: THREE.Group, env: VenueSpec): THREE.ShaderMaterial {
  const rng = new Rng(21);
  const bowl = buildBowl(group, {
    ...HALL_BOWL,
    roof: false,
    upper: false,
    ends: false,
    lowerRows: 5,
    empty: 0.35,
    seatColor: 0xc9bfa6,
    crowdLight: env.crowd,
    concrete: 0x9c8562,
    dark: 0x7d6848,
  });
  const sandTex = paint(256, 256, (ctx) => {
    ctx.fillStyle = '#ffffff';
    ctx.fillRect(0, 0, 256, 256);
    for (let i = 0; i < 5000; i++) {
      const v = 200 + Math.floor(rng.range(-40, 40));
      ctx.fillStyle = `rgb(${v},${v},${v})`;
      ctx.fillRect(rng.range(0, 256), rng.range(0, 256), rng.range(1, 3), rng.range(1, 2));
    }
    // wind ripples
    ctx.strokeStyle = 'rgba(120,110,90,0.12)';
    for (let y = 0; y < 256; y += 9) {
      ctx.beginPath();
      for (let x = 0; x <= 256; x += 8) ctx.lineTo(x, y + Math.sin((x / 256) * Math.PI * 4 + y) * 2.5);
      ctx.stroke();
    }
  });
  sandTex.repeat.set(70, 70);
  const shore = -46;
  const far = 132;
  const sand = new THREE.Mesh(
    ground(-far, shore - 4, far, far, -0.03),
    new THREE.MeshStandardMaterial({ color: 0xd9c08e, map: sandTex, roughness: 1 }),
  );
  sand.receiveShadow = true;
  sand.userData.noMirror = true;
  group.add(sand);
  // the swell: long low ridges running along the shore, which break the sun's path on the water into glitter
  const swellTex = paint(512, 512, (ctx) => {
    ctx.fillStyle = 'rgb(128,128,128)';
    ctx.fillRect(0, 0, 512, 512);
    for (let i = 0; i < 900; i++) {
      const x = rng.range(0, 512);
      const y = rng.range(0, 512);
      const w = rng.range(30, 130);
      const h = rng.range(1.5, 5);
      const up = rng.next() < 0.5;
      for (const ox of [-512, 0, 512]) {
        for (const oy of [-512, 0, 512]) {
          if (x + ox < -w || x + ox > 512 + w || y + oy < -h || y + oy > 512 + h) continue;
          ctx.save();
          ctx.translate(x + ox, y + oy);
          ctx.scale(w, h);
          const g = ctx.createRadialGradient(0, 0, 0, 0, 0, 1);
          g.addColorStop(0, up ? 'rgba(255,255,255,0.35)' : 'rgba(0,0,0,0.35)');
          g.addColorStop(1, up ? 'rgba(255,255,255,0)' : 'rgba(0,0,0,0)');
          ctx.fillStyle = g;
          ctx.beginPath();
          ctx.arc(0, 0, 1, 0, Math.PI * 2);
          ctx.fill();
          ctx.restore();
        }
      }
    }
  });
  swellTex.colorSpace = THREE.NoColorSpace;
  swellTex.repeat.set(22, 7);
  swellTex.anisotropy = 8;
  const sea = new THREE.Mesh(
    ground(-far, -far, far, shore, -0.2),
    new THREE.MeshStandardMaterial({
      color: 0x176a8a,
      roughness: 0.16,
      metalness: 0,
      envMapIntensity: 0.75,
      bumpMap: swellTex,
      bumpScale: 2.2,
    }),
  );
  sea.userData.noMirror = true;
  group.add(sea);
  // the wet edge and two lines of foam
  add(group, [ground(-far, shore - 4, far, shore + 1.5, -0.025)], new THREE.MeshStandardMaterial({ color: 0xb89e74, roughness: 0.35 }));
  add(group, [ground(-far, shore - 1.1, far, shore - 0.5, -0.02), ground(-far, shore - 7, far, shore - 6.6, -0.15)], glow(0.9, 0.93, 0.95));

  // palms: a leaning trunk and a crown of drooping fronds
  const frng = new Rng(5);
  const frondTex = paint(
    128,
    512,
    (ctx) => {
      ctx.clearRect(0, 0, 128, 512);
      ctx.fillStyle = '#ffffff';
      // the rib, tapering to the tip
      ctx.beginPath();
      ctx.moveTo(60, 512);
      ctx.lineTo(68, 512);
      ctx.lineTo(65, 0);
      ctx.lineTo(63, 0);
      ctx.fill();
      // leaflets: blades that leave the rib wide and run to a point, swept towards the tip
      for (let y = 500; y > 10; y -= 9) {
        const t = y / 512;
        const reach = 62 * Math.sin(t * Math.PI) ** 0.55;
        for (const sd of [-1, 1]) {
          const tipX = 64 + sd * reach * frng.range(0.82, 1);
          const tipY = y - reach * frng.range(0.45, 0.7) - 6;
          ctx.beginPath();
          ctx.moveTo(64, y + 4);
          ctx.lineTo(tipX, tipY);
          ctx.lineTo(64, y - 5);
          ctx.fill();
        }
      }
    },
    false,
  );
  frondTex.anisotropy = 8;
  // the trunk: the rings the old fronds left, lighter and darker up its length
  const barkTex = paint(64, 256, (ctx) => {
    ctx.fillStyle = '#d8d8d8';
    ctx.fillRect(0, 0, 64, 256);
    for (let y = 0; y < 256; y += 16) {
      ctx.fillStyle = `rgba(0,0,0,${frng.range(0.25, 0.45)})`;
      ctx.fillRect(0, y, 64, 3);
      ctx.fillStyle = `rgba(255,255,255,${frng.range(0.05, 0.25)})`;
      ctx.fillRect(0, y + 3, 64, 5);
    }
    for (let i = 0; i < 300; i++) {
      ctx.fillStyle = `rgba(0,0,0,${frng.range(0.05, 0.2)})`;
      ctx.fillRect(frng.range(0, 64), frng.range(0, 256), 1.5, frng.range(3, 10));
    }
  });
  barkTex.repeat.set(1, 5);
  const trunks: THREE.BufferGeometry[] = [];
  const fronds: THREE.BufferGeometry[] = [];
  const palm = (x: number, z: number, h: number, lean: number, dir: number) => {
    // one trunk, bent smoothly towards its lean and swelling at the foot
    const g = new THREE.CylinderGeometry(0.11, 0.2, h, 9, 12, true);
    g.translate(0, h / 2, 0);
    const tp = g.attributes.position as THREE.BufferAttribute;
    for (let v = 0; v < tp.count; v++) {
      const t = tp.getY(v) / h;
      const foot = 1 + 0.6 * Math.max(0, 1 - t * 9);
      tp.setXYZ(v, tp.getX(v) * foot + Math.cos(dir) * lean * t * t, tp.getY(v), tp.getZ(v) * foot + Math.sin(dir) * lean * t * t);
    }
    g.computeVertexNormals();
    g.translate(x, 0, z);
    trunks.push(g);
    const tx = x + Math.cos(dir) * lean;
    const tz = z + Math.sin(dir) * lean;
    const n = 13;
    for (let i = 0; i < n; i++) {
      const len = rng.range(3.2, 4.4);
      const g = new THREE.PlaneGeometry(1.5, len, 2, 10);
      const pos = g.attributes.position as THREE.BufferAttribute;
      // the young fronds stand up in the middle of the crown, the old ones hang
      const lift = i % 3 === 0 ? rng.range(1.6, 2.4) : rng.range(0.4, 1.4);
      for (let v = 0; v < pos.count; v++) {
        const t = pos.getY(v) / len + 0.5;
        const px = pos.getX(v);
        // folded along the rib, the leaflets hanging either side of it
        pos.setXYZ(v, px * 0.8, lift * Math.sin(t * 2.2) - t * t * 2.3 - Math.abs(px) * 0.55, t * len);
      }
      g.rotateY((i / n) * Math.PI * 2 + rng.range(-0.25, 0.25));
      g.translate(tx, h - 0.1, tz);
      fronds.push(g);
    }
  };
  const spots: [number, number][] = [
    [-22, -30],
    [-17, -36],
    [-27, -17],
    [-25, 6],
    [-23, 22],
    [-14, 31],
    [3, 34],
    [16, 30],
    [24, 18],
    [26, -4],
    [23, -24],
    [15, -37],
    [-6, -40],
    [8, -41],
  ];
  for (const [x, z] of spots)
    palm(x + rng.range(-1.5, 1.5), z + rng.range(-1.5, 1.5), rng.range(7, 11), rng.range(0.6, 2.4), rng.range(0, 6.28));
  add(group, trunks, new THREE.MeshStandardMaterial({ color: 0x8a6a46, map: barkTex, roughness: 0.95 }), { shadow: true });
  const crown = add(
    group,
    fronds,
    new THREE.MeshStandardMaterial({ color: 0x3f8a46, map: frondTex, alphaTest: 0.35, side: THREE.DoubleSide, roughness: 0.8 }),
    {
      shadow: true,
    },
  );
  crown.geometry.computeVertexNormals();

  // parasols on the sand between the court and the water
  const poles: THREE.BufferGeometry[] = [];
  const shades = new Map<number, THREE.BufferGeometry[]>();
  const colours = [0xf06a4a, 0xf7d15a, 0x2a8fa8, 0xf4f4f0, 0xe23a6e];
  for (let i = 0; i < 16; i++) {
    const x = rng.range(-30, 30);
    const z = rng.range(shore + 4, -EDGE_Z - 2.5);
    const pole = new THREE.CylinderGeometry(0.03, 0.03, 2.2, 5);
    pole.translate(x, 1.1, z);
    poles.push(pole);
    const cone = new THREE.ConeGeometry(1.5, 0.55, 10, 1, true);
    cone.translate(x, 2.25, z);
    const c = colours[i % colours.length];
    if (!shades.has(c)) shades.set(c, []);
    shades.get(c)!.push(cone);
  }
  add(group, poles, lit(0xdddddd, 0.5));
  for (const [c, geos] of shades)
    add(group, geos, new THREE.MeshStandardMaterial({ color: c, roughness: 0.8, side: THREE.DoubleSide }), { shadow: true });

  // pennants on poles behind the home end line
  const flagPoles: THREE.BufferGeometry[] = [];
  const flags = new Map<number, THREE.BufferGeometry[]>();
  for (let i = -3; i <= 3; i++) {
    const x = i * 4.2;
    const z = EDGE_Z + 1.5;
    const pole = new THREE.CylinderGeometry(0.04, 0.05, 7, 6);
    pole.translate(x, 3.5, z);
    flagPoles.push(pole);
    const f = new THREE.PlaneGeometry(0.9, 3.2, 2, 6);
    const pos = f.attributes.position as THREE.BufferAttribute;
    for (let v = 0; v < pos.count; v++) pos.setZ(v, Math.sin(pos.getY(v) * 2.2 + i) * 0.12 * (pos.getX(v) + 0.45));
    f.translate(x + 0.5, 5.2, z);
    const c = colours[(i + 3) % colours.length];
    if (!flags.has(c)) flags.set(c, []);
    flags.get(c)!.push(f);
  }
  add(group, flagPoles, lit(0xe8e8e8, 0.4));
  for (const [c, geos] of flags) add(group, geos, new THREE.MeshStandardMaterial({ color: c, roughness: 0.9, side: THREE.DoubleSide }));
  return bowl.crowd;
}

// -------------------------------------------------------------------- training gym at night
function gym(group: THREE.Group): void {
  const hx = EDGE_X + 0.3;
  const hz = EDGE_Z + 0.3;
  // the lamps hang 2.26 m below the roof and the beams come down 0.9 m: the roof stands high enough that
  // both clear the 12.5 m a ball may reach, so a high ball goes dead just under the lamps and never flies through one
  const h = COURT.ceiling + 2.4;
  const wallTex = paint(512, 512, (ctx) => {
    // painted blockwork above timber panelling
    ctx.fillStyle = '#b9b3a2';
    ctx.fillRect(0, 0, 512, 512);
    const g = ctx.createLinearGradient(0, 0, 0, 420);
    g.addColorStop(0, 'rgba(0,0,0,0.6)');
    g.addColorStop(1, 'rgba(0,0,0,0)');
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, 512, 420);
    ctx.strokeStyle = 'rgba(0,0,0,0.1)';
    for (let y = 0; y < 420; y += 16) {
      ctx.beginPath();
      ctx.moveTo(0, y + 0.5);
      ctx.lineTo(512, y + 0.5);
      ctx.stroke();
      for (let x = (y / 16) % 2 ? 0 : 16; x < 512; x += 32) {
        ctx.beginPath();
        ctx.moveTo(x + 0.5, y);
        ctx.lineTo(x + 0.5, y + 16);
        ctx.stroke();
      }
    }
    ctx.fillStyle = '#8a6238';
    ctx.fillRect(0, 420, 512, 92);
    ctx.fillStyle = 'rgba(40,22,8,0.35)';
    for (let x = 0; x < 512; x += 12) ctx.fillRect(x, 420, 1.5, 92);
    ctx.fillStyle = '#5c3f22';
    ctx.fillRect(0, 418, 512, 5);
  });
  wallTex.repeat.set(6, 1);
  const walls = new THREE.Mesh(
    new THREE.BoxGeometry(hx * 2, h, hz * 2),
    new THREE.MeshStandardMaterial({ map: wallTex, side: THREE.BackSide, roughness: 0.9 }),
  );
  walls.position.y = h / 2 - 0.01;
  group.add(walls);
  // the ceiling: dark, beams across, pendant lamps of which every other one is on
  add(group, [ground(-hx, -hz, hx, hz, h - 0.05).rotateZ(0)], new THREE.MeshBasicMaterial({ color: 0x0b0c10, side: THREE.DoubleSide }));
  const beams: THREE.BufferGeometry[] = [];
  const on: THREE.BufferGeometry[] = [];
  const off: THREE.BufferGeometry[] = [];
  for (let i = -3; i <= 3; i++) {
    beams.push(boxBetween(-hx, h - 0.9, i * 6 - 0.15, hx, h - 0.1, i * 6 + 0.15));
    for (const sx of [-9, -3, 3, 9]) {
      const z = i * 6;
      if (i === -3 || i === 3) continue;
      beams.push(boxBetween(sx - 0.02, h - 2.0, z - 0.02, sx + 0.02, h - 0.9, z + 0.02));
      beams.push(boxBetween(sx - 0.55, h - 2.25, z - 0.55, sx + 0.55, h - 2.0, z + 0.55));
      const lamp = new THREE.PlaneGeometry(0.9, 0.9);
      lamp.rotateX(Math.PI / 2);
      lamp.translate(sx, h - 2.26, z);
      ((i + (sx + 9) / 6) % 2 === 0 ? on : off).push(lamp);
    }
  }
  add(group, beams, lit(0x1c1d22, 0.7));
  add(group, on, glow(0.93, 0.82, 0.62));
  add(group, off, glow(0.05, 0.05, 0.055));
  // tall windows down one side: the night outside, and the moon lying across the floor
  const winTex = paint(
    64,
    128,
    (ctx) => {
      const g = ctx.createLinearGradient(0, 0, 0, 128);
      g.addColorStop(0, '#16224a');
      g.addColorStop(1, '#2a3a6c');
      ctx.fillStyle = g;
      ctx.fillRect(0, 0, 64, 128);
      ctx.fillStyle = '#0c0d12';
      for (const x of [0, 30, 61]) ctx.fillRect(x, 0, 3, 128);
      for (const y of [0, 31, 63, 95, 125]) ctx.fillRect(0, y, 64, 3);
    },
    false,
  );
  const panes: THREE.BufferGeometry[] = [];
  const pools: THREE.BufferGeometry[] = [];
  for (let i = -3; i <= 3; i++) {
    const z = i * 5.4;
    const g = new THREE.PlaneGeometry(2.8, 6);
    g.rotateY(Math.PI / 2);
    g.translate(-hx + 0.03, 6.4, z);
    panes.push(g);
    // the patch of moonlight each window throws, slanted across the free zone (it stops short of the court)
    const p = new THREE.PlaneGeometry(6.4, 2.6);
    p.rotateX(-Math.PI / 2);
    const pos = p.attributes.position as THREE.BufferAttribute;
    for (let v = 0; v < pos.count; v++) pos.setZ(v, pos.getZ(v) + pos.getX(v) * 0.35);
    p.translate(-10.6, 0.006, z + 1.2);
    pools.push(p);
  }
  add(group, panes, new THREE.MeshBasicMaterial({ map: winTex }), { mirror: true });
  const pool = add(
    group,
    pools,
    new THREE.MeshBasicMaterial({ color: 0x9fb4ff, transparent: true, opacity: 0.07, blending: THREE.AdditiveBlending, depthWrite: false }),
  );
  pool.receiveShadow = false;
  // wall bars along the other side, benches, a ball cart
  const timber: THREE.BufferGeometry[] = [];
  for (let z = -12; z <= 12; z += 1) timber.push(boxBetween(hx - 0.16, 0, z - 0.04, hx - 0.06, 2.9, z + 0.04));
  for (let k = 0; k < 12; k++) timber.push(boxBetween(hx - 0.2, 0.25 + k * 0.22, -12, hx - 0.16, 0.29 + k * 0.22, 12));
  for (const s of [-1, 1]) {
    for (const z of [-9, -3, 3, 9]) {
      timber.push(boxBetween(s * 12.6 - 0.18, 0.4, z - 1.4, s * 12.6 + 0.18, 0.46, z + 1.4));
      for (const dz of [-1.2, 1.2]) timber.push(boxBetween(s * 12.6 - 0.16, 0, z + dz - 0.03, s * 12.6 + 0.16, 0.4, z + dz + 0.03));
    }
  }
  add(group, timber, lit(0x9a7044, 0.6), { shadow: true, mirror: true });
  const cart: THREE.BufferGeometry[] = [];
  const cx = 11.2;
  const cz = 15.5;
  for (const [dx, dz] of [
    [-0.4, -0.3],
    [0.4, -0.3],
    [-0.4, 0.3],
    [0.4, 0.3],
  ])
    cart.push(boxBetween(cx + dx - 0.015, 0, cz + dz - 0.015, cx + dx + 0.015, 0.95, cz + dz + 0.015));
  cart.push(
    boxBetween(cx - 0.42, 0.93, cz - 0.32, cx + 0.42, 0.96, cz + 0.32),
    boxBetween(cx - 0.42, 0.4, cz - 0.32, cx + 0.42, 0.42, cz + 0.32),
  );
  add(group, cart, new THREE.MeshStandardMaterial({ color: 0x9aa0aa, roughness: 0.4, metalness: 0.7 }), { shadow: true, mirror: true });
  const balls: THREE.BufferGeometry[] = [];
  for (let k = 0; k < 9; k++) {
    const b = new THREE.SphereGeometry(0.105, 12, 8);
    b.translate(cx - 0.28 + (k % 3) * 0.28, 0.55 + Math.floor(k / 3) * 0.2 + (k % 2) * 0.02, cz - 0.15 + ((k * 7) % 3) * 0.15);
    balls.push(b);
  }
  add(group, balls, lit(0xf2d24a, 0.5), { shadow: true, mirror: true });
  // the way out, and its sign
  add(group, [boxBetween(-1.1, 0, hz - 0.08, 1.1, 2.3, hz - 0.02)], lit(0x3a2c20, 0.7), { mirror: true });
  add(group, [boxBetween(-0.45, 2.5, hz - 0.1, 0.45, 2.78, hz - 0.04)], glow(0.25, 1.5, 0.55), { mirror: true });
}

// -------------------------------------------------------------------- rooftop
function rooftop(group: THREE.Group, env: VenueSpec): THREE.ShaderMaterial {
  const rng = new Rng(8);
  const bowl = buildBowl(group, {
    ...HALL_BOWL,
    roof: false,
    upper: false,
    ends: false,
    lowerRows: 3,
    empty: 0.3,
    seatColor: 0x8a5a3a,
    crowdLight: env.crowd,
    concrete: 0x4c5262,
    dark: 0x343846,
  });
  const hx = EDGE_X + 0.4;
  const hz = EDGE_Z + 0.4;
  // the edge of the roof: a parapet, and a ball fence on posts above it
  const concrete: THREE.BufferGeometry[] = [];
  const steel: THREE.BufferGeometry[] = [];
  const fenceTop = 9;
  for (const s of [-1, 1]) {
    concrete.push(boxBetween(s * hx, 0, -hz - 0.3, s * (hx + 0.3), 1.1, hz + 0.3));
    concrete.push(boxBetween(-hx, 0, s * hz, hx, 1.1, s * (hz + 0.3)));
    for (let z = -hz; z <= hz + 0.01; z += (hz * 2) / 7)
      steel.push(boxBetween(s * hx - 0.05, 1.1, z - 0.05, s * hx + 0.05, fenceTop, z + 0.05));
    for (let x = -hx; x <= hx + 0.01; x += (hx * 2) / 5)
      steel.push(boxBetween(x - 0.05, 1.1, s * hz - 0.05, x + 0.05, fenceTop, s * hz + 0.05));
  }
  // the roof carries on a little past the parapet, then the drop
  concrete.push(boxBetween(-hx - 0.3, -60, -hz - 0.3, hx + 0.3, -0.02, hz + 0.3));
  // plant on the roof: a water tank on legs, a stair head, air handlers
  concrete.push(boxBetween(-13.5, 0, -19.5, -9.5, 2.6, -17));
  concrete.push(boxBetween(10.5, 0, 17.6, 13.8, 1.3, 19.8), boxBetween(6.5, 0, 18.2, 9.3, 1.1, 19.8));
  add(group, concrete, lit(0x565c6a, 0.9), { shadow: true });
  const tank = new THREE.CylinderGeometry(1.5, 1.5, 2.6, 14);
  tank.translate(12, 4.6, -18.2);
  const tankRoof = new THREE.ConeGeometry(1.65, 0.8, 14);
  tankRoof.translate(12, 6.3, -18.2);
  const legs = [-1, 1].flatMap((a) =>
    [-1, 1].map((b) => boxBetween(12 + a * 1.1 - 0.06, 0, -18.2 + b * 1.1 - 0.06, 12 + a * 1.1 + 0.06, 3.3, -18.2 + b * 1.1 + 0.06)),
  );
  add(group, [tank, tankRoof], lit(0x6a4a34, 0.8), { shadow: true });
  add(group, [...steel, ...legs], new THREE.MeshStandardMaterial({ color: 0x2a2e38, roughness: 0.5, metalness: 0.5 }));
  const meshTex = paint(128, 128, (ctx) => {
    ctx.clearRect(0, 0, 128, 128);
    ctx.strokeStyle = 'rgba(205,214,232,1)';
    ctx.lineWidth = 5;
    for (const [a, b, c, d] of [
      [-8, -8, 136, 136],
      [136, -8, -8, 136],
      [-72, 56, 72, 200],
      [56, -72, 200, 72],
      [56, 200, 200, 56],
      [-72, 72, 72, -72],
    ]) {
      ctx.beginPath();
      ctx.moveTo(a, b);
      ctx.lineTo(c, d);
      ctx.stroke();
    }
  });
  meshTex.anisotropy = 8;
  const fence: THREE.BufferGeometry[] = [];
  const panel = (len: number, place: (g: THREE.BufferGeometry) => void) => {
    const g = new THREE.PlaneGeometry(len, fenceTop - 1.1);
    const uv = g.attributes.uv as THREE.BufferAttribute;
    for (let i = 0; i < uv.count; i++) uv.setXY(i, uv.getX(i) * len * 3, uv.getY(i) * (fenceTop - 1.1) * 3);
    place(g);
    fence.push(g);
  };
  for (const s of [-1, 1]) {
    panel(hz * 2, (g) => g.rotateY(Math.PI / 2).translate(s * hx, (fenceTop + 1.1) / 2, 0));
    panel(hx * 2, (g) => g.translate(0, (fenceTop + 1.1) / 2, s * hz));
  }
  add(
    group,
    fence,
    new THREE.MeshBasicMaterial({
      map: meshTex,
      transparent: true,
      opacity: 0.5,
      side: THREE.DoubleSide,
      depthWrite: false,
      color: 0x8f9ab8,
    }),
  );

  // festoon lights strung between the fence posts, low enough to stay out of the sky you look up into
  const bulbs: [number, number, number][] = [];
  const run = (x0: number, z0: number, x1: number, z1: number, spans: number) => {
    const per = 9;
    for (let sp = 0; sp < spans; sp++) {
      for (let k = 0; k < per; k++) {
        const t = (sp + (k + 0.5) / per) / spans;
        const sag = Math.sin(((k + 0.5) / per) * Math.PI) * 0.7;
        bulbs.push([x0 + (x1 - x0) * t, 5.6 - sag, z0 + (z1 - z0) * t]);
      }
    }
  };
  for (const s of [-1, 1]) {
    run(s * (hx - 0.2), -hz, s * (hx - 0.2), hz, 7);
    run(-hx, s * (hz - 0.2), hx, s * (hz - 0.2), 5);
  }
  const bulbMesh = new THREE.InstancedMesh(new THREE.SphereGeometry(0.075, 6, 4), glow(2.4, 1.7, 0.9), bulbs.length);
  const m4 = new THREE.Matrix4();
  bulbs.forEach((b, i) => bulbMesh.setMatrixAt(i, m4.makeTranslation(b[0], b[1], b[2])));
  bulbMesh.frustumCulled = false;
  bulbMesh.userData.noMirror = true;
  group.add(bulbMesh);

  // four short light masts at the corners of the free zone side
  const heads: THREE.BufferGeometry[] = [];
  const poles: THREE.BufferGeometry[] = [];
  for (const sx of [-1, 1]) {
    for (const sz of [-1, 1]) {
      const x = sx * (hx - 0.6);
      const z = sz * (hz - 0.6);
      poles.push(boxBetween(x - 0.08, 0, z - 0.08, x + 0.08, 11.5, z + 0.08));
      const g = new THREE.PlaneGeometry(1.8, 0.8);
      g.rotateX(-0.6);
      g.rotateY(Math.atan2(-x, -z));
      g.translate(x - sx * 0.2, 11.6, z - sz * 0.2);
      heads.push(g);
    }
  }
  add(group, poles, lit(0x2a2e38, 0.5));
  add(group, heads, new THREE.MeshBasicMaterial({ color: new THREE.Color(0.96, 0.93, 0.85), side: THREE.DoubleSide }));

  // the city: towers all round, windows lit, fading into the dusk
  const winTex = paint(1024, 2048, (ctx) => {
    const cell = 128;
    const cols = 8;
    const rows = 16;
    ctx.fillStyle = '#10131f';
    ctx.fillRect(0, 0, 1024, 2048);
    // the face of the building: a slab line at every floor, a pier between every bay
    for (let r = 0; r < rows; r++) {
      ctx.fillStyle = '#191d2c';
      ctx.fillRect(0, r * cell, 1024, 10);
      ctx.fillStyle = '#0a0c15';
      ctx.fillRect(0, r * cell + 10, 1024, 3);
    }
    for (let c = 0; c < cols; c++) {
      ctx.fillStyle = '#151927';
      ctx.fillRect(c * cell - 5, 0, 10, 2048);
    }
    for (let r = 0; r < rows; r++) {
      for (let c = 0; c < cols; c++) {
        const x = c * cell + 24;
        const y = r * cell + 30;
        const w = 80;
        const h = 76;
        const v = rng.next();
        // the frame, then the glass
        ctx.fillStyle = '#07080e';
        ctx.fillRect(x - 3, y - 3, w + 6, h + 6);
        if (v > 0.42) {
          // dark: the night sky in the glass
          const g = ctx.createLinearGradient(0, y, 0, y + h);
          g.addColorStop(0, '#1c2440');
          g.addColorStop(1, '#121628');
          ctx.fillStyle = g;
          ctx.fillRect(x, y, w, h);
        } else {
          const [top, low] = v < 0.07 ? ['#d4ecff', '#8fb8e0'] : v < 0.25 ? ['#ffe6b0', '#e8b468'] : ['#d8a45c', '#9a6c34'];
          const g = ctx.createLinearGradient(0, y, 0, y + h);
          g.addColorStop(0, top);
          g.addColorStop(1, low);
          ctx.globalAlpha = rng.range(0.55, 1);
          ctx.fillStyle = g;
          ctx.fillRect(x, y, w, h);
          ctx.globalAlpha = 1;
          // a blind part of the way down, or something standing in the room
          if (rng.next() < 0.45) {
            ctx.fillStyle = 'rgba(255,244,220,0.28)';
            ctx.fillRect(x, y, w, h * rng.range(0.2, 0.7));
          } else if (rng.next() < 0.4) {
            ctx.fillStyle = 'rgba(20,14,10,0.55)';
            const tall = rng.range(18, 40);
            ctx.fillRect(x + rng.range(6, 50), y + h - tall, rng.range(10, 24), tall);
          }
        }
        // the bars of the window
        ctx.fillStyle = '#07080e';
        ctx.fillRect(x + w / 2 - 1.5, y, 3, h);
        ctx.fillRect(x, y + h * 0.36, w, 2.5);
      }
    }
  });
  winTex.anisotropy = 8;
  const towers: THREE.BufferGeometry[] = [];
  for (let i = 0; i < 90; i++) {
    const a = rng.range(0, Math.PI * 2);
    const d = rng.range(42, 122);
    const w = rng.range(10, 24);
    const dp = rng.range(10, 24);
    const topY = rng.range(-34, 6) + (rng.next() < 0.22 ? rng.range(10, 46) : 0);
    const g = new THREE.BoxGeometry(w, topY + 70, dp);
    const uv = g.attributes.uv as THREE.BufferAttribute;
    const ox = Math.floor(rng.range(0, 8)) / 8;
    for (let k = 0; k < uv.count; k++)
      uv.setXY(k, ox + (uv.getX(k) * Math.round(Math.max(w, dp) / 3)) / 8, (uv.getY(k) * Math.round((topY + 70) / 3.4)) / 16);
    g.translate(Math.sin(a) * d, (topY - 70) / 2, -Math.cos(a) * d);
    towers.push(g);
  }
  const city = new THREE.Mesh(
    mergeGeometries(towers),
    // held down a little: the ball flies in front of these windows
    new THREE.MeshBasicMaterial({ map: winTex, color: new THREE.Color(0.72, 0.72, 0.78) }),
  );
  city.userData.noMirror = true;
  group.add(city);
  return bowl.crowd;
}
