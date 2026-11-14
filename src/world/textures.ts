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

/** Net mesh: 10cm squares of dark cord, knotted at the crossings. Tile covers 1m x 1m. */
/**
 * A painted hard court seen close: grit in the acrylic, and coats that went on a little unevenly.
 * `map` is near white (it multiplies the paint's colour), `rough` varies the sheen, `bump` is the grit.
 * One tile is `PAINT_TILE` metres and wraps on every edge.
 */
export const PAINT_TILE = 2;
export function makePaintTextures(strength: number): { map: THREE.CanvasTexture; rough: THREE.CanvasTexture; bump: THREE.CanvasTexture } {
  const size = 1024;
  const [c, ctx] = canvas(size, size);
  const [rc, rctx] = canvas(size, size);
  const [bc, bctx] = canvas(size, size);
  const rng = new Rng(77);
  ctx.fillStyle = 'rgb(238,238,238)';
  ctx.fillRect(0, 0, size, size);
  rctx.fillStyle = 'rgb(236,236,236)';
  rctx.fillRect(0, 0, size, size);
  bctx.fillStyle = 'rgb(128,128,128)';
  bctx.fillRect(0, 0, size, size);
  // a soft patch, drawn again across each edge it crosses so the tile wraps
  const patch = (g: CanvasRenderingContext2D, x: number, y: number, rx: number, ry: number, rot: number, rgb: string, a: number) => {
    for (const ox of [-size, 0, size]) {
      for (const oy of [-size, 0, size]) {
        if (x + ox < -rx || x + ox > size + rx || y + oy < -rx || y + oy > size + rx) continue;
        g.save();
        g.translate(x + ox, y + oy);
        g.rotate(rot);
        g.scale(rx, ry);
        const grd = g.createRadialGradient(0, 0, 0, 0, 0, 1);
        grd.addColorStop(0, `rgba(${rgb},${a})`);
        grd.addColorStop(1, `rgba(${rgb},0)`);
        g.fillStyle = grd;
        g.beginPath();
        g.arc(0, 0, 1, 0, Math.PI * 2);
        g.fill();
        g.restore();
      }
    }
  };
  // the coats: long faint passes of the roller, lighter and darker, and where one dried duller
  for (let i = 0; i < 150; i++) {
    const x = rng.range(0, size);
    const y = rng.range(0, size);
    const light = rng.next() < 0.5;
    patch(
      ctx,
      x,
      y,
      rng.range(90, 300),
      rng.range(20, 70),
      rng.range(-0.12, 0.12),
      light ? '255,255,255' : '150,150,150',
      rng.range(0.02, 0.07) * strength,
    );
    patch(
      rctx,
      x,
      y,
      rng.range(80, 260),
      rng.range(30, 90),
      rng.range(-0.2, 0.2),
      light ? '255,255,255' : '170,170,170',
      rng.range(0.1, 0.3) * strength,
    );
  }
  // the grit: sand in the paint, a couple of millimetres across
  for (let i = 0; i < 90000; i++) {
    const x = rng.range(0, size);
    const y = rng.range(0, size);
    const r = rng.range(0.5, 1.3);
    const up = rng.next() < 0.5;
    ctx.fillStyle = up ? `rgba(255,255,255,${0.2 * strength})` : `rgba(90,90,90,${0.16 * strength})`;
    ctx.fillRect(x, y, r, r);
    bctx.fillStyle = up ? 'rgba(255,255,255,0.5)' : 'rgba(0,0,0,0.5)';
    bctx.fillRect(x, y, r, r);
  }
  const wrap = (cv: HTMLCanvasElement, srgb: boolean) => {
    const t = new THREE.CanvasTexture(cv);
    if (srgb) t.colorSpace = THREE.SRGBColorSpace;
    t.wrapS = t.wrapT = THREE.RepeatWrapping;
    t.anisotropy = 8;
    return t;
  };
  return { map: wrap(c, true), rough: wrap(rc, false), bump: wrap(bc, false) };
}

