import { randomUUID } from "node:crypto";
import bcrypt from "bcryptjs";

/** Number of salt rounds for key derivation */
const SALT_ROUNDS = 12;

let dummyHash: Promise<string> | undefined;

/**
 * Returns a real bcrypt hash (same cost factor as stored passwords) of a random secret.
 * Compared against when a login email does not exist, so both paths take the same time.
 */
export function getDummyHash(): Promise<string> {
  dummyHash ??= hashPassword(randomUUID());
  return dummyHash;
}

/**
 * Hashes a plaintext password using bcrypt with an automatically generated salt.
 */
export async function hashPassword(plainPassword: string): Promise<string> {
  return bcrypt.hash(plainPassword, SALT_ROUNDS);
}

/**
 * Compares a plaintext password against a stored bcrypt hash in constant time
 * to prevent timing-attack vulnerabilities.
 */
export async function comparePassword(plainPassword: string, hash: string): Promise<boolean> {
  return bcrypt.compare(plainPassword, hash);
}
