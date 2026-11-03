import * as THREE from 'three';
import { BALL } from '../../config';
import { solveApex, solveSpeedToFloor } from '../../physics/solve';
import type { ContactEvent } from '../contact';
import type { Outcome } from '../judge';
import { attackHeight, laneFor, SETTER_SPOT } from '../plays';
import { kbd, Mode, ZoneMarker } from './mode';

type Feed = 'set' | 'free' | 'serve' | 'attack' | 'practice';
const FEEDS: Feed[] = ['set', 'free', 'serve', 'attack', 'practice'];
const FEED_LABEL: Record<Feed, string> = {
  set: 'Set to you',
  free: 'Free ball',
  serve: 'Float serve',
  attack: 'Hard attack',
  practice: 'Serve practice (Q toss, LMB hit)',
};
/** serve-practice target zones on the far court */
const SERVE_ZONES = [
  { x0: -4.5, x1: -2.0, z0: -9, z1: -6.5 },
  { x0: 2.0, x1: 4.5, z0: -9, z1: -6.5 },
  { x0: -1.5, x1: 1.5, z0: -9, z1: -6.5 },
  { x0: -4.5, x1: -2.0, z0: -4.5, z1: -2.5 },
  { x0: 2.0, x1: 4.5, z0: -4.5, z1: -2.5 },
];

/** a ball machine: base, drum and barrel that aims where it shoots */
function makeMachine(): { group: THREE.Group; barrel: THREE.Group; lamp: THREE.Mesh } {
  const group = new THREE.Group();
  const dark = new THREE.MeshStandardMaterial({ color: 0x2b2f3a, roughness: 0.5, metalness: 0.5 });
  const accent = new THREE.MeshStandardMaterial({ color: 0xff9f1c, roughness: 0.4, metalness: 0.2 });
  const base = new THREE.Mesh(new THREE.BoxGeometry(0.6, 0.12, 0.6), dark);
  base.position.y = 0.06;
  group.add(base);
  const mast = new THREE.Mesh(new THREE.CylinderGeometry(0.05, 0.05, 0.9, 10), dark);
  mast.position.y = 0.55;
  group.add(mast);
  const barrel = new THREE.Group();
  barrel.position.y = 1.05;
  const drum = new THREE.Mesh(new THREE.CylinderGeometry(0.2, 0.2, 0.22, 18), accent);
  drum.rotation.z = Math.PI / 2;
  barrel.add(drum);
  const tube = new THREE.Mesh(new THREE.CylinderGeometry(0.13, 0.13, 0.45, 16, 1, true), dark);
  tube.rotation.x = Math.PI / 2;
  tube.position.z = -0.25;
  barrel.add(tube);
  group.add(barrel);
  const hopper = new THREE.Mesh(
    new THREE.CylinderGeometry(0.22, 0.12, 0.3, 14, 1, true),
    new THREE.MeshStandardMaterial({ color: 0x9fb4d8, transparent: true, opacity: 0.45, side: THREE.DoubleSide }),
  );
  hopper.position.set(0, 1.35, 0.1);
  group.add(hopper);
  const lamp = new THREE.Mesh(
    new THREE.SphereGeometry(0.05, 10, 8),
    new THREE.MeshBasicMaterial({ color: new THREE.Color(0.4, 2.2, 0.6) }),
  );
  lamp.position.set(0, 1.25, -0.12);
  group.add(lamp);
  group.traverse((o) => ((o as THREE.Mesh).castShadow = true));
  return { group, barrel, lamp };
}

/**
 * Free play: a machine feeds the ball type you choose (1-4); everything else
 * is up to you: spike, pass, block, set, or serve your own (Q).
 */
export class FreePlay extends Mode {
  readonly id = 'free' as const;
  private feed: Feed = 'set';
  private auto = true;
  private wait = 1.5;
  private machine!: ReturnType<typeof makeMachine>;
  private lastWasMachine = false;
  private requested = false;
  private serveZone = new ZoneMarker(0x7dff9b);
  private zoneIdx = 0;
  private served = false;

