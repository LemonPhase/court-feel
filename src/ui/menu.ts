import {
  BODY,
  isPositionId,
  POSITIONS,
  SETTING_RANGES,
  type BodyOverride,
  type BooleanSettingKey,
  type NumericSettingKey,
  type PositionId,
  type Settings,
} from '../config';
import { BUILD_LABEL } from '../core/build';
import { defaultSettings, systemPrefersReducedMotion } from '../core/settings';
import { isCustomBody, resolveBody, setBodyValue, spikeReach, topSpikeKmh } from '../game/body';
import { isModeId, MODE_INFO, type ModeId } from '../game/modes/mode';
import { athleteStats } from './athleteStats';
import { ALL_CONTROLS, COMING_FORMATS, DRILL_INFO, PLAY_MODES, SETTER_CALLS, TRAIN_MODES, type KeyHint } from './drillInfo';
import { ICONS, type IconName } from './icons';

/** the start screen's sections */
type View = 'home' | 'train' | 'play' | 'learn';
/** the full-screen sheets that open over the start screen or the pause menu */
type SheetId = 'settings' | 'athlete';

const NAV: readonly { id: View; label: string }[] = [
  { id: 'home', label: 'Home' },
  { id: 'train', label: 'Train' },
  { id: 'play', label: 'Play' },
  { id: 'learn', label: 'Learn' },
];

const POSITION_IDS = Object.keys(POSITIONS) as PositionId[];

/** where each position starts on its own half, for the card's small court (net at the top, 46 x 46 box) */
const COURT_SPOT: Record<PositionId, { x: number; y: number }> = {
  OH: { x: 11, y: 12 },
  MB: { x: 23, y: 11 },
  OPP: { x: 36, y: 12 },
  S: { x: 29, y: 10 },
  L: { x: 12, y: 33 },
};

function h<K extends keyof HTMLElementTagNameMap>(tag: K, cls = '', html = ''): HTMLElementTagNameMap[K] {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (html) e.innerHTML = html;
  return e;
}

/** a button that never submits and has plain text */
function btn(cls: string, text = ''): HTMLButtonElement {
  const b = h('button', cls);
  b.type = 'button';
  if (text) b.textContent = text;
  return b;
}

function txt<K extends keyof HTMLElementTagNameMap>(tag: K, cls: string, text: string): HTMLElementTagNameMap[K] {
  const e = h(tag, cls);
  e.textContent = text;
  return e;
}

const INCH = 0.0254;
/** 1.95 -> 6′5″ */
const feetInches = (m: number) => {
  const i = Math.round(m / INCH);
  return `${Math.floor(i / 12)}′${i % 12}″`;
};
const BODY_FMT: Record<keyof BodyOverride, (v: number) => string> = {
  height: (v) => `${v.toFixed(2)} m · ${feetInches(v)}`,
  jump: (v) => `${Math.round(v * 100)} cm · ${Math.round(v / INCH)}″`,
  power: (v) => `${Math.round(topSpikeKmh(v))} km/h`,
};
const percent = (v: number) => (v === 0 ? 'Off' : `${Math.round(v * 100)}%`);
const netLabel = (women: boolean) => (women ? "Women's net 2.24 m" : "Men's net 2.43 m");

/** a selectable row, card or chip: the highlight and, for assistive tech, the pressed state */
function setOn(e: HTMLElement, on: boolean): void {
  e.classList.toggle('on', on);
  e.setAttribute('aria-pressed', String(on));
}

/** the build label ("v0.1.0 · abc1234"): players can name it in a bug report */
function buildTag(): HTMLElement {
  return txt('div', 'build', BUILD_LABEL);
}

/** key caps with what each does */
function keyList(keys: readonly KeyHint[], cls = ''): HTMLElement {
  const list = h('div', `keys ${cls}`.trim());
  for (const k of keys) {
    const row = h('div', 'key-row');
    row.append(txt('span', 'key-cap', k.k), txt('span', 'key-a', k.a));
    list.append(row);
  }
  return list;
}

/** a mode's keys for the keyboard and for touch: CSS shows the one for the controls in use */
function drillKeys(mode: ModeId): HTMLElement[] {
  return [keyList(DRILL_INFO[mode].keys, 'only-kb'), keyList(DRILL_INFO[mode].touch, 'only-tc')];
}

function courtGlyph(id: PositionId, on: boolean): string {
  const s = COURT_SPOT[id];
  return `<svg class="pos-court" aria-hidden="true" viewBox="0 0 46 46" fill="none">
    <rect x="3" y="5" width="40" height="38" rx="2" stroke="rgba(255,255,255,0.45)" stroke-width="1.5"/>
    <line x1="1" y1="5" x2="45" y2="5" stroke="#f2f2f2" stroke-width="2.5" stroke-linecap="round"/>
    <line x1="3" y1="18" x2="43" y2="18" stroke="rgba(255,255,255,0.3)" stroke-dasharray="3 3"/>
    <circle cx="${s.x}" cy="${s.y}" r="5" fill="${on ? '#ffd23f' : '#4fd1ff'}"/></svg>`;
}

export interface MenuCallbacks {
  play(mode: ModeId, pos: PositionId): void;
  /** the welcome's main button: start the lesson, or carry on from where it was left */
  playTutorial(): void;
  /** Learn's lesson button once the lesson is done or skipped: the lesson from the top */
  replayTutorial(): void;
  skipTutorial(): void;
  /** what Home offers this visitor: the lesson, the rest of it, or nothing (it is done or skipped) */
  tutorialOffer(): 'new' | 'resume' | null;
  /** the visitor chose the drills over the lesson: don't offer it again */
  declineTutorial(): void;
  tutorialActive(): boolean;
  /** the mode and position being played (for the pause menu), or null on the start screen */
  playing(): { mode: ModeId; pos: PositionId } | null;
  resume(): void;
  restart(): void;
  quit(): void;
  settingsChanged(): void;
}

