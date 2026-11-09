#!/usr/bin/env node
// verify-court-feel: launch Court Feel and drive it the way a player does, one command at a time.
//
//   court.mjs launch [--touch]      start a Vite dev server + headless Chromium for this checkout
//   court.mjs doctor                read-only: is this session worth driving?
//   court.mjs open '?mode=spike'    load the app (see `court.mjs help` for every command)
//   court.mjs stop                  tear down what `launch` started; evidence stays
//
// One session per checkout (COURT_SESSION=<name> for a second one). `launch` starts a small
// supervisor process that owns the dev server and the browser and answers commands on a
// loopback port, so the page, its game state and the console log survive between commands.
// Scratch state: shots/verify/.sessions/<session>/   Evidence: shots/verify/<stamp>-<session>/
import { execFileSync, spawn } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import net from 'node:net';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const SELF = fileURLToPath(import.meta.url);
const ROOT = path.resolve(path.dirname(SELF), '../../..');
const SESSION = process.env.COURT_SESSION || 'default';
const VERIFY_DIR = path.join(ROOT, 'shots', 'verify');
const SESSION_DIR = path.join(VERIFY_DIR, '.sessions', SESSION);
const STATE_FILE = path.join(SESSION_DIR, 'state.json');
const rel = (p) => path.relative(ROOT, p) || '.';
/** the checkout as /proc reports a working directory (symlinks resolved) */
const REAL_ROOT = (() => {
  try {
    return fs.realpathSync(ROOT);
  } catch {
    return ROOT;
  }
})();

const HELP = `court.mjs <command> — drive Court Feel in headless Chromium (session "${SESSION}")

Lifecycle
  launch [--touch]            start the dev server and the browser, load the start screen.
                              --touch: a phone (844x390, touch screen) instead of a 1280x720 desktop
  doctor                      read-only health check (exit 0 = worth driving)
  stop                        stop what launch started and remove scratch state; evidence stays

Loading the app
  open [query] [--fresh] [--manual]
                              load the app, e.g. open '?mode=spike&pos=OH&bot=perfect'.
                              --fresh: clear saved settings first (a first visit)
                              --manual: manual clock from the first frame (repeatable runs)

Real input (DOM events, the path a player's hardware takes)
  click <selector>            mouse click (Playwright selector: css, text=, role=button[name="PLAY"])
  dblclick <selector>         mouse double-click
  key <Key>                   press and release (Enter, Escape, Space, Tab, F3, v, 1, Shift, ArrowRight ...)
  keydown <Key> / keyup <Key> hold and release separately (Space to load a jump, Shift+w to approach)
  mouse <down|up> [left|right]  attack / block buttons
  look <dx> <dy>              move the mouse by pixels while the game holds the pointer (aim)
  esc                         the Esc key as Chrome handles it (releases the pointer, which pauses)
  set <selector> <value>      set a slider (settings) and fire its input event
  tap <selector>              touch tap on a menu control (launch --touch)
  touch <start|move|end> <id> [<x> <y> | <selector>]
                              one finger of several (launch --touch): the stick, aim, the hold buttons.
                              A selector means the middle of that element: touch start 2 .t-jump

Time
  clock <manual|real>         manual: the game only advances with step (repeatable, machine-independent)
  step <seconds> [--until <js>]   advance the manual clock; with --until stop as soon as <js> is true
  wait <js> [--timeout ms]    real clock: wait until <js> is true (default 30000 ms)

Observation
  state                       screen, HUD text, menu selection, game state, saved settings (JSON)
  events [--clear]            contacts, outcomes and setter calls recorded since the page loaded
  errors [--clear]            console errors / warnings / page errors since the page loaded (exit 1 if any)
  shot <name>                 screenshot into the evidence directory
  eval <js>                   evaluate JS in the page and print the result (reading; g = window.__court)

Test hooks (say so in the proof when you use them)
  bot <perfect|good|sloppy|tip|off>   autopilot on the player's inputs (same as &bot= in a link)

In <js>, g is window.__court (the running Game). Every command is logged with the state it left
behind in the evidence directory (actions.jsonl); console output goes to console.jsonl.`;

// ---------------------------------------------------------------- small utilities
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const readState = () => {
  try {
    return JSON.parse(fs.readFileSync(STATE_FILE, 'utf8'));
  } catch {
    return null;
  }
};
const alive = (pid) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return e.code === 'EPERM';
  }
};
/** working directory of a process (Linux only; null where /proc is missing) */
const cwdOf = (pid) => {
  try {
    return fs.readlinkSync(`/proc/${pid}/cwd`);
  } catch {
    return null;
  }
};
/**
 * When a process started, as an opaque string: clock ticks since boot from /proc, or the start date from ps
 * where there is no /proc (macOS). A pid is reused after a reboot or a long uptime; a pid with its start time is not.
 */
const startOf = (pid) => {
  try {
    const stat = fs.readFileSync(`/proc/${pid}/stat`, 'utf8');
    // the fields after "(command name)": the 20th of them is the start time
    const ticks = stat.slice(stat.lastIndexOf(')') + 2).split(' ')[19];
    if (ticks) return 'ticks:' + ticks;
  } catch {
    /* no /proc here, or the process is gone */
  }
  try {
    const s = execFileSync('ps', ['-o', 'lstart=', '-p', String(pid)], { stdio: ['ignore', 'pipe', 'ignore'] })
      .toString()
      .trim();
    return s ? 'ps:' + s : null;
  } catch {
    return null;
  }
};
/** a process we recorded ({ pid, start }) that is still that same process, not a later one that got its pid */
const ours = (proc) => !!proc?.pid && !!proc.start && alive(proc.pid) && startOf(proc.pid) === proc.start;
const supervisorOf = (st) => ({ pid: st.pid, start: st.pidStart });
const viteOf = (st) => ({ pid: st.vitePid, start: st.viteStart });
/** each launch writes its token here; whoever wrote last owns the session (a supervisor that lost it exits) */
const OWNER_FILE = path.join(SESSION_DIR, 'owner');
const owns = (token) => {
  try {
    return fs.readFileSync(OWNER_FILE, 'utf8') === token;
  } catch {
    return false;
  }
};
/** reject with `what` if `p` has not settled after `ms` */
const withTimeout = (p, ms, what) => {
  let t;
  return Promise.race([p, new Promise((_, rej) => (t = setTimeout(() => rej(new Error(what)), ms)))]).finally(() => clearTimeout(t));
};
const git = (...args) => {
  try {
    return execFileSync('git', args, { cwd: ROOT, stdio: ['ignore', 'pipe', 'ignore'] })
      .toString()
      .trim();
  } catch {
    return null;
  }
};
const freePort = () =>
  new Promise((res, rej) => {
    const s = net.createServer();
    s.once('error', rej);
    s.listen(0, '127.0.0.1', () => {
      const { port } = s.address();
      s.close(() => res(port));
    });
  });
