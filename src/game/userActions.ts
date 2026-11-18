import { SERVE } from '../config';
import { clamp01 } from '../core/mathx';
import { tossFor } from './contact';
import type { Game } from './game';

/**
 * Binds the user's buttons to athlete actions. Everything starts on the
 * frame the button is pressed (the UserController buffers presses that are
 * not possible yet).
 */
export class UserActions {
  constructor(private g: Game) {
    const u = g.user;
    // the lesson's together rep reads jump and attack as held buttons (a button already down
    // when its moment comes counts), so their edges do nothing there
    u.handlers.jump = () => {
      if (this.g.tutorial.ownsButtons()) return true;
      return this.g.me.jumpPress();
    };
    u.releaseHandlers.jump = () => {
      if (this.g.tutorial.ownsButtons()) return;
      this.g.me.jumpRelease();
    };
    u.handlers.attack = () => (this.g.tutorial.ownsButtons() ? true : this.attack());
    // release the wind-up: the swing goes now (tap = tip, longer hold = more power)
    u.releaseHandlers.attack = () => {
      const g = this.g;
      if (g.tutorial.ownsButtons()) return;
      const swing = g.contact.releaseWindup(g.me);
      if (swing) g.notePress(swing.err, swing.contactT);
    };
    u.handlers.block = () => (this.g.tutorial.quiet() ? true : this.rightButton());
    u.releaseHandlers.block = () => {
      const act = this.g.me.action;
      if (act && (act.kind === 'block' || act.kind === 'set') && act.held) {
        act.held = false;
        // the set's push is timed to the frame you saw (the bar fills in slow-mo)
        act.releaseT = act.kind === 'set' ? this.g.inputTime() : this.g.simTime;
      }
    };
    u.handlers.pass = () => (this.g.tutorial.quiet() ? true : this.pass());
    u.releaseHandlers.pass = () => {
      const act = this.g.me.action;
      if (act && act.kind === 'pass' && act.held) {
        act.held = false;
        act.releaseT = this.g.simTime;
      }
    };
    // the toss button is held: the longer, the higher the toss (`SERVE.hold`), tossed on the release
    u.handlers.toss = () => this.beginToss();
    u.releaseHandlers.toss = () => this.toss();
  }

  /** attack button down: start the wind-up (from the plant, in the air, or under a serve toss) */
  private attack(): boolean {
    const g = this.g;
    const me = g.me;
    const act = me.action;
    // already mid-swing: buffer the press
    if (act && act.kind === 'swing' && !act.resolved) return false;
    if (act && act.kind === 'swing' && g.simTime - act.contactT < 0.25) return false;
    if (act && act.kind === 'windup') return true;
    g.contact.beginWindup(me);
    return true;
  }

  /** right mouse: set when the ball is dropping onto you, otherwise block */
  private rightButton(): boolean {
    const g = this.g;
    const me = g.me;
    if (me.action && me.action.kind === 'swing' && !me.action.resolved) return false;
    if (me.action && me.action.kind === 'windup') return false;
    if (g.contact.wantsSet(me)) {
      g.contact.pressSet(me, g.inputTime());
      return true;
    }
    me.startAction('block', g.simTime);
    return true;
  }

  private pass(): boolean {
    const g = this.g;
    const me = g.me;
    if (me.state === 'air' || me.state === 'load') return false;
    if (me.action && me.action.kind === 'pass' && !me.action.resolved) return true;
    me.startAction('pass', g.simTime);
    return true;
  }

  /** when the toss button went down (sim time), -1 while it is not held */
  private tossAt = -1;

  private beginToss(): boolean {
    const g = this.g;
    if (!g.contact.canToss(g.me)) return false;
    this.tossAt = g.simTime;
    return true;
  }

  /** let go of the toss now (the together rep of a serve lesson lets go at the serve's own toss) */
  releaseToss(): void {
    this.toss();
  }

  /** how long the toss button has been held (s), -1 while it is up */
  tossHeld(): number {
    return this.tossAt < 0 ? -1 : this.g.simTime - this.tossAt;
  }

  private toss(): void {
    const g = this.g;
    if (this.tossAt < 0) return;
    const hold = g.simTime - this.tossAt;
    this.tossAt = -1;
    g.contact.serveToss(g.me, g.serveKind, tossFor(g.serveKind, hold));
  }

  /** how high the toss being held would go, 0 (a tap) to 1 (the highest), or null while the button is up */
  tossHold(): number | null {
    return this.tossAt < 0 ? null : clamp01((this.g.simTime - this.tossAt) / SERVE.hold.full);
  }

  /** per fixed step: zone contacts for held actions */
  step(_dt: number): void {
    const g = this.g;
    // AI brains resolve their own touches; this handles the user's held actions
    for (const a of [g.me]) {
      const act = a.action;
      if (!act || act.resolved) continue;
      if (act.kind === 'pass') g.contact.tryPass(a, act);
      else if (act.kind === 'set') g.contact.trySet(a, act);
      else if (act.kind === 'block') g.contact.tryBlock(a, act);
      if (act.resolved || a.action !== act) continue;
      // a tapped pass expires; a set never caught ends once the ball has gone by (no second press for it)
      if (act.kind === 'pass' && !act.held && g.simTime - act.t0 > 0.85) a.endAction();
      else if (act.kind === 'set' && !act.absorbing && (act.idealT > 0 ? g.simTime > act.idealT + 0.3 : g.simTime - act.t0 > 2))
        a.endAction();
    }
  }
}
