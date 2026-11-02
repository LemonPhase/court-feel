import * as THREE from 'three';
import { COURT, SIM, type PositionId, type Settings } from '../config';
import { Emitter } from '../core/events';
import { Input } from '../core/input';
import { saveSettings } from '../core/settings';
import { CameraRig, type FollowTarget } from '../camera/cameraRig';
import { Arena } from '../world/arena';
import { Post } from '../fx/post';
import { Athlete } from './athlete';
import { UserController } from './userController';
import { DebugOverlay } from '../ui/debug';

export type GameEvents = {
  toggleCam: { fp: boolean };
};

/** Temporary capsule body for M1; replaced by the rigged character in M3. */
class CapsuleView {
  readonly group = new THREE.Group();
  constructor(public athlete: Athlete, color: number) {
    const body = new THREE.Mesh(
      new THREE.CapsuleGeometry(0.28, athlete.height - 0.56, 6, 14),
      new THREE.MeshStandardMaterial({ color, roughness: 0.6 }),
    );
    body.position.y = athlete.height / 2;
    body.castShadow = true;
    const nose = new THREE.Mesh(new THREE.BoxGeometry(0.12, 0.08, 0.2), new THREE.MeshStandardMaterial({ color: 0x222222 }));
    nose.position.set(0, athlete.height * 0.92, -0.3);
    this.group.add(body, nose);
  }
  update(hideSelf = false): void {
    const a = this.athlete;
    this.group.visible = !(hideSelf && a.isUser);
    this.group.position.copy(a.rpos);
    this.group.rotation.y = a.ryaw;
    const crouch = a.state === 'load' ? Math.min(1, a.loadT / 0.2) * 0.25 : 0;
    this.group.scale.y = 1 - crouch * 0.6;
  }
}

/**
 * Owns the renderer, the fixed-timestep simulation and the render loop.
 */
export class Game {
  readonly renderer: THREE.WebGLRenderer;
  readonly scene = new THREE.Scene();
  readonly rig: CameraRig;
  readonly arena: Arena;
  readonly post: Post;
  readonly input: Input;
  readonly user: UserController;
  readonly events = new Emitter<GameEvents>();
  readonly debug: DebugOverlay;
  athletes: Athlete[] = [];
  me!: Athlete;
  private views: CapsuleView[] = [];

  simTime = 0;
  private accum = 0;
  timeScale = 1;
  hitStop = 0;
  paused = false;
  private last = 0;
  private fpsAcc = 0;
  private fpsFrames = 0;
  private fps = 60;
  private stepMs = 0;
  private stepsThisFrame = 0;
  private frameMs = 0;
  /** test hook: when set, the RAF loop does not advance the simulation */
  manual = false;
  position: PositionId = 'OH';

