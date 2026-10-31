import { Inject, Injectable, Logger } from "@nestjs/common";
import type { Env } from "../config/env";
import { APP_ENV } from "../config/tokens";
import { PrismaService } from "../database/prisma.service";
import { AccountMailService } from "./account-mail.service";
import type { AuthTokenType } from "./auth-tokens.service";

/** Backoff after each failed attempt (30/60/120/240 s; attempt 5 is terminal, ≈ 7.5 min total) */
const RETRY_BACKOFF_MS = [30_000, 60_000, 120_000, 240_000, 480_000];
const MAX_ATTEMPTS = RETRY_BACKOFF_MS.length;
/** A row stuck in `sending` this long means the worker died mid-delivery: claim it again */
const CLAIM_TIMEOUT_MS = 5 * 60_000;
const POLL_INTERVAL_MS = 30_000;

interface OutboxRow {
  id: string;
  userId: string;
  type: string;
  attempts: number;
}

/**
 * Durable delivery of account emails (audit item 10). Requests only persist an intent —
 * in the same transaction as their audit entry — and this worker performs the actual
 * send with bounded retries and exponential backoff. A process restart or a transient
 * SMTP failure no longer swallows a message that was already acknowledged with 202:
 * pending rows survive and are retried by whoever boots next.
 *
 * - The single-use AuthToken is minted at DELIVERY time (createAuthToken deletes any
 *   previous pending token of the same type), so raw tokens are never persisted.
 * - Claiming is a conditional single statement, so several instances sharing the database
 *   cannot deliver the same row twice.
 * - `metrics` and the log lines (debug=delivered, warn=retrying, error=gave up) are the
 *   hooks for delivery alerting.
 */
@Injectable()
export class EmailOutboxService {
  private readonly logger = new Logger(EmailOutboxService.name);
  private pollTimer?: NodeJS.Timeout;
  private kickTimer?: NodeJS.Timeout;
  private draining = false;

  /** Delivery metrics (hook your monitoring here and on the log lines below) */
  readonly metrics = { enqueued: 0, sent: 0, retried: 0, failed: 0 };

  constructor(
    private readonly prisma: PrismaService,
    private readonly accountMail: AccountMailService,
    @Inject(APP_ENV) private readonly env: Env,
  ) {}

  /**
   * Prisma write that creates the delivery intent — returns the operation so callers can
   * put it in the same `$transaction` as their audit entry.
   */
  enqueueOp(userId: string, type: AuthTokenType): ReturnType<PrismaService["emailOutbox"]["create"]> {
    this.metrics.enqueued += 1;
    return this.prisma.emailOutbox.create({ data: { userId, type } });
  }

  /** Schedules an immediate delivery attempt (debounced and always off the request path) */
  kick(): void {
    if (this.kickTimer) return;
    this.kickTimer = setTimeout(() => {
      this.kickTimer = undefined;
      void this.drain();
    }, 10);
    this.kickTimer.unref();
  }

  /** Starts the recurring worker: one immediate cycle plus a polling timer (unref'd) */
  start(intervalMs: number = POLL_INTERVAL_MS): void {
    this.kick();
    this.pollTimer = setInterval(() => void this.drain(), intervalMs);
    this.pollTimer.unref();
  }

  stop(): void {
    if (this.pollTimer) clearInterval(this.pollTimer);
    if (this.kickTimer) clearTimeout(this.kickTimer);
  }

  /** Delivers every currently-due row (single-flight per process) */
  async drain(): Promise<void> {
    if (this.draining) return;
    this.draining = true;
    try {
      for (;;) {
        const row = await this.claimNext();
        if (!row) break;
        await this.deliver(row);
      }
    } catch (error) {
      this.logger.error(`Email outbox drain failed: ${String(error)}`);
    } finally {
      this.draining = false;
    }
  }

