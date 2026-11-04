import * as THREE from 'three';
import type { Grade } from '../game/athlete';
import { TIMING } from '../config';
import { COLLAR_DEG_PER_S, collarDegrees, collarZone } from '../game/tutorial';

const GRADE_CLASS: Record<Grade, string> = {
  Perfect: 'g-perfect',
  Good: 'g-good',
  Early: 'g-early',
  Late: 'g-late',
  Miss: 'g-miss',
};

/** hint `<kbd>` names → touch button names. Combined approach keys first. */
export function translateKeyMarkup(t: string, m: Record<string, string>): string {
  t = t.replace(/<kbd>Shift<\/kbd>\+<kbd>W<\/kbd>/g, `<kbd>${m['Shift+W'] ?? 'RUN'}</kbd>`);
  t = t.replace(/<kbd>([^<]*)<\/kbd>/g, (all, k: string) => (k in m ? `<kbd>${m[k]}</kbd>` : all));
  return t.replace(/with the mouse/g, 'by dragging');
}

/** annular sector. Degrees are collar degrees: 0 at 12 o'clock, positive (late) to the right. */
function ringSector(a0: number, a1: number, r0: number, r1: number): string {
  const p = (deg: number, r: number) => {
    const a = ((deg - 90) * Math.PI) / 180;
    return [Math.cos(a) * r, Math.sin(a) * r];
  };
  const large = a1 - a0 > 180 ? 1 : 0;
  const [x0, y0] = p(a0, r1);
  const [x1, y1] = p(a1, r1);
  const [x2, y2] = p(a1, r0);
  const [x3, y3] = p(a0, r0);
  return `M ${x0.toFixed(2)} ${y0.toFixed(2)} A ${r1} ${r1} 0 ${large} 1 ${x1.toFixed(2)} ${y1.toFixed(2)} L ${x2.toFixed(2)} ${y2.toFixed(2)} A ${r0} ${r0} 0 ${large} 0 ${x3.toFixed(2)} ${y3.toFixed(2)} Z`;
}

function el<K extends keyof HTMLElementTagNameMap>(tag: K, cls: string, parent: HTMLElement, text = ''): HTMLElementTagNameMap[K] {
  const e = document.createElement(tag);
  e.className = cls;
  if (text) e.textContent = text;
  parent.appendChild(e);
  return e;
}

/** In-game HUD: timing grade, ball speed, streak, score line, key hints. */
export class Hud {
  readonly root: HTMLDivElement;
  private title: HTMLDivElement;
  private score: HTMLDivElement;
  private grade: HTMLDivElement;
  private gradeText: HTMLDivElement;
  private gradeSub: HTMLDivElement;
  private banner: HTMLDivElement;
  private speedVal: HTMLSpanElement;
  private streakBox: HTMLDivElement;
  private streakVal: HTMLSpanElement;
  private hint: HTMLDivElement;
  private msg: HTMLDivElement;
  private cross: HTMLDivElement;
  private fadeEl: HTMLDivElement;
  private camTag: HTMLDivElement;
  private loadRing: HTMLDivElement;
  private chargeRing: HTMLDivElement;
  private goCue: HTMLDivElement;
  private callout: HTMLDivElement;
  private callWho: HTMLDivElement;
  private callWord: HTMLDivElement;
  private callSub: HTMLDivElement;
  private callTimer = 0;
  /** tutorial step title stays up until the step changes (hud-msg is otherwise a toast) */
  private msgPinned = false;
  /** while the tutorial is running, setter speech bubbles stay down */
  suppressCalls = false;
  /** SKIP TUTORIAL chip (keyboard). Touch draws its own in the top row. */
  private skipBtn: HTMLButtonElement;
  onSkip: (() => void) | null = null;
  /** timing collar is in the Perfect window: touch HIT borrows this */
  collarSweet = false;
  private collar!: HTMLDivElement;
  private collarMarker!: SVGCircleElement;
  private collarZones: { el: SVGPathElement; name: string }[] = [];
  private freezeVeil!: HTMLDivElement;
  private freezeTag!: HTMLDivElement;
  private callAnchor: ((out: THREE.Vector3) => THREE.Vector3) | null = null;
  private callP = new THREE.Vector3();
  private callV = new THREE.Vector3();
  /** the camera speech bubbles are placed with (set by the game) */
  camera: THREE.Camera | null = null;
  private gradeTimer = 0;
  private bannerTimer = 0;
  private msgTimer = 0;
  showHints = true;
  /** touch controls: key names in hints are shown as button names (null = keyboard) */
  keyLabels: Record<string, string> | null = null;

