import * as THREE from 'three';
import { FX } from '../config';
import { clamp01, lerp, smooth01 } from '../core/mathx';
import type { Game } from '../game/game';
import type { ContactEvent } from '../game/contact';
import { AudioEngine } from '../audio/audio';
import { makeBlobTexture, makeCrackTexture, makeRingTexture } from '../world/textures';
import { SpritePool, StreakPool } from './particles';
import { Replay, type ReplayEvent } from './replay';
import { Trail } from './trail';

interface Ring {
  mesh: THREE.Mesh;
  t: number;
  dur: number;
  size: number;
  strength: number;
}

interface Decal {
  mesh: THREE.Mesh;
  t: number;
}

/**
 * The juice: turns game events into sparks, trails, shockwaves, dust, crack
 * decals, hand flashes, hit-stop, camera shake, sound and the slow-motion
 * replay. Everything scales with timing quality so a Perfect feels earned.
 */
export class Effects {
  readonly audio = new AudioEngine();
  readonly sparks = new StreakPool(600);
  readonly dust: SpritePool;
  readonly glow: SpritePool;
  readonly trail = new Trail(30);
  readonly replay = new Replay(4.5, 60);
  private rings: Ring[] = [];
  private decals: Decal[] = [];
  private decalNext = 0;
  private pendingImpact: { q: number; perfect: boolean; user: boolean; speed: number } | null = null;
  private replayAt = -1;
  private replayFrom = 0;
  private replayTo = 0;
  replaying = false;
  private cineA = new THREE.Vector3();
  private cineB = new THREE.Vector3();
  private cineLookA = new THREE.Vector3();
  private letterbox: HTMLDivElement;
  private replayTag: HTMLDivElement;
  private flashes: { m: THREE.Sprite; t: number; follow: THREE.Vector3 | null }[] = [];
  /** shock rings in the air around a Perfect spike's path */
  private airRings: Ring[] = [];
  /** ball squash on contact / floor slam */
  private sq = { amount: 0, t: 0, q: new THREE.Quaternion() };

  constructor(private g: Game, parent: HTMLElement) {
    const scene = g.scene;
    scene.add(this.sparks.mesh);
    this.dust = new SpritePool(220, makeBlobTexture(0, 0.35), false);
    this.dust.drag = 3.2;
    this.dust.gravity = 0.25;
    this.glow = new SpritePool(80, makeBlobTexture(0, 0.2), true);
    this.glow.drag = 6;
    this.glow.gravity = 0;
    scene.add(this.dust.points, this.glow.points, this.trail.mesh);
    // shockwave rings
    const ringTex = makeRingTexture(0.16);
    for (let i = 0; i < 4; i++) {
      const m = new THREE.Mesh(
        new THREE.PlaneGeometry(1, 1),
        new THREE.MeshBasicMaterial({ map: ringTex, color: 0xffffff, transparent: true, opacity: 0, depthWrite: false, blending: THREE.AdditiveBlending }),
      );
      m.rotation.x = -Math.PI / 2;
      m.visible = false;
      m.renderOrder = 4;
      scene.add(m);
      this.rings.push({ mesh: m, t: 1, dur: 0.4, size: 3, strength: 0 });
    }
    const airTex = makeRingTexture(0.07);
    for (let i = 0; i < 2; i++) {
      const m = new THREE.Mesh(
        new THREE.PlaneGeometry(1, 1),
        new THREE.MeshBasicMaterial({ map: airTex, color: new THREE.Color(3.2, 2.6, 1.7), transparent: true, opacity: 0, depthWrite: false, side: THREE.DoubleSide, blending: THREE.AdditiveBlending }),
      );
      m.visible = false;
      m.renderOrder = 7;
      scene.add(m);
      this.airRings.push({ mesh: m, t: 1, dur: 0.2, size: 1, strength: 0 });
    }
    // crack decals
    for (let i = 0; i < 4; i++) {
      const m = new THREE.Mesh(
        new THREE.PlaneGeometry(1.5, 1.5),
        new THREE.MeshBasicMaterial({ map: makeCrackTexture(11 + i * 7), transparent: true, opacity: 0, depthWrite: false, polygonOffset: true, polygonOffsetFactor: -4 }),
      );
      m.rotation.x = -Math.PI / 2;
      m.visible = false;
      m.renderOrder = 3;
      scene.add(m);
      this.decals.push({ mesh: m, t: 1e9 });
    }
    // hand / contact flashes
    const flashMat = new THREE.SpriteMaterial({ map: makeBlobTexture(0, 0.15), color: new THREE.Color(3, 3.2, 3.6), transparent: true, depthWrite: false, blending: THREE.AdditiveBlending });
    for (let i = 0; i < 6; i++) {
      const s = new THREE.Sprite(flashMat.clone());
      s.visible = false;
      s.renderOrder = 8;
      scene.add(s);
      this.flashes.push({ m: s, t: 1, follow: null });
    }
    this.letterbox = document.createElement('div');
    this.letterbox.className = 'letterbox';
    this.replayTag = document.createElement('div');
    this.replayTag.className = 'replay-tag';
    this.replayTag.innerHTML = '<span>●</span> REPLAY <small>any key to skip</small>';
    parent.append(this.letterbox, this.replayTag);

    this.replay.onEvent = (e) => this.playEvent(e, true);
    this.wire();
  }

