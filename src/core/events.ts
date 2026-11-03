/** Tiny typed event bus. */
export type Handler<T> = (payload: T) => void;

export class Emitter<Events extends Record<string, unknown>> {
  // one set per event type; the payload type is restored per key in on() / emit()
  private map = new Map<keyof Events, Set<Handler<never>>>();

  /**
   * With `onError`, a handler that throws is reported and the remaining handlers still run
   * (an effects or audio listener must not abort the simulation step that emitted the event).
   * Without it, the error propagates to the emitter.
   */
  constructor(private readonly onError?: (err: unknown, type: keyof Events) => void) {}

  on<K extends keyof Events>(type: K, fn: Handler<Events[K]>): () => void {
    let set = this.map.get(type);
    if (!set) {
      set = new Set();
      this.map.set(type, set);
    }
    set.add(fn as Handler<never>);
    return () => set!.delete(fn as Handler<never>);
  }

  emit<K extends keyof Events>(type: K, payload: Events[K]): void {
    const set = this.map.get(type);
    if (!set) return;
    for (const h of set) {
      const fn = h as Handler<Events[K]>;
      if (!this.onError) {
        fn(payload);
        continue;
      }
      try {
        fn(payload);
      } catch (err) {
        this.onError(err, type);
      }
    }
  }

  clear(): void {
    this.map.clear();
  }
}
