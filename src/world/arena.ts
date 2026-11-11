import * as THREE from 'three';
import { COURT } from '../config';
import { Rng } from '../core/mathx';
import { makeAntennaTexture, makeBoardTexture, makeCrowdAtlas, makeNetTexture, makeWoodTextures } from './textures';

/**
 * Static arena: floor, court, net system, stands, crowd and lighting.
 * Everything here is visual; collision shapes live in physics/ball.ts and use
 * the same COURT constants.
 */
export class Arena {
  readonly group = new THREE.Group();
  netTop: number = COURT.netHeightMen;
  private netGroup = new THREE.Group();
  private crowdMat!: THREE.ShaderMaterial;
  private excitement = 0;
  private time = 0;
  keyLight!: THREE.DirectionalLight;
  envMap: THREE.Texture | null = null;
  /** objects the TP camera must not pass through (net + posts) */
  readonly cameraBlockers: THREE.Box3[] = [];

  constructor(
    private renderer: THREE.WebGLRenderer,
    private scene: THREE.Scene,
  ) {
    this.buildFloor();
    this.buildLines();
    this.buildNet();
    this.buildBoards();
    this.buildStands();
    this.buildRoom();
    this.buildLights();
    this.scene.add(this.group);
    this.buildEnvironment();
  }

  // ---------------------------------------------------------------- floor
  private buildFloor(): void {
    const { map, rough, gray } = makeWoodTextures(4);
    const fullX = COURT.arenaHalfX * 2;
    const fullZ = COURT.arenaHalfZ * 2;
    const mkMat = (color: number, roughness: number, tile = 4, painted = false) => {
      const m = (painted ? gray : map).clone();
      const r = rough.clone();
      m.needsUpdate = r.needsUpdate = true;
      const mat = new THREE.MeshStandardMaterial({
        color,
        map: m,
        roughnessMap: r,
        roughness,
        metalness: 0,
        envMapIntensity: 1,
      });
      return { mat, m, r, tile };
    };
    // natural wood everywhere
    const base = mkMat(0xf2e2d0, 1.4);
    base.m.repeat.set(fullX / 4, fullZ / 4);
    base.r.repeat.copy(base.m.repeat);
    const floor = new THREE.Mesh(new THREE.PlaneGeometry(fullX, fullZ), base.mat);
    floor.rotation.x = -Math.PI / 2;
    floor.receiveShadow = true;
    floor.name = 'floor';
    this.group.add(floor);

    // free zone paint (deep blue, still glossy so reflections read)
    const fzX = COURT.halfWidth + COURT.freeZoneSide;
    const fzZ = COURT.halfLength + COURT.freeZoneEnd;
    const free = mkMat(0x2a63c4, 1.3, 4, true);
    const court = mkMat(0xffe0c0, 1.2);
    const paint = (mat: THREE.MeshStandardMaterial, x0: number, x1: number, z0: number, z1: number, y: number, tex: THREE.Texture[]) => {
      const g = new THREE.PlaneGeometry(x1 - x0, z1 - z0);
      // world-aligned UVs so planks line up with the base floor
      const uv = g.attributes.uv as THREE.BufferAttribute;
      const pos = g.attributes.position as THREE.BufferAttribute;
      for (let i = 0; i < uv.count; i++) {
        const wx = pos.getX(i) + (x0 + x1) / 2;
        const wz = -pos.getY(i) + (z0 + z1) / 2;
        uv.setXY(i, (wx + COURT.arenaHalfX) / 4, (COURT.arenaHalfZ - wz) / 4);
      }
      for (const t of tex) t.repeat.set(1, 1);
      const m = new THREE.Mesh(g, mat);
      m.rotation.x = -Math.PI / 2;
      m.position.set((x0 + x1) / 2, y, (z0 + z1) / 2);
      m.receiveShadow = true;
      this.group.add(m);
    };
    free.mat.polygonOffset = true;
    free.mat.polygonOffsetFactor = -1;
    free.mat.polygonOffsetUnits = -1;
    court.mat.polygonOffset = true;
    court.mat.polygonOffsetFactor = -2;
    court.mat.polygonOffsetUnits = -2;
    const hw = COURT.halfWidth;
    const hl = COURT.halfLength;
    // frame of four rectangles around the court
    paint(free.mat, -fzX, fzX, -fzZ, -hl, 0.001, [free.m, free.r]);
    paint(free.mat, -fzX, fzX, hl, fzZ, 0.001, [free.m, free.r]);
    paint(free.mat, -fzX, -hw, -hl, hl, 0.001, [free.m, free.r]);
    paint(free.mat, hw, fzX, -hl, hl, 0.001, [free.m, free.r]);
    // court interior
    paint(court.mat, -hw, hw, -hl, hl, 0.002, [court.m, court.r]);
  }

