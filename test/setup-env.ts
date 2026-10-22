import os from "node:os";
import path from "node:path";

/**
 * Test-time environment (loaded by Jest's setupFiles BEFORE any module evaluates).
 * `??=` keeps CLI/exported overrides effective; secrets are test-only placeholders
 * that satisfy the production-hardening length checks.
 */
process.env.NODE_ENV ??= "test";
process.env.AUTH_MODE ??= "full";
process.env.JWT_SECRET ??= "test-jwt-secret-0123456789abcdef0123456789";
process.env.JWT_REFRESH_SECRET ??= "test-refresh-secret-abcdef0123456789abcdef01";
process.env.DATABASE_URL ??= `file:${path.join(os.tmpdir(), "nestjs-plantilla-test.db")}`;
