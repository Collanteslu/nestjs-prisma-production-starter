import "reflect-metadata";
import { execFileSync } from "node:child_process";
import type { INestApplication } from "@nestjs/common";
import { Test } from "@nestjs/testing";
import { AppModule } from "../src/app.module";
import { loadEnv } from "../src/config/env";
import { PrismaService } from "../src/database/prisma.service";
import { RateLimitService } from "../src/rate-limit/rate-limit.service";
import { CleanupService } from "../src/jobs/cleanup.service";

/**
 * Purge predicates of the hourly cleanup job (audit finding: security-relevant data
 * lifecycle with no automated guard). Every entity family is seeded with rows on both
 * sides of each cutoff; one runOnce() must delete exactly the expired side. Row
 * survival is asserted by id, so residue from other suites in the shared tmp database
 * cannot make these tests lie.
 */
const DAY = 24 * 60 * 60 * 1000;
const PREFIX = "cleanup-spec-";
const ago = (days: number) => new Date(Date.now() - days * DAY);
const ahead = (days: number) => new Date(Date.now() + days * DAY);

describe("CleanupService: purge predicates (data lifecycle)", () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let rateLimit: RateLimitService;
  let env: ReturnType<typeof loadEnv>;

  beforeAll(async () => {
    execFileSync("npx", ["prisma", "migrate", "deploy"], {
      encoding: "utf8",
      env: process.env,
    });
    env = loadEnv();
    const moduleRef = await Test.createTestingModule({
      imports: [AppModule.forRoot(env)],
    }).compile();
    app = moduleRef.createNestApplication({ bodyParser: false });
    await app.init();
    prisma = app.get(PrismaService);
    rateLimit = app.get(RateLimitService);

    await prisma.user.upsert({
      where: { id: `${PREFIX}user` },
      update: {},
      create: {
        id: `${PREFIX}user`,
        name: "Cleanup Spec",
        email: `cleanup-spec-${Date.now()}@example.com`,
        password: "not-a-real-hash",
        role: "user",
      },
    });
  }, 60_000);

  afterAll(async () => {
    await app.close();
  });

  /** Removes rows left by a previous run of this same spec, so reruns stay deterministic */
  const clearSpecResidue = async () => {
    await prisma.session.deleteMany({ where: { id: { startsWith: PREFIX } } });
    await prisma.refreshToken.deleteMany({ where: { tokenHash: { startsWith: PREFIX } } });
    await prisma.authToken.deleteMany({ where: { tokenHash: { startsWith: PREFIX } } });
    await prisma.recoveryCode.deleteMany({ where: { codeHash: { startsWith: PREFIX } } });
    await prisma.auditLog.deleteMany({ where: { id: { startsWith: PREFIX } } });
    await prisma.emailOutbox.deleteMany({ where: { id: { startsWith: PREFIX } } });
    await prisma.rateLimitBucket.deleteMany({ where: { key: { startsWith: PREFIX } } });
  };

  it("deletes exactly the expired side of every entity family", async () => {
    await clearSpecResidue();
    const user = { userId: `${PREFIX}user` };

    // Sessions: expired, or inactive for more than 24 h
    await prisma.session.createMany({
      data: [
        { id: `${PREFIX}s-expired`, ...user, isActive: true, expiresAt: ago(2), updatedAt: ago(2) },
        {
          id: `${PREFIX}s-inactive-old`,
          ...user,
          isActive: false,
          expiresAt: ahead(7),
          updatedAt: ago(2),
        },
        {
          id: `${PREFIX}s-inactive-recent`,
          ...user,
          isActive: false,
          expiresAt: ahead(7),
          updatedAt: ago(0.02),
        },
        { id: `${PREFIX}s-active`, ...user, isActive: true, expiresAt: ahead(7) },
      ],
    });

    // Refresh tokens: expired, or rotated more than 24 h ago
    await prisma.refreshToken.createMany({
      data: [
        { tokenHash: `${PREFIX}rt-expired`, ...user, expiresAt: ago(1) },
        { tokenHash: `${PREFIX}rt-used-old`, ...user, expiresAt: ahead(7), usedAt: ago(2) },
        { tokenHash: `${PREFIX}rt-used-recent`, ...user, expiresAt: ahead(7), usedAt: ago(0.02) },
        { tokenHash: `${PREFIX}rt-fresh`, ...user, expiresAt: ahead(7) },
      ],
    });

    // Emailed tokens: expired, or used more than a day ago
    await prisma.authToken.createMany({
      data: [
        {
          tokenHash: `${PREFIX}at-expired`,
          ...user,
          type: "password_reset",
          email: "cleanup@example.com",
          expiresAt: ago(1),
        },
        {
          tokenHash: `${PREFIX}at-used-old`,
          ...user,
          type: "email_verify",
          email: "cleanup@example.com",
          expiresAt: ahead(1),
          usedAt: ago(2),
        },
        {
          tokenHash: `${PREFIX}at-pending`,
          ...user,
          type: "password_reset",
          email: "cleanup@example.com",
          expiresAt: ahead(1),
        },
      ],
    });

    // Recovery codes: only USED ones older than the retention window
    await prisma.recoveryCode.createMany({
      data: [
        { codeHash: `${PREFIX}rc-used-old`, ...user, usedAt: ago(40) },
        { codeHash: `${PREFIX}rc-used-recent`, ...user, usedAt: ago(1) },
        { codeHash: `${PREFIX}rc-unused`, ...user },
      ],
    });

    // Audit retention (default 90 days; 0 keeps forever — covered below)
    await prisma.auditLog.createMany({
      data: [
        { id: `${PREFIX}al-old`, action: "CREATE", entity: "Task", createdAt: ago(100) },
        { id: `${PREFIX}al-recent`, action: "CREATE", entity: "Task", createdAt: ago(1) },
      ],
    });

    // Outbox: only TERMINAL rows (sent/failed) older than 30 days
    await prisma.emailOutbox.createMany({
      data: [
        { id: `${PREFIX}ox-sent-old`, ...user, type: "password_reset", status: "sent", createdAt: ago(40) },
        { id: `${PREFIX}ox-failed-old`, ...user, type: "email_verify", status: "failed", createdAt: ago(40) },
        { id: `${PREFIX}ox-sent-recent`, ...user, type: "password_reset", status: "sent", createdAt: ago(1) },
        { id: `${PREFIX}ox-pending-old`, ...user, type: "email_verify", status: "pending", createdAt: ago(40) },
      ],
    });

    // Rate-limit windows: only the ones that already reset
    await prisma.rateLimitBucket.createMany({
      data: [
        { key: `${PREFIX}bucket-expired`, count: 3, resetAt: ago(1) },
        { key: `${PREFIX}bucket-live`, count: 3, resetAt: ahead(1) },
      ],
    });

    const counts = await new CleanupService(prisma, rateLimit, env).runOnce();

    const session = async (id: string) =>
      Boolean(await prisma.session.findUnique({ where: { id: `${PREFIX}${id}` } }));
    expect(await session("s-expired")).toBe(false);
    expect(await session("s-inactive-old")).toBe(false);
    expect(await session("s-inactive-recent")).toBe(true);
    expect(await session("s-active")).toBe(true);

    const token = async (hash: string) =>
      Boolean(
        await prisma.refreshToken.findUnique({ where: { tokenHash: `${PREFIX}${hash}` } }),
      );
    expect(await token("rt-expired")).toBe(false);
    expect(await token("rt-used-old")).toBe(false);
    expect(await token("rt-used-recent")).toBe(true);
    expect(await token("rt-fresh")).toBe(true);

    const emailed = async (hash: string) =>
      Boolean(await prisma.authToken.findUnique({ where: { tokenHash: `${PREFIX}${hash}` } }));
    expect(await emailed("at-expired")).toBe(false);
    expect(await emailed("at-used-old")).toBe(false);
    expect(await emailed("at-pending")).toBe(true);

    const code = async (hash: string) =>
      Boolean(
        await prisma.recoveryCode.findUnique({
          where: {
            userId_codeHash: { userId: `${PREFIX}user`, codeHash: `${PREFIX}${hash}` },
          },
        }),
      );
    expect(await code("rc-used-old")).toBe(false);
    expect(await code("rc-used-recent")).toBe(true);
    expect(await code("rc-unused")).toBe(true);

    const audit = async (id: string) =>
      Boolean(await prisma.auditLog.findUnique({ where: { id: `${PREFIX}${id}` } }));
    expect(await audit("al-old")).toBe(false);
    expect(await audit("al-recent")).toBe(true);

    const outbox = async (id: string) =>
      Boolean(await prisma.emailOutbox.findUnique({ where: { id: `${PREFIX}${id}` } }));
    expect(await outbox("ox-sent-old")).toBe(false);
    expect(await outbox("ox-failed-old")).toBe(false);
    expect(await outbox("ox-sent-recent")).toBe(true);
    expect(await outbox("ox-pending-old")).toBe(true);

    const bucket = async (key: string) =>
      Boolean(await prisma.rateLimitBucket.findUnique({ where: { key: `${PREFIX}${key}` } }));
    expect(await bucket("bucket-expired")).toBe(false);
    expect(await bucket("bucket-live")).toBe(true);

    // The reported counts saw at least this cycle's deletions (the shared tmp database
    // may hold additional expired residue from other suites, hence >=)
    expect(counts.deletedSessions).toBeGreaterThanOrEqual(2);
    expect(counts.deletedTokens).toBeGreaterThanOrEqual(2);
    expect(counts.deletedBuckets).toBeGreaterThanOrEqual(1);
    expect(counts.deletedAuditLogs).toBeGreaterThanOrEqual(1);
    expect(counts.deletedOutbox).toBeGreaterThanOrEqual(2);
  });

  it("keeps audit rows forever when AUDIT_RETENTION_DAYS=0", async () => {
    await prisma.auditLog.deleteMany({ where: { id: { startsWith: `${PREFIX}al-zero` } } });
    await prisma.auditLog.create({
      data: { id: `${PREFIX}al-zero`, action: "CREATE", entity: "Task", createdAt: ago(400) },
    });
    await new CleanupService(prisma, rateLimit, { ...env, AUDIT_RETENTION_DAYS: 0 }).runOnce();
    expect(
      Boolean(await prisma.auditLog.findUnique({ where: { id: `${PREFIX}al-zero` } })),
    ).toBe(true);
  });

  it("start() schedules cycles and stop() clears the timer without keeping the loop alive", async () => {
    const job = new CleanupService(prisma, rateLimit, env);
    expect(() => {
      job.start(50);
      job.stop();
    }).not.toThrow();
  });

  it("a store failure returns zero counts instead of crashing the cycle", async () => {
    const brokenStore = {
      purgeExpired: async () => {
        throw new Error("store down");
      },
    } as unknown as RateLimitService;
    const counts = await new CleanupService(prisma, brokenStore, env).runOnce();
    expect(counts).toEqual({
      deletedSessions: 0,
      deletedTokens: 0,
      deletedBuckets: 0,
      deletedAuditLogs: 0,
      deletedOutbox: 0,
    });
  });
});