  constructor(parent: HTMLElement) {
    this.root = el('div', 'hud', parent);
    const top = el('div', 'hud-top', this.root);
    this.title = el('div', 'hud-title', top);
    this.score = el('div', 'hud-score', top);
    this.grade = el('div', 'hud-grade', this.root);
    this.gradeText = el('div', 'hud-grade-text', this.grade);
    this.gradeSub = el('div', 'hud-grade-sub', this.grade);
    this.banner = el('div', 'hud-banner', this.root);
    const bl = el('div', 'hud-bl', this.root);
    const sp = el('div', 'hud-speed', bl);
    this.speedVal = el('span', 'hud-speed-val', sp, '--');
    el('span', 'hud-speed-unit', sp, 'km/h');
    el('div', 'hud-speed-label', bl, 'last ball');
    this.streakBox = el('div', 'hud-streak', this.root);
    el('span', 'hud-streak-label', this.streakBox, 'STREAK');
    this.streakVal = el('span', 'hud-streak-val', this.streakBox, '0');
    this.hint = el('div', 'hud-hint', this.root);
    this.msg = el('div', 'hud-msg', this.root);
    this.skipBtn = el('button', 't-tap t-skip-kb', this.root, 'SKIP TUTORIAL');
    this.skipBtn.type = 'button';
    this.skipBtn.addEventListener('pointerdown', (e) => {
      e.preventDefault();
      e.stopPropagation();
      this.onSkip?.();
    });
    this.cross = el('div', 'crosshair', this.root);
    this.camTag = el('div', 'hud-cam', this.root, 'TP');
    this.loadRing = el('div', 'load-ring', this.root);
    this.chargeRing = el('div', 'charge-ring', this.root);
    this.collar = this.buildCollar();
    this.freezeVeil = el('div', 't-freeze', this.root);
    this.freezeTag = el('div', 't-freeze-tag', this.root, 'FROZEN · YOUR MOVE');
    this.goCue = el('div', 'go-cue', this.root, 'GO');
    this.callout = el('div', 'callout', this.root);
    const bubble = el('div', 'callout-bubble', this.callout);
    this.callWho = el('div', 'callout-who', bubble);
    this.callWord = el('div', 'callout-word', bubble);
    this.callSub = el('div', 'callout-sub', bubble);
    this.fadeEl = el('div', 'fade', parent);
  }

  setVisible(v: boolean): void {
    this.root.style.display = v ? 'block' : 'none';
  }

  setTitle(t: string): void {
    this.title.textContent = t;
  }

  setScore(t: string): void {
    this.score.textContent = t;
  }

  /** `force` keeps a tutorial coach line up even when Settings → Hints is off */
  setHint(t: string, force = false): void {
    if (!this.showHints && !force) t = '';
    else if (this.keyLabels && t) t = translateKeyMarkup(t, this.keyLabels);
    if (t !== this.lastHint) {
      this.lastHint = t;
      this.hint.innerHTML = t;
    }
  }

  /** keyboard skip chip + the camera-tag nudge. Touch hides this chip in CSS. */
  setTutorialChrome(on: boolean): void {
    this.root.classList.toggle('tutoring', on);
  }

  /** freeze feel: desaturated court, vignette, FROZEN · YOUR MOVE */
  setFrozen(on: boolean): void {
    this.root.classList.toggle('frozen', on);
    document.body.classList.toggle('frozen', on);
    this.freezeVeil.setAttribute('aria-hidden', on ? 'false' : 'true');
    this.freezeTag.setAttribute('aria-hidden', on ? 'false' : 'true');
  }