const httpGet = (url, timeout = 3000) =>
  new Promise((res) => {
    const req = http.get(url, { timeout }, (r) => {
      let body = '';
      r.on('data', (d) => (body += d));
      r.on('end', () => res({ status: r.statusCode, body }));
    });
    req.on('timeout', () => req.destroy());
    req.on('error', () => res({ status: 0, body: '' }));
  });
const stamp = () => {
  const d = new Date();
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
};
const fail = (msg) => {
  console.error(msg);
  process.exit(1);
};

/** positional arguments and --flags (a flag takes the next word unless it is one of the switches) */
const SWITCHES = new Set(['fresh', 'manual', 'touch', 'clear']);
function parseArgs(argv) {
  const args = [];
  const flags = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith('--') && a.length > 2) {
      const k = a.slice(2);
      flags[k] = SWITCHES.has(k) ? true : argv[++i];
    } else args.push(a);
  }
  return { args, flags };
}

// ---------------------------------------------------------------- code that runs inside the page
/**
 * Installed in every document before the app's own scripts.
 * 1. Headless Chromium has no real pointer device: while the game holds the pointer (pointer lock) a
 *    trusted mousemove reports the cursor's absolute position as its movement, then the same amount
 *    back. Those are dropped here; `look` sends the relative movement a real mouse would.
 * 2. When the app publishes the game (window.__court), record contacts, outcomes and setter calls
 *    (read-only listeners), and start on the manual clock if `open --manual` asked for it.
 */
const INIT_SCRIPT = `(() => {
  window.addEventListener('mousemove', (e) => {
    if (e.isTrusted && document.pointerLockElement) e.stopImmediatePropagation();
  }, true);
  const rec = (window.__verify = { events: [] });
  let game;
  Object.defineProperty(window, '__court', {
    configurable: true,
    get: () => game,
    set: (g) => {
      game = g;
      try {
        if (window.__verifyManual) g.manual = true;
        const who = (a) => (a.isUser ? 'me' : a.role + (a.side === 1 ? ' (home)' : ' (away)'));
        const t = () => +g.simTime.toFixed(3);
        g.events.on('contact', (e) => rec.events.push({ t: t(), type: 'contact', who: who(e.athlete), kind: e.kind, grade: e.grade,
          kmh: Math.round(e.speed * 3.6), note: e.note || undefined, tip: e.tip || undefined,
          power: e.power === undefined ? undefined : +e.power.toFixed(2) }));
        g.events.on('aiContact', (e) => rec.events.push({ t: t(), type: 'aiContact', who: who(e.athlete), kind: e.kind, kmh: Math.round(e.speed * 3.6) }));
        g.events.on('outcome', (o) => rec.events.push({ t: t(), type: 'outcome', kind: o.kind, side: o.side === 1 ? 'home' : 'away',
          winner: o.winner === 1 ? 'home' : 'away', netTouch: o.netTouch || undefined }));
        g.events.on('setterCall', (c) => rec.events.push({ t: t(), type: 'setterCall', who: who(c.athlete), call: c.call }));
      } catch (err) {
        rec.error = String(err);
      }
    },
  });
})();`;

/** everything a proof usually needs to read, in one object (runs in the page; reads only) */
function snapshot() {
  const g = window.__court;
  const q = (s) => document.querySelector(s);
  const txt = (s) => {
    const e = q(s);
    return e ? e.textContent.trim().replace(/\s+/g, ' ') : null;
  };
  const shown = (s) => !!q(s)?.classList.contains('show');
  const disp = (s) => {
    const e = q(s);
    return !!e && getComputedStyle(e).display !== 'none';
  };
  const stored = (k) => {
    try {
      return JSON.parse(localStorage.getItem(k));
    } catch {
      return null;
    }
  };
  const r2 = (n) => +n.toFixed(2);
  const crash = q('.crash');
  const screen = crash
    ? 'crash'
    : !g
      ? 'loading'
      : disp('.settings')
        ? 'settings'
        : disp('.pause')
          ? 'paused'
          : disp('.menu')
            ? 'start'
            : g.fx.replaying
              ? 'replay'
              : 'play';
  const out = { screen, url: location.pathname + location.search, build: txt('.build') };
  if (crash) out.crash = { title: txt('#crash-title'), body: txt('#crash-body'), details: q('.crash-details')?.value ?? null };
  if (q('.ctx-lost')) out.contextLost = true;
  if (!g) return out;
  out.start = disp('.menu')
    ? {
        position: txt('.pos-card[aria-pressed="true"] .pos-short'),
        drill: txt('.mode-card[aria-pressed="true"] .mode-t'),
        camera: txt('.cam-sel .chip[aria-pressed="true"]'),
      }
    : null;
  out.settingsPanel = disp('.settings')
    ? {
        rows: Object.fromEntries(
          [...document.querySelectorAll('.settings .set-row')].map((r) => [
            r.querySelector('.set-l')?.textContent ?? '?',
            (r.querySelector('.set-val') ?? r.querySelector('.chip'))?.textContent ?? null,
          ]),
        ),
        athleteTab: txt('.body-tab.on'),
        athlete: q('.body-sum')?.innerText.replace(/\s+/g, ' ') ?? null,
      }
    : null;
  out.hud = disp('.hud')
    ? {
        title: txt('.hud-title'),
        score: txt('.hud-score'),
        camera: txt('.hud-cam'),
        lastBallKmh: txt('.hud-speed-val'),
        streak: txt('.hud-streak-val'),
        hint: txt('.hud-hint'),
        grade: shown('.hud-grade') ? { text: txt('.hud-grade-text'), sub: txt('.hud-grade-sub') } : null,
        banner: shown('.hud-banner') ? txt('.hud-banner') : null,
        message: shown('.hud-msg') ? txt('.hud-msg') : null,
        call: shown('.callout') ? { who: txt('.callout-who'), word: txt('.callout-word'), sub: txt('.callout-sub') } : null,
      }
    : null;
  const m = g.mode;
  out.game = {
    mode: m ? g.modeId : null,
    position: g.position,
    inMenu: g.inMenu,
    paused: g.paused,
    stopped: g.stopped,
    replaying: g.fx.replaying,
    clock: g.manual ? 'manual' : 'real',
    simTime: +g.simTime.toFixed(3),
    camera: g.rig.mode,
    yaw: r2(g.rig.yaw),
    pitch: r2(g.rig.pitch),
    pointerLocked: g.input.pointerLocked,
    dragLook: g.input.dragLook,
    held: [...g.input.held],
    stick: g.input.stick.active ? { x: r2(g.input.stick.x), y: r2(g.input.stick.y), sprint: g.input.stick.sprint } : null,
    touchControls: !!window.__touch?.enabled,
    hand: g.settings.hand,
    autopilot: !!g.bot,
    netTop: g.env.netTop,
    score: m ? { points: m.score, reps: m.reps, streak: m.streak, home: m.scoreHome, away: m.scoreAway } : null,
    me: {
      role: g.me.role,
      state: g.me.state,
      action: g.me.action?.kind ?? null,
      x: r2(g.me.pos.x),
      y: r2(g.me.pos.y),
      z: r2(g.me.pos.z),
    },
    ball: g.ball.active ? { x: r2(g.ball.state.p.x), y: r2(g.ball.state.p.y), z: r2(g.ball.state.p.z) } : null,
    athletes: g.athletes.length,
  };
  out.saved = { settings: stored('courtfeel.settings.v1'), menu: stored('courtfeel.menu') };
  out.recorded = { events: window.__verify?.events.length ?? null };
  return out;
}