/**
 * The start screen (Home, Train, Play, Learn), the pause menu, and the Settings and Athlete sheets.
 *
 * Home is one press back into the last drill (or the lesson, on a first visit). Train lists the
 * drills, Play the games, Learn the lesson and every control. A drill shows only its own keys,
 * before it starts and again on pause.
 */
export class Menu {
  readonly start: HTMLDivElement;
  readonly pause: HTMLDivElement;
  private sheet: HTMLDivElement;
  /** the mode PLAY and Continue start: the last one picked or played */
  mode: ModeId = 'spike';
  pos: PositionId = 'OH';
  private view: View = 'home';
  /** the drill selected under Train */
  private trainSel: ModeId = 'spike';
  /** a drill has been started from this browser before: Home says "pick up where you left off" */
  private played = false;
  /** Learn's controls list: keyboard or touch (null: whichever is in use) */
  private learnDevice: 'kb' | 'touch' | null = null;
  /** every part of the screens that shows the mode, position or a setting redraws itself from here */
  private syncs: (() => void)[] = [];
  private views = new Map<View, HTMLElement>();
  private navBtns = new Map<View, HTMLButtonElement>();
  /** each section's main button: Enter presses it, and it takes the focus when asked */
  private mainBtns = new Map<View, HTMLButtonElement>();

  private welcome!: HTMLElement;
  private welcomeTitle!: HTMLElement;
  private welcomeGo!: HTMLButtonElement;
  private homeBack!: HTMLElement;
  private continueBtn!: HTMLButtonElement;
  private lessonGo!: HTMLButtonElement;

  private settingsOpen = false;
  /** the button that opened the sheet: focus returns there when it closes */
  private settingsOpener: HTMLElement | null = null;

  private resumeBtn!: HTMLButtonElement;
  private quitBtn!: HTMLElement;
  private skipTutorialBtn!: HTMLButtonElement;
  private pauseTitle!: HTMLElement;
  private pauseSub!: HTMLElement;
  private pauseBody!: HTMLElement;
  private pauseNote!: HTMLElement;
  private pauseSide!: HTMLElement;
  /** the pause menu's buttons that the end of the lesson leaves out */
  private pauseOnly: HTMLElement[] = [];
  /** the pause dialog is showing the end of the lesson (null: it is the pause menu) */
  private finished: 'clean' | 'done' | null = null;

  constructor(
    parent: HTMLElement,
    private settings: Settings,
    private cb: MenuCallbacks,
  ) {
    try {
      const saved = JSON.parse(localStorage.getItem('courtfeel.menu') || '{}');
      if (isModeId(saved?.mode)) this.mode = saved.mode;
      if (isPositionId(saved?.pos)) this.pos = saved.pos;
      // saves from before the flag existed were only ever written by PLAY
      this.played = typeof saved?.played === 'boolean' ? saved.played : isModeId(saved?.mode);
    } catch {
      /* ignore */
    }
    if (TRAIN_MODES.includes(this.mode)) this.trainSel = this.mode;

    // ------------------------------------------------------------ start screen
    this.start = h('div', 'menu');
    this.start.append(this.buildTopbar());
    const add = (id: View, el: HTMLElement) => {
      this.views.set(id, el);
      this.start.append(el);
    };
    add('home', this.buildHome());
    add('train', this.buildTrain());
    add('play', this.buildPlay());
    add('learn', this.buildLearn());
    parent.append(this.start);

    // ------------------------------------------------------------ pause
    this.pause = this.buildPause();
    parent.append(this.pause);

    // ------------------------------------------------------------ settings / athlete
    this.sheet = h('div', 'sheet');
    this.sheet.setAttribute('role', 'dialog');
    this.sheet.setAttribute('aria-modal', 'true');
    this.sheet.style.display = 'none';
    parent.append(this.sheet);

    this.setView('home');
    this.sync();
    this.showStart(true);
    this.showPause(false);
    window.addEventListener('keydown', (e) => {
      if (this.start.style.display !== 'none' && !this.settingsOpen && e.key === 'Enter') {
        // Enter presses the section's main button from anywhere on it, including a focused row, card or
        // chip (Space or a click selects those). Other focused controls handle Enter themselves.
        const control = (e.target as HTMLElement | null)?.closest?.('button, input, textarea, select, a');
        if (control && !control.matches('.row, .pos-chip')) return;
        const main = this.mainBtns.get(this.view);
        if (!main || main.offsetParent === null) return;
        e.preventDefault();
        main.click();
      }
      if (e.key === 'Escape' && this.settingsOpen) {
        // Esc closes the sheet only (main's Esc handler would also leave the pause menu)
        this.closeSettings();
        e.stopImmediatePropagation();
      }
    });
  }

  // ---------------------------------------------------------------- shared parts

  /** redraw everything that shows the mode, the position or a setting */
  private sync(): void {
    for (const f of this.syncs) f();
  }

  private setView(v: View): void {
    this.view = v;
    this.start.dataset.view = v;
    for (const [id, el] of this.views) el.classList.toggle('on', id === v);
    for (const [id, b] of this.navBtns) {
      b.classList.toggle('on', id === v);
      if (id === v) b.setAttribute('aria-current', 'page');
      else b.removeAttribute('aria-current');
    }
    this.views.get(v)?.scrollTo?.(0, 0);
  }