  private wire(): void {
    const g = this.g;
    const ev = g.events;
    ev.on('contact', (e) => this.onContact(e));
    ev.on('aiContact', (e) => {
      this.trail.intensity = 0;
      this.trail.fade();
      this.pendingImpact = null;
      if (e.kind === 'set') this.audio.set();
      if (e.kind === 'pass' || e.kind === 'dig') this.audio.pass(0.5);
    });
    ev.on('ballEvent', (e) => {
      if (e.kind === 'floor') {
        const imp = this.pendingImpact;
        if (imp && e.impact > 6) {
          this.pendingImpact = null;
          const data = { x: e.x, z: e.z, q: imp.q, perfect: imp.perfect ? 1 : 0, speed: imp.speed, user: imp.user ? 1 : 0 };
          this.playEvent({ t: g.simTime, kind: 'impact', data }, false);
          this.replay.addEvent(g.simTime, 'impact', data);
          if (imp.perfect && imp.user && g.settings.replays && FX.replayEnabled && !g.inMenu) {
            this.replayAt = g.simTime + 0.55;
            this.replayTo = g.simTime + FX.replayPost;
            this.replay.impact.set(e.x, 0, e.z);
            this.replay.impactT = g.simTime;
          }
        } else this.audio.floor(e.impact);
        if (e.impact > 4) this.puff(e.x, 0.05, e.z, 4, 0.18, 0.5);
      } else if (e.kind === 'net' || e.kind === 'tape') this.audio.net(e.impact);
      else if (e.kind === 'antenna') this.audio.antenna();
      else if (e.kind === 'board' || e.kind === 'post') this.audio.floor(e.impact * 0.6);
    });
    ev.on('land', ({ athlete, impact }) => {
      if (!this.near(athlete.pos)) return;
      this.audio.land(impact);
      if (impact > 3.4) {
        this.audio.squeak(0.4);
        this.puff(athlete.pos.x, 0.05, athlete.pos.z, 5, 0.22, 0.6);
      }
      if (athlete.isUser) g.rig.addTrauma(FX.shakeLand * clamp01(impact / 4.5));
    });
    ev.on('step', ({ athlete, speed }) => {
      const near = this.near(athlete.pos, 9);
      this.audio.step(speed, near);
      if (near && speed > 4.2 && Math.random() < 0.25) this.audio.squeak(0.3);
    });
    ev.on('takeoff', ({ athlete }) => {
      if (this.near(athlete.pos, 10)) this.audio.squeak(0.8);
    });
    ev.on('outcome', () => {
      if (g.modeId === 'rally') setTimeout(() => this.audio.whistle(), 250);
    });
    ev.on('crowd', ({ amount, cheer }) => this.audio.crowd(amount, cheer));
  }

  private near(p: THREE.Vector3, r = 12): boolean {
    return p.distanceTo(this.g.rig.camera.position) < r;
  }

