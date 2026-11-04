import { afterEach, describe, expect, it, vi } from 'vitest';
import { Input } from '../src/core/input';

/**
 * Input's pointer-lock bookkeeping against a scripted browser. `answer` decides each
 * requestPointerLock call: 'grant', 'refuse' (promise rejects), 'unsupported' (rejects only when
 * unadjustedMovement is asked for), or 'event' (returns nothing, like Firefox).
 */
type Answer = 'grant' | 'refuse' | 'unsupported' | 'event';

function browser(answer: () => Answer) {
  const doc = Object.assign(new EventTarget(), { pointerLockElement: null as unknown, exitPointerLock() {} });
  vi.stubGlobal('window', new EventTarget());
  vi.stubGlobal('document', doc);
  const el = new EventTarget() as EventTarget & { requestPointerLock?: (o?: object) => Promise<void> | undefined };
  const calls: (object | undefined)[] = [];
  const setLock = (locked: boolean) => {
    doc.pointerLockElement = locked ? el : null;
    doc.dispatchEvent(new Event('pointerlockchange'));
  };
  el.requestPointerLock = (opts?: object) => {
    calls.push(opts);
    const a = answer();
    if (a === 'event') return undefined;
    if (a === 'refuse' || (a === 'unsupported' && opts)) {
      // Chrome rejects the promise and also fires pointerlockerror
      doc.dispatchEvent(new Event('pointerlockerror'));
      return Promise.reject(new Error('refused'));
    }
    queueMicrotask(() => setLock(true));
    return Promise.resolve();
  };
  const input = new Input(el as unknown as HTMLElement);
  const refusals: boolean[] = [];
  input.onLockRefused = (fallback) => refusals.push(fallback);
  return { input, doc, calls, refusals, setLock };
}

const settle = () => new Promise((r) => setTimeout(r, 0));

afterEach(() => vi.unstubAllGlobals());

describe('pointer lock', () => {
  it('falls back to drag-look when the lock is refused before it ever worked', async () => {
    const b = browser(() => 'refuse');
    b.input.requestLock();
    await settle();
    expect(b.input.dragLook).toBe(true);
    expect(b.input.pointerLocked).toBe(false);
    // the plain retry after the unadjustedMovement attempt is one request, so one refusal
    expect(b.refusals).toEqual([true]);
  });

  it("stays in pointer-lock mode when a re-lock is refused after Esc (Chrome's cooldown)", async () => {
    let answer: Answer = 'grant';
    const b = browser(() => answer);
    b.input.requestLock();
    await settle();
    expect(b.input.pointerLocked).toBe(true);
    // the user presses Esc, then clicks Resume straight away
    const before = performance.now();
    b.setLock(false);
    expect(b.input.lockLostAt).toBeGreaterThanOrEqual(before);
    answer = 'refuse';
    b.input.requestLock();
    await settle();
    expect(b.input.dragLook).toBe(false);
    expect(b.refusals).toEqual([false]);
    // a later Resume gets it back
    answer = 'grant';
    b.input.requestLock();
    await settle();
    expect(b.input.pointerLocked).toBe(true);
    expect(b.input.dragLook).toBe(false);
  });

  it('a granted lock clears an earlier drag-look fallback, so losing it pauses again', async () => {
    let answer: Answer = 'refuse';
    const b = browser(() => answer);
    b.input.requestLock();
    await settle();
    expect(b.input.dragLook).toBe(true);
    answer = 'grant';
    b.input.requestLock();
    await settle();
    expect(b.input.pointerLocked).toBe(true);
    expect(b.input.dragLook).toBe(false);
  });

  it('retries without unadjustedMovement where it is unsupported, and that is not a refusal', async () => {
    const b = browser(() => 'unsupported');
    b.input.requestLock();
    await settle();
    expect(b.calls).toEqual([{ unadjustedMovement: true }, undefined]);
    expect(b.input.pointerLocked).toBe(true);
    expect(b.refusals).toEqual([]);
  });

  it('browsers without a promise report a refusal through pointerlockerror', async () => {
    const b = browser(() => 'event');
    b.input.requestLock();
    await settle();
    expect(b.refusals).toEqual([]);
    b.doc.dispatchEvent(new Event('pointerlockerror'));
    expect(b.refusals).toEqual([true]);
    // an unrelated error event later is not a second refusal
    b.doc.dispatchEvent(new Event('pointerlockerror'));
    expect(b.refusals).toEqual([true]);
    // and a granted event request counts as the lock working
    b.input.requestLock();
    b.setLock(true);
    expect(b.input.dragLook).toBe(false);
    b.doc.dispatchEvent(new Event('pointerlockerror'));
    expect(b.refusals).toEqual([true]);
  });

  it('a second request while locked does not ask the browser again', async () => {
    const b = browser(() => 'grant');
    b.input.requestLock();
    await settle();
    expect(b.input.pointerLocked).toBe(true);
    b.calls.length = 0;
    b.input.requestLock();
    await settle();
    expect(b.calls).toEqual([]);
    expect(b.input.pointerLocked).toBe(true);
  });

  it('touch controls never ask for the lock', async () => {
    const b = browser(() => 'refuse');
    b.input.touch = true;
    b.input.requestLock();
    await settle();
    expect(b.calls).toEqual([]);
    expect(b.input.dragLook).toBe(false);
  });
});
