import { PLAYER, TOUCH } from '../config';
import { clamp01 } from '../core/mathx';
import { TouchPad, type PadButton } from '../core/touchPad';
import { ContactSystem } from '../game/contact';
import type { Game } from '../game/game';
import { SET_PLAYS } from '../game/plays';

function el<K extends keyof HTMLElementTagNameMap>(tag: K, cls: string, parent: HTMLElement, html = ''): HTMLElementTagNameMap[K] {
  const e = document.createElement(tag);
  e.className = cls;
  if (html) e.innerHTML = html;
  parent.appendChild(e);
  return e;
}

/** names shown in the HUD hints instead of keys */
export const TOUCH_KEY_LABELS: Record<string, string> = {
  LMB: 'HIT',
  // the tutorial's swing hint says "Left mouse" (the mock). Same button as LMB.
  'Left mouse': 'HIT',
  RMB: 'BLOCK',
  Space: 'JUMP',
  E: 'PASS',
  Q: 'TOSS',
  V: 'CAM',
  N: 'RESET',
  R: 'REPLAY',
  B: 'VS BLOCK',
  F: 'FEED',
  T: 'AUTO',
  W: 'stick ↑',
  A: 'stick ←',
  D: 'stick →',
  WASD: 'stick',
  Shift: 'stick out',
  'Shift+W': 'stick out',
};

const HOLD_BUTTONS: { id: PadButton; cls: string; label: string }[] = [
  { id: 'hit', cls: 't-hit', label: 'HIT' },
  { id: 'jump', cls: 't-jump', label: 'JUMP' },
  { id: 'block', cls: 't-block', label: 'BLOCK' },
  { id: 'pass', cls: 't-pass', label: 'PASS' },
  { id: 'toss', cls: 't-toss', label: 'TOSS' },
];

/** should the touch layer be on for this device / setting */
export function wantsTouch(setting: 'auto' | 'on' | 'off'): boolean {
  if (setting !== 'auto') return setting === 'on';
  try {
    const q = new URLSearchParams(location.search).get('touch');
    if (q === '1') return true;
    if (q === '0') return false;
    return window.matchMedia('(pointer: coarse)').matches && navigator.maxTouchPoints > 0;
  } catch {
    return false;
  }
}

/**
 * On-screen touch controls: a floating joystick on the left, aim by dragging
 * on the right, hold buttons (JUMP / HIT / BLOCK / PASS) with the same
 * press-hold-release feel as the keys, plus pause / camera / reset and the
 * drill's set calls or feed types. All input goes through TouchPad into the
 * normal Input codes.
 */
export class TouchControls {
  readonly root: HTMLDivElement;
  readonly pad: TouchPad;
  enabled = false;
  private buttons = new Map<PadButton, HTMLElement>();
  private stickBase: HTMLDivElement;
  private stickKnob: HTMLDivElement;
  private hitRing: HTMLDivElement;
  private jumpRing: HTMLDivElement;
  private chips: HTMLDivElement;
  private chipsFor = '';
  private pauseBtn: HTMLDivElement;
  private skipBtn: HTMLDivElement;
  private replayBtn: HTMLElement;
  private lastCharge = -1;
  private visible = false;

  constructor(
    parent: HTMLElement,
    private g: Game,
    private cb: { pause(): void },
  ) {
    this.root = el('div', 'touch', parent);
    this.root.style.display = 'none';
    // resting stick hint (the live stick floats under the thumb)
    this.stickBase = el('div', 't-stick', this.root);
    el('div', 't-stick-ring', this.stickBase);
    this.stickKnob = el('div', 't-knob', this.stickBase);
    const cluster = el('div', 't-cluster', this.root);
    for (const b of HOLD_BUTTONS) {
      const e = el('div', `t-btn ${b.cls}`, cluster);
      e.dataset.btn = b.id;
      el('div', 't-ring', e);
      el('span', 't-label', e, b.label);
      this.buttons.set(b.id, e);
    }
    this.hitRing = this.buttons.get('hit')!.querySelector('.t-ring') as HTMLDivElement;
    this.jumpRing = this.buttons.get('jump')!.querySelector('.t-ring') as HTMLDivElement;
    const top = el('div', 't-top', this.root);
    // first chip, left of pause (the keyboard skip lives on the HUD instead)
    this.skipBtn = el('div', 't-tap t-skip', top, 'SKIP TUTORIAL');
    this.skipBtn.style.display = 'none';
    this.pauseBtn = el('div', 't-tap t-pause', top, '<span>❚❚</span>');
    this.pauseBtn.dataset.tap = 'pause';
    for (const [id, label] of [
      ['replay', 'REPLAY'],
      ['cam', 'CAM'],
      ['reset', 'RESET'],
    ] as [PadButton, string][]) {
      const e = el('div', 't-tap', top, label);
      e.dataset.btn = id;
      this.buttons.set(id, e);
    }
    this.replayBtn = this.buttons.get('replay')!;
    this.chips = el('div', 't-chips', this.root);
    el('div', 't-rotate', this.root, 'Turn your phone sideways');

    const input = this.g.input;
    this.pad = new TouchPad(input, {
      airborne: () => this.g.me.state === 'air' || this.g.me.state === 'load',
      wantsSet: () => this.g.contact.wantsSet(this.g.me),
      // independent of the mouse sensitivity setting (the rig multiplies by it)
      lookSens: () => this.g.settings.touchSensitivity / Math.max(0.2, this.g.settings.sensitivity),
      buttonAt: (x, y) => this.buttonAt(x, y),
      width: () => this.root.clientWidth || window.innerWidth,
    });

    const r = this.root;
    r.addEventListener('pointerdown', (e) => this.onDown(e));
    r.addEventListener('pointermove', (e) => this.onMove(e));
    r.addEventListener('pointerup', (e) => this.onUp(e));
    r.addEventListener('pointercancel', (e) => this.onUp(e));
    // iOS: no double-tap zoom, no pinch, no emulated mouse events, no text selection callout
    const block = (e: Event) => e.preventDefault();
    r.addEventListener('touchstart', block, { passive: false });
    r.addEventListener('touchmove', block, { passive: false });
    r.addEventListener('touchend', block, { passive: false });
    r.addEventListener('contextmenu', block);
    window.addEventListener('blur', () => this.pad.releaseAll());
    this.g.events.on('contact', (ev) => {
      if (!this.enabled || !ev.athlete.isUser || !ev.grade) return;
      this.buzz(ev.grade === 'Perfect' ? [18, 40, 36] : ev.grade === 'Good' ? 18 : 8);
    });
  }

