import { SET_PLAYS, type SetPlay } from './plays';

/** the hitters a setter can pick, in key order: 1 outside, 2 middle, 3 opposite, 4 pipe */
export type SetterKey = 'OH' | 'MB' | 'OPP' | 'PIPE';
export const SETTER_KEYS: readonly SetterKey[] = ['OH', 'MB', 'OPP', 'PIPE'];
type CallKey = 'OH' | 'MB' | 'OPP';

/**
 * The user setter's picks and calls (keys, through Input like every other control).
 * - 1-4 pick the hitter you set; no pick, the set goes to the hitter you look at. Pressing the
 *   picked one again asks them for a high ball instead of their call (again: back to the call).
 * - C opens the call sheet (2K's play calls, opt-in): while it is open, 1-3 step through that
 *   hitter's calls (the same SET_PLAYS hitters call for themselves). Leave it alone and every
 *   call stays as it is. Tempo is agreed before the pass because the hitter's run depends on it:
 *   once the pass is played the sheet locks (and closes).
 */
export class SetterCalls {
  pick: SetterKey | null = null;
  /** the pass is on its way: tempos are locked */
  locked = false;
  /** the call sheet is open: 1-3 change calls instead of picking */
  editing = false;
  private call: Record<CallKey, number> = { OH: 0, MB: 0, OPP: 0 };
  private high = new Set<SetterKey>();

  press(k: SetterKey): void {
    if (this.editing) {
      if (!this.locked && k !== 'PIPE') this.call[k] = (this.call[k] + 1) % (SET_PLAYS[k]?.length ?? 1);
      return;
    }
    if (this.pick !== k) {
      this.pick = k;
      return;
    }
    if (this.high.has(k)) this.high.delete(k);
    else this.high.add(k);
  }

  /** open or close the call sheet (not once the pass is played) */
  toggleSheet(): void {
    this.editing = !this.editing && !this.locked;
  }

  /** keys pressed since the last step: C the call sheet, Digit1 outside ... Digit4 pipe */
  readKeys(input: { consumePress(code: string): boolean }): void {
    if (input.consumePress('KeyC')) this.toggleSheet();
    SETTER_KEYS.forEach((k, i) => {
      if (input.consumePress('Digit' + (i + 1))) this.press(k);
    });
  }

  /** the pass is played: lock the tempos */
  lock(): void {
    this.locked = true;
    this.editing = false;
  }

  /** after the set (or a new rep): a fresh pick, unlocked; the calls stay until you change them */
  nextBall(): void {
    this.pick = null;
    this.locked = false;
    this.high.clear();
  }

  /** the call a hitter runs */
  play(k: CallKey): SetPlay {
    const plays = SET_PLAYS[k]!;
    return plays[this.call[k] % plays.length];
  }

  /** asked for a high ball */
  isHigh(k: SetterKey): boolean {
    return this.high.has(k);
  }

  /** the call as shown on screen: "Go", "1", "Back", "Pipe" (or "High" when asked for one) */
  label(k: SetterKey): string {
    if (this.high.has(k)) return 'High';
    return k === 'PIPE' ? 'Pipe' : this.play(k).short;
  }
}
