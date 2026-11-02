import * as THREE from 'three';

/**
 * GPU-drawn, CPU-simulated particle pools (no allocation after construction).
 *  - StreakPool: velocity-aligned glowing streaks (sparks), additive HDR
 *  - SpritePool: round soft sprites (dust, puffs, glows), normal or additive
 */

export class StreakPool {
  readonly mesh: THREE.Mesh;
  private pos: Float32Array;
  private vel: Float32Array;
  private life: Float32Array;
  private maxLife: Float32Array;
  private col: Float32Array;
  private size: Float32Array;
  private aPos: THREE.InstancedBufferAttribute;
  private aVel: THREE.InstancedBufferAttribute;
  private aCol: THREE.InstancedBufferAttribute;
  private aLife: THREE.InstancedBufferAttribute;
  private next = 0;
  private alive = 0;

  constructor(private max = 512) {
    const quad = new THREE.PlaneGeometry(1, 1);
    const g = new THREE.InstancedBufferGeometry();
    g.index = quad.index;
    g.attributes.position = quad.attributes.position;
    g.attributes.uv = quad.attributes.uv;
    this.pos = new Float32Array(max * 3);
    this.vel = new Float32Array(max * 3);
    this.life = new Float32Array(max);
    this.maxLife = new Float32Array(max);
    this.col = new Float32Array(max * 3);
    this.size = new Float32Array(max);
    this.aPos = new THREE.InstancedBufferAttribute(this.pos, 3);
    this.aVel = new THREE.InstancedBufferAttribute(this.vel, 3);
    this.aCol = new THREE.InstancedBufferAttribute(this.col, 3);
    const lifeSize = new Float32Array(max * 2);
    this.aLife = new THREE.InstancedBufferAttribute(lifeSize, 2);
    for (const a of [this.aPos, this.aVel, this.aCol, this.aLife]) a.setUsage(THREE.DynamicDrawUsage);
    g.setAttribute('iPos', this.aPos);
    g.setAttribute('iVel', this.aVel);
    g.setAttribute('iCol', this.aCol);
    g.setAttribute('iLife', this.aLife);
    g.instanceCount = max;
    const mat = new THREE.ShaderMaterial({
      transparent: true,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
      vertexShader: /* glsl */ `
        attribute vec3 iPos; attribute vec3 iVel; attribute vec3 iCol; attribute vec2 iLife;
        varying vec2 vUv; varying vec3 vCol; varying float vA;
        void main() {
          vUv = uv;
          float life = iLife.x; // 0..1 remaining
          vec4 c = modelViewMatrix * vec4(iPos, 1.0);
          vec3 v = (modelViewMatrix * vec4(iVel, 0.0)).xyz;
          float sp = length(v);
          vec2 axis = sp > 1e-4 ? normalize(v.xy) : vec2(1.0, 0.0);
          vec2 nrm = vec2(-axis.y, axis.x);
          float len = iLife.y * (0.4 + min(sp * 0.035, 1.6)) * (0.35 + life * 0.65);
          float wid = iLife.y * 0.22 * (0.3 + life * 0.7);
          vec2 off = axis * (position.x * len) + nrm * (position.y * wid);
          c.xy += off;
          vCol = iCol; vA = life;
          gl_Position = life > 0.0 ? projectionMatrix * c : vec4(2.0, 2.0, 2.0, 1.0);
        }`,
      fragmentShader: /* glsl */ `
        varying vec2 vUv; varying vec3 vCol; varying float vA;
        void main() {
          vec2 d = vUv - 0.5;
          float r = length(vec2(d.x * 0.6, d.y * 1.8));
          float a = smoothstep(0.5, 0.0, r) * vA;
          gl_FragColor = vec4(vCol * a, a);
        }`,
    });
    this.mesh = new THREE.Mesh(g, mat);
    this.mesh.frustumCulled = false;
    this.mesh.renderOrder = 6;
  }

  emit(x: number, y: number, z: number, vx: number, vy: number, vz: number, life: number, size: number, r: number, gc: number, b: number): void {
    const i = this.next;
    this.next = (this.next + 1) % this.max;
    this.pos[i * 3] = x;
    this.pos[i * 3 + 1] = y;
    this.pos[i * 3 + 2] = z;
    this.vel[i * 3] = vx;
    this.vel[i * 3 + 1] = vy;
    this.vel[i * 3 + 2] = vz;
    this.life[i] = life;
    this.maxLife[i] = life;
    this.size[i] = size;
    this.col[i * 3] = r;
    this.col[i * 3 + 1] = gc;
    this.col[i * 3 + 2] = b;
    this.alive = Math.max(this.alive, 1);
  }

  update(dt: number): void {
    if (!this.alive) return;
    const ls = this.aLife.array as Float32Array;
    let any = 0;
    for (let i = 0; i < this.max; i++) {
      if (this.life[i] <= 0) {
        ls[i * 2] = 0;
        continue;
      }
      any++;
      this.life[i] -= dt;
      const k = Math.exp(-dt * 2.2);
      this.vel[i * 3] *= k;
      this.vel[i * 3 + 1] = this.vel[i * 3 + 1] * k - 9.8 * dt;
      this.vel[i * 3 + 2] *= k;
      this.pos[i * 3] += this.vel[i * 3] * dt;
      this.pos[i * 3 + 1] += this.vel[i * 3 + 1] * dt;
      this.pos[i * 3 + 2] += this.vel[i * 3 + 2] * dt;
      if (this.pos[i * 3 + 1] < 0.01) {
        this.pos[i * 3 + 1] = 0.01;
        this.vel[i * 3 + 1] *= -0.35;
      }
      ls[i * 2] = Math.max(0, this.life[i] / this.maxLife[i]);
      ls[i * 2 + 1] = this.size[i];
    }
    this.alive = any;
    this.aPos.needsUpdate = this.aVel.needsUpdate = this.aCol.needsUpdate = this.aLife.needsUpdate = true;
  }
}