  private buildLines(): void {
    const geos: THREE.BufferGeometry[] = [];
    const W = COURT.lineWidth;
    const hw = COURT.halfWidth;
    const hl = COURT.halfLength;
    const rect = (cx: number, cz: number, sx: number, sz: number) => {
      const g = new THREE.PlaneGeometry(sx, sz);
      g.rotateX(-Math.PI / 2);
      g.translate(cx, 0.004, cz);
      geos.push(g);
    };
    // lines are inside the court dimensions
    rect(0, -hl + W / 2, COURT.width, W); // end lines
    rect(0, hl - W / 2, COURT.width, W);
    rect(-hw + W / 2, 0, W, COURT.length); // side lines
    rect(hw - W / 2, 0, W, COURT.length);
    rect(0, 0, COURT.width, W); // centre line
    rect(0, -COURT.attackLine, COURT.width, W); // attack lines
    rect(0, COURT.attackLine, COURT.width, W);
    // dashed extension of the attack lines into the free zone (FIVB)
    for (const s of [-1, 1]) {
      for (const side of [-1, 1]) {
        for (let k = 0; k < 5; k++) {
          const x = side * (hw + 0.2 + k * 0.35 + 0.075);
          rect(x, s * COURT.attackLine, 0.15, W);
        }
      }
    }
    // service zone ticks behind end lines
    for (const s of [-1, 1]) {
      for (const side of [-1, 1]) rect(side * (hw - W / 2), s * (hl + 0.2), W, 0.15);
    }
    const merged = mergeGeometries(geos);
    const mat = new THREE.MeshStandardMaterial({ color: 0xf6f6f2, roughness: 0.5, metalness: 0 });
    mat.polygonOffset = true;
    mat.polygonOffsetFactor = -3;
    mat.polygonOffsetUnits = -3;
    const lines = new THREE.Mesh(merged, mat);
    lines.receiveShadow = true;
    this.group.add(lines);
  }

