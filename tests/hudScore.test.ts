import { describe, expect, it } from 'vitest';
import { dropSelfNamed, statCells, translateKeyMarkup, type StatCell } from '../src/ui/hud';
import { HITTER_KEY_LABELS, SETTER_KEY_LABELS, TOUCH_KEY_LABELS } from '../src/ui/touchControls';

/** what a cell reads, in order, as the score draws it: what it counts, the value (in the numerals, [bracketed]), the rest */
const read = (c: StatCell) =>
  [c.label, `[${c.value}]`, c.tail]
    .filter((s) => s.trim())
    .join(' ')
    .trim();

describe('the drill score: one cell per part of the line', () => {
  it('a spike drill reads as points, the rep, the set called, the block and the target', () => {
    const cells = statCells('288 pts · rep 12 · set 1: High ball · block: Two · target: Sharp cut');
    // every cell reads the same way round: "PTS 288" like "REP 12"
    expect(cells.map(read)).toEqual(['pts [288]', 'rep [12]', 'set 1 [High ball]', 'block [Two]', 'target [Sharp cut]']);
    // points and reps are set in the numerals, a call or a target in words
    expect(cells.map((c) => c.num)).toEqual([true, true, false, false, false]);
  });

  it("the serve drill's average keeps its 'of 4', and the last serve its speed", () => {
    const cells = statCells('Serve 2: Jump float · avg 2.30 of 4 · rep 7 · last 3 (64 km/h)');
    expect(cells.map(read)).toEqual(['Serve 2 [Jump float]', 'avg [2.30] of 4', 'rep [7]', 'last [3] (64 km/h)']);
    expect(cells[1]).toMatchObject({ label: 'avg', value: '2.30', tail: 'of 4', num: true });
  });

  it("a pass drill's average rating is a number on its own", () => {
    expect(statCells('40 pts · rep 9 · avg 2.33').map(read)).toEqual(['pts [40]', 'rep [9]', 'avg [2.33]']);
  });

  it("free play's switches read as words, not numbers", () => {
    const cells = statCells('Feed: Set to you · auto on · 0 pts');
    expect(cells.map(read)).toEqual(['Feed [Set to you]', '[auto on]', 'pts [0]']);
    expect(cells[1].num).toBe(false);
  });

  it('an empty line has no cells, and a dot inside a word does not split it', () => {
    expect(statCells('')).toEqual([]);
    expect(statCells('target: Line·deep').map((c) => c.value)).toEqual(['Line·deep']);
  });
});

/** the key line as a phone shows it */
const onPhone = (hint: string, m: Record<string, string>) => dropSelfNamed(translateKeyMarkup(hint, m), m);

describe('the key line on a phone', () => {
  it("a hitter's line says nothing the buttons and chips don't already say", () => {
    // Mini Rally's line for the outside hitter: every part is a button reading its own name
    const hint =
      '<kbd>WASD</kbd> move · <kbd>E</kbd> pass · <kbd>LMB</kbd> attack · <kbd>RMB</kbd> block/set · <kbd>V</kbd> camera' +
      ' · <kbd>1</kbd>-<kbd>5</kbd> route · <kbd>C</kbd> routes';
    expect(onPhone(hint, HITTER_KEY_LABELS)).toBe('');
  });

  it("the 1-5 keys are the ROUTE chips on a phone, not number keys it doesn't have", () => {
    expect(translateKeyMarkup('<kbd>1</kbd>-<kbd>5</kbd> route', HITTER_KEY_LABELS)).toBe('<kbd>ROUTE</kbd> route');
  });

  it('keeps what a button cannot say: when to press it, how, and what a chip does', () => {
    const quick = 'QUICK · run in now · <kbd>Space</kbd> as the setter touches it · hold/release <kbd>LMB</kbd>';
    expect(onPhone(quick, TOUCH_KEY_LABELS)).toBe(
      'QUICK · run in now · <kbd>JUMP</kbd> as the setter touches it · hold/release <kbd>HIT</kbd>',
    );
    const setter = '<kbd>WASD</kbd> move · <kbd>E</kbd> pass · <kbd>1</kbd>-<kbd>4</kbd> pick a hitter, again: their next set';
    expect(onPhone(setter, SETTER_KEY_LABELS)).toBe('<kbd>SET TO</kbd> pick a hitter, again: their next set');
    const block = '<kbd>RMB</kbd> hands + <kbd>Space</kbd> block · <kbd>V</kbd> camera';
    expect(onPhone(block, TOUCH_KEY_LABELS)).toBe('<kbd>BLOCK</kbd> hands + <kbd>JUMP</kbd> block');
  });

  it("a key with no button on the phone keeps its words (Free Play's numbered feeds)", () => {
    const feeds = '<kbd>1</kbd>-<kbd>4</kbd> feed type · <kbd>F</kbd> feed';
    expect(onPhone(feeds, TOUCH_KEY_LABELS)).toBe('<kbd>1</kbd>-<kbd>4</kbd> feed type');
  });
});