  /** Reclaims rows abandoned by a crashed worker, then claims one due row atomically */
  private async claimNext(): Promise<OutboxRow | null> {
    const staleBefore = new Date(Date.now() - CLAIM_TIMEOUT_MS);
    await this.prisma.emailOutbox.updateMany({
      where: { status: "sending", claimedAt: { lt: staleBefore } },
      data: { status: "pending", claimedAt: null },
    });

    const due = await this.prisma.emailOutbox.findFirst({
      where: { status: "pending", nextAttemptAt: { lte: new Date() } },
      orderBy: { nextAttemptAt: "asc" },
    });
    if (!due) return null;

    const won = await this.prisma.emailOutbox.updateMany({
      where: { id: due.id, status: "pending" },
      data: { status: "sending", claimedAt: new Date() },
    });
    // Lost the race against another worker: this row is no longer pending, so the next
    // iteration naturally moves to another one (or finishes the drain)
    if (won.count !== 1) return null;
    return due;
  }

  private async deliver(row: OutboxRow): Promise<void> {
    // A transport that never delivers: retrying cannot change the outcome inside this
    // process — retire the row now (rows survive a restart with a fixed transport only
    // when they stay pending, which is why the user can always re-request the link)
    if (this.env.MAIL_TRANSPORT === "none") {
      await this.failTerminal(row, "MAIL_TRANSPORT=none: nothing is configured to deliver");
      return;
    }

    const user = await this.prisma.user.findUnique({ where: { id: row.userId } });
    if (!user || user.deletedAt || user.isBlocked) {
      await this.failTerminal(row, "account no longer deliverable");
      return;
    }

    try {
      const delivered =
        row.type === "email_verify"
          ? await this.accountMail.sendVerificationEmail(user)
          : await this.accountMail.sendPasswordResetEmail(user);
      if (delivered) {
        await this.prisma.emailOutbox.update({
          where: { id: row.id },
          data: { status: "sent", sentAt: new Date(), claimedAt: null, lastError: null },
        });
        this.metrics.sent += 1;
        this.logger.debug(`Email delivered (type=${row.type}, attempts=${row.attempts + 1})`);
        return;
      }
      await this.finish(row, "mail transport did not accept the message");
    } catch (error) {
      await this.finish(row, String(error));
    }
  }

  /**
   * Terminal failure without a delivery attempt: the outcome cannot change by retrying
   * (no transport configured, or no deliverable account), so the row is retired at once
   * and the condition is surfaced through `metrics.failed` and a warning.
   */
  private async failTerminal(row: OutboxRow, reason: string): Promise<void> {
    await this.prisma.emailOutbox.update({
      where: { id: row.id },
      data: {
        status: "failed",
        attempts: row.attempts + 1,
        lastError: reason.slice(0, 500),
        claimedAt: null,
      },
    });
    this.metrics.failed += 1;
    this.logger.warn(`Email retired without delivery (type=${row.type}): ${reason}`);
  }

  /** Records a failed attempt: schedules the next retry, or gives up at MAX_ATTEMPTS */
  private async finish(row: OutboxRow, lastError: string): Promise<void> {
    const attempts = row.attempts + 1;
    const error = lastError.slice(0, 500);
    if (attempts >= MAX_ATTEMPTS) {
      await this.prisma.emailOutbox.update({
        where: { id: row.id },
        data: { status: "failed", attempts, lastError: error, claimedAt: null },
      });
      this.metrics.failed += 1;
      // Alert hook: a message the user is waiting for will never arrive
      this.logger.error(
        `Email delivery abandoned after ${attempts} attempts (type=${row.type}): ${error}`,
      );
      return;
    }
    const backoff = RETRY_BACKOFF_MS[attempts - 1] ?? RETRY_BACKOFF_MS[RETRY_BACKOFF_MS.length - 1];
    await this.prisma.emailOutbox.update({
      where: { id: row.id },
      data: {
        status: "pending",
        attempts,
        lastError: error,
        claimedAt: null,
        nextAttemptAt: new Date(Date.now() + backoff),
      },
    });
    this.metrics.retried += 1;
    this.logger.warn(
      `Email delivery failed (attempt ${attempts}/${MAX_ATTEMPTS}, type=${row.type}), retrying in ${Math.round(backoff / 1000)}s: ${error}`,
    );
  }
}
