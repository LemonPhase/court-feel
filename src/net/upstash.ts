// The leaderboard store in production: Upstash Redis over its REST API (plain fetch, no client library).
import type { Store, SubmitOp, SubmitOutcome } from './server.js';

type Command = (string | number)[];

/**
 * Recording a run, as one script: Redis runs it alone, so a run's rank score and its details are
 * always written together, and two submissions can never interleave. Mirrors MemoryStore.submit.
 * KEYS: board, entries, names, submission, player limit, address limit
 * ARGV: player, score, entry, name, submission id, player window s, address window s, address max,
 *       submission ttl s, board ttl s (0 = keep)
 * Returns { 'repeat' | 'recorded', '1' won | '0' } or { 'limited', seconds to wait }.
 */
export const SUBMIT_SCRIPT = `
local done = redis.call('GET', KEYS[4])
if done then return {'repeat', done} end
local holder = redis.call('GET', KEYS[5])
if holder and holder ~= ARGV[5] then return {'limited', tostring(redis.call('TTL', KEYS[5]))} end
local n = redis.call('INCR', KEYS[6])
if n == 1 then redis.call('EXPIRE', KEYS[6], ARGV[7]) end
if n > tonumber(ARGV[8]) then return {'limited', tostring(redis.call('TTL', KEYS[6]))} end
redis.call('SET', KEYS[5], ARGV[5], 'EX', ARGV[6])
local prev = redis.call('ZSCORE', KEYS[1], ARGV[1])
local won = (not prev) or (tonumber(ARGV[2]) > tonumber(prev))
if won then
  redis.call('ZADD', KEYS[1], ARGV[2], ARGV[1])
  redis.call('HSET', KEYS[2], ARGV[1], ARGV[3])
end
redis.call('HSET', KEYS[3], ARGV[1], ARGV[4])
if tonumber(ARGV[10]) > 0 then
  redis.call('EXPIRE', KEYS[1], ARGV[10])
  redis.call('EXPIRE', KEYS[2], ARGV[10])
end
local r = won and '1' or '0'
redis.call('SET', KEYS[4], r, 'EX', ARGV[9])
return {'recorded', r}
`;

export class UpstashStore implements Store {
  readonly kind = 'upstash';

  constructor(
    private url: string,
    private token: string,
  ) {}

  private async send(path: string, body: Command | Command[]): Promise<unknown> {
    const res = await fetch(`${this.url.replace(/\/$/, '')}${path}`, {
      method: 'POST',
      headers: { authorization: `Bearer ${this.token}`, 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });
    if (!res.ok) throw new Error(`upstash ${res.status}`);
    return res.json();
  }

  private async cmd(...args: Command): Promise<unknown> {
    const r = (await this.send('', args)) as { result?: unknown; error?: string };
    if (r.error) throw new Error(`upstash: ${r.error}`);
    return r.result;
  }

  async submit(op: SubmitOp): Promise<SubmitOutcome> {
    const k = op.keys;
    const r = (await this.cmd(
      'EVAL',
      SUBMIT_SCRIPT,
      6,
      k.board,
      k.entries,
      k.names,
      k.submission,
      k.playerLimit,
      k.addressLimit,
      op.player,
      String(op.score),
      op.entry,
      op.name,
      op.submission,
      op.playerWindowS,
      op.addressWindowS,
      op.addressMax,
      op.submissionTtlS,
      op.boardTtlS,
    )) as [string, string];
    if (r[0] === 'limited') return { kind: 'limited', retryAfterS: Math.max(1, Number(r[1])) };
    return { kind: r[0] === 'repeat' ? 'repeat' : 'recorded', won: r[1] === '1' };
  }

  async zrevrank(key: string, member: string): Promise<number | null> {
    const r = await this.cmd('ZREVRANK', key, member);
    return r === null || r === undefined ? null : Number(r);
  }

  async zcard(key: string): Promise<number> {
    return Number(await this.cmd('ZCARD', key));
  }

  async zrevrange(key: string, start: number, stop: number): Promise<string[]> {
    return ((await this.cmd('ZREVRANGE', key, start, stop)) as string[] | null) ?? [];
  }

  async hmget(key: string, fields: string[]): Promise<(string | null)[]> {
    return ((await this.cmd('HMGET', key, ...fields)) as (string | null)[] | null) ?? fields.map(() => null);
  }

  async hit(key: string, seconds: number): Promise<number> {
    // start the window with the first hit only, then count
    const r = (await this.send('/pipeline', [
      ['SET', key, 0, 'EX', seconds, 'NX'],
      ['INCR', key],
    ])) as { result?: unknown; error?: string }[];
    if (r[1]?.error) throw new Error(`upstash: ${r[1].error}`);
    return Number(r[1]?.result);
  }

  async remove(board: string, entries: string, player: string): Promise<boolean> {
    const r = (await this.send('/multi-exec', [
      ['ZREM', board, player],
      ['HDEL', entries, player],
    ])) as { result?: unknown; error?: string }[];
    if (r[0]?.error) throw new Error(`upstash: ${r[0].error}`);
    return Number(r[0]?.result) > 0;
  }
}
