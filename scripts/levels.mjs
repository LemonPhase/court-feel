// Measures the levels of play (`LEVELS` in src/config.ts) on all-AI Mini Rallies: `npm run levels`.
// Run it after changing a level's numbers: the levels are tuned against what this prints.
//
// For each level it plays two kinds of rally on the manual clock (results do not depend on machine speed):
//   - the league: both teams at the level, as in the game. Its stat line is what the league looks like.
//   - the test hitter: a Pro home side that swings on time and plays its usual shots (line, cross,
//     sharp, seam) without looking for the open spot, against an away side of the level. Its kill
//     rate stands in for what a player who hits on time, without placing the ball, scores there.
//
//   node scripts/levels.mjs [seconds per run, default 3000] [seeds, default 2024,7,11]
//
// A figure carries about 3 points of noise at 9000 s a level. Uses the game's test hooks (`manual`,
// `holdRender`, `autoUser`, `probeLevels`, `play`); nothing here is the player's input path.
import { createRequire } from 'node:module';
import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const { chromium } = require('playwright');
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PORT = Number(process.env.LEVELS_PORT ?? 5198);
const seconds = Number(process.argv[2] ?? 3000);
const seeds = (process.argv[3] ?? '2024,7,11').split(',').map(Number);
const LEVELS = ['rec', 'club', 'national', 'pro'];

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

/** in the page: play `secs` of all-AI rallies and return every contact, setter's read and point */
const playRallies = async ({ level, seed, secs, hitter }) => {
  const g = window.__court;
  const { LEVELS } = await import('/src/config.ts');
  g.manual = true;
  g.holdRender = true;
  g.autoUser = true;
  g.settings.replays = false;
  g.settings.level = level;
  const pro = LEVELS.pro;
  g.probeLevels = hitter ? { home: { ...pro, attack: { ...pro.attack, openIn: 0, openOut: 0 } }, away: LEVELS[level] } : null;
  g.rng.reseed(seed);
  g.startMode('rally', 'OH');
  window.__menu?.showStart(false);
  const log = [];
  const t = () => +g.simTime.toFixed(3);
  g.events.on('contact', (ev) =>
    log.push({
      e: 'c',
      t: t(),
      side: ev.athlete.side,
      role: ev.athlete.role,
      kind: ev.kind,
      grade: ev.grade,
      speed: ev.speed,
      tip: ev.tip,
      y: ev.point.y,
    }),
  );
  g.events.on('aiContact', (ev) =>
    log.push({ e: 'c', t: t(), side: ev.athlete.side, role: ev.athlete.role, kind: ev.kind, speed: ev.speed }),
  );
  const mode = g.mode;
  for (const team of [mode.home, mode.away]) {
    const prev = team.onRead;
    team.onRead = (r) => {
      log.push({ e: 'r', t: t(), side: team.side, call: r.call });
      prev?.(r);
    };
  }
  const endPoint = mode.endPoint.bind(mode);
  mode.endPoint = (winner) => {
    if (mode.phase !== 'dead') log.push({ e: 'p', t: t(), winner, reason: mode.reason });
    endPoint(winner);
  };
  for (let done = 0; done < secs; done += 20) {
    g.play(20);
    await new Promise((r) => setTimeout(r, 0));
  }
  g.probeLevels = null;
  return log;
};

const median = (xs) => (xs.length ? [...xs].sort((a, b) => a - b)[Math.floor(xs.length / 2)] : NaN);
const pct = (a, b) => (b ? `${Math.round((100 * a) / b)}%` : '-');

