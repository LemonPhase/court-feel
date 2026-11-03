import * as THREE from 'three';
import { Rng } from '../core/mathx';

function canvas(w: number, h: number): [HTMLCanvasElement, CanvasRenderingContext2D] {
  const c = document.createElement('canvas');
  c.width = w;
  c.height = h;
  const ctx = c.getContext('2d')!;
  return [c, ctx];
}

/**
 * Maple strip flooring. Returns colour map and a roughness map that share the
 * same plank layout so the gloss varies plank to plank (polished-but-used look).
 * One tile covers `tileMetres` x `tileMetres`.
 */
export function makeWoodTextures(tileMetres = 4): { map: THREE.CanvasTexture; rough: THREE.CanvasTexture; gray: THREE.CanvasTexture } {
  const size = 1024;
  const [c, ctx] = canvas(size, size);
  const [rc, rctx] = canvas(size, size);
  const rng = new Rng(42);
  const pxPerM = size / tileMetres;
  const stripW = 0.064 * pxPerM; // ~6.4cm maple strips
  const strips = Math.ceil(size / stripW);
  ctx.fillStyle = '#c99a62';
  ctx.fillRect(0, 0, size, size);
  rctx.fillStyle = 'rgb(70,70,70)';
  rctx.fillRect(0, 0, size, size);
  for (let i = 0; i < strips; i++) {
    const x0 = i * stripW;
    let y = -rng.range(0, 1.6) * pxPerM;
    while (y < size) {
      const len = rng.range(0.9, 2.4) * pxPerM;
      // warm maple with per-board variance
      const l = rng.range(-1, 1);
      const r = 205 + l * 16 + rng.range(-5, 5);
      const g = 158 + l * 14 + rng.range(-5, 5);
      const b = 100 + l * 12 + rng.range(-6, 6);
      ctx.fillStyle = `rgb(${r | 0},${g | 0},${b | 0})`;
      ctx.fillRect(x0, y, stripW + 0.5, len);
      // grain streaks
      const grains = 5 + Math.floor(rng.range(0, 6));
      for (let k = 0; k < grains; k++) {
        const gx = x0 + rng.range(1, stripW - 1);
        ctx.strokeStyle = `rgba(${110 + rng.range(-20, 20)},${70 + rng.range(-15, 15)},${35},${rng.range(0.05, 0.16)})`;
        ctx.lineWidth = rng.range(0.4, 1.6);
        ctx.beginPath();
        ctx.moveTo(gx, y);
        const wob = rng.range(-2, 2);
        ctx.bezierCurveTo(gx + wob, y + len * 0.33, gx - wob, y + len * 0.66, gx + rng.range(-1, 1), y + len);
        ctx.stroke();
      }
      // occasional knot / figure
      if (rng.next() < 0.12) {
        const kx = x0 + stripW * 0.5;
        const ky = y + rng.range(0.1, 0.9) * len;
        const grd = ctx.createRadialGradient(kx, ky, 0, kx, ky, stripW * 0.6);
        grd.addColorStop(0, 'rgba(120,70,30,0.35)');
        grd.addColorStop(1, 'rgba(120,70,30,0)');
        ctx.fillStyle = grd;
        ctx.fillRect(kx - stripW, ky - stripW, stripW * 2, stripW * 2);
      }
      // board end seam
      ctx.fillStyle = 'rgba(60,35,15,0.45)';
      ctx.fillRect(x0, y, stripW, 1);
      // roughness per board: polished, slightly varied
      const rv = 52 + rng.range(-14, 22);
      rctx.fillStyle = `rgb(${rv | 0},${rv | 0},${rv | 0})`;
      rctx.fillRect(x0, y, stripW + 0.5, len);
      y += len;
    }
    // strip seam
    ctx.fillStyle = 'rgba(70,40,18,0.35)';
    ctx.fillRect(x0, 0, 1, size);
    rctx.fillStyle = 'rgba(150,150,150,0.6)';
    rctx.fillRect(x0, 0, 1, size);
  }
  // scuffs on the roughness map (shoes) and faint scuff tint on colour
  for (let i = 0; i < 260; i++) {
    const x = rng.range(0, size);
    const y = rng.range(0, size);
    const r = rng.range(4, 26);
    const grd = rctx.createRadialGradient(x, y, 0, x, y, r);
    grd.addColorStop(0, 'rgba(140,140,140,0.25)');
    grd.addColorStop(1, 'rgba(140,140,140,0)');
    rctx.fillStyle = grd;
    rctx.fillRect(x - r, y - r, r * 2, r * 2);
  }
  const map = new THREE.CanvasTexture(c);
  map.colorSpace = THREE.SRGBColorSpace;
  const rough = new THREE.CanvasTexture(rc);
  // desaturated, brightened copy for painted areas (grain shows through paint)
  const [gc, gctx] = canvas(size, size);
  gctx.filter = 'grayscale(1) brightness(1.55) contrast(0.55)';
  gctx.drawImage(c, 0, 0);
  const gray = new THREE.CanvasTexture(gc);
  gray.colorSpace = THREE.SRGBColorSpace;
  for (const t of [map, rough, gray]) {
    t.wrapS = t.wrapT = THREE.RepeatWrapping;
    t.anisotropy = 8;
    t.generateMipmaps = true;
  }
  return { map, rough, gray };
}

