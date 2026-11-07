import * as THREE from 'three';
import { AI, COURT } from '../../config';
import { netYaw } from '../../ai/brain';
import { SLOT_ROLE, SLOTS, TeamAI, USER_SLOT, type SetterRead } from '../../ai/team';
import { yawFromDir } from '../../core/mathx';
import { Athlete } from '../athlete';
import { applyCalls, CALL_COLOR, callOptions, callSheet, callSpot, startCallRuns, type CallHitters } from '../callRuns';
import type { ContactEvent } from '../contact';
import type { Outcome } from '../judge';
import { needsGoodPass, SET_PLAYS, SETTER_SPOT, SETTER_TARGET, type SetPlay } from '../plays';
import { SETTER_KEYS, SetterCalls, type SetterKey } from '../setterCalls';
import { kbd, makeFloorRing, Mode } from './mode';

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
  /** set calls for the user's position (keys 1-3), if it has any */
  private plays: SetPlay[] | null = null;
  private callIdx = 0;
  /** the user setter's pick (keys 1-4: outside, middle, opposite, pipe) and calls (C: the call sheet) */
  private setterCalls = new SetterCalls();
  private callsFor: unknown = null;
  /** the hitters the user sets, by key (outside OH1, middle, opposite, pipe OH2) */
  private hitters: CallHitters = new Map();
  /** the pass to the user setter is off the net: everything goes up high, no middle */
  private outOfSystem = false;
  /** the floor ring at the spot the user is setting to */
  private pickRing!: THREE.Mesh;

  setup(): void {
    const g = this.g;
    this.home = new TeamAI(1, g);
    this.away = new TeamAI(-1, g);
    this.home.opponents = this.away;
    this.away.opponents = this.home;
    this.home.onRead = (r) => this.setterCall(r);
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
    this.hitters.clear();
    for (const [k, slot] of [
      ['OH', 'OH1'],
      ['MB', 'MB'],
      ['OPP', 'OPP'],
      ['PIPE', 'OH2'],
    ] as const) {
      const a = this.home.players.get(slot);
      const brain = a && !a.isUser ? this.home.brains.get(a)?.hitter : null;
      if (a && brain) this.hitters.set(k, { a, brain });
    }
    this.pickRing = makeFloorRing(0xffffff, 1.0);
    this.pickRing.visible = false;
    this.add(this.pickRing);
    g.hud.setTitle('Mini Rally · you are the ' + g.me.stats.name);
    this.plays = g.autoUser ? null : (SET_PLAYS[this.position] ?? null);
    this.callIdx = 0;
    this.servingSide = -1;
    this.prepare(true);
    g.hud.message(this.plays ? 'Play your position · win the point · 1-3 call your set' : 'Play your position · win the point', 2.5);
  }

  /** the set call for the next ball the setter gives you (0-based; 0 = your position's default) */
  selectCall(i: number): void {
    if (!this.plays || i < 0 || i >= this.plays.length) return;
    this.callIdx = i;
    const play = this.plays[i];
    this.home.userPlay = play;
    this.g.hud.message(`Calling ${i + 1}: ${play.name}`, 1.6);
    this.updateScore();
  }

  private get play(): SetPlay | null {
    return this.plays ? this.plays[this.callIdx] : null;
  }

  /** the user plays a position the setter sets (outside, middle, opposite) */
  private get hitter(): boolean {
    return !!SET_PLAYS[this.position];
  }

  /**
   * Our setter has read the pass. Out of system ("HIGH!": no quick, a called fast set goes
   * up high) is always called; in system only when your call needs the good pass (a quick, a
   * go, a fast back...), to say it is on. Shown in a bubble over the setter and shouted.
   */
  private setterCall(r: SetterRead): void {
    const g = this.g;
    // tutorial reps are a quiet court: no setter bubble (the lesson is one coach line)
    if (g.tutorial.active) return;
    if (!this.hitter) return;
    const play = this.play;
    let word: string;
    let sub: string;
    if (r.call === 'in') {
      if (!play || !needsGoodPass(play)) return;
      word = `${play.short.toUpperCase()}!`;
      sub = 'in system';
    } else if (r.call === 'out') {
      word = 'HIGH!';
      sub = this.position === 'MB' ? 'out of system · no quick' : 'out of system';
    } else {
      word = 'HELP!';
      sub = "can't get there · no set";
    }
    const s = r.setter;
    g.hud.call(this.setterName(s), word, sub, r.call === 'in' ? 'in' : 'out', (out) =>
      out.set(s.rpos.x, s.rpos.y + s.height + 0.42, s.rpos.z),
    );
    g.events.emit('setterCall', { athlete: s, call: r.call });
  }

  /** who is setting for us: the setter, or the libero backing up when the setter played the first ball */
  private setterName(a: Athlete): string {
    return a === this.home.players.get('S') ? 'SETTER' : 'LIBERO';
  }

  /** the setter played our first ball and the second is the user's to set (the user is the libero) */
  private get yourBackupSet(): boolean {
    const me = this.g.me;
    return this.home.touches === 1 && this.home.secondBy === me && me !== this.home.players.get('S');
  }

  /** the setter's read of the pass we are on, if they have called it */
  private get read(): SetterRead | null {
    const r = this.home.read;
    return r && r.touch === this.g.ball.lastTouch ? r : null;
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
    this.outOfSystem = false;
    this.setterCalls.nextBall();
    g.hud.clearCall();
    this.updateScore();
  }

  /** the user sets for us (the setter, or the libero backing up): keys 1-4 pick the hitter */
  private get userSetsKeys(): boolean {
    return !this.g.autoUser && (this.position === 'S' || this.position === 'L');
  }

  /** the user is our setter: their calls are the hitters' (C opens the call sheet) */
  private get userSetter(): boolean {
    return !this.g.autoUser && this.position === 'S';
  }

  /** our first ball is in the air and the second is the user's (our setter, or the libero backing up) */
  userSetsNext(): boolean {
    const g = this.g;
    const lt = g.ball.lastTouch;
    if (g.autoUser || !lt || lt.side !== 1 || lt.athlete === g.me || this.home.touches !== 1) return false;
    return (lt.kind === 'pass' || lt.kind === 'dig' || lt.kind === 'free') && this.home.secondBy === g.me;
  }

  private updateScore(): void {
    const call = this.play ? ` · call ${this.callIdx + 1}: ${this.play.name}` : '';
    this.g.hud.setScore(`YOU ${this.scoreHome} : ${this.scoreAway} THEM · ${this.servingSide === 1 ? 'your serve' : 'their serve'}${call}`);
  }

  frame(dt: number): void {
    const g = this.g;
    if (this.userSetsKeys) {
      const c = this.setterCalls;
      // the libero backing up has no call sheet (a backup's set goes up high to a pin)
      if (!this.userSetter && g.input.consumePress('KeyC')) c.editing = false;
      c.readKeys(g.input);
      // the hitter you will set: your pick, else the one you look at once the ball is yours
      const yours = this.userSetsNext();
      let lit = c.pick;
      if (!lit && yours) {
        let bestD = 1e9;
        const me = g.me;
        for (const o of this.setOptions(me)) {
          const oy = yawFromDir(o.target.x - me.pos.x, o.target.z - me.pos.z);
          const d = Math.abs(((oy - g.rig.yaw + Math.PI * 3) % (Math.PI * 2)) - Math.PI);
          if (d < bestD) {
            bestD = d;
            lit = o.key ?? null;
          }
        }
      }
      const keys = this.userSetter ? SETTER_KEYS : SETTER_KEYS.filter((k) => k === 'OH' || k === 'OPP');
      g.hud.setCallSheet(callSheet(c, keys, lit));
      // the spot you are setting to, in the hitter's colour, while the ball is yours to set
      const oos = this.outOfSystem || !this.userSetter;
      const show = yours && !!lit && !(lit === 'MB' && oos);
      this.pickRing.visible = show;
      if (show && lit) {
        const spot = callSpot(c, lit, oos);
        this.pickRing.position.set(spot.x, 0.011, spot.z + 0.15);
        const mat = this.pickRing.material as THREE.MeshBasicMaterial;
        mat.color.setHex(CALL_COLOR[lit]);
        mat.opacity += (0.95 - mat.opacity) * Math.min(1, dt * 10);
      }
    }
    if (!this.plays) return;
    for (let i = 0; i < this.plays.length; i++) if (this.g.input.consumePress('Digit' + (i + 1))) this.selectCall(i);
  }

  passTarget(a: Athlete) {
    const team = a.side === 1 ? this.home : this.away;
    const s = a.side;
    if (team.touches >= 2) {
      // third contact without an attack: free ball deep into their court
      return { x: (this.g.rng.next() - 0.5) * 5, y: 0.5, z: -s * 6.5, apex: 5.2 };
    }
    // a first ball goes to the setter target (or, played by the setter himself, high to the 3 m line)
    if (team.touches === 0) return team.firstBallTarget(a);
    return { x: SETTER_TARGET.x * s, y: 2.35, z: SETTER_TARGET.z * s, apex: 4.1 };
  }

  setOptions(a: Athlete) {
    // the user as setter: their hitters at their calls. As the libero backing up the setter (who
    // played the first ball) the set is out of system: high balls to the pins, no quick, no pipe
    const backup = a !== this.home.players.get('S');
    const far = Math.hypot(a.pos.x - SETTER_SPOT.x, a.pos.z - SETTER_SPOT.z) > AI.outOfSystem;
    const opts = callOptions(this.g, this.hitters, this.setterCalls, backup || this.outOfSystem || far);
    return backup ? opts.filter((o) => o.key !== 'PIPE') : opts;
  }

  setPick(a: Athlete): SetterKey | null {
    return a === this.g.me ? this.setterCalls.pick : null;
  }

  /** the key hint for the user's set (the call sheet above it shows the hitters and calls) */
  private setterKeysHint(): string {
    if (this.setterCalls.editing) return `CALL SHEET · ${kbd('1')}${kbd('2')}${kbd('3')} change a hitter's call · ${kbd('C')} done`;
    const pick = this.userSetter ? `${kbd('1')}-${kbd('4')} pick (again: high) · ${kbd('C')} calls` : `${kbd('1')} OH ${kbd('3')} OPP`;
    return `${pick} · ${kbd('RMB')} as it reaches your hands, release in the green`;
  }

  canServe(a: Athlete): boolean {
    return this.phase === 'serve' && a.side === this.servingSide && !a.isUser;
  }

  hint(): string {
    const g = this.g;
    const me = g.me;
    if (this.userSetter && this.setterCalls.editing) return this.setterKeysHint();
    if (this.home.receiver === me) return `YOUR BALL · ${kbd('E')} pass / dig`;
    if (this.home.setFor === me && g.ball.lastTouch?.kind === 'set')
      return `SET TO YOU · ${kbd('Shift')}+${kbd('W')} approach · ${kbd('Space')} · hold/release ${kbd('LMB')}`;
    if (me.role === 'S' && this.home.touches === 1) return `Your set · ${this.setterKeysHint()}`;
    if (this.yourBackupSet) return `YOUR SET · the setter dug it · high ball to a pin · ${this.setterKeysHint()}`;
    // the setter's call on the pass overrides the plan: off a bad pass everything goes up high
    const read = this.hitter && this.home.touches === 1 ? this.read : null;
    const who = read ? this.setterName(read.setter) : 'SETTER';
    if (read?.call === 'out') return `${who}: HIGH · out of system · ${me.role === 'MB' ? 'no quick this time' : 'wait for the high ball'}`;
    if (read?.call === 'help') return `${who}: HELP · they can't get to it · no set this time`;
    if (me.role === 'MB' && this.home.passToSetter(g))
      return `QUICK · ${read ? 'in system · ' : ''}run in now · ${kbd('Space')} as the setter touches it · hold/release ${kbd('LMB')}`;
    const play = this.play;
    const fast = play && play.inFront === undefined && needsGoodPass(play);
    if (fast && this.home.touches === 1 && g.ball.lastTouch?.side === 1)
      return `${play.name.toUpperCase()} · ${read ? 'in system · ' : ''}start your approach as the setter touches it`;
    const calls = this.plays ? ` · ${kbd('1')}${kbd('2')}${kbd('3')} set call` : '';
    if (Math.abs(me.pos.z) < 1.4) return `${kbd('RMB')} hands + ${kbd('Space')} block · ${kbd('V')} camera${calls}`;
    return `${kbd('WASD')} move · ${kbd('E')} pass · ${kbd('LMB')} attack · ${kbd('RMB')} block/set · ${kbd('V')} camera${calls}`;
  }

  restartRep(): void {
    this.prepare();
  }

  ballDead(): boolean {
    return !this.g.ballLive || super.ballDead();
  }

  /** six on court: a ball that drops is the user's rep only when it was theirs (the pass, the set to them, their set) */
  userBall(): boolean {
    const g = this.g;
    const me = g.me;
    const lt = g.ball.lastTouch;
    if (this.home.receiver === me || this.yourBackupSet) return true;
    if (this.home.setFor === me && lt?.kind === 'set' && lt.side === 1) return true;
    return me.role === 'S' && this.home.touches === 1 && lt?.side === 1;
  }

  step(dt: number): void {
    const g = this.g;
    this.t += dt;
    this.home.step();
    this.away.step();
    // "your ball" cue (once per ball), also for the second ball when the user backs up the setter
    const backup = this.yourBackupSet;
    const yours = this.home.receiver === g.me || backup;
    // your pick: locked in once our first ball is played, a fresh one after your set
    const lt = g.ball.lastTouch;
    if (lt !== this.callsFor) {
      this.callsFor = lt;
      if (lt?.athlete === g.me && lt.kind === 'set') this.setterCalls.nextBall();
      else if (lt && lt.side === 1 && this.home.touches === 1) {
        this.setterCalls.lock();
        // a pass for you to set: your hitters run your calls (the fast ones before your touch)
        this.outOfSystem = false;
        if (this.userSetter && lt.athlete !== g.me) this.outOfSystem = startCallRuns(g, g.me, this.hitters, this.setterCalls);
      }
    }
    // until the pass, your hitters line up for your calls
    if (this.userSetter && !this.setterCalls.locked) applyCalls(this.hitters, this.setterCalls, false);
    if (yours && this.lastReceiverMsg !== g.ball.lastTouch) {
      this.lastReceiverMsg = g.ball.lastTouch;
      g.hud.message(backup ? 'Your set!' : 'Your ball!', 0.9);
    }
    g.ball.markerColor.setRGB(...((yours ? [0.35, 1.0, 0.45] : [0.3, 0.85, 1.0]) as [number, number, number]));
    switch (this.phase) {
      case 'prepare':
        if (this.t > 1.6) {
          this.phase = 'serve';
          this.t = 0;
          const recv = this.servingSide === 1 ? this.away : this.home;
          // aim the serve at a random receiver, sometimes at the user
          const passers = (['OH1', 'OH2', 'L'] as const).map((s) => recv.players.get(s)).filter((a) => a !== undefined);
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
        // service fault (the serving team played its own serve) and four-touch fault
        for (const team of [this.home, this.away]) {
          if (team.serveFault) {
            this.reason = 'SERVE FAULT';
            this.endPoint(-team.side as 1 | -1);
            return;
          }
          if (team.touches > 3) {
            this.reason = 'FOUR TOUCHES';
            this.endPoint(-team.side as 1 | -1);
            return;
          }
        }
        if (this.t > 25 || (g.ball.state.rest && this.t > 1)) {
          this.reason = g.ball.state.rest ? 'BALL DOWN' : 'LONG RALLY';
          this.endPoint(g.ball.pos.z > 0 ? -1 : 1);
        }
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
    // a serve that hit the net and never made it over (dropped back, or slid under it)
    if (lt?.kind === 'serve' && o.netTouch && (o.kind === 'under-net' || (o.kind === 'in' && o.side === lt.side)))
      this.reason = 'SERVE IN THE NET';
    else if (o.kind === 'in') {
      if (lt?.kind === 'serve' && o.side !== lt.side) this.reason = 'ACE';
      else if (lt?.kind === 'block' && o.side !== lt.side) this.reason = 'BLOCKED';
      else if ((lt?.kind === 'spike' || lt?.kind === 'tip') && o.side !== lt.side) this.reason = by?.isUser ? 'YOUR KILL' : 'KILL';
      else this.reason = 'BALL DOWN';
    } else
      this.reason =
        o.kind === 'out' ? 'OUT' : o.kind === 'antenna' ? 'ANTENNA' : o.kind === 'under-net' ? 'UNDER THE NET' : 'OUTSIDE ANTENNA';
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