  // ---------------------------------------------------------------- net system
  private buildNet(): void {
    this.netGroup.clear();
    const top = this.netTop;
    const nd = COURT.netDepth;
    const len = COURT.netHalfLength * 2;
    // mesh
    const netTex = makeNetTexture();
    netTex.repeat.set(len, nd);
    const netMat = new THREE.MeshStandardMaterial({
      map: netTex,
      transparent: true,
      alphaTest: 0.05,
      side: THREE.DoubleSide,
      roughness: 0.9,
      depthWrite: false,
    });
    const net = new THREE.Mesh(new THREE.PlaneGeometry(len, nd), netMat);
    net.position.set(0, top - nd / 2, 0);
    this.netGroup.add(net);
    // white top band (7cm) and bottom band (5cm)
    const bandMat = new THREE.MeshStandardMaterial({ color: 0xf4f4f0, roughness: 0.6 });
    const topBand = new THREE.Mesh(new THREE.BoxGeometry(len, 0.07, 0.012), bandMat);
    topBand.position.set(0, top - 0.035, 0);
    topBand.castShadow = true;
    this.netGroup.add(topBand);
    const botBand = new THREE.Mesh(new THREE.BoxGeometry(len, 0.05, 0.01), bandMat);
    botBand.position.set(0, top - nd + 0.025, 0);
    this.netGroup.add(botBand);
    // side bands above the sidelines
    for (const s of [-1, 1]) {
      const sb = new THREE.Mesh(new THREE.BoxGeometry(0.05, nd, 0.014), bandMat);
      sb.position.set(s * (COURT.halfWidth + 0.025), top - nd / 2, 0);
      this.netGroup.add(sb);
    }
    // cable to posts
    const cableMat = new THREE.MeshStandardMaterial({ color: 0x222222, roughness: 0.4, metalness: 0.6 });
    const cable = new THREE.Mesh(new THREE.CylinderGeometry(0.006, 0.006, COURT.postX * 2, 6), cableMat);
    cable.rotation.z = Math.PI / 2;
    cable.position.set(0, top, 0);
    this.netGroup.add(cable);
    // antennae: 1.8m red/white fibreglass rods
    const antTex = makeAntennaTexture();
    const antLen = nd + COURT.antennaAboveNet;
    antTex.wrapT = THREE.RepeatWrapping;
    antTex.repeat.set(1, antLen / 0.8);
    const antMat = new THREE.MeshStandardMaterial({ map: antTex, roughness: 0.35 });
    for (const s of [-1, 1]) {
      const ant = new THREE.Mesh(new THREE.CylinderGeometry(0.009, 0.009, antLen, 8), antMat);
      ant.position.set(s * COURT.antennaX, top - nd + antLen / 2, 0);
      ant.castShadow = true;
      this.netGroup.add(ant);
    }
    // posts with padding
    const postMat = new THREE.MeshStandardMaterial({ color: 0xb8bcc4, roughness: 0.3, metalness: 0.8 });
    const padMat = new THREE.MeshStandardMaterial({ color: 0x1b3f8f, roughness: 0.75 });
    for (const s of [-1, 1]) {
      const post = new THREE.Mesh(new THREE.CylinderGeometry(COURT.postRadius, COURT.postRadius, 2.6, 16), postMat);
      post.position.set(s * COURT.postX, 1.3, 0);
      post.castShadow = true;
      this.netGroup.add(post);
      const pad = new THREE.Mesh(new THREE.CylinderGeometry(0.16, 0.16, 1.9, 20), padMat);
      pad.position.set(s * COURT.postX, 0.95, 0);
      pad.castShadow = true;
      this.netGroup.add(pad);
    }
    // referee stand on +x side
    const ref = new THREE.Group();
    const frameMat = new THREE.MeshStandardMaterial({ color: 0x2a2f3a, roughness: 0.5, metalness: 0.5 });
    const plat = new THREE.Mesh(new THREE.BoxGeometry(0.7, 0.06, 0.6), frameMat);
    plat.position.y = 1.4;
    ref.add(plat);
    for (const dx of [-0.3, 0.3])
      for (const dz of [-0.25, 0.25]) {
        const leg = new THREE.Mesh(new THREE.BoxGeometry(0.05, 1.4, 0.05), frameMat);
        leg.position.set(dx, 0.7, dz);
        ref.add(leg);
      }
    ref.position.set(COURT.postX + 0.6, 0, 0);
    this.netGroup.add(ref);
    this.group.add(this.netGroup);

    // camera blockers: net slab and posts
    this.cameraBlockers.length = 0;
    this.cameraBlockers.push(
      new THREE.Box3(new THREE.Vector3(-COURT.postX - 0.2, top - nd - 0.05, -0.12), new THREE.Vector3(COURT.postX + 0.2, top + 0.12, 0.12)),
    );
    for (const s of [-1, 1]) {
      this.cameraBlockers.push(
        new THREE.Box3(new THREE.Vector3(s * COURT.postX - 0.3, 0, -0.3), new THREE.Vector3(s * COURT.postX + 0.3, 2.7, 0.3)),
      );
    }
  }

  setNetHeight(h: number): void {
    if (Math.abs(h - this.netTop) < 1e-4) return;
    this.netTop = h;
    this.netGroup.traverse((o) => {
      const m = o as THREE.Mesh;
      if (m.geometry) m.geometry.dispose();
      const mat = m.material as (THREE.Material & { map?: THREE.Texture | null }) | undefined;
      if (mat) {
        mat.map?.dispose();
        mat.dispose();
      }
    });
    this.buildNet();
  }