  setup(): void {
    const g = this.g;
    const lane = laneFor(this.position, 1);
    g.placeUser(lane.sx, lane.sz, 0);
    this.machine = makeMachine();
    this.add(this.machine.group);
    this.add(this.serveZone.group);
    this.serveZone.group.visible = false;
    this.placeMachine();
    g.hud.setTitle('Free Play');
    this.updateScore();
    g.hud.message('1-4 choose the feed · F feed now · T auto-feed · Q serve yourself', 3.5);
  }

  private placeMachine(): void {
    const m = this.machine.group;
    m.visible = this.feed !== 'practice';
    this.serveZone.group.visible = this.feed === 'practice';
    if (this.feed === 'practice') {
      const g = this.g;
      g.ball.hide();
      g.hud.dip();
      g.placeUser(0.5, 10.4, 0);
      this.pickZone();
      g.hud.message('Behind the end line: Q to toss, hold Left mouse and release to hit (jump for a jump serve)', 3);
      return;
    }
    switch (this.feed) {
      case 'set':
        m.position.set(SETTER_SPOT.x, 0, SETTER_SPOT.z + 0.2);
        break;
      case 'free':
        m.position.set(0, 0, -6.5);
        break;
      case 'serve':
        m.position.set(1.5, 0, -10.2);
        break;
      case 'attack':
        m.position.set(-0.5, 0.0, -2.2);
        break;
    }
    m.scale.setScalar(this.feed === 'attack' ? 1.6 : 1);
  }

  private updateScore(): void {
    this.g.hud.setScore(`Feed: ${FEED_LABEL[this.feed]} · auto ${this.auto ? 'on' : 'off'} · ${this.score} pts`);
  }

  private pickZone(): void {
    this.zoneIdx = (this.zoneIdx + 1 + Math.floor(this.g.rng.next() * (SERVE_ZONES.length - 1))) % SERVE_ZONES.length;
    const z = SERVE_ZONES[this.zoneIdx];
    this.serveZone.set(z.x0, z.x1, z.z0, z.z1);
  }

  hint(): string {
    if (this.feed === 'practice')
      return `${kbd('Q')} toss · hold/release ${kbd('LMB')} serve (aim with the mouse, jump for a jump serve) · ${kbd('1')}-${kbd('5')} feed type`;
    return `${kbd('1')}-${kbd('5')} feed type · ${kbd('F')} feed · ${kbd('T')} auto · ${kbd('Q')} serve toss · hold/release ${kbd('LMB')} hit · ${kbd('E')} pass · ${kbd('RMB')} block/set`;
  }

  canServe(): boolean {
    const b = this.g.ball;
    return !b.active || b.state.rest || this.lastWasMachine || (this.feed === 'practice' && !this.served);
  }

  frame(dt: number): void {
    const inp = this.g.input;
    this.serveZone.update(dt);
    for (let i = 0; i < FEEDS.length; i++) {
      if (inp.consumePress('Digit' + (i + 1))) {
        this.feed = FEEDS[i];
        this.placeMachine();
        this.updateScore();
        this.wait = 0.8;
        this.requested = !this.auto;
      }
    }
    if (inp.consumePress('KeyF')) this.requested = true;
    if (inp.consumePress('KeyT')) {
      this.auto = !this.auto;
      this.updateScore();
    }
  }

  restartRep(): void {
    this.g.ball.hide();
    this.wait = 0.4;
  }

  step(dt: number): void {
    const g = this.g;
    const b = g.ball;
    const idle = !b.active || b.state.rest;
    // the lamp shows when the machine is about to fire
    (this.machine.lamp.material as THREE.MeshBasicMaterial).color.setRGB(
      idle && this.wait < 0.6 ? 2.5 : 0.3,
      idle && this.wait < 0.6 ? 2.2 : 1.6,
      0.4,
    );
    if (!idle) return;
    const act = g.me.action?.kind;
    if (act === 'toss' || (act === 'windup' && g.contact.serving === g.me)) return; // the user is serving
    if (this.feed === 'practice') return; // the machine stands down
    this.wait -= dt;
    if ((this.auto && this.wait <= 0) || this.requested) {
      this.fire();
      this.requested = false;
      this.wait = 2.2;
    }
  }

