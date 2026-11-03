import { execSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { defineConfig } from 'vitest/config';

const pkg = JSON.parse(readFileSync(new URL('./package.json', import.meta.url), 'utf8')) as { version: string };

/** short commit of this build: Vercel / GitHub Actions provide it, otherwise ask git ('dev' without git) */
function commit(): string {
  const sha = process.env.VERCEL_GIT_COMMIT_SHA || process.env.GITHUB_SHA;
  if (sha) return sha.slice(0, 7);
  try {
    return execSync('git rev-parse --short=7 HEAD', { stdio: ['ignore', 'pipe', 'ignore'] })
      .toString()
      .trim();
  } catch {
    return 'dev';
  }
}

export default defineConfig({
  base: './',
  define: {
    // shown in the menus and on the crash screen, and sent with error reports, so a bug report names its build
    __BUILD__: JSON.stringify({ version: pkg.version, commit: commit(), time: new Date().toISOString() }),
  },
  build: {
    target: 'es2022',
    chunkSizeWarningLimit: 1500,
    sourcemap: false,
  },
  server: { host: true },
  test: {
    include: ['tests/**/*.test.ts'],
    environment: 'node',
  },
});