  private onContact(e: ContactEvent): void {
    const g = this.g;
    const user = e.athlete.isUser;
    const p = e.point;
    // a new touch ends the previous ball's trail (attacks re-ignite their own) and
    // cancels the previous attack's floor-impact package (a blocked/dug Perfect spike
    // must not crack the floor wherever the ball later drops)
    if (e.kind === 'pass' || e.kind === 'dig' || e.kind === 'set' || e.kind === 'block') {
      this.trail.intensity = 0;
      this.trail.fade();
      this.pendingImpact = null;
    }
    switch (e.kind) {
      case 'spike':
      case 'serve': {
        if (e.grade === 'Miss') return;
        const q = e.quality;
        const vel = g.ball.vel;
        const data = { x: p.x, y: p.y, z: p.z, q, perfect: e.perfect ? 1 : 0, vx: vel.x, vy: vel.y, vz: vel.z, serve: e.kind === 'serve' ? 1 : 0 };
        this.playEvent({ t: g.simTime, kind: 'spike', data }, false);
        this.replay.addEvent(g.simTime, 'spike', data);
        this.pendingImpact = { q, perfect: e.perfect, user, speed: e.speed };
        if (user || this.near(p, 8)) {
          if (e.perfect && user) {
            // the harder it was hit, the longer the freeze and the bigger the punch
            const pw = AudioEngine.powerFromSpeed(e.speed);
            g.hitStop = (FX.hitStopPerfect + FX.hitStopPower * pw) * FX.intensity;
            g.rig.addTrauma(FX.shakePerfect * FX.intensity);
            g.rig.punchFov(-FX.fovPunch * (0.5 + 0.5 * pw) * (g.rig.mode === 'fp' ? FX.fpPunchScale : 1) * FX.intensity);
            g.rig.kick(-FX.kickContact * pw * FX.intensity, 0);
            this.audio.perfectChime();
            if (!this.replay.playing) {
              this.replay.contactT = g.simTime;
              this.replayFrom = g.simTime - FX.replayPre;
              this.replay.focus.copy(p);
            }
          } else if (user) g.rig.addTrauma(FX.shakeGood * q);
          else g.rig.addTrauma(0.12 * q);
        }
        break;
      }
      case 'tip':
        this.audio.tip();
        this.trail.ignite(0, 0.25, g.ball.rpos);
        break;
      case 'block': {
        const stuff = e.quality >= 0.7;
        const v = g.views.get(e.athlete);
        this.audio.block(stuff);
        if (v) {
          // your own hands in first person are right at the lens: a small, cooler flash
          const fpSelf = user && g.rig.mode === 'fp';
          const size = fpSelf ? 0.12 : stuff ? 0.75 : 0.45;
          const col = fpSelf ? new THREE.Color(0.9, 1.2, 1.6) : new THREE.Color(2.2, 3.2, 4.2);
          this.flash(v.palmL, size, col);
          this.flash(v.palmR, size, col);
        }
        this.burst(p, stuff ? 26 : 10, new THREE.Color(2.5, 3.2, 4.5), 5, stuff ? (user && g.rig.mode === 'fp' ? 0.5 : 1) : 0.6);
        if (stuff) this.trail.ignite(0, 0.7, g.ball.rpos);
        if (user || this.near(p, 6)) {
          g.rig.addTrauma(FX.shakeBlock * (stuff ? 1 : 0.5) * (user ? 1 : 0.4));
          if (user && stuff) g.hitStop = FX.hitStopBlock;
        }
        if (stuff) g.crowd(user ? 1.0 : 0.5, true);
        break;
      }
      case 'pass':
      case 'dig': {
        const a = e.athlete;
        this.audio.pass(e.kind === 'dig' ? 0.9 : 0.6);
        this.puff(a.pos.x, 0.06, a.pos.z, e.kind === 'dig' ? 9 : 5, e.kind === 'dig' ? 0.32 : 0.2, 0.75);
        this.glowAt(p, 0.14, new THREE.Color(0.7, 0.65, 0.55));
        if (e.kind === 'dig') g.crowd(e.grade === 'Perfect' || e.grade === 'Good' ? 0.55 : 0.25, true);
        break;
      }
      case 'set':
        this.audio.set();
        if (e.perfect && user) this.glowAt(p, 0.14, new THREE.Color(1.0, 0.95, 0.7));
        break;
    }
  }

