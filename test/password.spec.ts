import bcrypt from "bcryptjs";
import {
  comparePassword,
  getDummyHash,
  hashPassword,
  needsRehash,
} from "../src/common/utils/password";

/**
 * Password storage (OWASP Password Storage Cheat Sheet): Argon2id for new hashes,
 * legacy bcrypt hashes keep verifying and are flagged for progressive rehash, unknown
 * formats fail closed, and the dummy hash used for unknown accounts matches the real
 * algorithm so the not-found path cannot be timed.
 */
describe("password storage (Argon2id + progressive rehash)", () => {
  it("hashes with Argon2id using the OWASP baseline parameters and verifies", async () => {
    const hash = await hashPassword("Correct-Horse-9!");
    expect(hash.startsWith("$argon2id$")).toBe(true);
    expect(hash).toContain("m=19456,t=2,p=1");

    await expect(comparePassword("Correct-Horse-9!", hash)).resolves.toBe(true);
    await expect(comparePassword("wrong-password", hash)).resolves.toBe(false);
  });

  it("still verifies legacy bcrypt hashes (existing installs keep working)", async () => {
    const legacy = await bcrypt.hash("Legacy-Pass-1!", 12);
    expect(legacy.startsWith("$2")).toBe(true);

    await expect(comparePassword("Legacy-Pass-1!", legacy)).resolves.toBe(true);
    await expect(comparePassword("nope", legacy)).resolves.toBe(false);
    expect(needsRehash(legacy)).toBe(true); // upgraded in place after the next login
  });

  it("flags fresh Argon2id hashes for no rehash", async () => {
    const hash = await hashPassword("Fresh-Pass-2!");
    expect(needsRehash(hash)).toBe(false);
  });

  it("fails closed on unknown or empty stored formats", async () => {
    await expect(comparePassword("anything", "not-a-hash")).resolves.toBe(false);
    await expect(comparePassword("anything", "")).resolves.toBe(false);
  });

  it("dummy hash for unknown accounts is real argon2id and never matches", async () => {
    const dummy = await getDummyHash();
    expect(dummy.startsWith("$argon2id$")).toBe(true);
    await expect(comparePassword("anything", dummy)).resolves.toBe(false);
    // cached: repeated logins for unknown emails reuse the same dummy work
    await expect(getDummyHash()).resolves.toBe(dummy);
  });
});
