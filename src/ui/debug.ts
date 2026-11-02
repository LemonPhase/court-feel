/** F3 debug overlay: FPS, step time, ball state, timing window. */
export interface DebugInfo {
  fps: number;
  frameMs: number;
  stepMs: number;
  steps: number;
  lines: string[];
  /** timing window: times relative to now (s). null = no active window */
  window: null | {
    now: number;
    ideal: number;
    perfect: number;
    good: number;
    ok: number;
    press?: number;
    label: string;
  };
}

export class DebugOverlay {
  readonly el: HTMLDivElement;
  private text: HTMLPreElement;
  private canvas: HTMLCanvasElement;
  private ctx: CanvasRenderingContext2D;
  visible = false;
  private lastPress: { t: number; ideal: number; label: string } | null = null;

  constructor(parent: HTMLElement) {
    this.el = document.createElement('div');
    this.el.className = 'debug';
    this.text = document.createElement('pre');
    this.canvas = document.createElement('canvas');
    this.canvas.width = 300;
    this.canvas.height = 56;
    this.ctx = this.canvas.getContext('2d')!;
    this.el.append(this.text, this.canvas);
    parent.appendChild(this.el);
    this.el.style.display = 'none';
  }

  toggle(): void {
    this.visible = !this.visible;
    this.el.style.display = this.visible ? 'block' : 'none';
  }

  notePress(t: number, ideal: number, label: string): void {
    this.lastPress = { t, ideal, label };
  }

  update(info: DebugInfo): void {
    if (!this.visible) return;
    this.text.textContent =
      `FPS ${info.fps.toFixed(0)}  frame ${info.frameMs.toFixed(2)}ms\n` +
      `physics ${info.stepMs.toFixed(3)}ms x${info.steps} steps\n` +
      info.lines.join('\n');
    const c = this.ctx;
    const W = this.canvas.width;
    const H = this.canvas.height;
    c.clearRect(0, 0, W, H);
    c.fillStyle = 'rgba(0,0,0,0.5)';
    c.fillRect(0, 0, W, H);
    // timeline: -0.3s .. +0.6s around now
    const t0 = -0.3;
    const t1 = 0.6;
    const X = (t: number) => ((t - t0) / (t1 - t0)) * W;
    const w = info.window;
    c.font = '10px monospace';
    if (w) {
      const band = (half: number, col: string) => {
        c.fillStyle = col;
        c.fillRect(X(w.ideal - half), 14, X(w.ideal + half) - X(w.ideal - half), 22);
      };
      band(w.ok, 'rgba(255,120,60,0.45)');
      band(w.good, 'rgba(90,200,255,0.6)');
      band(w.perfect, 'rgba(255,230,80,0.95)');
      c.fillStyle = '#fff';
      c.fillText(w.label, 4, 10);
    } else {
      c.fillStyle = '#aaa';
      c.fillText('no contact window', 4, 10);
    }
    // "now" marker: swing would land at now + nominal
    c.fillStyle = '#ff3b6b';
    c.fillRect(X(0) - 1, 10, 2, 30);
    c.fillStyle = '#fff';
    c.fillText('now', X(0) - 8, 50);
    if (this.lastPress) {
      c.fillStyle = '#bbb';
      c.fillText(`last: ${this.lastPress.label}`, 120, 50);
    }
  }
}
