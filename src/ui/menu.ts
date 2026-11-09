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
import { isCustomBody, resolveBody, setBodyValue, spikeReach, topSpikeKmh } from '../game/body';
import { isModeId, MODE_INFO, type ModeId } from '../game/modes/mode';
import { BUILD_LABEL } from '../core/build';

type Opt = { value: string; label: string };

function h<K extends keyof HTMLElementTagNameMap>(tag: K, cls = '', html = ''): HTMLElementTagNameMap[K] {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (html) e.innerHTML = html;
  return e;
}

const STAT_MAX = { jump: 0.95, speed: 5.8, power: 1.1, control: 1 };

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

/** a selectable card or chip: the highlight and, for assistive tech, the pressed state */
function setOn(e: HTMLElement, on: boolean): void {
  e.classList.toggle('on', on);
  e.setAttribute('aria-pressed', String(on));
}

function isTextEntry(t: EventTarget | null): boolean {
  return t instanceof HTMLElement && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA') && (t as HTMLInputElement).type !== 'range';
}

/** the build label ("v0.1.0 · abc1234"): players can name it in a bug report */
function buildTag(): HTMLElement {
  const e = h('div', 'build');
  e.textContent = BUILD_LABEL;
  return e;
}

export interface MenuCallbacks {
  play(mode: ModeId, pos: PositionId): void;
  /** PLAY / Enter while the first-run tutorial is still offered */
  playTutorial(): void;
  replayTutorial(): void;
  skipTutorial(): void;
  tutorialPending(): boolean;
  tutorialActive(): boolean;
  resume(): void;
  restart(): void;
  quit(): void;
  settingsChanged(): void;
}

/** Start screen (position + drill select), pause overlay and settings. */
export class Menu {
  readonly start: HTMLDivElement;
  readonly pause: HTMLDivElement;
  private settingsPanel: HTMLDivElement;
  mode: ModeId = 'spike';
  pos: PositionId = 'OH';
  private modeCards = new Map<ModeId, HTMLElement>();
  private posCards = new Map<PositionId, HTMLElement>();
  /** which position the "Your athlete" settings edit (follows the selected position when the settings open) */
  private bodyTab: PositionId = 'OH';
  private tutNote!: HTMLElement;
  private skipTutorialBtn!: HTMLButtonElement;

