// End-to-end check: `npm run e2e` (Playwright is a dev dependency; `npx playwright install chromium` once).
// Starts a Vite dev server, drives every drill with the autopilot bots through
// the real input path, takes FP/TP screenshots of key moments, and checks:
//   - no console errors or warnings, no page errors
//   - every drill's bot makes its contacts, mostly Perfect; rallies produce points
//   - spike-drill set calls take effect (each call sets its own play)
//   - the Perfect-spike replay starts; touch controls drive the athlete
//   - bad quick-start links and corrupted saved settings still load and play; menus are keyboard-usable;
//     a crash leaves the crash screen in control of the keyboard and mouse
//   - GPU resources (geometries, textures, shader programs) do not grow over a soak
// Frame time, draw calls and heap are reported, not asserted (software rendering here).
// SOAK sets the soak's length in simulated seconds (120) and PERF_FRAMES the frames the perf numbers are
// taken over (120); CI runs shorter ones (see .github/workflows/ci.yml).
// The simulation is stepped manually at a fixed dt, so results do not depend on machine speed.
// Wall-clock limits do depend on it: see "fresh pages on a software GPU" below before adding a page or a limit.
// Exit code 1 on any failed check. Output: scripts/out/*.png and scripts/out/report.json
import { createRequire } from 'node:module';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const { chromium } = require('playwright');
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const out = path.join(root, 'scripts', 'out');
fs.mkdirSync(out, { recursive: true });
const PORT = Number(process.env.E2E_PORT ?? 5199);
const soakSeconds = Number(process.env.SOAK ?? 120);
const perfFrames = Number(process.env.PERF_FRAMES ?? 120);

// own process group, so stopping it also stops the vite child that npx starts
const server = spawn('npx', ['vite', '--port', String(PORT), '--strictPort'], { cwd: root, stdio: 'pipe', detached: true });
const stopServer = () => {
  try {
    process.kill(-server.pid, 'SIGTERM');
  } catch {
    server.kill();
  }
};
process.on('exit', stopServer);
await new Promise((res, rej) => {
  const t = setTimeout(() => rej(new Error('vite did not start')), 30000);
  server.stdout.on('data', (d) => {
    if (String(d).includes('Local')) {
      clearTimeout(t);
      res();
    }
  });
});

const browser = await chromium.launch({
  args: [
    '--use-angle=swiftshader',
    '--enable-unsafe-swiftshader',
    '--ignore-gpu-blocklist',
    '--enable-precise-memory-info',
    '--js-flags=--expose-gc',
  ],
});

// ---- where the time goes: seconds per phase, printed at the end and kept in the report
const phaseSeconds = {};
let phaseName = 'start-up';
let phaseStart = Date.now();
const phase = (name) => {
  phaseSeconds[phaseName] = +((phaseSeconds[phaseName] ?? 0) + (Date.now() - phaseStart) / 1000).toFixed(1);
  phaseName = name;
  phaseStart = Date.now();
};

// ---- fresh pages on a software GPU
// SwiftShader draws a frame in 0.6 s on a good machine and 2 s on a slow CI runner, and WebGL does not wait
// for it: draw calls only queue work for the browser's GPU process. Two things then wait for that queue to
// empty, however long it is:
//   - a page's first drawn frame, which compiles every shader and blocks the page's main thread (and with
//     it every evaluate and all requestAnimationFrame polling) until the GPU has caught up;
//   - closing a browser context, which blocks the browser's own main thread until the GPU has drawn all it
//     was sent, by any page. Nothing that goes through the browser moves meanwhile: a new context, a
//     navigation, an answer from another page.
// So a page opened or closed right after a phase that queued frames used to spend its own time limit on
// those frames. At 2 s a frame the perf phase leaves 43 s of them and the soak 66 s (it never waits for a
// render), against limits of 30 and 60 s. The rules that keep a limit about the thing it names:
//   - a fresh page holds rendering until it is up (`newHeldPage` + `comeUp`), then draws (`startRendering`);
//   - a page that draws by itself is paced to the GPU (`paceRendering`), so it never queues more than a
//     frame or two. That is also most of the suite's speed: unpaced, some 55 s of a 4 min run went on
//     drawing queued frames nobody looked at;
//   - after a phase that queued frames (the soak renders from one long evaluate, which pacing cannot
//     reach), and before a context is closed, wait for the GPU (`gpuIdle`, `closeIdle`). Those waits sit in
//     evaluates, which have no limit of their own, under a generous one.
/** for a fresh page to load and construct the game with rendering held: 1 to 4 s here, 23 s on a single core */
const FRESH_PAGE_MS = 120000;
/** for the GPU to draw what it was sent: the default 120 s soak leaves 128 renders, over 4 min at 2 s a frame */
const GPU_MS = 600000;
/** `promise`, or an error naming `what` after `ms` (for waits that have no limit of their own) */
const within = (promise, ms, what) => {
  let timer;
  const late = new Promise((_, rej) => {
    timer = setTimeout(() => rej(new Error(`${what}: not done after ${ms / 1000} s`)), ms);
  });
  return Promise.race([promise, late]).finally(() => clearTimeout(timer));
};
/** runs in the page before its scripts: the game holds rendering from its very first frame */
const holdRendering = () => {
  let game;
  Object.defineProperty(window, '__court', {
    configurable: true,
    get: () => game,
    set: (g) => {
      game = g;
      g.holdRender = true;
    },
  });
};
/**
 * runs in the page before its scripts: animation frames wait for the GPU, the way a display that is not
 * ready holds a real page back. Left alone, the page renders some twenty frames ahead of the software GPU,
 * and every screenshot, every `gpuIdle` and the closing of the page then waits for frames nobody looks at.
 * Here an animation frame is skipped (all of its callbacks, so they stay in step) while `ahead` frames the
 * game rendered from earlier ones are still not drawn.
 */