  /** visual events, live or from the replay */
  private playEvent(e: ReplayEvent, fromReplay: boolean): void {
    const d = e.data;
    const g = this.g;
    if (e.kind === 'spike') {
      const q = d.q;
      const perfect = d.perfect > 0.5;
      const at = new THREE.Vector3(d.x, d.y, d.z);
      const rate = fromReplay ? 0.55 : 1;
      // the sound follows how hard the ball was actually hit (and how close it is)
      const speed = Math.hypot(d.vx, d.vy, d.vz);
      const near = fromReplay ? 1 : Math.max(0, Math.min(1, 1.35 - at.distanceTo(g.rig.camera.position) / 16));
      const pw = AudioEngine.powerFromSpeed(speed);
      this.audio.spike(pw, perfect, rate, near);
      const dir = new THREE.Vector3(d.vx, d.vy, d.vz);
      const col = perfect ? new THREE.Color(6, 3.8, 1.4) : q > 0.5 ? new THREE.Color(3.2, 3.0, 2.6) : new THREE.Color(1.6, 1.6, 1.6);
      const n = Math.round(FX.sparkCount * FX.intensity * (perfect ? 1 + 0.3 * pw : q > 0.5 ? 0.35 : 0.12));
      this.burst(at, n, col, perfect ? 11 + 3 * pw : 6, perfect ? 1.3 : 0.8, dir);
      this.glowAt(at, perfect ? 0.32 : 0.18, perfect ? new THREE.Color(2.4, 1.6, 0.7) : new THREE.Color(1.1, 1.1, 1.1));
      this.trail.ignite(perfect ? 1 : 0, perfect ? 1 : q > 0.5 ? 0.75 : 0.45, fromReplay ? at : g.ball.rpos);
      // the ball squashes on the hand: held through the hit-stop, then it wobbles back into shape
      this.squash(dir, FX.squashContact * pw * (perfect ? 1 : 0.5) * FX.intensity);
      if (perfect) {
        // a shock ring around the ball's new path, bursting out when the freeze ends. Sized and
        // dimmed by distance: in first person the contact is right in front of the lens
        const dist = at.distanceTo(g.rig.camera.position);
        const far = clamp01((dist - 1.0) / 2.5);
        this.airRing(at, dir, Math.min(0.95, dist * 0.6) * (0.6 + 0.4 * pw), lerp(0.3, 0.6, far) * (0.5 + 0.5 * pw));
      }
    } else if (e.kind === 'impact') {
      const q = d.q;
      const perfect = d.perfect > 0.5;
      const rate = fromReplay ? 0.55 : 1;
      // how hard it comes down follows the attack's speed, continuously (a full-power spike = 1)
      const pw = AudioEngine.powerFromSpeed(d.speed);
      this.audio.floor(d.speed * (0.8 + q), pw, rate);
      this.shockwave(d.x, d.z, perfect ? 3.6 : 1.4 + q * 1.4, perfect ? 1 : 0.35 + q * 0.4, perfect);
      this.dustRing(d.x, d.z, perfect ? 34 : Math.round(10 + q * 14), perfect ? 1 : 0.6);
      if (perfect || d.speed > 26) this.crack(d.x, d.z, perfect ? 1.0 : 0.6);
      this.squash(_up, FX.squashImpact * pw * (perfect ? 1 : 0.6) * FX.intensity);
      if (perfect) {
        // a fast bright inner ring, a flash on the boards and wood chips kicked up
        this.shockwave(d.x, d.z, 1.5 + 0.5 * pw, 1, true, 0.2);
        this.glowAt(new THREE.Vector3(d.x, 0.15, d.z), 0.4 + 0.3 * pw, new THREE.Color(3.2, 2.3, 1.1), 0.2);
        this.burst(new THREE.Vector3(d.x, 0.06, d.z), Math.round(18 + 16 * pw), new THREE.Color(3.2, 2.2, 1.1), 5, 0.8, new THREE.Vector3(0, 7, 0));
      }
      if (!fromReplay) {
        g.crowd(perfect ? 1.3 : 0.4 + q * 0.4, true);
        const dist = g.rig.camera.position.distanceTo(_v.set(d.x, 0, d.z));
        if (perfect && dist < 16) g.rig.addTrauma(0.35);
        if (perfect && d.user > 0.5) {
          // your own kill lands: the arena jolts and the moment holds for a beat
          g.rig.kick(0, -FX.kickImpact * pw * clamp01(1.5 - dist / 18) * FX.intensity);
          g.hitStop = Math.max(g.hitStop, FX.hitStopImpact * pw * FX.intensity);
        }
      }
    }
  }

