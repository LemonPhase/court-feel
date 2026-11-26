// Block sweep: what does the block do today, measured, before anyone changes it?
//
//   node scripts/block-sweep.mjs              the full sweep (3 matchups, 2 contact heights, 3 attacks, 5 angles, 4 speeds, 7 timings, 23 offsets)
//   BLOCK_SWEEP_SEEDS=4 node scripts/block-sweep.mjs
//
// Their hitter spikes over the net at our blocker with the real ball, the real spike solver and the
// real ContactSystem.tryBlock; only the blocker's jump is scripted (tests/blockSweep.ts says how).
// Every combination of matchup (AI vs AI, the user hitting, the user blocking), attack spot, shot
// angle, speed, jump timing and where along the hands the ball crosses the net is flown, and the
// block's answer is written down: touched or not, what kind, where it met the hands, where it went.
//
// Output: scripts/out/block-sweep/shots.csv (one row a shot) and summary.md (the tables below,
// also printed). Nothing here changes the game.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createServer } from 'vite';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const out = path.join(root, 'scripts', 'out', 'block-sweep');

const server = await createServer({ root, logLevel: 'error', server: { middlewareMode: true, hmr: false }, appType: 'custom' });
let mod;
try {
  mod = await server.ssrLoadModule('/tests/blockSweep.ts');
} catch (e) {
  await server.close();
  throw e;
}
const opts = { ...mod.DEFAULT_SWEEP };
if (process.env.BLOCK_SWEEP_SEEDS) opts.seeds = Number(process.env.BLOCK_SWEEP_SEEDS);

const t0 = Date.now();
const shots = [...mod.sweep(opts)];
const facts = mod.blockerFacts();
await server.close();

fs.mkdirSync(out, { recursive: true });
const cols = Object.keys(shots[0]);
const cell = (v) => (typeof v === 'number' ? (Number.isFinite(v) ? +v.toFixed(3) : '') : v === null ? '' : String(v));
fs.writeFileSync(path.join(out, 'shots.csv'), [cols.join(','), ...shots.map((s) => cols.map((c) => cell(s[c])).join(','))].join('\n'));

// ---------------------------------------------------------------- helpers
const lines = [];
const say = (s = '') => lines.push(s);
const pct = (n, d) => (d ? `${Math.round((100 * n) / d)}%` : '–');
const f2 = (x) => (Number.isFinite(x) ? x.toFixed(2) : '–');
const f0 = (x) => (Number.isFinite(x) ? x.toFixed(0) : '–');
const mean = (a) => (a.length ? a.reduce((s, x) => s + x, 0) / a.length : NaN);
const sd = (a) => {
  const m = mean(a);
  return a.length > 1 ? Math.sqrt(a.reduce((s, x) => s + (x - m) ** 2, 0) / (a.length - 1)) : NaN;
};
/** least squares y = a + b x, and Pearson r */
function fit(xs, ys) {
  const mx = mean(xs);
  const my = mean(ys);
  let sxy = 0;
  let sxx = 0;
  let syy = 0;
  for (let i = 0; i < xs.length; i++) {
    sxy += (xs[i] - mx) * (ys[i] - my);
    sxx += (xs[i] - mx) ** 2;
    syy += (ys[i] - my) ** 2;
  }
  return { slope: sxy / sxx, r: sxy / Math.sqrt(sxx * syy), n: xs.length };
}
function table(head, rows) {
  say(`| ${head.join(' | ')} |`);
  say(`|${head.map(() => '---').join('|')}|`);
  for (const r of rows) say(`| ${r.join(' | ')} |`);
  say();
}
const KINDS = ['stuff', 'soft', 'tool', 'recycle'];
const mix = (set) => {
  const t = set.filter((s) => s.touched);
  return [pct(t.length, set.length), ...KINDS.map((k) => pct(t.filter((s) => s.kind === k).length, t.length))];
};
const by = (arr, key) => {
  const m = new Map();
  for (const s of arr) {
    const k = typeof key === 'function' ? key(s) : s[key];
    if (!m.has(k)) m.set(k, []);
    m.get(k).push(s);
  }
  return m;
};
const step = opts.offsets[1] - opts.offsets[0];
const touched = shots.filter((s) => s.touched);

// ---------------------------------------------------------------- report
say('# Block sweep: the block as it is today');
say();
say(
  `${shots.length} shots, ${opts.seeds} seed(s) each, in ${((Date.now() - t0) / 1000).toFixed(0)} s. Hitter contact ${opts.contactYs.join(' or ')} m high, ${opts.contactOff} m off the net, aimed ${opts.depth} m deep. ` +
    `Blocker (MB): standing reach ${f2(facts.standReach)} m, block jump ${f2(facts.jump)} m, hands top at the peak ${f2(facts.handsTopAtPeak)} m. ` +
    `Hands half-width: AI ${f2(facts.halfWidthAi)} m, user ${f2(facts.halfWidthUser)} m (+ ball radius 0.105 each side).`,
);
say();
say(
  'Signs are folded: an offset or a yaw > 0 is toward the outer side (the nearer antenna; +x for the middle attack). An angle > 0 is a cross shot.',
);
say();

