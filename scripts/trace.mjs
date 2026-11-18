// Trace comparison: does a refactor play exactly like the code it started from?
//
//   npm run trace                    play this checkout twice and check that both runs are the same
//   npm run trace:compare            compare this checkout with the commit it branched from on origin/main
//   npm run trace:compare -- <ref>   compare this checkout with another commit or branch
//
// A seeded autopilot plays every drill on the manual clock, through the real input path, in a
// production build in headless Chromium. After every frame the whole simulation state (clock,
// ball, every athlete, score, the random stream, every contact and outcome) is folded into a hash,
// and four times a simulated second the hash and the state are written down. Two builds that play
// the same give the same hashes. Where they do not, the first difference is printed: the drill,
// the moment and the values.
//
// Nothing is stored in the repo. A feature that changes the play on purpose has nothing to
// re-record: this is run for a `refactor`, which must change nothing (docs/adr/0010).
//
// TRACE_SECONDS sets the simulated seconds per drill (60). Output: scripts/out/trace/. Exit code 1 on a difference.
import { createRequire } from 'node:module';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const { chromium } = require('playwright');
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const out = path.join(root, 'scripts', 'out', 'trace');
const SECONDS = Number(process.env.TRACE_SECONDS ?? 60);
/** the random seed every drill starts from (the same one the end-to-end run uses) */
const SEED = 2024;
/** how long a fresh page may take to come up on a software GPU */
const PAGE_MS = 300000;

/** every drill, and the Mini Rally from each position: `good` autopilots miss now and then, so more of the code runs */
const RUNS = [
  { mode: 'free', pos: 'OH', bot: 'good' },
  { mode: 'spike', pos: 'OH', bot: 'perfect' },
  { mode: 'spike', pos: 'MB', bot: 'good' },
  { mode: 'spike', pos: 'OPP', bot: 'sloppy' },
  // the slow-mo assist bends the clock: the same reps must take the same frames
  { mode: 'spike', pos: 'OH', bot: 'good', slowmo: true },
  { mode: 'block', pos: 'MB', bot: 'good' },
  { mode: 'receive', pos: 'L', bot: 'good' },
  { mode: 'setter', pos: 'S', bot: 'good' },
  { mode: 'serve', pos: 'OH', bot: 'good' },
  { mode: 'rally', pos: 'OH', bot: 'good' },
  { mode: 'rally', pos: 'OPP', bot: 'good' },
  { mode: 'rally', pos: 'MB', bot: 'good' },
  { mode: 'rally', pos: 'S', bot: 'good' },
  { mode: 'rally', pos: 'L', bot: 'good' },
];

const git = (args, cwd = root) => execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();

/** build a checkout for production into `dist` */
function build(cwd, dist) {
  fs.rmSync(dist, { recursive: true, force: true });
  execFileSync('npx', ['vite', 'build', '--outDir', dist, '--emptyOutDir', '--logLevel', 'error'], {
    cwd,
    stdio: ['ignore', 'inherit', 'inherit'],
  });
}

const TYPES = {
  '.html': 'text/html',
  '.js': 'text/javascript',
  '.css': 'text/css',
  '.json': 'application/json',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
};

/** serve a built app from a loopback port of its own */
function serve(dist) {
  const server = http.createServer((req, res) => {
    const rel = decodeURIComponent(new URL(req.url, 'http://x').pathname);
    const file = path.join(dist, rel === '/' ? 'index.html' : rel);
    if (!file.startsWith(dist) || !fs.existsSync(file) || !fs.statSync(file).isFile()) {
      res.writeHead(404).end();
      return;
    }
    res.writeHead(200, { 'content-type': TYPES[path.extname(file)] ?? 'application/octet-stream' });
    fs.createReadStream(file).pipe(res);
  });
  return new Promise((resolve) =>
    server.listen(0, '127.0.0.1', () => resolve({ url: `http://127.0.0.1:${server.address().port}/`, close: () => server.close() })),
  );
}

/**
 * Runs in the page before its scripts: the game is on the manual clock from the moment it exists.
 * Left alone, the start screen's autopilot plays until the trace takes over, for as long as the
 * machine took to get here, and every run would start from a different moment.
 */
function holdTheClock() {
  let game;
  Object.defineProperty(window, '__court', {
    configurable: true,
    get: () => game,
    set: (g) => {
      game = g;
      g.manual = true;
      g.holdRender = true;
    },
  });
}

/**
 * Runs in the page: play one drill and write the state down. It reads the game through
 * `window.__court` only, so the same reader works on both builds of a comparison. When a refactor
 * moves one of these fields, this function is where both shapes are read.
 */