  private buildTopbar(): HTMLElement {
    const bar = h('div', 'topbar');
    const brand = h('button', 'brand', 'COURT<b>FEEL</b>');
    brand.type = 'button';
    brand.setAttribute('aria-label', 'Court Feel: home');
    brand.onclick = () => this.setView('home');
    const nav = h('nav', 'nav');
    nav.setAttribute('aria-label', 'Sections');
    for (const { id, label } of NAV) {
      const b = h('button', 'nav-btn', `${ICONS[id]}<span>${label}</span>`);
      b.type = 'button';
      b.setAttribute('aria-label', label);
      b.onclick = () => this.setView(id);
      this.navBtns.set(id, b);
      nav.append(b);
    }
    const right = h('div', 'top-right');
    const athlete = btn('pill');
    athlete.onclick = () => this.openSheet('athlete', athlete);
    this.syncs.push(() => {
      const p = POSITIONS[this.pos];
      athlete.innerHTML = `<b>${p.short}</b><span>${p.name}</span>`;
      athlete.setAttribute('aria-label', `Athlete: ${p.name}`);
    });
    const set = h('button', 'pill', `${ICONS.settings}<span>Settings</span>`);
    set.type = 'button';
    set.setAttribute('aria-label', 'Settings');
    set.onclick = () => this.openSettings(set);
    right.append(athlete, set);
    bar.append(brand, nav, right);
    return bar;
  }

  /** the gold button that starts play, with the key that presses it */
  private playButton(label: string, go: () => void): HTMLButtonElement {
    const b = h('button', 'play-btn', `${label}<kbd class="only-kb">ENTER</kbd>`);
    b.type = 'button';
    b.onclick = go;
    return b;
  }

  /** "Play as": the five positions as chips, and a line about the one chosen */
  private posPicker(): HTMLElement {
    const wrap = h('div', 'block');
    const head = h('div', 'block-head');
    const edit = btn('link', 'Edit athlete');
    edit.onclick = () => this.openSheet('athlete', edit);
    head.append(txt('div', 'eyebrow', 'Play as'), edit);
    const chips = h('div', 'pos-chips');
    chips.setAttribute('role', 'group');
    chips.setAttribute('aria-label', 'Position');
    const buttons = new Map<PositionId, HTMLButtonElement>();
    for (const id of POSITION_IDS) {
      const b = btn('pos-chip', POSITIONS[id].short);
      b.setAttribute('aria-label', POSITIONS[id].name);
      b.onclick = () => this.selectPos(id);
      buttons.set(id, b);
      chips.append(b);
    }
    const note = h('div', 'block-note');
    this.syncs.push(() => {
      for (const [id, b] of buttons) setOn(b, id === this.pos);
      const p = POSITIONS[this.pos];
      const body = resolveBody(this.pos, this.settings.bodies[this.pos]);
      note.replaceChildren(txt('b', '', p.name), ` · ${body.height.toFixed(2)} m · ${p.blurb}`);
    });
    wrap.append(head, chips, note);
    return wrap;
  }

  /**
   * Two or three chips that set one thing; `at` reads which is on. `keep`: the group lives as long
   * as the menu and follows changes made elsewhere (a group in a sheet or the pause menu is rebuilt
   * each time it opens, so it must not be kept).
   */
  private chipGroup(label: string, options: readonly string[], at: () => number, pick: (i: number) => void, keep = true): HTMLElement {
    const group = h('div', 'chips');
    group.setAttribute('role', 'group');
    group.setAttribute('aria-label', label);
    const buttons = options.map((o, i) => {
      const b = btn('chip', o);
      b.onclick = () => {
        pick(i);
        draw();
        this.sync();
      };
      group.append(b);
      return b;
    });
    const draw = () => buttons.forEach((b, i) => setOn(b, i === at()));
    draw();
    if (keep) this.syncs.push(draw);
    return group;
  }

  private viewPicker(keep = true): HTMLElement {
    return this.chipGroup(
      'View',
      ['Third person', 'First person'],
      () => (this.settings.firstPerson ? 1 : 0),
      (i) => {
        this.settings.firstPerson = i === 1;
        this.cb.settingsChanged();
      },
      keep,
    );
  }

  // ---------------------------------------------------------------- home

  private buildHome(): HTMLElement {
    const view = h('section', 'view view-home');
    const col = h('div', 'home-col');
    col.append(h('div', 'logo', '<span>COURT</span><b>FEEL</b>'), txt('div', 'tagline', 'Approach. Plant. Explode. Feel every contact.'));

    // the first visit: the lesson offered on its own, with one way past it
    const w = h('div', 'welcome');
    w.setAttribute('role', 'group');
    w.setAttribute('aria-label', 'Welcome');
    this.welcomeTitle = h('div', 'eyebrow cyan');
    const steps = h('ol', 'steps');
    for (const s of ['Run', 'Jump', 'Draw', 'Hit']) steps.append(txt('li', 'step', s));
    this.welcomeGo = btn('play-btn');
    this.welcomeGo.onclick = () => this.cb.playTutorial();
    const skip = btn('ghost-btn', 'Skip to the drills');
    skip.onclick = () => {
      this.cb.declineTutorial();
      this.syncTutorial();
      this.setView('train');
      this.mainBtns.get('train')?.focus({ preventScroll: true });
    };
    const row = h('div', 'welcome-row');
    row.append(this.welcomeGo, skip);
    w.append(
      this.welcomeTitle,
      txt('div', 'welcome-t', 'Learn the spike in three balls'),
      txt('div', 'welcome-b', 'About a minute. We hit the first one together: the ball waits for you.'),
      steps,
      row,
      h('div', 'welcome-n', 'You can take it again any time, under <b>Learn</b>.'),
    );
    w.style.display = 'none';
    this.welcome = w;

    // every visit after: one press back into the last drill, and the three sections
    const back = h('div', 'home-back');
    const cont = h('div', 'continue');
    const text = h('div', 'continue-text');
    const eyebrow = h('div', 'eyebrow');
    const title = h('div', 'continue-t');
    const sub = h('div', 'continue-s');
    text.append(eyebrow, title, sub);
    const go = this.playButton('CONTINUE', () => this.go(this.mode));
    this.continueBtn = go;
    cont.append(text, go);
    this.syncs.push(() => {
      eyebrow.textContent = this.played ? 'Pick up where you left off' : 'A good place to start';
      go.firstChild!.textContent = this.played ? 'CONTINUE' : 'PLAY';
      title.textContent = MODE_INFO[this.mode].title;
      sub.textContent = `${POSITIONS[this.pos].name} · ${this.settings.firstPerson ? 'first' : 'third'} person · ${netLabel(this.settings.womenNet).toLowerCase()}`;
    });
    const doors = h('div', 'doors');
    const door = (id: View, icon: IconName, strap: string, body: string, foot: string) => {
      const d = btn('door');
      d.innerHTML = ICONS[icon];
      d.append(
        txt('span', 'door-t', NAV.find((n) => n.id === id)!.label),
        txt('span', 'door-s', strap),
        txt('span', 'door-b', body),
        txt('span', 'door-f', foot),
      );
      d.onclick = () => this.setView(id);
      doors.append(d);
    };
    door(
      'train',
      'train',
      'One skill at a time',
      'Spike, block, pass or set, rep after rep. Or open the gym and let the ball machine feed you.',
      `${TRAIN_MODES.length} drills`,
    );
    door(
      'play',
      'play',
      'Six a side',
      'Win the point in your position. Open rallies today; sets and full matches are on the way.',
      PLAY_MODES.map((m) => MODE_INFO[m].title).join(' · '),
    );
    door(
      'learn',
      'learn',
      'The lesson and the controls',
      'The spike, taught in three balls, and every key and touch control in one place.',
      'Tutorial',
    );
    back.append(cont, doors);
    this.homeBack = back;

    col.append(w, back, buildTag());
    view.append(col);
    return view;
  }

