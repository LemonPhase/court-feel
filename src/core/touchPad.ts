import { TOUCH } from '../config';
import type { Stick } from './input';

/**
 * Touch controls model (no DOM): turns pointer touches into the same button
 * codes and look deltas the keyboard and mouse produce, so every tuned contact,
 * timing and buffering rule stays exactly as it is for mouse and keyboard.
 *
 *   left half     a floating joystick under the thumb: deflection = speed,
 *                 push it out to the ring = approach / sprint (Shift)
 *   right half    drag anywhere = aim (mouse look). Buttons are held like keys:
 *                 JUMP (Space) hold to load / release to take off, HIT (LMB)
 *                 hold to wind up / release to swing / tap = tip, BLOCK (RMB,
 *                 also loads a jump unless the ball is dropping onto you: then
 *                 it sets), PASS (E), TOSS (Q). A held button still aims: once
 *                 the thumb travels past a small dead zone the drag turns the
 *                 camera, so you can wind up and aim with one thumb.
 *   in the air    any touch on the right half is the HIT button (the thumb
 *                 does not have to find it after the jump), and rolling the
 *                 thumb from JUMP onto HIT without lifting takes off and winds up.
 */
export type PadButton = 'jump' | 'hit' | 'block' | 'pass' | 'toss' | 'cam' | 'reset' | 'replay' | 'vsblock' | 'feed' | 'auto' | 'd1' | 'd2' | 'd3' | 'd4' | 'd5';

/** the slice of Input the pad drives (Input implements it) */
export interface PadInput {
  down(code: string): void;
  up(code: string): void;
  mouseDX: number;
  mouseDY: number;
  readonly stick: Stick;
}

export interface PadContext {
  /** the athlete is loading a jump or in the air */
  airborne(): boolean;
  /** a hands-up press would set (the ball is dropping onto you from your side) rather than block */
  wantsSet(): boolean;
  /** aim sensitivity multiplier on top of TOUCH.lookScale */
  lookSens(): number;
  /** which button is under a screen point (CSS px), if any */
  buttonAt(x: number, y: number): PadButton | null;
  /** screen width (CSS px): the stick lives on the left half, the aim on the right */
  width(): number;
}

/** key codes a button presses while it is held */
export const BUTTON_CODES: Record<PadButton, string[]> = {
  jump: ['Space'],
  hit: ['Mouse0'],
  block: ['Mouse2'],
  pass: ['KeyE'],
  toss: ['KeyQ'],
  cam: ['KeyV'],
  reset: ['KeyN'],
  replay: ['KeyR'],
  vsblock: ['KeyB'],
  feed: ['KeyF'],
  auto: ['KeyT'],
  d1: ['Digit1'],
  d2: ['Digit2'],
  d3: ['Digit3'],
  d4: ['Digit4'],
  d5: ['Digit5'],
};

/** buttons that keep aiming while held */
const AIMING: ReadonlySet<PadButton> = new Set<PadButton>(['jump', 'hit', 'block', 'pass', 'toss']);

export type PointerKind = 'stick' | 'look' | 'button';

export interface PadPointer {
  id: number;
  kind: PointerKind;
  /** where the touch started (stick origin for the stick) */
  x0: number;
  y0: number;
  x: number;
  y: number;
  button: PadButton | null;
  /** codes this touch is holding (released on end) */
  codes: string[];
  /** this touch drags the aim once it travels past the dead zone */
  aims: boolean;
  dragging: boolean;
  /** JUMP touch that rolled onto HIT */
  rolled: boolean;
  t0: number;
}

export class TouchPad {
  readonly pointers = new Map<number, PadPointer>();
  /** the hands-up button stays held through the block jump until the feet are back on the floor */
  private blockLatched = false;
  /** stick geometry for drawing: origin and knob (CSS px) */
  readonly stickView = { active: false, ox: 0, oy: 0, kx: 0, ky: 0, deflect: 0 };

  constructor(private readonly input: PadInput, private readonly ctx: PadContext) {}

  get stickPointer(): PadPointer | null {
    for (const p of this.pointers.values()) if (p.kind === 'stick') return p;
    return null;
  }

  /** is a button currently held by any touch */
  isHeld(b: PadButton): boolean {
    for (const p of this.pointers.values()) if (p.button === b || (b === 'hit' && p.rolled)) return true;
    return b === 'block' && this.blockLatched;
  }

