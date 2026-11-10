import { TIMING } from '../config';
import type { Input } from '../core/input';
import type { CameraRig } from '../camera/cameraRig';
import type { Athlete } from './athlete';

export type UserAction = 'jump' | 'attack' | 'block' | 'pass' | 'set' | 'toss';

interface Buffered {
  action: UserAction;
  /** real time (s) the press happened */
  at: number;
  /** the key was released while still buffered */
  released: boolean;
}

/**
 * Maps keyboard + mouse onto the user's athlete. Presses are executed on the
 * frame they arrive; if the action is not possible yet (mid-landing, already
 * swinging) the press is buffered for TIMING.bufferWindow and retried.
 */
export class UserController {
  athlete: Athlete | null = null;
  private buffer: Buffered[] = [];
  /** handlers return true if the action was executed */
  handlers: Partial<Record<UserAction, () => boolean>> = {};
  releaseHandlers: Partial<Record<UserAction, () => void>> = {};
  realTime = 0;
  /** suppress gameplay input (menus, replays) */
  locked = false;

  constructor(
    private input: Input,
    private rig: CameraRig,
  ) {}

  private static readonly binds: Record<UserAction, string[]> = {
    jump: ['Space'],
    attack: ['Mouse0'],
    block: ['Mouse2'],
    pass: ['KeyE'],
    set: ['Mouse2'],
    toss: ['KeyQ'],
  };

  isHeld(a: UserAction): boolean {
    return UserController.binds[a].some((c) => this.input.isDown(c));
  }

  /** per render frame: movement command + edge-triggered actions */
  frame(dt: number): void {
    this.realTime += dt;
    const a = this.athlete;
    if (!a) return;
    if (this.locked) {
      a.cmd.moveX = a.cmd.moveZ = 0;
      a.cmd.sprint = false;
      this.input.clearEdges();
      return;
    }
    // ---- movement relative to camera yaw
    let f = 0;
    let s = 0;
    if (this.input.isDown('KeyW') || this.input.isDown('ArrowUp')) f += 1;
    if (this.input.isDown('KeyS') || this.input.isDown('ArrowDown')) f -= 1;
    if (this.input.isDown('KeyD') || this.input.isDown('ArrowRight')) s += 1;
    if (this.input.isDown('KeyA') || this.input.isDown('ArrowLeft')) s -= 1;
    const stick = this.input.stick;
    if (stick.active) {
      f += stick.y;
      s += stick.x;
    }
    const yaw = this.rig.yaw;
    const fx = -Math.sin(yaw);
    const fz = -Math.cos(yaw);
    const rx = Math.cos(yaw);
    const rz = -Math.sin(yaw);
    let mx = fx * f + rx * s;
    let mz = fz * f + rz * s;
    const l = Math.hypot(mx, mz);
    if (l > 1) {
      mx /= l;
      mz /= l;
    }
    a.cmd.moveX = mx;
    a.cmd.moveZ = mz;
    a.cmd.sprint = this.input.isDown('ShiftLeft') || this.input.isDown('ShiftRight') || (stick.active && stick.sprint);
    // the body always faces where the camera looks, in both cameras: volleyball players face
    // the play while they shuffle, and it keeps the aim consistent
    a.cmd.faceYaw = yaw;

    // ---- edges
    const presses: UserAction[] = [];
    // Mouse2 maps to block or set; the handler decides by context
    if (this.input.consumePress('Space')) presses.push('jump');
    if (this.input.consumePress('Mouse0')) presses.push('attack');
    if (this.input.consumePress('Mouse2')) presses.push('block');
    if (this.input.consumePress('KeyE')) presses.push('pass');
    if (this.input.consumePress('KeyQ')) presses.push('toss');
    for (const p of presses) {
      if (!this.tryRun(p)) this.buffer.push({ action: p, at: this.realTime, released: false });
    }
    const rel = (code: string, action: UserAction, handlerKey: UserAction) => {
      if (!this.input.consumeRelease(code)) return;
      const pending = this.buffer.find((b) => b.action === action);
      if (pending) pending.released = true;
      else this.releaseHandlers[handlerKey]?.();
    };
    rel('Space', 'jump', 'jump');
    rel('Mouse0', 'attack', 'attack');
    rel('Mouse2', 'block', 'block');
    rel('KeyE', 'pass', 'pass');
    this.input.consumeRelease('KeyQ');

    // ---- retry buffered presses
    if (this.buffer.length) {
      const keep: Buffered[] = [];
      for (const b of this.buffer) {
        if (this.realTime - b.at > TIMING.bufferWindow) continue;
        if (!this.tryRun(b.action)) keep.push(b);
        else if (b.released) this.releaseHandlers[b.action]?.();
      }
      this.buffer = keep;
    }
  }

  private tryRun(a: UserAction): boolean {
    const h = this.handlers[a];
    return h ? h() : true;
  }

  clear(): void {
    this.buffer.length = 0;
  }
}
