// End-to-end check: `npm run e2e` (needs Playwright + Chromium available).
// Starts a Vite dev server, drives every drill with the autopilot bots through
// the real input path, takes FP/TP screenshots of key moments, records
// console errors, and reports frame time, draw calls and memory growth.
// Output: scripts/out/*.png and scripts/out/report.json
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

const browser = await chromium.launch({ args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist', '--enable-precise-memory-info', '--js-flags=--expose-gc'] });
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
const report = { modes: {}, shots: [], perf: {}, errors };

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
    g.startMode(mode, pos);
    window.__menu.showStart(false);
    if (call) g.mode.selectCall?.(call);
    g.hud.setVisible(true);
    if (bot) g.enableBot(bot);
    window.log = [];
    window.offs?.forEach((f) => f());
    window.offs = [
      g.events.on('contact', (e) => window.log.push({ who: e.athlete.isUser ? 'me' : e.athlete.role + (e.athlete.side === 1 ? 'H' : 'A'), kind: e.kind, grade: e.grade, kmh: Math.round(e.speed * 3.6) })),
      g.events.on('outcome', (o) => window.log.push({ outcome: o.kind, side: o.side })),
    ];
  };
});

// ---- spike drill: TP and FP perfect spikes, impact, replay
for (const fp of [false, true]) {
  const tag = fp ? 'fp' : 'tp';
  await page.evaluate((fp) => {
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
  }, fp);
  await shot(`10_spike_contact_${tag}`);
  await page.evaluate(() => window.__court.play(0.1));
  await shot(`11_spike_flight_${tag}`);
  await page.evaluate(() => {
    window.until(() => window.impact, 200);
    window.__court.play(0.08);
  });
  await shot(`12_spike_impact_${tag}`);
  if (!fp) {
    await page.evaluate(() => {
      const g = window.__court;
      window.until(() => g.fx.replaying, 200);
      g.play(1.1);
    });
    await shot('13_replay_hitter');
    await page.evaluate(() => window.__court.play(1.25));
    await shot('14_replay_contact');
    await page.evaluate(() => window.__court.play(2.0));
    await shot('15_replay_impact');
  }
}

// ---- every drill with its bot (and the rally both all-AI and with the user)
const runs = [
  ['spike', 'OH'], ['spike', 'OPP'], ['spike', 'MB'], ['spike', 'S'], ['spike', 'L'],
  // spike drill set calls (keys 2 and 3): go / inside 3, shoot / back quick, fast back / back 2
  ['spike', 'OH', 1], ['spike', 'OH', 2], ['spike', 'MB', 1], ['spike', 'MB', 2], ['spike', 'OPP', 1], ['spike', 'OPP', 2],
  ['block', 'MB'], ['receive', 'L'], ['setter', 'S'], ['free', 'OH'], ['rally', 'MB'], ['rally', 'L'],
];
for (const [mode, pos, call = 0] of runs) {
  const r = await page.evaluate(([mode, pos, call]) => {
    window.start(mode, pos, false, 'perfect', call);
    const g = window.__court;
    for (let i = 0; i < 60 * 30; i++) g.play(1 / 60);
    const mine = window.log.filter((l) => l.who === 'me');
    const grades = {};
    for (const m of mine) grades[m.kind + ':' + m.grade] = (grades[m.kind + ':' + m.grade] || 0) + 1;
    return { score: g.mode.score, reps: g.mode.reps, home: g.mode.scoreHome, away: g.mode.scoreAway, myContacts: grades, events: window.log.length };
  }, [mode, pos, call]);
  const key = call ? `${mode}_${pos}_call${call + 1}` : `${mode}_${pos}`;
  report.modes[key] = r;
  console.log(mode, pos + (call ? ` call${call + 1}` : ''), JSON.stringify(r));
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
  const snap = () => tp.evaluate(() => {
    const g = window.__court;
    return { state: g.me.state, sprint: g.me.cmd.sprint, stick: g.input.stick.active, held: [...g.input.held], action: g.me.action?.kind ?? null, yaw: g.rig.yaw };
  });
  const btn = (sel) => tp.evaluate((s) => {
    const r = document.querySelector(s).getBoundingClientRect();
    return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
  }, sel);
  const t = { ok: true, steps: {} };
  await touch('touchStart', 1, 160, 300);
  await touch('touchMove', 1, 160, 300 - 90);
  await wait(500);
  t.steps.run = await snap();
  const j = await btn('.t-jump');
  await touch('touchStart', 2, j.x, j.y);
  await wait(150);
  t.steps.load = await snap();
  await touch('touchEnd', 2);
  await wait(120);
  t.steps.air = await snap();
  await touch('touchStart', 3, 560, 140);
  await wait(250);
  await touch('touchMove', 3, 640, 150);
  await wait(60);
  t.steps.windup = await snap();
  await tshot('21_touch_windup');
  await touch('touchEnd', 3);
  await wait(100);
  t.steps.swing = await snap();
  await touch('touchEnd', 1);
  const s = t.steps;
  t.ok = s.run.sprint && s.run.stick && s.load.state === 'load' && s.load.held.includes('Space') && s.air.state === 'air' && !s.air.held.includes('Space')
    && s.windup.action === 'windup' && s.windup.yaw !== 0 && s.swing.action === 'swing' && !s.swing.held.includes('Mouse0');
  report.touch = t;
  console.log('touch', t.ok ? 'ok' : 'FAILED', JSON.stringify(s));
  await tctx.close();
}

// ---- soak: memory and GPU resources must not grow
const soak = await page.evaluate(async (secs) => {
  const g = window.__court;
  const mem = () => (performance.memory ? performance.memory.usedJSHeapSize / 1048576 : 0);
  const sample = () => ({ heapMB: +mem().toFixed(1), geometries: g.renderer.info.memory.geometries, textures: g.renderer.info.memory.textures, programs: g.renderer.info.programs?.length ?? 0 });
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

fs.writeFileSync(path.join(out, 'report.json'), JSON.stringify(report, null, 2));
console.log(errors.length ? 'CONSOLE ERRORS:\n' + errors.join('\n') : 'no console errors');
await browser.close();
stopServer();
process.exit(errors.length ? 1 : 0);
