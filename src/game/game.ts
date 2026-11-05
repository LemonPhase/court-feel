import * as THREE from 'three';
import { ASSIST, CAMERA, COURT, PLAYER, SIM, TIMING, type PositionId, type Settings } from '../config';
import { Emitter } from '../core/events';
import { Input } from '../core/input';
import { saveSettings } from '../core/settings';
import { clamp01, damp, lerp, Rng } from '../core/mathx';
import { CameraRig, type FollowTarget } from '../camera/cameraRig';
import { Arena } from '../world/arena';
import { Post } from '../fx/post';
import { Athlete, handSign } from './athlete';
import { bodyStats } from './body';
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
import { kbd, type Mode, type ModeId } from './modes/mode';
import { createMode } from './modes/registry';
import { makeRingTexture } from '../world/textures';
import { UserActions } from './userActions';
import { defaultPassTarget, defaultSetOptions } from './plays';
import { BlockBot, isBotQuality, SpikeBot, TouchBot, type BotQuality } from './bot';
import { Effects } from '../fx/effects';

/** consecutive frames that throw before the game stops and shows the crash screen */
const MAX_FAILED_FRAMES = 10;

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
  /** a team-mate's call to the user (the setter's read of the pass: in system, high, help) */
  setterCall: { athlete: Athlete; call: 'in' | 'out' | 'help' };
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
  /** a listener that throws is reported, the others still run and the step carries on */
  readonly events = new Emitter<GameEvents>((err, type) => this.reportError(err, `'${String(type)}' event handler`, false));
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
  readonly fx: Effects;
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
  /** called once per render frame after the HUD (the touch overlay draws itself here) */
  onFrame: (() => void) | null = null;
  /** test hook: stop the RAF loop from rendering (screenshots render on demand) */
  holdRender = false;
  /** in the menu: attract camera, no user control */
  inMenu = true;
  /** rally modes: is the ball in play (AI teams read this) */
  ballLive = false;
  /** test hook: the user's athlete is driven by the team AI */
  autoUser = false;
  /**
   * Errors caught by the game: a frame or an event handler that threw. `fatal` means the
   * game has stopped (frames kept throwing). Without a handler they go to the console.
   */
  onError: ((err: unknown, where: string, fatal: boolean) => void) | null = null;
  /** the render loop has stopped after repeated errors */
  stopped = false;
  /** consecutive frames that threw */
  private failedFrames = 0;
  private aimReticle: THREE.Mesh;
  private idealCache: IdealInfo = { t: 0, d: 0, ball: new THREE.Vector3(), point: new THREE.Vector3() };
  private idealValid = false;
  /** last timing info for the debug overlay */
  private lastPress: { at: number; ideal: number } | null = null;

  constructor(
    private container: HTMLElement,
    public settings: Settings,
  ) {
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
    this.hud.camera = this.rig.camera;
    this.ball = new BallEntity(this.scene);
    this.ball.hide();
    this.gizmos = new DebugGizmos(this.scene);

    this.aimReticle = new THREE.Mesh(
      new THREE.PlaneGeometry(0.9, 0.9),
      new THREE.MeshBasicMaterial({
        map: makeRingTexture(0.22),
        color: new THREE.Color(0.95, 0.35, 0.25),
        transparent: true,
        opacity: 0,
        depthWrite: false,
        blending: THREE.AdditiveBlending,
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

    this.me = new Athlete('OH', 1, { body: settings.bodies.OH, hand: settings.hand });
    this.me.isUser = true;
    this.me.place(-3.2, 4.5, 0);
    this.addAthlete(this.me);
    this.user.athlete = this.me;
    this.actions = new UserActions(this);
    this.fx = new Effects(this, container);

    this.applySettings();
    window.addEventListener('resize', () => this.resize());
    this.resize();
  }

  // ------------------------------------------------------------ athletes
  addAthlete(a: Athlete, seed = this.athletes.length + 1, kitKind: 'team' | 'coach' = 'team'): AthleteView {
    this.athletes.push(a);
    let kit: Kit = makeKit(a.team, a.role === 'L', seed);
    if (kitKind === 'coach') kit = { ...kit, jersey: 0x4a4f5c, jerseyTrim: 0x9aa0ad, shorts: 0x2a2d35, socks: 0x2a2d35, pads: 0x2a2d35 };
    const v = new AthleteView(a, kit);
    this.views.set(a, v);
    this.scene.add(v.root);
    // spawned mid-drill (the spike drill's block): the replay records it too, from now on
    this.fx?.replay.addView(v);
    a.onLand = (ath, impact) => this.events.emit('land', { athlete: ath, impact });
    a.onTakeoff = (ath) => this.events.emit('takeoff', { athlete: ath });
    v.onFootstep = (ath, speed) => this.events.emit('step', { athlete: ath, speed });
    return v;
  }

  private disposeView(v: AthleteView): void {
    this.scene.remove(v.root);
    v.rig.mesh.geometry.dispose();
    v.rig.material.dispose();
    v.rig.mesh.skeleton.dispose();
  }

  removeAthlete(a: Athlete): void {
    const v = this.views.get(a);
    if (v) this.disposeView(v);
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
    this.ret = null;
    this.me.place(x, z, yaw);
    this.rig.yaw = yaw;
    this.rig.snap();
    this.user.clear();
    this.eyeInit = false;
  }

  /** the user's athlete jogs back to a drill spot between reps (no teleport, no black cut) */
  private ret: { x: number; z: number; yaw: number; t: number; maxT: number; userDriven: boolean } | null = null;

  returnUser(x: number, z: number, yaw: number, maxT = 2.6): void {
    this.ret = { x, z, yaw, t: 0, maxT, userDriven: false };
  }

  /** a drill should hold its next feed while this is true */
  get userReturning(): boolean {
    return this.ret !== null;
  }

  private stepReturn(dt: number): void {
    const r = this.ret;
    if (!r) return;
    const me = this.me;
    r.t += dt;
    const d = Math.hypot(me.pos.x - r.x, me.pos.z - r.z);
    const keys =
      ['KeyW', 'KeyA', 'KeyS', 'KeyD', 'ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight'].some((k) => this.input.isDown(k)) ||
      this.input.stick.active;
    if (keys) r.userDriven = true;
    if (d < 0.1 || (r.userDriven && d < 0.9)) {
      this.ret = null;
      return;
    }
    if (r.t > r.maxT) {
      // still far (or the player wandered off): snap with a soft dip, not a black cut
      if (!r.userDriven || r.t > r.maxT + 2) {
        if (!r.userDriven) {
          this.hud.dip();
          this.placeUser(r.x, r.z, r.yaw);
        }
        this.ret = null;
      }
      return;
    }
    if (keys || me.state !== 'ground' || Math.hypot(me.cmd.moveX, me.cmd.moveZ) > 0.05) return;
    // jog back (body keeps facing where the camera looks: a backpedal when looking at the net)
    const m = Math.min(1, d / 0.6);
    me.cmd.moveX = ((r.x - me.pos.x) / d) * m;
    me.cmd.moveZ = ((r.z - me.pos.z) / d) * m;
    me.cmd.sprint = d > 2.5;
  }

  /** change the user's position stats (height, jump, etc; your custom body for that position from the settings) */
  setUserPosition(pos: PositionId): void {
    this.position = pos;
    const old = this.me;
    const a = new Athlete(pos, 1, { body: this.settings.bodies[pos], hand: this.settings.hand });
    a.isUser = true;
    this.removeAthlete(old);
    this.me = a;
    this.addAthlete(a, 1);
    this.user.athlete = a;
  }

  /** the user's model has to be rebuilt for a new height (done once per frame at most, while a slider drags) */
  private userViewDirty = false;

  /** apply your custom body and hitting hand (settings) to the user's athlete, live, also mid-drill */
  applyUserBody(): void {
    const me = this.me;
    me.hand = handSign(this.settings.hand);
    this.rig.shoulderSide = me.hand;
    const st = bodyStats(me.role, this.settings.bodies[me.role]);
    if (st.height === me.stats.height && st.jump === me.stats.jump && st.power === me.stats.power) return;
    const h = me.height;
    me.setBody(this.settings.bodies[me.role]);
    if (me.height !== h) this.userViewDirty = true;
  }

  /** a new height: a new model with the same kit (the view keeps its slot, so the replay keeps its athlete order) */
  private rebuildUserView(): void {
    this.userViewDirty = false;
    const a = this.me;
    const old = this.views.get(a);
    if (!old) return;
    this.disposeView(old);
    const v = new AthleteView(a, old.kit);
    v.onFootstep = old.onFootstep;
    this.views.set(a, v);
    this.scene.add(v.root);
    this.eyeInit = false;
    // the replay buffer recorded the old model: start it afresh
    this.fx.onModeStart();
  }

  // ------------------------------------------------------------ modes
  startMode(id: ModeId, pos: PositionId): void {
    this.mode?.teardown();
    this.bot = null;
    this.ballLive = false;
    this.me.isUser = true;
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
    this.fx.onModeStart();
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
    this.fx?.audio.setVolume(s.volume);
    this.applyUserBody();
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
        const pw =
          ev.power !== undefined && !ev.tip ? ` · ${ev.power >= 0.999 ? 'full power' : `power ${Math.round(ev.power * 100)}%`}` : '';
        const sub = ev.grade === 'Miss' ? ev.note : `${kmh.toFixed(0)} km/h${pw}${ev.note ? ' · ' + ev.note : ''}${ev.tip ? ' · tip' : ''}`;
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
      if (this.stopped) return;
      requestAnimationFrame(loop);
      try {
        this.frame(now);
        this.failedFrames = 0;
      } catch (err) {
        // a one-off error is reported and play goes on; a run of failing frames means the
        // game is stuck in a broken state: stop and say so instead of freezing silently
        this.failedFrames++;
        const fatal = this.failedFrames >= MAX_FAILED_FRAMES;
        if (fatal) this.stopped = true;
        this.reportError(err, 'frame', fatal);
      }
    };
    requestAnimationFrame(loop);
  }

  private reportError(err: unknown, where: string, fatal: boolean): void {
    if (this.onError) this.onError(err, where, fatal);
    else console.error(`[court-feel] error in ${where}`, err);
  }

  /**
   * test hook: render one frame right now. During a replay it only draws, like `tick` does:
   * the live `render()` would re-pose every athlete and the ball from the live simulation
   * under the cinematic camera instead of showing the frame the replay posed
   */
  renderNow(dt = 1 / 60): void {
    if (this.fx.replaying) {
      this.renderer.info.reset();
      this.post.render(dt);
      return;
    }
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

  // ------------------------------------------------------------ quality governor
  /** 0 = full (MSAA, 1.5x DPR cap), 1 = no MSAA + 1x DPR, 2 = 0.8x scale + 1024 shadows */
  quality = 0;
  private qAcc = 0;
  private qFrames = 0;
  private qCooldown = 3;
  private qSlow = 0;

  private governQuality(dt: number): void {
    if (this.manual || document.hidden) return;
    this.qCooldown -= dt;
    this.qAcc += dt;
    this.qFrames++;
    if (this.qAcc < 2) return;
    const avg = this.qAcc / this.qFrames;
    this.qAcc = 0;
    this.qFrames = 0;
    if (this.qCooldown > 0 || this.quality >= 2) return;
    // two slow windows in a row (below ~50 fps for 4 s): step down one level
    this.qSlow = avg > 1 / 50 ? this.qSlow + 1 : 0;
    if (this.qSlow >= 2) {
      this.qSlow = 0;
      this.setQuality(this.quality + 1);
    }
  }

  setQuality(q: number): void {
    this.quality = Math.max(0, Math.min(2, q));
    this.qCooldown = 4;
    const dpr = window.devicePixelRatio || 1;
    this.post.setSamples(this.quality === 0 ? 4 : 0);
    this.renderer.setPixelRatio(this.quality === 0 ? Math.min(dpr, 1.5) : this.quality === 1 ? Math.min(dpr, 1) : 0.8);
    this.post.composer.setPixelRatio(this.renderer.getPixelRatio());
    const sm = this.arena.keyLight.shadow;
    const size = this.quality === 2 ? 1024 : 2048;
    if (sm.mapSize.x !== size) {
      sm.mapSize.set(size, size);
      sm.map?.dispose();
      sm.map = null;
    }
    this.resize();
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
    // quality changes resize the canvas, which clears it: do it before drawing this frame
    this.governQuality(realDt);
    if (this.manual) this.renderNow(realDt);
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
    if (this.fx.replaying) {
      // slow-motion replay: the simulation is frozen, any key skips
      this.input.takeMouse();
      if (this.input.consumeAny() && !this.inMenu) this.fx.endReplay();
      else this.fx.replayStep(dt);
      this.renderReplay(dt, draw);
      return;
    }
    this.frameInput(dt);
    if (this.fx.replaying) {
      // R started a replay this frame: no live step underneath it
      this.fx.replayStep(dt);
      this.renderReplay(dt, draw);
      return;
    }
    this.advance(dt);
    this.mode?.frame(dt);
    this.render(dt, draw);
  }

  /** replay recording runs while the ball is live and for a second after (sim time) */
  private recordUntil = 0;

  /** can the last highlight be replayed right now (R)? */
  replayAvailable(): boolean {
    return this.fx.replayAvailable();
  }

  private renderReplay(dt: number, draw: boolean): void {
    this.mode?.replayFrame();
    this.rig.update(dt, null);
    this.fx.update(dt * this.fx.replay.speed);
    this.arena.update(dt);
    this.hud.update(dt);
    this.hud.setCrosshair(false);
    if (!draw) return;
    this.renderer.info.reset();
    this.post.render(dt);
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
        this.stepReturn(dt);
      }
      return;
    }
    this.bot?.step(dt);
    const [dx, dy] = this.input.takeMouse();
    this.rig.look(dx, dy, this.settings.sensitivity, this.settings.invertY);
    if (this.input.consumePress('KeyV')) this.toggleCamera();
    if (this.input.consumePress('KeyN')) this.mode?.restartRep();
    if (this.input.consumePress('KeyR')) this.fx.startReplay();
    this.user.frame(dt);
    this.bot?.after();
    this.stepReturn(dt);
  }

  enableBot(q: string): void {
    const quality: BotQuality = isBotQuality(q) ? q : 'perfect';
    const role = this.me.role;
    this.bot =
      this.modeId === 'block'
        ? new BlockBot(this, quality)
        : this.modeId === 'receive' || (this.modeId === 'rally' && role === 'L')
          ? new TouchBot(this, 'pass', quality)
          : this.modeId === 'setter' || (this.modeId === 'rally' && role === 'S')
            ? new TouchBot(this, 'set', quality)
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
      if (until > 0 && until < ASSIST.slowmoWindow && this.idealCache.d < this.contact.reach(this.me) + 0.4)
        slowTarget = ASSIST.slowmoScale;
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
      if (this.fx.replaying) {
        this.accum = 0;
        break;
      }
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
      // a wind-up never released before landing is dropped
      else if (act.kind === 'windup' && a.state === 'land' && a.stateT >= 0 && act.t0 < this.simTime - a.stateT) a.endAction();
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
    this.fx.checkReplay();
    this.fx.cueReplay();
    // timing window cache for HUD / slow-mo / debug
    const info =
      this.me.state === 'air' || this.me.state === 'load' ? this.contact.ideal(this.me, this.simTime, 0.9, this.idealCache) : null;
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
    // follow crouch/landing dips fully, filter the small head sway (no motion sickness)
    const dy = v.eyePos.y - stand;
    const ty = stand + (dy < -0.05 ? dy * 0.85 : dy * CAMERA.fpBobScale);
    this.eye.y += (ty - this.eye.y) * k;
  }

  private follow: FollowTarget = { root: new THREE.Vector3(), eye: new THREE.Vector3(), sprint: 0, height: 1.95, side: 1 };
  private _aim = new THREE.Vector3();

  render(realDt: number, draw = true): void {
    if (this.userViewDirty) this.rebuildUserView();
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
    // the buffer holds live play (plus a short tail for the ball settling) only: a dead ball
    // does not push the last highlight out of it. A ball in the air always counts (the toss
    // and wind-up of a serve come before the rally goes live)
    if (!this.fx.ballDead() || this.ball.active) this.recordUntil = tr + 1.0;
    if (tr <= this.recordUntil) this.fx.replay.record(tr, this.ball.mesh, this.ball.mesh.visible);
    this.fx.update(animDt);
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
    this.rig.frozen = this.hitStop > 0;
    this.rig.update(realDt, this.inMenu ? null : f);
    // fade our own body when the TP camera is very close, and anyone standing in the camera's way
    const camPos = this.rig.camera.position;
    for (const [a, v] of this.views) {
      if (a === me) {
        v.setOpacity(this.rig.mode === 'tp' ? clamp01((this.rig.tpCamToPivot - 0.5) / 0.6) * 0.75 + 0.25 : 1);
        continue;
      }
      if (this.rig.mode !== 'tp' && this.rig.mode !== 'fp') {
        v.setOpacity(1);
        continue;
      }
      // distance from the camera to the athlete's body axis
      const dx = camPos.x - a.rpos.x;
      const dz = camPos.z - a.rpos.z;
      const inBody = camPos.y > a.rpos.y - 0.1 && camPos.y < a.rpos.y + a.height + 0.15;
      const d = Math.hypot(dx, dz);
      v.setOpacity(inBody ? clamp01((d - 0.35) / 0.5) * 0.8 + 0.2 : 1);
    }
    this.arena.update(realDt);
    this.updateAimReticle(realDt);
    this.hud.update(realDt);
    this.onFrame?.();
    if (this.mode && !this.inMenu) this.hud.setHint(this.mode.hint() + (this.fx.replayAvailable() ? ` · ${kbd('R')} replay` : ''));
    this.hud.setCrosshair(!this.inMenu, me.state === 'air');
    this.hud.setLoad(
      me.state === 'load' && !this.inMenu ? clamp01((me.loadT - PLAYER.loadMin * 0.5) / (PLAYER.loadMax - PLAYER.loadMin * 0.5)) : null,
    );
    // spike wind-up: power ring, a tick at full charge, a swish on release
    const wind = me.action?.kind === 'windup' ? me.action : null;
    const charge = wind ? ContactSystem.chargeFor(this.simTime - wind.t0) : -1;
    this.hud.setCharge(wind && !this.inMenu ? charge : null);
    if (charge >= 1 && this.lastCharge < 1) this.fx?.audio.chargeFull();
    if (!wind && me.action?.kind === 'swing' && me.action !== this.swished) {
      this.swished = me.action;
      if (!me.action.tip) this.fx?.audio.swish(me.action.charge);
    }
    this.lastCharge = charge;
    if (!draw) return;
    this.renderer.info.reset();
    this.post.render(realDt);
    if (this.debug.visible) this.debug.update(this.debugInfo());
  }

  private updateAimReticle(dt: number): void {
    const me = this.me;
    const mat = this.aimReticle.material as THREE.MeshBasicMaterial;
    const show = !this.inMenu && (me.state === 'air' || me.state === 'load' || me.action?.kind === 'toss' || me.action?.kind === 'windup');
    mat.opacity = lerp(mat.opacity, show ? 0.75 : 0, damp(12, dt));
    this.aimReticle.visible = mat.opacity > 0.02;
    if (this.aimReticle.visible) {
      this.aimTargetFor(me, this._aim);
      this.aimReticle.position.set(this._aim.x, 0.013, this._aim.z);
    }
  }

  private lastCharge = -1;
  private swished: unknown = null;

  notePress(at: number, ideal: number): void {
    this.lastPress = { at, ideal };
  }

  private debugInfo(): DebugInfo {
    const me = this.me;
    let window: DebugInfo['window'] = null;
    if (this.idealValid) {
      const w = me.action?.kind === 'windup' ? me.action : null;
      const ideal = this.idealCache.t - this.simTime - ContactSystem.swingLead(w ? ContactSystem.chargeFor(this.simTime - w.t0) : 1);
      window = {
        now: 0,
        ideal,
        perfect: TIMING.spikePerfect,
        good: TIMING.spikeGood,
        ok: TIMING.spikeOk,
        label: `release in ${(ideal * 1000).toFixed(0)} ms · miss dist ${this.idealCache.d.toFixed(2)} m`,
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
    const lp = this.lastPress ? ` last release err ${(this.lastPress.at * 1000).toFixed(0)} ms` : '';
    return {
      fps: this.fps,
      frameMs: this.frameMs,
      stepMs: this.stepMs,
      steps: this.stepsThisFrame,
      lines: [
        `me ${me.role} ${me.state} pos ${me.pos.x.toFixed(2)},${me.pos.y.toFixed(2)},${me.pos.z.toFixed(2)} spd ${me.speed.toFixed(2)} jump ${me.jumpH.toFixed(2)}`,
        `quality ${this.quality} (${['high', 'medium', 'low'][this.quality]}) · cam ${this.rig.mode} yaw ${this.rig.yaw.toFixed(2)} pitch ${this.rig.pitch.toFixed(2)} timescale ${(this.timeScale * this.slowmo).toFixed(2)}`,
        `draws ${this.renderer.info.render.calls} tris ${this.renderer.info.render.triangles} mem geo ${this.renderer.info.memory.geometries} tex ${this.renderer.info.memory.textures}`,
        this.ballDebug(),
        `action ${me.action ? me.action.kind : '-'} grade ${act?.grade ?? '-'} err ${act ? (act.err * 1000).toFixed(0) : '-'} ms${lp}`,
      ],
      window,
    };
  }
}