say('## 1. What a touch turns into, by jump timing');
say();
say(
  'Timing is how long after the blocker’s peak the ball reached the net (> 0 jumped early, < 0 late). Shares of kinds are of touched balls.',
);
say();
for (const [m, set] of by(shots, 'matchup')) {
  say(`**${m}**`);
  say();
  table(
    ['timing (s)', 'grade(s) given', 'touched', ...KINDS],
    [...by(set, 'timing')].map(([t, s]) => [t, [...new Set(s.filter((x) => x.touched).map((x) => x.grade))].join('/'), ...mix(s)]),
  );
}

say('## 2. How wide is the block, by shot angle');
say();
say(
  `Perfect timing (0), AI vs AI, contact ${opts.contactYs[0]} m. Width = how much of the ${f2(opts.offsets[0])}…${f2(opts.offsets.at(-1))} m sweep of net-crossing points got a touch (${step.toFixed(1)} m steps). ` +
    'Compare the hands’ own width with a ball either side of them. ' +
    '“Outside the hands” counts touches whose line crossed the net clear of the hands sideways.',
);
say();
{
  const base = shots.filter((s) => s.matchup === 'ai-ai' && s.timing === 0 && s.seed === 0 && s.contactY === opts.contactYs[0]);
  const rows = [];
  for (const [ang, s1] of by(base, 'angle'))
    for (const [sp, s2] of by(s1, 'speed')) {
      const per = by(s2, 'attack');
      const w = [];
      const wn = [];
      const outside = [];
      let rng = '';
      for (const [att, s3] of per) {
        const hit = s3.filter((s) => s.touched);
        w.push(hit.length * step);
        wn.push(2 * (facts.halfWidthAi + 0.105));
        outside.push(hit.filter((s) => Math.abs(s.crossOff) > facts.halfWidthAi + 0.105).length);
        if (att === 'outside' && hit.length) rng = `${f2(Math.min(...hit.map((s) => s.off)))} … ${f2(Math.max(...hit.map((s) => s.off)))}`;
      }
      rows.push([ang, sp, f2(mean(w)), f2(mean(wn)), rng, outside.reduce((a, b) => a + b, 0)]);
    }
  table(
    ['angle (°)', 'speed (m/s)', 'touch width (m)', 'net-plane width (m)', 'outside hitter: offsets touched', 'touches outside the hands'],
    rows,
  );
}
{
  const ghosts = shots.filter((s) => s.touched);
  const outsideHands = ghosts.filter(
    (s) => Math.abs(s.crossOff) > (s.matchup === 'user-blocks' ? facts.halfWidthUser : facts.halfWidthAi) + 0.105,
  );
  const behind = ghosts.filter((s) => s.hitZ > 0.105);
  const over = ghosts.filter((s) => s.crossY > s.handsTop + 0.105);
  say(
    `Across the whole sweep, ${pct(outsideHands.length, ghosts.length)} of touches came from balls whose line crossed the net clear of the hands sideways, ` +
      `${pct(over.length, ghosts.length)} from balls that crossed the net over the fingertips (higher than the hands’ top + the ball radius), ` +
      `and ${pct(behind.length, ghosts.length)} were met behind the net, on the blocker’s own side (z > ball radius).`,
  );
  say();
  table(
    ['angle (°)', 'touches', 'line crossed clear of the hands', 'line crossed over the fingertips', 'met behind the net'],
    [...by(ghosts, 'angle')].map(([a, s]) => [
      a,
      s.length,
      pct(
        s.filter((x) => Math.abs(x.crossOff) > (x.matchup === 'user-blocks' ? facts.halfWidthUser : facts.halfWidthAi) + 0.105).length,
        s.length,
      ),
      pct(s.filter((x) => x.crossY > x.handsTop + 0.105).length, s.length),
      pct(s.filter((x) => x.hitZ > 0.105).length, s.length),
    ]),
  );
}

say('## 3. Does the way in decide the way out?');
say();
say(
  'Fit of the outgoing direction (yaw along the floor) against the incoming one, per kind. A wall that the ball bounced off would show a strong link; slope ≈ 0 and r ≈ 0 means the way out ignores the way in.',
);
say();
table(
  ['kind', 'n', 'slope out/in', 'r', 'out yaw mean (°)', 'out yaw sd (°)', 'out speed vs in speed: r'],
  KINDS.map((k) => {
    const s = touched.filter((x) => x.kind === k);
    if (s.length < 3) return [k, s.length, '–', '–', '–', '–', '–'];
    const f = fit(
      s.map((x) => x.inYaw),
      s.map((x) => x.outYaw),
    );
    const g = fit(
      s.map((x) => x.inSpeed),
      s.map((x) => x.outSpeed),
    );
    return [k, s.length, f2(f.slope), f2(f.r), f0(mean(s.map((x) => x.outYaw))), f0(sd(s.map((x) => x.outYaw))), f2(g.r)];
  }),
);
say('Where stuffs land, by shot angle (folded x, m; z is metres back into the hitter’s court):');
say();
say(
  'Stuff depth by spike speed: ' +
    [
      ...by(
        touched.filter((x) => x.kind === 'stuff' && x.landZ !== null),
        'speed',
      ),
    ]
      .map(([sp, s]) => `${sp} m/s → ${f2(-mean(s.map((x) => x.landZ)))} m back`)
      .join(', ') +
    '.',
);
say();
table(
  ['angle (°)', 'stuffs', 'land x mean', 'land x sd', 'land z mean', 'land z sd'],
  [
    ...by(
      touched.filter((x) => x.kind === 'stuff' && x.landZ !== null),
      'angle',
    ),
  ].map(([a, s]) => [
    a,
    s.length,
    f2(mean(s.map((x) => x.landX))),
    f2(sd(s.map((x) => x.landX))),
    f2(mean(s.map((x) => x.landZ))),
    f2(sd(s.map((x) => x.landZ))),
  ]),
);

