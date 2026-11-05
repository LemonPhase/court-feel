import { POSITIONS } from '../config';
import { MEDAL_NAMES, medalFor, nextMedal } from '../game/boards';
import { MODE_INFO } from '../game/modes/mode';
import type { RankedRun } from '../game/ranked';
import type { SubmitResult } from '../net/protocol';
import { formatPoints } from './hud';

export interface ResultsCallbacks {
  /** another ranked run on the same board */
  again(): void;
  /** the same drill in practice */
  practice(): void;
  menu(): void;
  leaderboard(): void;
  /** your name, typed the first time you put a run on the leaderboard */
  submitName(name: string): void;
  /** the run as text for a group chat */
  shareText(): string;
}

/** where the run stands with the online leaderboard */
export type OnlineState =
  | { kind: 'name'; error?: string }
  | { kind: 'sending' }
  | { kind: 'done'; result: SubmitResult }
  | { kind: 'offline' }
  | { kind: 'skipped'; why: string };

function el<K extends keyof HTMLElementTagNameMap>(tag: K, cls: string, text = ''): HTMLElementTagNameMap[K] {
  const e = document.createElement(tag);
  e.className = cls;
  if (text) e.textContent = text;
  return e;
}

/** CSS class of a rep's timing grade (the same colours as the HUD grades) */
const GRADE_CLASS: Record<string, string> = { Perfect: 'g-perfect', Good: 'g-good', Early: 'g-early', Late: 'g-late', Miss: 'g-miss' };

/** copy text, with the old select-and-copy for browsers without the clipboard API (or without permission) */
async function copy(text: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    const t = el('textarea', 'res-copy');
    t.value = text;
    document.body.append(t);
    t.select();
    let ok = false;
    try {
      ok = document.execCommand('copy');
    } catch {
      /* not allowed */
    }
    t.remove();
    return ok;
  }
}

/**
 * End of a ranked run: the total and medal, your best, where you stand on the online board, every
 * rep, and the way back in (R or Enter runs again).
 */
export class ResultsScreen {
  readonly root: HTMLDivElement;
  private box: HTMLDivElement;
  private online: HTMLDivElement | null = null;
  private againBtn: HTMLButtonElement | null = null;

  constructor(
    parent: HTMLElement,
    private cb: ResultsCallbacks,
  ) {
    this.root = el('div', 'pause results');
    this.root.setAttribute('role', 'dialog');
    this.root.setAttribute('aria-label', 'Ranked run results');
    this.box = el('div', 'pause-box results-box');
    this.root.append(this.box);
    parent.append(this.root);
    // R: straight into the next run (not while typing a name)
    window.addEventListener('keydown', (e) => {
      if (!this.visible || e.repeat || e.code !== 'KeyR') return;
      if (e.target instanceof HTMLInputElement) return;
      e.preventDefault();
      this.cb.again();
    });
  }

  get visible(): boolean {
    return this.root.style.display === 'flex';
  }

