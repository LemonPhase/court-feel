import * as THREE from 'three';
import {
  CAMERA,
  CHARACTER,
  COURT,
  PLAYER,
  SERVE,
  SIM,
  TIMING,
  TUTORIAL,
  type PositionId,
  type ServeKind,
  type Settings,
  type VenueId,
} from '../config';
import { Emitter } from '../core/events';
import type { GameEvents } from '../game/gameEvents';
import { Input } from '../core/input';
import { clamp01, damp, lerp, Rng } from '../core/mathx';
import { CameraRig, type FollowTarget } from '../camera/cameraRig';
import { BODY_LIGHT } from '../character/bodyMaterial';
import { Arena } from '../world/arena';
import { setVenue, VENUE, VENUE_ID } from '../world/venue';
import { REFLECT_LAYER } from '../world/floorReflection';
import { Post } from '../fx/post';
import { Athlete, handSign } from '../game/athlete';
import { bodyStats } from '../game/body';
import { copyIntent, idleIntent, readIntent, readKeys, takeKey, type Intent } from '../game/intent';
import type { Seat } from '../game/seat';
import type { UserController } from '../game/userController';
import { DebugOverlay, type DebugInfo } from '../ui/debug';
import { BallEntity, type TouchKind } from '../game/ballEntity';
import { BallView } from '../world/ballView';
import { Simulation } from '../game/simulation';
import { DebugGizmos } from '../fx/debugGizmos';
import { SceneMarkers } from '../fx/drillMarkers';
import type { BallEnv } from '../physics/ball';
import { AthleteView } from '../character/athleteView';
import { makeKit } from '../character/kits';
import type { Kit } from '../character/rig';
import { wheelPlays } from '../game/playbook';
import { setStepAssist } from '../game/setAssist';
import { autoSetJump, takeoffSpot } from '../game/setJump';
import { aimTargetFromLook, ContactSystem, tossGroove, type ContactEvent, type IdealInfo, type SetPreview } from '../game/contact';
import { SetGuide } from '../fx/setGuide';
import { SetRing } from '../fx/setRing';
import { SetSpot } from '../fx/setSpot';
import { SetBar } from '../ui/setBar';
import { PlayWheel } from '../ui/playWheel';
import type { RouteView } from '../game/routes';
import { SetRadar } from '../ui/setRadar';
import { Judge } from '../game/judge';
import { Hud } from '../ui/hud';
import type { AiHost, Brain } from '../game/brains';
import { kbd } from '../core/kbd';
import { type Mode, type ModeId } from '../game/modes/mode';
import { createMode } from '../game/modes/registry';
import { makeRingTexture } from '../world/textures';
import type { UserActions } from '../game/userActions';
import { lessonStore } from './lessonStore';
import { Pace } from './pace';
import { QualityGovernor } from './quality';
import { BlockBot, isBotQuality, ServeBot, SpikeBot, TouchBot, type BotQuality } from './bot';
import { Effects } from '../fx/effects';
import { reached, Tutorial, type Lesson, type TutorialBegin } from '../game/tutorial';

/** consecutive frames that throw before the game stops and shows the crash screen */
const MAX_FAILED_FRAMES = 10;

/**
 * Owns the renderer, the fixed-timestep simulation, the current drill and
 * the render loop.
 */
export class Game implements AiHost {
  readonly renderer: THREE.WebGLRenderer;
  readonly scene = new THREE.Scene();
  /** what the drill has put on the court for the player to read (a ring, the zone to hit, the block's shadow): the drill says what, this draws it */
  readonly markers = new SceneMarkers(this.scene);
  readonly rig: CameraRig;
  arena: Arena;
  readonly post: Post;
  readonly input: Input;
  /** this machine's player: their athlete, their controller, the actions they hold. A second player would be a second seat */
  readonly seat: Seat;
  get user(): UserController {
    return this.seat.controller;
  }
  /** a listener that throws is reported, the others still run and the step carries on */
  readonly events = new Emitter<GameEvents>((err, type) => this.reportError(err, `'${String(type)}' event handler`, false));
  readonly debug: DebugOverlay;
  readonly hud: Hud;
  /** the simulation: the athletes, the ball, the clock, the brains and the step. Everything else here draws it or drives it */
  readonly sim: Simulation;
  /** the ball as it is drawn */
  readonly ballView: BallView;
  readonly gizmos: DebugGizmos;
  readonly views = new Map<Athlete, AthleteView>();
  get actions(): UserActions {
    return this.seat.actions;
  }
  readonly fx: Effects;
  private currentMode: Mode | null = null;
  modeId: ModeId = 'spike';
  position: PositionId = 'OH';
  /** autopilot driving the user's inputs (tests / attract mode) */
  bot: { step(dt: number): void; steer(intent: Intent): void } | null = null;