const paceRendering = (ahead) => {
  const raf = window.requestAnimationFrame.bind(window);
  /** one fence per frame the game rendered from an animation frame and the GPU has not drawn yet, oldest first */
  const fences = [];
  let frameTime = -1;
  let open = true;
  const gpuReady = () => {
    const gl = window.__court?.renderer.getContext();
    while (fences.length && (gl.isContextLost() || gl.getSyncParameter(fences[0], gl.SYNC_STATUS) === gl.SIGNALED)) {
      gl.deleteSync(fences.shift());
    }
    return fences.length < ahead;
  };
  window.requestAnimationFrame = (callback) =>
    raf(function run(time) {
      // one decision per animation frame: every callback of a frame gets the same timestamp
      if (time !== frameTime) {
        frameTime = time;
        open = gpuReady();
      }
      if (!open) {
        raf(run);
        return;
      }
      const renderer = window.__court?.renderer;
      const before = renderer?.info.render.frame;
      callback(time);
      if (renderer && renderer.info.render.frame !== before) {
        const gl = renderer.getContext();
        fences.push(gl.fenceSync(gl.SYNC_GPU_COMMANDS_COMPLETE, 0));
        gl.flush();
      }
    });
};
/** a page in its own context whose game will hold rendering; `init` runs in the page before its scripts */
const newHeldPage = async (contextOptions, init) => {
  const ctx = await browser.newContext(contextOptions);
  await ctx.addInitScript(holdRendering);
  // one frame in flight keeps the GPU busy while the page prepares the next; more only builds a queue
  await ctx.addInitScript(paceRendering, 2);
  if (init) await ctx.addInitScript(init);
  return { ctx, p: await ctx.newPage() };
};
/** load `url` and wait until `ready` holds in the page (timer polling: animation frames stall behind the GPU) */
const comeUp = async (p, url, ready) => {
  await p.goto(`http://localhost:${PORT}/${url}`, { timeout: FRESH_PAGE_MS });
  await p.waitForFunction(ready, null, { timeout: FRESH_PAGE_MS, polling: 250 });
};
/**
 * resolves once the GPU has drawn everything this page's game has sent it so far (a fence, polled).
 * With `after`, the wait is printed: in a CI log it tells how much work that phase had left queued.
 */
const gpuIdle = async (p, after) => {
  const t0 = Date.now();
  await within(
    p.evaluate(async () => {
      const gl = window.__court?.renderer.getContext();
      if (!gl || gl.isContextLost()) return;
      const fence = gl.fenceSync(gl.SYNC_GPU_COMMANDS_COMPLETE, 0);
      gl.flush();
      while (!gl.isContextLost() && gl.getSyncParameter(fence, gl.SYNC_STATUS) !== gl.SIGNALED) {
        await new Promise((r) => setTimeout(r, 100));
      }
      gl.deleteSync(fence);
    }),
    GPU_MS,
    'waiting for the GPU to draw the queued frames',
  );
  if (after) console.log(`gpu queue after ${after}: ${((Date.now() - t0) / 1000).toFixed(1)} s`);
};
/** release a held page and wait until its first two frames (the first compiles every shader) are drawn */
const startRendering = async (p) => {
  await within(
    p.evaluate(async () => {
      window.__court.holdRender = false;
      await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
    }),
    GPU_MS,
    "waiting for a fresh page's first frames",
  );
  await gpuIdle(p);
};
/** close a page's context once its game has stopped drawing and the GPU has drawn what it sent */
const closeIdle = async (ctx, p) => {
  const hold = p.evaluate(() => {
    if (window.__court) window.__court.holdRender = true;
  });
  await within(hold, GPU_MS, 'waiting for a page to stop drawing');
  await gpuIdle(p);
  await ctx.close();
};