  // ---------------------------------------------------------------- train

  private buildTrain(): HTMLElement {
    const view = h('section', 'view view-split');
    const list = h('div', 'list-col');
    list.append(txt('h1', 'view-t', 'Train'), txt('p', 'view-s', 'One skill, rep after rep. Pick a drill.'));
    const rows = h('div', 'rows');
    rows.setAttribute('role', 'group');
    rows.setAttribute('aria-label', 'Drill');
    const buttons = new Map<ModeId, HTMLButtonElement>();
    for (const id of TRAIN_MODES) {
      const b = btn('row');
      const main = h('span', 'row-main');
      main.append(txt('span', 'row-t', MODE_INFO[id].title), txt('span', 'row-s', DRILL_INFO[id].short));
      b.append(main, txt('span', 'tag', DRILL_INFO[id].tag));
      b.onclick = () => this.selectMode(id);
      b.ondblclick = () => this.go(id);
      buttons.set(id, b);
      rows.append(b);
    }
    list.append(rows);

    const panel = h('div', 'panel');
    const title = h('h2', 'panel-t');
    const about = h('p', 'panel-b');
    const scored = h('p', 'panel-n');
    const mid = h('div', 'panel-mid');
    const keys = h('div', 'block block-keys');
    const keyBox = h('div', 'key-box');
    const all = btn('link', 'All controls');
    all.onclick = () => this.setView('learn');
    keys.append(txt('div', 'eyebrow', 'Keys for this drill'), keyBox, all);
    const setup = h('div', 'panel-setup');
    setup.append(this.posPicker());
    mid.append(keys, setup);
    const foot = h('div', 'panel-foot');
    const summary = btn('link summary');
    summary.onclick = () => this.openSettings(summary);
    const go = this.playButton('PLAY', () => this.go(this.trainSel));
    this.mainBtns.set('train', go);
    foot.append(this.viewPicker(), summary, go);
    panel.append(title, about, scored, mid, foot);
    this.syncs.push(() => {
      for (const [id, b] of buttons) setOn(b, id === this.trainSel);
      const d = DRILL_INFO[this.trainSel];
      title.textContent = MODE_INFO[this.trainSel].title;
      about.textContent = d.about;
      scored.replaceChildren(txt('b', '', 'Scored on'), ` · ${d.scored}`);
      keyBox.replaceChildren(...drillKeys(this.trainSel));
      summary.replaceChildren(
        `${netLabel(this.settings.womenNet)} · Aim assist ${percent(this.settings.aimAssist).toLowerCase()} · `,
        txt('b', '', 'Change'),
      );
    });
    view.append(list, panel);
    return view;
  }

  // ---------------------------------------------------------------- play

  private buildPlay(): HTMLElement {
    const mode = PLAY_MODES[0];
    const info = DRILL_INFO[mode];
    const view = h('section', 'view view-split');
    const list = h('div', 'list-col');
    list.append(txt('h1', 'view-t', 'Play'), txt('p', 'view-s', 'Six a side, you in your position.'));
    const rows = h('div', 'rows');
    rows.setAttribute('role', 'group');
    rows.setAttribute('aria-label', 'Game');
    const row = (title: string, short: string, tag: string, ready: boolean) => {
      const b = btn(`row${ready ? ' on' : ''}`);
      const main = h('span', 'row-main');
      main.append(txt('span', 'row-t', title), txt('span', 'row-s', short));
      b.append(main, txt('span', `tag ${ready ? 'ready' : 'soon'}`, tag));
      if (ready) b.setAttribute('aria-pressed', 'true');
      else b.disabled = true;
      rows.append(b);
      return b;
    };
    row(MODE_INFO[mode].title, info.short, 'Ready', true).ondblclick = () => this.go(mode);
    for (const f of COMING_FORMATS) row(f.title, f.short, 'Soon', false);
    list.append(rows);

    const panel = h('div', 'panel');
    const scored = h('p', 'panel-n');
    scored.append(txt('b', '', 'Ends'), ` · ${info.scored}`);
    const mid = h('div', 'panel-mid');
    const calls = h('div', 'block block-keys');
    const callList = h('div', 'calls');
    for (const c of SETTER_CALLS) {
      const r = h('div', 'call');
      r.append(txt('b', c.out ? 'out' : '', c.word), txt('span', '', c.means));
      callList.append(r);
    }
    const all = btn('link', 'All controls');
    all.onclick = () => this.setView('learn');
    calls.append(
      txt('div', 'eyebrow', 'Listen for your setter'),
      callList,
      txt(
        'div',
        'block-note',
        'The keys are the ones from the drills. The hint at the bottom of the screen names the key when the ball is yours.',
      ),
      all,
    );
    const setup = h('div', 'panel-setup');
    const net = h('div', 'block');
    net.append(
      txt('div', 'eyebrow', 'Net'),
      this.chipGroup(
        'Net height',
        ["Men's 2.43 m", "Women's 2.24 m"],
        () => (this.settings.womenNet ? 1 : 0),
        (i) => {
          this.settings.womenNet = i === 1;
          this.cb.settingsChanged();
        },
      ),
    );
    setup.append(this.posPicker(), net);
    mid.append(calls, setup);
    const foot = h('div', 'panel-foot');
    const go = this.playButton('PLAY', () => this.go(mode));
    this.mainBtns.set('play', go);
    foot.append(this.viewPicker(), h('span', 'foot-gap'), go);
    panel.append(txt('h2', 'panel-t', MODE_INFO[mode].title), txt('p', 'panel-b', info.about), scored, mid, foot);
    view.append(list, panel);
    return view;
  }