  // ---------------------------------------------------------------- surroundings
  private buildBoards(): void {
    const tex = makeBoardTexture();
    const mat = new THREE.MeshStandardMaterial({
      map: tex,
      emissive: 0xffffff,
      emissiveMap: tex,
      emissiveIntensity: 0.55,
      roughness: 0.4,
    });
    const fzX = COURT.halfWidth + COURT.freeZoneSide + 0.6;
    const fzZ = COURT.halfLength + COURT.freeZoneEnd + 0.6;
    const h = 0.9;
    const mk = (len: number, x: number, z: number, rotY: number) => {
      const t = tex.clone();
      t.needsUpdate = true;
      t.repeat.set(len / 8, 1);
      const m = mat.clone();
      m.map = t;
      m.emissiveMap = t;
      const b = new THREE.Mesh(new THREE.BoxGeometry(len, h, 0.25), m);
      b.position.set(x, h / 2, z);
      b.rotation.y = rotY;
      this.group.add(b);
    };
    mk(fzX * 2, 0, -fzZ, 0);
    mk(fzX * 2, 0, fzZ, Math.PI);
    mk(fzZ * 2, -fzX, 0, Math.PI / 2);
    mk(fzZ * 2, fzX, 0, -Math.PI / 2);
  }

  private buildStands(): void {
    const standMat = new THREE.MeshStandardMaterial({ color: 0x2b3245, roughness: 0.85 });
    const seatMat = new THREE.MeshStandardMaterial({ color: 0x5b2030, roughness: 0.7 });
    const rows = 9;
    const rowDepth = 0.85;
    const rowRise = 0.48;
    const seats: { x: number; y: number; z: number; rot: number }[] = [];
    // all tiers merged into two meshes (one per material): few draw calls
    const standGeos: THREE.BufferGeometry[] = [];
    const seatGeos: THREE.BufferGeometry[] = [];
    const rng = new Rng(5);
    const sideStart = COURT.halfWidth + COURT.freeZoneSide + 2.2;
    const endStart = COURT.halfLength + COURT.freeZoneEnd + 2.2;
    const addBlock = (axis: 'x' | 'z', sign: number, span: number) => {
      for (let r = 0; r < rows; r++) {
        const d = (axis === 'x' ? sideStart : endStart) + r * rowDepth;
        const y = 0.7 + r * rowRise;
        const g = new THREE.BoxGeometry(axis === 'x' ? rowDepth : span, y, axis === 'x' ? span : rowDepth);
        if (axis === 'x') g.translate(sign * (d + rowDepth / 2), y / 2, 0);
        else g.translate(0, y / 2, sign * (d + rowDepth / 2));
        (r % 2 ? standGeos : seatGeos).push(g);
        // fans
        const n = Math.floor(span / 0.55);
        for (let i = 0; i < n; i++) {
          if (rng.next() < 0.12) continue; // empty seats
          const along = -span / 2 + (i + 0.5) * (span / n) + rng.range(-0.08, 0.08);
          const rot = axis === 'x' ? (sign > 0 ? -Math.PI / 2 : Math.PI / 2) : sign > 0 ? Math.PI : 0;
          if (axis === 'x') seats.push({ x: sign * (d + rowDepth * 0.45), y: y, z: along, rot });
          else seats.push({ x: along, y: y, z: sign * (d + rowDepth * 0.45), rot });
        }
      }
    };
    addBlock('x', -1, 30);
    addBlock('x', 1, 30);
    addBlock('z', -1, 2 * (COURT.halfWidth + COURT.freeZoneSide + 1.5));
    addBlock('z', 1, 2 * (COURT.halfWidth + COURT.freeZoneSide + 1.5));
    this.group.add(new THREE.Mesh(mergeGeometries(standGeos), standMat), new THREE.Mesh(mergeGeometries(seatGeos), seatMat));
    this.buildCrowd(seats);
  }