say('## 4. Does where it meets the hands decide what happens?');
say();
say(
  'By the part of the block it met (a hand or a forearm), how far up the hand (0 the heel, 1 the fingertips) and across it (folded: > 0 toward the outer side, the antenna’s). All matchups, all timings.',
);
say();
table(
  ['part', 'touches', ...KINDS],
  [...by(touched, 'part')].sort().map(([b, s]) => [b, s.length, ...mix(s).slice(1)]),
);
const upBucket = (a) =>
  a < 0.25 ? 'a. heel' : a < 0.5 ? 'b. palm' : a < 0.75 ? 'c. fingers' : a < 0.95 ? 'd. upper fingers' : 'e. fingertips';
table(
  ['up the hand', 'touches', ...KINDS],
  [
    ...by(
      touched.filter((s) => s.part === 'hand'),
      (s) => upBucket(s.along),
    ),
  ]
    .sort()
    .map(([b, s]) => [b, s.length, ...mix(s).slice(1)]),
);
const acrossBucket = (a) =>
  a < -0.5
    ? 'a. inner edge (thumb)'
    : a < 0
      ? 'b. inner half'
      : a < 0.5
        ? 'c. outer half'
        : a < 0.95
          ? 'd. outer edge'
          : 'e. past the outer edge';
table(
  ['across the hand', 'touches', ...KINDS],
  [
    ...by(
      touched.filter((s) => s.part === 'hand'),
      (s) => acrossBucket(s.across),
    ),
  ]
    .sort()
    .map(([b, s]) => [b, s.length, ...mix(s).slice(1)]),
);

say('## 5. Tools and block-outs');
say();
{
  const tools = touched.filter((s) => s.kind === 'tool');
  const outer = tools.filter((s) => s.outYaw > 0);
  const met = by(tools, (s) => (s.across > 0 ? 'met on the outer half' : 'met on the inner half'));
  say(
    `${tools.length} tools. ${pct(outer.length, tools.length)} went off toward the outer side, ${pct(tools.length - outer.length, tools.length)} back toward the court’s middle.`,
  );
  say();
  table(
    [
      '',
      'tools',
      'went outer',
      'landed out',
      'landed in, blocker’s court',
      'landed in, hitter’s court',
      'landed: metres back from the net',
      'landed: |x| (m)',
    ],
    [...met].map(([k, s]) => [
      k,
      s.length,
      pct(s.filter((x) => x.outYaw > 0).length, s.length),
      pct(s.filter((x) => x.landOn !== 'none' && !x.landIn).length, s.length),
      pct(s.filter((x) => x.landIn && x.landOn === 'blocker').length, s.length),
      pct(s.filter((x) => x.landIn && x.landOn === 'hitter').length, s.length),
      f2(mean(s.filter((x) => x.landZ !== null).map((x) => Math.abs(x.landZ)))),
      f2(mean(s.filter((x) => x.landX !== null).map((x) => Math.abs(x.landX)))),
    ]),
  );
}

say('## 6. Soft blocks');
say();
{
  const soft = touched.filter((s) => s.kind === 'soft');
  const rows = [...by(soft, 'speed')].map(([sp, s]) => [
    sp,
    s.length,
    f2(mean(s.map((x) => x.outSpeed))),
    f2(sd(s.map((x) => x.outSpeed))),
    f2(mean(s.map((x) => x.outVy))),
    pct(s.filter((x) => x.landOn === 'blocker').length, s.length),
  ]);
  table(['spike speed (m/s)', 'soft blocks', 'out speed mean', 'out speed sd', 'up speed mean', 'came down on the blocker’s side'], rows);
  const fh = fit(
    soft.filter((x) => x.part === 'hand').map((x) => x.along),
    soft.filter((x) => x.part === 'hand').map((x) => x.outVy),
  );
  const fs2 = fit(
    soft.map((x) => x.inSpeed),
    soft.map((x) => x.outVy),
  );
  say(`Up speed against how far up the hand it met it: r = ${f2(fh.r)}; against the spike's speed: r = ${f2(fs2.r)} (n = ${soft.length}).`);
  say();
}

const text = lines.join('\n');
fs.writeFileSync(path.join(out, 'summary.md'), text + '\n');
console.log(text);
console.log(`\nwrote ${path.relative(root, path.join(out, 'shots.csv'))} and summary.md`);