const { p: page } = await newHeldPage({ viewport: { width: 1280, height: 720 } });
const errors = [];
page.on('console', (m) => {
  if (m.type() === 'error' || m.type() === 'warning') errors.push(`[${m.type()}] ${m.text()}`);
});
page.on('pageerror', (e) => errors.push('[pageerror] ' + e.message));
await comeUp(page, '', () => window.__court && window.__menu);
// the first frames compile the shaders before we start capturing (a fixed 6 s of frames used to follow:
// with the frames paced, the two that `startRendering` waits for are the ones that did the work)
await startRendering(page);
// render on demand only: continuous SwiftShader frames starve screenshot capture
await page.evaluate(() => {
  window.__court.holdRender = true;
});
await gpuIdle(page, 'the warm-up');
const failures = [];
/** record a failed expectation (the run continues so one report shows every failure) */
const check = (ok, what, detail) => {
  if (!ok) failures.push(detail === undefined ? what : `${what}: ${JSON.stringify(detail)}`);
  return ok;
};
const report = { modes: {}, shots: [], perf: {}, errors, failures };

const shot = async (name) => {
  await page.evaluate(() => window.__court.renderNow(1 / 60));
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      await page.screenshot({ path: path.join(out, name + '.png'), timeout: 90000 });
      report.shots.push(name);
      return;
    } catch (e) {
      console.log('screenshot retry', name, String(e).slice(0, 80));
    }
  }
};
phase('screenshots');
await shot('00_menu');

// helpers inside the page
await page.evaluate(() => {
  const g = window.__court;
  g.manual = true;
  g.holdRender = true;
  window.until = (fn, max) => {
    for (let i = 0; i < max; i++) {
      g.play(1 / 60);
      if (fn()) return i;
    }
    return -1;
  };
  window.start = (mode, pos, fp, bot = 'perfect', call = 0) => {
    g.settings.firstPerson = fp;
    g.startMode(mode, pos);
    window.__menu.showStart(false);
    if (call) g.mode.selectCall?.(call);
    g.hud.setVisible(true);
    if (bot) g.enableBot(bot);
    window.log = [];
    window.offs?.forEach((f) => f());
    window.offs = [
      g.events.on('contact', (e) =>
        window.log.push({
          who: e.athlete.isUser ? 'me' : e.athlete.role + (e.athlete.side === 1 ? 'H' : 'A'),
          kind: e.kind,
          grade: e.grade,
          kmh: Math.round(e.speed * 3.6),
        }),
      ),
      g.events.on('outcome', (o) => window.log.push({ outcome: o.kind, side: o.side })),
    ];
  };
});

// ---- spike drill: TP and FP perfect spikes, impact, replay
for (const fp of [false, true]) {
  const tag = fp ? 'fp' : 'tp';
  await page
    .evaluate((fp) => {
      window.start('spike', 'OH', fp);
      window.hit = null;
      window.impact = null;
      const g = window.__court;
      g.events.on('contact', (e) => {
        if (e.athlete === g.me && !window.hit) window.hit = e.grade;
      });
      g.events.on('ballEvent', (e) => {
        if (e.kind === 'floor' && window.hit && !window.impact) window.impact = true;
      });
      window.until(() => window.hit !== null, 1200);
      if (fp) g.rig.pitch = 0.55;
      g.play(2 / 60);
      return window.hit;
    }, fp)
    .then((grade) => check(grade === 'Perfect', `spike drill (${tag}): the perfect bot's spike is Perfect`, grade));
  await shot(`10_spike_contact_${tag}`);
  await page.evaluate(() => window.__court.play(0.1));
  await shot(`11_spike_flight_${tag}`);
  await page.evaluate(() => {
    window.until(() => window.impact, 200);
    window.__court.play(0.08);
  });
  await shot(`12_spike_impact_${tag}`);
  if (!fp) {
    const replayAt = await page.evaluate(() => {
      const g = window.__court;
      const at = window.until(() => g.fx.replaying, 200);
      g.play(1.1);
      return at;
    });
    check(replayAt >= 0, 'a Perfect spike that lands starts the automatic replay');
    await shot('13_replay_hitter');
    await page.evaluate(() => window.__court.play(1.25));
    await shot('14_replay_contact');
    await page.evaluate(() => window.__court.play(2.0));
    await shot('15_replay_impact');
  }
}

