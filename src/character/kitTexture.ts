import * as THREE from 'three';
import type { Kit } from './rig';

/**
 * One decal atlas per athlete: the face (eyes, brows, mouth) on the left half
 * and the jersey number on the right. Everything else is transparent, and the
 * body shader shows the vertex colour there. Painted on a canvas, no image files.
 */

const TILE = 512;
/** the face tile spans this many head half-heights either side of the head centre */
export const FACE_EXTENT = 1.15;
/** the number tile spans this many number-box half-sizes either side of the box centre */
export const NUMBER_EXTENT = 1.25;

/**
 * Face decal coordinates. `X` is towards the viewer's right and `Y` up, both in
 * head half-heights from the head centre.
 */
export function faceUV(X: number, Y: number): [number, number] {
  const lim = FACE_EXTENT * 0.985;
  const x = Math.max(-lim, Math.min(lim, X));
  const y = Math.max(-lim, Math.min(lim, Y));
  return [(0.5 + x / (2 * FACE_EXTENT)) * 0.5, 0.5 + y / (2 * FACE_EXTENT)];
}

/** Number decal coordinates: the number box is [-1, 1] in both axes; outside it the tile is clear. */
export function numberUV(X: number, Y: number): [number, number] {
  const lim = NUMBER_EXTENT * 0.985;
  const x = Math.max(-lim, Math.min(lim, X));
  const y = Math.max(-lim, Math.min(lim, Y));
  return [0.5 + (0.5 + x / (2 * NUMBER_EXTENT)) * 0.5, 0.5 + y / (2 * NUMBER_EXTENT)];
}

type RGB = [number, number, number];
const rgb = (hex: number): RGB => [(hex >> 16) & 255, (hex >> 8) & 255, hex & 255];
const mix = (a: RGB, b: RGB, t: number): RGB => [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t];
const css = (c: RGB, a = 1) => `rgba(${Math.round(c[0])},${Math.round(c[1])},${Math.round(c[2])},${a})`;
const lum = (c: RGB) => (0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2]) / 255;

/** proportions of the head the face is painted for (in head half-heights) */
export const FACE = {
  /** head half-width */
  halfWidth: 0.664,
  eyeX: 0.285,
  eyeY: 0.015,
  browY: 0.19,
  noseY: -0.3,
  mouthY: -0.56,
};

