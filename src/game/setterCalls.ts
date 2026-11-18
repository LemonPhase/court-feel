import { PLAYBOOK } from '../config';
import { COMBOS, type Combo } from './combos';
import { D_PLAY, isQuick, LANES, needsGoodPass, SETTER_PLAYS, SETTER_TARGET, type AttackLane, type SetPlay } from './plays';

/** the hitters a setter can pick, in key order: 1 outside, 2 middle, 3 opposite, 4 pipe */
export type SetterKey = 'OH' | 'MB' | 'OPP' | 'PIPE';
export const SETTER_KEYS: readonly SetterKey[] = ['OH', 'MB', 'OPP', 'PIPE'];

/** what the setter can send the ball to: a hitter, or (key 5, front row only) over the net: the dump */
export type SetPick = SetterKey | 'DUMP';
export const SET_PICKS: readonly SetPick[] = [...SETTER_KEYS, 'DUMP'];

/** with no key pressed the set goes to the outside: the ball every setter gives when nothing else is on */
export const DEFAULT_PICK: SetterKey = 'OH';

/** the hitters who meet the ball at the net (the pipe is hit 2 m off it, behind them) */
const FRONT: readonly SetterKey[] = ['OH', 'MB', 'OPP'];

/** where along the net a set is hit (a quick: `inFront` of where the setter takes the pass) */
export function hitX(play: SetPlay): number {
  return play.inFront !== undefined ? SETTER_TARGET.x - play.inFront : play.lane.x;
}

/**
 * Would `k` hitting `short` end up on the same spot as another front-row hitter in `calls`
 * (within PLAYBOOK.minGap m along the net)? Returns that hitter, or null when there is room.
 */
export function clashWith(calls: Record<SetterKey, string>, k: SetterKey, short: string): SetterKey | null {
  const mine = SETTER_PLAYS[k].find((p) => p.short === short);
  if (!mine || !FRONT.includes(k)) return null;
  for (const o of FRONT) {
    const theirs = o === k ? undefined : SETTER_PLAYS[o].find((p) => p.short === calls[o]);
    if (theirs && Math.abs(hitX(mine) - hitX(theirs)) < PLAYBOOK.minGap) return o;
  }
  return null;
}

/** do two hitters in these calls hit from the same spot? */
export function clashes(calls: Record<SetterKey, string>): boolean {
  return FRONT.some((k) => clashWith(calls, k, calls[k]) !== null);
}

/**
 * The user setter's picks and calls (keys, through Input like every other control).
 * - 1-4 pick the hitter you set; no key, it is the outside (never where you look: a setter
 *   watches the ball).
 * - Pressing the picked hitter again steps to their next set. Before the pass that is their next
 *   call (SETTER_PLAYS): tempo is agreed before the pass because the hitter's run depends on it.
 *   A call that would put two front-row hitters on one spot at the net is skipped (`clashWith`,
 *   as in the play designer): they would run into each other.
 *   A whole combination is called at once on the play wheel (`setCombo`).
 * - Once the pass is played the calls are locked. In system, the only late change a hitter can
 *   still take is a higher ball: the key again asks for a high ball (again: back to the call).
 *   A hitter already on a fast run can't stop for one (`canHold`), and a quick has no high ball.
 * - Out of system (`oos`) it is the other way round: everything goes up high, and the key again
 *   asks that hitter for their fast set all the same (a middle has no high ball, so picking
 *   them is the ask). They have to hear it in time (`canAsk`), and once they run it stays asked.
 * - Front row (`frontRow`): the opposite is in the back row and hits the D, and 5 picks the
 *   dump (again: short or deep). A back-row setter may not attack the ball above the net.
 */