  constructor(private container: HTMLElement, public settings: Settings) {
    this.renderer = new THREE.WebGLRenderer({ antialias: false, powerPreference: 'high-performance' });
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 1.5));
    this.renderer.setSize(container.clientWidth, container.clientHeight);
    this.renderer.shadowMap.enabled = true;
    this.renderer.shadowMap.type = THREE.PCFShadowMap;
    this.renderer.toneMapping = THREE.ACESFilmicToneMapping;
    this.renderer.toneMappingExposure = 1.0;
    this.renderer.outputColorSpace = THREE.SRGBColorSpace;
    this.renderer.info.autoReset = false;
    container.appendChild(this.renderer.domElement);
    this.renderer.domElement.tabIndex = 0;

    this.scene.background = new THREE.Color(0x0b0d14);
    this.scene.fog = new THREE.Fog(0x0b0d14, 38, 90);
    this.rig = new CameraRig(container.clientWidth / container.clientHeight);
    this.arena = new Arena(this.renderer, this.scene);
    this.rig.blockers = this.arena.cameraBlockers;
    this.post = new Post(this.renderer, this.scene, this.rig.camera);
    this.input = new Input(this.renderer.domElement);
    this.user = new UserController(this.input, this.rig);
    this.debug = new DebugOverlay(container);

    this.applySettings();
    window.addEventListener('resize', () => this.resize());

    this.me = new Athlete('OH', 1);
    this.me.isUser = true;
    this.me.place(-3.2, 4.5, 0);
    this.addAthlete(this.me, 0xd8342c);
    this.user.athlete = this.me;
    this.user.handlers.jump = () => this.me.jumpPress();
    this.user.releaseHandlers.jump = () => this.me.jumpRelease();
  }

  addAthlete(a: Athlete, color: number): void {
    this.athletes.push(a);
    const v = new CapsuleView(a, color);
    this.views.push(v);
    this.scene.add(v.group);
  }

  applySettings(): void {
    const s = this.settings;
    this.rig.baseFov = s.fov;
    this.rig.shakeScale = s.shake;
    this.arena.setNetHeight(s.womenNet ? COURT.netHeightWomen : COURT.netHeightMen);
    this.rig.netTop = this.arena.netTop;
    this.rig.blockers = this.arena.cameraBlockers;
    this.rig.setMode(s.firstPerson ? 'fp' : 'tp');
    saveSettings(s);
  }

  toggleCamera(): void {
    this.settings.firstPerson = !this.settings.firstPerson;
    this.rig.setMode(this.settings.firstPerson ? 'fp' : 'tp');
    saveSettings(this.settings);
    this.events.emit('toggleCam', { fp: this.settings.firstPerson });
  }

  resize(): void {
    const w = this.container.clientWidth;
    const h = this.container.clientHeight;
    this.renderer.setSize(w, h);
    this.post.setSize(w, h);
    this.rig.resize(w / h);
  }

  start(): void {
    this.last = performance.now();
    const loop = (now: number) => {
      requestAnimationFrame(loop);
      this.frame(now);
    };
    requestAnimationFrame(loop);
  }

  /** one render frame */
  frame(now: number): void {
    const t0 = performance.now();
    const realDt = Math.min((now - this.last) / 1000, SIM.maxFrameDt);
    this.last = now;
    if (realDt <= 0) return;

    // frame-level input: look, toggles, immediate action starts
    if (!this.paused) {
      const [dx, dy] = this.input.takeMouse();
      this.rig.look(dx, dy, this.settings.sensitivity, this.settings.invertY);
      if (this.input.consumePress('KeyV')) this.toggleCamera();
      this.user.frame(realDt);
    }
    if (this.input.consumePress('F3')) this.debug.toggle();

    if (!this.manual) this.advance(realDt);

    this.render(realDt);
    this.frameMs = performance.now() - t0;
    this.fpsAcc += realDt;
    this.fpsFrames++;
    if (this.fpsAcc >= 0.5) {
      this.fps = this.fpsFrames / this.fpsAcc;
      this.fpsAcc = 0;
      this.fpsFrames = 0;
    }
  }

  /** test hook: run `sec` seconds of game time at 60 Hz frames (input + sim, no render) */
  simulate(sec: number): void {
    const dt = 1 / 60;
    for (let t = 0; t < sec - 1e-9; t += dt) {
      if (!this.paused) this.user.frame(dt);
      this.advance(dt);
    }
  }

  /** advance simulation by real seconds (respects hit-stop and timescale) */
  advance(realDt: number): void {
    if (this.paused) return;
    const step = 1 / SIM.hz;
    let simDt = realDt * this.timeScale;
    if (this.hitStop > 0) {
      const used = Math.min(this.hitStop, realDt);
      this.hitStop -= used;
      simDt = (realDt - used) * this.timeScale;
    }
    this.accum += simDt;
    const ts = performance.now();
    let n = 0;
    while (this.accum >= step) {
      this.fixedStep(step);
      this.accum -= step;
      n++;
      if (n > 24) {
        this.accum = 0;
        break;
      }
    }
    this.stepsThisFrame = n;
    if (n) this.stepMs = (performance.now() - ts) / n;
  }

  fixedStep(dt: number): void {
    this.simTime += dt;
    for (const a of this.athletes) a.step(dt, this.simTime);
  }

  private follow: FollowTarget = { root: new THREE.Vector3(), eye: new THREE.Vector3(), sprint: 0, height: 1.95, side: 1 };

  render(realDt: number): void {
    const alpha = this.accum / (1 / SIM.hz);
    for (const a of this.athletes) a.interpolate(alpha);
    for (const v of this.views) v.update(this.rig.mode === 'fp');
    const me = this.me;
    const f = this.follow;
    f.root.copy(me.rpos);
    const crouch = me.state === 'load' ? Math.min(1, me.loadT / 0.2) * 0.22 : 0;
    f.eye.set(me.rpos.x, me.rpos.y + me.height * 0.93 - crouch, me.rpos.z);
    f.sprint = me.sprint;
    f.height = me.height;
    f.side = me.side;
    this.rig.update(realDt, f);
    this.arena.update(realDt);
    this.renderer.info.reset();
    this.post.render(realDt);
    this.debug.update({
      fps: this.fps,
      frameMs: this.frameMs,
      stepMs: this.stepMs,
      steps: this.stepsThisFrame,
      lines: [
        `me ${me.state} pos ${me.pos.x.toFixed(2)},${me.pos.y.toFixed(2)},${me.pos.z.toFixed(2)} spd ${me.speed.toFixed(2)}`,
        `cam ${this.rig.mode} yaw ${this.rig.yaw.toFixed(2)} pitch ${this.rig.pitch.toFixed(2)}`,
        `draws ${this.renderer.info.render.calls} tris ${this.renderer.info.render.triangles}`,
      ],
      window: null,
    });
  }
}
