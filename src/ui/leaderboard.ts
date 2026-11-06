import { POSITIONS, RANKED, type PositionId } from '../config';
import { boardId, MEDAL_NAMES, medalFor, seasonBoards, weekOf, weeklyBoard, type RankedMode } from '../game/boards';
import { MODE_INFO } from '../game/modes/mode';
import type { BoardRow, BoardView, MedalView } from '../net/protocol';
import { formatPoints } from './hud';

export interface LeaderboardCallbacks {
  close(): void;
  fetchBoard(board: string): Promise<BoardView | null>;
  fetchMedals(): Promise<MedalView | null>;
  /** finished runs on this device the leaderboard doesn't have yet */
  pending(): number;
  /** send them now (one at a time, oldest first) */
  sendPending(): Promise<{ sent: number; left: number }>;
  /** your name now (null: none yet) */
  name(): string | null;
  /** change your name: the new name, or null if it isn't a valid one */
  rename(name: string): string | null;
}

type Tab = 'season' | 'weekly' | 'medals';

function el<K extends keyof HTMLElementTagNameMap>(tag: K, cls: string, text = ''): HTMLElementTagNameMap[K] {
  const e = document.createElement(tag);
  e.className = cls;
  if (text) e.textContent = text;
  return e;
}

/**
 * The online boards: a season board per position, this week's featured board and the medal table.
 * Your own line is marked; when you are outside the top, the players just above you are shown too.
 */
export class LeaderboardScreen {
  readonly root: HTMLDivElement;
  private box: HTMLDivElement;
  private tab: Tab = 'season';
  private board: { mode: RankedMode; pos: PositionId } = seasonBoards()[0];
  /** the latest request: an older answer arriving late is dropped */
  private request = 0;

  constructor(
    parent: HTMLElement,
    private cb: LeaderboardCallbacks,
  ) {
    this.root = el('div', 'pause boards');
    this.root.setAttribute('role', 'dialog');
    this.root.setAttribute('aria-label', 'Leaderboard');
    this.box = el('div', 'pause-box boards-box');
    this.root.append(this.box);
    parent.append(this.root);
    window.addEventListener('keydown', (e) => {
      if (!this.visible || e.code !== 'Escape' || e.target instanceof HTMLInputElement) return;
      e.stopImmediatePropagation();
      this.cb.close();
    });
  }

  get visible(): boolean {
    return this.root.style.display === 'flex';
  }

  /** open on a tab and board (a season board of the drill and position, if it has one) */
  show(opts: { tab?: Tab; mode?: string; pos?: PositionId } = {}): void {
    this.tab = opts.tab ?? 'season';
    const b = seasonBoards().find((s) => s.mode === opts.mode && s.pos === opts.pos) ?? seasonBoards().find((s) => s.pos === opts.pos);
    if (b) this.board = b;
    this.root.style.display = 'flex';
    this.render();
  }

  hide(): void {
    this.root.style.display = 'none';
  }

  private render(): void {
    const b = this.box;
    b.innerHTML = '';
    const top = el('div', 'boards-top');
    top.append(el('div', 'pause-t', 'Leaderboard'));
    const close = el('button', 'ghost-btn', 'Close');
    close.onclick = () => this.cb.close();
    top.append(close);
    b.append(top);

    const tabs = el('div', 'boards-tabs');
    tabs.setAttribute('role', 'tablist');
    for (const [t, label] of [
      ['season', 'Season'],
      ['weekly', 'This week'],
      ['medals', 'Medal table'],
    ] as [Tab, string][]) {
      const c = el('button', 'chip', label);
      c.setAttribute('role', 'tab');
      c.setAttribute('aria-selected', String(t === this.tab));
      c.classList.toggle('on', t === this.tab);
      c.onclick = () => {
        this.tab = t;
        this.render();
      };
      tabs.append(c);
    }
    b.append(tabs);

    const body = el('div', 'boards-body');
    if (this.tab === 'season') {
      const picker = el('div', 'boards-pos');
      for (const s of seasonBoards()) {
        const c = el('button', 'chip', s.pos);
        c.title = POSITIONS[s.pos].name;
        c.classList.toggle('on', s.mode === this.board.mode && s.pos === this.board.pos);
        c.onclick = () => {
          this.board = s;
          this.render();
        };
        picker.append(c);
      }
      b.append(picker);
      this.loadBoard(body, this.board.mode, this.board.pos, null);
    } else if (this.tab === 'weekly') {
      const week = weekOf(Date.now());
      const wb = weeklyBoard(week);
      this.loadBoard(body, wb.mode, wb.pos, week.id);
    } else this.loadMedals(body);
    b.append(body);
    const waiting = this.pendingLine();
    if (waiting) b.append(waiting);
    b.append(this.nameLine());
    this.root.querySelector<HTMLButtonElement>('.boards-tabs .on')?.focus();
  }