// ---- every drill with its bot (and the rally both all-AI and with the user)
phase('drills');
const runs = [
  ['spike', 'OH'],
  ['spike', 'OPP'],
  ['spike', 'MB'],
  ['spike', 'S'],
  ['spike', 'L'],
  // spike drill set calls (keys 2 and 3): go / inside 3, shoot / back quick, fast back / back 2
  ['spike', 'OH', 1],
  ['spike', 'OH', 2],
  ['spike', 'MB', 1],
  ['spike', 'MB', 2],
  ['spike', 'OPP', 1],
  ['spike', 'OPP', 2],
  ['block', 'MB'],
  ['receive', 'L'],
  ['setter', 'S'],
  ['free', 'OH'],
  ['rally', 'MB'],
  ['rally', 'L'],
];
for (const [mode, pos, call = 0] of runs) {
  const r = await page.evaluate(
    ([mode, pos, call]) => {
      window.start(mode, pos, false, 'perfect', call);
      const g = window.__court;
      for (let i = 0; i < 60 * 30; i++) g.play(1 / 60);
      const mine = window.log.filter((l) => l.who === 'me');
      const grades = {};
      for (const m of mine) grades[m.kind + ':' + m.grade] = (grades[m.kind + ':' + m.grade] || 0) + 1;
      return {
        score: g.mode.score,
        reps: g.mode.reps,
        home: g.mode.scoreHome,
        away: g.mode.scoreAway,
        // the set call in effect (spike drill): proves selectCall reached the drill
        play: g.mode.play?.name ?? null,
        myContacts: grades,
        outcomes: window.log.filter((l) => l.outcome).length,
        events: window.log.length,
      };
    },
    [mode, pos, call],
  );
  const key = call ? `${mode}_${pos}_call${call + 1}` : `${mode}_${pos}`;
  report.modes[key] = r;
  console.log(mode, pos + (call ? ` call${call + 1}` : ''), JSON.stringify(r));
  // what each drill's bot has to touch; the perfect bot should mostly grade Perfect
  const kind = { spike: 'spike', free: 'spike', block: 'block', receive: 'pass', setter: 'set' }[mode];
  const count = (k, grade) =>
    Object.entries(r.myContacts)
      .filter(([g]) => g.startsWith(k + ':') && (!grade || g.endsWith(':' + grade)))
      .reduce((n, [, c]) => n + c, 0);
  if (kind) {
    const all = count(kind);
    check(all >= 1, `${key}: the bot makes ${kind} contacts`, r.myContacts);
    check(count(kind, 'Perfect') * 2 >= all, `${key}: at least half of the bot's ${kind} contacts are Perfect`, r.myContacts);
  }
  if (mode === 'spike' || mode === 'block' || mode === 'receive' || mode === 'setter')
    check(r.reps >= 1, `${key}: at least one rep completes`, r);
  if (mode === 'rally') {
    check(r.outcomes >= 1, `${key}: the rally produces points`, r);
    check(Object.keys(r.myContacts).length >= 1, `${key}: the user's athlete plays the ball`, r);
  }
}
// the three set calls of a position set three different plays
for (const pos of ['OH', 'MB', 'OPP']) {
  const plays = [report.modes[`spike_${pos}`], report.modes[`spike_${pos}_call2`], report.modes[`spike_${pos}_call3`]].map((m) => m?.play);
  check(new Set(plays).size === 3 && plays.every(Boolean), `spike drill ${pos}: calls 1 / 2 / 3 set different plays`, plays);
}

// ---- block FP + rally screenshots
phase('screenshots');
await page.evaluate(() => {
  window.start('block', 'MB', true);
  const g = window.__court;
  window.blk = null;
  g.events.on('contact', (e) => {
    if (e.athlete === g.me && !window.blk) window.blk = e.grade;
  });
  window.until(() => window.blk !== null, 1500);
  g.play(1 / 60);
});
await shot('20_block_fp');
await page.evaluate(() => {
  window.start('rally', 'OH', false, null);
  const g = window.__court;
  g.play(5);
  g.rig.setMode('cine');
  g.rig.cinePos.set(9, 7, 9);
  g.rig.cineTarget.set(0, 1, 0);
  g.rig.cineFov = 55;
  g.play(0.2);
});
await shot('21_rally_wide');

