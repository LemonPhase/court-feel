/** Tiny typed event bus. */
export type Handler<T> = (payload: T) => void;

export class Emitter<Events extends Record<string, unknown>> {
  private map = new Map<keyof Events, Set<Handler<any>>>();

  on<K extends keyof Events>(type: K, fn: Handler<Events[K]>): () => void {
    let set = this.map.get(type);
    if (!set) {
      set = new Set();
      this.map.set(type, set);
    }
    set.add(fn);
    return () => set!.delete(fn);
  }

  emit<K extends keyof Events>(type: K, payload: Events[K]): void {
    const set = this.map.get(type);
    if (!set) return;
    for (const fn of set) fn(payload);
  }

  clear(): void {
    this.map.clear();
  }
}