function paintFace(ctx: CanvasRenderingContext2D, kit: Kit): void {
  const S = TILE / (2 * FACE_EXTENT); // pixels per head half-height
  const cx = TILE / 2;
  const cy = TILE / 2;
  const skin = rgb(kit.skin);
  const hair = rgb(kit.hair);
  const dark = lum(skin) < 0.42;
  const px = (X: number) => cx + X * S;
  const py = (Y: number) => cy - Y * S;
  const iris = rgb(kit.eyes);
  const lidLine = mix(skin, [18, 10, 6], 0.86);
  const browCol = mix(hair, [10, 8, 6], 0.35);

  for (const s of [-1, 1]) {
    // ---- eye
    const ex = px(s * FACE.eyeX);
    const ey = py(FACE.eyeY);
    const ew = 0.128 * S; // half width
    const eh = 0.056 * S; // half height
    // outer corner sits slightly higher than the inner one
    const inX = ex - s * ew;
    const outX = ex + s * ew;
    const inY = ey + eh * 0.22;
    const outY = ey - eh * 0.18;
    const almond = () => {
      ctx.beginPath();
      ctx.moveTo(inX, inY);
      ctx.bezierCurveTo(ex - s * ew * 0.45, ey - eh * 1.35, ex + s * ew * 0.5, ey - eh * 1.3, outX, outY);
      ctx.bezierCurveTo(ex + s * ew * 0.45, ey + eh * 1.05, ex - s * ew * 0.4, ey + eh * 1.1, inX, inY);
      ctx.closePath();
    };
    // soft socket shadow around the eye
    const sh = ctx.createRadialGradient(ex, ey, ew * 0.4, ex, ey, ew * 1.7);
    sh.addColorStop(0, css(mix(skin, [20, 10, 8], 0.5), 0.32));
    sh.addColorStop(1, css(mix(skin, [20, 10, 8], 0.5), 0));
    ctx.fillStyle = sh;
    ctx.fillRect(ex - ew * 2, ey - ew * 2, ew * 4, ew * 4);

    ctx.save();
    almond();
    ctx.clip();
    // sclera, shaded under the upper lid
    const scl = ctx.createLinearGradient(0, ey - eh * 1.3, 0, ey + eh);
    scl.addColorStop(0, '#b9b2ad');
    scl.addColorStop(0.45, '#f1ece6');
    scl.addColorStop(1, '#e2dad3');
    ctx.fillStyle = scl;
    ctx.fillRect(ex - ew * 1.2, ey - eh * 2, ew * 2.4, eh * 4);
    // iris, pupil, catch-light
    const ir = eh * 1.12;
    const iy = ey - eh * 0.12;
    const ig = ctx.createRadialGradient(ex, iy, ir * 0.2, ex, iy, ir);
    ig.addColorStop(0, css(mix(iris, [255, 255, 255], 0.12)));
    ig.addColorStop(0.7, css(iris));
    ig.addColorStop(1, css(mix(iris, [0, 0, 0], 0.7)));
    ctx.fillStyle = ig;
    ctx.beginPath();
    ctx.arc(ex, iy, ir, 0, Math.PI * 2);
    ctx.fill();
    ctx.fillStyle = '#0a0706';
    ctx.beginPath();
    ctx.arc(ex, iy, ir * 0.42, 0, Math.PI * 2);
    ctx.fill();
    ctx.fillStyle = 'rgba(255,255,255,0.85)';
    ctx.beginPath();
    ctx.arc(ex - ir * 0.32, iy - ir * 0.36, ir * 0.17, 0, Math.PI * 2);
    ctx.fill();
    ctx.restore();

    // upper lid and lashes: heavier towards the outer corner
    ctx.strokeStyle = css(lidLine, 0.95);
    ctx.lineCap = 'round';
    ctx.lineWidth = eh * 0.34;
    ctx.beginPath();
    ctx.moveTo(inX, inY);
    ctx.bezierCurveTo(ex - s * ew * 0.45, ey - eh * 1.35, ex + s * ew * 0.5, ey - eh * 1.3, outX, outY);
    ctx.stroke();
    ctx.lineWidth = eh * 0.5;
    ctx.beginPath();
    ctx.moveTo(ex + s * ew * 0.25, ey - eh * 1.0);
    ctx.quadraticCurveTo(ex + s * ew * 0.75, ey - eh * 0.9, outX + s * ew * 0.08, outY - eh * 0.1);
    ctx.stroke();
    // lower lid
    ctx.strokeStyle = css(lidLine, 0.38);
    ctx.lineWidth = eh * 0.16;
    ctx.beginPath();
    ctx.moveTo(outX, outY);
    ctx.bezierCurveTo(ex + s * ew * 0.45, ey + eh * 1.05, ex - s * ew * 0.4, ey + eh * 1.1, inX, inY);
    ctx.stroke();
    // lid crease
    ctx.strokeStyle = css(mix(skin, [20, 10, 8], 0.55), 0.4);
    ctx.lineWidth = eh * 0.14;
    ctx.beginPath();
    ctx.moveTo(inX + s * ew * 0.15, inY - eh * 1.2);
    ctx.bezierCurveTo(ex - s * ew * 0.3, ey - eh * 2.1, ex + s * ew * 0.55, ey - eh * 2.05, outX, outY - eh * 0.75);
    ctx.stroke();

    // ---- brow: thick at the inner end, tapering out, set low and level (a player watching the ball)
    const by = py(FACE.browY);
    const b0x = ex - s * ew * 1.12;
    const b1x = ex + s * ew * 1.32;
    const th = eh * 0.95 * kit.brow;
    ctx.fillStyle = css(browCol, dark ? 0.95 : 0.9);
    ctx.beginPath();
    ctx.moveTo(b0x, by + th * 0.1);
    ctx.quadraticCurveTo(ex, by - th * 1.35, b1x, by - th * 0.1);
    ctx.quadraticCurveTo(ex + s * ew * 0.2, by - th * 0.4, b0x + s * th * 0.3, by + th * 0.85);
    ctx.closePath();
    ctx.fill();

    // ---- nostril
    const nx = px(s * 0.085);
    const ny = py(FACE.noseY - 0.055);
    const ng = ctx.createRadialGradient(nx, ny, 0, nx, ny, 0.045 * S);
    ng.addColorStop(0, css(mix(skin, [20, 8, 6], 0.75), 0.6));
    ng.addColorStop(1, css(mix(skin, [20, 8, 6], 0.75), 0));
    ctx.fillStyle = ng;
    ctx.fillRect(nx - 0.05 * S, ny - 0.05 * S, 0.1 * S, 0.1 * S);
  }

  // ---- mouth: closed, set, a hint of lip colour
  const mx = px(0);
  const my = py(FACE.mouthY);
  const mw = 0.2 * S;
  const lip = mix(skin, dark ? [120, 52, 48] : [176, 84, 78], dark ? 0.5 : 0.42);
  ctx.fillStyle = css(lip, 0.6);
  ctx.beginPath();
  ctx.moveTo(mx - mw, my);
  ctx.bezierCurveTo(mx - mw * 0.5, my + 0.085 * S, mx + mw * 0.5, my + 0.085 * S, mx + mw, my);
  ctx.bezierCurveTo(mx + mw * 0.5, my + 0.012 * S, mx - mw * 0.5, my + 0.012 * S, mx - mw, my);
  ctx.fill();
  ctx.fillStyle = css(mix(lip, [40, 14, 12], 0.25), 0.55);
  ctx.beginPath();
  ctx.moveTo(mx - mw, my);
  ctx.bezierCurveTo(mx - mw * 0.45, my - 0.045 * S, mx - mw * 0.12, my - 0.05 * S, mx, my - 0.026 * S);
  ctx.bezierCurveTo(mx + mw * 0.12, my - 0.05 * S, mx + mw * 0.45, my - 0.045 * S, mx + mw, my);
  ctx.bezierCurveTo(mx + mw * 0.5, my + 0.01 * S, mx - mw * 0.5, my + 0.01 * S, mx - mw, my);
  ctx.fill();
  ctx.strokeStyle = css(mix(skin, [28, 8, 8], 0.82), 0.9);
  ctx.lineWidth = 0.014 * S;
  ctx.lineCap = 'round';
  ctx.beginPath();
  ctx.moveTo(mx - mw * 1.04, my - 0.004 * S);
  ctx.bezierCurveTo(mx - mw * 0.5, my + 0.014 * S, mx + mw * 0.5, my + 0.014 * S, mx + mw * 1.04, my - 0.004 * S);
  ctx.stroke();
}