/** the few lines of a snapshot that say where the app is now (printed after every action) */
function digest(s) {
  const d = { screen: s.screen };
  if (s.crash) d.crash = s.crash.title;
  if (s.start) d.start = s.start;
  if (s.hud) {
    d.title = s.hud.title;
    d.score = s.hud.score;
    for (const k of ['grade', 'banner', 'message', 'call']) if (s.hud[k]) d[k] = s.hud[k];
  }
  if (s.game) {
    d.clock = s.game.clock;
    d.simTime = s.game.simTime;
  }
  return d;
}

// ---------------------------------------------------------------- the supervisor (started by launch)
async function supervisor() {
  const opts = JSON.parse(process.env.COURT_SUPERVISOR);
  const log = (...a) => console.log(new Date().toISOString(), ...a);
  const evidence = opts.evidence;
  const actionsFile = path.join(evidence, 'actions.jsonl');
  const consoleFile = path.join(evidence, 'console.jsonl');
  let vite = null;
  let context = null;
  let server = null;
  let closing = false;
  const shutdown = async (code) => {
    if (closing) return;
    closing = true;
    log('shutting down');
    try {
      // a stuck page can keep close() waiting: leaving the process ends the browser anyway
      await withTimeout(Promise.resolve(context?.close()), 5000, 'the browser did not close within 5 s');
    } catch (e) {
      log('browser close:', String(e));
    }
    if (vite && vite.exitCode === null) vite.kill('SIGTERM');
    server?.close();
    // give the dev server a moment to go, then leave regardless
    for (let i = 0; i < 30 && vite && vite.exitCode === null && vite.signalCode === null; i++) await sleep(100);
    process.exit(code);
  };
  process.on('SIGTERM', () => shutdown(0));
  process.on('SIGINT', () => shutdown(0));
  // The session record is the only way anyone can find and stop this process. If it is gone (deleted, or a
  // later launch took the session over), leave: a supervisor nobody can reach must not keep running.
  setInterval(() => {
    if (!closing && !owns(opts.token)) {
      log('the session record is gone or belongs to a later launch: exiting');
      shutdown(1);
    }
  }, 2000);

  try {
    // 1. the dev server: this checkout's sources, loopback only, a port nobody else has
    const vitePort = await freePort();
    const base = `http://127.0.0.1:${vitePort}/`;
    const viteLog = fs.openSync(path.join(SESSION_DIR, 'vite.log'), 'a');
    vite = spawn(
      process.execPath,
      [path.join(ROOT, 'node_modules', 'vite', 'bin', 'vite.js'), '--port', String(vitePort), '--strictPort', '--host', '127.0.0.1'],
      { cwd: ROOT, stdio: ['ignore', viteLog, viteLog] },
    );
    vite.on('exit', (code, sig) => {
      log(`vite exited (code ${code}, signal ${sig})`);
      if (!closing) shutdown(1);
    });
    let up = false;
    for (let i = 0; i < 150 && !up; i++) {
      const r = await httpGet(base, 1000);
      up = r.status === 200 && r.body.includes('<title>Court Feel</title>');
      if (!up) await sleep(200);
    }
    if (!up) throw new Error(`the dev server did not answer on ${base} within 30 s (see vite.log)`);
    const main = await httpGet(base + 'src/main.ts', 20000);
    if (main.status !== 200) throw new Error(`the dev server answers but cannot serve src/main.ts (HTTP ${main.status}; see vite.log)`);
    log('vite ready on', base);

    // 2. the browser: the same Chromium and GPU flags as scripts/e2e.mjs (software WebGL)
    const { chromium } = await import('playwright');
    context = await chromium.launchPersistentContext(path.join(SESSION_DIR, 'profile'), {
      headless: true,
      viewport: opts.touch ? { width: 844, height: 390 } : { width: 1280, height: 720 },
      ...(opts.touch ? { deviceScaleFactor: 2, isMobile: true, hasTouch: true } : {}),
      args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'],
    });
    await context.addInitScript(INIT_SCRIPT);
    const page = context.pages()[0] ?? (await context.newPage());
    const cdp = await context.newCDPSession(page);
    // scripts added over this session (open --manual) only run once its Page domain is enabled
    await cdp.send('Page.enable');
    log('browser ready');

    // console and page errors, kept for the whole session (and counted per page load)
    let consoleEntries = [];
    let loads = 0;
    let opens = 0;
    let loadsAtOpen = 0;
    const note = (type, text) => {
      const e = { at: new Date().toISOString(), type, text };
      fs.appendFileSync(consoleFile, JSON.stringify(e) + '\n');
      if (type === 'error' || type === 'warning' || type === 'pageerror') consoleEntries.push(e);
    };
    page.on('console', (m) => note(m.type(), m.text()));
    page.on('pageerror', (e) => note('pageerror', e.message));
    page.on('load', () => {
      loads++;
      fs.appendFileSync(consoleFile, JSON.stringify({ at: new Date().toISOString(), type: 'load', text: page.url() }) + '\n');
    });

    const snap = () => page.evaluate(snapshot);
    const inPage = (js) => `(() => { const g = window.__court; return (${js}); })()`;
    const needGame = async () => {
      if (!(await page.evaluate(() => !!window.__court && !document.querySelector('.crash'))))
        throw new Error('the game is not running on this page (run `open` first; `state` shows a crash screen if there is one)');
    };
    const clockIs = () => page.evaluate(() => (window.__court.manual ? 'manual' : 'real'));
    const touches = new Map();
    let shots = 0;
    /** the command being run right now (doctor reports it when it has been running for long) */
    let running = null;

    const cmds = {
      async ping() {
        return { session: SESSION, pid: process.pid, root: ROOT, base, vitePid: vite.pid, viteAlive: vite.exitCode === null };
      },
      async health() {
        let page_;
        try {
          page_ = await withTimeout(snap(), 5000, 'the page did not answer within 5 s (it is busy or stuck)');
        } catch (e) {
          page_ = { error: String(e).split('\n')[0] };
        }
        return {
          ...(await cmds.ping()),
          pageUrl: page.url(),
          page: page_,
          consoleProblems: consoleEntries.length,
          busy: running ? { cmd: running.cmd, seconds: Math.round((Date.now() - running.since) / 1000) } : null,
          opens,
          reloadedSinceOpen: loads > loadsAtOpen,
        };
      },
      async open([query = ''], flags) {
        const url = base + (query && !query.startsWith('?') ? '?' + query : query);
        if (flags.fresh) await cdp.send('Storage.clearDataForOrigin', { origin: new URL(base).origin, storageTypes: 'local_storage' });
        let manualScript = null;
        if (flags.manual)
          manualScript = (await cdp.send('Page.addScriptToEvaluateOnNewDocument', { source: 'window.__verifyManual = true;' })).identifier;
        consoleEntries = [];
        touches.clear();
        try {
          await page.goto(url, { waitUntil: 'load', timeout: 30000 });
        } finally {
          if (manualScript) await cdp.send('Page.removeScriptToEvaluateOnNewDocument', { identifier: manualScript });
        }
        // ready = the game and the menus exist, or the app has put up its crash screen
        await page.waitForFunction(() => (window.__court && window.__menu) || document.querySelector('.crash'), null, {
          timeout: 60000,
          polling: 100,
        });
        // the first frames compile every shader (seconds on a software GPU): wait until frames are flowing
        await page.evaluate(
          () =>
            new Promise((res) => {
              let n = 0;
              const f = () => (++n >= 3 ? res() : requestAnimationFrame(f));
              requestAnimationFrame(f);
            }),
        );
        if (flags.manual) await page.evaluate(() => window.__court && (window.__court.holdRender = true));
        opens++;
        loadsAtOpen = loads;
        return { opened: url };
      },
      async click([selector]) {
        if (!selector) throw new Error('usage: click <selector>');
        await page.locator(selector).click({ timeout: 10000 });
        return { clicked: selector };
      },
      async dblclick([selector]) {
        if (!selector) throw new Error('usage: dblclick <selector>');
        await page.locator(selector).dblclick({ timeout: 10000 });
        return { doubleClicked: selector };
      },
      async tap([selector]) {
        if (!opts.touch) throw new Error('tap needs a touch session: stop, then launch --touch');
        if (!selector) throw new Error('usage: tap <selector>');
        await page.locator(selector).tap({ timeout: 10000 });
        return { tapped: selector };
      },
      async touch([type, id, x, y]) {
        if (!opts.touch) throw new Error('touch needs a touch session: stop, then launch --touch');
        const n = Number(id);
        if (!['start', 'move', 'end'].includes(type) || !Number.isInteger(n))
          throw new Error('usage: touch <start|move|end> <id> [<x> <y> | <selector>]');
        let points;
        if (type === 'end') {
          const p = touches.get(n);
          if (!p) throw new Error(`touch ${n} is not down`);
          touches.delete(n);
          points = [{ x: p.x, y: p.y, id: n }];
        } else {
          if (type === 'move' && !touches.has(n)) throw new Error(`touch ${n} is not down`);
          let at = { x: Number(x), y: Number(y) };
          if (x !== undefined && y === undefined && !Number.isFinite(at.x)) {
            // a selector instead of coordinates: the middle of that element (the pad's buttons take no pointer events themselves)
            const box = await page.locator(x).boundingBox({ timeout: 10000 });
            if (!box) throw new Error(`${x} is not visible`);
            at = { x: Math.round(box.x + box.width / 2), y: Math.round(box.y + box.height / 2) };
          }
          if (!Number.isFinite(at.x) || !Number.isFinite(at.y)) throw new Error(`touch ${type} needs <x> <y> or a selector`);
          touches.set(n, at);
          points = [...touches.entries()].map(([i, p]) => ({ x: p.x, y: p.y, id: i }));
        }
        await cdp.send('Input.dispatchTouchEvent', {
          type: { start: 'touchStart', move: 'touchMove', end: 'touchEnd' }[type],
          touchPoints: points,
        });
        return { touch: type, id: n, at: points.find((p) => p.id === n), down: [...touches.keys()] };
      },
      async key([key]) {
        if (!key) throw new Error('usage: key <Key>');
        await page.keyboard.press(key);
        return { pressed: key };
      },
      async keydown([key]) {
        if (!key) throw new Error('usage: keydown <Key>');
        await page.keyboard.down(key);
        return { down: key };
      },
      async keyup([key]) {
        if (!key) throw new Error('usage: keyup <Key>');
        await page.keyboard.up(key);
        return { up: key };
      },
      async mouse([action, button = 'left']) {
        if (!['down', 'up'].includes(action) || !['left', 'right'].includes(button)) throw new Error('usage: mouse <down|up> [left|right]');
        // over the middle of the court (the canvas takes the buttons; while it holds the pointer the position is irrelevant)
        const vp = page.viewportSize();
        if (action === 'down') await page.mouse.move(vp.width / 2, vp.height / 2);
        await page.mouse[action]({ button });
        return { mouse: action, button };
      },
      async look([dx, dy = '0']) {
        const x = Number(dx);
        const y = Number(dy);
        if (!Number.isFinite(x) || !Number.isFinite(y)) throw new Error('usage: look <dx> <dy> (pixels; right and down are positive)');
        const ok = await page.evaluate(
          ([mx, my]) => {
            if (!document.pointerLockElement) return false;
            window.dispatchEvent(new MouseEvent('mousemove', { movementX: mx, movementY: my, bubbles: true }));
            return true;
          },
          [x, y],
        );
        if (!ok) throw new Error('the game does not hold the pointer: look only works in play (after PLAY or RESUME), not in menus');
        return { looked: [x, y] };
      },
      async esc() {
        // Chrome takes Esc for itself while a page holds the pointer: it releases the pointer and the page
        // sees pointerlockchange, not a key. Headless Chromium has no such handling, so do what Chrome does.
        const locked = await page.evaluate(() => {
          if (!document.pointerLockElement) return false;
          document.exitPointerLock();
          return true;
        });
        if (!locked) await page.keyboard.press('Escape');
        else await page.waitForFunction(() => !document.pointerLockElement, null, { timeout: 5000 });
        return { esc: locked ? 'released the pointer (what Chrome does with Esc in play)' : 'Escape key' };
      },
      async set([selector, value]) {
        if (!selector || value === undefined) throw new Error('usage: set <selector> <value>');
        await page.locator(selector).fill(String(value), { timeout: 10000 });
        return { set: selector, value: await page.locator(selector).inputValue() };
      },
      async clock([mode]) {
        if (mode !== 'manual' && mode !== 'real') throw new Error('usage: clock <manual|real>');
        await needGame();
        await page.evaluate((manual) => {
          const g = window.__court;
          g.manual = manual;
          g.holdRender = manual;
        }, mode === 'manual');
        return { clock: mode };
      },
      async step([seconds], flags) {
        const sec = Number(seconds);
        if (!(sec > 0) || sec > 600) throw new Error('usage: step <seconds> [--until <js>] (0 < seconds <= 600)');
        await needGame();
        if ((await clockIs()) !== 'manual')
          throw new Error('the clock is real: run `clock manual` first (or `wait <js>` on the real clock)');
        const r = await page.evaluate(
          ([max, until]) => {
            const g = window.__court;
            const test = until ? new Function('g', `return (${until});`) : null;
            const n = Math.round(max * 60);
            for (let i = 1; i <= n; i++) {
              g.play(1 / 60);
              if (test && test(g)) return { steppedSeconds: +(i / 60).toFixed(3), reached: true };
            }
            return { steppedSeconds: +(n / 60).toFixed(3), ...(test ? { reached: false } : {}) };
          },
          [sec, flags.until ?? null],
        );
        if (r.reached === false)
          throw Object.assign(new Error(`--until was still false after ${r.steppedSeconds} s: ${flags.until}`), { result: r });
        return r;
      },
      async wait([js], flags) {
        if (!js) throw new Error('usage: wait <js> [--timeout ms]');
        await needGame();
        if ((await clockIs()) === 'manual')
          throw new Error('the clock is manual, nothing changes while you wait: use `step <seconds> --until <js>`');
        const t0 = Date.now();
        await page.waitForFunction(inPage(js), null, { timeout: Number(flags.timeout ?? 30000), polling: 100 });
        return { waitedMs: Date.now() - t0 };
      },
      async bot([quality]) {
        await needGame();
        if (quality === 'off') {
          await page.evaluate(() => {
            window.__court.bot = null;
            window.__court.input.releaseAll();
          });
        } else if (['perfect', 'good', 'sloppy', 'tip'].includes(quality)) {
          if (await page.evaluate(() => window.__court.inMenu))
            throw new Error('start a drill first: the autopilot plays the drill that is running');
          await page.evaluate((q) => window.__court.enableBot(q), quality);
        } else throw new Error('usage: bot <perfect|good|sloppy|tip|off>');
        return { bot: quality, hook: 'window.__court.enableBot (same as &bot= in a quick-start link)' };
      },
      async state() {
        return await snap();
      },
      async events(_a, flags) {
        const ev = await page.evaluate((clear) => {
          const r = window.__verify;
          if (!r) return null;
          const e = r.events.slice();
          if (clear) r.events.length = 0;
          return { events: e, recorderError: r.error };
        }, !!flags.clear);
        if (!ev) throw new Error('no recorder on this page (run `open` first)');
        return ev;
      },
      async errors(_a, flags) {
        const r = { count: consoleEntries.length, entries: consoleEntries.slice() };
        if (flags.clear) consoleEntries = [];
        return r;
      },
      async eval([js]) {
        if (!js) throw new Error('usage: eval <js>');
        return { value: await page.evaluate(inPage(js)) };
      },
      async shot([name = 'shot']) {
        const file = path.join(evidence, `${String(++shots).padStart(2, '0')}-${name.replace(/[^\w.-]+/g, '-')}.png`);
        // continuous software-GL frames starve the capture: hold the loop, draw this one frame, capture, let go
        const held = await page.evaluate(() => {
          const g = window.__court;
          if (!g || g.stopped) return null;
          const was = g.holdRender;
          g.holdRender = true;
          g.renderNow(1 / 60);
          return was;
        });
        try {
          await page.screenshot({ path: file, timeout: 90000 });
        } finally {
          if (held === false) await page.evaluate(() => (window.__court.holdRender = false));
        }
        return { shot: rel(file) };
      },
    };
    const QUIET = new Set(['ping', 'health', 'state', 'events', 'errors']);

    // 3. commands arrive one at a time over loopback HTTP
    let queue = Promise.resolve();
    let lastDigest = '';
    // No command may hold the queue for ever: an endless loop in the page (in the game under test, or in an
    // eval) would otherwise block every later command. Seconds; step and wait are long by nature.
    const LIMITS = { step: 900, open: 150, shot: 120 };
    const handle = async ({ cmd, args = [], flags = {} }) => {
      const fn = cmds[cmd];
      if (!fn) return { ok: false, error: `unknown command "${cmd}" (try: court.mjs help)` };
      const entry = { at: new Date().toISOString(), cmd, args, flags };
      const limit = cmd === 'wait' ? Math.ceil(Number(flags.timeout ?? 30000) / 1000) + 10 : (LIMITS[cmd] ?? 60);
      let res;
      running = { cmd: [cmd, ...args].join(' ').slice(0, 120), since: Date.now() };
      try {
        const result = await withTimeout(
          fn(args, flags),
          limit * 1000,
          `no answer after ${limit} s. The page is probably stuck (an endless loop?). \`doctor\` shows its state; \`stop\` then \`launch\` gives a fresh page`,
        );
        res = { ok: true, result };
      } catch (e) {
        res = { ok: false, error: String(e.message ?? e).split('\nCall log:')[0], ...(e.result ? { result: e.result } : {}) };
      }
      running = null;
      if (!QUIET.has(cmd)) {
        let full = null;
        try {
          full = await withTimeout(snap(), 10000, 'the page did not answer within 10 s');
          const d = digest(full);
          const key = JSON.stringify({ ...d, simTime: 0 });
          // a page load always prints where it landed
          res.state = key === lastDigest && cmd !== 'open' ? { unchanged: true, simTime: d.simTime } : d;
          lastDigest = key;
        } catch (e) {
          res.state = { error: String(e).split('\n')[0] };
        }
        fs.appendFileSync(actionsFile, JSON.stringify({ ...entry, ok: res.ok, result: res.result, error: res.error, state: full }) + '\n');
      }
      return res;
    };
    server = http.createServer((req, resp) => {
      let body = '';
      req.on('data', (d) => (body += d));
      req.on('end', () => {
        let msg;
        try {
          msg = JSON.parse(body);
        } catch {
          msg = null;
        }
        if (!msg || msg.token !== opts.token) {
          resp.writeHead(403).end();
          return;
        }
        const reply = (out) => resp.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify(out));
        // stop and the health checks never wait behind a running command: they are how a stuck session is seen and ended
        if (msg.cmd === 'stop') {
          reply({ ok: true, result: { stopping: true } });
          shutdown(0);
          return;
        }
        if (msg.cmd === 'ping' || msg.cmd === 'health') {
          cmds[msg.cmd]().then(
            (result) => reply({ ok: true, result }),
            (e) => reply({ ok: false, error: String(e.message ?? e) }),
          );
          return;
        }
        queue = queue.then(async () => reply(await handle(msg).catch((e) => ({ ok: false, error: String(e) }))));
      });
    });
    await new Promise((res) => server.listen(0, '127.0.0.1', res));

    // 4. usable = the start screen is up in the browser
    await cmds.open([''], { fresh: true });
    const first = await snap();
    if (first.screen !== 'start') throw new Error(`the app did not reach its start screen: ${JSON.stringify(first)}`);
    const pidStart = startOf(process.pid);
    const viteStart = startOf(vite.pid);
    if (!pidStart || !viteStart)
      throw new Error('cannot read process start times (neither /proc nor ps works here), so the session could not be stopped safely');
    if (!owns(opts.token)) throw new Error('another launch took this session over while this one was starting');
    const state = {
      session: SESSION,
      pid: process.pid,
      pidStart,
      port: server.address().port,
      token: opts.token,
      root: ROOT,
      base,
      vitePid: vite.pid,
      viteStart,
      evidence,
      touch: !!opts.touch,
      build: first.build,
      commitAtLaunch: git('rev-parse', '--short=7', 'HEAD'),
      node: process.version,
      startedAt: new Date().toISOString(),
    };
    fs.writeFileSync(STATE_FILE + '.tmp', JSON.stringify(state, null, 2));
    fs.renameSync(STATE_FILE + '.tmp', STATE_FILE);
    log('session ready', JSON.stringify(state));
  } catch (e) {
    log('startup failed:', e?.stack ?? String(e));
    await shutdown(1);
  }
}