// ---- performance: real rendering frames (SwiftShader: CPU-side numbers only)
phase('perf');
const perf = await page.evaluate(async (frames) => {
  const g = window.__court;
  window.start('rally', 'MB', false, null);
  g.autoUser = false;
  g.play(3);
  g.holdRender = false;
  g.manual = false;
  const samples = [];
  const t0 = performance.now();
  await new Promise((res) => {
    let n = 0;
    const f = () => {
      n++;
      samples.push(g.frameMs);
      if (n < frames) requestAnimationFrame(f);
      else res();
    };
    requestAnimationFrame(f);
  });
  const wall = performance.now() - t0;
  g.holdRender = true;
  g.manual = true;
  const info = g.renderer.info;
  samples.sort((a, b) => a - b);
  return {
    cpuFrameMsMedian: samples[Math.floor(samples.length / 2)],
    cpuFrameMsP95: samples[Math.floor(samples.length * 0.95)],
    frames,
    swiftshaderWallMsPerFrame: wall / frames,
    drawCalls: info.render.calls,
    triangles: info.render.triangles,
    geometries: info.memory.geometries,
    textures: info.memory.textures,
  };
}, perfFrames);
report.perf.frame = perf;
console.log('perf', JSON.stringify(perf));
// the frames still queued behind the last one measured: the touch page below must not wait for them
await gpuIdle(page, 'the perf frames');

// ---- touch controls: a phone-sized touch context drives the stick, JUMP and HIT with real touch events
phase('touch');
{
  const { ctx: tctx, p: tp } = await newHeldPage({
    viewport: { width: 844, height: 390 },
    deviceScaleFactor: 2,
    isMobile: true,
    hasTouch: true,
  });
  tp.on('console', (m) => {
    if (m.type() === 'error' || m.type() === 'warning') errors.push(`[touch ${m.type()}] ${m.text()}`);
  });
  tp.on('pageerror', (e) => errors.push('[touch pageerror] ' + e.message));
  const cdp = await tctx.newCDPSession(tp);
  const pts = new Map();
  const touch = async (type, id, x, y) => {
    if (type === 'touchEnd') {
      const p = pts.get(id);
      pts.delete(id);
      return cdp.send('Input.dispatchTouchEvent', { type, touchPoints: [{ x: p.x, y: p.y, id }] });
    }
    pts.set(id, { x, y });
    return cdp.send('Input.dispatchTouchEvent', { type, touchPoints: [...pts.entries()].map(([id, p]) => ({ x: p.x, y: p.y, id })) });
  };
  const wait = (ms) => new Promise((r) => setTimeout(r, ms));
  await comeUp(tp, '?mode=spike&pos=OH&touch=1', () => window.__court && window.__touch?.enabled);
  // from here the page draws by itself, as on a phone: the touches below go through its real frame loop
  // (its first two frames are drawn when this returns, which is what a fixed 2.5 s wait here stood in for)
  await startRendering(tp);
  const tshot = async (name) => {
    await tp.evaluate(() => {
      window.__court.holdRender = true;
      window.__court.renderNow(1 / 60);
    });
    // the capture's limit is for capturing, not for the frames the free-running loop had queued
    await gpuIdle(tp);
    await tp.screenshot({ path: path.join(out, name + '.png'), timeout: 90000 });
    report.shots.push(name);
    await tp.evaluate(() => (window.__court.holdRender = false));
  };
  await tshot('20_touch_layout');
  const snap = () =>
    tp.evaluate(() => {
      const g = window.__court;
      return {
        state: g.me.state,
        sprint: g.me.cmd.sprint,
        stick: g.input.stick.active,
        held: [...g.input.held],
        action: g.me.action?.kind ?? null,
        yaw: g.rig.yaw,
      };
    });
  const btn = (sel) =>
    tp.evaluate((s) => {
      const r = document.querySelector(s).getBoundingClientRect();
      return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
    }, sel);
  // the software renderer runs the sim slower than real time: wait for each state rather than a fixed time
  // (a step needs a frame or a few, and a slow runner takes seconds to draw one: the limit is there for a
  // state that never comes, and how long each step took is printed)
  const stepMs = [];
  const untilSnap = async (pred, ms = 30000) => {
    const t0 = Date.now();
    let s = await snap();
    while (!pred(s) && Date.now() - t0 < ms) {
      await wait(50);
      s = await snap();
    }
    stepMs.push(Date.now() - t0);
    return s;
  };
  const t = { ok: true, steps: {} };
  await touch('touchStart', 1, 160, 300);
  await touch('touchMove', 1, 160, 300 - 90);
  t.steps.run = await untilSnap((s) => s.sprint && s.stick);
  const j = await btn('.t-jump');
  await touch('touchStart', 2, j.x, j.y);
  t.steps.load = await untilSnap((s) => s.state === 'load');
  await touch('touchEnd', 2);
  t.steps.air = await untilSnap((s) => s.state === 'air');
  await touch('touchStart', 3, 560, 140);
  await touch('touchMove', 3, 640, 150);
  t.steps.windup = await untilSnap((s) => s.action === 'windup' && s.yaw !== 0);
  await tshot('21_touch_windup');
  await touch('touchEnd', 3);
  t.steps.swing = await untilSnap((s) => s.action === 'swing');
  await touch('touchEnd', 1);
  const s = t.steps;
  t.ok =
    s.run.sprint &&
    s.run.stick &&
    s.load.state === 'load' &&
    s.load.held.includes('Space') &&
    s.air.state === 'air' &&
    !s.air.held.includes('Space') &&
    s.windup.action === 'windup' &&
    s.windup.yaw !== 0 &&
    s.swing.action === 'swing' &&
    !s.swing.held.includes('Mouse0');
  report.touch = t;
  console.log('touch', t.ok ? 'ok' : 'FAILED', JSON.stringify(s));
  console.log('touch step ms', JSON.stringify(stepMs));
  check(t.ok, 'touch controls drive run, load, jump, wind-up and swing', s);
  await closeIdle(tctx, tp);
}

