import './ui/styles.css';
import { BUILD_ID } from './core/build';
import { ErrorReporter, type ErrorReport } from './core/errors';
import { parseLaunchParams } from './core/launch';
import { loadSettings, saveSettings } from './core/settings';
import { Game } from './game/game';
import { Menu } from './ui/menu';
import type { ModeId } from './game/modes/mode';
import type { PositionId } from './config';
import type { RankedPlay } from './game/boards';
import { showCrashScreen } from './ui/crashScreen';
import { ResultsScreen } from './ui/results';
import { LeaderboardScreen } from './ui/leaderboard';
import { shareText } from './ui/share';
import {
  fetchBoard,
  fetchMedals,
  keepPending,
  loadPlayer,
  newId,
  pendingRuns,
  sendPending,
  setPlayerName,
  submitRun,
  toSubmission,
  type Player,
} from './net/client';
import type { RunSubmission, SubmitResult } from './net/protocol';
import type { RankedRun } from './game/ranked';
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
  if (fatal) {
    // the game is over: silence it (the crowd bed loops forever) and stay silent
    game.fx.audio.shutdown();
    crashScreen(r);
  }
};

let lastPlay: { mode: ModeId; pos: PositionId; ranked: RankedPlay | null } = { mode: 'spike', pos: 'OH', ranked: null };

// Once the game has stopped (crash screen), every handler below leaves input alone: a pause menu or a
// pointer lock on a dead game would hide the crash screen's buttons or take the mouse away from them.

function resume(): void {
  if (game.stopped) return;
  menu.showPause(false);
  game.paused = false;
  game.input.clearEdges();
  game.input.requestLock();
}