/** Net mesh: 10cm squares of dark cord. Tile covers 1m x 1m. */
export function makeNetTexture(): THREE.CanvasTexture {
  const size = 256;
  const [c, ctx] = canvas(size, size);
  ctx.clearRect(0, 0, size, size);
  ctx.strokeStyle = 'rgba(20,20,24,1)';
  ctx.lineWidth = 3.2;
  const cells = 10;
  const step = size / cells;
  for (let i = 0; i <= cells; i++) {
    ctx.beginPath();
    ctx.moveTo(i * step, 0);
    ctx.lineTo(i * step, size);
    ctx.stroke();
    ctx.beginPath();
    ctx.moveTo(0, i * step);
    ctx.lineTo(size, i * step);
    ctx.stroke();
  }
  const t = new THREE.CanvasTexture(c);
  t.wrapS = t.wrapT = THREE.RepeatWrapping;
  t.anisotropy = 8;
  t.colorSpace = THREE.SRGBColorSpace;
  return t;
}

/** Red/white antenna stripes, 10cm bands. */
export function makeAntennaTexture(): THREE.CanvasTexture {
  const [c, ctx] = canvas(8, 64);
  for (let i = 0; i < 8; i++) {
    ctx.fillStyle = i % 2 === 0 ? '#e8e8e8' : '#d0201e';
    ctx.fillRect(0, i * 8, 8, 8);
  }
  const t = new THREE.CanvasTexture(c);
  t.magFilter = THREE.NearestFilter;
  t.colorSpace = THREE.SRGBColorSpace;
  return t;
}

/**
 * Generic volleyball: 18 panels in six groups of three (cube layout), drawn in
 * equirect space from the 3D direction so the sphere mapping is seamless.
 * Our own colourway, not a brand design.
 */
export function makeBallTexture(): THREE.CanvasTexture {
  const w = 512;
  const h = 256;
  const [c, ctx] = canvas(w, h);
  const img = ctx.createImageData(w, h);
  const d = img.data;
  const yellow = [246, 200, 46];
  const blue = [28, 74, 168];
  const white = [244, 242, 232];
  const seam = [40, 40, 46];
  for (let y = 0; y < h; y++) {
    const v = (y + 0.5) / h;
    const theta = v * Math.PI; // polar
    for (let x = 0; x < w; x++) {
      const u = (x + 0.5) / w;
      const phi = u * Math.PI * 2;
      // three.js SphereGeometry mapping
      const nx = -Math.cos(phi) * Math.sin(theta);
      const ny = Math.cos(theta);
      const nz = Math.sin(phi) * Math.sin(theta);
      const ax = Math.abs(nx),
        ay = Math.abs(ny),
        az = Math.abs(nz);
      let face: number, m: number, perp: number, second: number;
      if (ax >= ay && ax >= az) {
        face = 0;
        m = ax;
        perp = ny;
        second = Math.max(ay, az);
      } else if (ay >= az) {
        face = 1;
        m = ay;
        perp = nz;
        second = Math.max(ax, az);
      } else {
        face = 2;
        m = az;
        perp = nx;
        second = Math.max(ax, ay);
      }
      const b = perp / m; // -1..1 across the face
      const band = b < -1 / 3 ? 0 : b > 1 / 3 ? 2 : 1;
      let col: number[];
      if (band === 1) col = face === 1 ? blue : yellow;
      else col = face === 1 ? white : face === 0 ? blue : white;
      if (face === 2 && band !== 1) col = blue;
      if (face === 0 && band !== 1) col = white;
      const seamW = 0.03;
      const nearBand = Math.abs(Math.abs(b) - 1 / 3) < seamW * 1.6;
      const nearFace = m - second < seamW;
      const i = (y * w + x) * 4;
      const sc = nearBand || nearFace ? 0.25 : 1;
      const base = sc < 1 ? seam : col;
      d[i] = base[0];
      d[i + 1] = base[1];
      d[i + 2] = base[2];
      d[i + 3] = 255;
    }
  }
  ctx.putImageData(img, 0, 0);
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  t.anisotropy = 4;
  return t;
}

