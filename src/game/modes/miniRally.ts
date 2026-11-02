import * as THREE from 'three';
import { COURT } from '../../config';
import { netYaw } from '../../ai/brain';
import { SLOT_ROLE, SLOTS, TeamAI, USER_SLOT } from '../../ai/team';
import { Athlete } from '../athlete';
import type { ContactEvent } from '../contact';
import type { Outcome } from '../judge';
import { SETTER_TARGET } from '../plays';
import { kbd, Mode } from './mode';

type Phase = 'prepare' | 'serve' | 'live' | 'dead';

/**
 * Mini rally: 6 v 6 with the user in their chosen position. AI team-mates and
 * opponents receive, set, attack, block and dig; points are won or lost.
 */
export class MiniRally extends Mode {
  readonly id = 'rally' as const;
  home!: TeamAI;
  away!: TeamAI;
  private phase: Phase = 'prepare';
  private t = 0;
  servingSide: 1 | -1 = -1;
  scoreHome = 0;
  scoreAway = 0;
  private lastReceiverMsg: unknown = null;
  private reason = '';
  private userTouches = 0;

  setup(): void {
    const g = this.g;
    this.home = new TeamAI(1, g);
    this.away = new TeamAI(-1, g);
    this.home.opponents = this.away;
    this.away.opponents = this.home;
    const userSlot = USER_SLOT[this.position];
    let seed = 50;
    for (const slot of SLOTS) {
      if (slot === userSlot) {
        if (g.autoUser) g.me.isUser = false;
        this.home.add(slot, g.me, !g.autoUser);
        continue;
      }
      const a = new Athlete(SLOT_ROLE[slot], 1);
      g.addAthlete(a, seed++);
      this.spawned.push(a);
      this.home.add(slot, a, false);
    }
    for (const slot of SLOTS) {
      const a = new Athlete(SLOT_ROLE[slot], -1);
      g.addAthlete(a, seed++);
      this.spawned.push(a);
      this.away.add(slot, a, false);
    }
    g.hud.setTitle('Mini Rally · you are the ' + g.me.stats.name);
    this.servingSide = -1;
    this.prepare(true);
    g.hud.message('Play your position · win the point', 2.5);
  }

  private prepare(first = false): void {
    const g = this.g;
    g.ballLive = false;
    g.ball.hide();
    g.judge.disarm();
    const homeForm = this.servingSide === 1 ? 'defense' : 'receive';
    const awayForm = this.servingSide === -1 ? 'defense' : 'receive';
    this.home.serving = this.servingSide === 1;
    this.away.serving = this.servingSide === -1;
    this.home.place(homeForm);
    this.away.place(awayForm);
    const spot = this.home.formSpot(homeForm, USER_SLOT[this.position]);
    const me = g.me;
    if (first) g.placeUser(spot.x, spot.z, 0);
    else if (Math.hypot(me.pos.x - spot.x, me.pos.z - spot.z) > 0.6) g.returnUser(spot.x, spot.z, 0, 1.5);
    this.phase = 'prepare';
    this.t = 0;
    this.userTouches = 0;
    this.updateScore();
  }

  private updateScore(): void {
    this.g.hud.setScore(`YOU ${this.scoreHome} : ${this.scoreAway} THEM · ${this.servingSide === 1 ? 'your serve' : 'their serve'}`);
  }

  passTarget(a: Athlete) {
    const team = a.side === 1 ? this.home : this.away;
    const s = a.side;
    if (team.touches >= 2) {
      // third contact without an attack: free ball deep into their court
      return { x: (this.g.rng.next() - 0.5) * 5, y: 0.5, z: -s * 6.5, apex: 5.2 };
    }
    return { x: SETTER_TARGET.x * s, y: 2.35, z: SETTER_TARGET.z * s, apex: 4.1 };
  }

  setOptions(a: Athlete) {
    // the user as setter: their AI hitters' lanes
    const team = a.side === 1 ? this.home : this.away;
    const out = [];
    for (const [slot, lane] of [['OH1', 'OH'], ['MB', 'MB'], ['OPP', 'OPP']] as const) {
      const h = team.players.get(slot);
      if (!h || h === a) continue;
      const c = team.callSetFor(h, lane);
      out.push({ ...c, label: lane === 'OH' ? 'Outside' : lane === 'MB' ? 'Quick' : 'Back set' });
    }
    return out;
  }

  canServe(a: Athlete): boolean {
    return this.phase === 'serve' && a.side === this.servingSide && !a.isUser;
  }

