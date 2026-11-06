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
// The simulation is stepped manually at a fixed dt, so results do not depend on machine speed.
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
const page = await browser.newPage({ viewport: { width: 1280, height: 720 } });
const errors = [];
page.on('console', (m) => {
  if (m.type() === 'error' || m.type() === 'warning') errors.push(`[${m.type()}] ${m.text()}`);
});
page.on('pageerror', (e) => errors.push('[pageerror] ' + e.message));
await page.goto(`http://localhost:${PORT}/`);
await page.waitForFunction(() => window.__court && window.__menu, null, { timeout: 30000 });
// let the RAF loop render for a while so every shader compiles before we start capturing
await page.waitForTimeout(6000);
// render on demand only: continuous SwiftShader frames starve screenshot capture
await page.evaluate(() => {
  window.__court.holdRender = true;
});
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
    // every run starts from the same random state: what a run does can't depend on how long the
    // menu's autopilot ran before the test took over (machine speed) or on the drills run before it
    g.rng.reseed(2024);
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
const perf = await page.evaluate(async () => {
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
      if (n < 120) requestAnimationFrame(f);
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
    swiftshaderWallMsPerFrame: wall / 120,
    drawCalls: info.render.calls,
    triangles: info.render.triangles,
    geometries: info.memory.geometries,
    textures: info.memory.textures,
  };
});
report.perf.frame = perf;
console.log('perf', JSON.stringify(perf));

// ---- touch controls: a phone-sized touch context drives the stick, JUMP and HIT with real touch events
{
  const tctx = await browser.newContext({ viewport: { width: 844, height: 390 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true });
  const tp = await tctx.newPage();
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
  await tp.goto(`http://localhost:${PORT}/?mode=spike&pos=OH&touch=1`);
  await tp.waitForFunction(() => window.__court && window.__touch?.enabled, null, { timeout: 30000 });
  await wait(2500);
  const tshot = async (name) => {
    await tp.evaluate(() => {
      window.__court.holdRender = true;
      window.__court.renderNow(1 / 60);
    });
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
  const untilSnap = async (pred, ms = 4000) => {
    const t0 = Date.now();
    let s = await snap();
    while (!pred(s) && Date.now() - t0 < ms) {
      await wait(50);
      s = await snap();
    }
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
  check(t.ok, 'touch controls drive run, load, jump, wind-up and swing', s);
  await tctx.close();
}

// ---- soak: memory and GPU resources must not grow
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
for (const k of ['geometries', 'textures', 'programs']) {
  check(soak.after[k] <= soak.before[k], `soak: ${k} do not grow across mode switches`, { before: soak.before[k], after: soak.after[k] });
}

// ---- robustness: what players actually do (share links, old saved settings, keyboard-only menus)
{
  // These probes check loading, settings and keys, not drawing, so rendering is held from the very first
  // frame: a fresh page's first frame compiles every shader at once, which on a CI runner's software GPU
  // blocks the page's main thread (and every evaluate) for more than 30 s.
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
  const probe = async (label, url, init) => {
    const ctx = await browser.newContext({ viewport: { width: 1280, height: 720 } });
    await ctx.addInitScript(holdRendering);
    if (init) await ctx.addInitScript(init);
    const p = await ctx.newPage();
    const errs = [];
    p.on('pageerror', (e) => errs.push(e.message));
    p.on('console', (m) => {
      if (m.type() === 'error') errs.push('console: ' + m.text());
    });
    try {
      await p.goto(`http://localhost:${PORT}/${url}`);
      // ready, or on the crash screen (which never sets __menu)
      await p.waitForFunction(() => (window.__court && window.__menu) || document.querySelector('.crash'), null, {
        timeout: 60000,
        polling: 250,
      });
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
      return { p, ctx, st };
    } catch (e) {
      // record it and carry on, so the report still lists every other check
      check(false, `${label}: the page comes up`, { error: String(e).split('\n')[0], errs });
      return { p, ctx, st: {} };
    }
  };
  let r = await probe('mistyped position in a link', '?mode=spike&pos=OHH');
  check(r.st.mode === 'spike' && r.st.pos === 'OH' && !r.st.inMenu, 'a mistyped position falls back to OH and starts the drill', r.st);
  await r.ctx.close();
  r = await probe('unknown mode in a link', '?mode=spikey');
  check(r.st.inMenu, 'an unknown mode opens the menu', r.st);
  await r.ctx.close();
  r = await probe('corrupted saved settings', '', () =>
    localStorage.setItem('courtfeel.settings.v1', JSON.stringify({ fov: 'wide', volume: null })),
  );
  check(typeof r.st.fov === 'number', 'a stored setting of the wrong type falls back to its default', r.st);
  await r.ctx.close();
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
  await r.ctx.close();
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
  await r.ctx.close();
}

fs.writeFileSync(path.join(out, 'report.json'), JSON.stringify(report, null, 2));
console.log(errors.length ? 'CONSOLE ERRORS:\n' + errors.join('\n') : 'no console errors');
console.log(failures.length ? `FAILED CHECKS (${failures.length}):\n  ` + failures.join('\n  ') : 'all checks passed');
await browser.close();
stopServer();
process.exit(errors.length || failures.length ? 1 : 0);
