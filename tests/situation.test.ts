import { describe, expect, it } from 'vitest';
import { situationOf, SITUATIONS, type SituationInput } from '../src/ai/situation';

const at = (o: Partial<SituationInput>): SituationInput => ({
  live: true,
  kind: 'pass',
  ours: true,
  comingToUs: true,
  freeCall: false,
  help: false,
  ...o,
});

describe('the situation a team is in', () => {
  it('no live ball: nothing is on', () => {
    expect(situationOf(at({ live: false }))).toBe('dead');
    expect(situationOf(at({ kind: null }))).toBe('dead');
    expect(situationOf(at({ kind: 'feed' }))).toBe('dead');
  });

  it("a serve is the server's team's serve and the other team's to receive", () => {
    expect(situationOf(at({ kind: 'serve', ours: true, comingToUs: false }))).toBe('ourServe');
    expect(situationOf(at({ kind: 'serve', ours: false }))).toBe('theirServe');
  });

  it('our ball: a first ball to the setter, a set, an attack; a first ball going over is theirs to play', () => {
    expect(situationOf(at({ kind: 'pass' }))).toBe('ourFirstBall');
    expect(situationOf(at({ kind: 'dig' }))).toBe('ourFirstBall');
    expect(situationOf(at({ kind: 'set' }))).toBe('ourSet');
    expect(situationOf(at({ kind: 'spike', comingToUs: false }))).toBe('ourAttack');
    expect(situationOf(at({ kind: 'tip', comingToUs: false }))).toBe('ourAttack');
    expect(situationOf(at({ kind: 'pass', comingToUs: false }))).toBe('ourAttack');
  });

  it('their ball: a first ball, a set, a hit; coming over without an attack (or called before it is sent) it is a free ball', () => {
    expect(situationOf(at({ ours: false, kind: 'dig', comingToUs: false }))).toBe('theirFirstBall');
    expect(situationOf(at({ ours: false, kind: 'set', comingToUs: false }))).toBe('theirSet');
    expect(situationOf(at({ ours: false, kind: 'spike' }))).toBe('theirHit');
    expect(situationOf(at({ ours: false, kind: 'tip' }))).toBe('theirHit');
    expect(situationOf(at({ ours: false, kind: 'pass', comingToUs: true }))).toBe('theirFree');
    expect(situationOf(at({ ours: false, kind: 'set', comingToUs: true }))).toBe('theirFree');
    expect(situationOf(at({ ours: false, kind: 'pass', comingToUs: false, freeCall: true }))).toBe('theirFree');
  });

  it('a scramble: a ball off a block coming down on our side, or a first ball the setter calls HELP on', () => {
    expect(situationOf(at({ kind: 'block', ours: true, comingToUs: true }))).toBe('scramble');
    expect(situationOf(at({ kind: 'block', ours: false, comingToUs: true }))).toBe('scramble');
    expect(situationOf(at({ kind: 'pass', help: true }))).toBe('scramble');
    // off a block and going to their side: they have to play it
    expect(situationOf(at({ kind: 'block', ours: true, comingToUs: false }))).toBe('ourAttack');
  });

  it('every case is one of the listed situations', () => {
    for (const kind of ['spike', 'tip', 'block', 'pass', 'dig', 'set', 'serve', 'free', 'feed'] as const)
      for (const ours of [true, false])
        for (const comingToUs of [true, false])
          for (const help of [true, false]) expect(SITUATIONS).toContain(situationOf(at({ kind, ours, comingToUs, help })));
  });
});
