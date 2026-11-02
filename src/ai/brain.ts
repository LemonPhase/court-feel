import * as THREE from 'three';
import { clamp, wrapAngle, yawFromDir } from '../core/mathx';
import type { Athlete } from '../game/athlete';
import type { Game } from '../game/game';

/** An AI controller for one athlete. */
export interface Brain {
  athlete: Athlete;
  step(dt: number, g: Game): void;
  /** optional reset at the start of a rally / rep */
  reset?(g: Game): void;
}

/**
 * Steering helper: walk/run towards (x,z) with an arrive radius so the
 * athlete decelerates (no snapping), optionally facing a fixed yaw.
 */
export function moveTo(a: Athlete, x: number, z: number, opts: { face?: number | null; sprintDist?: number; arrive?: number; urgency?: number } = {}): number {
  const dx = x - a.pos.x;
  const dz = z - a.pos.z;
  const d = Math.hypot(dx, dz);
  const arrive = opts.arrive ?? 0.55;
  const urgency = opts.urgency ?? 1;
  if (d < 0.04) {
    a.cmd.moveX = 0;
    a.cmd.moveZ = 0;
  } else {
    const m = clamp(d / arrive, 0, 1) * urgency;
    a.cmd.moveX = (dx / d) * m;
    a.cmd.moveZ = (dz / d) * m;
  }
  a.cmd.sprint = d > (opts.sprintDist ?? 2.2);
  if (opts.face !== undefined) a.cmd.faceYaw = opts.face;
  else if (d > 1.2) a.cmd.faceYaw = yawFromDir(dx, dz);
  return d;
}

export function stop(a: Athlete, face?: number | null): void {
  a.cmd.moveX = 0;
  a.cmd.moveZ = 0;
  a.cmd.sprint = false;
  if (face !== undefined) a.cmd.faceYaw = face;
}

/** yaw that faces a world point */
export function faceToward(a: Athlete, x: number, z: number): number {
  return yawFromDir(x - a.pos.x, z - a.pos.z);
}

/** the yaw facing the net from a side */
export const netYaw = (side: 1 | -1) => (side === 1 ? 0 : Math.PI);

export function angleTo(a: Athlete, yaw: number): number {
  return Math.abs(wrapAngle(a.yaw - yaw));
}

export const _bv = new THREE.Vector3();