  constructor(
    parent: HTMLElement,
    private settings: Settings,
    private cb: MenuCallbacks,
  ) {
    try {
      const saved = JSON.parse(localStorage.getItem('courtfeel.menu') || '{}');
      if (isModeId(saved?.mode)) this.mode = saved.mode;
      if (isPositionId(saved?.pos)) this.pos = saved.pos;
    } catch {
      /* ignore */
    }
    // ------------------------------------------------------------ start screen
    this.start = h('div', 'menu');
    const left = h('div', 'menu-left');
    left.append(h('div', 'logo', '<span>COURT</span><b>FEEL</b>'), h('div', 'tagline', 'Approach. Plant. Explode. Feel every contact.'));
    left.append(h('div', 'menu-h', '1 · Choose your position'));
    const posRow = h('div', 'pos-row');
    posRow.setAttribute('role', 'group');
    posRow.setAttribute('aria-label', 'Position');
    for (const id of Object.keys(POSITIONS) as PositionId[]) {
      const c = h('button', 'pos-card');
      c.onclick = () => this.selectPos(id);
      posRow.append(c);
      this.posCards.set(id, c);
    }
    this.refreshPosCards();
    left.append(posRow);
    left.append(h('div', 'menu-h', '2 · Choose a drill'));
    const modeGrid = h('div', 'mode-grid');
    modeGrid.setAttribute('role', 'group');
    modeGrid.setAttribute('aria-label', 'Drill');
    (Object.keys(MODE_INFO) as ModeId[]).forEach((id, i) => {
      const m = MODE_INFO[id];
      const c = h(
        'button',
        'mode-card',
        `<div class="mode-n">${i + 1}</div><div class="mode-t">${m.title}</div><div class="mode-b">${m.blurb}</div>`,
      );
      c.onclick = () => this.selectMode(id);
      c.ondblclick = () => this.go(true);
      modeGrid.append(c);
      this.modeCards.set(id, c);
    });
    left.append(modeGrid);
    const bottom = h('div', 'menu-bottom');
    const camSel = h('div', 'cam-sel');
    const fpBtn = h('button', 'chip', 'First person');
    const tpBtn = h('button', 'chip', 'Third person');
    const syncCam = () => {
      setOn(fpBtn, this.settings.firstPerson);
      setOn(tpBtn, !this.settings.firstPerson);
    };
    fpBtn.onclick = () => {
      this.settings.firstPerson = true;
      syncCam();
      this.cb.settingsChanged();
    };
    tpBtn.onclick = () => {
      this.settings.firstPerson = false;
      syncCam();
      this.cb.settingsChanged();
    };
    syncCam();
    camSel.append(fpBtn, tpBtn);
    const play = h('button', 'play-btn', 'PLAY');
    play.id = 'play';
    play.onclick = () => this.go(false);
    const setBtn = h('button', 'ghost-btn', 'Settings');
    setBtn.onclick = () => this.openSettings(setBtn);
    const replay = h('button', 'ghost-btn tut-replay', 'Replay tutorial');
    replay.type = 'button';
    replay.onclick = () => this.cb.replayTutorial();
    bottom.append(camSel, replay, setBtn, play);
    this.tutNote = h('div', 'tut-note', 'PLAY walks you through one spike. Tutorial uses Outside. Double-click any drill to start it.');
    left.append(this.tutNote, bottom);
    left.append(
      h(
        'div',
        'controls kb',
        `<b>WASD</b> move · <b>Shift</b> approach · <b>Space</b> plant & jump (hold to load) · <b>LMB</b> hold to wind up, release to spike (longer hold = harder · tap = tip) ·
         <b>RMB</b> block / set · <b>E</b> pass · <b>Q</b> serve toss · <b>V</b> camera · <b>R</b> replay · <b>N</b> reset rep · <b>Esc</b> pause · <b>F3</b> debug`,
      ),
      h(
        'div',
        'controls tc',
        `<b>Left thumb</b> joystick: push it out to the ring to run the approach · <b>Right thumb</b> drag anywhere to aim ·
         <b>JUMP</b> hold to load, release to take off · <b>HIT</b> hold to wind up (longer = harder), release to swing, tap = tip — drag while holding to aim;
         in the air the whole right half is HIT · <b>BLOCK</b> hold: hands up and jump (sets when the ball drops onto you) · <b>PASS</b> hold`,
      ),
    );
    left.append(buildTag());
    this.start.append(left);
    parent.append(this.start);

    // ------------------------------------------------------------ pause
    this.pause = h('div', 'pause');
    this.pause.setAttribute('role', 'dialog');
    this.pause.setAttribute('aria-label', 'Paused');
    const box = h('div', 'pause-box');
    box.append(h('div', 'pause-t', 'Paused'));
    const resume = h('button', 'play-btn', 'RESUME');
    this.resumeBtn = resume;
    resume.onclick = () => this.cb.resume();
    const restart = h('button', 'ghost-btn', 'Restart drill');
    restart.onclick = () => this.cb.restart();
    const quit = h('button', 'ghost-btn', 'Quit to menu');
    quit.onclick = () => this.cb.quit();
    const sett = h('button', 'ghost-btn', 'Settings');
    sett.onclick = () => this.openSettings(sett);
    this.skipTutorialBtn = h('button', 'ghost-btn', 'Skip tutorial');
    this.skipTutorialBtn.type = 'button';
    this.skipTutorialBtn.style.display = 'none';
    this.skipTutorialBtn.onclick = () => this.cb.skipTutorial();
    box.append(resume, sett, restart, this.skipTutorialBtn, quit, buildTag());
    this.pause.append(box);
    parent.append(this.pause);

    // ------------------------------------------------------------ settings
    this.settingsPanel = h('div', 'settings');
    this.settingsPanel.setAttribute('role', 'dialog');
    this.settingsPanel.setAttribute('aria-label', 'Settings');
    parent.append(this.settingsPanel);
    this.buildSettings();

    this.selectPos(this.pos);
    this.selectMode(this.mode);
    this.showStart(true);
    this.showPause(false);
    window.addEventListener('keydown', (e) => {
      if (this.start.style.display !== 'none' && !this.settingsOpen) {
        const n = parseInt(e.key, 10);
        const ids = Object.keys(MODE_INFO) as ModeId[];
        if (n >= 1 && n <= ids.length && !isTextEntry(e.target)) this.selectMode(ids[n - 1]);
        if (e.key === 'Enter') {
          // Enter plays from anywhere on the start screen, including a focused position or drill card
          // (Space or a click selects a card). Other focused controls handle Enter themselves.
          const control = (e.target as HTMLElement | null)?.closest?.('button, input, textarea, select');
          if (control && !control.matches('.pos-card, .mode-card')) return;
          e.preventDefault();
          this.go(false);
        }
      }
      if (e.key === 'Escape' && this.settingsOpen) {
        // Esc closes the settings only (main's Esc handler would also leave the pause menu)
        this.closeSettings();
        e.stopImmediatePropagation();
      }
    });
  }

