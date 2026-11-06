// Vercel Function: the online leaderboard (GET a board, your line, the medal table or a health check;
// POST a finished ranked run; DELETE a bogus run, with the admin token).
// It needs an Upstash Redis store on the Vercel project (Storage → Upstash for Redis), which sets the
// REST URL and token below. Production keeps its own boards; preview deployments share a test set.
// LEADERBOARD_ADMIN_TOKEN (optional, any long random string) unlocks the admin view and removals.
import { createHandler } from '../src/net/server.js';
import { UpstashStore } from '../src/net/upstash.js';

const url = process.env.UPSTASH_REDIS_REST_URL ?? process.env.KV_REST_API_URL;
const token = process.env.UPSTASH_REDIS_REST_TOKEN ?? process.env.KV_REST_API_TOKEN;
const prefix = process.env.VERCEL_ENV === 'production' ? 'cf:prod' : 'cf:dev';
const adminToken = process.env.LEADERBOARD_ADMIN_TOKEN || null;

const handler = url && token ? createHandler(new UpstashStore(url, token), { prefix, adminToken }) : null;

const notSetUp = (): Response =>
  new Response(JSON.stringify({ error: 'the leaderboard is not set up on this deployment' }), {
    status: 503,
    headers: { 'content-type': 'application/json', 'cache-control': 'no-store' },
  });

export function GET(request: Request): Promise<Response> | Response {
  return handler ? handler(request) : notSetUp();
}

export function POST(request: Request): Promise<Response> | Response {
  return handler ? handler(request) : notSetUp();
}

export function DELETE(request: Request): Promise<Response> | Response {
  return handler ? handler(request) : notSetUp();
}