// ---------------------------------------------------------------- the command line
function send(state, cmd, args = [], flags = {}, timeoutMs = 0) {
  return new Promise((res, rej) => {
    const body = JSON.stringify({ token: state.token, cmd, args, flags });
    const req = http.request(
      {
        host: '127.0.0.1',
        port: state.port,
        method: 'POST',
        headers: { 'content-type': 'application/json', 'content-length': Buffer.byteLength(body) },
      },
      (r) => {
        let out = '';
        r.on('data', (d) => (out += d));
        r.on('end', () => {
          if (r.statusCode !== 200) return rej(new Error(`the session refused the command (HTTP ${r.statusCode})`));
          try {
            res(JSON.parse(out));
          } catch (e) {
            rej(e);
          }
        });
      },
    );
    if (timeoutMs) req.setTimeout(timeoutMs, () => req.destroy(new Error(`no answer within ${timeoutMs / 1000} s`)));
    req.on('error', rej);
    req.end(body);
  });
}

function prerequisites() {
  const out = [];
  const want = (() => {
    try {
      return fs.readFileSync(path.join(ROOT, '.nvmrc'), 'utf8').trim();
    } catch {
      return null;
    }
  })();
  const major = process.versions.node.split('.')[0];
  out.push(
    !want || want === major
      ? ['ok', `Node ${process.version}`]
      : ['WARN', `Node ${process.version}, but .nvmrc and CI use ${want}: run \`source ~/.nvm/nvm.sh && nvm use\` first`],
  );
  const has = (p) => fs.existsSync(path.join(ROOT, 'node_modules', p));
  out.push(
    has('vite/bin/vite.js') && has('playwright') ? ['ok', 'dependencies installed'] : ['FAIL', 'dependencies missing: run `npm ci`'],
  );
  return out;
}

