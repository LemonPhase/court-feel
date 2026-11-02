/**
 * Raw keyboard / mouse state with per-frame edges. Edges are latched until the
 * game consumes them so a press is never lost between fixed steps.
 * The bot (autopilot) injects events through the same path as real hardware.
 */
export type ButtonCode = string; // KeyboardEvent.code or 'Mouse0' / 'Mouse2'

export class Input {
  readonly held = new Set<ButtonCode>();
  private pressed = new Set<ButtonCode>();
  private released = new Set<ButtonCode>();
  /** time (performance.now ms) a button went down */
  readonly downAt = new Map<ButtonCode, number>();
  mouseDX = 0;
  mouseDY = 0;
  pointerLocked = false;
  /** when pointer lock is unavailable (headless / denied) allow drag-look */
  dragLook = false;
  private dragging = false;
  enabled = true;
  onPointerLockChange: ((locked: boolean) => void) | null = null;
  /** keys that should never reach the browser default handler */
  private static readonly swallow = new Set([
    'Space', 'Tab', 'F3', 'ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', 'ShiftLeft', 'ShiftRight',
  ]);

  constructor(private readonly el: HTMLElement) {
    window.addEventListener('keydown', (e) => {
      if (Input.swallow.has(e.code)) e.preventDefault();
      if (e.repeat) return;
      if ((e.target as HTMLElement)?.tagName === 'INPUT' && e.code !== 'Escape') return;
      this.down(e.code);
    });
    window.addEventListener('keyup', (e) => this.up(e.code));
    window.addEventListener('blur', () => this.releaseAll());
    el.addEventListener('mousedown', (e) => {
      e.preventDefault();
      if (!this.enabled) return;
      this.down('Mouse' + e.button);
      if (this.dragLook) this.dragging = true;
    });
    window.addEventListener('mouseup', (e) => {
      this.up('Mouse' + e.button);
      this.dragging = false;
    });
    el.addEventListener('contextmenu', (e) => e.preventDefault());
    window.addEventListener('mousemove', (e) => {
      if (!this.enabled) return;
      if (this.pointerLocked || (this.dragLook && this.dragging)) {
        this.mouseDX += e.movementX;
        this.mouseDY += e.movementY;
      }
    });
    document.addEventListener('pointerlockchange', () => {
      this.pointerLocked = document.pointerLockElement === this.el;
      this.onPointerLockChange?.(this.pointerLocked);
    });
  }

  requestLock(): void {
    try {
      const p = (this.el as any).requestPointerLock?.({ unadjustedMovement: true });
      if (p && typeof p.catch === 'function') {
        p.catch(() => {
          // unadjustedMovement is not supported everywhere: retry plainly
          try {
            const p2 = (this.el as any).requestPointerLock?.();
            if (p2 && typeof p2.catch === 'function') p2.catch(() => (this.dragLook = true));
          } catch {
            this.dragLook = true;
          }
        });
      }
    } catch {
      this.dragLook = true;
    }
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

  /** drop any stale edges (e.g. after closing a menu) */
  clearEdges(): void {
    this.pressed.clear();
    this.released.clear();
    this.mouseDX = 0;
    this.mouseDY = 0;
  }
}