/** Radial soft blob used for the ball's timing shadow and dust. */
export function makeBlobTexture(inner = 0.0, hard = 0.55): THREE.CanvasTexture {
  const s = 128;
  const [c, ctx] = canvas(s, s);
  const g = ctx.createRadialGradient(s / 2, s / 2, inner * s * 0.5, s / 2, s / 2, s / 2);
  g.addColorStop(0, 'rgba(255,255,255,1)');
  g.addColorStop(hard, 'rgba(255,255,255,0.55)');
  g.addColorStop(1, 'rgba(255,255,255,0)');
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, s, s);
  const t = new THREE.CanvasTexture(c);
  return t;
}

/** Ring texture for landing markers and shockwaves. */
export function makeRingTexture(width = 0.12): THREE.CanvasTexture {
  const s = 256;
  const [c, ctx] = canvas(s, s);
  const g = ctx.createRadialGradient(s / 2, s / 2, 0, s / 2, s / 2, s / 2);
  const a = 1 - width;
  g.addColorStop(0, 'rgba(255,255,255,0)');
  g.addColorStop(Math.max(0, a - 0.12), 'rgba(255,255,255,0)');
  g.addColorStop(a, 'rgba(255,255,255,1)');
  g.addColorStop(Math.min(1, a + width * 0.5), 'rgba(255,255,255,0.9)');
  g.addColorStop(1, 'rgba(255,255,255,0)');
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, s, s);
  return new THREE.CanvasTexture(c);
}

/** Floor crack decal: radial fractures with a dark core. Alpha in the texture. */
export function makeCrackTexture(seed = 7): THREE.CanvasTexture {
  const s = 512;
  const [c, ctx] = canvas(s, s);
  const rng = new Rng(seed);
  ctx.translate(s / 2, s / 2);
  const core = ctx.createRadialGradient(0, 0, 0, 0, 0, s * 0.18);
  core.addColorStop(0, 'rgba(25,12,4,0.85)');
  core.addColorStop(0.5, 'rgba(40,20,8,0.45)');
  core.addColorStop(1, 'rgba(40,20,8,0)');
  ctx.fillStyle = core;
  ctx.beginPath();
  ctx.arc(0, 0, s * 0.18, 0, Math.PI * 2);
  ctx.fill();
  const branch = (x: number, y: number, ang: number, len: number, w: number, depth: number) => {
    let cx = x;
    let cy = y;
    const segs = 6;
    ctx.lineCap = 'round';
    for (let i = 0; i < segs; i++) {
      ang += rng.range(-0.45, 0.45);
      const nx = cx + Math.cos(ang) * (len / segs);
      const ny = cy + Math.sin(ang) * (len / segs);
      ctx.strokeStyle = `rgba(20,10,4,${0.9 - i * 0.1})`;
      ctx.lineWidth = Math.max(0.6, w * (1 - i / segs));
      ctx.beginPath();
      ctx.moveTo(cx, cy);
      ctx.lineTo(nx, ny);
      ctx.stroke();
      // light edge (chipped varnish)
      ctx.strokeStyle = `rgba(255,230,190,${0.25 - i * 0.03})`;
      ctx.lineWidth = Math.max(0.4, w * 0.35 * (1 - i / segs));
      ctx.beginPath();
      ctx.moveTo(cx + 1.2, cy + 1.2);
      ctx.lineTo(nx + 1.2, ny + 1.2);
      ctx.stroke();
      if (depth > 0 && rng.next() < 0.35) branch(nx, ny, ang + rng.range(-1.1, 1.1), len * 0.45, w * 0.55, depth - 1);
      cx = nx;
      cy = ny;
    }
  };
  const n = 9 + Math.floor(rng.range(0, 5));
  for (let i = 0; i < n; i++) {
    const a = (i / n) * Math.PI * 2 + rng.range(-0.2, 0.2);
    branch(Math.cos(a) * 14, Math.sin(a) * 14, a, rng.range(110, 225), rng.range(3, 6), 2);
  }
  // concentric ring fracture
  ctx.strokeStyle = 'rgba(30,15,5,0.5)';
  ctx.lineWidth = 2;
  ctx.beginPath();
  for (let a = 0; a <= Math.PI * 2 + 0.01; a += 0.15) {
    const r = 70 + rng.range(-8, 8);
    const px = Math.cos(a) * r;
    const py = Math.sin(a) * r;
    if (a === 0) ctx.moveTo(px, py);
    else ctx.lineTo(px, py);
  }
  ctx.stroke();
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  return t;
}