function playOne({ mode, pos, bot, slowmo = false, seconds, seed }) {
  const g = window.__court;
  // a replay stops the clock until someone watches it: there is no one here
  g.settings.replays = false;
  g.settings.firstPerson = false;
  g.settings.slowmoAssist = slowmo;
  g.rng.reseed(seed);
  g.startMode(mode, pos);
  window.__menu.showStart(false);
  g.enableBot(bot);

  const events = [];
  const who = (a) => (a.isUser ? 'me' : `${a.role}${a.side === 1 ? 'H' : 'A'}`);
  const offs = [
    g.events.on('contact', (e) => events.push(`${g.simTime.toFixed(4)} ${who(e.athlete)} ${e.kind} ${e.grade} ${e.speed}`)),
    g.events.on('aiContact', (e) => events.push(`${g.simTime.toFixed(4)} ${who(e.athlete)} ${e.kind} ai ${e.speed}`)),
    g.events.on('outcome', (o) => events.push(`${g.simTime.toFixed(4)} outcome ${o.kind} ${o.side}`)),
  ];

  /** the state as labelled values: numbers as they are, anything else as text */
  const read = () => {
    const s = [];
    const put = (label, v) => s.push([label, typeof v === 'boolean' ? Number(v) : (v ?? 'none')]);
    const v3 = (label, v) => {
      put(`${label}.x`, v.x);
      put(`${label}.y`, v.y);
      put(`${label}.z`, v.z);
    };
    put('simTime', g.simTime);
    put('ballLive', g.ballLive);
    put('rng', g.rng.s);
    put('ball.active', g.ball.active);
    put('ball.rest', g.ball.state.rest);
    v3('ball.p', g.ball.state.p);
    v3('ball.v', g.ball.state.v);
    v3('ball.w', g.ball.state.w);
    put('ball.knuckle', g.ball.state.knuckle);
    put('ball.kt', g.ball.state.kt);
    put('ball.lastTouch', g.ball.lastTouch ? `${g.ball.lastTouch.kind} ${g.ball.lastTouch.side}` : 'none');
    g.athletes.forEach((a, i) => {
      const name = `athlete[${i} ${who(a)}]`;
      v3(`${name}.pos`, a.pos);
      v3(`${name}.vel`, a.vel);
      put(`${name}.yaw`, a.yaw);
      put(`${name}.state`, a.state);
      put(`${name}.action`, a.action ? a.action.kind : 'none');
    });
    put('mode.score', g.mode.score);
    put('mode.streak', g.mode.streak);
    put('mode.reps', g.mode.reps);
    put('events', events.length);
    return s;
  };

  // FNV-1a over the exact bits of every number and the characters of every text
  const f64 = new Float64Array(1);
  const bytes = new Uint8Array(f64.buffer);
  let hash = 0x811c9dc5;
  const mix = (byte) => {
    hash ^= byte;
    hash = Math.imul(hash, 0x01000193) >>> 0;
  };
  const fold = (state) => {
    for (const [, v] of state) {
      if (typeof v === 'number') {
        f64[0] = v;
        for (let i = 0; i < 8; i++) mix(bytes[i]);
      } else for (const ch of String(v)) mix(ch.charCodeAt(0) & 0xff);
    }
  };

  const samples = [];
  const frames = Math.round(seconds * 60);
  let folded = 0;
  for (let f = 1; f <= frames; f++) {
    g.simulate(1 / 60);
    const state = read();
    fold(state);
    for (; folded < events.length; folded++) for (const ch of events[folded]) mix(ch.charCodeAt(0) & 0xff);
    if (f % 15 === 0) samples.push({ frame: f, t: g.simTime, hash: hash.toString(16).padStart(8, '0'), state });
  }
  offs.forEach((off) => off());
  g.bot = null;
  return { samples, events, simTime: g.simTime };
}

