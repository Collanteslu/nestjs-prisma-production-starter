import { Inject, Injectable } from "@nestjs/common";
import type { Env } from "../config/env";
import { APP_ENV } from "../config/tokens";
import { RateLimitService } from "./rate-limit.service";

/**
 * Tracks failed password confirmations per account (port of `passwordConfirmLockout`):
 * every endpoint that re-confirms the account password shares one counter (PUT
 * /api/users/:id and MFA enrolment/disable), so moving between them does not reset
 * it and a stolen access token cannot buy unlimited attempts by rotating source IPs.
 * Only WRONG confirmations count, so a legitimate client is never throttled.
 */
@Injectable()
export class PasswordConfirmLockoutService {
  private readonly maxFailures: number;
  private readonly lockoutMs: number;

  constructor(
    private readonly store: RateLimitService,
    @Inject(APP_ENV) env: Env,
  ) {
    this.maxFailures = env.LOGIN_LOCKOUT_MAX_FAILURES;
    this.lockoutMs = env.LOGIN_LOCKOUT_MINUTES * 60_000;
  }

  private keyOf(userId: string): string {
    return `lockout:password-confirm:${userId}`;
  }

  /** Seconds until the account unlocks, or 0 if confirmations are allowed */
  async retryAfterSeconds(userId: string): Promise<number> {
    const bucket = await this.store.peek(this.keyOf(userId));
    if (!bucket || bucket.count < this.maxFailures) return 0;
    return Math.max(1, Math.ceil((bucket.resetAt.getTime() - Date.now()) / 1000));
  }

  async recordFailure(userId: string): Promise<void> {
    await this.store.hit(this.keyOf(userId), this.lockoutMs);
    // The lockout is measured from the last failure, not from the first one
    await this.store.slide(this.keyOf(userId), this.lockoutMs);
  }

  async reset(userId: string): Promise<void> {
    await this.store.clear(this.keyOf(userId));
  }
}