  private buildCrowd(seats: { x: number; y: number; z: number; rot: number }[]): void {
    const { tex, cols, rows } = makeCrowdAtlas();
    const w = 0.55;
    const h = 0.82;
    const geo = new THREE.PlaneGeometry(w, h);
    geo.translate(0, h / 2 - 0.12, 0);
    const inst = new THREE.InstancedBufferGeometry();
    inst.index = geo.index;
    inst.attributes.position = geo.attributes.position;
    inst.attributes.uv = geo.attributes.uv;
    const n = seats.length;
    const offsets = new Float32Array(n * 4); // x y z rot
    const params = new Float32Array(n * 4); // atlas idx, phase, tint, energy
    const rng = new Rng(77);
    seats.forEach((s, i) => {
      offsets.set([s.x, s.y, s.z, s.rot], i * 4);
      params.set([Math.floor(rng.next() * cols * rows), rng.range(0, Math.PI * 2), rng.range(0.75, 1.05), rng.range(0.4, 1.2)], i * 4);
    });
    inst.setAttribute('aOffset', new THREE.InstancedBufferAttribute(offsets, 4));
    inst.setAttribute('aParams', new THREE.InstancedBufferAttribute(params, 4));
    inst.instanceCount = n;
    this.crowdMat = new THREE.ShaderMaterial({
      uniforms: {
        uTex: { value: tex },
        uGrid: { value: new THREE.Vector2(cols, rows) },
        uTime: { value: 0 },
        uExcite: { value: 0 },
      },
      vertexShader: /* glsl */ `
        attribute vec4 aOffset;
        attribute vec4 aParams;
        uniform float uTime;
        uniform float uExcite;
        uniform vec2 uGrid;
        varying vec2 vUv;
        varying float vTint;
        void main() {
          float idx = aParams.x;
          float col = mod(idx, uGrid.x);
          float row = floor(idx / uGrid.x);
          vUv = (uv + vec2(col, uGrid.y - 1.0 - row)) / uGrid;
          vTint = aParams.z;
          float idle = sin(uTime * (1.3 + aParams.w) + aParams.y) * 0.015;
          float jump = max(0.0, sin(uTime * (7.0 + aParams.w * 3.0) + aParams.y)) * 0.28 * uExcite * aParams.w;
          vec3 p = position;
          p.y += idle + jump;
          float c = cos(aOffset.w), s = sin(aOffset.w);
          vec3 r = vec3(p.x * c + p.z * s, p.y, -p.x * s + p.z * c);
          // fans face the court: rotate the quad
          vec3 world = r + aOffset.xyz;
          gl_Position = projectionMatrix * viewMatrix * vec4(world, 1.0);
        }
      `,
      fragmentShader: /* glsl */ `
        uniform sampler2D uTex;
        varying vec2 vUv;
        varying float vTint;
        void main() {
          vec4 c = texture2D(uTex, vUv);
          if (c.a < 0.5) discard;
          gl_FragColor = vec4(c.rgb * 0.42 * vTint, 1.0);
          #include <colorspace_fragment>
        }
      `,
    });
    const mesh = new THREE.Mesh(inst, this.crowdMat);
    mesh.frustumCulled = false;
    this.group.add(mesh);
  }

