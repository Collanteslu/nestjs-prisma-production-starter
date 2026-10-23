import { randomUUID } from "node:crypto";
import { hash, verify } from "@node-rs/argon2";
import bcrypt from "bcryptjs";

/**
 * OWASP Password Storage: Argon2id is the recommended algorithm. The parameters follow
 * the OWASP baseline (m = 19 MiB, t = 2, p = 1). `bcryptjs` remains only to verify
 * hashes from pre-Argon2id installs: they keep working and are upgraded IN PLACE after
 * the next successful login (progressive rehash — never a mass rewrite of stored hashes).
 *
 * Passwords are additionally capped at 72 bytes UTF-8 by the request schemas, which
 * keeps the legacy bcrypt path free of silent truncation as well.
 */
const ARGON2_OPTIONS = { memoryCost: 19_456, timeCost: 2, parallelism: 1 } as const;

let dummyHash: Promise<string> | undefined;

/**
 * Returns a real argon2id hash of a random secret. Compared against when a login email
 * does not exist, so both paths take the same time (and the format is the real one).
 */
export function getDummyHash(): Promise<string> {
  dummyHash ??= hashPassword(randomUUID());
  return dummyHash;
}

/** Hashes a plaintext password with Argon2id and a random salt */
export async function hashPassword(plainPassword: string): Promise<string> {
  return hash(plainPassword, ARGON2_OPTIONS);
}

/**
 * Compares a plaintext password against the stored hash in constant time. Dispatches on
 * the stored format; an unknown format fails closed (it must never authenticate).
 */
export async function comparePassword(plainPassword: string, stored: string): Promise<boolean> {
  if (stored.startsWith("$argon2")) return verify(stored, plainPassword);
  if (stored.startsWith("$2")) return bcrypt.compare(plainPassword, stored); // legacy
  return false;
}

/** True while the stored hash should be upgraded (legacy bcrypt or unknown format) */
export function needsRehash(stored: string): boolean {
  return !stored.startsWith("$argon2");
}
