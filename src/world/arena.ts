import * as THREE from 'three';
import { ARENA, COURT } from '../config';
import { FloorReflection, REFLECT_LAYER } from './floorReflection';
import { mergeGeometries } from './geo';
import { buildBowl } from './stands';
import { makeAntennaTexture, makeBoardTexture, makeNetTexture, makeWoodTextures } from './textures';

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
  readonly reflection: FloorReflection;
  /** the floor and what is painted on it: not part of its own mirror image */
  private unmirrored: THREE.Object3D[] = [];
  /** objects the TP camera must not pass through (net + posts) */
  readonly cameraBlockers: THREE.Box3[] = [];

  constructor(
    private renderer: THREE.WebGLRenderer,
    private scene: THREE.Scene,
  ) {
    this.reflection = new FloorReflection(renderer, scene);
    this.buildFloor();
    this.buildLines();
    this.buildNet();
    this.buildBoards();
    this.buildStands();
    this.buildLights();
    this.scene.add(this.group);
    this.buildEnvironment();
    // everything standing in the hall shows in the floor (the floor itself is taken back out below)
    this.group.traverse((o) => {
      if (!o.userData.noMirror) o.layers.enable(REFLECT_LAYER);
    });
    for (const o of this.unmirrored) o.layers.disable(REFLECT_LAYER);
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
      this.reflection.apply(mat);
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
    this.unmirrored.push(floor);

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
      this.unmirrored.push(m);
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
    this.unmirrored.push(lines);
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
    // referee stand on +x side: a frame of tubes, a platform with a padded front, steps up the back
    const ref = new THREE.Group();
    const frameMat = new THREE.MeshStandardMaterial({ color: 0xc8ccd4, roughness: 0.3, metalness: 0.85 });
    const padMatRef = new THREE.MeshStandardMaterial({ color: 0x1b3f8f, roughness: 0.75 });
    const deckMat = new THREE.MeshStandardMaterial({ color: 0x20242c, roughness: 0.8 });
    const tubeBetween = (a: THREE.Vector3, b: THREE.Vector3, r = 0.022) => {
      const m = new THREE.Mesh(new THREE.CylinderGeometry(r, r, a.distanceTo(b), 8), frameMat);
      m.position.copy(a).lerp(b, 0.5);
      m.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), b.clone().sub(a).normalize());
      m.castShadow = true;
      ref.add(m);
    };
    const P = (x: number, y: number, z: number) => new THREE.Vector3(x, y, z);
    const deckY = 1.25;
    for (const dz of [-0.3, 0.3]) {
      // legs splay out towards the floor; the front pair carries on up to the hand rail
      tubeBetween(P(-0.27, 0, dz * 1.25), P(-0.2, deckY + 0.95, dz));
      tubeBetween(P(0.5, 0, dz * 1.25), P(0.28, deckY, dz));
      tubeBetween(P(-0.24, 0.45, dz * 1.12), P(0.4, 0.45, dz * 1.12), 0.016);
      // steps up the back
      for (let k = 1; k <= 3; k++) tubeBetween(P(0.5 - k * 0.055, k * 0.31, -0.36), P(0.5 - k * 0.055, k * 0.31, 0.36), 0.016);
    }
    tubeBetween(P(-0.2, deckY + 0.95, -0.3), P(-0.2, deckY + 0.95, 0.3));
    const deck = new THREE.Mesh(new THREE.BoxGeometry(0.62, 0.05, 0.72), deckMat);
    deck.position.set(0.04, deckY, 0);
    deck.castShadow = true;
    const pad = new THREE.Mesh(new THREE.BoxGeometry(0.07, 1.0, 0.74), padMatRef);
    pad.position.set(-0.3, deckY + 0.42, 0);
    pad.castShadow = true;
    ref.add(deck, pad);
    ref.position.set(COURT.postX + 0.6, 0, 0);
    this.netGroup.add(ref);
    this.group.add(this.netGroup);
    this.netGroup.traverse((o) => o.layers.enable(REFLECT_LAYER));

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
    const bowl = buildBowl(this.group);
    this.crowdMat = bowl.crowd;
  }

  private buildLights(): void {
    const L = ARENA.light;
    const hemi = new THREE.HemisphereLight(0xe2e9ff, 0xb08c62, L.hemi);
    this.group.add(hemi);
    // key light nearly overhead: the arena look, a readable shadow under each player and no
    // hotspot on the floor. Faces get their light in the athletes' own shader (CHARACTER.sideFill):
    // two low lights from behind the baselines lit them too, and put a glare patch on the varnish
    // in front of the camera
    const key = new THREE.DirectionalLight(0xfff4e6, L.key);
    key.position.set(1.5, 24, 3.5);
    key.target.position.set(0, 0, 0);
    key.castShadow = true;
    key.shadow.mapSize.set(2048, 2048);
    const sc = key.shadow.camera;
    sc.left = -11;
    sc.right = 11;
    sc.top = 14.5;
    sc.bottom = -14.5;
    sc.near = 5;
    sc.far = 40;
    key.shadow.bias = -0.0004;
    key.shadow.normalBias = 0.03;
    key.shadow.radius = 4;
    this.group.add(key, key.target);
    this.keyLight = key;
    // two soft fills from the long sides (no shadows)
    const f1 = new THREE.DirectionalLight(0xdde6ff, L.fill);
    f1.position.set(-10, 18, -5);
    const f2 = new THREE.DirectionalLight(0xfff0dd, L.fill * 0.85);
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
    this.scene.environmentIntensity = ARENA.light.env;
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
