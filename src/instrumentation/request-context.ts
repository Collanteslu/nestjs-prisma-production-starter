import { randomUUID } from "node:crypto";
import { AsyncLocalStorage } from "node:async_hooks";
import type { NextFunction, Request, Response } from "express";

/**
 * Per-request context (request id + start time) shared by the envelope interceptor
 * and the exception filter. The middleware that populates it runs FIRST — before
 * body parsing, guards and rate limiting — so every response (even 401/429/413)
 * carries X-Request-Id, X-Response-Time and Server-Timing, mirroring the reference
 * implementation's requestId middleware ordering.
 */
export interface RequestContext {
  requestId: string;
  startedAtNs: bigint;
  ip: string;
  userAgent?: string;
}

export const requestContext = new AsyncLocalStorage<RequestContext>();

/** Single source of truth for the API version (keep in sync with package.json). */
export const API_VERSION = "2.0.0";

const REQUEST_ID_RE = /^[A-Za-z0-9._:-]{1,128}$/;

export function getRequestContext(): RequestContext | undefined {
  return requestContext.getStore();
}

/** Elapsed ms since request start with 2 decimals (reference: `1.44`, `18.27`). */
export function elapsedMs(ctx: RequestContext): number {
  return Math.round(Number(process.hrtime.bigint() - ctx.startedAtNs) / 1e4) / 100;
}

/**
 * Telemetry block shared by the success envelope and every error body:
 * `{requestId, timestamp, durationMs, apiVersion}` — undefined outside a request
 * (the key is then dropped from the JSON body).
 */
export function buildMeta(): Record<string, unknown> | undefined {
  const ctx = requestContext.getStore();
  if (!ctx) return undefined;
  return {
    requestId: ctx.requestId,
    timestamp: new Date().toISOString(),
    durationMs: elapsedMs(ctx),
    apiVersion: API_VERSION,
  };
}

/**
 * Express middleware: assigns/echoes X-Request-Id, measures duration and installs
 * the timing headers before the response is flushed (res.end is wrapped).
 */
export function requestContextMiddleware(req: Request, res: Response, next: NextFunction): void {
  const incoming = req.header("x-request-id");
  const requestId = incoming && REQUEST_ID_RE.test(incoming) ? incoming : randomUUID();
  const startedAtNs = process.hrtime.bigint();

  res.setHeader("X-Request-Id", requestId);

  const originalEnd = res.end.bind(res);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (res as any).end = (...args: any[]) => {
    if (!res.headersSent) {
      const ms = Math.round(Number(process.hrtime.bigint() - startedAtNs) / 1e4) / 100;
      res.setHeader("X-Response-Time", `${ms}ms`);
      res.setHeader("Server-Timing", `total;dur=${ms}`);
    }
    return (originalEnd as (...a: unknown[]) => unknown)(...args);
  };

  requestContext.run(
    {
      requestId,
      startedAtNs,
      ip: req.ip ?? req.socket.remoteAddress ?? "unknown",
      userAgent: req.header("user-agent"),
    },
    next,
  );
}