  private lastRenderSimT = 0;
  private accum = 0;
  /** how fast the play runs: the slow-mo assists, the lesson's clock and the hit-stop (src/app/pace.ts) */
  readonly pace = new Pace();
  get timeScale(): number {
    return this.pace.timeScale;
  }
  set timeScale(v: number) {
    this.pace.timeScale = v;
  }
  /** the game speed from the slow-mo assists right now (the set bot times its frames by it) */
  get slowmo(): number {
    return this.pace.slowmo;
  }
  /** the set coming down onto the user's hands (refreshed each frame), for the set slow-mo and the timing ring */
  private setPrev: SetPreview | null = null;
  /** the set coming to you, before you are under it: the bar shows early when the ball is yours to set */
  private setComing: SetPreview | null = null;

  /**
   * Your set loading in your hands, for the load tone: 0 at the catch, 1 at the top of the bar
   * (above 1 held past it). Null when no set is loading, the game is paused or in a menu or a
   * replay, or the set cues are off (Settings: Set ring and bar).
   */
  setLoading(): number | null {
    const bar = this.setPrev?.bar;
    if (!bar || this.paused || this.inMenu || this.fx.replaying || !this.settings.setRing) return null;
    return (this.simTime - bar.start) / (bar.target - bar.start);
  }
  private setRing!: SetRing;
  private setBar!: SetBar;
  private setGuide!: SetGuide;
  private setRadar!: SetRadar;
  private wheel!: PlayWheel;
  /** the route panel is open (a hitter's C; the app draws it, `routeView`) */
  routesOpen = false;

  /** the play wheel is open: a drill holds its next ball, and the game runs slow */
  get wheelOpen(): boolean {
    return this.wheel.open;
  }
  private setSpot!: SetSpot;
  private spotP = { x: 0, y: 0, z: 0 };
  /** seconds the play holds still after a clean hit: the effects ask for it, the pace spends it */
  get hitStop(): number {
    return this.pace.hitStop;
  }
  set hitStop(v: number) {
    this.pace.hitStop = v;
  }
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
  /** the lesson's three balls are done (`clean`: the last one was a Perfect or a Good): offer what to do next */
  /** where the lessons remember how far a visitor has got */
  readonly lessonStore = lessonStore();
  onTutorialDone: ((clean: boolean, lesson: Lesson) => void) | null = null;
  /** Skip tutorial: 'menu' from the welcome, 'drill' once a rep is underway */
  onTutorialSkipped: ((where: 'menu' | 'drill') => void) | null = null;
  tutorial!: Tutorial;
  /** test hook: stop the RAF loop from rendering (screenshots render on demand) */
  holdRender = false;
  /** in the menu: attract camera, no user control */
  inMenu = true;
  /** test hook: the user's athlete is driven by the team AI */
  autoUser = false;
  /** the serve the player has picked (keys 1-3 in the Serve drill): their next toss is that serve's toss */
  get serveKind(): ServeKind {
    return this.seat.serveKind;
  }
  set serveKind(kind: ServeKind) {
    this.seat.serveKind = kind;
  }
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
  /** the venue setting as last applied (a change to it ends a link's override) */
  private venueSetting: VenueId;
  private idealCache: IdealInfo = { t: 0, d: 0, ball: new THREE.Vector3(), point: new THREE.Vector3() };
  private idealValid = false;
  /** last timing info for the debug overlay */
  private lastPress: { at: number; ideal: number } | null = null;