  /** turn the layer on or off (menus and pointer lock behave differently in touch mode) */
  setEnabled(on: boolean): void {
    if (this.enabled === on) return;
    this.enabled = on;
    this.g.input.touch = on;
    document.body.classList.toggle('touchmode', on);
    this.g.hud.keyLabels = on ? TOUCH_KEY_LABELS : null;
    if (!on) {
      this.pad.releaseAll();
      this.show(false);
    }
  }

  private show(v: boolean): void {
    if (this.visible === v) return;
    this.visible = v;
    this.root.style.display = v ? 'block' : 'none';
    if (!v) this.pad.releaseAll();
  }

  private buzz(pattern: number | number[]): void {
    try {
      navigator.vibrate?.(pattern);
    } catch {
      /* no haptics */
    }
  }

  private buttonAt(x: number, y: number): PadButton | null {
    let best: PadButton | null = null;
    let bestD = Infinity;
    for (const [id, e] of this.buttons) {
      if (e.style.display === 'none' || !e.offsetParent) continue;
      const r = e.getBoundingClientRect();
      if (r.width === 0) continue;
      const cx = r.left + r.width / 2;
      const cy = r.top + r.height / 2;
      const d = Math.hypot(x - cx, y - cy);
      // round buttons with a little slop; tap buttons are rectangles
      const inside = e.classList.contains('t-tap')
        ? x >= r.left - 4 && x <= r.right + 4 && y >= r.top - 4 && y <= r.bottom + 4
        : d <= r.width / 2 + 8;
      if (inside && d < bestD) {
        best = id;
        bestD = d;
      }
    }
    return best;
  }

  private onDown(e: PointerEvent): void {
    if (!this.enabled) return;
    e.preventDefault();
    // children have pointer-events off (the root sees every touch), so hit-test the pause button by geometry
    if (this.hitTap(this.skipBtn, e)) {
      this.pad.releaseAll();
      this.g.tutorial.requestSkip();
      return;
    }
    if (this.hitTap(this.pauseBtn, e)) {
      this.pad.releaseAll();
      this.cb.pause();
      return;
    }
    this.g.fx.audio.unlock();
    if (this.g.fx.replaying) this.g.fx.endReplay();
    try {
      this.root.setPointerCapture(e.pointerId);
    } catch {
      /* already captured */
    }
    this.pad.begin(e.pointerId, e.clientX, e.clientY, performance.now());
  }

  private onMove(e: PointerEvent): void {
    if (!this.enabled) return;
    // coalesced events keep a fast thumb drag smooth
    const evs: PointerEvent[] = e.getCoalescedEvents?.() ?? [];
    if (evs.length) for (const c of evs) this.pad.move(e.pointerId, c.clientX, c.clientY);
    else this.pad.move(e.pointerId, e.clientX, e.clientY);
  }

  private onUp(e: PointerEvent): void {
    if (!this.enabled) return;
    this.pad.end(e.pointerId);
  }

  private hitTap(node: HTMLElement, e: PointerEvent): boolean {
    if (node.style.display === 'none') return false;
    const r = node.getBoundingClientRect();
    if (r.width === 0) return false;
    return e.clientX >= r.left - 6 && e.clientX <= r.right + 6 && e.clientY >= r.top - 6 && e.clientY <= r.bottom + 6;
  }

