/**
 * Client error reports. Every error the game catches (a frame that threw, an event handler
 * that threw, a failed start-up) and every uncaught error or rejected promise goes through
 * one ErrorReporter. It keeps the last few for the crash screen and, when an endpoint is
 * configured (VITE_ERROR_REPORT_URL), sends each distinct error once, up to a cap per page
 * load. Without an endpoint nothing leaves the browser. Reporting never throws.
 */

export type ErrorKind = 'startup' | 'crash' | 'error' | 'rejection';

export interface ErrorReport {
  kind: ErrorKind;
  /** where it was caught: 'frame', 'event handler', 'uncaught', ... */
  where: string;
  message: string;
  stack: string;
  /** version+commit */
  build: string;
  /** path and query of the page (no origin) */
  page: string;
  userAgent: string;
  /** ISO time */
  at: string;
  /** game state when it happened (mode, position, camera, ...) */
  context: Record<string, string | number | boolean>;
}

export type Send = (url: string, body: string) => void;

const MAX_STACK = 4000;

/** a readable message and stack from anything that was thrown */
export function describeError(err: unknown): { message: string; stack: string } {
  if (err instanceof Error) return { message: `${err.name}: ${err.message}`, stack: (err.stack ?? '').slice(0, MAX_STACK) };
  if (typeof err === 'string') return { message: err, stack: '' };
  try {
    return { message: JSON.stringify(err) ?? String(err), stack: '' };
  } catch {
    return { message: String(err), stack: '' };
  }
}

/** POST as text/plain (a CORS-safelisted type, so a cross-origin collector needs no preflight) */
export const beacon: Send = (url, body) => {
  try {
    if (navigator.sendBeacon?.(url, body)) return;
    void fetch(url, { method: 'POST', body, keepalive: true, headers: { 'content-type': 'text/plain' } }).catch(() => {});
  } catch {
    /* reporting must never throw */
  }
};

export interface ReporterOptions {
  build: string;
  /** where reports are sent; undefined = keep them local */
  endpoint?: string;
  send?: Send;
  page?: () => string;
  userAgent?: () => string;
  now?: () => Date;
}

export class ErrorReporter {
  /** distinct reports sent per page load at most (an error inside a loop must not flood the collector) */
  static readonly MAX_SENT = 10;
  /** the most recent reports, newest last */
  readonly recent: ErrorReport[] = [];
  /** game state attached to each report */
  context: () => ErrorReport['context'] = () => ({});
  private seen = new Set<string>();
  private sent = 0;

  constructor(private readonly opts: ReporterOptions) {}

  get sentCount(): number {
    return this.sent;
  }

  report(kind: ErrorKind, err: unknown, where = ''): ErrorReport {
    const { message, stack } = describeError(err);
    let context: ErrorReport['context'] = {};
    try {
      context = this.context();
    } catch {
      /* the game may be half-built: report without context */
    }
    const r: ErrorReport = {
      kind,
      where,
      message,
      stack,
      build: this.opts.build,
      page: safe(this.opts.page ?? (() => location.pathname + location.search)),
      userAgent: safe(this.opts.userAgent ?? (() => navigator.userAgent)),
      at: (this.opts.now?.() ?? new Date()).toISOString(),
      context,
    };
    this.recent.push(r);
    if (this.recent.length > 5) this.recent.shift();
    // the same error from the same place is sent once
    const key = `${kind}|${message}|${stack.split('\n')[1] ?? ''}`;
    if (this.opts.endpoint && !this.seen.has(key) && this.sent < ErrorReporter.MAX_SENT) {
      this.seen.add(key);
      this.sent++;
      try {
        (this.opts.send ?? beacon)(this.opts.endpoint, JSON.stringify(r));
      } catch {
        /* never throw from the reporter */
      }
    }
    return r;
  }

  /** plain text for the crash screen's "copy details" (what a player pastes into a bug report) */
  static details(r: ErrorReport): string {
    const ctx = Object.entries(r.context)
      .map(([k, v]) => `${k}=${v}`)
      .join(' ');
    return [`Court Feel ${r.build}`, `${r.at} · ${r.kind}${r.where ? ` in ${r.where}` : ''}`, r.message, ctx && `state: ${ctx}`, `page: ${r.page}`, `browser: ${r.userAgent}`, r.stack]
      .filter(Boolean)
      .join('\n');
  }
}

function safe(f: () => string): string {
  try {
    return f();
  } catch {
    return '';
  }
}
