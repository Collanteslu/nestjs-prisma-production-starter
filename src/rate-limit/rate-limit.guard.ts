import type { CanActivate, ExecutionContext } from "@nestjs/common";
import { Inject, Injectable, Logger } from "@nestjs/common";
import { Reflector } from "@nestjs/core";
import type { Request, Response } from "express";
import type { Env } from "../config/env";
import { APP_ENV } from "../config/tokens";
import { RateLimitedException } from "../common/exceptions/retry-after.exception";
import { RATE_LIMIT_KEY, RATE_LIMITS } from "./rate-limit.decorator";
import type { RateLimitName } from "./rate-limit.decorator";
import { RateLimitService } from "./rate-limit.service";

/**
 * Global, metadata-driven rate limiter (the reference mounts `rateLimiter(name, windowMs, max)`
 * middleware on the same routes). Counters live in the database, so limits are shared by every
 * instance. A broken counter store fails OPEN (a store outage must not take the API down).
 */
@Injectable()
export class RateLimitGuard implements CanActivate {
  private readonly logger = new Logger(RateLimitGuard.name);

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
      this.logger.error(`Rate limit store unavailable, allowing request: ${String(error)}`);
      return true;
    }

    response.setHeader("X-RateLimit-Limit", maxRequests.toString());
    response.setHeader(
      "X-RateLimit-Remaining",
      Math.max(0, maxRequests - bucket.count).toString(),
    );

    if (bucket.count > maxRequests) {
      const retryAfterSec = Math.max(1, Math.ceil((bucket.resetAt.getTime() - Date.now()) / 1000));
      throw new RateLimitedException(retryAfterSec);
    }

    return true;
  }
}
