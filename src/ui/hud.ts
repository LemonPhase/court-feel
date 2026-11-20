import * as THREE from 'three';
import type { Grade } from '../game/athlete';
import { TIMING, type HudLook } from '../config';
import { TEAM_COLORS } from '../character/kits';
import { COLLAR_DEG_PER_S, collarDegrees, collarZone, CUE_NAMES, CUE_ORDER, type Cue, type CueId } from '../game/tutorial';
import type { CallSheetView } from '../game/callRuns';

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
  // (a key range named as one button: the setter's 1-4 is the SET TO chips, a hitter's 1-5 the ROUTE chips)
  t = t.replace(/<kbd>1<\/kbd>-<kbd>(\d)<\/kbd>/g, (all, n: string) => {
    const name = m[`1-${n}`] ?? m['1-n'];
    return name ? `<kbd>${name}</kbd>` : all;
  });
  t = t.replace(/<kbd>([^<]*)<\/kbd>/g, (all, k: string) => (k in m ? `<kbd>${m[k]}</kbd>` : all));
  // a setter's chip names itself: "DUMP dump", "OH OH" read once
  t = t.replace(/(<kbd>(OH|MB|OPP|PIPE|DUMP)<\/kbd>) \2\b/gi, '$1');
  // the REPLAY button names itself: "REPLAY last attempt", not "REPLAY replay last attempt"
  t = t.replace(/(<kbd>REPLAY<\/kbd>) replay /g, '$1 ');
  return t.replace(/with the mouse/g, 'by dragging');
}

/**
 * On touch, a part of the key line that is only a button and its own verb ("PASS pass", "CAM camera") says what the
 * button already says on screen: it goes, and the line keeps what the buttons can't (when, how, a hitter's call).
 * `t` is a line already in touch names (translateKeyMarkup); `m` the names, whose values are the buttons.
 */