function paintNumber(ctx: CanvasRenderingContext2D, kit: Kit): void {
  const cx = TILE + TILE / 2;
  const cy = TILE / 2;
  const half = TILE / (2 * NUMBER_EXTENT); // pixels per box half-size
  const text = String(kit.number);
  ctx.save();
  ctx.translate(cx, cy);
  ctx.textAlign = 'center';
  ctx.textBaseline = 'alphabetic';
  const size = half * 2.35;
  ctx.font = `900 ${size}px "Arial Narrow", "Helvetica Neue", "Liberation Sans Narrow", Arial, sans-serif`;
  // fit two digits into the box
  const m = ctx.measureText(text);
  const sx = Math.min(1, (half * 1.9) / Math.max(1, m.width));
  const asc = m.actualBoundingBoxAscent || size * 0.72;
  ctx.scale(sx, 1);
  const y = asc / 2;
  ctx.lineJoin = 'round';
  ctx.strokeStyle = css(mix(rgb(kit.jersey), [0, 0, 0], 0.55));
  ctx.lineWidth = half * 0.16;
  ctx.strokeText(text, 0, y);
  ctx.fillStyle = css(rgb(kit.jerseyTrim));
  ctx.fillText(text, 0, y);
  ctx.restore();
}

/** the athlete's decal atlas, or null where there is no canvas (unit tests) */
export function makeKitTexture(kit: Kit): THREE.CanvasTexture | null {
  if (typeof document === 'undefined') return null;
  const c = document.createElement('canvas');
  c.width = TILE * 2;
  c.height = TILE;
  const ctx = c.getContext('2d');
  if (!ctx) return null;
  paintFace(ctx, kit);
  paintNumber(ctx, kit);
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  t.premultiplyAlpha = true;
  t.anisotropy = 4;
  t.wrapS = t.wrapT = THREE.ClampToEdgeWrapping;
  return t;
}