  /** anti-stuck: pulse the hint key and brighten Skip, once */
  setNudge(on: boolean): void {
    this.hint.classList.toggle('nudge', on);
    this.skipBtn.classList.toggle('nudge', on);
  }

  nudgeTutorial(): void {
    this.setNudge(true);
  }

  /**
   * Timing collar around the charge ring. `err` is how late a release now would be
   * (negative = early). Null hides it.
   */
  setTiming(err: number | null): void {
    if (err === null) {
      this.collar.style.opacity = '0';
      this.chargeRing.classList.remove('sweet');
      this.cross.classList.remove('sweet');
      this.collarSweet = false;
      document.body.classList.remove('collar');
      return;
    }
    document.body.classList.add('collar');
    this.collar.style.opacity = '1';
    const zone = collarZone(err);
    this.collarSweet = zone === 'perfect';
    this.chargeRing.classList.toggle('sweet', this.collarSweet);
    this.cross.classList.toggle('sweet', this.collarSweet);
    const deg = collarDegrees(err);
    const rad = ((deg - 90) * Math.PI) / 180;
    const mx = Math.cos(rad) * 37;
    const my = Math.sin(rad) * 37;
    this.collarMarker.setAttribute('cx', mx.toFixed(2));
    this.collarMarker.setAttribute('cy', my.toFixed(2));
    for (const z of this.collarZones) z.el.classList.toggle('lit', z.name === zone);
  }

  private buildCollar(): HTMLDivElement {
    const wrap = el('div', 'timing-collar', this.root);
    const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    svg.setAttribute('viewBox', '-46 -46 92 92');
    const dps = COLLAR_DEG_PER_S;
    const zones: { name: string; a0: number; a1: number }[] = [
      { name: 'wood', a0: -90, a1: -TIMING.spikeGood * dps },
      { name: 'good', a0: -TIMING.spikeGood * dps, a1: -TIMING.spikePerfect * dps },
      { name: 'perfect', a0: -TIMING.spikePerfect * dps, a1: TIMING.spikePerfectLate * dps },
      { name: 'good', a0: TIMING.spikePerfectLate * dps, a1: TIMING.spikeGoodLate * dps },
      { name: 'wood', a0: TIMING.spikeGoodLate * dps, a1: 72 },
    ];
    for (const z of zones) {
      const path = document.createElementNS('http://www.w3.org/2000/svg', 'path');
      path.setAttribute('d', ringSector(z.a0, z.a1, 33, 41));
      path.setAttribute('class', `tz-${z.name}`);
      svg.appendChild(path);
      this.collarZones.push({ el: path, name: z.name });
    }
    const notch = document.createElementNS('http://www.w3.org/2000/svg', 'line');
    notch.setAttribute('x1', '0');
    notch.setAttribute('y1', '-29');
    notch.setAttribute('x2', '0');
    notch.setAttribute('y2', '-44');
    notch.setAttribute('class', 'tz-notch');
    svg.appendChild(notch);
    this.collarMarker = document.createElementNS('http://www.w3.org/2000/svg', 'circle');
    this.collarMarker.setAttribute('r', '5.2');
    this.collarMarker.setAttribute('class', 'tz-marker');
    svg.appendChild(this.collarMarker);
    wrap.appendChild(svg);
    return wrap;
  }

  /** viewport point over the keyboard Skip chip (hidden on touch, and whenever the lesson isn't up) */
  skipHit(x: number, y: number): boolean {
    if (!this.root.classList.contains('tutoring')) return false;
    const r = this.skipBtn.getBoundingClientRect();
    if (r.width < 1 || r.height < 1) return false;
    const slop = 8;
    return x >= r.left - slop && x <= r.right + slop && y >= r.top - slop && y <= r.bottom + slop;
  }

  private lastHint = '';