  private settingsOpen = false;
  private resumeBtn: HTMLButtonElement | null = null;
  /** the button that opened the settings: focus returns there when they close */
  private settingsOpener: HTMLElement | null = null;

  /** position cards show your custom height / vert / power where you set one */
  private refreshPosCards(): void {
    for (const [id, c] of this.posCards) {
      const p = POSITIONS[id];
      const custom = this.settings.bodies[id];
      const b = resolveBody(id, custom);
      const bar = (label: string, v: number, max: number) =>
        `<div class="stat"><span>${label}</span><i style="width:${Math.min(100, Math.round((v / max) * 100))}%"></i></div>`;
      c.innerHTML = `<div class="pos-short">${p.short}</div><div class="pos-name">${p.name}</div>
        <div class="pos-blurb">${p.blurb}</div>
        ${bar('Jump', b.jump, STAT_MAX.jump)}${bar('Speed', p.approachSpeed, STAT_MAX.speed)}
        ${bar('Power', b.power, STAT_MAX.power)}${bar('Control', p.ballControl, STAT_MAX.control)}
        <div class="pos-h">${b.height.toFixed(2)} m${isCustomBody(id, custom) ? ' · <b>custom</b>' : ''}${this.settings.hand === 'left' ? ' · <b>lefty</b>' : ''}</div>`;
    }
  }

  /**
   * PLAY and Enter offer the tutorial while it is still pending.
   * A double-clicked drill card is an explicit choice and starts that drill.
   */
  private go(explicitDrill: boolean): void {
    try {
      localStorage.setItem('courtfeel.menu', JSON.stringify({ mode: this.mode, pos: this.pos }));
    } catch {
      /* ignore */
    }
    if (!explicitDrill && this.cb.tutorialPending()) {
      this.cb.playTutorial();
      return;
    }
    this.cb.play(this.mode, this.pos);
  }

  selectPos(id: PositionId): void {
    this.pos = id;
    for (const [k, c] of this.posCards) setOn(c, k === id);
  }

  selectMode(id: ModeId): void {
    this.mode = id;
    for (const [k, c] of this.modeCards) setOn(c, k === id);
  }

  showStart(v: boolean): void {
    this.start.style.display = v ? 'flex' : 'none';
    if (v) this.syncTutorial();
  }

  showPause(v: boolean): void {
    const was = this.pauseVisible;
    this.pause.style.display = v ? 'flex' : 'none';
    if (!v) this.closeSettings();
    else {
      if (!was) this.resumeBtn?.focus();
      this.syncTutorial();
    }
  }

  /** start-screen note and the pause-menu skip, from the stored flag and the live session */
  syncTutorial(): void {
    this.tutNote.style.display = this.cb.tutorialPending() ? '' : 'none';
    this.skipTutorialBtn.style.display = this.cb.tutorialActive() ? '' : 'none';
  }

  get pauseVisible(): boolean {
    return this.pause.style.display !== 'none';
  }

  get settingsVisible(): boolean {
    return this.settingsOpen;
  }

  openSettings(opener?: HTMLElement): void {
    this.settingsOpener = opener ?? null;
    this.bodyTab = this.pos;
    this.buildSettings();
    this.settingsPanel.style.display = 'flex';
    this.settingsOpen = true;
    this.settingsPanel.querySelector<HTMLElement>('input, button')?.focus();
  }

