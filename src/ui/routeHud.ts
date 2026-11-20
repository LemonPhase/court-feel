import { COURT } from '../config';
import { callCss } from '../game/callRuns';
import { needsGoodPass, SETTER_PLAYS, SETTER_SPOT, type SetPlay } from '../game/plays';
import { routeLine, routeTempo, type RouteTempo, type RouteView, type TeamPlayView } from '../game/routes';
import { SETTER_KEYS } from '../game/setterCalls';

/**
 * Your routes as a hitter. The route strip is always there while you call your own set (keys 1-5):
 * the route you are calling, how fast it is, and the play your setter has called. C opens the route
 * panel beside it: your half of the court from above with every route's run and where it is hit,
 * your team-mates' routes in the setter's play, and the list. It sits at the side, never over the
 * middle of the screen, and the game does not slow down for it.
 */

const SVG = 'http://www.w3.org/2000/svg';

/** bars lit on the tempo meter (a faster set, more bars) and the word for it */
const TEMPO: Record<RouteTempo, { bars: number; word: string }> = {
  high: { bars: 1, word: 'High' },
  medium: { bars: 2, word: 'Medium' },
  fast: { bars: 3, word: 'Fast' },
  quick: { bars: 4, word: 'Quick' },
};

const WHO: Record<RouteView['position'], string> = { OH: 'Outside', MB: 'Middle', OPP: 'Opposite' };

/** the court sketch: metres to the drawing (x across the net, z away from it), the net at the top */
const PX = 30;
const W = 300;
const TOP = 16;
/** metres drawn behind the net: past the pipe's start (5.5 m) */
const DEEP = 6;
const H = Math.round(TOP + DEEP * PX + 6);
const px = (x: number) => (W / 2 + x * PX).toFixed(1);
const py = (z: number) => (TOP + z * PX).toFixed(1);
/** hit spots nearer than this (m) along the net share one marker */
const SAME_SPOT = 0.5;

/** two draw keys hold the same things (the play by identity: TeamAI.playView keeps it while unchanged) */
const same = (a: readonly unknown[], b: readonly unknown[]) => a.length === b.length && a.every((x, i) => x === b[i]);

const esc = (s: string) => s.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);

/** a route's tempo as bars, with its word unless the route is named after it (the High route reads "High", not "High High") */
function tempoMeter(t: RouteTempo, name: string): string {
  const { bars, word } = TEMPO[t];
  const said = name.toLowerCase() === word.toLowerCase() ? '' : `<em>${word}</em>`;
  return `<span class="tempo" data-n="${bars}"><i></i><i></i><i></i><i></i>${said}</span>`;
}

/** what a route is, in a few words: the name's own explanation, else its full name */
function note(p: SetPlay): string {
  const m = /\(([^)]+)\)/.exec(p.name);
  return m ? m[1] : p.name;
}

/** a run from the approach start to the hit, curving in so it ends square to the net (as hitters run it) */
function runPath(p: SetPlay): string {
  const r = routeLine(p);
  const cx = r.x + (r.sx - r.x) * 0.2;
  const cz = r.z + (r.sz - r.z) * 0.5;
  return `M ${px(r.sx)} ${py(r.sz)} Q ${px(cx)} ${py(cz)} ${px(r.x)} ${py(r.z)}`;
}

/** the play's state, as the strip and the panel say it */
function playState(p: TeamPlayView, high: boolean): { cls: string; word: string } {
  if (high) return { cls: 'high', word: 'High' };
  if (p.state === 'running') return { cls: 'on', word: 'On' };
  if (p.state === 'off') return { cls: 'off', word: 'Off' };
  return p.on === 'receive' ? { cls: 'wait', word: 'On a perfect pass' } : { cls: 'wait', word: 'Called' };
}

export class RouteHud {
  /** the panel is open (C), as last drawn */
  private open = false;
  private strip: HTMLDivElement;
  private panel: HTMLDivElement;
  /** what each was last drawn for (TeamAI.playView keeps its object while the play is unchanged) */
  private stripKey: unknown[] = [];
  private panelKey: unknown[] = [];
  private lastOn = -1;
  private lastPos = '';

  /** the panel goes on `parent`, the strip in `foot` (the HUD's bottom column, so it stacks over the key line) */
  constructor(parent: HTMLElement, foot: HTMLElement = parent) {
    this.strip = document.createElement('div');
    this.strip.className = 'route-strip';
    // hidden until there is a route to show (the first update with none changes nothing)
    this.strip.style.display = 'none';
    this.panel = document.createElement('div');
    this.panel.className = 'route-panel';
    this.panel.setAttribute('aria-hidden', 'true');
    foot.append(this.strip);
    parent.append(this.panel);
  }