  // ------------------------------------------------------------ primitives
  burst(at: THREE.Vector3, n: number, col: THREE.Color, speed: number, size: number, dir?: THREE.Vector3): void {
    const dl = dir ? dir.length() : 0;
    for (let i = 0; i < n; i++) {
      // a cone along the ball's new direction plus a spherical spray
      let vx = (Math.random() * 2 - 1);
      let vy = (Math.random() * 2 - 1) * 0.8 + 0.3;
      let vz = (Math.random() * 2 - 1);
      const l = Math.hypot(vx, vy, vz) || 1;
      const s = speed * (0.35 + Math.random() * 0.9);
      vx = (vx / l) * s;
      vy = (vy / l) * s;
      vz = (vz / l) * s;
      if (dir && dl > 1 && i % 2 === 0) {
        vx += (dir.x / dl) * speed * 0.9;
        vy += (dir.y / dl) * speed * 0.9;
        vz += (dir.z / dl) * speed * 0.9;
      }
      const k = 0.6 + Math.random() * 0.6;
      this.sparks.emit(at.x, at.y, at.z, vx, vy, vz, 0.25 + Math.random() * 0.45, size * (0.06 + Math.random() * 0.05), col.r * k, col.g * k, col.b * k);
    }
  }

  private glowAt(at: THREE.Vector3, size: number, col: THREE.Color, life = 0.16): void {
    this.glow.emit(at.x, at.y, at.z, 0, 0, 0, life, size, 0.8, col.r, col.g, col.b);
  }

  /** a shock ring in the air, square to the ball's new direction, expanding fast */
  private airRing(at: THREE.Vector3, dir: THREE.Vector3, size: number, strength: number): void {
    if (dir.lengthSq() < 1e-6) return;
    const r = this.airRings.find((q) => q.t >= 1) ?? this.airRings[0];
    r.t = 0;
    r.dur = 0.2;
    r.size = size;
    r.strength = strength;
    r.mesh.position.copy(at);
    r.mesh.lookAt(_v.copy(at).add(dir));
    r.mesh.scale.setScalar(0.05);
    r.mesh.visible = true;
  }

  /** squash the ball along `dir` by `amount` (fraction); it holds while time is frozen, then wobbles back */
  private squash(dir: THREE.Vector3, amount: number): void {
    if (amount <= 0.01 || dir.lengthSq() < 1e-6) return;
    this.sq.amount = amount;
    this.sq.t = 0;
    this.sq.q.setFromUnitVectors(_z, _v.copy(dir).normalize());
  }

  private applySquash(dt: number): void {
    const sq = this.sq;
    const mesh = this.g.ball.mesh;
    if (sq.amount <= 0) return;
    sq.t += dt;
    // a damped wobble: compressed, overshoots long, settles (~0.2 s)
    const a = sq.amount * Math.exp(-sq.t / 0.05) * Math.cos(sq.t * 2 * Math.PI * 13);
    if (sq.t > 0.25) {
      sq.amount = 0;
      mesh.matrixAutoUpdate = true;
      return;
    }
    // M = T * Rd * S * Rd^-1 * Rspin: scale along the squash axis, the spin rotation inside it
    const side = 1 / Math.sqrt(Math.max(0.3, 1 - a)); // keep the volume roughly constant
    _m1.makeRotationFromQuaternion(mesh.quaternion);
    _m2.makeRotationFromQuaternion(sq.q).transpose();
    _m1.premultiply(_m2);
    _m1.premultiply(_m2.makeScale(side, side, 1 - a));
    _m1.premultiply(_m2.makeRotationFromQuaternion(sq.q));
    _m1.setPosition(mesh.position);
    mesh.matrixAutoUpdate = false;
    mesh.matrix.copy(_m1);
    mesh.matrixWorldNeedsUpdate = true;
  }