async function doctor() {
  const lines = prerequisites();
  if (lines.every((l) => l[0] !== 'FAIL')) {
    try {
      const { chromium } = await import('playwright');
      const exe = chromium.executablePath();
      lines.push(
        fs.existsSync(exe) ? ['ok', 'Playwright Chromium installed'] : ['FAIL', 'Chromium missing: run `npx playwright install chromium`'],
      );
    } catch (e) {
      lines.push(['FAIL', `cannot load Playwright: ${String(e).split('\n')[0]}`]);
    }
  }
  const st = readState();
  if (!st) {
    lines.push(['FAIL', `no session "${SESSION}" for this checkout: run \`${rel(SELF)} launch\``]);
  } else {
    const up = ours(supervisorOf(st));
    lines.push(
      up
        ? ['ok', `session "${SESSION}" supervisor pid ${st.pid}, started ${st.startedAt}, is the process launch started`]
        : [
            'FAIL',
            `supervisor pid ${st.pid} is gone${alive(st.pid) ? ' (that pid now belongs to another process)' : ''}: the session died. Run stop to clear what it left, then launch`,
          ],
    );
    if (up) {
      const cwd = cwdOf(st.pid);
      if (cwd && cwd !== REAL_ROOT) lines.push(['FAIL', `pid ${st.pid} runs from ${cwd}, not this checkout: not our session`]);
      let h = null;
      try {
        const r = await send(st, 'health', [], {}, 15000);
        if (r.ok) h = r.result;
        else lines.push(['FAIL', `supervisor error: ${r.error}`]);
      } catch (e) {
        lines.push(['FAIL', `the supervisor does not answer on port ${st.port}: ${String(e.message ?? e)}`]);
      }
      if (h) {
        lines.push(
          h.pid === st.pid && h.root === ROOT && h.session === SESSION
            ? ['ok', `command port ${st.port} is answered by our supervisor`]
            : ['FAIL', `port ${st.port} is answered by someone else (${JSON.stringify({ pid: h.pid, root: h.root })})`],
        );
        const web = await httpGet(h.base);
        lines.push(
          web.status === 200 && web.body.includes('<title>Court Feel</title>') && ours(viteOf(st))
            ? ['ok', `dev server ${h.base} (pid ${h.vitePid}) serves Court Feel and is the process launch started`]
            : ['FAIL', `dev server ${h.base} (pid ${h.vitePid}) is not serving Court Feel (HTTP ${web.status}), or is not our process`],
        );
        if (h.busy && h.busy.seconds >= 30)
          lines.push([
            'WARN',
            `a command has been running for ${h.busy.seconds} s: "${h.busy.cmd}". If the page is stuck, stop and launch again`,
          ]);
        const head = git('rev-parse', '--short=7', 'HEAD');
        const dirty = (git('status', '--porcelain') ?? '').split('\n').filter(Boolean).length;
        const p = h.page ?? {};
        const label = p.build ?? st.build ?? '?';
        if (head && !label.includes(head))
          lines.push([
            'WARN',
            `the menus show build "${label}" but HEAD is ${head}: the label is fixed when the dev server starts (stop + launch to refresh); the code served is current`,
          ]);
        else
          lines.push([
            'ok',
            `build "${label}" matches HEAD${dirty ? `, plus ${dirty} uncommitted file(s) (the dev server serves the working tree)` : ''}`,
          ]);
        if (p.error) lines.push(['FAIL', `the page cannot be read: ${p.error}`]);
        else if (p.screen === 'crash')
          lines.push(['FAIL', `the app is on its crash screen: ${p.crash?.title} (\`state\` has the details; \`open\` reloads)`]);
        else if (p.screen === 'loading')
          lines.push(['FAIL', 'the page is still loading or has no game (a reload after a source edit takes a few seconds): run `open`']);
        else
          lines.push([
            'ok',
            `page ${p.url} is on the "${p.screen}" screen${p.game ? `, clock ${p.game.clock}` : ''}${st.touch ? ', touch session' : ''}`,
          ]);
        if (h.reloadedSinceOpen)
          lines.push([
            'WARN',
            'the page reloaded since your last `open` (a source edit triggers that): game state and the clock were reset, `open` again',
          ]);
        lines.push(
          h.consoleProblems
            ? ['WARN', `${h.consoleProblems} console error(s) / warning(s) since the page loaded: run \`errors\``]
            : ['ok', 'no console errors or warnings since the page loaded'],
        );
        lines.push(['ok', `evidence directory ${rel(st.evidence)}`]);
      }
    }
  }
  for (const [lvl, text] of lines) console.log(`${lvl.padEnd(4)} ${text}`);
  const bad = lines.some((l) => l[0] === 'FAIL');
  console.log(bad ? 'NOT HEALTHY' : lines.some((l) => l[0] === 'WARN') ? 'HEALTHY (with warnings)' : 'HEALTHY');
  process.exit(bad ? 1 : 0);
}

