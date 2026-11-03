import './ui/styles.css';
import { BUILD_ID } from './core/build';
import { ErrorReporter, type ErrorReport } from './core/errors';
import { parseLaunchParams } from './core/launch';
import { loadSettings, saveSettings } from './core/settings';
import { Game } from './game/game';
import { Menu } from './ui/menu';
import type { ModeId } from './game/modes/mode';
import type { PositionId } from './config';
import { showCrashScreen } from './ui/crashScreen';
import { TouchControls, wantsTouch } from './ui/touchControls';

const app = document.getElementById('app')!;

// ------------------------------------------------------------ errors
// installed first, so even a failed start-up (no WebGL, a bad build) ends on a readable screen
const reporter = new ErrorReporter({ build: BUILD_ID, endpoint: import.meta.env.VITE_ERROR_REPORT_URL || undefined });
window.__errors = reporter;
let booted = false;
const crashScreen = (r: ErrorReport) => {
  const webgl = r.kind === 'startup' && /webgl/i.test(r.message);
  showCrashScreen(app, {
    title: r.kind === 'startup' ? "Court Feel couldn't start" : 'Something went wrong',
    body: webgl
      ? 'Your browser could not start 3D graphics (WebGL). Turn on hardware acceleration in the browser settings, update the browser, or try another one.'
      : r.kind === 'startup'
        ? 'The game failed while loading. Reloading usually fixes it. If it keeps happening, copy the details and send them to whoever runs Court Feel.'
        : 'The game hit an error and had to stop. Reloading usually fixes it. If it keeps happening, copy the details and send them to whoever runs Court Feel.',
    details: ErrorReporter.details(r),
  });
};
window.addEventListener('error', (e) => {
  const r = reporter.report(booted ? 'error' : 'startup', e.error ?? e.message, 'uncaught');
  if (!booted) crashScreen(r);
});
window.addEventListener('unhandledrejection', (e) => {
  reporter.report('rejection', e.reason, 'promise');
});

const settings = loadSettings();
const game = new Game(app, settings);
window.__court = game;
// game keys stay with the browser while a menu or the crash screen is up (Tab, Space and the arrows work on its controls)
game.input.captureKeys = () => !game.inMenu && !game.paused && !game.stopped;
// reduced motion: a still menu camera (shake and replays default off in loadSettings, CSS animations in styles.css)
try {
  const rm = matchMedia('(prefers-reduced-motion: reduce)');
  game.rig.reducedMotion = rm.matches;
  rm.addEventListener('change', () => (game.rig.reducedMotion = rm.matches));
} catch {
  /* no matchMedia */
}
game.onError = (err, where, fatal) => {
  // errors the game caught are not logged by the browser: keep them visible in the console
  console.error(`[court-feel] error in ${where}${fatal ? ' (game stopped)' : ''}`, err);
  const r = reporter.report(fatal ? 'crash' : 'error', err, where);
  if (fatal) crashScreen(r);
};

let lastPlay: { mode: ModeId; pos: PositionId } = { mode: 'spike', pos: 'OH' };

function resume(): void {
  menu.showPause(false);
  game.paused = false;
  game.input.clearEdges();
  game.input.requestLock();
}

const menu = new Menu(app, settings, {
  play(mode, pos) {
    game.fx.audio.unlock();
    lastPlay = { mode, pos };
    menu.showStart(false);
    game.startMode(mode, pos);
    // the key that pressed PLAY (Space, Enter) must not also act in the drill
    game.input.clearEdges();
    game.paused = false;
    game.hud.setVisible(true);
    game.input.requestLock();
    if (touch.enabled) goFullscreen();
  },
  resume,
  restart() {
    menu.showPause(false);
    game.startMode(lastPlay.mode, lastPlay.pos);
    game.input.clearEdges();
    game.paused = false;
    game.input.requestLock();
  },
  quit() {
    menu.showPause(false);
    game.stopMode();
    enterMenu();
  },
  settingsChanged() {
    saveSettings(settings);
    game.applySettings();
    touch.setEnabled(wantsTouch(settings.touchControls));
  },
});
window.__menu = menu;

// touch controls (phones / tablets): on-screen stick and hold buttons through the same input path
const touch = new TouchControls(app, game, {
  pause() {
    if (game.inMenu) return;
    game.paused = true;
    menu.showPause(true);
  },
});
window.__touch = touch;
reporter.context = () => ({
  mode: game.mode ? game.modeId : 'none',
  pos: game.position,
  menu: game.inMenu,
  cam: game.rig.mode,
  quality: game.quality,
  touch: touch.enabled,
});
touch.setEnabled(wantsTouch(settings.touchControls));
// a hybrid device in auto mode: the first touch turns the controls on
window.addEventListener(
  'touchstart',
  () => {
    if (settings.touchControls === 'auto' && !touch.enabled) touch.setEnabled(true);
  },
  { passive: true, capture: true },
);
game.onFrame = () => touch.update();

