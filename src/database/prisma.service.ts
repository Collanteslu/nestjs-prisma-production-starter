import path from "node:path";
import { Inject, Injectable, Logger } from "@nestjs/common";
import type { OnApplicationShutdown, OnModuleInit } from "@nestjs/common";
import { PrismaLibSql } from "@prisma/adapter-libsql";
import { PrismaClient } from "../generated/client/client";
import type { Env } from "../config/env";
import { APP_ENV } from "../config/tokens";

/** Resolves the effective database URL, prioritizing Turso over the local SQLite file. */
export function resolveDatabaseUrl(env: Env): string {
  if (env.TURSO_DATABASE_URL) {
    return env.TURSO_DATABASE_URL;
  }
  if (env.DATABASE_URL) {
    // If DATABASE_URL starts with file:, normalize path if relative
    if (env.DATABASE_URL.startsWith("file:")) {
      const rawPath = env.DATABASE_URL.replace(/^file:/, "");
      const resolvedPath = path.isAbsolute(rawPath)
        ? rawPath
        : path.resolve(process.cwd(), rawPath);
      return `file:${resolvedPath}`;
    }
    return env.DATABASE_URL;
  }
  return `file:${path.resolve(process.cwd(), "dev.db")}`;
}

/**
 * Prisma 7 client (libsql driver adapter) with the reference's production defaults:
 * - passwords, TOTP secrets and the last accepted TOTP step are omitted from every query
 *   (opt in explicitly, e.g. `omit: { password: false }`);
 * - the adapter waits up to 5s for the single SQLite writer instead of failing with
 *   SQLITE_BUSY under concurrency.
 */
@Injectable()
export class PrismaService extends PrismaClient implements OnModuleInit, OnApplicationShutdown {
  private readonly logger = new Logger(PrismaService.name);
  readonly databaseUrl: string;

  constructor(@Inject(APP_ENV) env: Env) {
    const databaseUrl = resolveDatabaseUrl(env);
    const adapter = new PrismaLibSql({
      url: databaseUrl,
      authToken: env.TURSO_AUTH_TOKEN,
      // Wait for the single SQLite writer instead of failing with SQLITE_BUSY under concurrency (ms, local files only)
      timeout: 5000,
    });
    super({
      adapter,
      omit: { user: { password: true, totpSecret: true, totpLastStep: true } },
    });
    this.databaseUrl = databaseUrl;
    if (env.TURSO_DATABASE_URL && env.DATABASE_URL) {
      Logger.warn(
        "TURSO_DATABASE_URL and DATABASE_URL are both set: TURSO_DATABASE_URL takes precedence, DATABASE_URL is ignored",
        PrismaService.name,
      );
    }
  }

  async onModuleInit(): Promise<void> {
    await this.$connect();
  }

  async onApplicationShutdown(): Promise<void> {
    await this.$disconnect();
  }

  /**
   * Switches a local SQLite file to WAL journaling (readers never block behind the single
   * writer) with synchronous=NORMAL, the safe and fast pairing for WAL. Never applied to
   * remote databases.
   *
   * `PRAGMA foreign_keys` is already ON on this adapter's connections (verified empirically
   * in the reference implementation), so the schema's onDelete: Cascade / SetNull relations
   * do fire and dependents never need manual deletes.
   */
  async applySqlitePragmas(): Promise<void> {
    if (!this.databaseUrl.startsWith("file:")) return;
    const [{ journal_mode: journalMode }] = await this.$queryRawUnsafe<{ journal_mode: string }[]>(
      "PRAGMA journal_mode=WAL;",
    );
    await this.$queryRawUnsafe("PRAGMA synchronous=NORMAL;");
    this.logger.log(`SQLite pragmas applied at startup (journalMode=${journalMode})`);
  }
}
