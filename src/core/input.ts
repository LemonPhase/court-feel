/**
 * Raw keyboard / mouse state with per-frame edges. Edges are latched until the
 * game consumes them so a press is never lost between fixed steps.
 * The bot (autopilot) injects events through the same path as real hardware.
 */
export type ButtonCode = string; // KeyboardEvent.code or 'Mouse0' / 'Mouse2'

/**
 * Pointer lock freezes clientX/Y, so a click on a HUD chip is only visible as travel
 * from the lock anchor. A direct move onto the chip counts; wandering (looking around)
 * makes the path much longer than the straight line and does not.
 */
export function isDirectLockedTravel(anchorX: number, anchorY: number, x: number, y: number, travel: number): boolean {
  const straight = Math.hypot(x - anchorX, y - anchorY);
  if (straight < 1) return true;
  // no travel recorded for a long jump: the move never happened, so this isn't an aim at the chip
  if (travel + 1 < straight * 0.5) return false;
  return travel <= straight * 1.5 + 80;
}

/** analog movement axis fed by the touch joystick (x right, y forward, camera relative) */
export interface Stick {
  active: boolean;
  x: number;
  y: number;
  sprint: boolean;
}

export class Input {
  readonly held = new Set<ButtonCode>();
  private pressed = new Set<ButtonCode>();
  private released = new Set<ButtonCode>();
  /** time (performance.now ms) a button went down */
  readonly downAt = new Map<ButtonCode, number>();
  mouseDX = 0;
  mouseDY = 0;
  pointerLocked = false;
  /** pointer lock is unavailable here (refused before it ever worked): drag to look instead */
  dragLook = false;
  /** pointer lock has been granted on this page, so a later refusal is temporary */
  private lockGranted = false;
  /** a request whose requestPointerLock returned no promise (Firefox, Safari): it can only fail through pointerlockerror */
  private eventRequest = false;
  /** performance.now() when the pointer lock was last released */
  lockLostAt = -1e9;
  private dragging = false;
  enabled = true;
  /** touch controls drive look and buttons (no pointer lock, mouse events emulated from touches are ignored) */
  touch = false;
  /** virtual joystick (touch) */
  readonly stick: Stick = { active: false, x: 0, y: 0, sprint: false };
  private lastTouchAt = -1e9;
  onPointerLockChange: ((locked: boolean) => void) | null = null;
  /** a lock request was refused; `fallback`: the lock never worked here, so drag-look took over */
  onLockRefused: ((fallback: boolean) => void) | null = null;
  /**
   * Is gameplay in control of the keyboard? While it is, the game keys below never reach the
   * browser (Space must not scroll, Tab must not move focus out of the game). In the menus they
   * keep their default meaning, so Tab, Space and the arrow keys work on buttons and sliders.
   */
  captureKeys: () => boolean = () => true;
  /**
   * A click while the pointer is locked. Chrome retargets it at the canvas and freezes
   * clientX/Y at the lock anchor; the travel is only in movementX/Y, which `shadowX/Y` integrates.
   * Return true to swallow the click (the tutorial's Skip chip).
   */
  onLockedClick: ((x: number, y: number) => boolean) | null = null;
  /** viewport point of the locked pointer (anchor + movement since the lock) */
  shadowX = 0;
  shadowY = 0;
  private anchorX = 0;
  private anchorY = 0;
  /** path length of the mouse since the lock engaged */
  private lockTravel = 0;
  /** game keys whose browser default is suppressed while gameplay captures the keyboard */
  private static readonly swallow = new Set([
    'Space',
    'Tab',
    'F3',
    'ArrowUp',
    'ArrowDown',
    'ArrowLeft',
    'ArrowRight',
    'ShiftLeft',
    'ShiftRight',
  ]);

  constructor(private readonly el: HTMLElement) {
    window.addEventListener('keydown', (e) => {
      // F3 (the debug overlay) is never left to the browser
      if (Input.swallow.has(e.code) && (e.code === 'F3' || this.captureKeys())) e.preventDefault();
      if (e.repeat) return;
      if ((e.target as HTMLElement)?.tagName === 'INPUT' && e.code !== 'Escape') return;
      this.down(e.code);
    });
    window.addEventListener('keyup', (e) => this.up(e.code));
    window.addEventListener('blur', () => this.releaseAll());
    // the locking gesture is often the PLAY button, not the canvas: remember that point
    const noteFreePointer = (e: MouseEvent) => {
      // read the lock from the document: the cached flag can lag the event that pointer lock retargets
      if (document.pointerLockElement === this.el) return;
      this.shadowX = e.clientX;
      this.shadowY = e.clientY;
    };
    window.addEventListener('pointerdown', noteFreePointer, true);
    window.addEventListener('pointermove', noteFreePointer, true);
    el.addEventListener('mousedown', (e) => {
      e.preventDefault();
      if (!this.enabled || this.emulatedMouse()) return;
      if (document.pointerLockElement !== this.el) {
        this.shadowX = e.clientX;
        this.shadowY = e.clientY;
      } else if (e.button === 0 && this.lockedClickHitsChip()) {
        // the gesture was aimed at Skip: don't also swing, and drop the look from this move
        this.mouseDX = 0;
        this.mouseDY = 0;
        e.stopPropagation();
        return;
      }
      this.down('Mouse' + e.button);
      if (this.dragLook) this.dragging = true;
    });
    window.addEventListener('mouseup', (e) => {
      if (this.emulatedMouse()) return;
      this.up('Mouse' + e.button);
      this.dragging = false;
    });
    // browsers synthesise mouse events after a tap: remember when the last touch happened
    window.addEventListener('touchstart', () => (this.lastTouchAt = performance.now()), { passive: true, capture: true });
    window.addEventListener('touchend', () => (this.lastTouchAt = performance.now()), { passive: true, capture: true });
    el.addEventListener('contextmenu', (e) => e.preventDefault());
    window.addEventListener('mousemove', (e) => {
      if (!this.enabled) return;
      const locked = document.pointerLockElement === this.el;
      if (locked || (this.dragLook && this.dragging)) {
        this.mouseDX += e.movementX;
        this.mouseDY += e.movementY;
        if (locked) {
          this.shadowX += e.movementX;
          this.shadowY += e.movementY;
          this.lockTravel += Math.hypot(e.movementX, e.movementY);
        }
      } else {
        this.shadowX = e.clientX;
        this.shadowY = e.clientY;
      }
    });
    document.addEventListener('pointerlockchange', () => {
      this.pointerLocked = document.pointerLockElement === this.el;
      this.eventRequest = false;
      if (this.pointerLocked) {
        // the lock works here: an earlier drag-look fallback no longer applies, so losing it pauses again
        this.lockGranted = true;
        this.dragLook = false;
        this.dragging = false;
        // travel toward Skip is measured from where the cursor was locked, not from earlier looking
        this.anchorX = this.shadowX;
        this.anchorY = this.shadowY;
        this.lockTravel = 0;
      } else this.lockLostAt = performance.now();
      this.onPointerLockChange?.(this.pointerLocked);
    });
    document.addEventListener('pointerlockerror', () => {
      // promise requests report through their promise (Chrome fires this event as well)
      if (!this.eventRequest) return;
      this.eventRequest = false;
      this.lockRefused();
    });
  }

