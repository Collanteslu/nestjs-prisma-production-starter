#!/usr/bin/env node
/**
 * Computes the rate-limit/lockout bucket key for an account, so support can find (and
 * clear) a lockout row — bucket keys store a PSEUDONYM of the address by design
 * (src/common/utils/pii.ts), and an HMAC cannot be inverted.
 *
 * Usage:
 *   JWT_SECRET=... node scripts/lockout-key.mjs ana@example.com
 *   node --env-file=.env scripts/lockout-key.mjs ana@example.com
 *
 * Prints the full RateLimitBucket key plus ready-to-run SQL. Runbook (AGENTS.md):
 *   SELECT count, resetAt FROM RateLimitBucket WHERE key = '<key>';
 *   DELETE FROM RateLimitBucket WHERE key = '<key>';   -- unlocks the account
 */
import { createHmac, hkdfSync } from "node:crypto";

const email = process.argv[2];
if (!email) {
  console.error("Uso: node scripts/lockout-key.mjs <email>");
  process.exit(2);
}
const secret = process.env.JWT_SECRET;
if (!secret) {
  console.error(
    "Falta JWT_SECRET (usa node --env-file=.env o expórtalo): el pseudónimo depende de la misma clave que la app.",
  );
  process.exit(2);
}

// Misma derivación que src/common/utils/pii.ts — cambia ahí y cámbiala aquí (cubierta por test)
const material = Buffer.from(hkdfSync("sha256", secret, "", "pii-pseudonym", 32));
const key = createHmac("sha256", material)
  .update(email.trim().toLowerCase())
  .digest("hex")
  .slice(0, 32);

console.log(`cuenta : ${email.trim().toLowerCase()}`);
console.log(`bucket : lockout:${key}`);
console.log("");
console.log(`SELECT count, resetAt FROM RateLimitBucket WHERE key = 'lockout:${key}';`);
console.log(`DELETE FROM RateLimitBucket WHERE key = 'lockout:${key}';`);
