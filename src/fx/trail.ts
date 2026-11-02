import * as THREE from 'three';

/**
 * Camera-facing ribbon that follows the ball. Style 0 = clean white-blue
 * streak (normal spikes), 1 = fire (perfect spikes): HDR orange core with a
 * flickering noise edge so only the effect blooms.
 */
export class Trail {
  readonly mesh: THREE.Mesh;
  private pts: THREE.Vector3[] = [];
  private head = 0;
  private count = 0;
  private geo: THREE.BufferGeometry;
  private posA: Float32Array;
  private tA: Float32Array;
  private sideA: Float32Array;
  private mat: THREE.ShaderMaterial;
  intensity = 0;
  private target = 0;
  style = 0;
  private time = 0;

  constructor(private n = 28) {
    for (let i = 0; i < n; i++) this.pts.push(new THREE.Vector3());
    this.geo = new THREE.BufferGeometry();
    this.posA = new Float32Array(n * 2 * 3);
    this.tA = new Float32Array(n * 2);
    this.sideA = new Float32Array(n * 2);
    const idx: number[] = [];
    for (let i = 0; i < n - 1; i++) {
      const a = i * 2;
      idx.push(a, a + 1, a + 2, a + 1, a + 3, a + 2);
    }
    this.geo.setIndex(idx);
    this.geo.setAttribute('position', new THREE.BufferAttribute(this.posA, 3).setUsage(THREE.DynamicDrawUsage));
    this.geo.setAttribute('aT', new THREE.BufferAttribute(this.tA, 1).setUsage(THREE.DynamicDrawUsage));
    this.geo.setAttribute('aSide', new THREE.BufferAttribute(this.sideA, 1).setUsage(THREE.DynamicDrawUsage));
    this.mat = new THREE.ShaderMaterial({
      uniforms: { uI: { value: 0 }, uStyle: { value: 0 }, uTime: { value: 0 }, uCam: { value: new THREE.Vector3() } },
      transparent: true,
      depthWrite: false,
      side: THREE.DoubleSide,
      blending: THREE.AdditiveBlending,
      vertexShader: /* glsl */ `
        attribute float aT; attribute float aSide;
        varying float vT; varying float vS; varying vec3 vW;
        void main() { vT = aT; vS = aSide; vW = (modelMatrix * vec4(position, 1.0)).xyz; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }`,
      fragmentShader: /* glsl */ `
        uniform float uI; uniform float uStyle; uniform float uTime; uniform vec3 uCam;
        varying float vT; varying float vS; varying vec3 vW;
        float hash(float n) { return fract(sin(n) * 43758.5453); }
        float noise(vec2 p) { vec2 i = floor(p); vec2 f = fract(p); f = f*f*(3.0-2.0*f);
          float a = hash(i.x + i.y*57.0), b = hash(i.x+1.0 + i.y*57.0), c = hash(i.x + (i.y+1.0)*57.0), d = hash(i.x+1.0+(i.y+1.0)*57.0);
          return mix(mix(a,b,f.x), mix(c,d,f.x), f.y); }
        void main() {
          float along = 1.0 - vT;
          float edge = 1.0 - abs(vS);
          // never blind the camera: fade the ribbon close to the lens
          float a = pow(along, 1.6) * smoothstep(0.0, 0.6, edge) * uI * smoothstep(0.5, 2.2, distance(vW, uCam));
          vec3 col;
          if (uStyle > 0.5) {
            float n = noise(vec2(vT * 9.0 - uTime * 14.0, vS * 3.0 + uTime * 3.0));
            float core = smoothstep(0.35, 1.0, edge) * along;
            col = mix(vec3(1.6, 0.3, 0.04), vec3(3.0, 1.9, 0.6), core) * (0.7 + 0.6 * n);
            a *= 0.65 + 0.5 * n;
          } else {
            col = mix(vec3(0.5, 0.75, 1.4), vec3(1.6, 1.7, 1.9), edge) * 0.9;
            a *= 0.6;
          }
          gl_FragColor = vec4(col * a, a);
        }`,
    });
    this.mesh = new THREE.Mesh(this.geo, this.mat);
    this.mesh.frustumCulled = false;
    this.mesh.renderOrder = 7;
    this.mesh.visible = false;
  }

  /** start a trail (style 1 = fire), strength 0..1 */
  ignite(style: number, strength: number, at: THREE.Vector3): void {
    this.style = style;
    this.target = strength;
    this.intensity = Math.max(this.intensity, strength * 0.6);
    this.reset(at);
  }

  reset(at: THREE.Vector3): void {
    for (const p of this.pts) p.copy(at);
    this.count = 1;
    this.head = 0;
  }

  fade(): void {
    this.target = 0;
  }

  update(dt: number, ball: THREE.Vector3, speed: number, cam: THREE.Camera): void {
    this.time += dt;
    // trails die out as the ball slows
    if (speed < 7) this.target = 0;
    this.intensity += (this.target - this.intensity) * Math.min(1, dt * (this.target > this.intensity ? 20 : 5));
    this.mesh.visible = this.intensity > 0.01;
    if (!this.mesh.visible) return;
    const last = this.pts[this.head];
    if (last.distanceToSquared(ball) > 0.0009) {
      this.head = (this.head + 1) % this.n;
      this.pts[this.head].copy(ball);
      this.count = Math.min(this.n, this.count + 1);
    }
    const camPos = cam.position;
    const width = this.style ? 0.14 : 0.085;
    for (let k = 0; k < this.n; k++) {
      const i = (this.head - Math.min(k, this.count - 1) + this.n) % this.n;
      const j = (this.head - Math.min(k + 1, this.count - 1) + this.n) % this.n;
      const p = k === 0 ? ball : this.pts[i];
      const q = this.pts[j];
      _d.subVectors(p, q);
      if (_d.lengthSq() < 1e-8) _d.set(0, 0, 1);
      _v.subVectors(camPos, p);
      _s.crossVectors(_d, _v).normalize();
      const t = k / (this.n - 1);
      const w = width * (1 - t * 0.7);
      this.posA.set([p.x + _s.x * w, p.y + _s.y * w, p.z + _s.z * w], k * 6);
      this.posA.set([p.x - _s.x * w, p.y - _s.y * w, p.z - _s.z * w], k * 6 + 3);
      this.tA[k * 2] = this.tA[k * 2 + 1] = t;
      this.sideA[k * 2] = 1;
      this.sideA[k * 2 + 1] = -1;
    }
    for (const n of ['position', 'aT', 'aSide']) (this.geo.attributes[n] as THREE.BufferAttribute).needsUpdate = true;
    this.mat.uniforms.uI.value = this.intensity;
    this.mat.uniforms.uStyle.value = this.style;
    this.mat.uniforms.uTime.value = this.time;
    (this.mat.uniforms.uCam.value as THREE.Vector3).copy(cam.position);
  }
}

const _d = new THREE.Vector3();
const _v = new THREE.Vector3();
const _s = new THREE.Vector3();