  private puff(x: number, y: number, z: number, n: number, size: number, alpha: number): void {
    for (let i = 0; i < n; i++) {
      const a = Math.random() * Math.PI * 2;
      const s = 0.4 + Math.random() * 0.9;
      const shade = 0.62 + Math.random() * 0.12;
      this.dust.emit(x + Math.cos(a) * 0.1, y, z + Math.sin(a) * 0.1, Math.cos(a) * s, 0.25 + Math.random() * 0.45, Math.sin(a) * s,
        0.6 + Math.random() * 0.5, size * (0.7 + Math.random() * 0.6), 1.6, shade * alpha, shade * 0.92 * alpha, shade * 0.82 * alpha);
    }
  }

  private dustRing(x: number, z: number, n: number, strength: number): void {
    for (let i = 0; i < n; i++) {
      const a = (i / n) * Math.PI * 2 + Math.random() * 0.2;
      const s = (3 + Math.random() * 3) * strength;
      const shade = 0.6 + Math.random() * 0.15;
      this.dust.emit(x, 0.05, z, Math.cos(a) * s, 0.4 + Math.random() * 0.8 * strength, Math.sin(a) * s, 0.7 + Math.random() * 0.6,
        0.25 + Math.random() * 0.25, 2.2, shade, shade * 0.9, shade * 0.78);
    }
  }

  private shockwave(x: number, z: number, size: number, strength: number, perfect: boolean, dur = perfect ? 0.45 : 0.32): void {
    const r = this.rings.find((q) => q.t >= 1) ?? this.rings[0];
    r.t = 0;
    r.dur = dur;
    r.size = size;
    r.strength = strength;
    r.mesh.position.set(x, 0.02, z);
    const mat = r.mesh.material as THREE.MeshBasicMaterial;
    mat.color.setRGB(perfect ? 2.6 : 1.1, perfect ? 1.6 : 1.1, perfect ? 0.7 : 1.2);
    r.mesh.visible = true;
  }

  private crack(x: number, z: number, scale: number): void {
    const d = this.decals[this.decalNext];
    this.decalNext = (this.decalNext + 1) % this.decals.length;
    d.t = 0;
    d.mesh.position.set(x, 0.007, z);
    d.mesh.rotation.z = Math.random() * Math.PI * 2;
    d.mesh.scale.setScalar(scale * (0.9 + Math.random() * 0.3));
    d.mesh.visible = true;
  }

  private flash(at: THREE.Vector3, size: number, col: THREE.Color): void {
    const f = this.flashes.find((q) => q.t >= 1) ?? this.flashes[0];
    f.t = 0;
    f.follow = at;
    f.m.position.copy(at);
    f.m.scale.setScalar(size);
    (f.m.material as THREE.SpriteMaterial).color.copy(col);
    f.m.visible = true;
  }

  // ------------------------------------------------------------ per frame
  private tension = 0;
  update(dt: number): void {
    const g = this.g;
    // the crowd murmur rises while the ball is in the air near the action
    const live = g.ball.active && !g.ball.state.rest && g.ball.pos.y > 1.5;
    this.tension += ((live ? 1 : 0) - this.tension) * Math.min(1, dt * 1.5);
    this.audio.setCrowdTension(this.tension);
    this.sparks.update(dt);
    this.dust.update(dt);
    this.glow.update(dt);
    const cam = g.rig.camera;
    const h = g.renderer.domElement.clientHeight || 720;
    this.dust.setScale(h, cam.fov);
    this.glow.setScale(h, cam.fov);
    const ballPos = this.replaying ? g.ball.mesh.position : g.ball.rpos;
    this.trail.update(dt, ballPos, this.replaying ? 20 : g.ball.speed(), cam);
    if (!g.ball.active && !this.replaying) this.trail.fade();
    for (const r of this.rings) {
      if (r.t >= 1) continue;
      r.t += dt / r.dur;
      const e = smooth01(Math.min(1, r.t));
      const s = lerp(0.2, r.size, 1 - Math.pow(1 - e, 3));
      r.mesh.scale.set(s, s, 1);
      (r.mesh.material as THREE.MeshBasicMaterial).opacity = (1 - e) * r.strength;
      if (r.t >= 1) r.mesh.visible = false;
    }
    for (const d of this.decals) {
      if (!d.mesh.visible) continue;
      d.t += dt;
      const life = FX.crackLife;
      (d.mesh.material as THREE.MeshBasicMaterial).opacity = d.t < 0.06 ? d.t / 0.06 : 1 - smooth01((d.t - life * 0.6) / (life * 0.4));
      if (d.t > life) d.mesh.visible = false;
    }
    for (const r of this.airRings) {
      if (r.t >= 1) continue;
      r.t += dt / r.dur;
      const e = Math.min(1, r.t);
      r.mesh.scale.setScalar(lerp(0.05, r.size, 1 - Math.pow(1 - e, 3)));
      (r.mesh.material as THREE.MeshBasicMaterial).opacity = Math.pow(1 - e, 1.4) * r.strength;
      if (r.t >= 1) r.mesh.visible = false;
    }
    this.applySquash(dt);
    for (const f of this.flashes) {
      if (f.t >= 1) continue;
      f.t += dt / 0.22;
      if (f.follow) f.m.position.copy(f.follow);
      (f.m.material as THREE.SpriteMaterial).opacity = 1 - f.t;
      if (f.t >= 1) f.m.visible = false;
    }
  }

