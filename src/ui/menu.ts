import { BODY, CAMERA, POSITIONS, type BodyOverride, type PositionId, type Settings } from '../config';
import { isCustomBody, resolveBody, setBodyValue, spikeReach, topSpikeKmh } from '../game/body';
import { MODE_INFO, type ModeId } from '../game/modes/mode';

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

export interface MenuCallbacks {
  play(mode: ModeId, pos: PositionId): void;
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

  constructor(parent: HTMLElement, private settings: Settings, private cb: MenuCallbacks) {
    try {
      const saved = JSON.parse(localStorage.getItem('courtfeel.menu') || '{}');
      if (saved.mode && saved.mode in MODE_INFO) this.mode = saved.mode;
      if (saved.pos && saved.pos in POSITIONS) this.pos = saved.pos;
    } catch {
      /* ignore */
    }
    // ------------------------------------------------------------ start screen
    this.start = h('div', 'menu');
    const left = h('div', 'menu-left');
    left.append(
      h('div', 'logo', '<span>COURT</span><b>FEEL</b>'),
      h('div', 'tagline', 'Approach. Plant. Explode. Feel every contact.'),
    );
    left.append(h('div', 'menu-h', '1 · Choose your position'));
    const posRow = h('div', 'pos-row');
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
    (Object.keys(MODE_INFO) as ModeId[]).forEach((id, i) => {
      const m = MODE_INFO[id];
      const c = h('button', 'mode-card', `<div class="mode-n">${i + 1}</div><div class="mode-t">${m.title}</div><div class="mode-b">${m.blurb}</div>`);
      c.onclick = () => this.selectMode(id);
      c.ondblclick = () => this.go();
      modeGrid.append(c);
      this.modeCards.set(id, c);
    });
    left.append(modeGrid);
    const bottom = h('div', 'menu-bottom');
    const camSel = h('div', 'cam-sel');
    const fpBtn = h('button', 'chip', 'First person');
    const tpBtn = h('button', 'chip', 'Third person');
    const syncCam = () => {
      fpBtn.classList.toggle('on', this.settings.firstPerson);
      tpBtn.classList.toggle('on', !this.settings.firstPerson);
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
    play.onclick = () => this.go();
    const setBtn = h('button', 'ghost-btn', 'Settings');
    setBtn.onclick = () => this.openSettings();
    bottom.append(camSel, setBtn, play);
    left.append(bottom);
    left.append(
      h(
        'div',
        'controls kb',
        `<b>WASD</b> move · <b>Shift</b> approach · <b>Space</b> plant & jump (hold to load) · <b>LMB</b> hold to wind up, release to spike (longer hold = harder · tap = tip) ·
         <b>RMB</b> block / set · <b>E</b> pass · <b>Q</b> serve toss · <b>V</b> camera · <b>R</b> reset rep · <b>Esc</b> pause · <b>F3</b> debug`,
      ),
      h(
        'div',
        'controls tc',
        `<b>Left thumb</b> joystick: push it out to the ring to run the approach · <b>Right thumb</b> drag anywhere to aim ·
         <b>JUMP</b> hold to load, release to take off · <b>HIT</b> hold to wind up (longer = harder), release to swing, tap = tip — drag while holding to aim;
         in the air the whole right half is HIT · <b>BLOCK</b> hold: hands up and jump (sets when the ball drops onto you) · <b>PASS</b> hold`,
      ),
    );
    this.start.append(left);
    parent.append(this.start);

    // ------------------------------------------------------------ pause
    this.pause = h('div', 'pause');
    const box = h('div', 'pause-box');
    box.append(h('div', 'pause-t', 'Paused'));
    const resume = h('button', 'play-btn', 'RESUME');
    resume.onclick = () => this.cb.resume();
    const restart = h('button', 'ghost-btn', 'Restart drill');
    restart.onclick = () => this.cb.restart();
    const quit = h('button', 'ghost-btn', 'Quit to menu');
    quit.onclick = () => this.cb.quit();
    const sett = h('button', 'ghost-btn', 'Settings');
    sett.onclick = () => this.openSettings();
    box.append(resume, sett, restart, quit);
    this.pause.append(box);
    parent.append(this.pause);

    // ------------------------------------------------------------ settings
    this.settingsPanel = h('div', 'settings');
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
        if (n >= 1 && n <= ids.length) this.selectMode(ids[n - 1]);
        if (e.key === 'Enter') this.go();
      }
    });
  }

  private settingsOpen = false;

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
        <div class="pos-h">${b.height.toFixed(2)} m${isCustomBody(id, custom) ? ' · <b>custom</b>' : ''}</div>`;
    }
  }

  private go(): void {
    try {
      localStorage.setItem('courtfeel.menu', JSON.stringify({ mode: this.mode, pos: this.pos }));
    } catch {
      /* ignore */
    }
    this.cb.play(this.mode, this.pos);
  }

  selectPos(id: PositionId): void {
    this.pos = id;
    for (const [k, c] of this.posCards) c.classList.toggle('on', k === id);
  }

  selectMode(id: ModeId): void {
    this.mode = id;
    for (const [k, c] of this.modeCards) c.classList.toggle('on', k === id);
  }

  showStart(v: boolean): void {
    this.start.style.display = v ? 'flex' : 'none';
  }

  showPause(v: boolean): void {
    this.pause.style.display = v ? 'flex' : 'none';
    if (!v) this.closeSettings();
  }

  get pauseVisible(): boolean {
    return this.pause.style.display !== 'none';
  }

  openSettings(): void {
    this.bodyTab = this.pos;
    this.buildSettings();
    this.settingsPanel.style.display = 'flex';
    this.settingsOpen = true;
  }

  closeSettings(): void {
    this.settingsPanel.style.display = 'none';
    this.settingsOpen = false;
  }

  private buildSettings(): void {
    const s = this.settings;
    const p = this.settingsPanel;
    p.innerHTML = '';
    const box = h('div', 'settings-box');
    box.append(h('div', 'pause-t', 'Settings'));
    const grid = h('div', 'set-grid');
    const changed = () => this.cb.settingsChanged();
    const slider = (label: string, key: keyof Settings, min: number, max: number, step: number, fmt: (v: number) => string) => {
      const row = h('label', 'set-row');
      const val = h('span', 'set-val', fmt(s[key] as number));
      const inp = h('input') as HTMLInputElement;
      inp.type = 'range';
      inp.min = String(min);
      inp.max = String(max);
      inp.step = String(step);
      inp.value = String(s[key]);
      inp.oninput = () => {
        (s as any)[key] = parseFloat(inp.value);
        val.textContent = fmt(s[key] as number);
        changed();
      };
      row.append(h('span', 'set-l', label), inp, val);
      grid.append(row);
    };
    const toggle = (label: string, key: keyof Settings, opts?: Opt[]) => {
      const row = h('label', 'set-row');
      const btn = h('button', 'chip');
      const sync = () => {
        const v = s[key] as boolean;
        btn.textContent = opts ? (v ? opts[1].label : opts[0].label) : v ? 'On' : 'Off';
        btn.classList.toggle('on', v);
      };
      btn.onclick = (e) => {
        e.preventDefault();
        (s as any)[key] = !s[key];
        sync();
        changed();
      };
      sync();
      row.append(h('span', 'set-l', label), btn);
      grid.append(row);
    };
    const choice = <T extends string>(label: string, key: keyof Settings, opts: { value: T; label: string }[]) => {
      const row = h('label', 'set-row');
      const btn = h('button', 'chip');
      const sync = () => {
        const v = s[key] as string;
        btn.textContent = opts.find((o) => o.value === v)?.label ?? v;
        btn.classList.toggle('on', v !== opts[0].value);
      };
      btn.onclick = (e) => {
        e.preventDefault();
        const i = opts.findIndex((o) => o.value === s[key]);
        (s as any)[key] = opts[(i + 1) % opts.length].value;
        sync();
        changed();
      };
      sync();
      row.append(h('span', 'set-l', label), btn);
      grid.append(row);
    };
    slider('Mouse sensitivity', 'sensitivity', 0.2, 3, 0.05, (v) => v.toFixed(2));
    choice('Touch controls', 'touchControls', [
      { value: 'auto', label: 'Auto (touch screens)' },
      { value: 'on', label: 'On' },
      { value: 'off', label: 'Off' },
    ]);
    slider('Touch aim sensitivity', 'touchSensitivity', 0.3, 3, 0.05, (v) => v.toFixed(2));
    slider('Field of view', 'fov', 55, 100, 1, (v) => `${v.toFixed(0)}°`);
    toggle('Invert Y', 'invertY');
    toggle('Net height', 'womenNet', [
      { value: 'm', label: "Men's 2.43 m" },
      { value: 'w', label: "Women's 2.24 m" },
    ]);
    slider('Aim assist', 'aimAssist', 0, 1, 0.05, (v) => (v === 0 ? 'Off' : `${Math.round(v * 100)}%`));
    toggle('Slow-mo assist', 'slowmoAssist');
    toggle('Landing marker', 'landingMarker');
    toggle('Perfect-spike replays', 'replays');
    slider('Camera shake', 'shake', 0, 1.5, 0.05, (v) => (v === 0 ? 'Off' : `${Math.round(v * 100)}%`));
    slider('Volume', 'volume', 0, 1, 0.05, (v) => `${Math.round(v * 100)}%`);
    toggle('Key hints', 'showHints');
    const cols = h('div', 'settings-cols');
    cols.append(grid, this.buildBodySettings(changed));
    box.append(cols);
    const close = h('button', 'play-btn', 'DONE');
    close.onclick = () => this.closeSettings();
    box.append(close);
    p.append(box);
    p.style.display = this.settingsOpen ? 'flex' : 'none';
  }

  /** "Your athlete": height, vertical jump and spike power for each position you play (only your player, never the AI) */
  private buildBodySettings(changed: () => void): HTMLElement {
    const s = this.settings;
    const wrap = h('div', 'body-set');
    const draw = () => {
      wrap.innerHTML = '';
      const id = this.bodyTab;
      const p = POSITIONS[id];
      wrap.append(
        h('div', 'set-h', 'Your athlete'),
        h('div', 'set-note', 'Height, vert and spike power for each position you play. Only your player changes; it applies right away.'),
      );
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

export const DEFAULT_FOV = CAMERA.fov;