const menu = new Menu(app, settings, {
  play(mode, pos, ranked) {
    if (game.stopped) return;
    game.fx.audio.unlock();
    lastPlay = { mode, pos, ranked };
    menu.showStart(false);
    game.startMode(mode, pos, ranked);
    // the key that pressed PLAY (Space, Enter) must not also act in the drill
    game.input.clearEdges();
    game.paused = false;
    game.hud.setVisible(true);
    game.input.requestLock();
    if (touch.enabled) goFullscreen();
  },
  resume,
  leaderboard() {
    if (game.stopped) return;
    leaderboard.show({ mode: menu.mode, pos: menu.pos });
  },
  restart() {
    if (game.stopped) return;
    menu.showPause(false);
    game.startMode(lastPlay.mode, lastPlay.pos, lastPlay.ranked);
    game.input.clearEdges();
    game.paused = false;
    game.input.requestLock();
  },
  quit() {
    if (game.stopped) return;
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

// the end of a ranked run: the game has paused itself; the mouse is freed for the results screen
let finished: RankedRun | null = null;
/** the finished run as sent to the leaderboard (made once: a retry sends the same submission) */
let sent: RunSubmission | null = null;
/** the online leaderboard's answer for the finished run (its place goes into the share text) */
let placed: SubmitResult | null = null;
const results = new ResultsScreen(app, {
  again: () => playAgain(lastPlay.ranked ?? 'season'),
  practice: () => playAgain(null),
  menu() {
    if (game.stopped) return;
    results.hide();
    game.stopMode();
    enterMenu();
  },
  leaderboard() {
    if (finished) leaderboard.show({ tab: finished.week ? 'weekly' : 'season', mode: finished.mode, pos: finished.pos });
  },
  submitName(name) {
    const p = setPlayerName(name);
    if (!p) results.setOnline({ kind: 'name', error: 'A name is 2 to 16 letters or digits (spaces, dots and dashes are fine)' });
    else if (finished) void putOnBoard(finished, p);
  },
  retry() {
    if (sent) void send(sent);
  },
  shareText: () =>
    finished
      ? shareText(finished, {
          link: location.origin + location.pathname,
          place: placed ? { rank: placed.me.rank, count: placed.count } : null,
        })
      : '',
});
game.events.on('rankedDone', (run) => {
  menu.showPause(false);
  game.input.exitLock();
  finished = run;
  sent = null;
  placed = null;
  results.show(run);
  // unranked and autopilot runs stay off the leaderboard; your first run asks for your name
  if (run.unranked) results.setOnline({ kind: 'skipped', why: "Unranked runs don't go on the leaderboard." });
  else if (game.bot) results.setOnline({ kind: 'skipped', why: "Autopilot runs don't go on the leaderboard." });
  else {
    const p = loadPlayer();
    if (p.name) void putOnBoard(run, p);
    else results.setOnline({ kind: 'name' });
  }
});

/** a finished run goes on the online leaderboard: it is kept on this device until the leaderboard has it */
function putOnBoard(run: RankedRun, p: Player): Promise<void> {
  const how = { cam: settings.firstPerson ? 'fp' : 'tp', input: touch.enabled ? 'touch' : 'mouse', hand: settings.hand } as const;
  sent = toSubmission(run, p, how, newId());
  keepPending(sent);
  return send(sent);
}

/** send (or send again) the finished run and show where it landed, or why it didn't */
async function send(s: RunSubmission): Promise<void> {
  results.setOnline({ kind: 'sending' });
  const r = await submitRun(s);
  // moved on to something else meanwhile
  if (sent !== s || !results.visible) return;
  if (r.kind === 'ok') {
    placed = r.result;
    results.setOnline({ kind: 'done', result: r.result });
  } else results.setOnline(r);
}

// the online boards (from the start screen or the results screen, over either)
const leaderboard = new LeaderboardScreen(app, {
  close: () => leaderboard.hide(),
  fetchBoard: (board) => fetchBoard(board, loadPlayer().id),
  fetchMedals: () => fetchMedals(),
  pending: () => pendingRuns().length,
  sendPending: () => sendPending(),
  name: () => loadPlayer().name,
  rename: (name) => setPlayerName(name)?.name ?? null,
});

/** from the results screen: the same drill again, ranked or in practice */
function playAgain(ranked: RankedPlay | null): void {
  if (game.stopped) return;
  results.hide();
  leaderboard.hide();
  lastPlay = { ...lastPlay, ranked };
  game.startMode(lastPlay.mode, lastPlay.pos, ranked);
  game.input.clearEdges();
  game.paused = false;
  game.input.requestLock();
}

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
  results.hide();
  leaderboard.hide();
  game.inMenu = true;
  game.paused = false;
  game.rig.setMode('menu');
  game.hud.setVisible(false);
  menu.showStart(true);
  game.input.exitLock();
  game.startAttract();
}

game.input.onPointerLockChange = (locked) => {
  if (!locked && !game.inMenu && !game.input.dragLook && !game.stopped && !results.visible && !leaderboard.visible) {
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
  if (fallback || game.inMenu || game.stopped) return;
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
  if (document.hidden && !game.inMenu && !game.paused && !game.stopped) {
    game.paused = true;
    menu.showPause(true);
  }
});
window.addEventListener('keydown', (e) => {
  if (e.code !== 'Escape' || e.repeat || game.inMenu || game.stopped || results.visible || leaderboard.visible) return;
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
  if (!game.inMenu && !game.paused && !game.stopped && !game.input.pointerLocked && !game.input.dragLook) game.input.requestLock();
});

// quick-start links for automation and sharing a drill: ?mode=spike&pos=OH&bot=perfect&cam=fp&hand=left
enterMenu();
const launch = parseLaunchParams(location.search);
if (launch) {
  if (launch.cam) settings.firstPerson = launch.cam === 'fp';
  if (launch.hand) {
    settings.hand = launch.hand;
    game.applyUserBody();
  }
  menu.showStart(false);
  menu.selectPos(launch.pos);
  lastPlay = { mode: launch.mode, pos: launch.pos, ranked: launch.ranked };
  game.startMode(launch.mode, launch.pos, launch.ranked);
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
