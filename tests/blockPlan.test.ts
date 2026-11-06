import { describe, expect, it } from 'vitest';
import { AI, COURT, RANKED } from '../src/config';
import { blockShadowOnCourt } from '../src/game/blockShadow';
import { blockPlan, coveredFraction, openZone, planSpans, type BlockTakes } from '../src/game/blockPlan';
import { boardSeed, repSeed, spikeScript } from '../src/game/ranked';
import { zonesFor } from '../src/game/modes/spikeDrill';
import { laneFor } from '../src/game/plays';

/** an outside hitter's high ball: contact at the left pin, about 3.2 m up */
const OH = { x: laneFor('OH', 1).x, y: 3.2, z: laneFor('OH', 1).z };
/** the block's wall: the AI blockers' hands reach about as high as the contact, so it is kept just under it */
const HANDS_TOP = OH.y - 0.1;
const M = AI.drillBlock.handsMargin;
const high = { inside: false, fast: false, normalX: OH.x };

describe('the Spike Drill block takes a side', () => {
  it('a block that takes the line stands on the sideline side of the hitter; one that takes the cross, inside', () => {
    const line = blockPlan(OH.x, 'line', 1, high);
    const cross = blockPlan(OH.x, 'cross', 1, high);
    // the outside hitter is on the left (x < 0): the line is further left
    expect(line.pin.end).toBeLessThan(OH.x);
    expect(cross.pin.end).toBeGreaterThan(OH.x);
    expect(Math.abs(line.pin.end)).toBeLessThanOrEqual(COURT.halfWidth);
  });

  it('on a pin set the block is formed before the set and holds there', () => {
    const p = blockPlan(OH.x, 'cross', 1, high);
    expect(p.pin.hold).toBe(true);
    expect(p.pin.start).toBe(p.pin.end);
  });

  it('on an inside set the pin blocker starts at its usual spot and moves after the set', () => {
    // an outside's 3 ball: hit between the middle and the pin
    const p = blockPlan(-2.1, 'line', 1, { inside: true, fast: true, normalX: OH.x });
    expect(p.pin.hold).toBe(false);
    expect(p.pin.start).toBe(OH.x);
    expect(p.pin.end).toBeCloseTo(-2.1 - AI.drillBlock.takeShift, 6);
  });

  it("a double block's middle closes inside the pin blocker: formed early on a high ball; on a go it starts halfway and arrives with the swing", () => {
    const highBall = blockPlan(OH.x, 'line', 2, high);
    expect(highBall.middle).toMatchObject({ hold: true, late: false });
    expect(highBall.middle!.end).toBeCloseTo(highBall.pin.end + AI.drillBlock.closeGap, 6);
    const go = blockPlan(-4.0, 'line', 2, { inside: false, fast: true, normalX: OH.x });
    expect(go.middle).toMatchObject({ hold: false, late: true });
    // shading towards the pin: halfway from the middle of the net to its spot, not still in the middle
    expect(go.middle!.start).toBeCloseTo(go.middle!.end * AI.drillBlock.fastStart, 6);
    expect(Math.abs(go.middle!.start)).toBeGreaterThan(1);
    expect(Math.abs(go.middle!.start)).toBeLessThan(Math.abs(go.middle!.end));
    // still arriving when the hitter swings: between where it started and its spot
    expect(go.middle!.at).toBeCloseTo(go.middle!.end + (go.middle!.start - go.middle!.end) * AI.drillBlock.arriveShort, 6);
  });

  it('on a go the middle is still arriving: a block that takes the line leaves the seam between the two blockers', () => {
    const go = { x: -4.0, y: 3.15, z: 0.85 };
    const plan = blockPlan(go.x, 'line', 2, { inside: false, fast: true, normalX: OH.x });
    const spans = planSpans(plan, M);
    const polys = blockShadowOnCourt(go, spans, go.y - 0.1, COURT.halfWidth, COURT.halfLength);
    const seam = zonesFor('OH').find((z) => z.name === 'Seam')!;
    expect(coveredFraction(seam, polys)).toBeLessThan(AI.drillBlock.openFrac);
    // the same block fully closed (a high ball) covers it
    const closed = planSpans(blockPlan(go.x, 'line', 2, high), M);
    expect(coveredFraction(seam, blockShadowOnCourt(go, closed, go.y - 0.1, COURT.halfWidth, COURT.halfLength))).toBe(1);
  });
});

