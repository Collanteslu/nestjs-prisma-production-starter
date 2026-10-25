import { parseEnv } from "../src/config/env";
import type { PrismaService } from "../src/database/prisma.service";
import { AccountMailService } from "../src/mail/account-mail.service";
import { EmailOutboxService } from "../src/mail/email-outbox.service";

/**
 * Retry policy of the durable outbox (audit item 10): bounded attempts with backoff,
 * terminal states, no delivery of raw tokens from storage, and the `MAIL_TRANSPORT=none`
 * short-circuit. Uses an in-memory fake of the two Prisma models the worker touches.
 */
describe("EmailOutboxService delivery policy", () => {
  interface Row {
    id: string;
    userId: string;
    type: string;
    status: string;
    attempts: number;
    nextAttemptAt: Date;
    claimedAt: Date | null;
    lastError: string | null;
    sentAt: Date | null;
    createdAt: Date;
  }

  const buildPrisma = (
    rows: Row[],
    users: Map<string, { id: string; deletedAt: Date | null; isBlocked: boolean } | null>,
  ) => {
    const store = {
      emailOutbox: {
        create: jest.fn(async ({ data }: { data: { userId: string; type: string } }) => {
          const row: Row = {
            id: `row-${rows.length + 1}`,
            userId: data.userId,
            type: data.type,
            status: "pending",
            attempts: 0,
            nextAttemptAt: new Date(),
            claimedAt: null,
            lastError: null,
            sentAt: null,
            createdAt: new Date(),
          };
          rows.push(row);
          return row;
        }),
        findFirst: jest.fn(async () => {
          const due = rows.find(
            (r) => r.status === "pending" && r.nextAttemptAt.getTime() <= Date.now(),
          );
          return due ?? null;
        }),
        updateMany: jest.fn(
          async ({
            where,
            data,
          }: {
            where: Record<string, unknown>;
            data: Record<string, unknown>;
          }) => {
            if ("status" in where && "id" in where) {
              const row = rows.find((r) => r.id === (where as { id: string }).id);
              if (!row || row.status !== where.status) return { count: 0 };
              Object.assign(row, data);
              return { count: 1 };
            }
            if ((where as { status?: string }).status === "sending") {
              // stale-claim reclaim
              let count = 0;
              for (const row of rows) {
                if (row.status === "sending") {
                  Object.assign(row, data);
                  count += 1;
                }
              }
              return { count };
            }
            return { count: 0 };
          },
        ),
        update: jest.fn(
          async ({ where, data }: { where: { id: string }; data: Record<string, unknown> }) => {
            const row = rows.find((r) => r.id === where.id);
            if (!row) throw new Error("missing row");
            Object.assign(row, data);
            return row;
          },
        ),
      },
      user: {
        findUnique: jest.fn(
          async ({ where }: { where: { id: string } }) => users.get(where.id) ?? null,
        ),
      },
    };
    return store as unknown as PrismaService;
  };

  const envWith = (transport: string) =>
    parseEnv({
      AUTH_MODE: "none",
      MAIL_TRANSPORT: transport,
      ...(transport === "smtp" ? { SMTP_URL: "smtp://127.0.0.1:1" } : {}),
    });

  const user = { id: "user-1", deletedAt: null, isBlocked: false };

  it("marks a successful delivery as sent and counts the metric", async () => {
    const rows: Row[] = [];
    const prisma = buildPrisma(rows, new Map([[user.id, user]]));
    const accountMail = {
      sendVerificationEmail: jest.fn().mockResolvedValue(true),
      sendPasswordResetEmail: jest.fn().mockResolvedValue(true),
    } as unknown as AccountMailService;
    const svc = new EmailOutboxService(prisma, accountMail, envWith("smtp"));

    await svc.enqueueOp(user.id, "email_verify");
    await svc.drain();

    expect(rows[0]?.status).toBe("sent");
    expect(rows[0]?.sentAt).toBeInstanceOf(Date);
    expect(svc.metrics.sent).toBe(1);
    expect(accountMail.sendVerificationEmail).toHaveBeenCalledTimes(1);
    // the token is minted by the mailer at delivery time, never read from the row
    expect(rows[0]).not.toHaveProperty("token");
  });

  it("retries with backoff up to MAX_ATTEMPTS, then goes terminal 'failed'", async () => {
    const rows: Row[] = [];
    const prisma = buildPrisma(rows, new Map([[user.id, user]]));
    const accountMail = {
      sendVerificationEmail: jest.fn().mockResolvedValue(false),
      sendPasswordResetEmail: jest.fn().mockResolvedValue(false),
    } as unknown as AccountMailService;
    const svc = new EmailOutboxService(prisma, accountMail, envWith("smtp"));

    await svc.enqueueOp(user.id, "password_reset");
    for (let i = 0; i < 5; i++) {
      await svc.drain();
      // make the backoff due immediately to simulate the passage of time
      if (rows[0]?.status === "pending") rows[0].nextAttemptAt = new Date(Date.now() - 1);
    }

    expect(rows[0]?.status).toBe("failed");
    expect(rows[0]?.attempts).toBe(5);
    expect(rows[0]?.lastError).toBeTruthy();
    expect(svc.metrics.retried).toBe(4); // attempts 1..4 schedule a retry
    expect(svc.metrics.failed).toBe(1); // attempt 5 gives up
    expect(accountMail.sendPasswordResetEmail).toHaveBeenCalledTimes(5);
  });

  it("retires the row immediately when nothing can deliver (MAIL_TRANSPORT=none)", async () => {
    const rows: Row[] = [];
    const prisma = buildPrisma(rows, new Map([[user.id, user]]));
    const accountMail = {
      sendVerificationEmail: jest.fn(),
      sendPasswordResetEmail: jest.fn(),
    } as unknown as AccountMailService;
    const svc = new EmailOutboxService(prisma, accountMail, envWith("none"));

    await svc.enqueueOp(user.id, "email_verify");
    await svc.drain();

    expect(rows[0]?.status).toBe("failed");
    expect(rows[0]?.attempts).toBe(1);
    expect(rows[0]?.lastError).toContain("MAIL_TRANSPORT=none");
    expect(accountMail.sendVerificationEmail).not.toHaveBeenCalled();
  });

  it("does not deliver to deleted or blocked accounts", async () => {
    const rows: Row[] = [];
    const prisma = buildPrisma(
      rows,
      new Map([[user.id, { id: user.id, deletedAt: new Date(), isBlocked: false }]]),
    );
    const accountMail = {
      sendVerificationEmail: jest.fn().mockResolvedValue(true),
      sendPasswordResetEmail: jest.fn().mockResolvedValue(true),
    } as unknown as AccountMailService;
    const svc = new EmailOutboxService(prisma, accountMail, envWith("smtp"));

    await svc.enqueueOp(user.id, "email_verify");
    await svc.drain();

    expect(rows[0]?.status).toBe("failed");
    expect(rows[0]?.lastError).toContain("no longer deliverable");
    expect(accountMail.sendVerificationEmail).not.toHaveBeenCalled();
  });
});