  private caption(mode: RankedMode, pos: PositionId, week: string | null, count: number | null): HTMLElement {
    const c = el('div', 'boards-caption');
    const players = count === null ? '' : ` · ${count} ${count === 1 ? 'player' : 'players'}`;
    c.append(el('b', '', `${MODE_INFO[mode].title} · ${POSITIONS[pos].name}`), `${week ? ` · week ${week.slice(-2)}` : ''}${players}`);
    const [bronze, silver, gold] = RANKED.medals[pos];
    const coach = RANKED.coach[pos];
    const medals = el('div', 'boards-medals');
    for (const [m, at] of [['bronze', bronze], ['silver', silver], ['gold', gold], ...(coach !== undefined ? [['coach', coach]] : [])] as [
      keyof typeof MEDAL_NAMES,
      number,
    ][])
      medals.append(el('span', `m-${m}`, `${MEDAL_NAMES[m]} ${formatPoints(at)}`));
    c.append(medals);
    return c;
  }

  private loadBoard(body: HTMLElement, mode: RankedMode, pos: PositionId, week: string | null): void {
    const req = ++this.request;
    body.append(this.caption(mode, pos, week, null), el('div', 'boards-note', 'Loading…'));
    void this.cb.fetchBoard(boardId(mode, pos, week)).then((v) => {
      if (req !== this.request || !this.visible) return;
      body.innerHTML = '';
      body.append(this.caption(mode, pos, week, v ? v.count : null));
      if (!v) {
        body.append(el('div', 'boards-note', "The online leaderboard can't be reached right now. Your bests are kept on this device."));
        return;
      }
      if (!v.top.length) {
        body.append(el('div', 'boards-note', 'No runs on this board yet: the first one takes the top spot.'));
        return;
      }
      const table = el('div', 'boards-table');
      table.setAttribute('role', 'table');
      table.append(this.headRow(['#', 'Name', 'Score', 'Medal', 'Perfect']));
      for (const r of v.top) table.append(this.boardRow(r, pos));
      // outside the top (or in it, but newer than the cached list): your line, and the players just above you
      if (v.me && !v.top.some((r) => r.you)) {
        table.append(el('div', 'boards-gap', '···'));
        for (const r of [...v.above, v.me]) table.append(this.boardRow(r, pos));
      }
      body.append(table);
      if (!v.me) body.append(el('div', 'boards-note', 'Play a ranked run to get on this board.'));
    });
  }

