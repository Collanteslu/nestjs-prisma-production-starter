import { Inject, Injectable, Logger } from "@nestjs/common";
import type { Env } from "../config/env";
import { APP_ENV } from "../config/tokens";
import { PrismaService } from "../database/prisma.service";
import { RateLimitService } from "../rate-limit/rate-limit.service";

const DAY_MS = 24 * 60 * 60 * 1000;
/** Days a used MFA recovery code is kept (for inspection) before it is purged */
const USED_RECOVERY_CODE_RETENTION_DAYS = 30;

export interface CleanupCounts {
  deletedSessions: number;
  deletedTokens: number;
  deletedBuckets: number;
  deletedAuditLogs: number;
}

/**
 * Background garbage collection (port of jobs/cleanup.ts): purges expired sessions, stale
 * refresh tokens, emailed tokens, used MFA recovery codes, ended rate-limit windows and old
 * audit entries. Keeps the SQLite database performant and prevents storage bloat.
 * Started from main.ts after the seed: one non-blocking cycle plus an hourly unref'd timer.
 */
@Injectable()
export class CleanupService {
  private readonly logger = new Logger(CleanupService.name);
  private timer?: NodeJS.Timeout;

  constructor(
    private readonly prisma: PrismaService,
    private readonly rateLimit: RateLimitService,
    @Inject(APP_ENV) private readonly env: Env,
  ) {}

  /** Executes a cleanup cycle deleting expired sessions and tokens. @returns Counts of purged rows */
  async runOnce(): Promise<CleanupCounts> {
    try {
      const now = new Date();

      const [sessionsRes, tokensRes] = await this.prisma.$transaction([
        // 1. Purge sessions that are either naturally expired or marked inactive for >24 hours
        //    (refresh tokens of deleted sessions are removed by the ON DELETE CASCADE relation)
        this.prisma.session.deleteMany({
          where: {
            OR: [
              { expiresAt: { lt: now } },
              { isActive: false, updatedAt: { lt: new Date(now.getTime() - DAY_MS) } },
            ],
          },
        }),
        // 2. Purge expired tokens and tokens rotated more than 24 hours ago. A replay of a purged
        //    token is still detected as reuse because it no longer matches any stored hash.
        this.prisma.refreshToken.deleteMany({
          where: {
            OR: [
              { expiresAt: { lt: now } },
              { usedAt: { lt: new Date(now.getTime() - DAY_MS) } },
            ],
          },
        }),
      ]);

      // 3. Purge ended rate-limit windows and audit entries past the retention period
      const deletedBuckets = await this.rateLimit.purgeExpired();
      // Emailed tokens past their expiry (or used more than a day ago) are of no further use
      await this.prisma.authToken.deleteMany({
        where: {
          OR: [
            { expiresAt: { lt: now } },
            { usedAt: { lt: new Date(now.getTime() - DAY_MS) } },
          ],
        },
      });
      // Used MFA recovery codes can never work again; unused ones stay until 2FA is reset
      await this.prisma.recoveryCode.deleteMany({
        where: {
          usedAt: { lt: new Date(now.getTime() - USED_RECOVERY_CODE_RETENTION_DAYS * DAY_MS) },
        },
      });
      const deletedAuditLogs =
        this.env.AUDIT_RETENTION_DAYS > 0
          ? (
              await this.prisma.auditLog.deleteMany({
                where: {
                  createdAt: {
                    lt: new Date(now.getTime() - this.env.AUDIT_RETENTION_DAYS * DAY_MS),
                  },
                },
              })
            ).count
          : 0;

      if (sessionsRes.count > 0 || tokensRes.count > 0 || deletedAuditLogs > 0) {
        this.logger.log(
          `Cleanup routine purged expired sessions, tokens and old audit entries ` +
            `(sessions=${sessionsRes.count}, tokens=${tokensRes.count}, ` +
            `buckets=${deletedBuckets}, auditLogs=${deletedAuditLogs})`,
        );
      }

      return {
        deletedSessions: sessionsRes.count,
        deletedTokens: tokensRes.count,
        deletedBuckets,
        deletedAuditLogs,
      };
    } catch (error) {
      this.logger.error(`Error during session cleanup routine: ${String(error)}`);
      return { deletedSessions: 0, deletedTokens: 0, deletedBuckets: 0, deletedAuditLogs: 0 };
    }
  }

  /**
   * Schedules periodic execution of the cleanup routine.
   * @param intervalMs Time between cycles in milliseconds (default: 1 hour)
   */
  start(intervalMs: number = 60 * 60 * 1000): void {
    // Run an initial non-blocking cycle on startup
    void this.runOnce();

    this.timer = setInterval(() => void this.runOnce(), intervalMs);
    // Unref the timer so it does not keep the Node process alive during shutdown
    this.timer.unref();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
  }
}