async function launch(flags) {
  const st = readState();
  if (st && ours(supervisorOf(st)))
    fail(
      `session "${SESSION}" is already running for this checkout (pid ${st.pid}, started ${st.startedAt}).\n` +
        `If you started it, keep using it (doctor tells you its state). If you did not, leave it alone and use your own:\n` +
        `  COURT_SESSION=<name> ${rel(SELF)} launch`,
    );
  const pre = prerequisites();
  for (const [lvl, text] of pre) if (lvl !== 'ok') console.error(`${lvl} ${text}`);
  if (pre.some((l) => l[0] === 'FAIL')) process.exit(1);
  // a dead session's leftovers (a crash, a reboot): stop whatever it left running, then start clean
  if (st) await stop(true);
  fs.rmSync(SESSION_DIR, { recursive: true, force: true });
  fs.mkdirSync(SESSION_DIR, { recursive: true });
  // From here this launch owns the session. If another launch starts before this one is ready, it writes its own
  // token and owns it instead: this one then fails, and its supervisor sees the change and exits by itself.
  const token = crypto.randomBytes(16).toString('hex');
  fs.writeFileSync(OWNER_FILE, token);
  const evidence = path.join(VERIFY_DIR, `${stamp()}-${SESSION}`);
  fs.mkdirSync(evidence, { recursive: true });
  const logFile = path.join(SESSION_DIR, 'supervisor.log');
  const out = fs.openSync(logFile, 'a');
  const child = spawn(process.execPath, [SELF, '__supervisor'], {
    cwd: ROOT,
    detached: true,
    stdio: ['ignore', out, out],
    env: {
      ...process.env,
      COURT_SESSION: SESSION,
      COURT_SUPERVISOR: JSON.stringify({ evidence, touch: !!flags.touch, token }),
    },
  });
  let exited = null;
  child.on('exit', (code) => (exited = code ?? 1));
  child.unref();
  const t0 = Date.now();
  while (Date.now() - t0 < 120000 && exited === null && owns(token) && readState()?.token !== token) await sleep(200);
  if (!owns(token))
    fail(
      `another launch of session "${SESSION}" started while this one was starting, and took the session over.\n` +
        `This launch has stopped itself. Run doctor to see the session that is running.`,
    );
  const ready = readState();
  if (ready?.token !== token) {
    if (exited === null) {
      try {
        process.kill(-child.pid, 'SIGTERM');
      } catch {
        /* already gone */
      }
    }
    const tail = fs.existsSync(logFile) ? fs.readFileSync(logFile, 'utf8').split('\n').slice(-25).join('\n') : '';
    fs.copyFileSync(logFile, path.join(evidence, 'supervisor.log'));
    fs.rmSync(SESSION_DIR, { recursive: true, force: true });
    fail(`launch failed${exited === null ? ' (timed out after 120 s)' : ''}. Supervisor log:\n${tail}`);
  }
  console.log(`session   ${SESSION} (supervisor pid ${ready.pid})`);
  console.log(`app       ${ready.base}  build "${ready.build}"${ready.touch ? '  (phone, touch)' : ''}`);
  console.log(`evidence  ${rel(ready.evidence)}/`);
  console.log(`ready     the start screen is up. Next: ${rel(SELF)} doctor`);
}