/** play every drill in a built app and return the traces */
async function record(dist, label) {
  const server = await serve(dist);
  const browser = await chromium.launch({ args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'] });
  const t0 = Date.now();
  try {
    const page = await browser.newPage({ viewport: { width: 640, height: 360 } });
    const errors = [];
    // an app that throws while it starts never comes up: say why at once, not after the whole wait
    let starting = true;
    let failStart = () => {};
    const threw = new Promise((_, reject) => (failStart = reject));
    threw.catch(() => {});
    page.on('pageerror', (e) => {
      errors.push(String(e));
      if (starting) failStart(new Error(`${label}: the app threw while it was starting: ${e.message}`));
    });
    await page.addInitScript(holdTheClock);
    await page.goto(server.url, { timeout: PAGE_MS });
    const up = page.waitForFunction(() => window.__court && window.__menu, null, { timeout: PAGE_MS, polling: 250 });
    up.catch(() => {});
    await Promise.race([up, threw]);
    starting = false;
    const runs = [];
    for (const run of RUNS) {
      const name = `${run.mode}/${run.pos}/${run.bot}${run.slowmo ? '/slow-mo assist' : ''}`;
      const r = await page.evaluate(playOne, { ...run, seconds: SECONDS, seed: SEED });
      if (errors.length) throw new Error(`${label}: ${name} threw in the page: ${errors[0]}`);
      runs.push({ name, ...r });
    }
    console.log(
      `${label}: ${runs.length} drills, ${SECONDS} s each, ${runs.reduce((n, r) => n + r.events.length, 0)} contacts and outcomes, in ${((Date.now() - t0) / 1000).toFixed(0)} s`,
    );
    return runs;
  } finally {
    await browser.close();
    server.close();
  }
}

const show = (v) => (typeof v === 'number' ? String(v) : `'${v}'`);

/**
 * The first difference between two traces, as lines to print (none when they are the same). The
 * drills share one page and one clock, so only the first drill that differs is explained: the
 * ones after it may only differ because it did.
 */
function difference(a, b, nameA, nameB) {
  const differs = (ra, rb) => ra.samples.some((s, k) => s.hash !== rb.samples[k]?.hash) || ra.events.length !== rb.events.length;
  const at = a.findIndex((ra, i) => differs(ra, b[i]));
  if (at < 0) return [];
  const ra = a[at];
  const rb = b[at];
  const k = Math.max(
    ra.samples.findIndex((s, i) => s.hash !== rb.samples[i]?.hash),
    0,
  );
  const sa = ra.samples[k];
  const sb = rb.samples[k];
  const lines = [`${ra.name}: differs by frame ${sa.frame} (${(sa.frame / 60).toFixed(2)} s into the drill)`];
  const fields = sa.state.filter(([label, v], i) => sb.state[i]?.[0] !== label || sb.state[i][1] !== v);
  for (const [label, v] of fields.slice(0, 8)) {
    const other = sb.state.find(([l]) => l === label);
    lines.push(`    ${label}: ${show(v)} (${nameA}) and ${other ? show(other[1]) : 'nothing'} (${nameB})`);
  }
  if (fields.length > 8) lines.push(`    and ${fields.length - 8} more values`);
  if (!fields.length) lines.push('    the states match again at this moment: they differed in the quarter second before it');
  const e = ra.events.findIndex((x, i) => x !== rb.events[i]);
  if (e >= 0 || ra.events.length !== rb.events.length) {
    const first = e >= 0 ? e : Math.min(ra.events.length, rb.events.length);
    lines.push(
      `    first different contact or outcome: '${ra.events[first] ?? 'nothing'}' (${nameA}) and '${rb.events[first] ?? 'nothing'}' (${nameB})`,
    );
  }
  const later = a.filter((r, i) => i > at && differs(r, b[i])).map((r) => r.name);
  if (later.length) lines.push(`also different, perhaps only because of it: ${later.join(', ')}`);
  return lines;
}

const save = (name, runs) => fs.writeFileSync(path.join(out, `${name}.json`), JSON.stringify(runs));

/** check out a commit beside this one and build it. It uses this checkout's node_modules when the lockfile is the same. */
function buildRef(ref) {
  const dir = path.join(out, 'base');
  try {
    git(['worktree', 'remove', '--force', dir]);
  } catch {
    // no such worktree yet
  }
  git(['worktree', 'add', '--detach', dir, ref]);
  const sameLock =
    fs.readFileSync(path.join(dir, 'package-lock.json'), 'utf8') === fs.readFileSync(path.join(root, 'package-lock.json'), 'utf8');
  if (sameLock) fs.symlinkSync(path.join(root, 'node_modules'), path.join(dir, 'node_modules'), 'dir');
  else execFileSync('npm', ['ci'], { cwd: dir, stdio: ['ignore', 'inherit', 'inherit'] });
  const dist = path.join(out, 'base-dist');
  build(dir, dist);
  git(['worktree', 'remove', '--force', dir]);
  return dist;
}

fs.mkdirSync(out, { recursive: true });
const [command = 'self', arg] = process.argv.slice(2);
const headDist = path.join(out, 'head-dist');
build(root, headDist);
let lines;
if (command === 'compare') {
  const ref = arg ?? git(['merge-base', 'HEAD', 'origin/main']);
  const sha = git(['rev-parse', '--short=7', ref]);
  console.log(
    `comparing this checkout (${git(['rev-parse', '--short=7', 'HEAD'])}${git(['status', '--porcelain']) ? ' with local changes' : ''}) with ${arg ?? 'where it left origin/main'} (${sha})`,
  );
  const base = await record(buildRef(ref), sha);
  const head = await record(headDist, 'this checkout');
  save('base', base);
  save('head', head);
  lines = difference(base, head, sha, 'this checkout');
  if (!lines.length) console.log(`same play: every drill gives the same states, contacts and outcomes as ${sha}`);
} else if (command === 'self') {
  const first = await record(headDist, 'first run');
  const second = await record(headDist, 'second run');
  save('head', first);
  lines = difference(first, second, 'first run', 'second run');
  if (!lines.length) console.log('repeatable: two runs of this checkout give the same states, contacts and outcomes');
} else {
  console.error(`unknown command '${command}': use 'self' or 'compare [ref]'`);
  process.exit(2);
}
if (lines.length) {
  console.error(lines.join('\n'));
  process.exit(1);
}