export class SetterCalls {
  pick: SetPick | null = null;
  /** the pass is on its way: tempos are locked */
  locked = false;
  /** the hitters run your calls (false for a backup's set: every ball goes up high, the keys only pick) */
  canCall = true;
  /** this ball's pass is out of system: high balls, unless you ask a hitter for their fast set */
  oos = false;
  /** the setter is front row: the opposite hits the D from the back row, and the dump is on */
  frontRow = false;
  /** the dump goes deep (the far corner) instead of short behind the block */
  dumpDeep = false;
  /** out of system: can this hitter still make their fast run if asked now? (the mode knows the clock; null: always) */
  canAsk: ((k: SetterKey) => boolean) | null = null;
  /** a hitter was asked for their fast set after the pass (the mode starts their run) */
  onAsk: ((k: SetterKey) => void) | null = null;
  /**
   * In system, after the pass: can this hitter still wait for a high ball instead of their fast
   * call? Only if they have not started the run (the mode holds them; null: always).
   */
  canHold: ((k: SetterKey) => boolean) | null = null;
  private call: Record<SetterKey, number> = { OH: 0, MB: 0, OPP: 0, PIPE: 0 };
  private high = new Set<SetterKey>();
  private fast = new Set<SetterKey>();
  private late: SetterKey | null = null;
  /** every call this hitter has (front row: the opposite only has the D) */
  plays(k: SetterKey): readonly SetPlay[] {
    return k === 'OPP' && this.frontRow ? [D_PLAY] : SETTER_PLAYS[k];
  }

  press(k: SetPick): void {
    if (k === 'DUMP') {
      if (!this.frontRow) return;
      if (this.pick === 'DUMP') this.dumpDeep = !this.dumpDeep;
      this.pick = 'DUMP';
      return;
    }
    const again = this.pick === k;
    this.pick = k;
    if (this.locked && this.oos && this.canCall) {
      // out of system: the key again asks for the fast set (the middle: picking them is the ask)
      if ((!again && k !== 'MB') || k === 'PIPE' || this.fast.has(k) || !this.fastPlay(k)) return;
      if (this.canAsk && !this.canAsk(k)) {
        this.late = k;
        return;
      }
      this.fast.add(k);
      this.onAsk?.(k);
      return;
    }
    if (!again) return;
    const n = this.plays(k).length;
    if (!this.locked && this.canCall && n > 1) {
      // their next call that leaves every front-row hitter their own spot
      const now = {} as Record<SetterKey, string>;
      for (const o of SETTER_KEYS) now[o] = this.play(o).short;
      const plays = this.plays(k);
      for (let i = 1; i < n; i++) {
        const j = (this.call[k] + i) % n;
        if (clashWith(now, k, plays[j].short)) continue;
        this.call[k] = j;
        return;
      }
      return;
    }
    // a high ball instead of their call (again: back to the call)
    const p = this.play(k);
    const running = this.locked && this.canCall && needsGoodPass(p);
    if (this.high.has(k)) {
      // back to a fast call: they have to make the run from here
      if (running && this.canAsk && !this.canAsk(k)) {
        this.late = k;
        return;
      }
      this.high.delete(k);
      if (running) this.onAsk?.(k);
      return;
    }
    // a quick has no high ball; a hitter already on a fast run can't stop for one
    if (running && (isQuick(p) || (this.canHold && !this.canHold(k)))) {
      if (!isQuick(p)) this.late = k;
      return;
    }
    this.high.add(k);
  }

  /** keys pressed since the last step: Digit1 outside ... Digit4 pipe, Digit5 the dump */
  readKeys(input: { consumePress(code: string): boolean }): void {
    SET_PICKS.forEach((k, i) => {
      if (input.consumePress('Digit' + (i + 1))) this.press(k);
    });
  }

  /** the pass is played: lock the tempos; `oos` it is out of system */
  lock(oos = false): void {
    this.locked = true;
    this.oos = oos;
  }

  /**
   * After the set (or a new rep): unlocked, in system, nothing asked. The calls stay until you
   * change them; the pick goes back to the outside unless you keep it (Settings: Keep my pick).
   */
  nextBall(keepPick = false): void {
    if (!keepPick) {
      this.pick = null;
      this.dumpDeep = false;
    }
    this.locked = false;
    this.oos = false;
    this.high.clear();
    this.fast.clear();
    this.late = null;
  }

