import { Inject, Injectable } from "@nestjs/common";
import type { Env } from "../config/env";
import { APP_ENV } from "../config/tokens";
import { RateLimitService } from "./rate-limit.service";

/**
 * Tracks failed login attempts per account to lock out credential stuffing that rotates
 * source IPs. Successful logins clear the counter.
 *
 * Trade-off: because the key is the account, someone who knows an email can keep it locked
 * for `lockoutMs`. Tune LOGIN_LOCKOUT_* to your risk (same trade-off as the reference).
 */
@Injectable()
export class LoginLockoutService {
  private readonly maxFailures: number;
  private readonly lockoutMs: number;

  constructor(
    private readonly store: RateLimitService,
    @Inject(APP_ENV) env: Env,
  ) {
    this.maxFailures = env.LOGIN_LOCKOUT_MAX_FAILURES;
    this.lockoutMs = env.LOGIN_LOCKOUT_MINUTES * 60_000;
  }

  private keyOf(account: string): string {
    return `lockout:${account}`;
  }

  /** Seconds until the account unlocks, or 0 if login attempts are allowed */
  async retryAfterSeconds(account: string): Promise<number> {
    const bucket = await this.store.peek(this.keyOf(account));
    if (!bucket || bucket.count < this.maxFailures) return 0;
    return Math.max(1, Math.ceil((bucket.resetAt.getTime() - Date.now()) / 1000));
  }

  async recordFailure(account: string): Promise<void> {
    await this.store.hit(this.keyOf(account), this.lockoutMs);
    // The lockout is measured from the last failure, not from the first one
    await this.store.slide(this.keyOf(account), this.lockoutMs);
  }

  async reset(account: string): Promise<void> {
    await this.store.clear(this.keyOf(account));
  }
}
