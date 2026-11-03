import { describe, expect, it } from 'vitest';
import { Emitter } from '../src/core/events';
import { describeError, ErrorReporter } from '../src/core/errors';

const make = (endpoint?: string) => {
  const sent: { url: string; body: string }[] = [];
  const r = new ErrorReporter({
    build: '0.1.0+abc1234',
    endpoint,
    send: (url, body) => sent.push({ url, body }),
    page: () => '/?mode=spike',
    userAgent: () => 'test-agent',
    now: () => new Date('2026-11-03T12:00:00Z'),
  });
  return { r, sent };
};

describe('error reports', () => {
  it('describes errors, strings and odd values', () => {
    expect(describeError(new TypeError('x is undefined')).message).toBe('TypeError: x is undefined');
    expect(describeError('plain').message).toBe('plain');
    expect(describeError({ code: 7 }).message).toBe('{"code":7}');
    const circular: Record<string, unknown> = {};
    circular.self = circular;
    expect(typeof describeError(circular).message).toBe('string');
    expect(describeError(undefined).message).toBe('undefined');
  });

  it('nothing is sent without an endpoint, but the report is kept for the crash screen', () => {
    const { r, sent } = make();
    r.report('crash', new Error('boom'), 'frame');
    expect(sent).toHaveLength(0);
    expect(r.recent.at(-1)?.message).toBe('Error: boom');
  });

  it('sends a report with build, page, browser and game state', () => {
    const { r, sent } = make('https://collector.example/report');
    r.context = () => ({ mode: 'rally', pos: 'MB' });
    r.report('error', new Error('boom'), 'frame');
    expect(sent).toHaveLength(1);
    const body = JSON.parse(sent[0].body);
    expect(body).toMatchObject({
      kind: 'error',
      where: 'frame',
      message: 'Error: boom',
      build: '0.1.0+abc1234',
      page: '/?mode=spike',
      userAgent: 'test-agent',
      at: '2026-11-03T12:00:00.000Z',
      context: { mode: 'rally', pos: 'MB' },
    });
  });

  it('the same error is sent once, and a page load sends at most MAX_SENT reports', () => {
    const { r, sent } = make('/collect');
    const e = new Error('same');
    for (let i = 0; i < 50; i++) r.report('error', e, 'frame');
    expect(sent).toHaveLength(1);
    for (let i = 0; i < 50; i++) r.report('error', new Error(`distinct ${i}`), 'frame');
    expect(sent).toHaveLength(ErrorReporter.MAX_SENT);
    expect(r.recent.length).toBeLessThanOrEqual(5);
  });

  it('never throws: a failing context or transport is swallowed', () => {
    const r = new ErrorReporter({
      build: 'b',
      endpoint: '/collect',
      send: () => {
        throw new Error('offline');
      },
      page: () => {
        throw new Error('no location');
      },
    });
    r.context = () => {
      throw new Error('half-built game');
    };
    expect(() => r.report('startup', new Error('x'))).not.toThrow();
    expect(r.recent[0].context).toEqual({});
    expect(r.recent[0].page).toBe('');
  });

  it('details are plain text a player can paste into a bug report', () => {
    const { r } = make();
    r.context = () => ({ mode: 'spike' });
    const d = ErrorReporter.details(r.report('crash', new Error('boom'), 'frame'));
    expect(d).toContain('Court Feel 0.1.0+abc1234');
    expect(d).toContain('crash in frame');
    expect(d).toContain('Error: boom');
    expect(d).toContain('state: mode=spike');
  });
});

describe('event bus error isolation', () => {
  it('with an error handler, a throwing listener is reported and the others still run', () => {
    const errors: unknown[] = [];
    const bus = new Emitter<{ hit: number }>((e) => errors.push(e));
    const got: number[] = [];
    bus.on('hit', () => {
      throw new Error('fx bug');
    });
    bus.on('hit', (n) => got.push(n));
    expect(() => bus.emit('hit', 3)).not.toThrow();
    expect(got).toEqual([3]);
    expect(errors).toHaveLength(1);
  });

  it('without one, the error propagates (unchanged behaviour)', () => {
    const bus = new Emitter<{ hit: number }>();
    bus.on('hit', () => {
      throw new Error('boom');
    });
    expect(() => bus.emit('hit', 1)).toThrow('boom');
  });
});
