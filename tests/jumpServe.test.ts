import { describe, expect, it } from 'vitest';
import * as THREE from 'three';
import { AI, COURT } from '../src/config';
import { serveRun } from './serveRun';

/**
 * An AI serve from the home end line (aimed deep at zone 1 of the far court), with the server's
 * timing error drawn as `sd` standard deviations.
 */
const jumpServe = (sd: number, aim?: THREE.Vector3, jump = true) => serveRun({ kind: jump ? 'jump' : 'float', sd, aim });

describe('the jump serve (Mini Rally AI)', () => {
  it('walks into the toss, runs in, takes off behind the end line and lands in the court', () => {
    const r = jumpServe(0);
    expect(r.e?.kind).toBe('serve');
    // FIVB rule 12.4.3: take off behind the end line; the landing may be in the court
    expect(r.takeoffZ).toBeGreaterThan(COURT.halfLength);
    expect(r.landZ).toBeLessThan(COURT.halfLength);
    // the run-up: from AI.serve.jumpBack behind the line to the takeoff, more than two steps' worth
    expect(COURT.halfLength + AI.serve.jumpBack - r.takeoffZ).toBeGreaterThan(2.5);
  });

  it('the toss drops into the run-up from about 1-1.5 m over the contact, not out of the sky', () => {
    const r = jumpServe(0);
    expect(r.tossApex - r.contactY).toBeGreaterThan(0.8);
    expect(r.tossApex - r.contactY).toBeLessThan(1.6);
  });

  it('a clean jump serve is driven: hard and low over the tape', () => {
    const r = jumpServe(0);
    expect(r.e!.grade).toBe('Perfect');
    expect(r.e!.speed * 3.6).toBeGreaterThan(85);
    expect(r.overTape).toBeGreaterThan(0);
    expect(r.overTape).toBeLessThan(1.2);
  });

  it('a server never lets the toss drop past untouched: a late arm still hits it (late, lower)', () => {
    const r = jumpServe(4);
    expect(r.e?.kind).toBe('serve');
    expect(r.e!.grade).toBe('Late');
  });

  it('a jump serve met early flies flat, it does not loop up into a lob', () => {
    const r = jumpServe(-4);
    expect(r.e!.grade).toBe('Early');
    expect(r.apex - r.contactY).toBeLessThan(1.2);
    expect(r.overTape).toBeLessThan(2);
  });

  it('the AI never misses a serve: early, late, at the deep corners or short, jump or float, it clears the tape and lands in', () => {
    const aims = [
      new THREE.Vector3(-4.4, 0, -8.9),
      new THREE.Vector3(4.4, 0, -8.9),
      new THREE.Vector3(0, 0, -3.2),
      new THREE.Vector3(-3.5, 0, -7.5),
    ];
    for (const jump of [true, false])
      for (const aim of aims)
        for (const sd of [-4, -2, 0, 2, 4]) {
          const r = jumpServe(sd, aim, jump);
          const what = `${jump ? 'jump' : 'float'} at ${aim.x},${aim.z}, error ${sd} sd`;
          expect(r.e?.kind, what).toBe('serve');
          expect(r.overTape, what).toBeGreaterThan(0.1);
          expect(Math.abs(r.ball.x), what).toBeLessThan(COURT.halfWidth);
          expect(r.ball.z, what).toBeLessThan(0);
          expect(r.ball.z, what).toBeGreaterThan(-COURT.halfLength);
        }
  });
});
