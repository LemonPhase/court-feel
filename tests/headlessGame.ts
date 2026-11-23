import * as THREE from 'three';
import { DEFAULT_SETTINGS, type LevelId, type PositionId, type ServeKind, type Settings } from '../src/config';
import { Athlete } from '../src/game/athlete';
import type { ContactEvent } from '../src/game/contact';
import { takeKey } from '../src/game/intent';
import { NO_MARKERS } from '../src/game/modes/markers';
import type { DrillHost, DrillHud, Mode, ModeId } from '../src/game/modes/mode';
import { createMode } from '../src/game/modes/registry';
import { Simulation } from '../src/game/simulation';
import { NO_HOOKS } from './simHooks';

/** a HUD nobody reads: every line a drill writes is kept, so a test can ask what was said */
function silentHud(said: string[]): DrillHud {
  const say =
    (what: string) =>
    (...args: unknown[]): void => {
      said.push(`${what} ${args.filter((a) => typeof a === 'string' || typeof a === 'number').join(' ')}`.trim());
    };
  return {
    gradeAside: false,
    setTitle: say('title'),
    setScore: say('score'),
    setStreak: say('streak'),
    setCallSheet: () => {},
    showBanner: say('banner'),
    message: say('message'),
    go: say('go'),
    call: say('call'),
    clearCall: () => {},
    topCall: (text: string | null) => said.push(text ? `topCall ${text}` : 'topCall off'),
  };
}

/** no lesson is being taken */
const NO_LESSON: DrillHost['tutorial'] = {
  active: false,
  serving: false,
  lesson: 'spike',
  holdingFeed: () => false,
  holdingResult: () => false,
  showPath: () => false,
  urgeRun: () => false,
  noteFeed: () => {},
  noteContact: () => {},
  noteRepEnd: () => {},
};

/**
 * A whole game with nobody watching: a real simulation, a real drill and one player in seat 0,
 * with no renderer, no DOM, no HUD and no camera. It is what `Game` is to a drill (`DrillHost`),
 * cut down to what the play needs. The player's hands do nothing unless a test feeds the seat.
 */
export function headlessGame(id: ModeId, pos: PositionId, seed = 2024, opts: { level?: LevelId; autoUser?: boolean } = {}) {
  const said: string[] = [];
  const touches: string[] = [];
  const outcomes: string[] = [];
  let mode: Mode | null = null;
  let walkBack: { x: number; z: number; yaw: number } | null = null;

  const sim = new Simulation({
    ...NO_HOOKS,
    aimAssist: (a) => (a.isUser ? DEFAULT_SETTINGS.aimAssist : 0.3),
    aimTargetFor: (a, out) => (a.isUser ? out.set(a.pos.x, 0, -a.side * 6) : out.copy(a.aiAim)),
    contact: (ev: ContactEvent) => {
      // as the game does: a clean touch arms the judge, and the drill hears of every touch
      if (ev.grade !== 'Miss' && ev.speed > 0) sim.judge.arm(sim.ball);
      touches.push(`${sim.simTime.toFixed(4)} ${ev.athlete.role}${ev.athlete.side === 1 ? 'H' : 'A'} ${ev.kind} ${ev.grade}`);
      mode?.onContact(ev);
    },
    aiContact: (a, kind) => touches.push(`${sim.simTime.toFixed(4)} ${a.role}${a.side === 1 ? 'H' : 'A'} ${kind} ai`),
    outcome: (o) => outcomes.push(`${sim.simTime.toFixed(4)} ${o.kind} ${o.side}`),
  });
  sim.rng.reseed(seed);
  const me = new Athlete(pos, 1);
  me.place(-3.2, 4.5, 0);
  sim.athletes.push(me);
  const seat = sim.addSeat(me);
  // (the Mini Rally plays at Pro unless a test picks its level)
  const settings: Settings = { ...DEFAULT_SETTINGS, level: opts.level ?? 'pro' };

  const host: DrillHost = {
    get simTime() {
      return sim.simTime;
    },
    rng: sim.rng,
    ball: sim.ball,
    env: sim.env,
    contact: sim.contact,
    get athletes() {
      return sim.athletes;
    },
    get ballLive() {
      return sim.ballLive;
    },
    set ballLive(live: boolean) {
      sim.ballLive = live;
    },
    setBrain: (a, b) => sim.setBrain(a, b),
    onAiContact: (a, kind, speed) => sim.onAiContact(a, kind, speed),
    brains: sim.brains,
    clearBrains: () => sim.clearBrains(),
    judge: sim.judge,
    addAthlete: (a) => {
      if (!sim.athletes.includes(a)) sim.athletes.push(a);
    },
    removeAthlete: (a) => {
      sim.athletes = sim.athletes.filter((x) => x !== a);
      sim.brains.delete(a);
    },
    get me() {
      return seat.athlete;
    },
    keyPressed: (code) => takeKey(seat.intent, code),
    settings,
    get serveKind(): ServeKind {
      return seat.serveKind;
    },
    set serveKind(kind: ServeKind) {
      seat.serveKind = kind;
    },
    autoUser: opts.autoUser ?? false,
    placeUser: (x, z, yaw) => {
      walkBack = null;
      seat.athlete.place(x, z, yaw);
      seat.intent.yaw = yaw;
      seat.controller.clear();
    },
    // nobody is steering: the walk back between reps is taken at once
    returnUser: (x, z, yaw) => {
      walkBack = { x, z, yaw };
    },
    get userReturning() {
      return walkBack !== null;
    },
    wheelOpen: false,
    tutorial: NO_LESSON,
    events: { emit: () => {} },
    hud: silentHud(said),
    crowd: () => {},
    markers: NO_MARKERS,
    rig: { mode: 'tp', pitch: 0 },
    views: { get: () => undefined },
    fx: { replay: { contact: new THREE.Vector3() } },
  };

  mode = createMode(id, host, pos);
  sim.drill = mode;
  mode.setup();

  return {
    sim,
    seat,
    mode,
    host,
    said,
    touches,
    outcomes,
    /** play one frame: the walk back is taken, the drill's frame runs, and the simulation steps twice (120 Hz under 60 fps) */
    frame(): void {
      if (walkBack) {
        const to = walkBack;
        host.placeUser(to.x, to.z, to.yaw);
      }
      for (let i = 0; i < 2; i++) sim.step(1 / 120);
      mode!.frame(1 / 60);
    },
  };
}
