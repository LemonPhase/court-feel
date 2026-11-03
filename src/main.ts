import './ui/styles.css';
import { loadSettings, saveSettings } from './core/settings';
import { Game } from './game/game';
import { Menu } from './ui/menu';
import type { ModeId } from './game/modes/mode';
import type { PositionId } from './config';
import { TouchControls, wantsTouch } from './ui/touchControls';

const app = document.getElementById('app')!;
const settings = loadSettings();
const game = new Game(app, settings);
(window as any).__court = game;

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
    game.paused = false;
    game.hud.setVisible(true);
    game.input.requestLock();
    if (touch.enabled) goFullscreen();
  },
  resume,
  restart() {
    menu.showPause(false);
    game.startMode(lastPlay.mode, lastPlay.pos);
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
(window as any).__menu = menu;

// touch controls (phones / tablets): on-screen stick and hold buttons through the same input path
const touch = new TouchControls(app, game, {
  pause() {
    if (game.inMenu) return;
    game.paused = true;
    menu.showPause(true);
  },
});
(window as any).__touch = touch;
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
    const d = document.documentElement as any;
    const p = d.requestFullscreen?.({ navigationUI: 'hide' }) ?? d.webkitRequestFullscreen?.();
    if (p && typeof p.catch === 'function') p.catch(() => {});
  } catch {
    /* not allowed here */
  }
  try {
    const o = (screen as any).orientation;
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
  else (game.paused = true), menu.showPause(true);
});
window.addEventListener('pointerdown', () => game.fx.audio.unlock(), { once: false });
window.addEventListener('keydown', () => game.fx.audio.unlock());
app.addEventListener('mousedown', () => {
  if (!game.inMenu && !game.paused && !game.input.pointerLocked && !game.input.dragLook) game.input.requestLock();
});

// URL params for automation / quick start: ?mode=spike&pos=OH&bot=perfect&cam=fp
const q = new URLSearchParams(location.search);
enterMenu();
if (q.get('mode')) {
  const mode = q.get('mode') as ModeId;
  const pos = (q.get('pos') || 'OH') as PositionId;
  if (q.get('cam')) settings.firstPerson = q.get('cam') === 'fp';
  menu.showStart(false);
  lastPlay = { mode, pos };
  game.startMode(mode, pos);
  game.hud.setVisible(true);
  if (q.get('bot')) game.enableBot(q.get('bot') as string);
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
