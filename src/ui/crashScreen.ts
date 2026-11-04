/**
 * Full-screen message for an error the game cannot carry on from (it failed to start, or
 * frames keep throwing). Everything is set with textContent: error messages are not HTML.
 */
export function showCrashScreen(parent: HTMLElement, opts: { title: string; body: string; details: string }): void {
  if (parent.querySelector('.crash')) return;
  const root = document.createElement('div');
  root.className = 'crash';
  root.setAttribute('role', 'alertdialog');
  root.setAttribute('aria-modal', 'true');
  root.setAttribute('aria-labelledby', 'crash-title');
  root.setAttribute('aria-describedby', 'crash-body');

  const box = document.createElement('div');
  box.className = 'crash-box';
  const title = document.createElement('h1');
  title.id = 'crash-title';
  title.textContent = opts.title;
  const body = document.createElement('p');
  body.id = 'crash-body';
  body.textContent = opts.body;
  const details = document.createElement('textarea');
  details.className = 'crash-details';
  details.readOnly = true;
  details.value = opts.details;
  details.setAttribute('aria-label', 'Error details');

  const buttons = document.createElement('div');
  buttons.className = 'crash-buttons';
  const reload = document.createElement('button');
  reload.className = 'play-btn';
  reload.textContent = 'RELOAD';
  reload.addEventListener('click', () => location.reload());
  const copy = document.createElement('button');
  copy.className = 'ghost-btn';
  copy.textContent = 'Copy details';
  copy.addEventListener('click', () => {
    const done = () => (copy.textContent = 'Copied');
    const fallback = () => {
      details.focus();
      details.select();
      copy.textContent = 'Press Ctrl+C / Cmd+C';
    };
    try {
      navigator.clipboard.writeText(opts.details).then(done, fallback);
    } catch {
      fallback();
    }
  });
  buttons.append(reload, copy);
  box.append(title, body, details, buttons);
  root.append(box);
  parent.append(root);
  // everything behind it (menus, HUD, canvas) is out of reach: no focus, no clicks, a real modal
  for (const el of Array.from(parent.children)) if (el !== root && el instanceof HTMLElement) el.inert = true;
  // the game may hold the pointer: give it back so the buttons can be clicked
  try {
    if (document.pointerLockElement) document.exitPointerLock();
  } catch {
    /* ignore */
  }
  reload.focus();
}