export function makeNetTexture(): THREE.CanvasTexture {
  const size = 512;
  const [c, ctx] = canvas(size, size);
  ctx.clearRect(0, 0, size, size);
  const cells = 10;
  const step = size / cells;
  ctx.strokeStyle = 'rgba(26,24,26,1)';
  ctx.lineWidth = 3.4;
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
  ctx.fillStyle = 'rgba(26,24,26,1)';
  for (let i = 0; i <= cells; i++) for (let k = 0; k <= cells; k++) ctx.fillRect(i * step - 3.2, k * step - 3.2, 6.4, 6.4);
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
 * Our own colourway, not a brand design. Returns the colour map and a height
 * map of the seams (grooves between the panels) for bump mapping.
 */
export function makeBallTextures(): { map: THREE.CanvasTexture; bump: THREE.CanvasTexture } {
  const w = 1024;
  const h = 512;
  const [c, ctx] = canvas(w, h);
  const [bc, bctx] = canvas(w, h);
  const img = ctx.createImageData(w, h);
  const bimg = bctx.createImageData(w, h);
  const d = img.data;
  const bd = bimg.data;
  const yellow = [246, 200, 46];
  const blue = [28, 74, 168];
  const white = [244, 242, 232];
  const seam = [46, 44, 48];
  const rng = new Rng(11);
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
      // distance to the nearest seam (between the three panels of a face, or between two faces), as an angle
      const dist = Math.min(Math.abs(Math.abs(b) - 1 / 3) * 0.75, (m - second) * 0.72);
      // 0 in the groove, 1 on the panel: a soft-edged line a few millimetres wide
      const k = Math.min(1, Math.max(0, (dist - 0.006) / 0.012));
      const on = k * k * (3 - 2 * k);
      // panels are a touch darker towards their edges (the leather curves into the seam), with a fine grain
      const edge = 0.9 + 0.1 * Math.min(1, dist / 0.07);
      const grain = 1 + (rng.next() - 0.5) * 0.035;
      const i = (y * w + x) * 4;
      for (let q = 0; q < 3; q++) d[i + q] = (seam[q] + (col[q] * edge * grain - seam[q]) * on) | 0;
      d[i + 3] = 255;
      const hgt = (70 + 185 * Math.min(1, dist / 0.035) ** 0.6) | 0;
      bd[i] = bd[i + 1] = bd[i + 2] = hgt;
      bd[i + 3] = 255;
    }
  }
  ctx.putImageData(img, 0, 0);
  bctx.putImageData(bimg, 0, 0);
  const map = new THREE.CanvasTexture(c);
  map.colorSpace = THREE.SRGBColorSpace;
  map.anisotropy = 8;
  const bump = new THREE.CanvasTexture(bc);
  bump.anisotropy = 4;
  return { map, bump };
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