  // ---------------------------------------------------------------- learn

  private buildLearn(): HTMLElement {
    const view = h('section', 'view view-split');
    const list = h('div', 'list-col');
    list.append(txt('h1', 'view-t', 'Learn'), txt('p', 'view-s', 'A lesson that waits for you, and every control.'));
    const lesson = h('div', 'lesson');
    const steps = h('ol', 'steps');
    for (const s of ['Run', 'Jump', 'Draw', 'Hit']) steps.append(txt('li', 'step', s));
    this.lessonGo = btn('play-btn');
    this.lessonGo.onclick = () => (this.cb.tutorialOffer() ? this.cb.playTutorial() : this.cb.replayTutorial());
    lesson.append(
      txt('div', 'eyebrow', 'Tutorial'),
      txt('div', 'lesson-t', 'The spike, in three balls'),
      txt(
        'div',
        'lesson-b',
        'One outside spike, about a minute. The first ball waits for you at each moment, the second is in slow motion, the third is the drill as it is played.',
      ),
      steps,
      this.lessonGo,
    );
    list.append(lesson, txt('p', 'view-s', 'More lessons will be added here.'));

    const panel = h('div', 'panel');
    const head = h('div', 'block-head');
    const groups = h('div', 'key-groups');
    const draw = () => {
      const dev = this.learnDevice ?? (document.body.classList.contains('touchmode') ? 'touch' : 'kb');
      groups.replaceChildren(
        ...ALL_CONTROLS[dev].map((g) => {
          const box = h('div', 'block');
          box.append(txt('div', 'eyebrow', g.title), keyList(g.rows));
          return box;
        }),
      );
      return dev;
    };
    head.append(
      txt('h2', 'panel-t', 'Controls'),
      this.chipGroup(
        'Controls for',
        ['Keyboard and mouse', 'Touch'],
        () => (draw() === 'touch' ? 1 : 0),
        (i) => (this.learnDevice = i === 1 ? 'touch' : 'kb'),
      ),
    );
    const note = h('p', 'panel-n');
    const sens = btn('link', 'Sensitivity and touch settings');
    sens.onclick = () => this.openSettings(sens);
    note.append('Each drill shows only its own keys before you start, and again when you pause. ', sens);
    panel.append(head, groups, note);
    view.append(list, panel);
    return view;
  }

  // ---------------------------------------------------------------- pause

  private buildPause(): HTMLDivElement {
    const pause = h('div', 'pause');
    pause.setAttribute('role', 'dialog');
    pause.setAttribute('aria-label', 'Paused');
    const box = h('div', 'pause-box');
    const main = h('div', 'pause-main');
    this.pauseTitle = txt('div', 'pause-t', 'Paused');
    this.pauseSub = h('div', 'pause-s');
    this.pauseBody = h('div', 'pause-b');
    this.pauseNote = h('div', 'pause-n', 'The <b>Spike Drill</b> is under Train, and the <b>tutorial</b> under Learn.');
    this.resumeBtn = h('button', 'play-btn');
    this.resumeBtn.type = 'button';
    this.resumeBtn.onclick = () => this.cb.resume();
    const restart = btn('ghost-btn', 'Restart drill');
    restart.onclick = () => this.cb.restart();
    this.quitBtn = btn('ghost-btn quiet', 'Quit to menu');
    this.quitBtn.onclick = () => this.cb.quit();
    const sett = btn('ghost-btn', 'Settings');
    sett.onclick = () => this.openSettings(sett);
    this.pauseOnly = [sett, restart];
    this.skipTutorialBtn = btn('ghost-btn', 'Skip tutorial');
    this.skipTutorialBtn.style.display = 'none';
    this.skipTutorialBtn.onclick = () => this.cb.skipTutorial();
    main.append(
      this.pauseTitle,
      this.pauseSub,
      this.pauseBody,
      this.resumeBtn,
      restart,
      sett,
      this.skipTutorialBtn,
      this.quitBtn,
      this.pauseNote,
      buildTag(),
    );
    this.pauseSide = h('div', 'pause-side');
    box.append(main, this.pauseSide);
    pause.append(box);
    return pause;
  }

  /** the pause menu's right side: the keys of the drill being played, and the settings changed most mid-game */
  private drawPauseSide(): void {
    const playing = this.cb.playing();
    const side = this.pauseSide;
    side.replaceChildren();
    if (playing) {
      const keys = h('div', 'block');
      keys.append(txt('div', 'eyebrow', 'Keys for this drill'), ...drillKeys(playing.mode));
      side.append(keys);
    }
    const quick = h('div', 'block quick');
    quick.append(txt('div', 'eyebrow', 'Quick settings'));
    const view = h('div', 'set-row choice');
    view.append(txt('span', 'set-l', 'View'), this.viewPicker(false));
    quick.append(
      view,
      this.sliderRow('Mouse sensitivity', 'sensitivity', (v) => v.toFixed(2), 'only-kb'),
    );
    quick.append(this.sliderRow('Touch aim sensitivity', 'touchSensitivity', (v) => v.toFixed(2), 'only-tc'));
    quick.append(this.sliderRow('Volume', 'volume', percent));
    side.append(quick);
  }

