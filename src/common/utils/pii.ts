import { createHmac, hkdfSync } from "node:crypto";

/**
 * Pseudonyms for personal data in security-relevant storage and logs
 * (OWASP: minimize or pseudonymize personal data — an operational question like
 * "how many failed logins for this account?" is answered just as well by a derived value).
 *
 * The material is HKDF-SHA256(JWT_SECRET), so every instance that shares the signing
 * secret derives the same pseudonym: rate-limit buckets stay shared across replicas and
 * log lines correlate. Rotating JWT_SECRET rotates the pseudonyms as well (counters and
 * correlation history reset), which is acceptable for their short retention windows.
 */
const materialCache = new Map<string, Buffer>();

function keyMaterial(jwtSecret: string): Buffer {
  const cached = materialCache.get(jwtSecret);
  if (cached) return cached;
  const material = Buffer.from(hkdfSync("sha256", jwtSecret, "", "pii-pseudonym", 32));
  // One active signing secret in practice; keep the cache from growing unbounded
  if (materialCache.size > 4) materialCache.clear();
  materialCache.set(jwtSecret, material);
  return material;
}

/**
 * Stable pseudonym of an identifier. Values are trimmed and lowercased first, so
 * `Ana@Example.com` and `ana@example.com` produce the same pseudonym (identifiers are
 * case-insensitive in practice and bucket keys must not fork on case).
 */
export function pseudonym(jwtSecret: string, value: string): string {
  const normalized = value.trim().toLowerCase();
  return createHmac("sha256", keyMaterial(jwtSecret)).update(normalized).digest("hex").slice(0, 32);
}
