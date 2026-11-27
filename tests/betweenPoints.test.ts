import { describe, expect, it } from 'vitest';
import { AI, MINI_RALLY } from '../src/config';
import type { Athlete } from '../src/game/athlete';
import type { MiniRally } from '../src/game/modes/miniRally';
import type { TeamAI } from '../src/ai/team';
import { headlessGame } from './headlessGame';

/**
 * A Mini Rally played point after point with nobody watching (you stand in seat 0, hands off), and
 * what everyone did between the points: how fast anyone moved from one frame to the next, where
 * each AI player stood when the server tossed, how long the next serve took, and what their bodies
 * said (the gestures, the team coming together) while there was no ball in play.
 */
function betweenPoints(seed: number, points: number) {
  const h = headlessGame('rally', 'OH', seed);
  const rally = h.mode as MiniRally;
  const teams = (): TeamAI[] => [rally.home, rally.away];
  const ai = (): Athlete[] => h.sim.athletes.filter((a) => !a.isUser);
  const last = new Map<Athlete, { x: number; z: number }>();
  let fastest = 0;
  const offSpot: number[] = [];
  const before: number[] = [];
  const serveAfter: number[] = [];
  const kinds = new Set<string>();
  const styles = new Set<string>();
  const loudInPlay: string[] = [];
  let ended = -1;
  let active = false;
  let outcomes = 0;
  for (let f = 0; f < 600 * 60 && outcomes <= points; f++) {
    h.frame();
    const now = h.sim.simTime;
    if (h.outcomes.length > outcomes) {
      outcomes = h.outcomes.length;
      ended = now;
      for (const t of teams()) styles.add(t.between.style);
    }
    if (ended >= 0) for (const a of ai()) if (a.gesture) kinds.add(a.gesture.kind);
    const nowActive = teams().some((t) => t.between.active);
    if (active && !nowActive) {
      // the toss: every AI player was on the spot the team gave them (the frame before, when a
      // passer reads a jump serve off the toss and steps back), and nobody was put there
      offSpot.push(...before);
      serveAfter.push(now - ended);
    }
    if (nowActive) {
      before.length = 0;
      for (const t of teams())
        for (const [a, b] of t.brains) if (a !== t.server && !a.isUser) before.push(Math.hypot(a.pos.x - b.spot.x, a.pos.z - b.spot.z));
      for (const a of ai()) {
        const was = last.get(a);
        if (was) fastest = Math.max(fastest, Math.hypot(a.pos.x - was.x, a.pos.z - was.z) * 60);
      }
    }
    for (const a of ai()) last.set(a, { x: a.pos.x, z: a.pos.z });
    active = nowActive;
    if (!nowActive && h.sim.ballLive)
      for (const a of h.sim.athletes) if (a.gesture || a.relax || a.ready || a.gaze) loudInPlay.push(`${a.role} ${a.side}`);
  }
  return { fastest, offSpot, serveAfter, kinds, styles, loudInPlay, touches: h.touches };
}

describe('Mini Rally: between points', () => {
  const run = betweenPoints(11, 10);

  it('nobody is picked up and put on a spot between points: they walk there (no one moves faster than a sprint)', () => {
    expect(run.serveAfter.length).toBeGreaterThanOrEqual(8);
    // a sprint is 5.3 m/s at most (`BODIES`); a body put on its spot jumps metres in a frame
    expect(run.fastest).toBeLessThan(6);
  });

  it('when the server tosses, everyone is on their spot for the serve', () => {
    expect(Math.max(...run.offSpot)).toBeLessThan(AI.between.stop);
  });

  it('the next serve comes when it always did: the whistle after the dead time, the server takes a moment at the line and tosses', () => {
    const T = MINI_RALLY.timing;
    const whistle = T.dead + T.prepare;
    const [soonest, latest] = AI.between.serverReady;
    // (then the server's own wait and, for a jump serve, the walk into the toss: `src/ai/server.ts`)
    for (const t of run.serveAfter) {
      expect(t).toBeGreaterThan(whistle + soonest);
      expect(t).toBeLessThan(whistle + latest + 1.5);
    }
  });

  it('after a point the team comes together, and it is not the same every time', () => {
    // a ring in the middle, the scorer mobbed, or fives on the way back
    expect(run.styles.size).toBeGreaterThanOrEqual(2);
    // a fist, a clap, a five, a hand up for an error, hands on the hips or the knees...
    expect(run.kinds.size).toBeGreaterThanOrEqual(6);
  });

  it('with the ball in play nobody is celebrating, standing loose or looking anywhere but at it', () => {
    expect(run.loudInPlay).toEqual([]);
  });

  it('it is the same game every time it is played with the same dice', () => {
    const again = betweenPoints(11, 10);
    expect(again.touches).toEqual(run.touches);
  });
});