  /** per render frame: visibility, stick drawing, hold feedback (charge / load rings), context buttons */
  update(): void {
    if (!this.enabled) return;
    const g = this.g;
    this.show(!g.inMenu && !g.paused);
    if (!this.visible) return;
    this.pad.frame();
    const me = g.me;
    // stick: floats to the thumb, rests at its home spot otherwise
    const sv = this.pad.stickView;
    const base = this.stickBase;
    base.classList.toggle('live', sv.active);
    base.classList.toggle('run', sv.active && g.input.stick.sprint);
    if (sv.active) {
      base.style.left = `${sv.ox}px`;
      base.style.top = `${sv.oy}px`;
      this.stickKnob.style.transform = `translate(${sv.kx - sv.ox}px, ${sv.ky - sv.oy}px)`;
    } else {
      base.style.left = '';
      base.style.top = '';
      this.stickKnob.style.transform = '';
    }
    // held buttons
    for (const [id, e] of this.buttons) e.classList.toggle('held', this.pad.isHeld(id));
    // JUMP: load ring (same read-out as the HUD ring)
    const load = me.state === 'load' ? clamp01((me.loadT - PLAYER.loadMin * 0.5) / (PLAYER.loadMax - PLAYER.loadMin * 0.5)) : -1;
    this.setRing(this.jumpRing, load);
    // HIT: wind-up charge, and a "ready" glow while airborne (the whole right half is HIT now)
    const wind = me.action?.kind === 'windup' ? me.action : null;
    const charge = wind ? ContactSystem.chargeFor(g.simTime - wind.t0) : -1;
    this.setRing(this.hitRing, charge);
    if (charge >= 1 && this.lastCharge < 1) this.buzz(12);
    this.lastCharge = charge;
    const air = me.state === 'air' || me.state === 'load';
    this.buttons.get('hit')!.classList.toggle('ready', air && TOUCH.airHitAnywhere && !wind);
    this.buttons.get('hit')!.classList.toggle('sweet', g.hud.collarSweet);
    this.skipBtn.classList.toggle('nudge', g.tutorial.stuck());
    // tutorial: the chip left of pause, and the buttons the current step is not teaching go quiet
    const skipDisplay = g.tutorial.teaching ? 'flex' : 'none';
    if (this.skipBtn.style.display !== skipDisplay) this.skipBtn.style.display = skipDisplay;
    const dim = new Set<string>();
    if (g.tutorial.quiet()) for (const id of ['block', 'pass', 'toss']) dim.add(id);
    for (const [id, e] of this.buttons) if (e.classList.contains('t-btn')) e.classList.toggle('dim', dim.has(id));
    // BLOCK reads SET when a press would set
    const blockLabel = this.buttons.get('block')!.querySelector('.t-label')!;
    const wantsSet = g.contact.wantsSet(me);
    const want = wantsSet ? 'SET' : 'BLOCK';
    if (blockLabel.textContent !== want) blockLabel.textContent = want;
    // the last highlight can be replayed once the ball is dead
    const replay = g.replayAvailable() && !g.fx.replaying;
    const rd = replay ? '' : 'none';
    if (this.replayBtn.style.display !== rd) this.replayBtn.style.display = rd;
    // drill context: set calls / feed types / toss
    const key = `${g.modeId}:${g.position}:${g.tutorial.active ? 'tut' : ''}`;
    if (key !== this.chipsFor) {
      this.chipsFor = key;
      this.buildChips();
    }
  }

  private setRing(ring: HTMLDivElement, frac: number): void {
    if (frac < 0) {
      if (ring.style.opacity !== '0') {
        ring.style.opacity = '0';
        ring.classList.remove('full');
      }
      return;
    }
    ring.style.opacity = '1';
    ring.style.setProperty('--p', `${Math.round(frac * 100)}%`);
    ring.classList.toggle('full', frac >= 0.99);
  }

  private buildChips(): void {
    const g = this.g;
    for (const id of ['feed', 'auto', 'vsblock', 'd1', 'd2', 'd3', 'd4', 'd5'] as PadButton[]) this.buttons.delete(id);
    this.chips.innerHTML = '';
    const chip = (id: PadButton, label: string) => {
      const e = el('div', 't-tap t-chip', this.chips, label);
      e.dataset.btn = id;
      this.buttons.set(id, e);
    };
    const toss = this.buttons.get('toss')!;
    toss.style.display = g.modeId === 'free' ? '' : 'none';
    // tutorial reps: no set-call chips and no block toggle (one Outside story, block off)
    const calls = !g.tutorial.active && (g.modeId === 'spike' || g.modeId === 'rally') && SET_PLAYS[g.position];
    if (calls) {
      el('span', 't-chip-l', this.chips, 'SET CALL');
      chip('d1', '1');
      chip('d2', '2');
      chip('d3', '3');
    }
    if (g.modeId === 'spike' && !g.tutorial.active) chip('vsblock', 'VS BLOCK');
    if (g.modeId === 'free') {
      el('span', 't-chip-l', this.chips, 'FEED');
      for (let i = 1; i <= 5; i++) chip(`d${i}` as PadButton, String(i));
      chip('feed', 'FEED');
      chip('auto', 'AUTO');
    }
  }
}
