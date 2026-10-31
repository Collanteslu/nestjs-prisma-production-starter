import { Inject, Injectable, Logger } from "@nestjs/common";
import type { Env } from "../config/env";
import { APP_ENV } from "../config/tokens";
import { pseudonym } from "../common/utils/pii";
import { RateLimitService } from "./rate-limit.service";

/**
 * Tracks failed login attempts per account to lock out credential stuffing that rotates
 * source IPs. Successful logins clear the counter.
 *
 * Trade-off (deliberate, inherited from the reference): because the key is the account,
 * someone who knows an email can keep it locked for `lockoutMs` — a bounded denial-of-
 * service against that one account. It is the price of stopping distributed credential
 * stuffing, and it is time-boxed by LOGIN_LOCKOUT_*: the account always unlocks itself,
 * no operator action is needed (AGENTS.md, "Compensaciones de seguridad"). Engagement is
 * logged as a warning so alerting can detect abuse of the mechanism. Tune LOGIN_LOCKOUT_*
 * to your risk (same trade-off and windows as the reference).
 *
 * The bucket key stores a pseudonym of the account, never the raw email (the counter must
 * be shared across instances, so the pseudonym is keyed with JWT_SECRET — see pii.ts).
 */
@Injectable()
export class LoginLockoutService {
  private readonly logger = new Logger(LoginLockoutService.name);
  private readonly maxFailures: number;
  private readonly lockoutMs: number;

  constructor(
    private readonly store: RateLimitService,
    @Inject(APP_ENV) private readonly env: Env,
  ) {
    this.maxFailures = env.LOGIN_LOCKOUT_MAX_FAILURES;
    this.lockoutMs = env.LOGIN_LOCKOUT_MINUTES * 60_000;
  }

  private keyOf(account: string): string {
    return `lockout:${pseudonym(this.env.JWT_SECRET, account)}`;
  }

  /** Seconds until the account unlocks, or 0 if login attempts are allowed */
  async retryAfterSeconds(account: string): Promise<number> {
    const bucket = await this.store.peek(this.keyOf(account));
    if (!bucket || bucket.count < this.maxFailures) return 0;
    return Math.max(1, Math.ceil((bucket.resetAt.getTime() - Date.now()) / 1000));
  }

  async recordFailure(account: string): Promise<void> {
    // One atomic store statement: the count and the sliding window (measured from the last
    // failure) change together. The count is this failure's own, so it equals maxFailures for
    // exactly one failure: the alert fires once per engagement.
    const hit = await this.store.hit(this.keyOf(account), this.lockoutMs, { slide: true });
    if (hit.count === this.maxFailures) {
      const until = new Date(Date.now() + this.lockoutMs);
      this.logger.warn(
        `Account lockout engaged after ${this.maxFailures} failed login attempts ` +
          `(account=${pseudonym(this.env.JWT_SECRET, account)}, until=${until.toISOString()})`,
      );
    }
  }

  async reset(account: string): Promise<void> {
    await this.store.clear(this.keyOf(account));
  }
}