  /** a mouse event that is really a tap (touch screens emulate the mouse after touchend) */
  private emulatedMouse(): boolean {
    return performance.now() - this.lastTouchAt < 1000;
  }

  requestLock(): void {
    if (this.touch || this.pointerLocked || document.pointerLockElement) return;
    const el = this.el as HTMLElement & { requestPointerLock?: (opts?: object) => Promise<void> | void };
    if (typeof el.requestPointerLock !== 'function') return this.lockRefused();
    // a request either returns a promise (Chrome) or reports back through pointerlockchange / pointerlockerror
    const ask = (opts?: object): Promise<void> | null => {
      const p = opts ? el.requestPointerLock!(opts) : el.requestPointerLock!();
      if (p && typeof p.then === 'function') return p;
      this.eventRequest = true;
      return null;
    };
    try {
      ask({ unadjustedMovement: true })?.catch(() => {
        // unadjustedMovement is not supported everywhere: retry plainly
        try {
          ask()?.catch(() => this.lockRefused());
        } catch {
          this.lockRefused();
        }
      });
    } catch {
      this.lockRefused();
    }
  }

  /**
   * A locked click lands on Skip only when the integrated pointer is on the chip and the
   * gesture went there fairly directly. Looking around wanders a long path, so a later
   * attack click does not skip the lesson.
   */
  private lockedClickHitsChip(): boolean {
    if (!this.onLockedClick) return false;
    if (!isDirectLockedTravel(this.anchorX, this.anchorY, this.shadowX, this.shadowY, this.lockTravel)) return false;
    return this.onLockedClick(this.shadowX, this.shadowY);
  }

  /**
   * Once the lock has worked here a refusal is temporary (Chrome refuses it for ~1.25 s after the user's
   * Esc, and without a click), so stay in pointer-lock mode: drag-look is only for pages that never get it
   * (a sandboxed frame, a browser without it). A sticky fallback here left the game unpaused with a free
   * mouse, and a later lock then needed two Esc presses to pause.
   */
  private lockRefused(): void {
    if (!this.lockGranted) this.dragLook = true;
    this.onLockRefused?.(this.dragLook);
  }

  exitLock(): void {
    if (document.pointerLockElement) document.exitPointerLock();
  }

  down(code: ButtonCode): void {
    if (this.held.has(code)) return;
    this.held.add(code);
    this.pressed.add(code);
    this.downAt.set(code, performance.now());
  }

  up(code: ButtonCode): void {
    if (!this.held.has(code)) return;
    this.held.delete(code);
    this.released.add(code);
  }

  releaseAll(): void {
    for (const c of [...this.held]) this.up(c);
  }

  isDown(code: ButtonCode): boolean {
    return this.held.has(code);
  }

  /** returns true once per press */
  consumePress(code: ButtonCode): boolean {
    if (this.pressed.has(code)) {
      this.pressed.delete(code);
      return true;
    }
    return false;
  }

  consumeRelease(code: ButtonCode): boolean {
    if (this.released.has(code)) {
      this.released.delete(code);
      return true;
    }
    return false;
  }

  peekPress(code: ButtonCode): boolean {
    return this.pressed.has(code);
  }

  takeMouse(): [number, number] {
    const d: [number, number] = [this.mouseDX, this.mouseDY];
    this.mouseDX = 0;
    this.mouseDY = 0;
    return d;
  }

  /** true if anything was pressed since the last call (edges are cleared) */
  consumeAny(): boolean {
    const any = this.pressed.size > 0;
    this.pressed.clear();
    this.released.clear();
    return any;
  }

  /** drop any stale edges (e.g. after closing a menu) */
  clearEdges(): void {
    this.pressed.clear();
    this.released.clear();
    this.mouseDX = 0;
    this.mouseDY = 0;
  }
}