  /** draw both for `v` (null: you are not calling a route; both hide), the panel when `open` */
  update(v: RouteView | null, open: boolean): void {
    this.open = !!v && open;
    this.drawStrip(v);
    this.drawPanel(v);
  }

  private drawStrip(v: RouteView | null): void {
    const p = v ? v.plays[v.on] : null;
    const key = v && p ? [v.position, v.on, v.play, v.high, this.open] : [];
    if (same(key, this.stripKey)) return;
    this.stripKey = key;
    this.strip.style.display = v && p ? '' : 'none';
    this.strip.classList.toggle('panel-open', this.open);
    if (!v || !p) {
      this.lastOn = -1;
      return;
    }
    this.strip.style.setProperty('--c', callCss(v.position));
    const pips = v.plays.map((_, i) => `<em${i === v.on ? ' class="on"' : ''}></em>`).join('');
    let play = '';
    if (v.high)
      play = `<span class="rs-play"><small>Setter</small><b class="rs-badge high">High</b><span class="rs-why">out of system</span></span>`;
    else if (v.play) {
      const s = playState(v.play, false);
      play = `<span class="rs-play rs-${s.cls}"><small>Setter</small><strong>${esc(v.play.name)}</strong><b class="rs-badge ${s.cls}">${s.word}</b></span>`;
    }
    this.strip.innerHTML =
      `<b class="rs-key">${v.on + 1}</b><span class="rs-name">${esc(p.short)}</span>${tempoMeter(routeTempo(p), p.short)}` +
      `<span class="rs-pips">${pips}</span>${play}<kbd class="rs-c">C</kbd>`;
    // a new call: the key pops (same position, so not on the first draw)
    if (this.lastOn >= 0 && this.lastOn !== v.on && this.lastPos === v.position) {
      const k = this.strip.querySelector('.rs-key');
      k?.classList.add('pop');
    }
    this.lastOn = v.on;
    this.lastPos = v.position;
  }

  private drawPanel(v: RouteView | null): void {
    const show = !!v && this.open;
    this.panel.classList.toggle('open', show);
    this.panel.setAttribute('aria-hidden', show ? 'false' : 'true');
    if (!v || !show) return;
    const key = [v.position, v.on, v.play, v.high];
    if (same(key, this.panelKey)) return;
    this.panelKey = key;
    this.panel.style.setProperty('--c', callCss(v.position));
    const list = v.plays
      .map(
        (p, i) =>
          `<li${i === v.on ? ' class="on"' : ''}><b>${i + 1}</b><span class="rp-name">${esc(p.short)}<small>${esc(note(p))}</small></span>` +
          `<span class="rp-t">${tempoMeter(routeTempo(p), p.short)}${needsGoodPass(p) ? '<u>good pass</u>' : ''}</span></li>`,
      )
      .join('');
    let play = '';
    if (v.play) {
      const s = playState(v.play, v.high);
      play =
        `<div class="rp-play rs-${s.cls}"><div><small>Setter's play</small><strong>${esc(v.play.name)}</strong>` +
        `<b class="rs-badge ${s.cls}">${s.word}</b></div><p>${esc(v.play.idea)}</p></div>`;
    }
    this.panel.innerHTML =
      `<div class="rp-head"><h2><span>${WHO[v.position]}</span> routes</h2><kbd class="rs-c">C</kbd></div>` +
      `<div class="rp-court"></div>${play}<ol class="rp-list">${list}</ol>`;
    this.panel.querySelector('.rp-court')!.appendChild(this.court(v));
    // a short window scrolls the list: keep the route you call in view
    const li = this.panel.querySelector<HTMLElement>('li.on');
    if (li) {
      const pad = 6;
      const bottom = li.offsetTop + li.offsetHeight + pad;
      if (bottom > this.panel.scrollTop + this.panel.clientHeight) this.panel.scrollTop = bottom - this.panel.clientHeight;
      else if (li.offsetTop - pad < this.panel.scrollTop) this.panel.scrollTop = li.offsetTop - pad;
    }
  }