async function stop(quiet = false) {
  const st = readState();
  if (!st) {
    if (fs.existsSync(SESSION_DIR)) fs.rmSync(SESSION_DIR, { recursive: true, force: true });
    if (!quiet) console.log(`no session "${SESSION}" is running for this checkout`);
    return;
  }
  // Exactly the two processes launch recorded, each checked by pid and start time, so a pid that was reused by
  // another program is never signalled. The browser belongs to the supervisor and goes with it.
  const procs = [supervisorOf(st), viteOf(st)];
  const left = () => procs.filter(ours).map((p) => p.pid);
  const wasRunning = left().length > 0;
  const gone = async (ms) => {
    const t0 = Date.now();
    while (Date.now() - t0 < ms && left().length) await sleep(100);
    return !left().length;
  };
  if (ours(supervisorOf(st))) {
    try {
      await send(st, 'stop', [], {}, 5000);
    } catch {
      /* not answering: signal it below */
    }
    await gone(10000);
  }
  for (const sig of ['SIGTERM', 'SIGKILL']) {
    if (!left().length) break;
    for (const pid of left()) {
      try {
        process.kill(pid, sig);
      } catch {
        /* already gone */
      }
    }
    await gone(5000);
  }
  for (const f of ['supervisor.log', 'vite.log']) {
    try {
      fs.copyFileSync(path.join(SESSION_DIR, f), path.join(st.evidence, f));
    } catch {
      /* no such log */
    }
  }
  if (left().length) fail(`could not stop pids ${JSON.stringify(left())}. Scratch state kept in ${rel(SESSION_DIR)}`);
  fs.rmSync(SESSION_DIR, { recursive: true, force: true });
  try {
    fs.rmdirSync(path.dirname(SESSION_DIR)); // only when no other session is left
  } catch {
    /* another session is running */
  }
  if (quiet) return;
  const files = fs.existsSync(st.evidence) ? fs.readdirSync(st.evidence) : [];
  console.log(
    wasRunning
      ? `stopped   session ${SESSION} (supervisor ${st.pid}, dev server ${st.vitePid})`
      : `cleared   the record of session ${SESSION}: its processes were already gone, nothing was signalled`,
  );
  console.log(`evidence  ${rel(st.evidence)}/ (${files.length} files, ${files.filter((f) => f.endsWith('.png')).length} screenshots)`);
}

