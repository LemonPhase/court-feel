import * as THREE from 'three';
import { BALL, FX, TIMING } from '../config';
import type { SetPreview, SetResult } from '../game/contact';

/**
 * The set bar (2K's shot meter), beside the ball so your eyes stay on it. It starts filling when
 * you catch the ball and reaches the green line as the ball has loaded (TIMING.setLoad of game
 * time; the set slow-mo stretches it on screen). Release in the green band (your window, sized
 * by your touch and the level); the white band is a good set. After the push it stays a moment,
 * stopped where you released, coloured by the grade.
 */
export class SetBar {
  private el: HTMLDivElement;
  private good: HTMLDivElement;
  private green: HTMLDivElement;
  private fill: HTMLDivElement;
  private shownFor: SetResult | null = null;
  private linger = 0;
  private v = new THREE.Vector3();

  constructor(parent: HTMLElement) {
    const div = (cls: string, p: HTMLElement) => {
      const d = document.createElement('div');
      d.className = cls;
      p.appendChild(d);
      return d;
    };
    const B = FX.setBar;
    this.el = div('set-bar', parent);
    this.el.style.width = `${B.width}px`;
    this.el.style.height = `${B.height}px`;
    this.good = div('sb-zone sb-good', this.el);
    this.green = div('sb-zone sb-green', this.el);
    this.fill = div('sb-fill', this.el);
    div('sb-line', this.el).style.bottom = `${B.target * B.height}px`;
  }

  /** game seconds the bar's full height stands for (the green line sits at `target` of it) */
  private static span(): number {
    return TIMING.setLoad / FX.setBar.target;
  }

  /** px from the bottom for `dt` game seconds after the catch, kept on the bar */
  private static px(dt: number): number {
    return Math.max(0, Math.min(1, dt / SetBar.span())) * FX.setBar.height;
  }

  private zone(z: HTMLDivElement, half: number): void {
    const target = TIMING.setLoad;
    const lo = SetBar.px(target - half);
    const hi = SetBar.px(target + half);
    z.style.bottom = `${lo}px`;
    z.style.height = `${Math.max(1, hi - lo)}px`;
  }

  /**
   * `p` the set loading in your hands (or null), `last` your last push, `t` the render time,
   * `realDt` real seconds since the last frame.
   */
  update(
    p: SetPreview | null,
    last: SetResult | null,
    ballPos: THREE.Vector3,
    camera: THREE.PerspectiveCamera,
    t: number,
    realDt: number,
    show: boolean,
  ): void {
    if (last && last !== this.shownFor) {
      this.shownFor = last;
      this.linger = FX.setBar.linger;
    }
    this.linger = Math.max(0, this.linger - realDt);
    const live = show && !!p?.bar;
    const after = show && !live && this.linger > 0 && !!this.shownFor;
    if (!live && !after) {
      this.el.style.display = 'none';
      return;
    }
    this.el.style.display = 'block';
    let fill: number;
    let cls = '';
    if (live && p?.bar) {
      this.zone(this.good, p.bar.good);
      this.zone(this.green, p.bar.green);
      fill = SetBar.px(t - p.bar.start);
    } else {
      const r = this.shownFor!;
      this.zone(this.good, r.good);
      this.zone(this.green, r.window);
      fill = SetBar.px(TIMING.setLoad + r.err);
      cls = r.green ? 'sb-hit-green' : r.grade === 'Good' ? 'sb-hit-good' : 'sb-hit-miss';
      this.el.style.opacity = String(Math.min(1, this.linger / 0.25));
    }
    if (live) this.el.style.opacity = '1';
    this.fill.style.height = `${fill}px`;
    this.fill.className = `sb-fill ${cls}`;
    this.place(ballPos, camera);
  }

  /** beside the ball on screen, the green line level with it; kept inside the view */
  private place(ballPos: THREE.Vector3, camera: THREE.PerspectiveCamera): void {
    const B = FX.setBar;
    const w = window.innerWidth;
    const h = window.innerHeight;
    const v = this.v.copy(ballPos).project(camera);
    // behind the camera: park it right of centre
    const behind = v.z > 1;
    const sx = behind ? w * 0.6 : ((v.x + 1) / 2) * w;
    const sy = behind ? h * 0.5 : ((1 - v.y) / 2) * h;
    const dist = Math.max(0.3, camera.position.distanceTo(ballPos));
    const rPx = (BALL.radius / (dist * Math.tan(THREE.MathUtils.degToRad(camera.fov) / 2))) * (h / 2);
    const m = 8;
    const x = Math.min(w - B.width - m, Math.max(m, sx + rPx + B.gap));
    const y = Math.min(h - B.height - m, Math.max(m, sy - (1 - B.target) * B.height));
    this.el.style.transform = `translate(${x.toFixed(1)}px, ${y.toFixed(1)}px)`;
  }

  hide(): void {
    this.el.style.display = 'none';
    this.linger = 0;
  }
}
