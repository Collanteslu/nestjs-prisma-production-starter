import { HttpException } from "@nestjs/common";

/**
 * 429 produced by the DB-backed rate limiter. The Hono starter body carries
 * `retryAfterSeconds` at the TOP level (instead of the usual `details`) plus a
 * `Retry-After` header; the global filter renders both.
 */
export class RateLimitedException extends HttpException {
  constructor(
    readonly retryAfterSeconds: number,
    message = "Too many requests. Please slow down and try again later.",
  ) {
    super(message, 429);
  }
}

/**
 * Any-status error that also sets a `Retry-After` header while keeping the standard
 * error envelope (e.g. the per-account login lockout, which answers 429 without a
 * top-level `retryAfterSeconds`).
 */
export class RetryAfterException extends HttpException {
  constructor(
    message: string,
    status: number,
    readonly retryAfterSeconds: number,
  ) {
    super(message, status);
  }
}
