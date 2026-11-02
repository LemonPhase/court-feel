import './ui/styles.css';
import { loadSettings, saveSettings } from './core/settings';
import { Game } from './game/game';
import { Menu } from './ui/menu';
import type { ModeId } from './game/modes/mode';
import type { PositionId } from './config';

const app = document.getElementById('app')!;
const settings = loadSettings();
const game = new Game(app, settings);
(window as any).__court = game;

let lastPlay: { mode: ModeId; pos: PositionId } = { mode: 'spike', pos: 'OH' };

const menu = new Menu(app, settings, {
  play(mode, pos) {
    game.fx.audio.unlock();
    lastPlay = { mode, pos };
    menu.showStart(false);
    game.startMode(mode, pos);
    game.paused = false;
    game.hud.setVisible(true);
    game.input.requestLock();
  },
  resume() {
    menu.showPause(false);
    game.paused = false;
    game.input.clearEdges();
    game.input.requestLock();
  },
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
  },
});
(window as any).__menu = menu;

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
    game.paused = true;
    menu.showPause(true);
  }
};
window.addEventListener('keydown', (e) => {
  if (e.code !== 'Escape' || game.inMenu) return;
  // with pointer lock the browser consumes Esc and fires pointerlockchange instead
  if (game.input.dragLook || !game.input.pointerLocked) {
    if (menu.pauseVisible) menu.showPause(false), (game.paused = false);
    else (game.paused = true), menu.showPause(true);
  }
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
