import * as THREE from 'three';
import { CAMERA, type VenueSpec } from '../config';
import { Rng } from '../core/mathx';

type Sky = NonNullable<VenueSpec['sky']>;

const css = (hex: number, a = 1) => `rgba(${(hex >> 16) & 255},${(hex >> 8) & 255},${hex & 255},${a})`;

/** where a direction lands on the dome's texture (three's sphere mapping), as fractions of its width and height */
function dirToUv(az: number, el: number): [number, number] {
  // azimuth 0 looks down -z (at the far court), positive towards +x
  const x = Math.sin(az) * Math.cos(el);
  const y = Math.sin(el);
  const z = -Math.cos(az) * Math.cos(el);
  let u = Math.atan2(z, -x) / (Math.PI * 2);
  if (u < 0) u += 1;
  return [u, Math.acos(y) / Math.PI];
}

/** The sky, painted once: a gradient from the zenith to the horizon, stars, a sun or a moon, streaks of cloud */
export function makeSkyTexture(sky: Sky): THREE.CanvasTexture {
  const W = 2048;
  const H = 1024;
  const c = document.createElement('canvas');
  c.width = W;
  c.height = H;
  const ctx = c.getContext('2d')!;
  const g = ctx.createLinearGradient(0, 0, 0, H);
  g.addColorStop(0, css(sky.zenith));
  g.addColorStop(0.37, css(sky.mid));
  g.addColorStop(0.49, css(sky.horizon));
  g.addColorStop(0.5, css(sky.horizon));
  g.addColorStop(0.515, css(sky.ground));
  g.addColorStop(1, css(sky.ground));
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, W, H);
  const rng = new Rng(11);
  // stars: even over the dome, thinning towards the haze at the horizon, with a denser band across it
  for (let i = 0; i < sky.stars; i++) {
    const band = i % 3 === 0;
    let el = Math.asin(rng.next());
    let az = rng.range(0, Math.PI * 2);
    if (band) {
      // a great circle tilted across the sky
      const t = rng.range(0, Math.PI * 2);
      const off = rng.gauss() * 0.09;
      const bx = Math.cos(t);
      const by = Math.sin(t) * 0.82 + off * 0.5;
      const bz = Math.sin(t) * 0.57 - off;
      if (by <= 0.02) continue;
      el = Math.asin(Math.min(1, by));
      az = Math.atan2(bx, -bz);
    }
    const [u, v] = dirToUv(az, el);
    const fade = Math.min(1, el / 0.35);
    const mag = Math.pow(rng.next(), band ? 5 : 3.2);
    const a = sky.starLight * fade * (0.25 + 0.75 * mag);
    const r = 0.35 + mag * 0.75;
    ctx.fillStyle = css(rng.next() < 0.2 ? 0xffe2c0 : rng.next() < 0.3 ? 0xc6d6ff : 0xffffff, a);
    // wider near the zenith, where the mapping squeezes the columns together
    const stretch = Math.min(3, 1 / Math.max(0.3, Math.cos(el)));
    ctx.beginPath();
    ctx.ellipse(u * W, v * H, r * stretch, r, 0, 0, Math.PI * 2);
    ctx.fill();
  }
  if (sky.clouds !== null) {
    for (let i = 0; i < 46; i++) {
      const [u, v] = dirToUv(rng.range(0, Math.PI * 2), rng.range(0.03, 0.34));
      const w = rng.range(60, 240);
      const h = rng.range(5, 16);
      const grd = ctx.createRadialGradient(0, 0, 0, 0, 0, 1);
      grd.addColorStop(0, css(sky.clouds, rng.range(0.16, 0.4)));
      grd.addColorStop(1, css(sky.clouds, 0));
      ctx.save();
      ctx.translate(u * W, v * H);
      ctx.scale(w, h);
      ctx.fillStyle = grd;
      ctx.beginPath();
      ctx.arc(0, 0, 1, 0, Math.PI * 2);
      ctx.fill();
      ctx.restore();
    }
  }
  if (sky.disc) {
    const d = sky.disc;
    const [u, v] = dirToUv(d.az, d.el);
    const sx = W / (Math.PI * 2) / Math.max(0.2, Math.cos(d.el));
    const sy = H / Math.PI;
    for (const wrap of [-1, 0, 1]) {
      ctx.save();
      ctx.translate((u + wrap) * W, v * H);
      ctx.scale(sx, sy);
      const glow = ctx.createRadialGradient(0, 0, 0, 0, 0, d.glowSize);
      glow.addColorStop(0, css(d.color, d.glow));
      glow.addColorStop(0.35, css(d.color, d.glow * 0.4));
      glow.addColorStop(1, css(d.color, 0));
      ctx.fillStyle = glow;
      ctx.beginPath();
      ctx.arc(0, 0, d.glowSize, 0, Math.PI * 2);
      ctx.fill();
      ctx.fillStyle = css(d.color);
      ctx.beginPath();
      ctx.arc(0, 0, d.size, 0, Math.PI * 2);
      ctx.fill();
      ctx.restore();
    }
    // the ground takes the haze back below the horizon
    const gg = ctx.createLinearGradient(0, H * 0.5, 0, H * 0.53);
    gg.addColorStop(0, css(sky.ground, 0));
    gg.addColorStop(1, css(sky.ground, 1));
    ctx.fillStyle = gg;
    ctx.fillRect(0, H * 0.5, W, H * 0.5);
  }
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  t.wrapS = THREE.RepeatWrapping;
  t.anisotropy = 4;
  return t;
}

/** the dome itself: behind everything, never fogged and never in the floor's mirror */
export function makeSkyDome(tex: THREE.Texture): THREE.Mesh {
  const dome = new THREE.Mesh(
    new THREE.SphereGeometry(CAMERA.far * 0.7, 48, 32),
    new THREE.MeshBasicMaterial({ map: tex, side: THREE.BackSide, fog: false, depthWrite: false }),
  );
  dome.renderOrder = -10;
  dome.frustumCulled = false;
  // the sky is at no distance: it travels with the lens, so the far plane never cuts it
  dome.matrixAutoUpdate = false;
  dome.onBeforeRender = (_r, _s, camera) => {
    dome.matrixWorld.makeTranslation(camera.matrixWorld.elements[12], camera.matrixWorld.elements[13], camera.matrixWorld.elements[14]);
  };
  dome.userData.noMirror = true;
  return dome;
}
