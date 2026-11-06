// Checks a deployed leaderboard end to end (the real function and its Redis store), the way two
// players would use it. Run it against a preview once Upstash is attached:
//
//   node scripts/leaderboard-check.mjs https://court-feel-git-<branch>-<team>.vercel.app
//   node scripts/leaderboard-check.mjs <url> --admin-token <token>   (also removes the test runs)
//
// It plays two browsers, A and B (two random player ids): A puts a run on the Outside Hitter season
// board, B sees it; A's lost answer is retried and counts once; a second run within 30 s is refused
// with a wait; after the wait a worse run keeps A's best; and the health check says which set of
// boards answered (previews must say cf:dev, production cf:prod). It writes test runs ("check A …")
// to the boards it talks to, so against production it asks for --production and an admin token.
import { randomUUID } from 'node:crypto';

const args = process.argv.slice(2);
const base = args.find((a) => /^https?:\/\//.test(a));
const flag = (name) => {
  const i = args.indexOf(name);
  return i >= 0 ? (args[i + 1] ?? true) : null;
};
const adminToken = flag('--admin-token');
if (!base) {
  console.error('usage: node scripts/leaderboard-check.mjs <deployment url> [--admin-token <token>] [--production]');
  process.exit(2);
}
const api = new URL('api/leaderboard', base.endsWith('/') ? base : `${base}/`).toString();
const board = '1:spike:OH';
let failures = 0;
const check = (ok, what, extra = '') => {
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${what}${extra ? `  (${extra})` : ''}`);
  if (!ok) failures++;
};
const wait = (s) => new Promise((r) => setTimeout(r, s * 1000));

async function call(method, query = '', body, headers = {}) {
  const res = await fetch(`${api}${query}`, {
    method,
    headers: { 'content-type': 'application/json', ...headers },
    body: body ? JSON.stringify(body) : undefined,
  });
  let json = null;
  try {
    json = await res.json();
  } catch {
    /* not json */
  }
  return { status: res.status, json, cache: res.headers.get('cache-control') ?? '' };
}

const tag = randomUUID().slice(0, 4);
const run = (player, name, points) => ({
  id: randomUUID(),
  board,
  player,
  name,
  reps: new Array(20).fill(points),
  perfects: 4,
  bestStreak: 3,
  ms: 150_000,
  cam: 'tp',
  input: 'mouse',
  hand: 'right',
  build: 'leaderboard-check',
});

// ---- 0. is it there, and which boards does it write?
const health = await call('GET', '?view=health');
if (health.status === 503) {
  console.log(`The leaderboard isn't set up on ${base} (503): attach Upstash for Redis to the Vercel project and redeploy.`);
  process.exit(1);
}
check(health.status === 200 && health.json?.ok, 'health check answers', JSON.stringify(health.json));
const prefix = health.json?.boards;
check(health.json?.store === 'upstash', 'the store is Upstash', health.json?.store);
if (prefix === 'cf:prod' && !(flag('--production') && adminToken)) {
  console.log('This is production (cf:prod). Run with --production --admin-token <token> to write and then remove test runs.');
  process.exit(1);
}
console.log(`boards: ${prefix}`);

const A = randomUUID();
const B = randomUUID();
const nameA = `check A ${tag}`;

// ---- 1. A submits, B reads
const first = run(A, nameA, 150);
const put = await call('POST', '', first);
check(put.status === 200 && put.json?.saved === true, 'browser A: the run goes on the board', `status ${put.status}`);
const total = put.json?.me?.total;
const mine = await call('GET', `?view=me&board=${board}&player=${A}`);
check(mine.json?.me?.total === total && mine.cache.includes('no-store'), "A's own line is fresh and never cached");
// the public list may be cached at the edge for a few seconds
await wait(12);
const seen = await call('GET', `?board=${board}&player=${B}`);
const listed = seen.json?.top?.some((r) => r.name === nameA) || (seen.json?.count ?? 0) > 10;
check(listed, "browser B sees A's run on the public board", `count ${seen.json?.count}`);
check(seen.cache.includes('s-maxage'), 'the public board can be cached at the edge', seen.cache);

// ---- 2. a lost answer: the same run again counts once
const retry = await call('POST', '', first);
check(retry.status === 200 && retry.json?.repeat === true && retry.json?.me?.total === total, 'a retry of the same run counts once');

// ---- 3. one run at a time
const quick = await call('POST', '', run(A, nameA, 160));
check(
  quick.status === 429 && quick.json?.retryAfterS > 0,
  'a second run within 30 s is refused with a wait',
  `${quick.json?.retryAfterS} s`,
);

// ---- 4. a worse run keeps the best
await wait((quick.json?.retryAfterS ?? 30) + 1);
const worse = await call('POST', '', run(A, nameA, 100));
check(worse.status === 200 && worse.json?.saved === false && worse.json?.me?.total === total, 'a worse run keeps the best');

// ---- 5. the medal table answers
const medals = await call('GET', '?view=medals');
check(medals.status === 200 && Array.isArray(medals.json?.rows), 'the medal table answers', `depth ${medals.json?.depth}`);

// ---- 6. clean up
if (adminToken) {
  const del = await call('DELETE', `?board=${board}&player=${A}`, undefined, { authorization: `Bearer ${adminToken}` });
  check(del.status === 200 && del.json?.removed === true, 'the admin token removes the test run');
} else console.log(`(test run "${nameA}" left on ${prefix}: pass --admin-token to remove it)`);

console.log(failures ? `${failures} check(s) failed` : 'all checks passed');
process.exit(failures ? 1 : 0);