  hint(): string {
    const g = this.g;
    const me = g.me;
    if (this.home.receiver === me) return `YOUR BALL · ${kbd('E')} pass / dig`;
    if (this.home.setFor === me && g.ball.lastTouch?.kind === 'set') return `SET TO YOU · ${kbd('Shift')}+${kbd('W')} approach · ${kbd('Space')} · ${kbd('LMB')}`;
    if (me.role === 'S' && this.home.touches === 1) return `Your set · look at a hitter · ${kbd('RMB')}`;
    if (me.role === 'MB' && this.home.passToSetter(g)) return `QUICK · run in now · ${kbd('Space')} as the setter touches it · ${kbd('LMB')}`;
    if (Math.abs(me.pos.z) < 1.4) return `${kbd('RMB')} hands + ${kbd('Space')} block · ${kbd('V')} camera`;
    return `${kbd('WASD')} move · ${kbd('E')} pass · ${kbd('LMB')} attack · ${kbd('RMB')} block/set · ${kbd('V')} camera`;
  }

  restartRep(): void {
    this.prepare();
  }

  step(dt: number): void {
    const g = this.g;
    this.t += dt;
    this.home.step();
    this.away.step();
    // "your ball" cue (once per ball)
    if (this.home.receiver === g.me && this.lastReceiverMsg !== g.ball.lastTouch) {
      this.lastReceiverMsg = g.ball.lastTouch;
      g.hud.message('Your ball!', 0.9);
    }
    g.ball.markerColor.setRGB(...((this.home.receiver === g.me ? [0.35, 1.0, 0.45] : [0.85, 0.7, 0.22]) as [number, number, number]));
    switch (this.phase) {
      case 'prepare':
        if (this.t > 1.6) {
          this.phase = 'serve';
          this.t = 0;
          const recv = this.servingSide === 1 ? this.away : this.home;
          // aim the serve at a random receiver, sometimes at the user
          const passers = ['OH1', 'OH2', 'L'].map((s) => recv.players.get(s as any)!).filter(Boolean);
          const tgt = passers[Math.floor(g.rng.next() * passers.length)];
          const aim = new THREE.Vector3(tgt.pos.x + g.rng.gauss() * 0.9, 0, tgt.pos.z + g.rng.gauss() * 0.9);
          aim.x = Math.max(-COURT.halfWidth + 0.4, Math.min(COURT.halfWidth - 0.4, aim.x));
          (this.servingSide === 1 ? this.home : this.away).serve(aim);
        }
        break;
      case 'serve':
        if (this.t > 6) this.prepare();
        break;
      case 'live': {
        // four-touch fault
        for (const team of [this.home, this.away]) {
          if (team.touches > 3) {
            this.reason = 'FOUR TOUCHES';
            this.endPoint((-team.side) as 1 | -1);
            return;
          }
        }
        if (this.t > 25 || (g.ball.state.rest && this.t > 1)) this.endPoint(g.ball.pos.z > 0 ? -1 : 1);
        break;
      }
      case 'dead':
        if (this.t > 2.6) this.prepare();
        break;
    }
  }

  onContact(ev: ContactEvent): void {
    const g = this.g;
    if (this.phase === 'serve' && ev.kind === 'serve') {
      this.phase = 'live';
      this.t = 0;
      g.ballLive = true;
    }
    if (ev.athlete === g.me && ev.grade !== 'Miss') this.userTouches++;
  }

  onOutcome(o: Outcome): void {
    if (this.phase !== 'live') return;
    const lt = this.g.ball.lastTouch;
    const by = lt?.athlete;
    if (o.kind === 'in') {
      if (lt?.kind === 'serve' && o.side !== lt.side) this.reason = 'ACE';
      else if (lt?.kind === 'block' && o.side !== lt.side) this.reason = 'BLOCKED';
      else if ((lt?.kind === 'spike' || lt?.kind === 'tip') && o.side !== lt.side) this.reason = by?.isUser ? 'YOUR KILL' : 'KILL';
      else this.reason = 'BALL DOWN';
    } else this.reason = o.kind === 'out' ? 'OUT' : o.kind === 'antenna' ? 'ANTENNA' : o.kind === 'under-net' ? 'UNDER THE NET' : 'OUTSIDE ANTENNA';
    this.endPoint(o.winner);
  }

  private endPoint(winner: 1 | -1): void {
    const g = this.g;
    if (this.phase === 'dead') return;
    this.phase = 'dead';
    this.t = 0;
    g.ballLive = false;
    g.judge.disarm();
    if (winner === 1) this.scoreHome++;
    else this.scoreAway++;
    this.reps++;
    this.servingSide = winner;
    const mine = winner === 1;
    this.bumpStreak(mine);
    this.score = this.scoreHome;
    g.hud.showBanner(`${mine ? 'POINT YOU' : 'POINT THEM'} · ${this.reason}`, mine ? 'good' : 'bad');
    g.crowd(mine ? (this.reason === 'YOUR KILL' ? 1.2 : 0.7) : 0.25, mine);
    this.updateScore();
    // everyone relaxes towards their spots while the banner shows
    for (const team of [this.home, this.away]) {
      for (const [slot, a] of team.players) {
        if (a.isUser) continue;
        const b = team.brains.get(a);
        if (b) {
          b.job = 'base';
          b.spot = team.formSpot('defense', slot);
        }
        a.cmd.faceYaw = netYaw(a.side);
      }
    }
  }
}