// ---- soak: memory and GPU resources must not grow
phase('soak');
// The soak renders to make three.js build and free resources, not to be looked at, and what gets built does
// not depend on the size of the picture: a small one costs the software GPU a fraction of the time.
// Nothing on this page is captured after this.
await page.setViewportSize({ width: 320, height: 180 });
await page.waitForFunction(() => window.__court.renderer.domElement.clientWidth === 320, null, { timeout: FRESH_PAGE_MS, polling: 100 });
const soak = await page.evaluate(async (secs) => {
  const g = window.__court;
  const mem = () => (performance.memory ? performance.memory.usedJSHeapSize / 1048576 : 0);
  const sample = () => ({
    heapMB: +mem().toFixed(1),
    geometries: g.renderer.info.memory.geometries,
    textures: g.renderer.info.memory.textures,
    programs: g.renderer.info.programs?.length ?? 0,
  });
  const modes = ['rally', 'spike', 'block', 'receive', 'setter', 'free'];
  // warm up: every mode once (first-use shaders and pools), then measure from the rally
  for (const m of modes) {
    window.start(m, 'OH', false, 'good');
    g.play(2);
    g.renderNow(1 / 60);
  }
  window.start('rally', 'OH', false, null);
  g.play(2);
  g.renderNow(1 / 60);
  // What is built once and kept only counts once it has been drawn, and some of it stays hidden until its
  // moment (the aim ring until the athlete first winds up). Draw all of it once before the first sample:
  // otherwise its first appearance counts as growth, and when that falls depends on how the rally went.
  const shown = [];
  g.scene.traverse((o) => {
    shown.push([o, o.visible, o.frustumCulled]);
    o.visible = true;
    o.frustumCulled = false;
  });
  g.post.render(1 / 60);
  for (const [o, visible, frustumCulled] of shown) Object.assign(o, { visible, frustumCulled });
  const before = sample();
  let t = 0;
  let k = 0;
  while (t < secs) {
    // cycle modes to catch leaks in setup/teardown, render now and then
    if (t % 20 < 1 / 60) {
      window.start(modes[k++ % modes.length], ['OH', 'MB', 'L', 'S', 'OPP'][k % 5], k % 2 === 0, 'good');
    }
    g.play(1);
    g.renderNow(1 / 60);
    t += 1;
  }
  window.start('rally', 'OH', false, null);
  g.play(2);
  g.renderNow(1 / 60);
  if (window.gc) window.gc();
  await new Promise((r) => setTimeout(r, 500));
  const after = sample();
  return { simulatedSeconds: secs, before, after };
}, soakSeconds);
report.perf.soak = soak;
console.log('soak', JSON.stringify(soak));
// the soak's renders are only queued when it returns (it never waits for a frame): let the GPU draw them
// before the probes open and close their contexts
await gpuIdle(page, 'the soak');
for (const k of ['geometries', 'textures', 'programs']) {
  check(soak.after[k] <= soak.before[k], `soak: ${k} do not grow across mode switches`, { before: soak.before[k], after: soak.after[k] });
}