/** Crowd sprite atlas: 8 x 4 seated fans. Returns the texture and grid size. */
export function makeCrowdAtlas(): { tex: THREE.CanvasTexture; cols: number; rows: number } {
  const cols = 8;
  const rows = 4;
  const cw = 64;
  const ch = 96;
  const [c, ctx] = canvas(cols * cw, rows * ch);
  const rng = new Rng(99);
  const shirts = [
    '#d8342c',
    '#f2f2f2',
    '#1f5fbf',
    '#f2b632',
    '#2a2a2e',
    '#2b9a5a',
    '#e86a1f',
    '#7a3fb0',
    '#ffffff',
    '#c41e3a',
    '#0d2f6e',
    '#ffd34d',
  ];
  const skins = ['#f1c6a0', '#d9a77b', '#b47d55', '#8a5a3a', '#5f3b24', '#e7b892'];
  const hairs = ['#1b1209', '#3a2416', '#6b4a2a', '#c9a35b', '#111111', '#7d2e12', '#9a9a9a'];
  for (let r = 0; r < rows; r++) {
    for (let k = 0; k < cols; k++) {
      const x0 = k * cw;
      const y0 = r * ch;
      const cx = x0 + cw / 2;
      const shirt = rng.pick(shirts);
      const skin = rng.pick(skins);
      const hair = rng.pick(hairs);
      const arms = rng.next() < 0.35; // arms raised
      ctx.fillStyle = shirt;
      // torso
      ctx.beginPath();
      ctx.moveTo(cx - 20, y0 + ch);
      ctx.lineTo(cx - 19, y0 + 52);
      ctx.quadraticCurveTo(cx, y0 + 42, cx + 19, y0 + 52);
      ctx.lineTo(cx + 20, y0 + ch);
      ctx.fill();
      // arms
      ctx.strokeStyle = shirt;
      ctx.lineWidth = 8;
      ctx.lineCap = 'round';
      if (arms) {
        ctx.beginPath();
        ctx.moveTo(cx - 16, y0 + 56);
        ctx.lineTo(cx - 24, y0 + 22);
        ctx.moveTo(cx + 16, y0 + 56);
        ctx.lineTo(cx + 24, y0 + 22);
        ctx.stroke();
        ctx.fillStyle = skin;
        ctx.beginPath();
        ctx.arc(cx - 25, y0 + 18, 4.5, 0, Math.PI * 2);
        ctx.arc(cx + 25, y0 + 18, 4.5, 0, Math.PI * 2);
        ctx.fill();
      }
      // neck + head
      ctx.fillStyle = skin;
      ctx.fillRect(cx - 4, y0 + 40, 8, 8);
      ctx.beginPath();
      ctx.ellipse(cx, y0 + 32, 10, 12, 0, 0, Math.PI * 2);
      ctx.fill();
      ctx.fillStyle = hair;
      ctx.beginPath();
      ctx.ellipse(cx, y0 + 26, 10.5, 7.5, 0, Math.PI, Math.PI * 2);
      ctx.fill();
      if (rng.next() < 0.3) {
        // long hair
        ctx.fillRect(cx - 10.5, y0 + 26, 4, 16);
        ctx.fillRect(cx + 6.5, y0 + 26, 4, 16);
      }
    }
  }
  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.generateMipmaps = true;
  tex.minFilter = THREE.LinearMipmapLinearFilter;
  return { tex, cols, rows };
}

/** LED board strip texture: abstract gradient panels with chevrons (no real brands). */
export function makeBoardTexture(): THREE.CanvasTexture {
  const [c, ctx] = canvas(1024, 64);
  const palettes = [
    ['#0b2a6b', '#1e64d8'],
    ['#7a0d1a', '#e0333d'],
    ['#0d4d3a', '#22b07a'],
    ['#3b1466', '#8a3ee0'],
  ];
  for (let i = 0; i < 8; i++) {
    const p = palettes[i % palettes.length];
    const g = ctx.createLinearGradient(i * 128, 0, i * 128 + 128, 64);
    g.addColorStop(0, p[0]);
    g.addColorStop(1, p[1]);
    ctx.fillStyle = g;
    ctx.fillRect(i * 128, 0, 128, 64);
    ctx.fillStyle = 'rgba(255,255,255,0.75)';
    ctx.font = 'bold 30px system-ui, sans-serif';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText(['COURT', 'FEEL', 'SPIKE', 'BLOCK'][i % 4], i * 128 + 64, 33);
  }
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  t.wrapS = THREE.RepeatWrapping;
  return t;
}
