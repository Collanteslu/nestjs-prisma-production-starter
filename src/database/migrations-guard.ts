import { createHash } from "node:crypto";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import type { PrismaService } from "./prisma.service";

/**
 * Startup guard that compares the migration files in `prisma/migrations` with the rows
 * recorded in `_prisma_migrations`. An out-of-date database fails fast with an actionable
 * message instead of surfacing later as confusing runtime errors (e.g. "no such table" in
 * background jobs). Structural drift (schema vs. final migration state) is a separate
 * concern, checked in CI with `prisma migrate diff`.
 */

const MIGRATIONS_DIR = path.resolve(process.cwd(), "prisma", "migrations");

type MigrationRow = {
  migration_name: string;
  checksum: string;
  finished_at: number | bigint | null;
};

function sha256(content: Buffer): string {
  return createHash("sha256").update(content).digest("hex");
}

/** Same SQL regardless of CRLF/LF line endings */
function normalizeNewlines(content: Buffer): Buffer {
  return Buffer.from(content.toString("utf8").replace(/\r\n/g, "\n"));
}

/** Migration folder names on disk, in the order Prisma applies them. */
function localMigrationNames(): string[] {
  if (!existsSync(MIGRATIONS_DIR)) return [];
  return readdirSync(MIGRATIONS_DIR, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .sort();
}

/**
 * Verifies every migration shipped in `prisma/migrations` is recorded as applied in the
 * database with a matching SHA-256 checksum (the same value `prisma migrate deploy` stores).
 * @throws Error listing the pending, failed, modified or untracked migrations
 */
export async function assertMigrationsUpToDate(prisma: PrismaService): Promise<void> {
  const local = localMigrationNames();
  if (local.length === 0) {
    // Nothing to compare against (e.g. a packaging mistake): keep booting, like the reference.
    return;
  }

  let rows: MigrationRow[];
  try {
    rows = await prisma.$queryRaw<MigrationRow[]>`
      SELECT migration_name, checksum, finished_at FROM _prisma_migrations
    `;
  } catch {
    // Fresh database without any migration history: every migration is pending
    rows = [];
  }
  const applied = new Map(rows.map((row) => [row.migration_name, row]));

  const pending: string[] = [];
  const failed: string[] = [];
  const modified: string[] = [];
  for (const name of local) {
    const row = applied.get(name);
    if (!row) {
      pending.push(name);
      continue;
    }
    if (row.finished_at === null || row.finished_at === undefined) failed.push(name);
    const sqlPath = path.join(MIGRATIONS_DIR, name, "migration.sql");
    if (!existsSync(sqlPath)) continue;
    const content = readFileSync(sqlPath);
    if (row.checksum !== sha256(content)) {
      // git autocrlf checkout changes the bytes but not the SQL: warn instead of blocking boot
      if (row.checksum === sha256(normalizeNewlines(content))) {
        continue;
      }
      modified.push(name);
    }
  }
  const untracked = rows.map((row) => row.migration_name).filter((name) => !local.includes(name));

  if (
    pending.length === 0 &&
    failed.length === 0 &&
    modified.length === 0 &&
    untracked.length === 0
  ) {
    return;
  }

  const findings: string[] = [];
  if (pending.length > 0) {
    findings.push(`Pending: ${pending.join(", ")} — apply them with \`npx prisma migrate deploy\``);
  }
  if (failed.length > 0) {
    findings.push(
      `Failed (never completed): ${failed.join(", ")} — repair with \`npx prisma migrate resolve\``,
    );
  }
  if (modified.length > 0) {
    findings.push(
      `Modified after being applied: ${modified.join(", ")} — restore the original SQL or add a new migration; never edit an applied one`,
    );
  }
  if (untracked.length > 0) {
    findings.push(
      `Applied but absent from prisma/migrations: ${untracked.join(", ")} — the migration files were deleted or renamed`,
    );
  }
  throw new Error(
    `Migration history does not match prisma/migrations:\n  ${findings.join("\n  ")}`,
  );
}