/** A floor arrow (a chevron pointing up the texture) with a dark outline, so it reads on the wood and on the blue. */
export function makeChevronTexture(): THREE.CanvasTexture {
  const s = 128;
  const [c, ctx] = canvas(s, s);
  ctx.lineCap = 'round';
  ctx.lineJoin = 'round';
  const draw = (width: number, style: string) => {
    ctx.strokeStyle = style;
    ctx.lineWidth = width;
    ctx.beginPath();
    ctx.moveTo(s * 0.2, s * 0.68);
    ctx.lineTo(s * 0.5, s * 0.32);
    ctx.lineTo(s * 0.8, s * 0.68);
    ctx.stroke();
  };
  draw(s * 0.3, 'rgba(5,7,12,0.6)');
  draw(s * 0.16, 'rgba(255,255,255,1)');
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

/** Crowd sprite atlas: 8 x 4 fans from the waist up, lit from above. Returns the texture and grid size. */
export function makeCrowdAtlas(): { tex: THREE.CanvasTexture; cols: number; rows: number } {
  const cols = 8;
  const rows = 4;
  const cw = 96;
  const ch = 144;
  const [c, ctx] = canvas(cols * cw, rows * ch);
  const rng = new Rng(99);
  // mostly everyday clothes, with the two teams' colours through them
  const neutral = ['#2b2f38', '#3c4350', '#59606c', '#8b8f96', '#c9c6bd', '#23324d', '#3d4f6e', '#4a3b32', '#6b5a48', '#1d1f24'];
  const home = ['#c9342c', '#e9e6df', '#b02a25'];
  const away = ['#2259b0', '#dfe4ec', '#1b3f86'];
  const other = ['#d9a52a', '#2f8a56', '#c9631f', '#6a3f9a'];
  const skins = ['#f0c6a2', '#dba87e', '#b98058', '#8d5c3c', '#623d27', '#e6b78f'];
  const hairs = ['#1b1209', '#3a2416', '#6b4a2a', '#c2a05c', '#111111', '#7d2e12', '#9c9c9c'];
  const shadeHex = (hex: string, k: number) => {
    const n = parseInt(hex.slice(1), 16);
    const f = (v: number) => Math.max(0, Math.min(255, Math.round(v * k)));
    return `rgb(${f((n >> 16) & 255)},${f((n >> 8) & 255)},${f(n & 255)})`;
  };
  for (let r = 0; r < rows; r++) {
    for (let k = 0; k < cols; k++) {
      const x0 = k * cw;
      const y0 = r * ch;
      const cx = x0 + cw / 2;
      const pick = rng.next();
      const shirt = pick < 0.46 ? rng.pick(neutral) : pick < 0.72 ? rng.pick(home) : pick < 0.86 ? rng.pick(away) : rng.pick(other);
      const skin = rng.pick(skins);
      const hair = rng.pick(hairs);
      const pose = rng.next(); // < 0.3 arms up, < 0.45 clapping, else sitting
      const sw = rng.range(27, 32); // half shoulder width
      const hy = y0 + 50; // head centre
      ctx.save();
      ctx.beginPath();
      ctx.rect(x0, y0, cw, ch);
      ctx.clip();
      const body = () => {
        ctx.beginPath();
        ctx.moveTo(cx - sw - 2, y0 + ch);
        ctx.lineTo(cx - sw, y0 + 88);
        ctx.quadraticCurveTo(cx - sw + 2, y0 + 72, cx - 12, y0 + 68);
        ctx.lineTo(cx + 12, y0 + 68);
        ctx.quadraticCurveTo(cx + sw - 2, y0 + 72, cx + sw, y0 + 88);
        ctx.lineTo(cx + sw + 2, y0 + ch);
        ctx.closePath();
      };
      const arm = (s: number, width: number) => {
        ctx.lineWidth = width;
        ctx.lineCap = 'round';
        ctx.beginPath();
        if (pose < 0.3) {
          ctx.moveTo(cx + s * (sw - 5), y0 + 84);
          ctx.quadraticCurveTo(cx + s * (sw + 6), y0 + 56, cx + s * (sw + 2), y0 + 26);
        } else {
          ctx.moveTo(cx + s * (sw - 5), y0 + 84);
          ctx.quadraticCurveTo(cx + s * (sw - 2), y0 + 112, cx + s * 7, y0 + 104);
        }
        ctx.stroke();
      };
      // a dark edge all round, so neighbours separate
      ctx.fillStyle = 'rgba(8,9,13,1)';
      ctx.strokeStyle = 'rgba(8,9,13,1)';
      ctx.lineJoin = 'round';
      ctx.lineWidth = 5;
      body();
      ctx.fill();
      ctx.stroke();
      if (pose < 0.45) for (const s of [-1, 1]) arm(s, 17);
      ctx.beginPath();
      ctx.ellipse(cx, hy, 17.5, 21, 0, 0, Math.PI * 2);
      ctx.fill();
      // torso: lit on the shoulders, falling off downwards
      const tg = ctx.createLinearGradient(0, y0 + 66, 0, y0 + ch);
      tg.addColorStop(0, shadeHex(shirt, 1.18));
      tg.addColorStop(0.35, shirt);
      tg.addColorStop(1, shadeHex(shirt, 0.55));
      ctx.fillStyle = tg;
      body();
      ctx.fill();
      // neck
      ctx.fillStyle = shadeHex(skin, 0.72);
      ctx.fillRect(cx - 6.5, y0 + 62, 13, 12);
      // arms
      if (pose < 0.45) {
        for (const s of [-1, 1]) {
          ctx.strokeStyle = shadeHex(shirt, 0.9);
          arm(s, 12);
          ctx.fillStyle = skin;
          ctx.beginPath();
          if (pose < 0.3) ctx.arc(cx + s * (sw + 2), y0 + 21, 6.5, 0, Math.PI * 2);
          else ctx.arc(cx + s * 5, y0 + 104, 6.5, 0, Math.PI * 2);
          ctx.fill();
        }
      }
      // head: brighter on top
      const hg = ctx.createRadialGradient(cx - 3, hy - 9, 2, cx, hy, 21);
      hg.addColorStop(0, shadeHex(skin, 1.08));
      hg.addColorStop(0.65, skin);
      hg.addColorStop(1, shadeHex(skin, 0.66));
      ctx.fillStyle = hg;
      ctx.beginPath();
      ctx.ellipse(cx, hy, 14.5, 18, 0, 0, Math.PI * 2);
      ctx.fill();
      // eyes and mouth: a couple of marks are enough at this size
      ctx.fillStyle = 'rgba(20,12,8,0.75)';
      ctx.fillRect(cx - 7, hy - 1, 3.5, 2.5);
      ctx.fillRect(cx + 3.5, hy - 1, 3.5, 2.5);
      ctx.fillStyle = 'rgba(60,20,16,0.5)';
      ctx.fillRect(cx - 3.5, hy + 8.5, 7, pose < 0.3 ? 3 : 1.6);
      // hair, or a cap
      const style = rng.next();
      ctx.fillStyle = hair;
      if (style < 0.14) {
        ctx.fillStyle = shadeHex(rng.pick(neutral.concat(home)), 1);
        ctx.beginPath();
        ctx.ellipse(cx, hy - 9, 15.5, 11, 0, Math.PI, Math.PI * 2);
        ctx.fill();
        ctx.fillRect(cx - 16, hy - 10, 32, 4);
      } else if (style < 0.22) {
        // bald or cropped: a shadow of hair
        ctx.globalAlpha = 0.35;
        ctx.beginPath();
        ctx.ellipse(cx, hy - 8, 14.5, 10, 0, Math.PI, Math.PI * 2);
        ctx.fill();
        ctx.globalAlpha = 1;
      } else {
        ctx.beginPath();
        ctx.ellipse(cx, hy - 7, 15.5, 12.5, 0, Math.PI, Math.PI * 2);
        ctx.fill();
        if (style > 0.68) {
          // long hair to the shoulders
          ctx.fillRect(cx - 16, hy - 8, 5.5, 26);
          ctx.fillRect(cx + 10.5, hy - 8, 5.5, 26);
        }
      }
      ctx.restore();
    }
  }
  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.generateMipmaps = true;
  tex.minFilter = THREE.LinearMipmapLinearFilter;
  tex.anisotropy = 4;
  return { tex, cols, rows };
}

/** The LED ribbon round the balcony and the scoreboard screens: slow colour bands and the wordmark. Tiles every 16 m. */
export function makeRibbonTexture(): THREE.CanvasTexture {
  const [c, ctx] = canvas(1024, 64);
  const g = ctx.createLinearGradient(0, 0, 1024, 0);
  const stops = ['#0d2a6e', '#1e64d8', '#0d2a6e', '#7a1020', '#d8343c', '#7a1020', '#0d2a6e'];
  stops.forEach((s, i) => g.addColorStop(i / (stops.length - 1), s));
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, 1024, 64);
  ctx.fillStyle = 'rgba(255,255,255,0.92)';
  ctx.font = '800 32px system-ui, "Helvetica Neue", Arial, sans-serif';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillText('COURT FEEL', 256, 34);
  ctx.fillText('TRUE TO THE COURT', 768, 34);
  // the pixel grid of an LED panel
  ctx.fillStyle = 'rgba(0,0,0,0.16)';
  for (let y = 0; y < 64; y += 4) ctx.fillRect(0, y, 1024, 1);
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  t.wrapS = THREE.RepeatWrapping;
  t.anisotropy = 4;
  return t;
}

