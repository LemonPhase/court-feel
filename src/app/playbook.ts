import type { Playbook, PlaybookStore } from '../game/playbook';

const KEY = 'courtfeel.plays.v1';

/** your plays (start screen, Plays) are kept in this browser's storage; errors are the caller's (private mode, blocked storage) */
export const playbookStorage: PlaybookStore = {
  load(): unknown {
    const raw = localStorage.getItem(KEY);
    return raw ? JSON.parse(raw) : null;
  },
  save(book: Playbook): void {
    localStorage.setItem(KEY, JSON.stringify(book));
  },
};