  begin(id: number, x: number, y: number, now: number): PadPointer {
    if (this.pointers.has(id)) this.end(id);
    let button = this.ctx.buttonAt(x, y);
    const right = x >= this.ctx.width() * 0.5;
    const air = this.ctx.airborne();
    // airborne: the right half is the HIT button (JUMP included: the thumb is still there after the takeoff)
    if (air && TOUCH.airHitAnywhere && right && (button === null || button === 'jump')) button = 'hit';
    // a drag on empty space aims from the first pixel; a press on a button gets a dead zone first
    const p: PadPointer = { id, kind: 'look', x0: x, y0: y, x, y, button, codes: [], aims: right, dragging: right, rolled: false, t0: now };
    if (button) {
      p.dragging = false;
      p.kind = 'button';
      p.aims = AIMING.has(button);
      // a JUMP press aims only once it has rolled onto HIT (the roll itself must not turn the camera)
      if (button === 'jump' && TOUCH.rollToHit) p.aims = false;
      this.press(p, button);
    } else if (!right && !this.stickPointer) {
      p.kind = 'stick';
      p.aims = false;
      this.setStick(p, x, y);
    }
    this.pointers.set(id, p);
    return p;
  }

  move(id: number, x: number, y: number): void {
    const p = this.pointers.get(id);
    if (!p) return;
    const dx = x - p.x;
    const dy = y - p.y;
    p.x = x;
    p.y = y;
    if (p.kind === 'stick') {
      this.setStick(p, x, y);
      return;
    }
    // roll from JUMP onto HIT: take off now (if still loading) and start the wind-up
    if (p.button === 'jump' && !p.rolled && TOUCH.rollToHit && this.ctx.buttonAt(x, y) === 'hit') {
      p.rolled = true;
      this.input.up('Space');
      p.codes = p.codes.filter((c) => c !== 'Space');
      this.input.down('Mouse0');
      p.codes.push('Mouse0');
      p.aims = true;
      p.dragging = true;
      return;
    }
    if (!p.aims) return;
    const k = TOUCH.lookScale * this.ctx.lookSens();
    if (!p.dragging) {
      const ex = x - p.x0;
      const ey = y - p.y0;
      const len = Math.hypot(ex, ey);
      if (len < TOUCH.lookDeadZone) return;
      p.dragging = true;
      // the dead zone itself is swallowed; the travel beyond it turns the camera
      const f = (len - TOUCH.lookDeadZone) / len;
      this.input.mouseDX += ex * f * k;
      this.input.mouseDY += ey * f * k;
      return;
    }
    this.input.mouseDX += dx * k;
    this.input.mouseDY += dy * k;
  }

  end(id: number): void {
    const p = this.pointers.get(id);
    if (!p) return;
    this.pointers.delete(id);
    if (p.kind === 'stick') {
      this.clearStick();
      return;
    }
    for (const c of p.codes) {
      // a block jump keeps the hands up until the feet are back on the floor
      if (c === 'Mouse2' && p.button === 'block' && this.ctx.airborne()) {
        this.blockLatched = true;
        continue;
      }
      this.input.up(c);
    }
  }

  /** once per frame: housekeeping for latched holds */
  frame(): void {
    if (this.blockLatched && !this.ctx.airborne() && !this.isHeldByTouch('block')) {
      this.blockLatched = false;
      this.input.up('Mouse2');
    }
  }

  releaseAll(): void {
    for (const id of [...this.pointers.keys()]) this.end(id);
    if (this.blockLatched) {
      this.blockLatched = false;
      this.input.up('Mouse2');
    }
    this.clearStick();
  }

  private isHeldByTouch(b: PadButton): boolean {
    for (const p of this.pointers.values()) if (p.button === b) return true;
    return false;
  }

  private press(p: PadPointer, b: PadButton): void {
    const codes = [...BUTTON_CODES[b]];
    // hands up: block (with a jump to time) or, when the ball is dropping onto you, a set
    if (b === 'block' && TOUCH.blockJumps && !this.ctx.wantsSet() && !this.ctx.airborne()) codes.push('Space');
    for (const c of codes) this.input.down(c);
    p.codes = codes;
  }

  private setStick(p: PadPointer, x: number, y: number): void {
    const R = TOUCH.stickRadius;
    let dx = x - p.x0;
    let dy = y - p.y0;
    const len = Math.hypot(dx, dy);
    const raw = Math.min(1, len / R);
    const nx = len > 1e-6 ? dx / len : 0;
    const ny = len > 1e-6 ? dy / len : 0;
    const d = raw <= TOUCH.stickDead ? 0 : (raw - TOUCH.stickDead) / (1 - TOUCH.stickDead);
    const s = this.input.stick;
    s.active = true;
    s.x = d === 0 ? 0 : nx * d;
    s.y = d === 0 ? 0 : -ny * d; // screen up = forward
    if (raw >= TOUCH.sprintOn) s.sprint = true;
    else if (raw <= TOUCH.sprintOff) s.sprint = false;
    const v = this.stickView;
    v.active = true;
    v.ox = p.x0;
    v.oy = p.y0;
    v.kx = p.x0 + nx * raw * R;
    v.ky = p.y0 + ny * raw * R;
    v.deflect = raw;
  }

  private clearStick(): void {
    const s = this.input.stick;
    s.active = false;
    s.x = s.y = 0;
    s.sprint = false;
    this.stickView.active = false;
    this.stickView.deflect = 0;
  }
}
