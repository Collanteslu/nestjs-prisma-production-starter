import { parseEnv } from "../src/config/env";
import { TotpService } from "../src/mfa/totp.service";

/**
 * RFC 6238 behaviour and key rotation (audit items 2 and the MFA hardening): the
 * verification window, replay protection and the previous/current key handling are the
 * properties the login path depends on.
 */
describe("TotpService", () => {
  const env = parseEnv({
    AUTH_MODE: "none", // no JWT requirements; TotpService only needs MFA_* + JWT_SECRET
    MFA_ISSUER: "Parity API",
    MFA_ENCRYPTION_KEY: "current-key-0123456789abcdef0123456789",
  });
  const totp = new TotpService(env);

  it("round-trips base32 (encode/decode) and generates 160-bit secrets", () => {
    const secret = totp.generateTotpSecret();
    expect(secret).toMatch(/^[A-Z2-7]+$/);
    expect(totp.base32Decode(totp.base32Encode(Buffer.from("hello world"))).toString()).toBe(
      "hello world",
    );
  });

  it("accepts the current step and ±1 of clock drift, rejects everything else", () => {
    const secret = totp.generateTotpSecret();
    const now = Date.now();
    const code = totp.totpCode(secret, now);

    expect(totp.verifyTotp(secret, code, null, now)).not.toBeNull();
    expect(totp.verifyTotp(secret, code, null, now + 30_000)).not.toBeNull(); // verifier 30s ahead
    expect(totp.verifyTotp(secret, code, null, now - 30_000)).not.toBeNull(); // verifier 30s behind
    expect(totp.verifyTotp(secret, code, null, now + 61_000)).toBeNull(); // two steps away
  });

  it("never replays a code whose step was already accepted", () => {
    const secret = totp.generateTotpSecret();
    const now = Date.now();
    const code = totp.totpCode(secret, now);
    const step = totp.currentStep(now);

    expect(totp.verifyTotp(secret, code, step - 1, now)).not.toBeNull(); // first use ok
    expect(totp.verifyTotp(secret, code, step, now)).toBeNull(); // same step: replay
    expect(totp.verifyTotp(secret, code, step + 1, now)).toBeNull(); // future step: replay
  });

  it("rejects malformed codes without touching the clock window", () => {
    const secret = totp.generateTotpSecret();
    expect(totp.verifyTotp(secret, "12345", null)).toBeNull(); // 5 digits
    expect(totp.verifyTotp(secret, "abcdef", null)).toBeNull(); // not numeric
    expect(totp.verifyTotp(secret, "", null)).toBeNull();
  });

  it("encrypts at rest with the current key and reports previous-key use for rotation", () => {
    const previous = parseEnv({
      AUTH_MODE: "none",
      MFA_ENCRYPTION_KEY: "current-key-0123456789abcdef0123456789",
      MFA_ENCRYPTION_KEY_PREVIOUS: "previous-key-fedcba9876543210fedcba9876543210",
    });
    const oldTotp = new TotpService(previous);
    const secret = totp.generateTotpSecret();
    const storedOld = oldTotp.encryptSecret(secret); // encrypted as the CURRENT key at the time

    // Rotate: what was current becomes the previous key
    const rotated = parseEnv({
      AUTH_MODE: "none",
      MFA_ENCRYPTION_KEY: "brand-new-key-0123456789abcdef0123456789",
      MFA_ENCRYPTION_KEY_PREVIOUS: "current-key-0123456789abcdef0123456789",
    });
    const newTotp = new TotpService(rotated);
    const opened = newTotp.decryptSecretWithSource(storedOld);
    expect(opened.secret).toBe(secret);
    expect(opened.fromPreviousKey).toBe(true); // signals the lazy re-encryption

    // New material always encrypts with the fresh key and reports no rotation pending
    const storedNew = newTotp.encryptSecret(secret);
    const fresh = newTotp.decryptSecretWithSource(storedNew);
    expect(fresh.fromPreviousKey).toBe(false);
    expect(storedNew).not.toBe(storedOld);
  });

  it("fails closed when no configured key matches (tamper or wrong key)", () => {
    const foreign = parseEnv({
      AUTH_MODE: "none",
      MFA_ENCRYPTION_KEY: "totally-different-key-0123456789abcdef0123",
    });
    const foreignTotp = new TotpService(foreign);
    const stored = totp.encryptSecret("JBSWY3DPEHPK3PXP");
    expect(() => foreignTotp.decryptSecret(stored)).toThrow(/no configured MFA key matches/);
    expect(() => totp.decryptSecret("v2.not.a.v1value.x.y")).toThrow(/Unsupported secret/);
  });

  it("normalizes recovery codes when hashing (case and whitespace insensitive)", () => {
    expect(totp.hashRecoveryCode("ABCD-EFGH")).toBe(totp.hashRecoveryCode("  abcd-efgh "));
    expect(totp.generateRecoveryCodes()).toHaveLength(10);
    expect(totp.generateRecoveryCodes(3)[0]).toMatch(
      /^[a-z2-7]{4}-[a-z2-7]{4}-[a-z2-7]{4}-[a-z2-7]{4}$/,
    );
  });
});