  private buildRoom(): void {
    const X = COURT.arenaHalfX + 6;
    const Z = COURT.arenaHalfZ + 6;
    const H = 16;
    const wallMat = new THREE.MeshStandardMaterial({ color: 0x232a3d, roughness: 0.95, side: THREE.BackSide });
    const room = new THREE.Mesh(new THREE.BoxGeometry(X * 2, H, Z * 2), wallMat);
    room.position.y = H / 2 - 0.01;
    this.group.add(room);
    // ceiling light banks (emissive, kept below bloom threshold)
    const lightMat = new THREE.MeshBasicMaterial({ color: new THREE.Color(0.9, 0.92, 0.95) });
    const lg = new THREE.PlaneGeometry(2.2, 0.6);
    lg.rotateX(Math.PI / 2);
    const banks: THREE.BufferGeometry[] = [];
    for (let i = -3; i <= 3; i++) {
      for (const sx of [-6, -2, 2, 6]) {
        const g = lg.clone();
        g.translate(sx, H - 0.6, i * 5);
        banks.push(g);
      }
    }
    const bankMesh = new THREE.Mesh(mergeGeometries(banks), lightMat);
    this.group.add(bankMesh);
    // centre-hung scoreboard cube
    const sbMat = new THREE.MeshStandardMaterial({ color: 0x0c0e14, roughness: 0.5, metalness: 0.6 });
    const sb = new THREE.Mesh(new THREE.BoxGeometry(4.2, 2.4, 4.2), sbMat);
    sb.position.set(0, H - 3.2, 0);
    this.group.add(sb);
    const screenMat = new THREE.MeshBasicMaterial({ color: new THREE.Color(0.16, 0.3, 0.75) });
    const screens: THREE.BufferGeometry[] = [];
    for (let k = 0; k < 4; k++) {
      const a = (k * Math.PI) / 2;
      const g = new THREE.PlaneGeometry(3.8, 2.0);
      g.rotateY(a);
      g.translate(Math.sin(a) * 2.12, H - 3.2, Math.cos(a) * 2.12);
      screens.push(g);
    }
    this.group.add(new THREE.Mesh(mergeGeometries(screens), screenMat));
    // trusses
    const trussMat = new THREE.MeshStandardMaterial({ color: 0x30343e, roughness: 0.6, metalness: 0.4 });
    const trusses: THREE.BufferGeometry[] = [];
    for (let i = -3; i <= 3; i++) {
      const g = new THREE.BoxGeometry(X * 2, 0.35, 0.3);
      g.translate(0, H - 0.3, i * 5);
      trusses.push(g);
    }
    this.group.add(new THREE.Mesh(mergeGeometries(trusses), trussMat));
    // team banners hanging on the long walls
    const colors = [0xd23a2a, 0x2456c8, 0xf2b632, 0x22a06b, 0xf5f5f5];
    const rng = new Rng(3);
    const byColor = new Map<number, THREE.BufferGeometry[]>();
    for (const s of [-1, 1]) {
      for (let i = -4; i <= 4; i++) {
        const c = colors[Math.floor(rng.next() * colors.length)];
        const g = new THREE.PlaneGeometry(1.6, 3.2);
        g.rotateY((-s * Math.PI) / 2);
        g.translate(s * (X - 0.05), H - 4, i * 4.2);
        if (!byColor.has(c)) byColor.set(c, []);
        byColor.get(c)!.push(g);
      }
    }
    for (const [c, geos] of byColor) {
      this.group.add(
        new THREE.Mesh(mergeGeometries(geos), new THREE.MeshStandardMaterial({ color: c, roughness: 0.9, side: THREE.DoubleSide })),
      );
    }
  }

  private buildLights(): void {
    const hemi = new THREE.HemisphereLight(0xdfe6ff, 0x9a7650, 0.42);
    this.group.add(hemi);
    // key light nearly overhead: the arena look, a readable shadow under each player and no
    // hotspot on the floor
    const key = new THREE.DirectionalLight(0xfff4e6, 2.1);
    key.position.set(1.5, 24, 3.5);
    key.target.position.set(0, 0, 0);
    key.castShadow = true;
    key.shadow.mapSize.set(2048, 2048);
    const sc = key.shadow.camera;
    sc.left = -12;
    sc.right = 12;
    sc.top = 15;
    sc.bottom = -15;
    sc.near = 5;
    sc.far = 40;
    key.shadow.bias = -0.0004;
    key.shadow.normalBias = 0.03;
    key.shadow.radius = 4;
    this.group.add(key, key.target);
    this.keyLight = key;
    // two soft fills from the long sides (no shadows)
    const f1 = new THREE.DirectionalLight(0xdde6ff, 0.55);
    f1.position.set(-10, 18, -5);
    const f2 = new THREE.DirectionalLight(0xfff0dd, 0.45);
    f2.position.set(10, 18, 7);
    this.group.add(f1, f2);
  }