  // ---------------------------------------------------------------- actions

  private go(mode: ModeId): void {
    this.mode = mode;
    this.played = true;
    this.save();
    this.cb.play(this.mode, this.pos);
  }

  /** remember the last drill and position for the next visit */
  private save(): void {
    try {
      localStorage.setItem('courtfeel.menu', JSON.stringify({ mode: this.mode, pos: this.pos, played: this.played }));
    } catch {
      /* ignore */
    }
  }

  selectPos(id: PositionId): void {
    this.pos = id;
    this.sync();
  }

  selectMode(id: ModeId): void {
    this.mode = id;
    if (TRAIN_MODES.includes(id)) this.trainSel = id;
    this.sync();
  }

  showStart(v: boolean): void {
    this.start.style.display = v ? 'flex' : 'none';
    if (!v) return;
    this.syncTutorial();
    this.sync();
    // the lesson is offered on Home, and its main button takes the keyboard when it comes up
    if (this.welcomeVisible) {
      this.setView('home');
      this.welcomeGo.focus({ preventScroll: true });
    }
  }

  private get welcomeVisible(): boolean {
    return this.welcome.style.display !== 'none';
  }

  showPause(v: boolean): void {
    const was = this.pauseVisible;
    this.pause.style.display = v ? 'flex' : 'none';
    if (!v) {
      this.closeSettings();
      this.finished = null;
    } else {
      this.drawPauseSide();
      if (!was) this.resumeBtn.focus();
      this.syncTutorial();
    }
    this.syncPause();
  }

  /**
   * The lesson's three balls are done. The same dialog as the pause menu (so Esc, the pointer
   * and touch behave as they do there), saying so and offering what to do next: carry on in
   * the Spike Drill you are standing in, or go and choose another drill. `clean`: the last
   * ball was a Perfect or a Good.
   */
  showFinished(clean: boolean): void {
    this.finished = clean ? 'clean' : 'done';
    // "Choose another drill" lands on the drills
    this.setView('train');
    this.showPause(true);
  }

  private syncPause(): void {
    const f = this.finished;
    const playing = this.cb.playing();
    this.pause.setAttribute('aria-label', f ? 'Tutorial complete' : 'Paused');
    this.pauseTitle.textContent = f ? "You're on the court." : 'Paused';
    this.pauseSub.textContent = playing ? `${MODE_INFO[playing.mode].title} · ${POSITIONS[playing.pos].name}` : '';
    this.pauseSub.style.display = playing && !f ? '' : 'none';
    this.pauseBody.textContent = !f
      ? ''
      : f === 'clean'
        ? 'That is the spike: run, jump, draw, hit. The tutorial is done.'
        : 'That is the tutorial. The timing comes with reps.';
    this.pauseBody.style.display = f ? '' : 'none';
    this.pauseNote.style.display = f ? '' : 'none';
    this.resumeBtn.innerHTML = f ? 'KEEP HITTING' : 'RESUME<kbd class="only-kb">ESC</kbd>';
    this.quitBtn.textContent = f ? 'Choose another drill' : 'Quit to menu';
    for (const b of this.pauseOnly) b.style.display = f ? 'none' : '';
  }

  /** Home's welcome or its Continue, Learn's lesson button and the pause-menu skip, from the stored flag and the live session */
  syncTutorial(): void {
    const offer = this.cb.tutorialOffer();
    this.welcome.style.display = offer ? '' : 'none';
    this.homeBack.style.display = offer ? 'none' : '';
    if (offer) {
      this.welcomeTitle.textContent = offer === 'resume' ? 'Welcome back' : 'First time here?';
      this.welcomeGo.textContent = offer === 'resume' ? 'CONTINUE THE TUTORIAL' : 'START THE TUTORIAL';
    }
    // Enter on Home takes the lesson while it is offered
    this.mainBtns.set('home', offer ? this.welcomeGo : this.continueBtn);
    this.lessonGo.textContent = offer === 'resume' ? 'CONTINUE' : offer ? 'START' : 'TAKE IT AGAIN';
    this.skipTutorialBtn.style.display = this.cb.tutorialActive() ? '' : 'none';
  }

  get pauseVisible(): boolean {
    return this.pause.style.display !== 'none';
  }

  /** a sheet (Settings or Athlete) is open over the start screen or the pause menu */
  get settingsVisible(): boolean {
    return this.settingsOpen;
  }

  // ---------------------------------------------------------------- sheets

  openSettings(opener?: HTMLElement): void {
    this.openSheet('settings', opener);
  }

  private openSheet(id: SheetId, opener?: HTMLElement): void {
    // switching between the two sheets keeps the button that opened the first
    if (!this.settingsOpen) this.settingsOpener = opener ?? null;
    this.sheet.dataset.sheet = id;
    this.sheet.setAttribute('aria-label', id === 'settings' ? 'Settings' : 'Athlete');
    this.sheet.replaceChildren(id === 'settings' ? this.buildSettings() : this.buildAthlete());
    this.sheet.style.display = 'flex';
    this.settingsOpen = true;
    this.sheet.querySelector<HTMLElement>('.sheet-body input, .sheet-body button')?.focus({ preventScroll: true });
  }

  closeSettings(): void {
    if (!this.settingsOpen) return;
    this.sheet.style.display = 'none';
    this.sheet.replaceChildren();
    this.settingsOpen = false;
    // the screens underneath show the position and some settings
    if (this.pauseVisible) this.drawPauseSide();
    else this.sync();
    // back to the button that opened it, if it is still on screen
    const o = this.settingsOpener;
    this.settingsOpener = null;
    if (o?.isConnected && o.offsetParent !== null) o.focus();
  }