// ---- robustness: what players actually do (share links, old saved settings, keyboard-only menus)
phase('probes');
{
  // These probes check loading, settings and keys, not drawing, so rendering stays held: a fresh page's
  // first frame compiles every shader at once, which on a CI runner's software GPU blocks the page's main
  // thread (and every evaluate) for more than 30 s.
  const probe = async (label, url, init) => {
    const { ctx, p } = await newHeldPage({ viewport: { width: 1280, height: 720 } }, init);
    const errs = [];
    p.on('pageerror', (e) => errs.push(e.message));
    p.on('console', (m) => {
      if (m.type() === 'error') errs.push('console: ' + m.text());
    });
    try {
      // ready, or on the crash screen (which never sets __menu)
      await comeUp(p, url, () => (window.__court && window.__menu) || document.querySelector('.crash'));
      // building the game queued GPU work too (the environment map): done with it before the probe's own waits
      await gpuIdle(p);
      // rendering is held, so the loop never ticks: step the simulation and the drill for a second by hand
      // (no drawing), so an error in the game loop fails the probe instead of hiding behind the hold
      await p.evaluate(() => {
        if (window.__court && !document.querySelector('.crash')) window.__court.play(1);
      });
      const st = await p.evaluate(() => ({
        mode: window.__court?.mode ? window.__court.modeId : null,
        pos: window.__court?.position,
        inMenu: window.__court?.inMenu,
        fov: window.__court?.settings.fov,
        crash: !!document.querySelector('.crash'),
      }));
      check(errs.length === 0 && !st.crash, `${label}: loads and plays a second without errors`, { errs, st });
      return { p, ctx, st, close: () => closeIdle(ctx, p) };
    } catch (e) {
      // record it and carry on, so the report still lists every other check
      check(false, `${label}: the page comes up`, { error: String(e).split('\n')[0], errs });
      // a page that never came up may never answer either: close it without asking it anything
      return { p, ctx, st: {}, close: () => ctx.close() };
    }
  };
  let r = await probe('mistyped position in a link', '?mode=spike&pos=OHH');
  check(r.st.mode === 'spike' && r.st.pos === 'OH' && !r.st.inMenu, 'a mistyped position falls back to OH and starts the drill', r.st);
  await r.close();
  r = await probe('unknown mode in a link', '?mode=spikey');
  check(r.st.inMenu, 'an unknown mode opens the menu', r.st);
  await r.close();
  r = await probe('corrupted saved settings', '', () =>
    localStorage.setItem('courtfeel.settings.v1', JSON.stringify({ fov: 'wide', volume: null })),
  );
  check(typeof r.st.fov === 'number', 'a stored setting of the wrong type falls back to its default', r.st);
  await r.close();
  // keyboard: game keys are left to the browser in the menu, captured in play
  r = await probe('keyboard', '');
  const keys = await r.p.evaluate(() => {
    const send = (code) => {
      const e = new KeyboardEvent('keydown', { code, key: code, bubbles: true, cancelable: true });
      window.dispatchEvent(e);
      window.dispatchEvent(new KeyboardEvent('keyup', { code, key: code, bubbles: true }));
      return e.defaultPrevented;
    };
    const inMenu = { tab: send('Tab'), space: send('Space') };
    const g = window.__court;
    g.startMode('spike', 'OH');
    window.__menu.showStart(false);
    const inGame = { tab: send('Tab'), space: send('Space') };
    return { inMenu, inGame };
  });
  check(!keys.inMenu.tab && !keys.inMenu.space, 'menus: Tab and Space keep their browser meaning', keys);
  check(keys.inGame.tab && keys.inGame.space, 'in play: Tab and Space are captured by the game', keys);
  await r.close();
  // the menus: a first visit is offered the lesson; past it, Train lists the drills and Enter plays the one picked
  r = await probe('menu', '');
  try {
    const m = {};
    m.welcome = await r.p.locator('.welcome').isVisible();
    await r.p.click('.welcome .ghost-btn');
    m.view = await r.p.evaluate(() => document.querySelector('.menu').dataset.view);
    await r.p.click('.row:has-text("Block Drill")');
    await r.p.click('.pos-chip[aria-label="Middle Blocker"]');
    m.keys = await r.p.locator('.view.on .keys.only-kb .key-cap').allTextContents();
    // Enter plays even when the last click left the focus on the nav
    await r.p.click('.nav-btn[aria-label=Train]');
    await r.p.keyboard.press('Enter');
    Object.assign(
      m,
      await r.p.evaluate(() => ({ mode: window.__court.modeId, pos: window.__court.position, inMenu: window.__court.inMenu })),
    );
    check(m.welcome && m.view === 'train', 'menu: a first visit is offered the lesson, and Skip lands on the drills', m);
    check(
      m.keys.includes('Right mouse') && !m.keys.includes('Left mouse'),
      "menu: a drill lists its own keys (the Block Drill's, not the spike's)",
      m,
    );
    check(m.mode === 'block' && m.pos === 'MB' && !m.inMenu, 'menu: Enter plays the drill and position picked', m);
    // paused: the dialog names the drill and its keys; Settings opens over it and Esc closes only the sheet
    const pz = await r.p.evaluate(() => {
      window.__court.paused = true;
      window.__menu.showPause(true);
      const sub = document.querySelector('.pause-s').textContent;
      const caps = [...document.querySelectorAll('.pause-side .keys.only-kb .key-cap')].map((e) => e.textContent);
      window.__menu.openSettings();
      const open = window.__menu.settingsVisible;
      window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', code: 'Escape', bubbles: true, cancelable: true }));
      return { sub, caps, open, closed: !window.__menu.settingsVisible, paused: window.__menu.pauseVisible };
    });
    check(
      pz.sub.includes('Block Drill') && pz.sub.includes('Middle Blocker') && pz.caps.includes('Right mouse'),
      'pause: names the drill, the position and its keys',
      pz,
    );
    check(pz.open && pz.closed && pz.paused, 'pause: Esc closes the settings and leaves the pause menu', pz);
  } catch (e) {
    check(false, 'menu: the probe runs', { error: String(e).split('\n')[0] });
  }
  await r.close();
  // the menus on a phone: no panel is squeezed shorter than its text, nothing runs off the side, and the
  // settings' reset is in reach (held upright and sideways)
  for (const [w, h] of [
    [390, 844],
    [844, 390],
  ]) {
    const { ctx, p } = await newHeldPage({ viewport: { width: w, height: h }, hasTouch: true, isMobile: true });
    let up = false;
    try {
      await comeUp(p, '', () => window.__court && window.__menu);
      up = true;
      await gpuIdle(p);
      await p.tap('.welcome .ghost-btn');
      const bad = await p.evaluate(() => {
        const out = [];
        const look = (label, root) => {
          for (const e of root.querySelectorAll(
            '.panel, .row, .set-group, .set-row, .set-text, .pos-card, .body-set, .sheet-head, .topbar',
          )) {
            if (e.offsetParent === null) continue;
            const r = e.getBoundingClientRect();
            if (e.scrollHeight > e.clientHeight + 1 || e.scrollWidth > e.clientWidth + 1) out.push(`${label}: ${e.className} spills`);
            if (r.right > innerWidth + 1 || r.left < -1) out.push(`${label}: ${e.className} is off the side`);
          }
        };
        look('train', document.querySelector('.menu'));
        for (const name of ['Play', 'Learn']) {
          document.querySelector(`.nav-btn[aria-label=${name}]`).click();
          look(name, document.querySelector('.menu'));
        }
        window.__menu.openSettings();
        look('settings', document.querySelector('.sheet'));
        const reset = [...document.querySelectorAll('.sheet button')].find((b) => b.textContent === 'Reset to defaults');
        if (!reset || reset.offsetParent === null) out.push('settings: Reset to defaults is not shown');
        if (!document.querySelector('.sheet').contains(document.activeElement)) out.push('settings: focus is not in the sheet');
        document.querySelector('.sheet-head .ghost-btn').click();
        look('athlete', document.querySelector('.sheet'));
        return out;
      });
      check(bad.length === 0, `menus at ${w} x ${h}: every box holds its text and stays on screen`, bad);
    } catch (e) {
      check(false, `menus at ${w} x ${h}: the probe runs`, { error: String(e).split('\n')[0] });
    }
    // a page that never came up may never answer either: close it without asking it anything
    if (up) await closeIdle(ctx, p);
    else await ctx.close();
  }
  // a crash in play: the crash screen keeps the keyboard and mouse (no pause menu or pointer lock behind it)
  r = await probe('crash screen', '?mode=spike&pos=OH');
  try {
    await r.p.evaluate(() => {
      window.__court.frame = () => {
        throw new Error('e2e: injected frame failure');
      };
    });
    await r.p.waitForSelector('.crash', { timeout: 20000 });
    await r.p.keyboard.press('Escape');
    await r.p.click('.crash .ghost-btn');
    const cs = await r.p.evaluate(() => ({
      stopped: window.__court.stopped,
      pauseMenu: window.__menu.pauseVisible,
      pointerLocked: !!document.pointerLockElement,
      focusOnCrashScreen: !!document.activeElement?.closest('.crash'),
      restInert: [...document.querySelectorAll('#app > :not(.crash)')].every((e) => e.inert),
    }));
    check(
      cs.stopped && !cs.pauseMenu && !cs.pointerLocked && cs.focusOnCrashScreen && cs.restInert,
      'crash screen: Esc and clicks leave it in control (no pause menu or pointer lock behind it)',
      cs,
    );
  } catch (e) {
    check(false, 'crash screen: shows after repeated frame errors', String(e).split('\n')[0]);
  }
  await r.close();
}

phase('done');
report.perf.phaseSeconds = phaseSeconds;
console.log('seconds per phase', JSON.stringify(phaseSeconds));
fs.writeFileSync(path.join(out, 'report.json'), JSON.stringify(report, null, 2));
console.log(errors.length ? 'CONSOLE ERRORS:\n' + errors.join('\n') : 'no console errors');
console.log(failures.length ? `FAILED CHECKS (${failures.length}):\n  ` + failures.join('\n  ') : 'all checks passed');
await browser.close();
stopServer();
process.exit(errors.length || failures.length ? 1 : 0);
