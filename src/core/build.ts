/** this build (injected by vite.config.ts) */
export const BUILD = __BUILD__;

/** "v0.1.0 · abc1234": shown in the menus so a bug report can name the build */
export const BUILD_LABEL = `v${BUILD.version} · ${BUILD.commit}`;

/** "0.1.0+abc1234": sent with error reports */
export const BUILD_ID = `${BUILD.version}+${BUILD.commit}`;
