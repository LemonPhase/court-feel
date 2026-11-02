import * as THREE from 'three';
import { ASSIST, COURT, SIM, TIMING, type PositionId, type Settings } from '../config';
import { Emitter } from '../core/events';
import { Input } from '../core/input';
import { saveSettings } from '../core/settings';
import { clamp01, damp, lerp, Rng } from '../core/mathx';
import { CameraRig, type FollowTarget } from '../camera/cameraRig';
import { Arena } from '../world/arena';
import { Post } from '../fx/post';
import { Athlete } from './athlete';
import { UserController } from './userController';
import { DebugOverlay, type DebugInfo } from '../ui/debug';
import { BallEntity, type TouchKind } from './ballEntity';
import { DebugGizmos } from './debugGizmos';
import type { BallEnv } from '../physics/ball';
import { AthleteView } from '../character/athleteView';
import { makeKit } from '../character/kits';
import type { Kit } from '../character/rig';
import { aimTargetFromLook, ContactSystem, type ContactEvent, type IdealInfo } from './contact';
import { Judge, type Outcome } from './judge';
import { Hud } from '../ui/hud';
import type { Brain } from '../ai/brain';
import type { Mode, ModeId } from './modes/mode';
import { createMode } from './modes/registry';
import { makeRingTexture } from '../world/textures';
import { UserActions } from './userActions';
import { defaultPassTarget, defaultSetOptions } from './plays';
import { BlockBot, SpikeBot, TouchBot, type BotQuality } from './bot';

export type GameEvents = {
  toggleCam: { fp: boolean };
  contact: ContactEvent;
  aiContact: { athlete: Athlete; kind: TouchKind; speed: number };
  outcome: Outcome;
  ballEvent: { kind: string; x: number; y: number; z: number; impact: number };
  crowd: { amount: number; cheer: boolean };
  step: { athlete: Athlete; speed: number };
  land: { athlete: Athlete; impact: number };
  takeoff: { athlete: Athlete };
};

