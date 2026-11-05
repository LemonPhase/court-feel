// The leaderboard store in production: Upstash Redis over its REST API (plain fetch, no client library).
import type { Store } from './server.js';

type Command = (string | number)[];

export class UpstashStore implements Store {
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

  async zaddGreater(key: string, score: number, member: string): Promise<void> {
    await this.cmd('ZADD', key, 'GT', score, member);
  }

  async zscore(key: string, member: string): Promise<number | null> {
    const r = await this.cmd('ZSCORE', key, member);
    return r === null || r === undefined ? null : Number(r);
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

  async hset(key: string, field: string, value: string): Promise<void> {
    await this.cmd('HSET', key, field, value);
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
}
