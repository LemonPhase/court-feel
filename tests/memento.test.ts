import { describe, expect, it } from 'vitest';
import { capture, restore, type MementoRules } from '../src/core/memento';

/** a value object, as a vector is: copied back into itself */
class Vec {
  constructor(
    public x = 0,
    public y = 0,
  ) {}
  clone(): Vec {
    return new Vec(this.x, this.y);
  }
  copy(from: Vec): this {
    this.x = from.x;
    this.y = from.y;
    return this;
  }
}

/** a stateful object, as an athlete or a brain is: its fields are written back onto it */
class Player {
  readonly pos = new Vec();
  spot: { x: number; z: number } = { x: 0, z: 0 };
  readSpot: { x: number; z: number } | null = null;
  touch: object | null = null;
  mate: Player | null = null;
  seen = new Map<string, number>();
  plan: { at: Vec; steps: number[] } | null = null;
  onStep: (() => void) | null = null;
  fixed = { table: 1 };
  constructor(public name: string) {}
}

/** something the rules do not name: kept as the reference it is */
class Scene {
  children = [1, 2, 3];
}

const touch = (kind: string) => ({ kind, side: 1, athlete: null, t: 0 });
const RULES: MementoRules = {
  stateful: [Player],
  values: [Vec],
  shared: (o) => 'kind' in o && 'side' in o,
  skip: (o, key) => o instanceof Player && key === 'fixed',
};

describe('a memento puts a graph of live objects back', () => {
  it('a stateful object keeps its identity: its fields are written back onto it', () => {
    const p = new Player('L');
    p.spot = { x: 1, z: 2 };
    const m = capture(p, RULES);
    p.spot = { x: 9, z: 9 };
    p.name = 'changed';
    expect(restore(m)).toBe(p);
    expect(p.name).toBe('L');
    expect(p.spot).toEqual({ x: 1, z: 2 });
  });

  it('a value object is copied back into the same instance: whoever holds it still holds the right thing', () => {
    const p = new Player('L');
    const held = p.pos;
    p.pos.x = 3;
    const m = capture(p, RULES);
    p.pos.x = 7;
    restore(m);
    expect(p.pos).toBe(held);
    expect(held.x).toBe(3);
  });

  it('plain data is copied when saved, so changing it afterwards in place does not change what is put back', () => {
    const p = new Player('L');
    p.plan = { at: new Vec(1, 1), steps: [1, 2] };
    const m = capture(p, RULES);
    p.plan.steps.push(3);
    p.plan.at.x = 5;
    p.spot.x = 4;
    restore(m);
    expect(p.plan!.steps).toEqual([1, 2]);
    expect(p.plan!.at.x).toBe(1);
    expect(p.spot.x).toBe(0);
  });

  it('data that was shared is still shared, and data that was not is not', () => {
    const p = new Player('L');
    p.readSpot = { x: 1, z: 1 };
    p.spot = p.readSpot;
    const shared = capture(p, RULES);
    p.spot = { x: 2, z: 2 };
    restore(shared);
    expect(p.spot).toBe(p.readSpot);

    p.spot = { x: 3, z: 3 };
    const apart = capture(p, RULES);
    p.spot = p.readSpot!;
    restore(apart);
    expect(p.spot).not.toBe(p.readSpot);
    expect(p.spot).toEqual({ x: 3, z: 3 });
  });

  it('a shared record (a touch) is never copied: players who compare touches by identity still agree', () => {
    const a = new Player('S');
    const b = new Player('MB');
    const first = touch('pass');
    a.touch = b.touch = first;
    const m = capture([a, b], RULES);
    a.touch = b.touch = touch('set');
    restore(m);
    expect(a.touch).toBe(first);
    expect(b.touch).toBe(first);
  });

  it('a Map is refilled in place, and entries added since are gone', () => {
    const p = new Player('L');
    p.seen.set('serve', 1);
    const map = p.seen;
    const m = capture(p, RULES);
    p.seen.set('spike', 2);
    p.seen.set('serve', 5);
    restore(m);
    expect(p.seen).toBe(map);
    expect([...p.seen]).toEqual([['serve', 1]]);
  });

  it('objects that point at each other are put back once each', () => {
    const a = new Player('S');
    const b = new Player('MB');
    a.mate = b;
    b.mate = a;
    const m = capture(a, RULES);
    a.mate = null;
    b.name = 'x';
    restore(m);
    expect(a.mate).toBe(b);
    expect(b.mate).toBe(a);
    expect(b.name).toBe('MB');
  });

  it('what the rules do not name is kept as it is: functions, other classes, skipped fields, plain objects with behaviour', () => {
    const p = new Player('L');
    const step = () => {};
    const scene = new Scene();
    const host = { get now() { return 1; }, run: () => 2 }; // prettier-ignore
    p.onStep = step;
    const root = { p, scene, host };
    const m = capture(root, RULES);
    scene.children.push(4);
    p.fixed.table = 2;
    const back = restore(m) as typeof root;
    expect(back.p.onStep).toBe(step);
    expect(back.scene).toBe(scene);
    expect(scene.children).toEqual([1, 2, 3, 4]);
    expect(back.host).toBe(host);
    expect(p.fixed.table).toBe(2);
  });

  it('a self-saving object saves and loads itself', () => {
    class Ball {
      height = 1;
      saveState() {
        return { height: this.height };
      }
      loadState(s: unknown) {
        this.height = (s as { height: number }).height;
      }
    }
    const ball = new Ball();
    const m = capture(ball, { stateful: [Ball], values: [] });
    ball.height = 4;
    restore(m);
    expect(ball.height).toBe(1);
  });

  it('it can be put back as often as asked: taking a ball again twice starts from the same place', () => {
    const p = new Player('L');
    p.plan = { at: new Vec(1, 1), steps: [1] };
    const m = capture(p, RULES);
    for (let i = 0; i < 3; i++) {
      p.plan!.steps.push(9);
      p.pos.x += 5;
      restore(m);
      expect(p.plan!.steps).toEqual([1]);
      expect(p.pos.x).toBe(0);
    }
  });
});
