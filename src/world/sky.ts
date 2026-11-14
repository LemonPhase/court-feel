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

/** The sky, painted once: a gradient from the zenith to the horizon, a sun or a moon, banks of cloud (the stars are `makeStars`) */
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
  if (sky.clouds !== null) {
    // banks of cloud low over the horizon: each a run of overlapping puffs, dusky above, lit from below by the low sun
    const dusk = ((sky.mid >> 16) & 255) * 0.6 + 40;
    const shade = `${dusk | 0},${(((sky.mid >> 8) & 255) * 0.55 + 30) | 0},${((sky.mid & 255) * 0.6 + 40) | 0}`;
    const lit = `${(sky.clouds >> 16) & 255},${(sky.clouds >> 8) & 255},${sky.clouds & 255}`;
    const puff = (x: number, y: number, w: number, h: number, rgb: string, a: number) => {
      for (const wrap of [-W, 0, W]) {
        if (x + wrap < -w || x + wrap > W + w) continue;
        ctx.save();
        ctx.translate(x + wrap, y);
        ctx.scale(w, h);
        const grd = ctx.createRadialGradient(0, 0, 0, 0, 0, 1);
        grd.addColorStop(0, `rgba(${rgb},${a})`);
        grd.addColorStop(0.6, `rgba(${rgb},${a * 0.55})`);
        grd.addColorStop(1, `rgba(${rgb},0)`);
        ctx.fillStyle = grd;
        ctx.beginPath();
        ctx.arc(0, 0, 1, 0, Math.PI * 2);
        ctx.fill();
        ctx.restore();
      }
    };
    for (let i = 0; i < 30; i++) {
      const [u, v] = dirToUv(rng.range(0, Math.PI * 2), rng.range(0.035, 0.36));
      const len = rng.range(90, 300);
      const thick = rng.range(4, 11) * (1 + (0.5 - v) * 6);
      const n = Math.round(len / 14);
      const tilt = rng.range(-0.03, 0.03);
      for (let k = 0; k < n; k++) {
        const t = k / (n - 1) - 0.5;
        const taper = 1 - (2 * t) ** 2 * 0.75;
        const x = u * W + t * len + rng.range(-5, 5);
        const y = v * H + t * len * tilt + rng.range(-1.5, 1.5);
        const w = rng.range(16, 34);
        puff(x, y - thick * 0.25, w, thick * taper, shade, rng.range(0.1, 0.2));
        puff(x, y + thick * 0.3, w * 0.9, thick * taper * 0.5, lit, rng.range(0.14, 0.3));
      }
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

/**
 * The stars: points, not paint. Painted on the dome they were a few texels each and came out as soft blobs;
 * a point is as sharp as the screen is. Even over the dome, thinning into the haze at the horizon, with a
 * denser band across it. They travel with the lens, as the dome does, and are drawn straight after it.
 */
export function makeStars(sky: Sky, renderer: THREE.WebGLRenderer): THREE.Points {
  const rng = new Rng(11);
  const pos: number[] = [];
  const col: number[] = [];
  const size: number[] = [];
  const tint = new THREE.Color();
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
    const fade = Math.min(1, el / 0.35);
    const mag = Math.pow(rng.next(), band ? 5 : 3.2);
    const a = sky.starLight * fade * (0.3 + 0.7 * mag);
    tint.set(rng.next() < 0.2 ? 0xffe2c0 : rng.next() < 0.3 ? 0xc6d6ff : 0xffffff);
    pos.push(Math.sin(az) * Math.cos(el), Math.sin(el), -Math.cos(az) * Math.cos(el));
    col.push(tint.r * a, tint.g * a, tint.b * a);
    size.push(1.3 + mag * 2.2);
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setAttribute('aColor', new THREE.Float32BufferAttribute(col, 3));
  g.setAttribute('aSize', new THREE.Float32BufferAttribute(size, 1));
  const uPx = { value: 1 };
  const mat = new THREE.ShaderMaterial({
    uniforms: { uPx },
    vertexShader: `
      attribute vec3 aColor;
      attribute float aSize;
      uniform float uPx;
      varying vec3 vColor;
      void main() {
        vColor = aColor;
        // a direction, not a place: the view's rotation only
        vec4 mv = viewMatrix * vec4( position, 0.0 );
        gl_Position = projectionMatrix * vec4( mv.xyz, 1.0 );
        gl_PointSize = aSize * uPx;
      }`,
    fragmentShader: `
      varying vec3 vColor;
      void main() {
        float d = length( gl_PointCoord - 0.5 ) * 2.0;
        gl_FragColor = vec4( vColor * smoothstep( 1.0, 0.35, d ), 1.0 );
      }`,
    blending: THREE.AdditiveBlending,
    depthTest: false,
    depthWrite: false,
  });
  const stars = new THREE.Points(g, mat);
  stars.renderOrder = -9;
  stars.frustumCulled = false;
  stars.onBeforeRender = () => {
    uPx.value = renderer.getPixelRatio();
  };
  stars.userData.noMirror = true;
  return stars;
}