  // ------------------------------------------------------------ replay
  /** called every fixed step: start a pending replay when its time comes */
  checkReplay(): boolean {
    const g = this.g;
    if (this.replayAt > 0 && g.simTime >= this.replayAt && !this.replay.playing) {
      this.replayAt = -1;
      if (this.replay.start(this.replayFrom, this.replayTo)) {
        this.replaying = true;
        this.setupCine();
        document.body.classList.add('replaying');
        return true;
      }
    }
    return false;
  }

  private setupCine(): void {
    const r = this.replay;
    const C = r.focus.clone();
    const I = r.impact.clone();
    // broadcast angle: beside the hitter towards the middle of the court, a step behind the net
    const sx = Math.abs(C.x) < 0.5 ? 1 : -Math.sign(C.x);
    const sz = Math.sign(C.z) || 1;
    this.cineA.set(C.x + sx * 5.0, 1.75, C.z + sz * 1.6);
    // frame the hitter's body and the contact point together
    this.cineLookA.set(C.x, C.y - 1.0, C.z);
    // then a low view from between the net and the impact, looking at the floor where it lands
    const ix = Math.abs(I.x) < 0.5 ? -sx : -Math.sign(I.x);
    const iz = Math.sign(I.z) || -sz;
    this.cineB.set(I.x + ix * 3.0, 1.15, I.z - iz * 2.4);
    this.trail.intensity = 0;
    this.trail.fade();
  }

  /** run during a replay instead of the simulation; false when it ended */
  replayStep(dt: number): boolean {
    const g = this.g;
    const r = this.replay;
    const live = r.advance(dt, g.ball.mesh);
    const rig = g.rig;
    const u = smooth01((r.cursor - r.contactT + 0.05) / Math.max(0.2, r.impactT - r.contactT + 0.1));
    rig.mode = 'cine';
    rig.cinePos.lerpVectors(this.cineA, this.cineB, u);
    // look at the hitter's contact, then track the ball down to the floor
    rig.cineTarget.copy(this.cineLookA).lerp(r.focus, smooth01(u * 1.6));
    rig.cineFov = lerp(50, 56, u);
    if (!live) this.endReplay();
    return live;
  }

  endReplay(): void {
    const g = this.g;
    this.replay.stop();
    this.replaying = false;
    document.body.classList.remove('replaying');
    g.rig.setMode(g.settings.firstPerson ? 'fp' : 'tp');
    g.ball.mesh.visible = g.ball.active;
  }

  onModeStart(): void {
    this.replay.setViews([...this.g.views.values()]);
    this.replayAt = -1;
    this.pendingImpact = null;
    if (this.replaying) this.endReplay();
  }
}

const _v = new THREE.Vector3();
const _up = new THREE.Vector3(0, 1, 0);
const _z = new THREE.Vector3(0, 0, 1);
const _m1 = new THREE.Matrix4();
const _m2 = new THREE.Matrix4();
