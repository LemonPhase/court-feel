import { describe, expect, it } from 'vitest';
import * as THREE from 'three';
import { drawnBallPos } from '../src/game/ballEntity';

describe('where the ball is drawn', () => {
  // a spike at 30 m/s: the step that resolves the touch then moves the ball a quarter of a metre down its line
  const touch = { x: 0, y: 3, z: 1 };
  const afterStep = { x: 0, y: 2.91, z: 0.77 };
  const out = new THREE.Vector3();

  it('between its last two simulated positions on an ordinary frame', () => {
    drawnBallPos(touch, afterStep, 0.5, null, out);
    expect(out.z).toBeCloseTo(0.885, 6);
    expect(out.y).toBeCloseTo(2.955, 6);
  });

  it('where it was touched for as long as the hit-stop holds the frame: on the hand, not past it', () => {
    for (const alpha of [0, 0.3, 0.99]) {
      drawnBallPos(touch, afterStep, alpha, touch, out);
      expect(out.distanceTo(new THREE.Vector3(touch.x, touch.y, touch.z))).toBe(0);
    }
  });
});
