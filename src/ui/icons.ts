/**
 * The menu's icons: one set, drawn here (24 grid, one stroke weight, round ends, no fills).
 * They take the colour of the text beside them and are always decorative: the label carries the meaning.
 */
const svg = (body: string) =>
  `<svg class="ico" aria-hidden="true" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round">${body}</svg>`;

export const ICONS = {
  home: svg('<path d="M4 11l8-7 8 7"/><path d="M6 10v9.5h12V10"/>'),
  train: svg('<circle cx="12" cy="12" r="8.5"/><circle cx="12" cy="12" r="4.2"/><circle cx="12" cy="12" r="0.9" fill="currentColor"/>'),
  play: svg(
    '<circle cx="12" cy="12" r="8.5"/><path d="M12 12c-1-3-.4-6 1.6-8.3"/><path d="M12 12c3 .6 5.5 2.4 7 5"/><path d="M12 12c-2 2.4-5 3.6-8.2 3.2"/>',
  ),
  learn: svg(
    '<path d="M12 6.5C10 5.2 7.5 4.7 4.5 5v12c3-.3 5.5.2 7.5 1.5 2-1.3 4.5-1.8 7.5-1.5V5c-3-.3-5.5.2-7.5 1.5z"/><path d="M12 6.5v12"/>',
  ),
  settings: svg(
    '<path d="M4 7h8.8M17.2 7H20M4 12h2.8M11.2 12H20M4 17h10.8M19.2 17H20"/><circle cx="15" cy="7" r="2.2"/><circle cx="9" cy="12" r="2.2"/><circle cx="17" cy="17" r="2.2"/>',
  ),
  controls: svg('<rect x="7.5" y="3.5" width="9" height="17" rx="4.5"/><path d="M12 7v3"/>'),
  camera: svg('<rect x="3.5" y="7" width="12" height="10" rx="2"/><path d="M15.5 10.5l5-2.5v8l-5-2.5"/>'),
  assists: svg('<circle cx="12" cy="12" r="6"/><path d="M12 2.5v4M12 17.5v4M2.5 12h4M17.5 12h4"/>'),
  sound: svg(
    '<path d="M4.5 9.5h3l4.5-4v13l-4.5-4h-3z"/><path d="M15.5 9.2c1.2 1.6 1.2 4 0 5.6"/><path d="M18.2 6.8c2.3 3 2.3 7.4 0 10.4"/>',
  ),
  court: svg(
    '<rect x="4.5" y="3.5" width="15" height="17" rx="1"/><path d="M2.5 12h19"/><path d="M4.5 8.5h15M4.5 15.5h15" stroke-width="1.2"/>',
  ),
} as const;

export type IconName = keyof typeof ICONS;