  /** Bake a simple room into a PMREM env map for floor and ball reflections. */
  private buildEnvironment(): void {
    const envScene = new THREE.Scene();
    envScene.background = new THREE.Color(0x10131c);
    const box = new THREE.Mesh(new THREE.BoxGeometry(60, 18, 60), new THREE.MeshBasicMaterial({ color: 0x1a1f2c, side: THREE.BackSide }));
    box.position.y = 8;
    envScene.add(box);
    const panel = new THREE.MeshBasicMaterial({ color: new THREE.Color(5.0, 5.0, 4.7) });
    for (let i = -3; i <= 3; i++) {
      for (const sx of [-6, -2, 2, 6]) {
        const p = new THREE.Mesh(new THREE.PlaneGeometry(2.2, 0.6), panel);
        p.rotation.x = Math.PI / 2;
        p.position.set(sx, 15, i * 5);
        envScene.add(p);
      }
    }
    // stands (colourful crowd) on all four sides
    const standMat = new THREE.MeshBasicMaterial({ color: new THREE.Color(0.55, 0.32, 0.36) });
    for (const sx of [-1, 1]) {
      const s = new THREE.Mesh(new THREE.BoxGeometry(6, 5, 40), standMat);
      s.position.set(sx * 17, 3, 0);
      envScene.add(s);
      const e = new THREE.Mesh(new THREE.BoxGeometry(30, 5, 6), standMat);
      e.position.set(0, 3, sx * 22);
      envScene.add(e);
    }
    // ring of upper lights / balcony glow: gives the floor visible sheen
    const ringMat = new THREE.MeshBasicMaterial({ color: new THREE.Color(3.2, 3.0, 2.7) });
    for (const sx of [-1, 1]) {
      const a = new THREE.Mesh(new THREE.BoxGeometry(0.4, 0.5, 44), ringMat);
      a.position.set(sx * 19.5, 9, 0);
      envScene.add(a);
      const b = new THREE.Mesh(new THREE.BoxGeometry(38, 0.5, 0.4), ringMat);
      b.position.set(0, 9, sx * 25);
      envScene.add(b);
    }
    // LED boards around the free zone
    const boardMat = new THREE.MeshBasicMaterial({ color: new THREE.Color(0.25, 0.4, 1.0) });
    for (const sx of [-1, 1]) {
      const a = new THREE.Mesh(new THREE.BoxGeometry(0.2, 0.9, 32), boardMat);
      a.position.set(sx * 9.1, 0.45, 0);
      envScene.add(a);
      const b = new THREE.Mesh(new THREE.BoxGeometry(18, 0.9, 0.2), boardMat);
      b.position.set(0, 0.45, sx * 16.1);
      envScene.add(b);
    }
    const pmrem = new THREE.PMREMGenerator(this.renderer);
    const rt = pmrem.fromScene(envScene, 0.035, 0.1, 100);
    this.envMap = rt.texture;
    this.scene.environment = rt.texture;
    this.scene.environmentIntensity = 0.45;
    pmrem.dispose();
  }

  excite(amount: number): void {
    this.excitement = Math.min(1.5, this.excitement + amount);
  }

  update(dt: number): void {
    this.time += dt;
    this.excitement *= Math.exp(-dt * 1.3);
    if (this.crowdMat) {
      this.crowdMat.uniforms.uTime.value = this.time;
      this.crowdMat.uniforms.uExcite.value = Math.min(1, this.excitement);
    }
  }
}

/** Minimal geometry merge (positions, normals, uvs) to avoid pulling extra deps. */
export function mergeGeometries(geos: THREE.BufferGeometry[]): THREE.BufferGeometry {
  let vCount = 0;
  let iCount = 0;
  for (const g of geos) {
    vCount += g.attributes.position.count;
    iCount += g.index ? g.index.count : g.attributes.position.count;
  }
  const pos = new Float32Array(vCount * 3);
  const nor = new Float32Array(vCount * 3);
  const uv = new Float32Array(vCount * 2);
  const idx = new Uint32Array(iCount);
  let vo = 0;
  let io = 0;
  for (const g of geos) {
    const p = g.attributes.position as THREE.BufferAttribute;
    const n = g.attributes.normal as THREE.BufferAttribute | undefined;
    const u = g.attributes.uv as THREE.BufferAttribute | undefined;
    pos.set(p.array as Float32Array, vo * 3);
    if (n) nor.set(n.array as Float32Array, vo * 3);
    if (u) uv.set(u.array as Float32Array, vo * 2);
    if (g.index) {
      for (let i = 0; i < g.index.count; i++) idx[io++] = g.index.getX(i) + vo;
    } else {
      for (let i = 0; i < p.count; i++) idx[io++] = i + vo;
    }
    vo += p.count;
    g.dispose();
  }
  const out = new THREE.BufferGeometry();
  out.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  out.setAttribute('normal', new THREE.BufferAttribute(nor, 3));
  out.setAttribute('uv', new THREE.BufferAttribute(uv, 2));
  out.setIndex(new THREE.BufferAttribute(idx, 1));
  return out;
}
