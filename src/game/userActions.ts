import type { Game } from './game';

/**
 * Binds the user's buttons to athlete actions. Everything starts on the
 * frame the button is pressed (the UserController buffers presses that are
 * not possible yet).
 */
export class UserActions {
  constructor(private g: Game) {
    const u = g.user;
    u.handlers.jump = () => this.g.me.jumpPress();
    u.releaseHandlers.jump = () => this.g.me.jumpRelease();
    u.handlers.attack = () => this.attack();
    u.releaseHandlers.attack = () => {
      const act = this.g.me.action;
      if (act && act.kind === 'swing' && act.held) {
        act.held = false;
        act.releaseT = this.g.simTime;
      }
    };
    u.handlers.block = () => this.rightButton();
    u.releaseHandlers.block = () => {
      const act = this.g.me.action;
      if (act && (act.kind === 'block' || act.kind === 'set') && act.held) {
        act.held = false;
        act.releaseT = this.g.simTime;
      }
    };
    u.handlers.pass = () => this.pass();
    u.releaseHandlers.pass = () => {
      const act = this.g.me.action;
      if (act && act.kind === 'pass' && act.held) {
        act.held = false;
        act.releaseT = this.g.simTime;
      }
    };
    u.handlers.toss = () => this.toss();
  }

  private attack(): boolean {
    const g = this.g;
    const me = g.me;
    const act = me.action;
    // already mid-swing: buffer the press
    if (act && act.kind === 'swing' && !act.resolved) return false;
    if (act && act.kind === 'swing' && g.simTime - act.contactT < 0.25) return false;
    if (me.state === 'load') return false;
    const swing = g.contact.startSwing(me);
    g.notePress(swing.err, swing.contactT);
    return true;
  }

  /** right mouse: set when the ball is dropping onto you, otherwise block */
  private rightButton(): boolean {
    const g = this.g;
    const me = g.me;
    if (me.action && me.action.kind === 'swing' && !me.action.resolved) return false;
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