  /** a sheet's top row: its name, the way to the other sheet, and DONE */
  private sheetHead(title: string, other: SheetId): HTMLElement {
    const head = h('div', 'sheet-head');
    const swap = btn('ghost-btn', other === 'athlete' ? 'Athlete' : 'Settings');
    swap.onclick = () => this.openSheet(other);
    const done = btn('play-btn', 'DONE');
    done.onclick = () => this.closeSettings();
    head.append(txt('h1', 'view-t', title), h('span', 'foot-gap'), swap, done);
    return head;
  }

  /** a labelled slider for one numeric setting: it applies as it moves */
  private sliderRow(label: string, key: NumericSettingKey, fmt: (v: number) => string, cls = '', help = ''): HTMLElement {
    const s = this.settings;
    const { min, max, step } = SETTING_RANGES[key];
    const row = h('label', `set-row ${cls}`.trim());
    const val = txt('span', 'set-val', fmt(s[key]));
    const inp = h('input');
    inp.type = 'range';
    inp.min = String(min);
    inp.max = String(max);
    inp.step = String(step);
    inp.value = String(s[key]);
    inp.oninput = () => {
      const v = parseFloat(inp.value);
      if (!Number.isFinite(v)) return;
      s[key] = v;
      val.textContent = fmt(v);
      this.cb.settingsChanged();
    };
    row.append(this.rowText(label, help), inp, val);
    return row;
  }

  private rowText(label: string, help = ''): HTMLElement {
    const text = h('span', 'set-text');
    text.append(txt('span', 'set-l', label));
    if (help) text.append(txt('span', 'set-help', help));
    return text;
  }

  private buildSettings(): HTMLElement {
    const s = this.settings;
    const box = h('div', 'sheet-box');
    const changed = () => this.cb.settingsChanged();
    const body = h('div', 'sheet-body settings-body');
    const rail = h('nav', 'rail');
    rail.setAttribute('aria-label', 'Settings groups');
    const cols = [h('div', 'set-col'), h('div', 'set-col')];

    const sw = (label: string, key: BooleanSettingKey, help = '') => {
      const row = h('div', 'set-row choice');
      const b = h('button', 'switch', '<span class="switch-state"></span><span class="switch-track"><i></i></span>');
      b.type = 'button';
      b.setAttribute('role', 'switch');
      b.setAttribute('aria-label', label);
      const state = b.querySelector('.switch-state')!;
      const draw = () => {
        b.setAttribute('aria-checked', String(s[key]));
        state.textContent = s[key] ? 'On' : 'Off';
      };
      b.onclick = () => {
        s[key] = !s[key];
        draw();
        changed();
      };
      draw();
      row.append(this.rowText(label, help), b);
      return row;
    };
    /** a choice of two or three: one chip each */
    const seg = (label: string, options: readonly string[], at: () => number, pick: (i: number) => void, help = '') => {
      const row = h('div', 'set-row choice');
      const chips = this.chipGroup(
        label,
        options,
        at,
        (i) => {
          pick(i);
          changed();
        },
        false,
      );
      row.append(this.rowText(label, help), chips);
      return row;
    };
    const group = (col: number, icon: IconName, title: string, rows: HTMLElement[]) => {
      const sec = h('section', 'set-group');
      sec.append(txt('h2', 'eyebrow', title), ...rows);
      cols[col].append(sec);
      const jump = h('button', 'rail-btn', `${ICONS[icon]}<span>${title}</span>`);
      jump.type = 'button';
      jump.onclick = () => sec.scrollIntoView({ block: 'start', behavior: systemPrefersReducedMotion() ? 'auto' : 'smooth' });
      rail.append(jump);
    };
    const two = (v: number) => v.toFixed(2);
    const touchModes: Settings['touchControls'][] = ['auto', 'on', 'off'];
    group(0, 'controls', 'Controls', [
      this.sliderRow('Mouse sensitivity', 'sensitivity', two),
      sw('Invert Y', 'invertY'),
      seg(
        'Touch controls',
        ['Auto', 'On', 'Off'],
        () => touchModes.indexOf(s.touchControls),
        (i) => (s.touchControls = touchModes[i]),
        'Auto turns them on for touch screens.',
      ),
      this.sliderRow('Touch aim sensitivity', 'touchSensitivity', two),
    ]);
    group(1, 'camera', 'Camera', [
      seg(
        'View',
        ['Third person', 'First person'],
        () => (s.firstPerson ? 1 : 0),
        (i) => (s.firstPerson = i === 1),
        'V switches while you play.',
      ),
      this.sliderRow('Field of view', 'fov', (v) => `${v.toFixed(0)}°`),
      this.sliderRow('Camera shake', 'shake', percent),
      sw('Perfect-spike replays', 'replays'),
    ]);
    group(1, 'assists', 'Assists and hints', [
      this.sliderRow(
        'Aim assist',
        'aimAssist',
        percent,
        '',
        'Helps your body only: a little reach and a drift towards the ball. 0 is off.',
      ),
      sw('Slow-mo assist', 'slowmoAssist'),
      sw('Landing marker', 'landingMarker'),
      sw('Hints', 'showHints', 'The key hint at the bottom, and the timing collar around the charge ring.'),
    ]);
    group(0, 'sound', 'Sound', [this.sliderRow('Volume', 'volume', percent)]);
    group(0, 'court', 'Court', [
      seg(
        'Net height',
        ["Men's 2.43 m", "Women's 2.24 m"],
        () => (s.womenNet ? 1 : 0),
        (i) => (s.womenNet = i === 1),
      ),
    ]);

    // back to the defaults, in two presses (the athlete is not touched)
    const reset = btn('ghost-btn rail-reset', 'Reset to defaults');
    let armed = false;
    reset.onclick = () => {
      if (!armed) {
        armed = true;
        reset.textContent = 'Reset all of these?';
        return;
      }
      const d = defaultSettings(systemPrefersReducedMotion());
      Object.assign(s, { ...d, bodies: s.bodies, hand: s.hand });
      changed();
      this.openSheet('settings');
    };
    reset.onblur = () => {
      armed = false;
      reset.textContent = 'Reset to defaults';
    };
    rail.append(txt('p', 'rail-note', 'Height, jump, power and your hitting hand are under Athlete.'), reset);
    const grid = h('div', 'set-cols');
    grid.append(...cols);
    body.append(rail, grid);
    box.append(this.sheetHead('Settings', 'athlete'), body);
    return box;
  }