  /**
   * A touch in a rally (Mini Rally). Your set ends your ball: a fresh one. Our first touch is the
   * pass: the calls lock (returns true, and the mode starts the hitters' runs). Once they play the
   * ball the next pass is a new ball, also when a team-mate set this one (the libero, your help
   * key), so last ball's asks don't carry over and the wheel opens again.
   */
  touched(t: { mine: boolean; kind: string; ours: boolean }, ourTouches: number, keepPick = false): boolean {
    if (t.mine && t.kind === 'set') this.nextBall(keepPick);
    else if (t.ours && ourTouches === 1) {
      this.lock();
      return true;
    } else if (!t.ours && this.locked) this.nextBall(keepPick);
    return false;
  }

  /** the hitter (or the dump) the set goes to: your pick, else the outside */
  target(): SetPick {
    return this.pick === 'DUMP' && !this.frontRow ? DEFAULT_PICK : (this.pick ?? DEFAULT_PICK);
  }

  /** out of system: the fast set this hitter can be asked for (their call if it is one, else their first fast one) */
  fastPlay(k: SetterKey): SetPlay | null {
    const plays = this.plays(k);
    const called = plays[this.call[k] % plays.length];
    return needsGoodPass(called) ? called : (plays.find(needsGoodPass) ?? null);
  }

  /** out of system: this hitter was asked for their fast set and is running it */
  asksFast(k: SetterKey): boolean {
    return this.oos && this.fast.has(k);
  }

  /**
   * A hitter could not make their fast run (still at the net after a block): they wait for a
   * high ball, whatever was called or asked.
   */
  forceHigh(k: SetterKey): void {
    this.high.add(k);
    this.fast.delete(k);
  }

  /** a hitter asked too late for their fast set (once: for the message) */
  takeLate(): SetterKey | null {
    const k = this.late;
    this.late = null;
    return k;
  }

  /** the call a hitter runs (out of system and asked: their fast set) */
  play(k: SetterKey): SetPlay {
    if (this.asksFast(k)) return this.fastPlay(k)!;
    const plays = this.plays(k);
    return plays[this.call[k] % plays.length];
  }

  /** where a hitter's high ball goes (out of system, or asked for one) */
  highLane(k: SetterKey): AttackLane {
    if (k === 'PIPE') return LANES.L;
    return k === 'OPP' && this.frontRow ? D_PLAY.lane : LANES[k];
  }

  /** which of a hitter's calls is on, and how many they have */
  step(k: SetterKey): { i: number; n: number } {
    const n = this.plays(k).length;
    return { i: this.call[k] % n, n };
  }

  /** this hitter gets a high ball: asked for one, or out of system and not asked for the fast set */
  isHigh(k: SetterKey): boolean {
    return this.oos ? !this.fast.has(k) : this.high.has(k);
  }

  /** the call as shown on screen: "Go", "1", "Back", "Pipe" (or "High") */
  label(k: SetterKey): string {
    if (k === 'MB' && this.oos) return this.play(k).short;
    return this.isHigh(k) ? 'High' : this.play(k).short;
  }

  /** call a whole combination (the play wheel). Not once the pass is played, and not for a backup. */
  setCombo(c: Combo): boolean {
    if (this.locked || !this.canCall) return false;
    for (const k of SETTER_KEYS) {
      const i = this.plays(k).findIndex((p) => p.short === c.calls[k]);
      if (i >= 0) this.call[k] = i;
    }
    return true;
  }

  /** the play (of `plays`: the wheel's) the calls make right now, if they are one */
  combo(plays: readonly Combo[] = COMBOS): Combo | null {
    return (
      plays.find((c) => SETTER_KEYS.every((k) => this.plays(k).length === 1 || this.plays(k)[this.step(k).i].short === c.calls[k])) ?? null
    );
  }
}