  closeSettings(): void {
    if (!this.settingsOpen) return;
    this.settingsPanel.style.display = 'none';
    this.settingsOpen = false;
    // back to the button that opened them, if it is still on screen
    const o = this.settingsOpener;
    this.settingsOpener = null;
    if (o?.isConnected && o.offsetParent !== null) o.focus();
  }

  private buildSettings(): void {
    const s = this.settings;
    const p = this.settingsPanel;
    p.innerHTML = '';
    const box = h('div', 'settings-box');
    box.append(h('div', 'pause-t', 'Settings'));
    const grid = h('div', 'set-grid');
    const changed = () => this.cb.settingsChanged();
    const slider = (label: string, key: NumericSettingKey, fmt: (v: number) => string) => {
      const { min, max, step } = SETTING_RANGES[key];
      const row = h('label', 'set-row');
      const val = h('span', 'set-val', fmt(s[key]));
      const inp = h('input') as HTMLInputElement;
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
        changed();
      };
      row.append(h('span', 'set-l', label), inp, val);
      grid.append(row);
    };
    const toggle = (label: string, key: BooleanSettingKey, opts?: Opt[]) => {
      const row = h('label', 'set-row');
      const btn = h('button', 'chip');
      const sync = () => {
        const v = s[key];
        btn.textContent = opts ? (v ? opts[1].label : opts[0].label) : v ? 'On' : 'Off';
        btn.classList.toggle('on', v);
        // an On/Off switch exposes its state; a two-way choice (net height) says it in its label
        if (!opts) btn.setAttribute('aria-pressed', String(v));
      };
      btn.onclick = (e) => {
        e.preventDefault();
        s[key] = !s[key];
        sync();
        changed();
      };
      sync();
      row.append(h('span', 'set-l', label), btn);
      grid.append(row);
    };
    const choice = (label: string, key: 'touchControls', opts: { value: Settings['touchControls']; label: string }[]) => {
      const row = h('label', 'set-row');
      const btn = h('button', 'chip');
      const sync = () => {
        const v = s[key];
        btn.textContent = opts.find((o) => o.value === v)?.label ?? v;
        btn.classList.toggle('on', v !== opts[0].value);
      };
      btn.onclick = (e) => {
        e.preventDefault();
        const i = opts.findIndex((o) => o.value === s[key]);
        s[key] = opts[(i + 1) % opts.length].value;
        sync();
        changed();
      };
      sync();
      row.append(h('span', 'set-l', label), btn);
      grid.append(row);
    };
    slider('Mouse sensitivity', 'sensitivity', (v) => v.toFixed(2));
    choice('Touch controls', 'touchControls', [
      { value: 'auto', label: 'Auto (touch screens)' },
      { value: 'on', label: 'On' },
      { value: 'off', label: 'Off' },
    ]);
    slider('Touch aim sensitivity', 'touchSensitivity', (v) => v.toFixed(2));
    slider('Field of view', 'fov', (v) => `${v.toFixed(0)}°`);
    toggle('Invert Y', 'invertY');
    toggle('Net height', 'womenNet', [
      { value: 'm', label: "Men's 2.43 m" },
      { value: 'w', label: "Women's 2.24 m" },
    ]);
    slider('Aim assist', 'aimAssist', (v) => (v === 0 ? 'Off' : `${Math.round(v * 100)}%`));
    toggle('Slow-mo assist', 'slowmoAssist');
    toggle('Landing marker', 'landingMarker');
    toggle('Perfect-spike replays', 'replays');
    slider('Camera shake', 'shake', (v) => (v === 0 ? 'Off' : `${Math.round(v * 100)}%`));
    slider('Volume', 'volume', (v) => `${Math.round(v * 100)}%`);
    toggle('Hints', 'showHints');
    const replayRow = h('label', 'set-row');
    const replayBtn = h('button', 'chip', 'Replay tutorial');
    replayBtn.type = 'button';
    replayBtn.onclick = (e) => {
      e.preventDefault();
      this.closeSettings();
      this.cb.replayTutorial();
    };
    replayRow.append(h('span', 'set-l', 'Tutorial'), replayBtn);
    grid.append(replayRow);
    const cols = h('div', 'settings-cols');
    cols.append(grid, this.buildBodySettings(changed));
    box.append(cols);
    const close = h('button', 'play-btn', 'DONE');
    close.onclick = () => this.closeSettings();
    box.append(close);
    p.append(box);
    p.style.display = this.settingsOpen ? 'flex' : 'none';
  }

  /** "Your athlete": your hitting hand, and height, vertical jump and spike power for each position you play (only your player, never the AI) */
  private buildBodySettings(changed: () => void): HTMLElement {
    const s = this.settings;
    const wrap = h('div', 'body-set');
    const draw = () => {
      wrap.innerHTML = '';
      const id = this.bodyTab;
      const p = POSITIONS[id];
      wrap.append(
        h('div', 'set-h', 'Your athlete'),
        h(
          'div',
          'set-note',
          'Your hitting hand, and height, vert and spike power for each position you play. Only your player changes; it applies right away.',
        ),
      );
      // one hand for every position: spikes, tips and serves (passing, setting and blocking use both hands)
      const handRow = h('label', 'set-row');
      const handBtn = h('button', 'chip');
      const syncHand = () => {
        handBtn.textContent = s.hand === 'left' ? 'Left' : 'Right';
        handBtn.classList.toggle('on', s.hand === 'left');
      };
      handBtn.onclick = (e) => {
        e.preventDefault();
        s.hand = s.hand === 'left' ? 'right' : 'left';
        syncHand();
        this.refreshPosCards();
        changed();
      };
      syncHand();
      handRow.append(h('span', 'set-l', 'Hitting hand'), handBtn);
      wrap.append(handRow);
      const tabs = h('div', 'body-tabs');
      for (const pid of Object.keys(POSITIONS) as PositionId[]) {
        const t = h('button', 'chip body-tab', POSITIONS[pid].short);
        t.title = POSITIONS[pid].name;
        t.classList.toggle('on', pid === id);
        t.classList.toggle('custom', isCustomBody(pid, s.bodies[pid]));
        t.onclick = (e) => {
          e.preventDefault();
          this.bodyTab = pid;
          draw();
        };
        tabs.append(t);
      }
      wrap.append(tabs, h('div', 'body-pos', p.name));
      const sum = h('div', 'body-sum');
      const reset = h('button', 'ghost-btn body-reset', `Reset ${p.short} to defaults`);
      const sync = () => {
        const b = resolveBody(id, s.bodies[id]);
        const custom = isCustomBody(id, s.bodies[id]);
        sum.innerHTML = `Spike reach <b>${spikeReach(b).toFixed(2)} m</b><br><span>${p.short} default: ${p.height.toFixed(2)} m · ${Math.round(p.jump * 100)} cm · ${Math.round(topSpikeKmh(p.power))} km/h</span>`;
        reset.disabled = !custom;
        tabs.children[(Object.keys(POSITIONS) as PositionId[]).indexOf(id)]?.classList.toggle('custom', custom);
      };
      const slider = (label: string, key: keyof BodyOverride) => {
        const lim = BODY[key];
        const v0 = resolveBody(id, s.bodies[id])[key];
        const row = h('label', 'set-row');
        const val = h('span', 'set-val', BODY_FMT[key](v0));
        const inp = h('input') as HTMLInputElement;
        inp.type = 'range';
        inp.min = String(lim.min);
        inp.max = String(lim.max);
        inp.step = String(lim.step);
        inp.value = String(v0);
        inp.dataset.body = key;
        inp.oninput = () => {
          const v = parseFloat(inp.value);
          setBodyValue(s.bodies, id, key, v);
          val.textContent = BODY_FMT[key](v);
          sync();
          this.refreshPosCards();
          changed();
        };
        row.append(h('span', 'set-l', label), inp, val);
        wrap.append(row);
      };
      slider('Height', 'height');
      slider('Vertical jump', 'jump');
      slider('Spike power', 'power');
      reset.onclick = (e) => {
        e.preventDefault();
        delete s.bodies[id];
        this.refreshPosCards();
        changed();
        draw();
      };
      wrap.append(sum, reset);
      sync();
    };
    draw();
    return wrap;
  }
}