describe('the target is on the side the block leaves open', () => {
  const zones = zonesFor('OH');
  const rand = (v: number) => () => v;
  const spansOf = (takes: BlockTakes, level: 1 | 2) => planSpans(blockPlan(OH.x, takes, level, high), M);
  const cover = (takes: BlockTakes, level: 1 | 2) => {
    const polys = blockShadowOnCourt(OH, spansOf(takes, level), HANDS_TOP, COURT.halfWidth, COURT.halfLength);
    return Object.fromEntries(zones.map((z) => [z.name, coveredFraction(z, polys)]));
  };
  const picks = (takes: BlockTakes, level: 1 | 2) =>
    new Set(Array.from({ length: 20 }, (_, i) => openZone(zones, OH, spansOf(takes, level), HANDS_TOP, rand(i / 20)).name));

  for (const takes of ['line', 'cross'] as BlockTakes[])
    for (const level of [1, 2] as const)
      it(`a ${level === 1 ? 'single' : 'double'} block that takes the ${takes}: every target it can pick is open`, () => {
        const c = cover(takes, level);
        for (const name of picks(takes, level)) expect(c[name], name).toBeLessThan(AI.drillBlock.openFrac);
      });

  it('a block that takes the line sends the outside hitter cross: no line target', () => {
    for (const level of [1, 2] as const) {
      const p = picks('line', level);
      for (const name of ['Deep line', 'Line short', 'Line past the block']) expect(p.has(name), `${level} ${name}`).toBe(false);
    }
  });

  it('a double block that takes the cross leaves the line: the target is the line past the block', () => {
    expect(picks('cross', 2)).toEqual(new Set(['Line past the block']));
  });

  it("hands as high as the hitter's contact cover the court all the way back: no deep ball over a formed block", () => {
    expect(cover('line', 2)['Deep cross']).toBeGreaterThan(0.9);
    expect(cover('cross', 2)['Deep cross']).toBe(1);
  });

  it('a double block closes more of the court than a single one', () => {
    const sum = (c: Record<string, number>) => Object.values(c).reduce((t, v) => t + v, 0);
    for (const takes of ['line', 'cross'] as BlockTakes[]) expect(sum(cover(takes, 2))).toBeGreaterThan(sum(cover(takes, 1)));
  });

  it('the last target is skipped when another open zone is left', () => {
    const spans = spansOf('line', 1);
    const first = openZone(zones, OH, spans, HANDS_TOP, rand(0));
    for (let v = 0; v < 1; v += 0.1) expect(openZone(zones, OH, spans, HANDS_TOP, rand(v), first)).not.toBe(first);
  });

  it('the line past the block is only a target when a block is up', () => {
    expect(zones.find((z) => z.name === 'Line past the block')?.blockOnly).toBe(true);
    expect(zones.filter((z) => !z.blockOnly).map((z) => z.name)).not.toContain('Line past the block');
  });
});

describe('the ranked script calls the block side', () => {
  it('each rep has a side, the same for everyone, and a run sees both', () => {
    const seed = boardSeed('spike', 'OH');
    const sides = new Set<BlockTakes>();
    for (let k = 0; k < RANKED.reps; k++) {
      const a = spikeScript(k, repSeed(seed, k), 3);
      expect(a.takes).toBe(spikeScript(k, repSeed(seed, k), 3).takes);
      if (a.block) sides.add(a.takes);
    }
    expect(sides).toEqual(new Set(['line', 'cross']));
    // it doesn't depend on the set calls a position has
    expect(spikeScript(12, repSeed(seed, 12), 0).takes).toBe(spikeScript(12, repSeed(seed, 12), 3).takes);
  });
});
