import type { CanActivate, ExecutionContext } from "@nestjs/common";
import { Inject, Injectable, Logger } from "@nestjs/common";
import { Reflector } from "@nestjs/core";
import type { Request, Response } from "express";
import type { Env } from "../config/env";
import { APP_ENV } from "../config/tokens";
import { RateLimitedException } from "../common/exceptions/retry-after.exception";
import { CRITICAL_RATE_LIMITS, RATE_LIMIT_KEY, RATE_LIMITS } from "./rate-limit.decorator";
import type { RateLimitName } from "./rate-limit.decorator";
import { RateLimitService } from "./rate-limit.service";

interface LocalBucket {
  count: number;
  resetAt: number;
}

/**
 * Global, metadata-driven rate limiter (the Hono starter mounts `rateLimiter(name, windowMs, max)`
 * middleware on the same routes). Counters live in the database, so limits are shared by every
 * instance.
 *
 * Store failures are handled per RATE_LIMIT_ON_DB_FAILURE:
 * - `local` (default): the critical rates (auth, recovery, MFA) keep a temporary per-process
 *   window — a database outage must not switch off the protection of the routes attackers
 *   hit; every failure is logged and counted as a metric (hook your alerting there).
 * - `open`: everything is allowed (pure availability, the previous behaviour).
 * Non-critical rates fail open in both modes.
 */
@Injectable()
export class RateLimitGuard implements CanActivate {
  private readonly logger = new Logger(RateLimitGuard.name);
  /** Per-process windows, only consulted while the shared store is unavailable */
  private readonly localBuckets = new Map<string, LocalBucket>();

  /** Operational metrics: expose them to your monitoring (logs carry the same events). */
  readonly metrics = {
    storeFailures: 0,
    localAllowed: 0,
    localBlocked: 0,
    openAllowed: 0,
  };

  constructor(
    private readonly reflector: Reflector,
    private readonly store: RateLimitService,
    @Inject(APP_ENV) private readonly env: Env,
  ) {}

  async canActivate(ctx: ExecutionContext): Promise<boolean> {
    const name = this.reflector.getAllAndOverride<RateLimitName | undefined>(RATE_LIMIT_KEY, [
      ctx.getHandler(),
      ctx.getClass(),
    ]);
    if (!name) return true;

    const limit = RATE_LIMITS[name];
    const maxRequests = limit.max(this.env);
    const request = ctx.switchToHttp().getRequest<Request>();
    const response = ctx.switchToHttp().getResponse<Response>();

    // Proxy headers are only honoured when TRUST_PROXY is enabled (Express `trust proxy`)
    const ip = request.ip || "127.0.0.1";

    let bucket: Awaited<ReturnType<RateLimitService["hit"]>>;
    try {
      bucket = await this.store.hit(`rl:${name}:${ip}`, limit.windowMs);
    } catch (error) {
      return this.onStoreFailure(name, ip, maxRequests, limit.windowMs, response, error);
    }

    response.setHeader("X-RateLimit-Limit", maxRequests.toString());
    response.setHeader("X-RateLimit-Remaining", Math.max(0, maxRequests - bucket.count).toString());

    if (bucket.count > maxRequests) {
      const retryAfterSec = Math.max(1, Math.ceil((bucket.resetAt.getTime() - Date.now()) / 1000));
      throw new RateLimitedException(retryAfterSec);
    }

    return true;
  }

  /** Store outage: enforce locally on the critical rates, allow (and alert) elsewhere */
  private onStoreFailure(
    name: RateLimitName,
    ip: string,
    maxRequests: number,
    windowMs: number,
    response: Response,
    error: unknown,
  ): boolean {
    this.metrics.storeFailures += 1;
    const protectLocally =
      this.env.RATE_LIMIT_ON_DB_FAILURE === "local" && CRITICAL_RATE_LIMITS.has(name);

    if (!protectLocally) {
      this.metrics.openAllowed += 1;
      // Alert hook: an open limiter during an outage leaves the affected routes unprotected
      this.logger.error(
        `Rate limit store unavailable, allowing request without limit (rate=${name}): ${String(error)}`,
      );
      return true;
    }

    this.logger.error(
      `Rate limit store unavailable, enforcing rate=${name} from a local in-process window: ${String(error)}`,
    );
    const local = this.localHit(`rl:${name}:${ip}`, windowMs);
    response.setHeader("X-RateLimit-Limit", maxRequests.toString());
    response.setHeader("X-RateLimit-Remaining", Math.max(0, maxRequests - local.count).toString());
    if (local.count > maxRequests) {
      this.metrics.localBlocked += 1;
      const retryAfterSec = Math.max(1, Math.ceil((local.resetAt - Date.now()) / 1000));
      throw new RateLimitedException(retryAfterSec);
    }
    this.metrics.localAllowed += 1;
    return true;
  }

  /** Fixed window kept in memory; only runs while the shared store is down */
  private localHit(key: string, windowMs: number): LocalBucket {
    const now = Date.now();
    if (this.localBuckets.size > 1000) {
      for (const [existing, bucket] of this.localBuckets) {
        if (bucket.resetAt <= now) this.localBuckets.delete(existing);
      }
    }
    let bucket = this.localBuckets.get(key);
    if (!bucket || bucket.resetAt <= now) {
      bucket = { count: 0, resetAt: now + windowMs };
      this.localBuckets.set(key, bucket);
    }
    bucket.count += 1;
    return bucket;
  }
}