/** phones: fullscreen and landscape when the browser allows it (must come from a tap) */
function goFullscreen(): void {
  try {
    const d = document.documentElement as HTMLElement & { webkitRequestFullscreen?: () => Promise<void> | void };
    const p = d.requestFullscreen ? d.requestFullscreen({ navigationUI: 'hide' }) : d.webkitRequestFullscreen?.();
    if (p && typeof p.catch === 'function') p.catch(() => {});
  } catch {
    /* not allowed here */
  }
  try {
    const o = screen.orientation as (ScreenOrientation & { lock?: (o: string) => Promise<void> }) | undefined;
    const p = o?.lock?.('landscape');
    if (p && typeof p.catch === 'function') p.catch(() => {});
  } catch {
    /* not supported */
  }
}

function enterMenu(): void {
  game.inMenu = true;
  game.paused = false;
  game.rig.setMode('menu');
  game.hud.setVisible(false);
  menu.showStart(true);
  game.input.exitLock();
  game.startAttract();
}

game.input.onPointerLockChange = (locked) => {
  if (!locked && !game.inMenu && !game.input.dragLook) {
    // Esc during a replay ends the replay (the pause menu still opens: the browser dropped the lock)
    if (game.fx.replaying) game.fx.endReplay();
    game.paused = true;
    menu.showPause(true);
  }
};
/** Chrome refuses pointer lock for ~1.25 s after the user's Esc released it (measured from the release) */
const LOCK_COOLDOWN_MS = 1350;
let lockRetry = 0;
game.input.onLockRefused = (fallback) => {
  // no pointer lock here at all: drag-look took over, play on
  if (fallback || game.inMenu) return;
  // never leave the game running with a free mouse that doesn't look around: stay paused
  game.paused = true;
  menu.showPause(true);
  // Resume clicked right after Esc: retry once the browser allows it (that click still counts as the gesture)
  const wait = game.input.lockLostAt + LOCK_COOLDOWN_MS - performance.now();
  if (wait > 0 && !lockRetry) {
    lockRetry = window.setTimeout(() => {
      lockRetry = 0;
      if (!game.inMenu && menu.pauseVisible && !menu.settingsVisible) resume();
    }, wait);
  }
};
// a hidden tab: silence the audio and pause play (touch devices have no pointer lock whose loss would pause it)
document.addEventListener('visibilitychange', () => {
  game.fx.audio.setHidden(document.hidden);
  if (document.hidden && !game.inMenu && !game.paused) {
    game.paused = true;
    menu.showPause(true);
  }
});
window.addEventListener('keydown', (e) => {
  if (e.code !== 'Escape' || e.repeat || game.inMenu) return;
  // with pointer lock the browser consumes Esc and fires pointerlockchange instead (or delivers it too:
  // that same press must not resume)
  if (game.input.pointerLocked || performance.now() - game.input.lockLostAt < 250) return;
  if (game.fx.replaying) {
    game.fx.endReplay();
    return;
  }
  // resume through the lock request: unpausing alone left the mouse free and not steering
  if (menu.pauseVisible) resume();
  else {
    game.paused = true;
    menu.showPause(true);
  }
});
window.addEventListener('pointerdown', () => game.fx.audio.unlock(), { once: false });
window.addEventListener('keydown', () => game.fx.audio.unlock());
app.addEventListener('mousedown', () => {
  if (!game.inMenu && !game.paused && !game.input.pointerLocked && !game.input.dragLook) game.input.requestLock();
});

// quick-start links for automation and sharing a drill: ?mode=spike&pos=OH&bot=perfect&cam=fp
enterMenu();
const launch = parseLaunchParams(location.search);
if (launch) {
  if (launch.cam) settings.firstPerson = launch.cam === 'fp';
  menu.showStart(false);
  menu.selectPos(launch.pos);
  lastPlay = { mode: launch.mode, pos: launch.pos };
  game.startMode(launch.mode, launch.pos);
  game.hud.setVisible(true);
  if (launch.bot) game.enableBot(launch.bot);
}
// robustness: a lost GL context pauses the game and offers a reload
const canvas = game.renderer.domElement;
canvas.addEventListener('webglcontextlost', (e) => {
  e.preventDefault();
  game.paused = true;
  const m = document.createElement('div');
  m.className = 'ctx-lost';
  m.innerHTML = 'The graphics context was lost.<br><button>Reload</button>';
  m.querySelector('button')!.addEventListener('click', () => location.reload());
  app.append(m);
});
game.start();
booted = true;