  private fire(): void {
    const g = this.g;
    const me = g.me;
    const m = this.machine.group;
    const from = { x: m.position.x, y: this.feed === 'attack' ? 2.85 : 1.2, z: m.position.z - (this.feed === 'set' ? 0 : -0.3) };
    const v = { x: 0, y: 0, z: 0 };
    let w = { x: 0, y: 0, z: 0 };
    let knuckle = 0;
    switch (this.feed) {
      case 'set': {
        const lane = laneFor(this.position, 1);
        const y = attackHeight(me);
        from.y = 2.3;
        solveApex(from, { x: lane.x, y, z: lane.z }, y + lane.apexAbove, w, v);
        break;
      }
      case 'free': {
        const tgt = { x: me.pos.x + g.rng.gauss() * 1.2, y: 1.0, z: me.pos.z + g.rng.gauss() * 1.0 };
        solveApex(from, tgt, 5.5 + g.rng.next(), w, v);
        break;
      }
      case 'serve': {
        const land = { x: 0, y: 0, z: 0 };
        const tx = me.pos.x + g.rng.gauss() * 1.0;
        const tz = me.pos.z + g.rng.gauss() * 1.0;
        from.y = 2.9;
        solveSpeedToFloor(from, tx, tz, 16 + g.rng.next() * 2, 0, v, w, land, -0.4, 0.6);
        w = { x: 0, y: 0, z: 0 };
        knuckle = BALL.floatWobble;
        break;
      }
      case 'attack': {
        const land = { x: 0, y: 0, z: 0 };
        const tx = me.pos.x + g.rng.gauss() * 0.9;
        const tz = me.pos.z + g.rng.gauss() * 0.8;
        solveSpeedToFloor(from, tx, tz, 19 + g.rng.next() * 5, 45, v, w, land);
        break;
      }
    }
    // aim the barrel
    const yaw = Math.atan2(-v.x, -v.z);
    this.machine.barrel.rotation.set(Math.atan2(v.y, Math.hypot(v.x, v.z)), yaw - m.rotation.y, 0, 'YXZ');
    g.ball.launch(from, v, w, knuckle, g.simTime);
    g.ball.lastTouch = { athlete: null, kind: this.feed === 'set' ? 'set' : 'feed', t: g.simTime, side: this.feed === 'set' ? 1 : -1 };
    g.judge.arm(g.ball);
    this.lastWasMachine = true;
  }

  onContact(ev: ContactEvent): void {
    if (ev.athlete !== this.g.me) return;
    this.lastWasMachine = false;
    if (ev.kind === 'serve') this.served = true;
    const pts = ev.grade === 'Perfect' ? 30 : ev.grade === 'Good' ? 15 : ev.grade === 'Miss' ? 0 : 5;
    this.score += pts;
    this.bumpStreak(ev.grade === 'Perfect' || ev.grade === 'Good');
    this.updateScore();
  }

  onOutcome(o: Outcome): void {
    const lt = this.g.ball.lastTouch;
    if (this.feed === 'practice' && this.served && lt?.athlete === this.g.me) {
      this.served = false;
      const z = SERVE_ZONES[this.zoneIdx];
      const inZone = o.kind === 'in' && o.x >= z.x0 && o.x <= z.x1 && o.z >= z.z0 && o.z <= z.z1;
      if (o.kind === 'in' && o.side === -1) {
        const pts = inZone ? 60 : 20;
        this.score += pts;
        this.bumpStreak(inZone);
        this.g.hud.showBanner(inZone ? `ON TARGET  +${pts}` : `IN  +${pts}`, 'good');
        this.g.crowd(inZone ? 0.6 : 0.25);
        if (inZone) this.pickZone();
      } else {
        this.bumpStreak(false);
        this.g.hud.showBanner(o.kind === 'in' ? 'NET' : 'OUT', 'bad');
      }
      this.updateScore();
      return;
    }
    if (lt?.athlete === this.g.me && o.kind === 'in' && o.side === -1) {
      this.g.hud.showBanner('IN!', 'good');
      this.g.crowd(0.4);
    } else if (lt?.athlete === this.g.me && o.kind !== 'in') this.g.hud.showBanner('OUT', 'bad');
    this.wait = Math.min(this.wait, 1.8);
  }
}
