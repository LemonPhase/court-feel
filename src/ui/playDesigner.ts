import { COURT, PLAYBOOK } from '../config';
import { callCss } from '../game/callRuns';
import { COMBOS } from '../game/combos';
import { callsOf, clashWith, cleanName, hitX, playbook, savePlay, wheelPlays } from '../game/playbook';
import { SETTER_PLAYS, SETTER_SPOT } from '../game/plays';
import { SETTER_KEYS, type SetterKey } from '../game/setterCalls';

const SVG = 'http://www.w3.org/2000/svg';
/** the court drawing: px per metre, the margin beside the sidelines and above the net (m), and how deep it shows (m) */
const S = 40;
const SIDE = 1.0;
const TOP = 0.5;
const DEEP = 6.5;
const px = (x: number) => (x + COURT.halfWidth + SIDE) * S;
const py = (z: number) => (z + TOP) * S;

const WHO: Record<SetterKey, string> = { OH: 'Outside', MB: 'Middle', OPP: 'Opposite', PIPE: 'Back row' };

function el<K extends keyof HTMLElementTagNameMap>(tag: K, cls = '', text = ''): HTMLElementTagNameMap[K] {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text) e.textContent = text;
  return e;
}

function svgEl<K extends keyof SVGElementTagNameMap>(tag: K, attrs: Record<string, string | number> = {}): SVGElementTagNameMap[K] {
  const e = document.createElementNS(SVG, tag);
  for (const [k, v] of Object.entries(attrs)) e.setAttribute(k, String(v));
  return e;
}

function button(cls: string, text = ''): HTMLButtonElement {
  const b = el('button', cls, text);
  b.type = 'button';
  return b;
}

function setOn(e: HTMLElement, on: boolean): void {
  e.classList.toggle('on', on);
  e.setAttribute('aria-pressed', String(on));
}

/**
 * Plays: make your own play and put it on the play wheel. Pick the place on the wheel it takes,
 * then pick one set for each hitter (the same sets their key steps through on court: each is a
 * run, a spot at the net and a tempo, all in one). The court shows every hitter's run for the
 * play as it stands. A set that would send two hitters to the same spot can't be picked. Name it
 * and save: it replaces the play in that place until you put the built-in one back.
 */