  /** your half of the court from above: the net at the top, each route's run and its hit spot */
  private court(v: RouteView): SVGSVGElement {
    const svg = document.createElementNS(SVG, 'svg');
    svg.setAttribute('viewBox', `0 0 ${W} ${H}`);
    svg.setAttribute('role', 'img');
    svg.setAttribute('aria-label', `${WHO[v.position]} routes from above, the net at the top`);
    const hw = COURT.halfWidth;
    let s =
      `<defs><linearGradient id="rp-floor" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#fff" stop-opacity="0.07"/>` +
      `<stop offset="1" stop-color="#fff" stop-opacity="0"/></linearGradient></defs>` +
      `<rect x="${px(-hw)}" y="${TOP}" width="${2 * hw * PX}" height="${DEEP * PX + 6}" fill="url(#rp-floor)"/>` +
      `<path d="M ${px(-hw)} ${H} V ${TOP} M ${px(hw)} ${TOP} V ${H}" class="rp-line"/>` +
      `<line x1="${px(-hw)}" y1="${py(COURT.attackLine)}" x2="${px(hw)}" y2="${py(COURT.attackLine)}" class="rp-line rp-3m"/>` +
      `<text x="${+px(hw) - 4}" y="${+py(COURT.attackLine) - 4}" class="rp-tag" text-anchor="end">3 m</text>` +
      `<line x1="${+px(-hw) - 4}" y1="${TOP}" x2="${+px(hw) + 4}" y2="${TOP}" class="rp-net"/>` +
      `<line x1="${px(-hw)}" y1="${TOP - 9}" x2="${px(-hw)}" y2="${TOP + 1}" class="rp-ant"/>` +
      `<line x1="${px(hw)}" y1="${TOP - 9}" x2="${px(hw)}" y2="${TOP + 1}" class="rp-ant"/>`;
    // your team-mates' routes in the setter's play: faint, dashed, in their colours
    if (v.play) {
      for (const k of SETTER_KEYS) {
        if (k === v.position) continue;
        const p = SETTER_PLAYS[k].find((o) => o.short === v.play!.calls[k]);
        if (!p) continue;
        const r = routeLine(p);
        const c = callCss(k);
        s +=
          `<path d="${runPath(p)}" class="rp-mate" stroke="${c}"/>` +
          `<circle cx="${px(r.x)}" cy="${py(r.z)}" r="3.4" fill="${c}" class="rp-mate-dot"/>` +
          `<text x="${px(r.x)}" y="${+py(r.z) + 13}" class="rp-mate-tag" fill="${c}" text-anchor="middle">${esc(p.short)}</text>`;
      }
    }
    s += `<circle cx="${px(SETTER_SPOT.x)}" cy="${py(SETTER_SPOT.z)}" r="7" class="rp-setter"/>`;
    s += `<text x="${px(SETTER_SPOT.x)}" y="${+py(SETTER_SPOT.z) + 3.4}" class="rp-setter-s" text-anchor="middle">S</text>`;
    // your routes: the others first, the one you call on top
    const order = v.plays.map((_, i) => i).sort((a, b) => +(a === v.on) - +(b === v.on));
    for (const i of order) {
      const p = v.plays[i];
      const r = routeLine(p);
      const on = i === v.on;
      s += `<path d="${runPath(p)}" class="rp-run${on ? ' on' : ''}"/>`;
      s += `<circle cx="${px(r.sx)}" cy="${py(r.sz)}" r="${on ? 3.4 : 2.6}" class="rp-start${on ? ' on' : ''}"/>`;
    }
    // hit spots: routes hit from (nearly) the same spot share one marker, "1 2"
    const groups: { x: number; z: number; ids: number[] }[] = [];
    v.plays.forEach((p, i) => {
      const r = routeLine(p);
      const g = groups.find((o) => Math.hypot(o.x - r.x, o.z - r.z) < SAME_SPOT);
      if (g) g.ids.push(i);
      else groups.push({ x: r.x, z: r.z, ids: [i] });
    });
    groups.sort((a, b) => +a.ids.includes(v.on) - +b.ids.includes(v.on));
    for (const g of groups) {
      const on = g.ids.includes(v.on);
      const label = g.ids.map((i) => i + 1).join(' ');
      const rx = 8 + (label.length - 1) * 3.2;
      s +=
        `<rect x="${(+px(g.x) - rx).toFixed(1)}" y="${(+py(g.z) - 8).toFixed(1)}" width="${(2 * rx).toFixed(1)}" height="16" rx="8" class="rp-spot${on ? ' on' : ''}"/>` +
        `<text x="${px(g.x)}" y="${(+py(g.z) + 3.6).toFixed(1)}" class="rp-num${on ? ' on' : ''}" text-anchor="middle">${label}</text>`;
    }
    svg.innerHTML = s;
    return svg;
  }
}
