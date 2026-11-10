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
        act.releaseT = this.g.simTime;
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
    u.handlers.toss = () => this.toss();
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
      me.startAction('set', g.simTime);
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

  private toss(): boolean {
    const g = this.g;
    return g.contact.serveToss(g.me);
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
      // a tapped pass/set expires
      if ((act.kind === 'pass' || act.kind === 'set') && !act.resolved && g.simTime - act.t0 > 0.85 && !act.held) a.endAction();
    }
  }
}