  /** plain-text drill messages: key names become button names */
  private static readonly TEXT_KEYS: [RegExp, string][] = [
    [/Shift \+ W/g, 'the stick out'],
    [/\bSpace\b/g, 'JUMP'],
    [/Left mouse/g, 'HIT'],
    [/\bLMB\b/g, 'HIT'],
    [/\bRMB\b/g, 'BLOCK'],
    [/\bpress E\b/g, 'hold PASS'],
    [/\bQ\b/g, 'TOSS'],
    [/\bF feed\b/g, 'FEED feed'],
    [/\bT auto\b/g, 'AUTO auto'],
    [/with the mouse/g, 'by dragging'],
  ];

  static translateText(t: string): string {
    for (const [re, to] of Hud.TEXT_KEYS) t = t.replace(re, to);
    return t;
  }


  setCam(fp: boolean): void {
    this.camTag.textContent = fp ? 'FIRST PERSON' : 'THIRD PERSON';
    this.camTag.classList.remove('pulse');
    void this.camTag.offsetWidth;
    this.camTag.classList.add('pulse');
  }

  /** drop a grade / banner left up by the previous drill (tutorial entry, replay) */
  clearFlash(): void {
    this.gradeTimer = 0;
    this.bannerTimer = 0;
    this.grade.classList.remove('show');
    this.banner.classList.remove('show');
  }

  showGrade(g: Grade, sub: string): void {
    this.gradeText.textContent = g === 'Miss' ? 'MISS' : g.toUpperCase();
    this.grade.className = 'hud-grade show ' + GRADE_CLASS[g];
    this.gradeSub.textContent = sub;
    // restart animation
    void this.grade.offsetWidth;
    this.grade.classList.add('pop');
    this.gradeTimer = g === 'Perfect' ? 1.6 : 1.2;
  }

  showBanner(text: string, kind: 'good' | 'bad' | 'neutral' = 'neutral', dur = 1.5): void {
    this.banner.textContent = text;
    this.banner.className = 'hud-banner show b-' + kind;
    void this.banner.offsetWidth;
    this.banner.classList.add('pop');
    this.bannerTimer = dur;
  }

  /** step title that stays until cleared (the tutorial's STEP 2 · JUMP line) */
  pinMessage(text: string | null): void {
    if (!text) {
      this.msgPinned = false;
      this.msg.classList.remove('show');
      this.msgTimer = 0;
      return;
    }
    this.msgPinned = true;
    this.msg.textContent = text;
    this.msg.classList.add('show');
    this.msgTimer = 0;
  }

  message(text: string, dur = 1.5): void {
    if (this.msgPinned) return;
    if (this.keyLabels) text = Hud.translateText(text);
    this.msg.textContent = text;
    this.msg.classList.add('show');
    this.msgTimer = dur;
  }

  setSpeed(kmh: number | null): void {
    this.speedVal.textContent = kmh === null ? '--' : kmh.toFixed(0);
  }

  setStreak(n: number): void {
    this.streakVal.textContent = String(n);
    this.streakBox.classList.toggle('hot', n >= 3);
    this.streakBox.classList.toggle('fire', n >= 6);
  }

  /** jump load meter under the crosshair (null hides it) */
  setLoad(frac: number | null): void {
    if (frac === null) {
      this.loadRing.style.opacity = '0';
      return;
    }
    this.loadRing.style.opacity = '1';
    this.loadRing.style.setProperty('--p', `${Math.round(frac * 100)}%`);
    this.loadRing.classList.toggle('full', frac >= 0.99);
  }

  /** spike wind-up power around the crosshair (null hides it) */
  setCharge(frac: number | null): void {
    if (frac === null) {
      this.chargeRing.style.opacity = '0';
      this.chargeRing.classList.remove('full');
      return;
    }
    this.chargeRing.style.opacity = '1';
    this.chargeRing.style.setProperty('--p', `${Math.round(frac * 100)}%`);
    this.chargeRing.classList.toggle('full', frac >= 0.999);
  }

  /** approach timing cue */
  go(): void {
    this.goCue.classList.remove('show');
    void this.goCue.offsetWidth;
    this.goCue.classList.add('show');
  }