/** one stat line from the logs of a level's runs; `side`: count the attacks of this side only */
function stats(logs, side) {
  const S = {
    points: 0,
    att: 0,
    kill: 0,
    stuff: 0,
    err: 0,
    kept: 0,
    block: 0,
    attIn: 0,
    killIn: 0,
    hard: 0,
    hardKill: 0,
    tips: 0,
    tipKill: 0,
  };
  Object.assign(S, { serves: 0, jumps: 0, unreturned: 0, recv: 0, recvIn: 0, spikes: [], serveSpeeds: [], perRally: [] });
  for (const log of logs) {
    let rally = [];
    for (const ev of log) {
      rally.push(ev);
      if (ev.e !== 'p') continue;
      S.points++;
      const cs = rally.filter((x) => x.e === 'c');
      const serve = cs.find((x) => x.kind === 'serve');
      if (serve) {
        S.serves++;
        S.serveSpeeds.push(serve.speed * 3.6);
        // a jump serve is met well above a standing reach
        if (serve.y > 2.9) S.jumps++;
        const after = cs.slice(cs.indexOf(serve) + 1);
        // not returned: the receiving side never got it back over (an ace, or a pass nobody could play)
        if (!after.some((x) => x.side === serve.side) && ev.winner === serve.side) S.unreturned++;
        const read = rally.find((x) => x.e === 'r' && x.side !== serve.side && x.t > serve.t);
        const firstAttack = after.find((x) => x.kind === 'spike' || x.kind === 'tip');
        if (read && (!firstAttack || read.t < firstAttack.t)) {
          S.recv++;
          if (read.call === 'in') S.recvIn++;
        }
      }
      let attacks = 0;
      for (let i = 0; i < cs.length; i++) {
        const a = cs[i];
        if (a.kind !== 'spike' && a.kind !== 'tip') continue;
        attacks++;
        if (side && a.side !== side) continue;
        S.att++;
        const rest = cs.slice(i + 1);
        // what the defenders did before the attacker's side played the ball again (if it ever did)
        const again = rest.find((x) => x.side === a.side && x.kind !== 'block');
        const def = rest.filter((x) => x.side !== a.side && (!again || x.t < again.t));
        const dug = def.some((x) => x.kind === 'dig' || x.kind === 'pass');
        const blocked = def.some((x) => x.kind === 'block');
        const outcome = again ? 'kept' : ev.winner === a.side ? 'kill' : blocked && !dug ? 'stuff' : !blocked && !dug ? 'err' : 'kept';
        S[outcome]++;
        if (blocked) S.block++;
        const tip = a.kind === 'tip' || a.tip;
        if (!tip) S.spikes.push(a.speed * 3.6);
        const read = [...rally].reverse().find((x) => x.e === 'r' && x.side === a.side && x.t < a.t);
        if (read?.call === 'in') {
          S.attIn++;
          if (outcome === 'kill') S.killIn++;
        }
        if (!blocked && !tip && a.speed * 3.6 >= 80) {
          S.hard++;
          if (outcome === 'kill') S.hardKill++;
        }
        if (!blocked && tip) {
          S.tips++;
          if (outcome === 'kill') S.tipKill++;
        }
      }
      S.perRally.push(attacks);
      rally = [];
    }
  }
  return S;
}

const browser = await chromium.launch({ args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'] });
const errors = [];
/** the logs of one level's runs, one per seed, in pages of their own that run side by side */
const runLevel = (level, hitter) =>
  Promise.all(
    seeds.map(async (seed) => {
      const page = await browser.newPage();
      page.on('pageerror', (e) => errors.push(`${level} seed ${seed}: ${String(e).slice(0, 200)}`));
      await page.goto(`http://localhost:${PORT}/`, { waitUntil: 'load' });
      await page.waitForFunction(() => !!window.__court, null, { timeout: 120000 });
      const log = await page.evaluate(playRallies, { level, seed, secs: seconds, hitter });
      await page.close();
      return log;
    }),
  );

const league = {};
const hitter = {};
for (const level of LEVELS) {
  process.stderr.write(`${level}: the league and the test hitter, ${seeds.length} x ${seconds} s each\n`);
  league[level] = stats(await runLevel(level, false), 0);
  hitter[level] = stats(await runLevel(level, true), 1);
}
await browser.close();
stopServer();

const row = (label, cells) => console.log(`${label.padEnd(34)}${cells.map((c) => String(c).padStart(10)).join('')}`);
const table = (title, of, rows) => {
  console.log(`\n${title}`);
  row('', LEVELS);
  for (const [label, cell] of rows)
    row(
      label,
      LEVELS.map((l) => cell(of[l])),
    );
};
const outcome = [
  ['attacks', (s) => s.att],
  ['kill', (s) => pct(s.kill, s.att)],
  ['kept in play', (s) => pct(s.kept, s.att)],
  ['stuffed', (s) => pct(s.stuff, s.att)],
  ['hit out or netted', (s) => pct(s.err, s.att)],
  ['touches the block', (s) => pct(s.block, s.att)],
  ['kill in system', (s) => pct(s.killIn, s.attIn)],
];
table('The test hitter (a Pro side that does not look for the open spot) against each level', hitter, [
  ...outcome,
  ['clean 80+ km/h spike: kill', (s) => pct(s.hardKill, s.hard)],
  ['clean tip or roll: kill', (s) => pct(s.tipKill, s.tips)],
]);
table('Each league against itself', league, [
  ...outcome,
  ['median spike (km/h)', (s) => Math.round(median(s.spikes))],
  ['attacks per rally', (s) => (s.perRally.reduce((a, b) => a + b, 0) / Math.max(1, s.perRally.length)).toFixed(2)],
  ['jump serves', (s) => pct(s.jumps, s.serves)],
  ['median serve (km/h)', (s) => Math.round(median(s.serveSpeeds))],
  ['serves not returned', (s) => pct(s.unreturned, s.serves)],
  ['reception in system', (s) => pct(s.recvIn, s.recv)],
]);
if (errors.length) {
  console.error(`\npage errors:\n${errors.join('\n')}`);
  process.exit(1);
}