async function main() {
  const [cmd, ...rest] = process.argv.slice(2);
  if (cmd === '__supervisor') return supervisor();
  if (!cmd || cmd === 'help' || cmd === '--help' || cmd === '-h') return console.log(HELP);
  if (
    !fs.existsSync(path.join(ROOT, 'package.json')) ||
    JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8')).name !== 'court-feel'
  )
    fail(`${ROOT} is not a court-feel checkout (this helper must live in <checkout>/.agents/skills/verify-court-feel/)`);
  // the session name becomes a directory that stop removes: nothing but a plain name
  if (!/^[\w-]+$/.test(SESSION)) fail('COURT_SESSION may only contain letters, digits, _ and -');
  const { args, flags } = parseArgs(rest);
  if (cmd === 'launch') return launch(flags);
  if (cmd === 'doctor') return doctor();
  if (cmd === 'stop') return stop();
  const st = readState();
  if (!st || !ours(supervisorOf(st))) fail(`no running session "${SESSION}" for this checkout: run \`${rel(SELF)} launch\` (or doctor)`);
  let res;
  try {
    res = await send(st, cmd, args, flags);
  } catch (e) {
    fail(`the session did not answer: ${String(e.message ?? e)} (run doctor)`);
  }
  const pretty = cmd === 'state' || cmd === 'events' || cmd === 'errors';
  if (res.ok) {
    if (pretty) console.log(JSON.stringify(res.result, null, 2));
    else {
      console.log(JSON.stringify(res.result));
      if (res.state)
        console.log(res.state.unchanged ? `state unchanged (simTime ${res.state.simTime})` : 'state ' + JSON.stringify(res.state));
    }
    if (cmd === 'errors' && res.result.count) process.exit(1);
  } else {
    console.error(`FAILED ${cmd}: ${res.error}`);
    if (res.state && !res.state.unchanged) console.error('state ' + JSON.stringify(res.state));
    process.exit(1);
  }
}

main().catch((e) => fail(e?.stack ?? String(e)));