  /**
   * Athlete: your position, and your hitting hand, height, vertical jump and spike power for it
   * (only your player, never the AI). The cards' stat bars follow the sliders.
   */
  private buildAthlete(): HTMLElement {
    const s = this.settings;
    const box = h('div', 'sheet-box');
    const body = h('div', 'sheet-body athlete-body');
    const changed = () => this.cb.settingsChanged();

    const left = h('div', 'athlete-left');
    const cards = h('div', 'pos-row');
    cards.setAttribute('role', 'group');
    cards.setAttribute('aria-label', 'Position');
    const cardOf = new Map<PositionId, HTMLButtonElement>();
    const side = h('div', 'body-set');
    const drawCards = () => {
      const stats = athleteStats(s.bodies);
      for (const [id, c] of cardOf) {
        const p = POSITIONS[id];
        const on = id === this.pos;
        const b = resolveBody(id, s.bodies[id]);
        setOn(c, on);
        c.innerHTML = `<span class="pos-top"><span class="pos-short">${p.short}</span>${courtGlyph(id, on)}</span>
          <span class="pos-name">${p.name}</span><span class="pos-blurb">${p.blurb}</span>
          ${stats[id]
            .map(
              (st) =>
                `<span class="stat stat-${st.tier}"><span class="stat-head"><span>${st.label}</span><b>${st.value}</b></span><span class="stat-track"><i style="width:${Math.round(st.frac * 100)}%"></i></span></span>`,
            )
            .join('')}
          <span class="pos-h">${b.height.toFixed(2)} m${isCustomBody(id, s.bodies[id]) ? ' · <b>custom</b>' : ''}${s.hand === 'left' ? ' · <b>lefty</b>' : ''}</span>`;
      }
    };
    const drawBody = () => {
      const id = this.pos;
      const p = POSITIONS[id];
      side.replaceChildren(
        txt('div', 'eyebrow', `Your body as ${p.name}`),
        txt('div', 'set-help', 'Only your player changes, never the AI. It applies right away.'),
      );
      // one hand for every position: spikes, tips and serves (passing, setting and blocking use both hands)
      const handRow = h('div', 'set-row choice');
      const hands = h('div', 'chips');
      hands.setAttribute('role', 'group');
      hands.setAttribute('aria-label', 'Hitting hand');
      const handBtns = (['right', 'left'] as const).map((hand) => {
        const b = btn('chip', hand === 'right' ? 'Right' : 'Left');
        b.onclick = () => {
          s.hand = hand;
          handBtns.forEach((x, n) => setOn(x, (n === 1) === (s.hand === 'left')));
          drawCards();
          changed();
        };
        hands.append(b);
        return b;
      });
      handBtns.forEach((x, n) => setOn(x, (n === 1) === (s.hand === 'left')));
      handRow.append(this.rowText('Hitting hand'), hands);
      side.append(handRow);

      const reach = h('div', 'reach');
      const defaults = h('div', 'set-help');
      const reset = btn('ghost-btn body-reset', `Reset ${p.short} to defaults`);
      const sum = () => {
        const b = resolveBody(id, s.bodies[id]);
        reach.replaceChildren(txt('span', '', 'Spike reach'), txt('b', '', `${spikeReach(b).toFixed(2)} m`));
        reset.disabled = !isCustomBody(id, s.bodies[id]);
      };
      const slider = (label: string, key: keyof BodyOverride) => {
        const lim = BODY[key];
        const v0 = resolveBody(id, s.bodies[id])[key];
        const row = h('label', 'set-row stack');
        const val = txt('span', 'set-val', BODY_FMT[key](v0));
        const inp = h('input');
        inp.type = 'range';
        inp.min = String(lim.min);
        inp.max = String(lim.max);
        inp.step = String(lim.step);
        inp.value = String(v0);
        inp.dataset.body = key;
        inp.oninput = () => {
          const v = parseFloat(inp.value);
          if (!Number.isFinite(v)) return;
          setBodyValue(s.bodies, id, key, v);
          val.textContent = BODY_FMT[key](v);
          sum();
          drawCards();
          changed();
        };
        const head = h('span', 'set-head');
        head.append(txt('span', 'set-l', label), val);
        row.append(head, inp);
        side.append(row);
      };
      slider('Height', 'height');
      slider('Vertical jump', 'jump');
      slider('Spike power', 'power');
      defaults.textContent = `${p.short} default: ${p.height.toFixed(2)} m · ${Math.round(p.jump * 100)} cm · ${Math.round(topSpikeKmh(p.power))} km/h`;
      reset.onclick = () => {
        delete s.bodies[id];
        changed();
        drawCards();
        drawBody();
      };
      side.append(reach, defaults, reset);
      sum();
    };
    for (const id of POSITION_IDS) {
      const c = btn('pos-card');
      c.onclick = () => {
        this.pos = id;
        this.save();
        drawCards();
        drawBody();
      };
      cardOf.set(id, c);
      cards.append(c);
    }
    const legend = h(
      'div',
      'legend',
      '<span class="stat-best"><i></i>Best of the five</span><span class="stat-strong"><i></i>Strong</span><span class="stat-base"><i></i>Not this position\'s job</span><span class="legend-n">The dot is where you start on your side of the net.</span>',
    );
    left.append(txt('p', 'view-s', 'Your position. You can still switch for a single drill from its panel.'), cards, legend);
    drawCards();
    drawBody();
    body.append(left, side);
    box.append(this.sheetHead('Athlete', 'settings'), body);
    return box;
  }
}
