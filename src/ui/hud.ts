import * as THREE from 'three';
import type { Grade } from '../game/athlete';
import type { RepMark } from '../game/ranked';

const GRADE_CLASS: Record<Grade, string> = {
  Perfect: 'g-perfect',
  Good: 'g-good',
  Early: 'g-early',
  Late: 'g-late',
  Miss: 'g-miss',
};

/** what the scored drills show at the top centre */
export interface Scoreboard {
  points: number;
  /** a ranked run against your best after as many reps: + ahead, - behind (null: practice, or no best yet) */
  split: number | null;
  /** a ranked run: how each finished rep went, and the run's length (null in practice) */
  run: { marks: RepMark[]; length: number } | null;
  status: 'ranked' | 'unranked' | 'practice';
  /** what the drill is doing now (the set, the block, the target...) */
  detail: string[];
}

/** 1260 -> "1 260" (a narrow space between thousands) */
export const formatPoints = (n: number): string => String(Math.round(n)).replace(/\B(?=(\d{3})+(?!\d))/g, ' ');

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
  private sb: {
    score: HTMLSpanElement;
    val: HTMLSpanElement;
    split: HTMLSpanElement;
    splitVal: HTMLSpanElement;
    run: HTMLDivElement;
    strip: HTMLSpanElement;
    count: HTMLSpanElement;
    detail: HTMLDivElement;
    status: HTMLSpanElement;
    detailText: HTMLSpanElement;
  };
  /** the scoreboard's last points (-1: just shown), so only a gain pops the number */
  private sbLast = -1;
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
    const sb = el('div', 'sb', top);
    const main = el('div', 'sb-main', sb);
    const score = el('span', 'sb-score', main);
    const val = el('span', 'sb-val', score, '0');
    el('span', 'sb-unit', score, 'pts');
    const split = el('span', 'sb-split', main);
    const splitVal = el('span', 'sb-split-val', split);
    el('span', 'sb-split-label', split, 'vs best');
    const run = el('div', 'sb-run', sb);
    const strip = el('span', 'sb-strip', run);
    const count = el('span', 'sb-count', run);
    const detail = el('div', 'sb-detail', sb);
    const status = el('span', 'sb-status', detail);
    const detailText = el('span', '', detail);
    this.sb = { score, val, split, splitVal, run, strip, count, detail, status, detailText };
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
    this.cross = el('div', 'crosshair', this.root);
    this.camTag = el('div', 'hud-cam', this.root, 'TP');
    this.loadRing = el('div', 'load-ring', this.root);
    this.chargeRing = el('div', 'charge-ring', this.root);
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

  /**
   * The scored drills' scoreboard at the top centre: the score, the split against your best, the
   * run strip and a detail line. Null hides it (Free Play and Mini Rally keep their title + score line).
   */
  setScoreboard(s: Scoreboard | null): void {
    const sb = this.sb;
    this.root.classList.toggle('has-sb', s !== null);
    if (!s) {
      this.sbLast = -1;
      return;
    }
    sb.val.textContent = formatPoints(s.points);
    if (this.sbLast >= 0 && s.points > this.sbLast) {
      // the points landing: one pop of the number
      sb.score.classList.remove('bump');
      void sb.score.offsetWidth;
      sb.score.classList.add('bump');
    }
    this.sbLast = s.points;
    const split = s.split;
    sb.split.classList.toggle('show', split !== null);
    if (split !== null) {
      sb.splitVal.textContent = split > 0 ? `+${formatPoints(split)}` : split < 0 ? `−${formatPoints(-split)}` : '±0';
      sb.split.classList.toggle('up', split > 0);
      sb.split.classList.toggle('down', split < 0);
    }
    sb.run.classList.toggle('show', s.run !== null);
    if (s.run) {
      const { marks, length } = s.run;
      while (sb.strip.children.length < length) el('i', '', sb.strip);
      while (sb.strip.children.length > length) sb.strip.lastChild!.remove();
      for (let i = 0; i < length; i++)
        (sb.strip.children[i] as HTMLElement).className = i < marks.length ? `m-${marks[i]}` : i === marks.length ? 'm-now' : '';
      sb.count.textContent = `${Math.min(marks.length + 1, length)}/${length}`;
    }
    sb.status.textContent = s.status === 'practice' ? '' : s.status === 'ranked' ? 'Ranked run' : 'Unranked';
    sb.status.className = `sb-status s-${s.status}`;
    sb.detailText.textContent = (s.status !== 'practice' && s.detail.length ? ' · ' : '') + s.detail.join(' · ');
    sb.detail.classList.toggle('show', s.status !== 'practice' || s.detail.length > 0);
  }

  setHint(t: string): void {
    if (!this.showHints) t = '';
    else if (this.keyLabels) t = this.translateKeys(t);
    if (t !== this.lastHint) {
      this.lastHint = t;
      this.hint.innerHTML = t;
    }
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

  private translateKeys(t: string): string {
    const m = this.keyLabels!;
    // combined keys first (approach = push the stick out), then single keys
    t = t.replace(/<kbd>Shift<\/kbd>\+<kbd>W<\/kbd>/g, `<kbd>${m['Shift+W'] ?? 'RUN'}</kbd>`);
    t = t.replace(/<kbd>([^<]*)<\/kbd>/g, (all, k: string) => (k in m ? `<kbd>${m[k]}</kbd>` : all));
    return t.replace(/with the mouse/g, 'by dragging');
  }

  setCam(fp: boolean): void {
    this.camTag.textContent = fp ? 'FIRST PERSON' : 'THIRD PERSON';
    this.camTag.classList.remove('pulse');
    void this.camTag.offsetWidth;
    this.camTag.classList.add('pulse');
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

  showBanner(text: string, kind: 'good' | 'bad' | 'neutral' = 'neutral'): void {
    this.banner.textContent = text;
    this.banner.className = 'hud-banner show b-' + kind;
    void this.banner.offsetWidth;
    this.banner.classList.add('pop');
    this.bannerTimer = 1.5;
  }

  message(text: string, dur = 1.5): void {
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
    // the whole bubble below the scoreboard when it is up
    const cy = Math.min(Math.max(y, this.root.classList.contains('has-sb') ? 200 : 96), h * (this.keyLabels ? 0.42 : 0.62));
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
    if (this.msgTimer > 0) {
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