  constructor(
    private container: HTMLElement,
    public settings: Settings,
    /** a venue asked for by the link: it wins over the saved one until the player picks a venue in Settings */
    private venueOverride: VenueId | null = null,
    /** keeps the settings after a change. The app decides where (the browser's storage): the game does not know */
    private persist: (s: Settings) => void = () => {},
  ) {
    // first: the venue, the settings and the display below all read the simulation's ball and net
    this.sim = new Simulation({
      aimAssist: (a) => (a.isUser ? this.settings.aimAssist : 0.3),
      setAssist: (a) => (a.isUser ? this.settings.setAimAssist : 0.3),
      setByFeel: () => !this.settings.setRing,
      aimTargetFor: (a, out) => this.aimTargetFor(a, out),
      contact: (ev) => this.onContact(ev),
      aiContact: (athlete, kind, speed) => this.events.emit('aiContact', { athlete, kind, speed }),
      ballEvent: (e) => this.events.emit('ballEvent', e),
      floatBreak: (strength) => this.events.emit('floatBreak', { strength }),
      outcome: (o) => this.events.emit('outcome', o),
      setLevel: () => this.settings.setLevel,
      userSetJump: () => this.userSetJump(),
    });
    this.venueSetting = settings.venue;
    setVenue(venueOverride ?? settings.venue);
    this.renderer = new THREE.WebGLRenderer({ antialias: false, powerPreference: 'high-performance' });
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 1.5));
    this.renderer.setSize(container.clientWidth, container.clientHeight);
    this.renderer.shadowMap.enabled = true;
    // three r187 removed PCFSoftShadowMap: the soft edge comes from the key light's shadow radius
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
    this.applyVenue();
    this.post.preRender = () => this.arena.reflection.render(this.rig.camera);
    this.input = new Input(this.renderer.domElement);
    this.debug = new DebugOverlay(container);
    this.hud = new Hud(container);
    this.hud.camera = this.rig.camera;
    this.ballView = new BallView(this.scene, this.ball);
    this.ballView.mesh.layers.enable(REFLECT_LAYER);
    this.setRing = new SetRing(this.scene);
    this.setSpot = new SetSpot(this.scene);
    this.setBar = new SetBar(this.hud.root);
    this.setGuide = new SetGuide(this.scene, this.hud.root);
    this.setRadar = new SetRadar(this.hud.root);
    // a tapped slice (touch) presses that play's number, through Input like every control
    this.wheel = new PlayWheel(this.hud.root, (i) => {
      this.input.down('Digit' + (i + 1));
      this.input.up('Digit' + (i + 1));
    });
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

    this.seat = this.sim.addSeat(new Athlete('OH', 1, { body: settings.bodies.OH, hand: settings.hand }), {
      inputTime: () => this.inputTime(),
      tutorial: { ownsButtons: () => this.tutorial.ownsButtons(), quiet: () => this.tutorial.quiet() },
      notePress: (err, contactT) => this.notePress(err, contactT),
    });
    this.me.place(-3.2, 4.5, 0);
    this.addAthlete(this.me);
    this.fx = new Effects(this, container);
    // the venue was applied above, before there was a ball or any sound: a saved or linked venue starts with its own
    this.applyVenueToBallAndSound();

    this.applySettings();
    window.addEventListener('resize', () => this.resize());
    this.resize();
    this.tutorial = new Tutorial(this);
  }

  // ------------------------------------------------------------ the simulation's own, as the game's
  // Drills, effects, the menus and the test hooks read these from the game, as they did when the
  // game held them itself.
  get athletes(): Athlete[] {
    return this.sim.athletes;
  }
  set athletes(list: Athlete[]) {
    this.sim.athletes = list;
  }
  get me(): Athlete {
    return this.sim.me;
  }
  set me(a: Athlete) {
    this.sim.me = a;
  }
  get ball(): BallEntity {
    return this.sim.ball;
  }
  get env(): BallEnv {
    return this.sim.env;
  }
  get rng(): Rng {
    return this.sim.rng;
  }
  get brains(): Map<Athlete, Brain> {
    return this.sim.brains;
  }
  get contact(): ContactSystem {
    return this.sim.contact;
  }
  get judge(): Judge {
    return this.sim.judge;
  }
  get simTime(): number {
    return this.sim.simTime;
  }
  set simTime(t: number) {
    this.sim.simTime = t;
  }
  /** rally modes: is the ball in play (AI teams read this) */
  get ballLive(): boolean {
    return this.sim.ballLive;
  }
  set ballLive(live: boolean) {
    this.sim.ballLive = live;
  }
  /** the drill being played: the simulation steps it */
  get mode(): Mode | null {
    return this.currentMode;
  }
  set mode(m: Mode | null) {
    this.currentMode = m;
    this.sim.drill = m;
  }

  // ------------------------------------------------------------ athletes
  addAthlete(a: Athlete, seed = this.athletes.length + 1, kitKind: 'team' | 'coach' = 'team'): AthleteView {
    this.athletes.push(a);
    let kit: Kit = makeKit(a.team, a.role === 'L', seed);
    if (kitKind === 'coach') kit = { ...kit, jersey: 0x4a4f5c, jerseyTrim: 0x9aa0ad, shorts: 0x2a2d35, socks: 0x2a2d35, pads: 0x2a2d35 };
    const v = new AthleteView(a, kit);
    this.views.set(a, v);
    v.rig.mesh.layers.enable(REFLECT_LAYER);
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
    v.rig.dispose();
  }

  removeAthlete(a: Athlete): void {
    const v = this.views.get(a);
    if (v) this.disposeView(v);
    this.views.delete(a);
    this.brains.delete(a);
    this.athletes = this.athletes.filter((x) => x !== a);
  }

  setBrain(a: Athlete, b: Brain): void {
    this.sim.setBrain(a, b);
  }

  clearBrains(): void {
    this.sim.clearBrains();
  }

  /** set the user's body + camera facing (teleport) */
  placeUser(x: number, z: number, yaw: number): void {
    this.ret = null;
    this.me.place(x, z, yaw);
    this.rig.yaw = yaw;
    // a teleport turns the player's look with their body
    this.user.intent.yaw = yaw;
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
    const keys = this.user.intent.steering;
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
    this.removeAthlete(old);
    // the seat's athlete: it is the player's from here on
    this.me = a;
    this.addAthlete(a, 1);
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
    v.rig.mesh.layers.enable(REFLECT_LAYER);
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
    this.serveKind = 'float';
    this.contact.serving = null;
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

  /**
   * Guided first session: Spike Drill, Outside, block off. Camera stays whatever
   * the player picked (FP and TP both stay available). `replay` starts at the welcome.
   * A serve lesson (`lesson`: the serve) runs on the Serve Drill, as an Outside Hitter.
   */
  beginTutorial(opts: TutorialBegin = {}): void {
    this.hud.setVisible(true);
    this.paused = false;
    this.tutorial.begin(opts);
    this.startMode(this.tutorial.lesson === 'spike' ? 'spike' : 'serve', 'OH');
    this.tutorial.present();
  }

  /** Skip: don't stay frozen for a frame after the lesson ends */
  snapTutor(): void {
    this.pace.tutor = 1;
  }

  stopMode(): void {
    // quitting to the menu part-way through the lesson leaves it (it is offered again from where it stopped)
    this.tutorial.leave();
    this.mode?.teardown();
    this.mode = null;
    this.judge.disarm();
    this.ball.hide();
  }

  // ------------------------------------------------------------ venue
  /** what the venue sets outside the arena itself: the athletes' light, the grade, and whether the sky is open */
  private applyVenue(): void {
    BODY_LIGHT.rim.value = CHARACTER.rim * VENUE.body.rim;
    BODY_LIGHT.side.value = CHARACTER.sideFill * VENUE.body.side;
    this.post.setGrade(VENUE.grade);
    // the one thing a venue changes about play (docs/adr/0009): outdoors nothing stops the ball overhead
    this.env.ceiling = VENUE.openSky ? null : COURT.ceiling;
  }

  /** the rest of what a venue sets, on things the constructor builds after the arena: the predictor's reach and the crowd's sound */
  private applyVenueToBallAndSound(): void {
    // with no roof a ball can stay up longer than any ball can indoors: look as far ahead as it can fly
    this.ball.predictor.setHorizon(VENUE.openSky ? SIM.predictHorizonOpenSky : SIM.predictHorizon);
    this.fx.audio.setCrowdShare(VENUE.crowdSound);
  }

  /** rebuild what stands round the court (the court, the net and everyone on it stay where they are) */
  private changeVenue(id: VenueId): void {
    const netTop = this.arena.netTop;
    this.arena.dispose();
    setVenue(id);
    this.arena = new Arena(this.renderer, this.scene);
    this.arena.setNetHeight(netTop);
    this.applyVenue();
    this.applyVenueToBallAndSound();
    this.ball.version++;
    // the mirror's size and the quality level's choices belong to the arena that was thrown away
    this.setQuality(this.quality);
  }

  /** the venue the court is standing in */
  get venue(): VenueId {
    return VENUE_ID;
  }

  /**
   * The player picked a venue in Settings: that pick is saved and it ends a link's `venue=`, even when it
   * is the venue that was already saved (otherwise the saved one could not be chosen back from a link).
   */
  pickVenue(id: VenueId): void {
    this.settings.venue = id;
    this.venueSetting = id;
    this.venueOverride = null;
  }

  // ------------------------------------------------------------ settings
  applySettings(): void {
    const s = this.settings;
    this.rig.baseFov = s.fov;
    this.rig.shakeScale = s.shake;
    if (s.venue !== this.venueSetting) {
      this.venueSetting = s.venue;
      this.venueOverride = null;
    }
    const venue = this.venueOverride ?? s.venue;
    if (venue !== VENUE_ID) this.changeVenue(venue);
    this.arena.setNetHeight(s.womenNet ? COURT.netHeightWomen : COURT.netHeightMen);
    this.rig.netTop = this.arena.netTop;
    this.env.netTop = this.arena.netTop;
    this.ball.version++;
    this.ball.showMarker = s.landingMarker;
    this.rig.blockers = this.arena.cameraBlockers;
    if (!this.inMenu) this.rig.setMode(s.firstPerson ? 'fp' : 'tp');
    this.hud.showHints = s.showHints;
    this.hud.setShown(s.hudGrades, s.hudCalls);
    this.hud.setLook(s.hudLook);
    this.fx?.audio.setVolume(s.volume);
    this.applyUserBody();
    this.persist(s);
  }

  toggleCamera(): void {
    this.settings.firstPerson = !this.settings.firstPerson;
    this.rig.setMode(this.settings.firstPerson ? 'fp' : 'tp');
    this.persist(this.settings);
    this.hud.setCam(this.settings.firstPerson);
    this.events.emit('toggleCam', { fp: this.settings.firstPerson });
  }

  resize(): void {
    const w = this.container.clientWidth;
    const h = this.container.clientHeight;
    this.renderer.setSize(w, h);
    this.post.setSize(w, h);
    const pr = this.renderer.getPixelRatio();
    this.arena.reflection.setSize(w * pr, h * pr);
    this.rig.resize(w / h);
  }

  // ------------------------------------------------------------ contacts
  aimTargetFor(a: Athlete, out: THREE.Vector3): THREE.Vector3 {
    if (a.isUser) {
      // the lesson's together rep: the coach aims it too (deep, down the hitter's line). Aiming comes later.
      if (this.tutorial.ownsButtons())
        return out.set(a.pos.x, 0, -a.side * (this.tutorial.serving ? TUTORIAL.serveAimDepth : TUTORIAL.aimDepth));
      const from = a.action && a.action.kind === 'swing' ? a.action.contactPoint : a.pos;
      const look = this.sim.seatOf(a)?.intent ?? this.user.intent;
      return aimTargetFromLook(from.x, from.z, look.yaw, look.pitch, look.firstPerson, a.side, out);
    }
    return out.copy(a.aiAim);
  }

  private onContact(ev: ContactEvent): void {
    if (ev.athlete.isUser) {
      if (ev.grade) {
        const kmh = ev.speed * 3.6;
        const pw =
          ev.power !== undefined && !ev.tip ? ` · ${ev.power >= 0.999 ? 'full power' : `power ${Math.round(ev.power * 100)}%`}` : '';
        // a set shows its release timing and what shrank the window; a perfectly timed one is a green
        const set = ev.kind === 'set';
        let sub =
          ev.grade === 'Miss' || set ? ev.note : `${kmh.toFixed(0)} km/h${pw}${ev.note ? ' · ' + ev.note : ''}${ev.tip ? ' · tip' : ''}`;
        if (this.tutorial.active) sub = this.tutorial.gradeSub(ev.grade, sub);
        this.hud.showGrade(ev.grade, sub, set && ev.perfect);
      }
      if (ev.speed > 0) this.hud.setSpeed(ev.speed * 3.6);
    }
    if (ev.grade !== 'Miss' && ev.speed > 0) this.judge.arm(this.ball);
    this.mode?.onContact(ev);
    this.events.emit('contact', ev);
  }

  /** AI touches (sets, digs, blocks) for audio/FX */
  onAiContact(a: Athlete, kind: TouchKind, speed: number): void {
    this.sim.onAiContact(a, kind, speed);
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
  /** 0 = full (MSAA, 1.5x DPR cap), 1 = no MSAA + 1x DPR, 2 = 0.8x scale + 1024 shadows + no floor mirror */
  get quality(): number {
    return this.governor.level;
  }
  private readonly governor = new QualityGovernor();

  private governQuality(dt: number): void {
    if (this.manual || document.hidden) return;
    const next = this.governor.frame(dt);
    if (next !== null) this.setQuality(next);
  }

  setQuality(q: number): void {
    this.governor.set(q);
    const dpr = window.devicePixelRatio || 1;
    this.post.setSamples(this.quality === 0 ? 4 : 0);
    this.arena.reflection.setEnabled(this.quality < 2);
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

  /** can the last attempt be replayed right now (R)? */
  replayAvailable(): boolean {
    return this.fx.replayAvailable();
  }

  private renderReplay(dt: number, draw: boolean): void {
    this.setRing.hide();
    this.setBar.hide();
    this.setGuide.hide();
    this.setRadar.hide();
    this.wheel.hide();
    this.setSpot.hide();
    this.mode?.replayFrame();
    this.arena.netPress(this.ballView.mesh.visible ? this.ballView.mesh.position : null);
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
  /**
   * Set aim assist for your footwork: the ball is yours to set and you are on the floor near
   * the spot, so your body takes the last steps onto it (setStepAssist; off at assist 0, and
   * once the ball is in your hands).
   */
  private assistSetStep(): void {
    const me = this.me;
    if (!this.user.intent.helped || this.settings.setAimAssist <= 0 || me.state !== 'ground' || !this.mode?.userSetsNext?.()) return;
    if (me.action?.kind === 'set' && me.action.absorbing) return;
    // going up for it: the steps go to where the hop takes off from (the spot, less what your run carries)
    const jump = this.contact.setCatch(me)?.jump;
    const spot = jump ? takeoffSpot(me, jump, this.stepP) : this.contact.setSpot(me, this.stepP);
    if (spot) setStepAssist(me.cmd, me.pos, spot, this.settings.setAimAssist);
  }
  private stepP = { x: 0, y: 0, z: 0 };

  /**
   * The play wheel (C, while the mode lets you call a play): hold C and move the mouse to a
   * play, let go to call it; or press C, then the play's number (a tap on touch) or click.
   * C again closes it. Returns whether the wheel has the mouse this frame.
   * A hitter calling their own route has no wheel: C opens and closes the route panel.
   */
  private playWheelFrame(dx: number, dy: number): boolean {
    const w = this.wheel;
    const calls = this.mode?.playCalls?.() ?? null;
    const pressed = this.input.consumePress('KeyC');
    const released = this.input.consumeRelease('KeyC');
    if (!calls) {
      w.hide();
      if (pressed && this.routeView()) this.routesOpen = !this.routesOpen;
      return false;
    }
    if (!w.open) {
      if (!pressed) return false;
      w.show(calls.combo(wheelPlays()));
    } else if (pressed) {
      w.hide();
      return false;
    }
    w.setAside(this.ballLive);
    w.move(dx, dy);
    let pick = -1;
    const plays = wheelPlays();
    for (let i = 0; i < plays.length; i++) if (this.input.consumePress('Digit' + (i + 1))) pick = i;
    if (pick < 0 && w.sel >= 0 && (released || this.input.consumePress('Mouse0'))) pick = w.sel;
    if (pick < 0) return true;
    if (calls.setCombo(plays[pick])) this.hud.message(`Play · ${plays[pick].name}`, 1.4, false);
    w.hide();
    return false;
  }

  /** your routes as a hitter, for the route strip and panel (null: you are not calling your own route) */
  routeView(): RouteView | null {
    return this.mode && !this.inMenu ? (this.mode.routes?.() ?? null) : null;
  }

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
        this.user.intent = this.hands();
        this.user.frame(dt);
        this.stepReturn(dt);
      } else readKeys(this.input, this.user.intent);
      return;
    }
    this.bot?.step(dt);
    const [dx, dy] = this.input.takeMouse();
    // the play wheel takes the mouse while it is open
    if (!this.playWheelFrame(dx, dy)) this.rig.look(dx, dy, this.settings.sensitivity, this.settings.invertY);
    if (this.input.consumePress('KeyV')) this.toggleCamera();
    // from here on the frame is played from the intent: whoever's hands it came from
    this.user.intent = this.hands();
    if (this.keyPressed('KeyN')) this.mode?.restartRep();
    if (this.input.consumePress('KeyR')) this.fx.startReplay();
    this.user.frame(dt);
    this.assistSetStep();
    // the lesson's together rep: the coach holds your line (what you hold decides whether time runs)
    this.tutorial.drive(this.me);
    this.stepReturn(dt);
  }

  /**
   * Whose hands play the user's athlete, when they are not this machine's keys and camera: a
   * recording being played back, or (one day) a player on another machine. Null: read `Input`.
   */
  handsFrom: (() => Intent) | null = null;
  /** when set, every frame's intent is added to it: the whole of what the player did, in order */
  handsLog: Intent[] | null = null;
  private readonly handsNow = idleIntent();

  /** this frame's intent for the user's athlete */
  private hands(): Intent {
    if (this.handsFrom) return this.handsFrom();
    const intent = readIntent(this.input, this.rig, this.handsNow);
    // an autopilot presses the buttons and turns the camera like a person, and says where its feet go outright
    this.bot?.steer(intent);
    this.handsLog?.push(copyIntent(intent));
    return intent;
  }

  /** a command key was pressed (`COMMAND_KEYS`). True once for each press: it is taken from the intent, and from `Input` where it came from */
  keyPressed(code: string): boolean {
    if (!takeKey(this.user.intent, code)) return false;
    this.input.consumePress(code);
    return true;
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
            : this.modeId === 'serve'
              ? new ServeBot(this, quality)
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
    // slow-mo assist while lining up a contact: a spike's, so not in a jump set (it has its own)
    // unless you swing at the ball
    const swinging = this.me.airIntent !== 'set' || this.me.action?.kind === 'windup';
    const dip = (this.settings.slowmoAssist || this.tutorial.wantsContactDip()) && this.me.state === 'air' && swinging && this.idealValid;
    // your set (Settings: Set slow-mo): time slows for the catch, and more while the ball loads in
    // your hands, the same on every level; only when you are under the ball or have pressed
    const sp = this.inMenu ? null : this.contact.setPreview(this.me);
    this.setPrev = sp && (sp.pressed || sp.absorbing || sp.centreD < this.contact.setReach(this.me) + 0.4) ? sp : null;
    this.setComing = sp;
    // a moment the lesson's ball waits at is never simulated past: `stopAt`
    const stopAt = this.tutorial.stopAt();
    const simDt = this.pace.simSeconds(realDt, {
      // choosing a play: the game waits for you (it runs, slowly), unless the drill says not to
      wheelOpen: this.wheel.open && (this.mode?.wheelSlows?.() ?? true),
      swing: dip ? { until: this.idealCache.t - this.simTime, inReach: this.idealCache.d < this.contact.reach(this.me) + 0.4 } : null,
      set:
        this.setPrev && this.settings.setSlowmo ? { until: this.setPrev.tIdeal - this.simTime, absorbing: this.setPrev.absorbing } : null,
      lesson: { scale: this.tutorial.timeScale(), snap: this.tutorial.snapScale() },
    });
    this.accum += simDt;
    const ts = performance.now();
    let n = 0;
    while (this.accum >= step) {
      if (reached(this.simTime, stopAt)) {
        this.accum = 0;
        break;
      }
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
    if (this.tutorial.active && !this.fx.replaying) this.tutorial.frame(realDt);
  }

  /** when the ball the user is jumping at is best met (sim time), or -1 with nothing to reach */
  idealT(): number {
    return this.idealValid ? this.idealCache.t : -1;
  }

  /**
   * The sim time of the frame on screen (between the last two steps): what a press or release
   * you make now is timed against. In heavy slow-mo a step spans several frames, so the step
   * time alone would round your release to the step.
   */
  inputTime(): number {
    return this.simTime - 1 / SIM.hz + this.accum;
  }

  /**
   * Your jump set (Settings: Auto jump set): a pass in system is yours to set, so your body goes
   * up for it by itself, timed so the top of the jump is in the middle of the touch. The catch and
   * the release stay yours. Off, or out of system, you set from the floor (or jump yourself: Space).
   */
  private userSetJump(): void {
    const me = this.me;
    const sets = !this.inMenu && !!this.mode?.userSetsNext?.();
    me.jumpSets = sets && this.settings.autoJumpSet;
    // what the arms get ready for in the air, chosen on the floor (a jump keeps what it went up for)
    if (me.grounded) me.airIntent = sets ? 'set' : 'attack';
    if (me.jumpSets) autoSetJump(me, this.contact.setCatch(me)?.jump ?? null, this.simTime);
  }

  fixedStep(dt: number): void {
    this.sim.step(dt);
    this.fx.trackAttempt();
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
    this.ball.interpolate(alpha, this.hitStop > 0);
    this.ballView.sync();
    // the net's mesh goes with a ball that is in it
    this.arena.netPress(this.ball.active ? this.ball.rpos : null);
    const step = 1 / SIM.hz;
    const tr = this.simTime - step * (1 - alpha);
    const animDt = Math.max(0, tr - this.lastRenderSimT);
    this.lastRenderSimT = tr;
    for (const [a, v] of this.views) {
      a.ballPos = this.ball.active ? this.ball.rpos : null;
      a.ballVel = this.ball.active ? this.ball.state.v : null;
      v.passZone = this.contact.platformPoint(a, v.passZone ?? new THREE.Vector3());
      v.setZone = this.contact.handsPoint(a, v.setZone ?? new THREE.Vector3());
      if (this.ball.active) a.lookAt.copy(this.ball.rpos);
      a.alert = this.ball.active && !this.ball.state.rest ? 1 : 0;
      v.setFirstPerson(a.isUser && this.rig.mode === 'fp' && !this.inMenu);
      v.netTop = this.env.netTop;
      v.update(animDt, tr);
    }
    this.ballView.update(realDt, this.simTime, this.env);
    // the buffer holds live play (plus a short tail for the ball settling) only: a dead ball
    // does not push the last highlight out of it. A ball in the air always counts (the toss
    // and wind-up of a serve come before the rally goes live)
    if (!this.fx.ballDead() || this.ball.active) this.recordUntil = tr + 1.0;
    if (tr <= this.recordUntil) this.fx.replay.record(tr, this.ballView.mesh, this.ballView.mesh.visible);
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
    const cues = this.settings.setRing && this.ball.active && this.ball.visible && !this.inMenu;
    this.setRing.update(this.setPrev, this.ball.rpos, tr, this.rig.camera, cues);
    const last = this.contact.lastSetResult;
    const yours = !this.inMenu && !!this.mode?.userSetsNext?.();
    const barFor = this.setPrev ?? (yours ? this.setComing : null);
    const fp = this.settings.firstPerson;
    this.setBar.update(barFor, last?.athlete === me ? last : null, this.ball.rpos, this.rig.camera, tr, realDt, cues, fp);
    // who the set goes to is not timing: it has its own switch (Settings: Set arc and hitter marker)
    this.setGuide.update(barFor, this.rig.camera, realDt, this.settings.setArc && this.ball.active && this.ball.visible && !this.inMenu);
    // where to stand for your set, instead of where the ball would land
    const spot = yours && !this.setPrev?.absorbing ? this.contact.setSpot(me, this.spotP) : null;
    // (a second ring: your body is going up for this one, or already has)
    const jumping = !!spot && (me.state === 'air' || me.state === 'load' || !!this.contact.setCatch(me)?.jump);
    this.setSpot.update(spot, me.rpos, realDt, jumping);
    // looking up at the ball in first person the floor is out of view: the same spot on a dial
    this.setRadar.update(fp && !this.inMenu ? spot : null, me.rpos, this.rig.yaw);
    // the ball's landing ring, unless one of those rings says where to stand instead; the lesson
    // shows where your feet go, so the ring beside it would be a second ring to read
    this.ball.showMarker = this.settings.landingMarker && !spot && !this.setPrev?.absorbing && !this.tutorial.teaching;
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
    if (!this.routeView()) this.routesOpen = false;
    this.onFrame?.();
    if (this.mode && !this.inMenu) {
      const tutoring = this.tutorial.active;
      const base = tutoring ? this.tutorial.hint() : this.mode.hint();
      const replay = !tutoring && this.fx.replayAvailable() ? ` · ${kbd('R')} replay last attempt` : '';
      this.hud.setHint(base + replay, tutoring);
    }
    this.hud.setCrosshair(!this.inMenu, me.state === 'air');
    this.hud.setLoad(
      me.state === 'load' && !this.inMenu ? clamp01((me.loadT - PLAYER.loadMin * 0.5) / (PLAYER.loadMax - PLAYER.loadMin * 0.5)) : null,
    );
    // spike wind-up: power ring, a tick at full charge, a swish on release
    const wind = me.action?.kind === 'windup' ? me.action : null;
    const charge = wind ? ContactSystem.chargeFor(this.simTime - wind.t0) : -1;
    // (the same ring shows how high a toss being held will go, with a mark at the serve's own height)
    this.hud.setCharge(this.inMenu ? null : wind ? charge : this.actions.tossHold(), wind ? null : tossGroove() / SERVE.hold.full);
    // the spike's timing collar (Settings: Spike timing collar): a swing's, so not in a jump set unless you wind up
    const collarErr =
      this.idealValid && me.state === 'air' && (me.airIntent !== 'set' || !!wind) && !this.inMenu
        ? this.simTime + ContactSystem.swingLead(wind ? charge : 0) - this.idealCache.t
        : null;
    this.hud.setTiming(collarErr !== null && (this.tutorial.active || this.settings.spikeCollar) ? collarErr : null);
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
    // (a serve is aimed from the toss to the hit: the run-up under a jump serve's toss is longer than the toss's own pose)
    const show =
      !this.inMenu &&
      (me.state === 'air' ||
        me.state === 'load' ||
        me.action?.kind === 'toss' ||
        me.action?.kind === 'windup' ||
        this.contact.serving === me);
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
        ...(this.mode?.debugLines?.() ?? []),
      ],
      window,
    };
  }
}
