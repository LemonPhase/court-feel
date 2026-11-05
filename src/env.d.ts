/** injected by vite.config.ts at build time */
declare const __BUILD__: { version: string; commit: string; time: string };

interface ImportMetaEnv {
  /** optional: where client error reports are POSTed (see README, "Error reports"); unset = nothing is sent */
  readonly VITE_ERROR_REPORT_URL?: string;
}

/** test and debugging hooks (the e2e drives the game through these) */
interface Window {
  __court?: import('./game/game').Game;
  __menu?: import('./ui/menu').Menu;
  __touch?: import('./ui/touchControls').TouchControls;
  __errors?: import('./core/errors').ErrorReporter;
}