export function dropSelfNamed(t: string, m: Record<string, string>): string {
  const buttons = new Set(Object.values(m));
  return t
    .split(' · ')
    .filter((part) => {
      const k = /^<kbd>([^<]+)<\/kbd> [a-z/]+$/.exec(part.trim());
      return !(k && buttons.has(k[1]));
    })
    .join(' · ');
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

/** a team's jersey, drawn in its kit colour: who won the point, on the strap */
const JERSEY =
  '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M8.3 2.6 3 5.3l1.7 5.2 2.5-.9v11.8h9.6V9.6l2.5.9L21 5.3l-5.3-2.7c-.6 1.8-2 2.8-3.7 2.8s-3.1-1-3.7-2.8Z"/></svg>';

/** the game's ball (yellow, blue and white panels, as the 3D ball is drawn): who serves */
const BALL =
  '<svg viewBox="0 0 24 24" aria-hidden="true"><defs><clipPath id="vb-clip"><circle cx="12" cy="12" r="10"/></clipPath></defs>' +
  '<circle cx="12" cy="12" r="10" class="vb-y"/><g clip-path="url(#vb-clip)">' +
  '<path d="M3.2 2.2C9.4 6 11.2 12.4 8.1 22.6" class="vb-b"/><path d="M23.4 8.4c-6.2 1.6-9.6 6.4-9.4 15" class="vb-w"/>' +
  '<path d="M1 13.6c4.6-.6 8.6-2.6 11.6-6.4" class="vb-seam"/></g><circle cx="12" cy="12" r="10" class="vb-rim"/></svg>';

/** one part of a drill's score line, as the score shows it: a value and what it counts */
export interface StatCell {
  label: string;
  value: string;
  /** the value is a number (set in the numerals) */
  num: boolean;
  /** words after the number ("of 4" in "avg 2.30 of 4"), shown small after it */
  tail: string;
}

/** a drill's score line ("12 pts · rep 5 · target: Line") as the score's cells: each part split into its value and its label */
export function statCells(t: string): StatCell[] {
  return t
    .split(' · ')
    .map((s) => s.trim())
    .filter(Boolean)
    .map((s): StatCell => {
      // "12 pts", "+40"
      let m = /^([+-]?\d+(?:[.:]\d+)?)\s*(.*)$/.exec(s);
      if (m) return { value: m[1], label: m[2], num: true, tail: '' };
      // "target: Line", "Serve 1: Jump float"
      m = /^([^:]+):\s*(.+)$/.exec(s);
      if (m) return { label: m[1], value: m[2], num: /^[+-]?\d+(?:\.\d+)?$/.test(m[2]), tail: '' };
      // "rep 5", "avg 2.30 of 4", "last 3 (64 km/h)"
      m = /^(\D+?)\s+([+-]?\d+(?:\.\d+)?)(?:\s+(.+))?$/.exec(s);
      if (m) return { label: m[1], value: m[2], num: true, tail: m[3] ?? '' };
      // "auto on"
      return { label: '', value: s, num: false, tail: '' };
    });
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
  /** what hangs at the bottom, stacked: the calls (a hitter's route strip goes here too), the lesson's cue, the keys */
  readonly foot: HTMLDivElement;
  /** the score: the VNL bar or the Games bug (the look decides how it is laid out) */
  private bug: HTMLDivElement;
  private band: HTMLDivElement;
  private usPts: HTMLElement;
  private themPts: HTMLElement;
  private usSlot: HTMLElement;
  private themSlot: HTMLElement;
  private usTeam: HTMLElement;
  private themTeam: HTMLElement;
  private cells: HTMLDivElement;
  private cellsText = '';
  /** the serve marker: flies over to the side that wins the serve */
  private ball: HTMLElement;
  private ballDirty = true;
  /** what you play, on the tab under the score */
  private tab: HTMLDivElement;
  /** why the point ended, on the strap under the score (Mini Rally) */
  private strap: HTMLDivElement;
  private strapWhat: HTMLElement;
  private strapWho: HTMLElement;
  private strapTimer = 0;
  private speedBox: HTMLDivElement;
  private grade: HTMLDivElement;
  private gradeText: HTMLDivElement;
  private gradeSub: HTMLDivElement;
  private banner: HTMLDivElement;
  private speedVal: HTMLSpanElement;
  private streakBox: HTMLDivElement;
  private streakVal: HTMLSpanElement;
  private hint: HTMLDivElement;
  private sheet: HTMLDivElement;
  private sheetHtml = '';
  private msg: HTMLDivElement;
  private cross: HTMLDivElement;
  private fadeEl: HTMLDivElement;
  private camTag: HTMLDivElement;
  private loadRing: HTMLDivElement;
  private chargeRing: HTMLDivElement;
  /** a tick on the ring, outside its mask so it reads over the court: where to let go of a held toss */
  private chargeMark: HTMLDivElement;
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
  /** the lesson: the four parts of a spike, and the one to do now with its key */
  private coachStrip!: HTMLDivElement;
  private coachSteps: HTMLSpanElement[] = [];
  private coachCue!: HTMLDivElement;
  private coachKeys!: HTMLSpanElement;
  private coachText!: HTMLSpanElement;
  private coachShown = '';
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
    const hex = (c: number) => `#${c.toString(16).padStart(6, '0')}`;
    this.root.style.setProperty('--us', hex(TEAM_COLORS.home.jersey));
    this.root.style.setProperty('--them', hex(TEAM_COLORS.away.jersey));
    // the score: a flag, the team's code and its points per side (or a drill's cells), what you play on a tab, the point's reason on a strap
    this.bug = el('div', 'bug', this.root);
    this.bug.dataset.kind = 'drill';
    this.band = el('div', 'bug-band', this.bug);
    const match = el('div', 'bug-match', this.band);
    [this.usTeam, this.usPts, this.usSlot] = this.team(match, 'us', 'You');
    el('i', 'bug-mid', match);
    [this.themTeam, this.themPts, this.themSlot] = this.team(match, 'them', 'Them');
    this.cells = el('div', 'bug-cells', this.band);
    this.ball = el('i', 'bug-ball still', this.band);
    this.ball.innerHTML = BALL;
    this.tab = el('div', 'bug-tab', this.bug);
    this.strap = el('div', 'bug-strap', this.bug);
    this.strap.innerHTML = JERSEY;
    this.strapWhat = el('b', 'bug-strap-what', this.strap);
    this.strapWho = el('span', 'bug-strap-who', this.strap);
    window.addEventListener('resize', () => (this.ballDirty = true));
    this.grade = el('div', 'hud-grade', this.root);
    this.gradeText = el('div', 'hud-grade-text', this.grade);
    this.gradeSub = el('div', 'hud-grade-sub', this.grade);
    this.banner = el('div', 'hud-banner', this.root);
    const bl = el('div', 'hud-bl empty', this.root);
    this.speedBox = bl;
    const sp = el('div', 'hud-speed', bl);
    this.speedVal = el('span', 'hud-speed-val', sp, '--');
    el('span', 'hud-speed-unit', sp, 'km/h');
    el('div', 'hud-speed-label', bl, 'last ball');
    this.streakBox = el('div', 'hud-streak', this.root);
    el('span', 'hud-streak-label', this.streakBox, 'STREAK');
    this.streakVal = el('span', 'hud-streak-val', this.streakBox, '0');
    this.foot = el('div', 'hud-foot', this.root);
    this.hint = el('div', 'hud-hint', this.foot);
    this.sheet = el('div', 'call-sheet', this.foot);
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
    this.chargeMark = el('div', 'charge-mark', this.root);
    this.collar = this.buildCollar();
    this.freezeVeil = el('div', 't-freeze', this.root);
    this.coachStrip = el('div', 'coach-strip', this.root);
    this.buildCoachSteps(CUE_ORDER);
    this.coachCue = el('div', 'coach-cue', this.foot);
    this.coachKeys = el('span', 'coach-keys', this.coachCue);
    this.coachText = el('span', 'coach-text', this.coachCue);
    this.goCue = el('div', 'go-cue', this.root, 'GO');
    this.callout = el('div', 'callout', this.root);
    const bubble = el('div', 'callout-bubble', this.callout);
    this.callWho = el('div', 'callout-who', bubble);
    this.callWord = el('div', 'callout-word', bubble);
    this.callSub = el('div', 'callout-sub', bubble);
    this.fadeEl = el('div', 'fade', parent);
  }

  /** Settings → Screen: the grades (with km/h) and the calls each on or off; the score always shows */
  setShown(grades: boolean, calls: boolean): void {
    this.root.classList.toggle('no-grades', !grades);
    this.root.classList.toggle('no-calls', !calls);
  }

  setVisible(v: boolean): void {
    this.root.style.display = v ? 'block' : 'none';
  }

  /** a team's half of the score: its flag (in its kit colour), its name on a plate, points and the slot the serve ball sits in */
  private team(parent: HTMLElement, side: 'us' | 'them', name: string): [HTMLElement, HTMLElement, HTMLElement] {
    const t = el('div', `bug-team ${side}`, parent);
    const slot = el('i', 'bug-slot', t);
    el('i', 'bug-kit', t);
    // (the name in its own box: the VNL look slants the letters, not the plate)
    el('b', 'bug-code', el('span', 'bug-name', t), name);
    const pts = el('b', 'bug-pts', t);
    return [t, pts, slot];
  }

  /** the look (Settings → Screen): the VNL bar or the Games bug */
  setLook(look: HudLook): void {
    if (document.body.dataset.hud === look) return;
    document.body.dataset.hud = look;
    this.ballDirty = true;
  }

  /** what you play: "Mini Rally · you are the Setter" (the first part is the drill, the rest what you are in it) */
  setTitle(t: string): void {
    const [head, ...rest] = t.split(' · ');
    this.tab.replaceChildren();
    el('b', '', this.tab, head);
    if (rest.length) el('span', '', this.tab, rest.join(' · '));
  }

  /** a drill's score line ("12 pts · rep 5"): one cell per part */
  setScore(t: string): void {
    this.bug.dataset.kind = 'drill';
    delete this.bug.dataset.serve;
    // the cells, read as one line (a screen reader, the verify helper)
    this.bug.setAttribute('aria-label', t);
    if (t === this.cellsText) return;
    this.cellsText = t;
    this.cells.replaceChildren();
    for (const c of statCells(t)) {
      const cell = el('span', c.num ? 'bug-cell' : 'bug-cell txt', this.cells);
      // every cell reads the same way: what it counts, the value, then any words after it ("PTS 288", "AVG 2.30 OF 4")
      const parts: ['b' | 'small', string, string][] = [
        ['small', 'bug-lab', c.label],
        ['b', '', c.value],
        ['small', 'bug-tail', c.tail],
      ];
      for (const [tag, cls, text] of parts) if (text) el(tag, cls, cell, text);
    }
  }

  /** a match's score (the Mini Rally): our points, theirs, and who serves. A new point rolls in; the serve ball flies over */
  setMatch(m: { us: number; them: number; serving: 1 | -1 }): void {
    const first = this.bug.dataset.kind !== 'match';
    this.bug.dataset.kind = 'match';
    this.setPts(this.usPts, m.us, first);
    this.setPts(this.themPts, m.them, first);
    const serve = m.serving === 1 ? 'us' : 'them';
    this.bug.setAttribute('aria-label', `YOU ${m.us} : ${m.them} THEM · ${serve === 'us' ? 'your' : 'their'} serve`);
    if (this.bug.dataset.serve === serve && !first) return;
    this.bug.dataset.serve = serve;
    if (first) this.ballDirty = true;
    else this.placeBall(true);
  }

  private setPts(cell: HTMLElement, n: number, quiet: boolean): void {
    const s = String(n);
    if (cell.textContent === s) return;
    cell.textContent = s;
    if (quiet) return;
    cell.classList.remove('tick');
    void cell.offsetWidth;
    cell.classList.add('tick');
  }

  /** the serve ball to the serving side's slot; `fly`: over the band, as a side-out */
  private placeBall(fly: boolean): void {
    const slot = this.bug.dataset.serve === 'them' ? this.themSlot : this.usSlot;
    const b = this.band.getBoundingClientRect();
    const s = slot.getBoundingClientRect();
    // hidden (a menu is up): place it on the first frame it shows
    this.ballDirty = !b.width;
    if (this.ballDirty) return;
    this.ball.classList.toggle('still', !fly);
    this.ball.style.transform = `translate(${(s.left - b.left).toFixed(1)}px, ${(s.top - b.top).toFixed(1)}px)`;
    if (!fly) return;
    this.ball.classList.remove('fly');
    void this.ball.offsetWidth;
    this.ball.classList.add('fly');
  }

  /** the point is over: who won it and why, on the strap under the score, and their points light */
  point(ours: boolean, reason: string): void {
    this.strapWhat.textContent = reason;
    this.strapWho.textContent = ours ? 'Point · you' : 'Point · them';
    this.strap.dataset.side = ours ? 'us' : 'them';
    this.usTeam.classList.toggle('scored', ours);
    this.themTeam.classList.toggle('scored', !ours);
    this.strap.classList.remove('show');
    void this.strap.offsetWidth;
    this.strap.classList.add('show');
    this.strapTimer = 2.4;
  }

  /** `force` keeps a tutorial coach line up even when Settings → Coaching is off */
  setHint(t: string, force = false): void {
    if (!this.showHints && !force) t = '';
    else if (this.keyLabels && t) t = dropSelfNamed(translateKeyMarkup(t, this.keyLabels), this.keyLabels);
    // each part of the line its own group, with a gap between them, not a dot
    t = t.replace(/ · /g, '<i class="hs"></i>');
    if (t !== this.lastHint) {
      this.lastHint = t;
      this.hint.innerHTML = t;
    }
  }

  /** keyboard skip chip + the camera-tag nudge. Touch hides this chip in CSS. */
  setTutorialChrome(on: boolean): void {
    this.root.classList.toggle('tutoring', on);
  }

  /** the ball is waiting for the player: the court cools a little, the HUD stays */
  setFrozen(on: boolean): void {
    if (this.root.classList.contains('frozen') === on) return;
    this.root.classList.toggle('frozen', on);
    document.body.classList.toggle('frozen', on);
    this.freezeVeil.setAttribute('aria-hidden', on ? 'false' : 'true');
  }

  /** the strip of what a rep is made of (RUN › JUMP › DRAW › HIT, a serve has TOSS first) */
  private coachOrder = '';
  private buildCoachSteps(order: readonly CueId[]): void {
    this.coachOrder = order.join();
    this.coachStrip.replaceChildren();
    this.coachSteps = [];
    order.forEach((id, i) => {
      if (i) el('span', 'coach-sep', this.coachStrip, '›');
      this.coachSteps.push(el('span', 'coach-step', this.coachStrip, CUE_NAMES[id]));
    });
  }

  /**
   * The lesson's cues. The strip names the parts of the rep, a spike's four or a serve's with the
   * toss first (the ones behind you ticked, the current one lit); the cue under the crosshair is the one thing to do now, with its key.
   * It pulses while the ball waits for it. Null hides both.
   */
  setCoach(c: { stage: number; cue: Cue | null; order?: readonly CueId[] } | null): void {
    this.coachStrip.classList.toggle('show', !!c);
    const cue = c?.cue ?? null;
    this.coachCue.classList.toggle('show', !!cue);
    this.coachCue.classList.toggle('waiting', !!cue?.waiting);
    if (!c) return;
    const order = c.order ?? CUE_ORDER;
    if (order.join() !== this.coachOrder) this.buildCoachSteps(order);
    this.coachSteps.forEach((e, i) => {
      e.classList.toggle('done', i < c.stage);
      e.classList.toggle('now', i === c.stage);
    });
    if (!cue) return;
    const key = cue.keys + '|' + cue.text;
    if (key === this.coachShown) return;
    this.coachShown = key;
    this.coachKeys.innerHTML = this.keyLabels ? translateKeyMarkup(cue.keys, this.keyLabels) : cue.keys;
    this.coachText.innerHTML = this.keyLabels ? translateKeyMarkup(cue.text, this.keyLabels) : cue.text;
  }

  /** the ball has waited a while on the same cue: the cue calls harder and Skip lights up */
  setNudge(on: boolean): void {
    this.coachCue.classList.toggle('nudge', on);
    this.skipBtn.classList.toggle('nudge', on);
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

  /**
   * The call strip when you set, laid out like the net (outside, middle, opposite; the pipe behind
   * the middle): each hitter's key, call and colour, with a dot per call they have (the one on
   * lit). The hitter your set goes to is lit: solid once you pressed their key, an outline while it
   * is the outside by default. Once the pass is played the calls are locked (the dots dim); a
   * hitter who can't be set this ball is struck out. Null hides it.
   */
  setCallSheet(v: CallSheetView | null): void {
    let html = '';
    if (v) {
      html = v.items
        .map((i) => {
          const cls = `cs-item cs-${i.id}${i.lit ? ' lit' : ''}${i.picked ? ' picked' : ''}${i.off ? ' off' : ''}`;
          const dots =
            i.steps > 1
              ? `<i>${Array.from({ length: i.steps }, (_, n) => `<em${n === i.step ? ' class="on"' : ''}></em>`).join('')}</i>`
              : '';
          return `<div class="${cls}" style="--c:${i.color}"><b>${i.key}</b>${i.who}${i.call ? `<span>${i.call}</span>` : ''}${dots}</div>`;
        })
        .join('');
      // the net the hitters run at, above them; the combination the calls make, named above it
      html = `<div class="cs-net"></div>${html}`;
      if (v.play) html = `<div class="cs-play">${escapeHtml(v.play)}</div>${html}`;
      this.sheet.classList.toggle('locked', v.locked);
      this.sheet.classList.toggle('pins', !v.items.some((i) => i.id === 'MB'));
    }
    if (html !== this.sheetHtml) {
      this.sheetHtml = html;
      this.sheet.innerHTML = html;
      this.sheet.style.display = html ? 'grid' : 'none';
    }
  }

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
    // a hitter's routes are chips on a phone, and the route panel is the ROUTES button
    [/\b1-\d call your route\b/g, 'the chips call your route'],
    [/\bC see them\b/g, 'ROUTES see them'],
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
    this.strapTimer = 0;
    this.grade.classList.remove('show');
    this.banner.classList.remove('show');
    this.strap.classList.remove('show');
  }

  /** show the grade to one side, off the line a served ball flies down (the Serve Drill) */
  gradeAside = false;

  /** `green`: a perfectly timed set reads GREEN, in green */
  showGrade(g: Grade, sub: string, green = false): void {
    this.gradeText.textContent = green ? 'GREEN' : g === 'Miss' ? 'MISS' : g.toUpperCase();
    // (kmh: the grade says the ball's speed, so the LAST BALL corner yields until it goes)
    this.grade.className =
      'hud-grade show ' + (green ? 'g-green' : GRADE_CLASS[g]) + (this.gradeAside ? ' aside' : '') + (/km\/h/.test(sub) ? ' kmh' : '');
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

  /** a title that stays until cleared (the lesson's `1 / 3 · TOGETHER` line) */
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

  /** a short note. `coach`: a coaching note, down when Settings → Coaching is off (false: what your own key just changed) */
  message(text: string, dur = 1.5, coach = true): void {
    if (this.msgPinned || (coach && !this.showHints)) return;
    if (this.keyLabels) text = Hud.translateText(text);
    this.msg.textContent = text;
    this.msg.classList.add('show');
    this.msgTimer = dur;
  }

  setSpeed(kmh: number | null): void {
    this.speedVal.textContent = kmh === null ? '--' : kmh.toFixed(0);
    this.speedBox.classList.toggle('empty', kmh === null);
  }

  /** the streak shows from two in a row */
  setStreak(n: number): void {
    this.streakVal.textContent = String(n);
    this.streakBox.classList.toggle('on', n >= 2);
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

  /**
   * The ring around the crosshair: the wind-up's charge, or how high a toss being held will go.
   * `mark`: a tick on the ring at that fraction (the serve's own toss height).
   */
  setCharge(frac: number | null, mark: number | null = null): void {
    if (frac === null) {
      this.chargeRing.style.opacity = '0';
      this.chargeRing.classList.remove('full');
      this.chargeMark.classList.remove('on');
      return;
    }
    this.chargeRing.style.opacity = '1';
    this.chargeRing.style.setProperty('--p', `${Math.round(frac * 100)}%`);
    this.chargeRing.classList.toggle('full', frac >= 0.999);
    this.chargeMark.classList.toggle('on', mark !== null);
    if (mark !== null) this.chargeMark.style.setProperty('--m', `${180 + mark * 360}deg`);
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
    if (this.ballDirty && this.bug.dataset.kind === 'match') this.placeBall(false);
    if (this.strapTimer > 0) {
      this.strapTimer -= dt;
      if (this.strapTimer <= 0) {
        this.strap.classList.remove('show');
        this.usTeam.classList.remove('scored');
        this.themTeam.classList.remove('scored');
      }
    }
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

/** text for innerHTML: a play's name is typed by the player (the designer), so it must not be markup */
function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
}