export function buildPlayDesigner(): HTMLElement {
  let slot = 0;
  let calls = callsOf(COMBOS[0]);
  const body = el('div', 'sheet-body plays-body');

  // ------------------------------------------------------------ the wheel's places
  const slots = el('div', 'pd-slots');
  slots.setAttribute('role', 'group');
  slots.setAttribute('aria-label', 'Place on the play wheel');
  slots.append(el('h2', 'eyebrow', 'On the wheel'));
  const slotBtns = COMBOS.map((_, i) => {
    const b = button('row pd-slot');
    b.onclick = () => load(i);
    slots.append(b);
    return b;
  });

  // ------------------------------------------------------------ the court: every hitter's run
  const mid = el('div', 'pd-mid');
  const W = (COURT.halfWidth + SIDE) * 2 * S;
  const H = (DEEP + TOP) * S;
  const court = svgEl('svg', { viewBox: `0 0 ${W} ${H}`, class: 'pd-court', role: 'img' });
  court.append(
    svgEl('rect', { x: px(-COURT.halfWidth), y: py(0), width: COURT.halfWidth * 2 * S, height: DEEP * S, class: 'pd-floor' }),
    svgEl('line', {
      x1: px(-COURT.halfWidth),
      y1: py(COURT.attackLine),
      x2: px(COURT.halfWidth),
      y2: py(COURT.attackLine),
      class: 'pd-line',
    }),
    svgEl('line', { x1: px(-COURT.halfWidth - 0.6), y1: py(0), x2: px(COURT.halfWidth + 0.6), y2: py(0), class: 'pd-net' }),
    svgEl('circle', { cx: px(SETTER_SPOT.x), cy: py(SETTER_SPOT.z), r: 9, class: 'pd-setter' }),
  );
  const you = svgEl('text', { x: px(SETTER_SPOT.x), y: py(SETTER_SPOT.z), class: 'pd-key' });
  you.textContent = 'S';
  court.append(you);
  const parts = new Map<SetterKey, { run: SVGPathElement; start: SVGCircleElement; hit: SVGCircleElement; key: SVGTextElement }>();
  SETTER_KEYS.forEach((k, i) => {
    const run = svgEl('path', { class: 'pd-run', stroke: callCss(k) });
    const start = svgEl('circle', { r: 6, class: 'pd-start', stroke: callCss(k) });
    const hit = svgEl('circle', { r: 12, fill: callCss(k) });
    const key = svgEl('text', { class: 'pd-key' });
    key.textContent = String(i + 1);
    court.append(run, start, hit, key);
    parts.set(k, { run, start, hit, key });
  });

  const save = el('div', 'pd-save');
  const name = el('input', 'pd-name');
  name.type = 'text';
  name.maxLength = PLAYBOOK.nameMax;
  name.setAttribute('aria-label', 'The name of your play');
  name.placeholder = 'Name your play';
  name.autocomplete = 'off';
  const saveBtn = button('play-btn');
  const reset = button('ghost-btn');
  save.append(name, saveBtn, reset);
  const status = el('p', 'pd-note');
  status.setAttribute('role', 'status');
  mid.append(court, save, status);

  // ------------------------------------------------------------ the hitters: one set each
  const hitters = el('div', 'pd-hitters');
  hitters.append(el('h2', 'eyebrow', 'One set for each hitter'));
  const cards = new Map<SetterKey, { set: HTMLElement; chips: HTMLButtonElement[]; note: HTMLElement }>();
  SETTER_KEYS.forEach((k, i) => {
    const card = el('section', 'pd-hitter');
    card.style.setProperty('--c', callCss(k));
    const head = el('div', 'pd-who');
    const set = el('span', 'pd-set');
    head.append(el('span', 'pd-dot'), el('span', '', `${i + 1} · ${WHO[k]}`), set);
    const group = el('div', 'chips');
    group.setAttribute('role', 'group');
    group.setAttribute('aria-label', `${WHO[k]}: their set`);
    const chips = SETTER_PLAYS[k].map((p) => {
      const b = button('chip', p.short);
      b.onclick = () => {
        calls[k] = p.short;
        status.textContent = '';
        draw();
      };
      group.append(b);
      return b;
    });
    const note = el('p', 'pd-note');
    card.append(head, group, note);
    hitters.append(card);
    cards.set(k, { set, chips, note });
  });

  // ------------------------------------------------------------ drawing
  const drawSlots = () => {
    const book = playbook();
    wheelPlays().forEach((c, i) => {
      const b = slotBtns[i];
      const main = el('span', 'row-main');
      main.append(el('span', 'row-t', c.name), el('span', 'row-s', SETTER_KEYS.map((k) => c.calls[k]).join(' · ')));
      b.replaceChildren(el('span', 'pd-num', String(i + 1)), main);
      if (book[i]) b.append(el('span', 'tag ready', 'Yours'));
      setOn(b, i === slot);
    });
  };

  function draw(): void {
    const said: string[] = [];
    for (const k of SETTER_KEYS) {
      const play = SETTER_PLAYS[k].find((p) => p.short === calls[k]) ?? SETTER_PLAYS[k][0];
      const { sx, sz, z } = play.lane;
      const x = hitX(play);
      const p = parts.get(k)!;
      // the run loops in: it leaves along the net and turns towards it (as the hitters run it)
      p.run.setAttribute('d', `M ${px(sx)} ${py(sz)} Q ${px(x + (sx - x) * 0.3)} ${py(z + (sz - z) * 0.7)} ${px(x)} ${py(z)}`);
      p.start.setAttribute('cx', String(px(sx)));
      p.start.setAttribute('cy', String(py(sz)));
      p.hit.setAttribute('cx', String(px(x)));
      p.hit.setAttribute('cy', String(py(z)));
      p.key.setAttribute('x', String(px(x)));
      p.key.setAttribute('y', String(py(z)));
      said.push(`${WHO[k]}: ${play.name}`);
      const c = cards.get(k)!;
      c.set.textContent = play.name;
      // a set that would put this hitter on another one's spot can't be picked
      const taken: string[] = [];
      SETTER_PLAYS[k].forEach((o, n) => {
        const by = o.short === calls[k] ? null : clashWith(calls, k, o.short);
        const b = c.chips[n];
        setOn(b, o.short === calls[k]);
        b.disabled = by !== null;
        b.title = by ? `The ${WHO[by].toLowerCase()} hits there` : o.name;
        b.setAttribute('aria-label', by ? `${o.name}: not now, the ${WHO[by].toLowerCase()} hits there` : o.name);
        if (by && !taken.includes(WHO[by].toLowerCase())) taken.push(WHO[by].toLowerCase());
      });
      c.note.textContent = taken.length ? `Greyed out: the ${taken.join(' or the ')} already hits there.` : '';
      c.note.hidden = !taken.length;
    }
    court.setAttribute('aria-label', `Your side of the court, the net at the top. ${said.join('. ')}.`);
    saveBtn.textContent = `SAVE TO ${slot + 1}`;
  }

  function load(i: number): void {
    slot = i;
    const saved = playbook()[i];
    calls = saved ? { ...saved.calls } : callsOf(COMBOS[i]);
    name.value = saved?.name ?? '';
    reset.textContent = `Put ${COMBOS[i].name} back`;
    reset.hidden = !saved;
    status.textContent = '';
    drawSlots();
    draw();
  }

  saveBtn.onclick = () => {
    const n = cleanName(name.value) || `My play ${slot + 1}`;
    if (!savePlay(slot, { name: n, calls })) return;
    load(slot);
    // (on a touch screen the wheel is the PLAY chip)
    const wheel = document.body.classList.contains('touchmode') ? 'tap PLAY' : 'hold C';
    status.textContent = `Saved. ${n} is play ${slot + 1} on the wheel: ${wheel} when you set.`;
  };
  // Enter in the name saves it
  name.addEventListener('keydown', (e) => {
    if (e.key !== 'Enter') return;
    e.preventDefault();
    saveBtn.click();
  });
  reset.onclick = () => {
    savePlay(slot, null);
    load(slot);
    status.textContent = `${COMBOS[slot].name} is back on the wheel.`;
  };

  body.append(slots, mid, hitters);
  load(0);
  return body;
}