/** Hall walls: dark, with the glow of the court lights fading up them, and a faint panel grid. */
export function makeWallTexture(): THREE.CanvasTexture {
  const [c, ctx] = canvas(256, 256);
  const g = ctx.createLinearGradient(0, 256, 0, 0);
  g.addColorStop(0, '#1a2233');
  g.addColorStop(0.45, '#141b2a');
  g.addColorStop(0.8, '#0c111b');
  g.addColorStop(1, '#070a11');
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, 256, 256);
  ctx.strokeStyle = 'rgba(255,255,255,0.035)';
  ctx.lineWidth = 1;
  for (let x = 0; x <= 256; x += 32) {
    ctx.beginPath();
    ctx.moveTo(x + 0.5, 0);
    ctx.lineTo(x + 0.5, 256);
    ctx.stroke();
  }
  for (let y = 0; y <= 256; y += 64) {
    ctx.beginPath();
    ctx.moveTo(0, y + 0.5);
    ctx.lineTo(256, y + 0.5);
    ctx.stroke();
  }
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  return t;
}

/** LED boards round the free zone: dark panels with the wordmark and the drills, in the two teams' colours (no real brands). Tiles every 8 m. */
export function makeBoardTexture(panels: [string, string, string, string][]): THREE.CanvasTexture {
  const [c, ctx] = canvas(1024, 96);
  const w = 1024 / panels.length;
  panels.forEach(([a, b, text, fg], i) => {
    const g = ctx.createLinearGradient(i * w, 0, i * w + w, 96);
    g.addColorStop(0, a);
    g.addColorStop(1, b);
    ctx.fillStyle = g;
    ctx.fillRect(i * w, 0, w, 96);
    ctx.fillStyle = fg;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    let px = 46;
    ctx.font = `800 ${px}px system-ui, "Helvetica Neue", Arial, sans-serif`;
    while (ctx.measureText(text).width > w - 28 && px > 12) ctx.font = `800 ${--px}px system-ui, "Helvetica Neue", Arial, sans-serif`;
    ctx.fillText(text, i * w + w / 2, 50);
    // panel joint
    ctx.fillStyle = 'rgba(0,0,0,0.55)';
    ctx.fillRect(i * w, 0, 2, 96);
  });
  // the pixel rows of an LED panel
  ctx.fillStyle = 'rgba(0,0,0,0.14)';
  for (let y = 0; y < 96; y += 4) ctx.fillRect(0, y, 1024, 1);
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  t.wrapS = THREE.RepeatWrapping;
  t.anisotropy = 8;
  return t;
}