  show(run: RankedRun): void {
    const b = this.box;
    b.innerHTML = '';
    const where = run.week ? `This week (${run.week})` : 'Season';
    b.append(el('div', 'res-kicker' + (run.unranked ? ' unranked' : ''), run.unranked ? 'Unranked run' : `Ranked run · ${where}`));
    b.append(el('div', 'res-board', `${MODE_INFO[run.mode].title} · ${POSITIONS[run.pos].name}`));
    const total = el('div', 'res-total');
    total.append(formatPoints(run.total), el('span', '', ' pts'));
    const medal = medalFor(run.total, run.pos);
    if (medal) total.append(el('span', `res-medal m-${medal}`, MEDAL_NAMES[medal]));
    b.append(total);
    const next = nextMedal(run.total, run.pos);
    if (next)
      b.append(
        el('div', 'res-next', `${MEDAL_NAMES[next.medal]} at ${formatPoints(next.at)} · ${formatPoints(next.at - run.total)} to go`),
      );
    if (run.newBest)
      b.append(el('div', 'res-best new', run.best ? `New personal best · was ${formatPoints(run.best.total)}` : 'New personal best'));
    else if (run.best) {
      const d = run.total - run.best.total;
      const line = el('div', 'res-best', `Your best ${formatPoints(run.best.total)} · `);
      line.append(el('span', d < 0 ? 'down' : '', d < 0 ? `−${formatPoints(-d)}` : d > 0 ? `+${formatPoints(d)}` : '±0'));
      b.append(line);
    }
    b.append(el('div', 'res-stats', `Perfect contacts ${run.perfects} · best streak ${run.bestStreak} · ${run.length} reps`));
    if (run.unranked) b.append(el('div', 'res-note', "A locked setting changed during this run, so it doesn't count."));
    this.online = el('div', 'res-online');
    b.append(this.online);

    const table = el('div', 'res-reps');
    table.setAttribute('role', 'table');
    const head = el('div', 'res-row res-head');
    head.setAttribute('role', 'row');
    for (const c of ['#', 'Result', 'Timing', 'km/h', 'Pts']) head.append(el('span', '', c));
    table.append(head);
    run.reps.forEach((r, i) => {
      const row = el('div', 'res-row' + (r.skipped ? ' skipped' : ''));
      row.setAttribute('role', 'row');
      row.append(
        el('span', 'res-n', String(i + 1)),
        el('span', 'res-label', r.label),
        el('span', 'res-grade ' + (r.grade ? GRADE_CLASS[r.grade] : ''), r.grade ?? '–'),
        el('span', 'res-kmh', r.kmh !== null ? r.kmh.toFixed(0) : '–'),
        el('span', 'res-pts', r.points > 0 ? `+${r.points}` : '0'),
      );
      table.append(row);
    });
    b.append(table);

    const btns = el('div', 'res-btns');
    const again = el('button', 'play-btn', 'RUN AGAIN');
    again.title = 'R';
    again.onclick = () => this.cb.again();
    this.againBtn = again;
    const share = el('button', 'ghost-btn', 'Share');
    share.onclick = async () => {
      share.textContent = (await copy(this.cb.shareText())) ? 'Copied' : "Couldn't copy";
      window.setTimeout(() => (share.textContent = 'Share'), 1800);
    };
    const boards = el('button', 'ghost-btn', 'Leaderboard');
    boards.onclick = () => this.cb.leaderboard();
    const practice = el('button', 'ghost-btn', 'Practise');
    practice.onclick = () => this.cb.practice();
    const menu = el('button', 'ghost-btn', 'Menu');
    menu.onclick = () => this.cb.menu();
    btns.append(again, share, boards, practice, menu);
    b.append(btns);
    b.append(el('div', 'res-keys', 'R run again'));

    this.root.style.display = 'flex';
    again.focus();
  }

  /** where the run stands with the online leaderboard */
  setOnline(s: OnlineState): void {
    const o = this.online;
    if (!o) return;
    o.innerHTML = '';
    o.className = `res-online s-${s.kind}`;
    if (s.kind === 'name') {
      const form = el('form', 'res-name');
      const input = el('input', '');
      input.maxLength = 16;
      input.placeholder = 'Your name';
      input.setAttribute('aria-label', 'Your name on the leaderboard');
      input.setAttribute('autocomplete', 'nickname');
      const go = el('button', 'ghost-btn ranked-btn', 'Put it on the board');
      go.type = 'submit';
      form.onsubmit = (e) => {
        e.preventDefault();
        this.cb.submitName(input.value);
      };
      form.append(input, go);
      o.append(el('div', 'res-online-h', s.error ?? 'Your name on the leaderboard (2 to 16 letters or digits)'), form);
      input.focus();
      return;
    }
    if (s.kind === 'sending') o.textContent = 'Putting your run on the board…';
    else if (s.kind === 'offline') o.textContent = 'Online leaderboard unavailable: your best is kept on this device.';
    else if (s.kind === 'skipped') o.textContent = s.why;
    else {
      const { me, count, next, saved } = s.result;
      const line = el('div', 'res-rank');
      line.append(el('b', '', `#${me.rank}`), ` of ${count} on the board`);
      if (!saved) line.append(' · your best there stands');
      o.append(line);
      if (next) {
        const gap = next.total - me.total;
        o.append(
          el('div', 'res-rival', `Next up: ${next.name} ${formatPoints(next.total)} (${gap > 0 ? `+${formatPoints(gap)}` : 'level'})`),
        );
      } else o.append(el('div', 'res-rival top', 'Top of the board'));
    }
    this.againBtn?.focus();
  }

  hide(): void {
    this.root.style.display = 'none';
  }
}