export class SpritePool {
  readonly points: THREE.Points;
  private pos: Float32Array;
  private vel: Float32Array;
  private life: Float32Array;
  private maxLife: Float32Array;
  private grow: Float32Array;
  private baseSize: Float32Array;
  private sizeA: Float32Array;
  private alphaA: Float32Array;
  private colA: Float32Array;
  private geo: THREE.BufferGeometry;
  private next = 0;
  private alive = 0;
  drag = 2.5;
  gravity = -0.4;

  constructor(private max: number, tex: THREE.Texture, additive: boolean) {
    this.pos = new Float32Array(max * 3);
    this.vel = new Float32Array(max * 3);
    this.life = new Float32Array(max);
    this.maxLife = new Float32Array(max);
    this.grow = new Float32Array(max);
    this.baseSize = new Float32Array(max);
    this.sizeA = new Float32Array(max);
    this.alphaA = new Float32Array(max);
    this.colA = new Float32Array(max * 3);
    this.geo = new THREE.BufferGeometry();
    this.geo.setAttribute('position', new THREE.BufferAttribute(this.pos, 3).setUsage(THREE.DynamicDrawUsage));
    this.geo.setAttribute('aSize', new THREE.BufferAttribute(this.sizeA, 1).setUsage(THREE.DynamicDrawUsage));
    this.geo.setAttribute('aAlpha', new THREE.BufferAttribute(this.alphaA, 1).setUsage(THREE.DynamicDrawUsage));
    this.geo.setAttribute('aCol', new THREE.BufferAttribute(this.colA, 3).setUsage(THREE.DynamicDrawUsage));
    const mat = new THREE.ShaderMaterial({
      uniforms: { uTex: { value: tex }, uScale: { value: 600 } },
      transparent: true,
      depthWrite: false,
      blending: additive ? THREE.AdditiveBlending : THREE.NormalBlending,
      vertexShader: /* glsl */ `
        attribute float aSize; attribute float aAlpha; attribute vec3 aCol;
        uniform float uScale; varying float vA; varying vec3 vCol;
        void main() {
          vec4 mv = modelViewMatrix * vec4(position, 1.0);
          gl_Position = projectionMatrix * mv;
          gl_PointSize = aAlpha > 0.0 ? aSize * uScale / max(0.1, -mv.z) : 0.0;
          vA = aAlpha; vCol = aCol;
        }`,
      fragmentShader: /* glsl */ `
        uniform sampler2D uTex; varying float vA; varying vec3 vCol;
        void main() {
          float a = texture2D(uTex, gl_PointCoord).a * vA;
          if (a < 0.003) discard;
          gl_FragColor = vec4(vCol, a);
        }`,
    });
    this.points = new THREE.Points(this.geo, mat);
    this.points.frustumCulled = false;
    this.points.renderOrder = 5;
  }

  setScale(viewportHeight: number, fovDeg: number): void {
    // pixels per metre at distance 1
    (this.points.material as THREE.ShaderMaterial).uniforms.uScale.value = viewportHeight / (2 * Math.tan((fovDeg * Math.PI) / 360));
  }

  emit(x: number, y: number, z: number, vx: number, vy: number, vz: number, life: number, size: number, grow: number, r: number, g: number, b: number): void {
    const i = this.next;
    this.next = (this.next + 1) % this.max;
    this.pos.set([x, y, z], i * 3);
    this.vel.set([vx, vy, vz], i * 3);
    this.life[i] = this.maxLife[i] = life;
    this.baseSize[i] = size;
    this.grow[i] = grow;
    this.colA.set([r, g, b], i * 3);
    this.alive = 1;
  }

  update(dt: number): void {
    if (!this.alive) return;
    let any = 0;
    for (let i = 0; i < this.max; i++) {
      if (this.life[i] <= 0) {
        this.alphaA[i] = 0;
        continue;
      }
      any++;
      this.life[i] -= dt;
      const t = 1 - Math.max(0, this.life[i] / this.maxLife[i]);
      const k = Math.exp(-dt * this.drag);
      this.vel[i * 3] *= k;
      this.vel[i * 3 + 1] = this.vel[i * 3 + 1] * k + this.gravity * dt;
      this.vel[i * 3 + 2] *= k;
      this.pos[i * 3] += this.vel[i * 3] * dt;
      this.pos[i * 3 + 1] = Math.max(0.02, this.pos[i * 3 + 1] + this.vel[i * 3 + 1] * dt);
      this.pos[i * 3 + 2] += this.vel[i * 3 + 2] * dt;
      this.sizeA[i] = this.baseSize[i] * (1 + this.grow[i] * t);
      this.alphaA[i] = (1 - t) * (1 - t) * Math.min(1, t * 12 + 0.15);
    }
    this.alive = any;
    for (const n of ['position', 'aSize', 'aAlpha', 'aCol']) (this.geo.attributes[n] as THREE.BufferAttribute).needsUpdate = true;
  }
}
