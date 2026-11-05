import { execSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import type { Plugin } from 'vite';
import { defineConfig } from 'vitest/config';
import { createHandler, MemoryStore } from './src/net/server.js';

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

/**
 * The dev server answers /api/leaderboard itself, with the real handler over a store in memory: the
 * leaderboard works locally (and the e2e never touches production). Runs vanish when it restarts.
 */
function localLeaderboard(): Plugin {
  return {
    name: 'court-feel-local-leaderboard',
    configureServer(server) {
      const handler = createHandler(new MemoryStore(), { prefix: 'cf:local' });
      server.middlewares.use('/api/leaderboard', (req, res) => {
        const chunks: Buffer[] = [];
        req.on('data', (c: Buffer) => chunks.push(c));
        req.on('end', async () => {
          const url = new URL((req as { originalUrl?: string }).originalUrl ?? req.url ?? '/', 'http://localhost');
          const headers = new Headers();
          for (const [k, v] of Object.entries(req.headers)) if (typeof v === 'string') headers.set(k, v);
          const response = await handler(
            new Request(url, { method: req.method, headers, body: req.method === 'POST' ? Buffer.concat(chunks) : undefined }),
          );
          res.statusCode = response.status;
          response.headers.forEach((v, k) => res.setHeader(k, v));
          res.end(Buffer.from(await response.arrayBuffer()));
        });
      });
    },
  };
}

export default defineConfig({
  base: './',
  plugins: [localLeaderboard()],
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
