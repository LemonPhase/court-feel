/**
 * A memento of a graph of live objects: `capture` saves it, `restore` puts it back, as often as
 * asked. It is what lets a rally go back to an earlier touch (game/flashback.ts).
 *
 * The objects that hold the state stay the objects they are: a stateful object's fields are
 * written back onto the same instance, a value object (a vector) is copied back into itself, a
 * Map or a Set is refilled in place. Whoever else holds them (a closure, a view, a team) still
 * holds the right thing afterwards. Plain objects and arrays in between are data: they are copied
 * when saved and copied again each time they are put back, with shared ones still shared.
 *
 * Everything else (functions, scene objects, the game itself, anything of a class the rules do not
 * name) is kept as the reference it was and never looked into.
 */

/** something `instanceof` can test against */
export type Ctor = abstract new (...args: never[]) => object;

/** a stateful object that saves and loads itself (what it returns is kept as is, so it must not be changed later) */
export interface SelfSaving {
  saveState(): unknown;
  loadState(saved: unknown): void;
}

export interface MementoRules {
  /** classes whose instances hold state: their own data fields are saved, and written back in place */
  stateful: readonly Ctor[];
  /** value classes with `clone()` and `copy(from)` (vectors, quaternions): copied back into the same instance */
  values: readonly Ctor[];
  /** objects kept by reference and never copied: records that are never changed and are compared by identity */
  shared?: (o: object) => boolean;
  /** a field of a stateful object that is left alone (it never changes, or must not be put back) */
  skip?: (o: object, key: string) => boolean;
}

interface Copyable {
  clone(): Copyable;
  copy(from: Copyable): unknown;
}
type Typed = Float32Array | Float64Array | Uint8Array | Int32Array | Uint32Array | Uint16Array | Int16Array | Int8Array;

type Node =
  | { k: 'raw'; v: unknown }
  | { k: 'val'; src: Copyable; copy: Copyable }
  | { k: 'obj'; src: Record<string, unknown>; fields: [string, Node][] }
  | { k: 'self'; src: SelfSaving; saved: unknown }
  | { k: 'pojo'; fields: [string, Node][] }
  | { k: 'arr'; items: Node[] }
  | { k: 'map'; src: Map<unknown, unknown>; entries: [Node, Node][] }
  | { k: 'set'; src: Set<unknown>; items: Node[] }
  | { k: 'typed'; src: Typed; copy: Typed };

export interface Memento {
  readonly root: Node;
  /** how many objects it holds (for the debug overlay and the tests) */
  readonly size: number;
}

const isPlain = (o: object): boolean => {
  const p = Object.getPrototypeOf(o);
  return p === Object.prototype || p === null;
};

/** the own data fields of an object: no getters, nothing read-only */
function dataKeys(o: object): string[] {
  const out: string[] = [];
  for (const key of Object.keys(o)) {
    const d = Object.getOwnPropertyDescriptor(o, key);
    if (d && 'value' in d && d.writable) out.push(key);
  }
  return out;
}

/** a plain object that carries behaviour (a function, a getter) is not data: it is kept as it is */
function isData(o: object): boolean {
  for (const key of Object.keys(o)) {
    const d = Object.getOwnPropertyDescriptor(o, key);
    if (!d || !('value' in d) || typeof d.value === 'function') return false;
  }
  return true;
}

/** save `root` and everything it reaches under `rules` */
export function capture(root: unknown, rules: MementoRules): Memento {
  const seen = new Map<object, Node>();
  const is = (o: object, classes: readonly Ctor[]) => classes.some((c) => o instanceof c);
  const enc = (v: unknown): Node => {
    if (v === null || typeof v !== 'object') return { k: 'raw', v };
    const known = seen.get(v);
    if (known) return known;
    const keep = (n: Node): Node => {
      seen.set(v, n);
      return n;
    };
    if (rules.shared?.(v)) return keep({ k: 'raw', v });
    if (is(v, rules.values)) return keep({ k: 'val', src: v as Copyable, copy: (v as Copyable).clone() });
    if (ArrayBuffer.isView(v) && !(v instanceof DataView)) return keep({ k: 'typed', src: v as Typed, copy: (v as Typed).slice() });
    if (is(v, rules.stateful)) {
      const self = v as Partial<SelfSaving>;
      if (typeof self.saveState === 'function' && typeof self.loadState === 'function')
        return keep({ k: 'self', src: v as SelfSaving, saved: self.saveState() });
      const node: Node = { k: 'obj', src: v as Record<string, unknown>, fields: [] };
      keep(node);
      for (const key of dataKeys(v)) if (!rules.skip?.(v, key)) node.fields.push([key, enc((v as Record<string, unknown>)[key])]);
      return node;
    }
    if (Array.isArray(v)) {
      const node: Node = { k: 'arr', items: [] };
      keep(node);
      for (const item of v) node.items.push(enc(item));
      return node;
    }
    if (v instanceof Map) {
      const node: Node = { k: 'map', src: v, entries: [] };
      keep(node);
      for (const [key, value] of v) node.entries.push([enc(key), enc(value)]);
      return node;
    }
    if (v instanceof Set) {
      const node: Node = { k: 'set', src: v, items: [] };
      keep(node);
      for (const item of v) node.items.push(enc(item));
      return node;
    }
    if (isPlain(v) && isData(v)) {
      const node: Node = { k: 'pojo', fields: [] };
      keep(node);
      for (const key of Object.keys(v)) node.fields.push([key, enc((v as Record<string, unknown>)[key])]);
      return node;
    }
    return keep({ k: 'raw', v });
  };
  const node = enc(root);
  return { root: node, size: seen.size };
}

/** put a memento back; returns the root (itself when it is stateful, a fresh copy when it is plain data) */
export function restore(m: Memento): unknown {
  const done = new Map<Node, unknown>();
  const dec = (n: Node): unknown => {
    if (n.k === 'raw') return n.v;
    if (done.has(n)) return done.get(n);
    switch (n.k) {
      case 'val':
        n.src.copy(n.copy);
        done.set(n, n.src);
        return n.src;
      case 'typed':
        n.src.set(n.copy);
        done.set(n, n.src);
        return n.src;
      case 'self':
        done.set(n, n.src);
        n.src.loadState(n.saved);
        return n.src;
      case 'obj':
        done.set(n, n.src);
        for (const [key, f] of n.fields) n.src[key] = dec(f);
        return n.src;
      case 'pojo': {
        const o: Record<string, unknown> = {};
        done.set(n, o);
        for (const [key, f] of n.fields) o[key] = dec(f);
        return o;
      }
      case 'arr': {
        const a: unknown[] = [];
        done.set(n, a);
        for (const item of n.items) a.push(dec(item));
        return a;
      }
      case 'map': {
        done.set(n, n.src);
        const entries = n.entries.map(([key, value]) => [dec(key), dec(value)] as const);
        n.src.clear();
        for (const [key, value] of entries) n.src.set(key, value);
        return n.src;
      }
      case 'set': {
        done.set(n, n.src);
        const items = n.items.map(dec);
        n.src.clear();
        for (const item of items) n.src.add(item);
        return n.src;
      }
    }
  };
  return dec(m.root);
}
