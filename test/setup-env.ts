import os from "node:os";
import path from "node:path";

/**
 * Test-time environment (loaded by Jest's setupFiles BEFORE any module evaluates).
 *
 * NODE_ENV, AUTH_MODE and the secrets use `??=`: an exported value is a legitimate
 * override, and the placeholders satisfy the production-hardening length checks.
 *
 * Everything that decides WHERE data is written or mails are sent is forced, never
 * inherited. The suite migrates the database, registers users and sends emails, so a
 * developer shell with DATABASE_URL / TURSO_DATABASE_URL (Turso takes precedence!) /
 * SMTP_URL exported would otherwise run the tests against a real database or mailbox.
 */
process.env.NODE_ENV ??= "test";
process.env.AUTH_MODE ??= "full";
process.env.JWT_SECRET ??= "test-jwt-secret-0123456789abcdef0123456789";
process.env.JWT_REFRESH_SECRET ??= "test-refresh-secret-abcdef0123456789abcdef01";
process.env.DATABASE_URL = `file:${path.join(os.tmpdir(), "nestjs-plantilla-test.db")}`;
process.env.TURSO_DATABASE_URL = "";
process.env.TURSO_AUTH_TOKEN = "";
process.env.MAIL_TRANSPORT = "log";
process.env.SMTP_URL = "";