  /**
   * A team-mate's call in a speech bubble over their head: `kind` 'out' is a warning
   * (orange), 'in' a confirmation (cyan). `anchor` writes the point above their head and is
   * followed every frame; when they are off screen the bubble waits at the edge on their side.
   */
  call(
    who: string,
    word: string,
    sub: string,
    kind: 'in' | 'out',
    anchor: ((out: THREE.Vector3) => THREE.Vector3) | null,
    dur = 1.5,
  ): void {
    if (this.suppressCalls) return;
    this.callWho.textContent = who;
    this.callWord.textContent = word;
    this.callSub.textContent = sub;
    this.callAnchor = anchor;
    this.callout.className = `callout show c-${kind}`;
    this.placeCall();
    void this.callout.offsetWidth;
    this.callout.classList.add('pop');
    this.callTimer = dur;
  }

  /** take a call bubble down (the point is over) */
  clearCall(): void {
    this.callTimer = 0;
    this.callAnchor = null;
    this.callout.classList.remove('show');
  }

  private placeCall(): void {
    const cam = this.camera;
    const w = this.root.clientWidth;
    const h = this.root.clientHeight;
    const st = this.callout.style;
    if (!cam || !this.callAnchor || !w || !h) {
      st.left = '50%';
      st.top = '26%';
      this.callout.classList.add('edge');
      this.callout.classList.remove('edge-l', 'edge-r');
      return;
    }
    const p = this.callAnchor(this.callP);
    cam.updateMatrixWorld();
    const v = this.callV.copy(p).applyMatrix4(cam.matrixWorldInverse);
    let x: number;
    let y: number;
    if (v.z < -0.2) {
      p.project(cam);
      x = (p.x * 0.5 + 0.5) * w;
      y = (-p.y * 0.5 + 0.5) * h;
    } else {
      // behind the camera: wait at the edge on their side
      x = v.x < 0 ? 0 : w;
      y = h * 0.3;
    }
    // keep the whole bubble on screen (its anchor is the tip of the tail, under the bubble),
    // and on a touch screen above the thumb buttons
    const mx = Math.min(110, w * 0.2);
    const cx = Math.min(Math.max(x, mx), w - mx);
    const cy = Math.min(Math.max(y, 96), h * (this.keyLabels ? 0.42 : 0.62));
    // off screen: no tail, an arrow towards them instead
    this.callout.classList.toggle('edge', Math.abs(cx - x) > 2 || Math.abs(cy - y) > 2);
    this.callout.classList.toggle('edge-l', x < cx - 2);
    this.callout.classList.toggle('edge-r', x > cx + 2);
    st.left = `${cx.toFixed(1)}px`;
    st.top = `${cy.toFixed(1)}px`;
  }

  setCrosshair(visible: boolean, active = false): void {
    this.cross.style.display = visible ? 'block' : 'none';
    this.cross.classList.toggle('active', active);
  }

  /** soft partial dip that masks a camera snap (never a full black cut) */
  dip(): void {
    if (this.root.style.display === 'none') return;
    const f = this.fadeEl;
    f.style.transition = 'none';
    f.classList.add('dip');
    void f.offsetWidth;
    f.style.transition = '';
    requestAnimationFrame(() => f.classList.remove('dip'));
  }

  update(dt: number): void {
    if (this.gradeTimer > 0) {
      this.gradeTimer -= dt;
      if (this.gradeTimer <= 0) this.grade.classList.remove('show');
    }
    if (this.bannerTimer > 0) {
      this.bannerTimer -= dt;
      if (this.bannerTimer <= 0) this.banner.classList.remove('show');
    }
    if (!this.msgPinned && this.msgTimer > 0) {
      this.msgTimer -= dt;
      if (this.msgTimer <= 0) this.msg.classList.remove('show');
    }
    if (this.callTimer > 0) {
      this.callTimer -= dt;
      if (this.callTimer <= 0) this.clearCall();
      else this.placeCall();
    }
  }
}