/**
 * Owns the renderer, the fixed-timestep simulation, the current drill and
 * the render loop.
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
  readonly hud: Hud;
  athletes: Athlete[] = [];
  me!: Athlete;
  readonly ball: BallEntity;
  readonly env: BallEnv = { netTop: COURT.netHeightMen };
  readonly rng = new Rng(2024);
  readonly gizmos: DebugGizmos;
  readonly views = new Map<Athlete, AthleteView>();
  readonly brains = new Map<Athlete, Brain>();
  readonly contact: ContactSystem;
  readonly judge = new Judge();
  readonly actions: UserActions;
  mode: Mode | null = null;
  modeId: ModeId = 'spike';
  position: PositionId = 'OH';
  /** autopilot driving the user's inputs (tests / attract mode) */
  bot: { step(dt: number): void; after(): void } | null = null;

  simTime = 0;
  private lastRenderSimT = 0;
  private accum = 0;
  timeScale = 1;
  private slowmo = 1;
  hitStop = 0;
  paused = false;
  private last = 0;
  private fpsAcc = 0;
  private fpsFrames = 0;
  fps = 60;
  private stepMs = 0;
  private stepsThisFrame = 0;
  private frameMs = 0;
  /** test hook: when set, the RAF loop does not advance the simulation */
  manual = false;
  /** test hook: stop the RAF loop from rendering (screenshots render on demand) */
  holdRender = false;
  /** in the menu: attract camera, no user control */
  inMenu = true;
  private aimReticle: THREE.Mesh;
  private idealCache: IdealInfo = { t: 0, d: 0, ball: new THREE.Vector3(), point: new THREE.Vector3() };
  private idealValid = false;
  /** last timing info for the debug overlay */
  private lastPress: { at: number; ideal: number } | null = null;

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
    this.hud = new Hud(container);
    this.ball = new BallEntity(this.scene);
    this.ball.hide();
    this.gizmos = new DebugGizmos(this.scene);

    this.aimReticle = new THREE.Mesh(
      new THREE.PlaneGeometry(0.9, 0.9),
      new THREE.MeshBasicMaterial({
        map: makeRingTexture(0.22), color: new THREE.Color(0.95, 0.35, 0.25), transparent: true, opacity: 0,
        depthWrite: false, blending: THREE.AdditiveBlending,
      }),
    );
    this.aimReticle.rotation.x = -Math.PI / 2;
    this.aimReticle.renderOrder = 4;
    this.scene.add(this.aimReticle);

    // eslint-disable-next-line @typescript-eslint/no-this-alias
    const game = this;
    this.contact = new ContactSystem({
      ball: this.ball,
      get simTime() {
        return game.simTime;
      },
      env: this.env,
      aimAssist: (a) => (a.isUser ? this.settings.aimAssist : 0.3),
      aimTargetFor: (a, out) => this.aimTargetFor(a, out),
      emitContact: (ev) => this.onContact(ev),
      rand: () => this.rng.next(),
      passTarget: (a) => this.mode?.passTarget?.(a) ?? defaultPassTarget(a),
      setOptions: (a) => this.mode?.setOptions?.(a) ?? defaultSetOptions(a),
      canServe: (a) => (this.mode?.canServe ? this.mode.canServe(a) : !this.ball.active || this.ball.state.rest),
    });
    this.contact.userAimYaw = () => this.rig.yaw;

    this.me = new Athlete('OH', 1);
    this.me.isUser = true;
    this.me.place(-3.2, 4.5, 0);
    this.addAthlete(this.me);
    this.user.athlete = this.me;
    this.actions = new UserActions(this);

    this.applySettings();
    window.addEventListener('resize', () => this.resize());
  }

  // ------------------------------------------------------------ athletes
  addAthlete(a: Athlete, seed = this.athletes.length + 1, kitKind: 'team' | 'coach' = 'team'): AthleteView {
    this.athletes.push(a);
    let kit: Kit = makeKit(a.team, a.role === 'L', seed);
    if (kitKind === 'coach') kit = { ...kit, jersey: 0x4a4f5c, jerseyTrim: 0x9aa0ad, shorts: 0x2a2d35, socks: 0x2a2d35, pads: 0x2a2d35 };
    const v = new AthleteView(a, kit);
    this.views.set(a, v);
    this.scene.add(v.root);
    a.onLand = (ath, impact) => this.events.emit('land', { athlete: ath, impact });
    a.onTakeoff = (ath) => this.events.emit('takeoff', { athlete: ath });
    v.onFootstep = (ath, speed) => this.events.emit('step', { athlete: ath, speed });
    return v;
  }

  removeAthlete(a: Athlete): void {
    const v = this.views.get(a);
    if (v) {
      this.scene.remove(v.root);
      v.rig.mesh.geometry.dispose();
      v.rig.material.dispose();
      v.rig.mesh.skeleton.dispose();
    }
    this.views.delete(a);
    this.brains.delete(a);
    this.athletes = this.athletes.filter((x) => x !== a);
  }

  setBrain(a: Athlete, b: Brain): void {
    this.brains.set(a, b);
  }

  clearBrains(): void {
    this.brains.clear();
  }

  /** set the user's body + camera facing (teleport) */
  placeUser(x: number, z: number, yaw: number): void {
    this.me.place(x, z, yaw);
    this.rig.yaw = yaw;
    this.user.clear();
    this.eyeInit = false;
  }

  /** change the user's position stats (height, jump, etc) */
  setUserPosition(pos: PositionId): void {
    this.position = pos;
    const old = this.me;
    const a = new Athlete(pos, 1);
    a.isUser = true;
    this.removeAthlete(old);
    this.me = a;
    this.addAthlete(a, 1);
    this.user.athlete = a;
  }

  // ------------------------------------------------------------ modes
  startMode(id: ModeId, pos: PositionId): void {
    this.mode?.teardown();
    this.bot = null;
    this.input.releaseAll();
    this.judge.disarm();
    this.ball.hide();
    this.ball.lastTouch = null;
    if (pos !== this.position || this.me.role !== pos) this.setUserPosition(pos);
    this.modeId = id;
    const mode = createMode(id, this, pos);
    this.mode = mode;
    this.hud.setStreak(0);
    this.hud.setSpeed(null);
    mode.setup();
    this.inMenu = false;
    this.rig.setMode(this.settings.firstPerson ? 'fp' : 'tp');
    this.hud.setCam(this.settings.firstPerson);
  }

  stopMode(): void {
    this.mode?.teardown();
    this.mode = null;
    this.judge.disarm();
    this.ball.hide();
  }

  // ------------------------------------------------------------ settings
  applySettings(): void {
    const s = this.settings;
    this.rig.baseFov = s.fov;
    this.rig.shakeScale = s.shake;
    this.arena.setNetHeight(s.womenNet ? COURT.netHeightWomen : COURT.netHeightMen);
    this.rig.netTop = this.arena.netTop;
    this.env.netTop = this.arena.netTop;
    this.ball.version++;
    this.ball.showMarker = s.landingMarker;
    this.rig.blockers = this.arena.cameraBlockers;
    if (!this.inMenu) this.rig.setMode(s.firstPerson ? 'fp' : 'tp');
    this.hud.showHints = s.showHints;
    saveSettings(s);
  }

  toggleCamera(): void {
    this.settings.firstPerson = !this.settings.firstPerson;
    this.rig.setMode(this.settings.firstPerson ? 'fp' : 'tp');
    saveSettings(this.settings);
    this.hud.setCam(this.settings.firstPerson);
    this.events.emit('toggleCam', { fp: this.settings.firstPerson });
  }

  resize(): void {
    const w = this.container.clientWidth;
    const h = this.container.clientHeight;
    this.renderer.setSize(w, h);
    this.post.setSize(w, h);
    this.rig.resize(w / h);
  }

  // ------------------------------------------------------------ contacts
  aimTargetFor(a: Athlete, out: THREE.Vector3): THREE.Vector3 {
    if (a.isUser) {
      const from = a.action && a.action.kind === 'swing' ? a.action.contactPoint : a.pos;
      return aimTargetFromLook(from.x, from.z, this.rig.yaw, this.rig.pitch, this.rig.mode === 'fp', a.side, out);
    }
    return out.copy(a.aiAim);
  }

  private onContact(ev: ContactEvent): void {
    if (ev.athlete.isUser) {
      if (ev.grade) {
        const kmh = ev.speed * 3.6;
        const sub = ev.grade === 'Miss' ? ev.note : `${kmh.toFixed(0)} km/h${ev.note ? ' · ' + ev.note : ''}${ev.tip ? ' · tip' : ''}`;
        this.hud.showGrade(ev.grade, sub);
      }
      if (ev.speed > 0) this.hud.setSpeed(ev.speed * 3.6);
    }
    if (ev.grade !== 'Miss' && ev.speed > 0) this.judge.arm(this.ball);
    this.mode?.onContact(ev);
    this.events.emit('contact', ev);
  }

  /** AI touches (sets, digs, blocks) for audio/FX */
  onAiContact(a: Athlete, kind: TouchKind, speed: number): void {
    this.events.emit('aiContact', { athlete: a, kind, speed });
  }

  crowd(amount: number, cheer = true): void {
    this.arena.excite(amount);
    this.events.emit('crowd', { amount, cheer });
  }

  // ------------------------------------------------------------ loop
  start(): void {
    this.last = performance.now();
    const loop = (now: number) => {
      requestAnimationFrame(loop);
      this.frame(now);
    };
    requestAnimationFrame(loop);
  }

  /** test hook: render one frame right now */
  renderNow(dt = 1 / 60): void {
    this.render(dt);
  }

  /** test hook: simulate and animate frame by frame (no drawing) */
  play(sec: number): void {
    const dt = 1 / 60;
    for (let t = 0; t < sec - 1e-9; t += dt) this.tick(dt, false);
  }

  /** test hook: run `sec` seconds without animation */
  simulate(sec: number): void {
    const dt = 1 / 60;
    for (let t = 0; t < sec - 1e-9; t += dt) {
      this.frameInput(dt);
      this.advance(dt);
    }
  }

  /** one render frame */
  frame(now: number): void {
    if (this.holdRender) {
      this.last = now;
      return;
    }
    const t0 = performance.now();
    const realDt = Math.min((now - this.last) / 1000, SIM.maxFrameDt);
    this.last = now;
    if (realDt <= 0) return;
    if (this.manual) this.render(realDt);
    else this.tick(realDt, true);
    this.frameMs = performance.now() - t0;
    this.fpsAcc += realDt;
    this.fpsFrames++;
    if (this.fpsAcc >= 0.5) {
      this.fps = this.fpsFrames / this.fpsAcc;
      this.fpsAcc = 0;
      this.fpsFrames = 0;
    }
  }

  private tick(dt: number, draw: boolean): void {
    this.frameInput(dt);
    this.advance(dt);
    this.mode?.frame(dt);
    this.render(dt, draw);
  }

  /** frame-level input: look, toggles, immediate action starts (same frame as the input) */
  private frameInput(dt: number): void {
    if (this.input.consumePress('F3')) {
      this.debug.toggle();
      this.gizmos.setVisible(this.debug.visible);
    }
    if (this.paused) {
      this.input.takeMouse();
      return;
    }
    if (this.inMenu) {
      // attract mode: only the bot plays
      this.input.takeMouse();
      if (this.bot && this.mode) {
        this.bot.step(dt);
        this.user.frame(dt);
        this.bot.after();
      }
      return;
    }
    this.bot?.step(dt);
    const [dx, dy] = this.input.takeMouse();
    this.rig.look(dx, dy, this.settings.sensitivity, this.settings.invertY);
    if (this.input.consumePress('KeyV')) this.toggleCamera();
    if (this.input.consumePress('KeyR')) this.mode?.restartRep();
    this.user.frame(dt);
    this.bot?.after();
  }

  enableBot(q: string): void {
    const quality = (['perfect', 'good', 'sloppy', 'tip'].includes(q) ? q : 'perfect') as BotQuality;
    this.bot =
      this.modeId === 'block' ? new BlockBot(this, quality)
      : this.modeId === 'receive' ? new TouchBot(this, 'pass', quality)
      : this.modeId === 'setter' ? new TouchBot(this, 'set', quality)
      : new SpikeBot(this, quality);
  }

  /** start-screen background: the bot runs the spike drill under an orbiting camera */
  startAttract(): void {
    this.startMode('spike', 'OH');
    this.inMenu = true;
    this.bot = new SpikeBot(this, 'good');
    this.rig.setMode('menu');
    this.hud.setVisible(false);
  }

  /** advance simulation by real seconds (respects hit-stop, slow-mo and timescale) */
  advance(realDt: number): void {
    if (this.paused) return;
    const step = 1 / SIM.hz;
    // slow-mo assist while lining up a contact
    let slowTarget = 1;
    if (this.settings.slowmoAssist && this.me.state === 'air' && this.idealValid) {
      const until = this.idealCache.t - this.simTime;
      if (until > 0 && until < ASSIST.slowmoWindow && this.idealCache.d < this.contact.reach(this.me) + 0.4) slowTarget = 0.55;
    }
    this.slowmo = lerp(this.slowmo, slowTarget, damp(12, realDt));
    let simDt = realDt * this.timeScale * this.slowmo;
    if (this.hitStop > 0) {
      const used = Math.min(this.hitStop, realDt);
      this.hitStop -= used;
      simDt = (realDt - used) * this.timeScale * this.slowmo;
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
    for (const [, b] of this.brains) b.step(dt, this);
    // assist magnet for the user's mid-air drift
    this.contact.magnet(this.me);
    for (const a of this.athletes) a.step(dt, this.simTime);
    this.actions.step(dt);
    this.contact.step(this.athletes);
    // cleanup finished actions
    for (const a of this.athletes) {
      const act = a.action;
      if (!act) continue;
      if (act.kind === 'swing' && act.resolved && this.simTime > act.contactT + 0.35) a.endAction();
      else if (act.kind === 'block' && !act.held && this.simTime > act.releaseT + 0.25) a.endAction();
      else if (act.kind === 'toss' && this.simTime > act.t0 + 1.6) a.endAction();
      else if (act.kind === 'set' && act.resolved && this.simTime > act.contactT + 0.45) a.endAction();
      else if (act.kind === 'pass' && act.resolved && this.simTime > act.contactT + 0.4) a.endAction();
    }
    this.ball.step(dt, this.env);
    for (const e of this.ball.events) this.events.emit('ballEvent', e);
    const out = this.judge.step(this.ball, this.ball.events, this.env.netTop);
    if (out) {
      this.events.emit('outcome', out);
      this.mode?.onOutcome(out);
    }
    this.mode?.step(dt);
    // timing window cache for HUD / slow-mo / debug
    const info = this.me.state === 'air' || this.me.state === 'load' ? this.contact.ideal(this.me, this.simTime, 0.9, this.idealCache) : null;
    this.idealValid = !!info;
  }

  // ------------------------------------------------------------ render
  private ballDebug(): string {
    const b = this.ball.state;
    const sp = this.ball.speed();
    const w = Math.hypot(b.w.x, b.w.y, b.w.z);
    return `ball ${this.ball.active ? '' : '(idle) '}p ${b.p.x.toFixed(2)},${b.p.y.toFixed(2)},${b.p.z.toFixed(2)} v ${b.v.x.toFixed(1)},${b.v.y.toFixed(1)},${b.v.z.toFixed(1)} |v| ${sp.toFixed(1)} m/s (${(sp * 3.6).toFixed(0)} km/h) spin ${(w / (2 * Math.PI)).toFixed(1)} rps`;
  }

  /** stabilised first-person eye: follows the head height (crouch, jump) without sway */
  private eye = new THREE.Vector3();
  private eyeInit = false;
  private updateEye(dt: number): void {
    const v = this.views.get(this.me);
    if (!v) return;
    const me = this.me;
    if (!this.eyeInit) {
      this.eye.copy(v.eyePos);
      this.eyeInit = true;
      return;
    }
    this.eye.x = me.rpos.x;
    this.eye.z = me.rpos.z;
    const k = 1 - Math.exp(-dt * (me.state === 'air' ? 40 : 14));
    const stand = me.rpos.y + me.height * 0.935;
    const ty = stand + (v.eyePos.y - stand) * 0.6;
    this.eye.y += (ty - this.eye.y) * k;
  }

  private follow: FollowTarget = { root: new THREE.Vector3(), eye: new THREE.Vector3(), sprint: 0, height: 1.95, side: 1 };
  private _aim = new THREE.Vector3();

  render(realDt: number, draw = true): void {
    const alpha = this.accum / (1 / SIM.hz);
    for (const a of this.athletes) a.interpolate(alpha);
    this.ball.interpolate(alpha);
    const step = 1 / SIM.hz;
    const tr = this.simTime - step * (1 - alpha);
    const animDt = Math.max(0, tr - this.lastRenderSimT);
    this.lastRenderSimT = tr;
    for (const [a, v] of this.views) {
      a.ballPos = this.ball.active ? this.ball.rpos : null;
      if (this.ball.active) a.lookAt.copy(this.ball.rpos);
      v.setFirstPerson(a.isUser && this.rig.mode === 'fp' && !this.inMenu);
      v.update(animDt, tr);
    }
    this.ball.updateVisuals(realDt, this.simTime, this.env);
    this.rig.ballPos = this.ball.active ? this.ball.rpos : null;
    if (this.ball.active && this.debug.visible) this.gizmos.updatePath(this.ball.ensurePrediction(this.env, this.simTime), this.simTime);
    const me = this.me;
    const f = this.follow;
    f.root.copy(me.rpos);
    this.updateEye(realDt);
    f.eye.copy(this.eye);
    f.sprint = me.sprint;
    f.height = me.height;
    f.side = me.side;
    this.rig.update(realDt, this.inMenu ? null : f);
    // fade our own body when the TP camera is very close
    const myView = this.views.get(me);
    if (myView) myView.setOpacity(this.rig.mode === 'tp' ? clamp01((this.rig.tpCamToPivot - 0.5) / 0.6) * 0.75 + 0.25 : 1);
    this.arena.update(realDt);
    this.updateAimReticle(realDt);
    this.hud.update(realDt);
    if (this.mode && !this.inMenu) this.hud.setHint(this.mode.hint());
    this.hud.setCrosshair(!this.inMenu, me.state === 'air');
    if (!draw) return;
    this.renderer.info.reset();
    this.post.render(realDt);
    if (this.debug.visible) this.debug.update(this.debugInfo());
  }

  private updateAimReticle(dt: number): void {
    const me = this.me;
    const mat = this.aimReticle.material as THREE.MeshBasicMaterial;
    const show = !this.inMenu && (me.state === 'air' || me.state === 'load' || (me.action?.kind === 'toss'));
    mat.opacity = lerp(mat.opacity, show ? 0.75 : 0, damp(12, dt));
    this.aimReticle.visible = mat.opacity > 0.02;
    if (this.aimReticle.visible) {
      this.aimTargetFor(me, this._aim);
      this.aimReticle.position.set(this._aim.x, 0.013, this._aim.z);
    }
  }

  notePress(at: number, ideal: number): void {
    this.lastPress = { at, ideal };
  }

  private debugInfo(): DebugInfo {
    const me = this.me;
    let window: DebugInfo['window'] = null;
    if (this.idealValid) {
      const ideal = this.idealCache.t - this.simTime - TIMING.swingNominal;
      window = {
        now: 0,
        ideal,
        perfect: TIMING.spikePerfect,
        good: TIMING.spikeGood,
        ok: TIMING.spikeOk,
        label: `click in ${(ideal * 1000).toFixed(0)} ms · miss dist ${this.idealCache.d.toFixed(2)} m`,
      };
      this.gizmos.contact.visible = true;
      this.gizmos.contact.position.copy(this.idealCache.point);
      this.gizmos.reach.visible = true;
      this.gizmos.reach.position.copy(this.idealCache.point);
      this.gizmos.reach.scale.setScalar(this.contact.reach(me));
    } else {
      this.gizmos.contact.visible = false;
      this.gizmos.reach.visible = false;
    }
    const act = me.lastAction ?? me.action;
    if (act && act.kind === 'swing') {
      this.gizmos.lastHit.visible = true;
      this.gizmos.lastHit.position.copy(act.contactPoint);
    }
    const lp = this.lastPress ? ` last click err ${(this.lastPress.at * 1000).toFixed(0)} ms` : '';
    return {
      fps: this.fps,
      frameMs: this.frameMs,
      stepMs: this.stepMs,
      steps: this.stepsThisFrame,
      lines: [
        `me ${me.role} ${me.state} pos ${me.pos.x.toFixed(2)},${me.pos.y.toFixed(2)},${me.pos.z.toFixed(2)} spd ${me.speed.toFixed(2)} jump ${me.jumpH.toFixed(2)}`,
        `cam ${this.rig.mode} yaw ${this.rig.yaw.toFixed(2)} pitch ${this.rig.pitch.toFixed(2)} timescale ${(this.timeScale * this.slowmo).toFixed(2)}`,
        `draws ${this.renderer.info.render.calls} tris ${this.renderer.info.render.triangles} mem geo ${this.renderer.info.memory.geometries} tex ${this.renderer.info.memory.textures}`,
        this.ballDebug(),
        `action ${me.action ? me.action.kind : '-'} grade ${act?.grade ?? '-'} err ${act ? (act.err * 1000).toFixed(0) : '-'} ms${lp}`,
      ],
      window,
    };
  }
}