  private loadMedals(body: HTMLElement): void {
    const req = ++this.request;
    const caption = el('div', 'boards-caption');
    caption.append(el('b', '', 'Medal table'), ` · every season board (${seasonBoards().length}), most golds first`);
    const you = this.cb.name();
    body.append(caption, el('div', 'boards-note', 'Loading…'));
    void this.cb.fetchMedals().then((v) => {
      if (req !== this.request || !this.visible) return;
      body.innerHTML = '';
      body.append(caption);
      if (!v) {
        body.append(el('div', 'boards-note', "The online leaderboard can't be reached right now."));
        return;
      }
      if (!v.rows.length) {
        body.append(el('div', 'boards-note', 'No medals won yet.'));
        return;
      }
      const coach = v.rows.some((r) => r.coach > 0);
      const table = el('div', 'boards-table medals' + (coach ? ' with-coach' : ''));
      table.setAttribute('role', 'table');
      table.append(this.headRow(['#', 'Name', ...(coach ? ['Coach'] : []), 'Gold', 'Silver', 'Bronze']));
      for (const r of v.rows) {
        // the table is the same for everyone (cached): your line is found by your name
        const row = el('div', 'boards-row' + (you && r.name === you ? ' you' : ''));
        row.setAttribute('role', 'row');
        row.append(el('span', 'b-rank', String(r.rank)), el('span', 'b-name', r.name));
        if (coach) row.append(el('span', 'b-num m-coach', String(r.coach)));
        row.append(
          el('span', 'b-num m-gold', String(r.gold)),
          el('span', 'b-num m-silver', String(r.silver)),
          el('span', 'b-num m-bronze', String(r.bronze)),
        );
        table.append(row);
      }
      body.append(table);
      body.append(el('div', 'boards-note small', `Counts the top ${formatPoints(v.depth)} runs of each board.`));
    });
  }

  /** runs finished on this device that the leaderboard doesn't have yet, and a way to send them */
  private pendingLine(): HTMLElement | null {
    const n = this.cb.pending();
    if (!n) return null;
    const line = el('div', 'boards-pending');
    line.append(`${n} ${n === 1 ? 'run' : 'runs'} from this device ${n === 1 ? "isn't" : "aren't"} on the board yet. `);
    const send = el('button', 'link-btn', 'Send now');
    send.onclick = async () => {
      send.disabled = true;
      send.textContent = 'Sending…';
      const r = await this.cb.sendPending();
      if (this.visible) this.render();
      if (r.left && this.visible)
        this.box.querySelector('.boards-pending')?.append(' (the leaderboard is busy or offline: try again in a minute)');
    };
    line.append(send);
    return line;
  }

  private headRow(cols: string[]): HTMLElement {
    const h = el('div', 'boards-row boards-head');
    h.setAttribute('role', 'row');
    for (const c of cols) h.append(el('span', '', c));
    return h;
  }

  private boardRow(r: BoardRow, pos: PositionId): HTMLElement {
    const row = el('div', 'boards-row' + (r.you ? ' you' : ''));
    row.setAttribute('role', 'row');
    const medal = medalFor(r.total, pos);
    row.append(
      el('span', 'b-rank', String(r.rank)),
      el('span', 'b-name', r.you ? `${r.name} (you)` : r.name),
      el('span', 'b-score', formatPoints(r.total)),
      el('span', 'b-medal' + (medal ? ` m-${medal}` : ''), medal ? MEDAL_NAMES[medal] : '–'),
      el('span', 'b-num', String(r.perfects)),
    );
    return row;
  }

  /** your name on the boards, and a way to change it */
  private nameLine(): HTMLElement {
    const line = el('div', 'boards-name');
    const name = this.cb.name();
    line.append(name ? `You play as ${name}. ` : 'You pick a name when you put your first run on the board. ');
    if (!name) return line;
    const change = el('button', 'link-btn', 'Change name');
    change.onclick = () => {
      line.innerHTML = '';
      const form = el('form', 'res-name');
      const input = el('input', '');
      input.maxLength = 16;
      input.value = name;
      input.setAttribute('aria-label', 'Your name on the leaderboard');
      const save = el('button', 'ghost-btn', 'Save');
      save.type = 'submit';
      form.onsubmit = (e) => {
        e.preventDefault();
        if (this.cb.rename(input.value)) this.render();
        else input.setCustomValidity('2 to 16 letters, digits, spaces, dots or dashes');
        input.reportValidity();
      };
      input.oninput = () => input.setCustomValidity('');
      form.append(input, save);
      line.append(form);
      input.focus();
      input.select();
    };
    line.append(change, ' Your new name shows on the boards from your next run.');
    return line;
  }
}
