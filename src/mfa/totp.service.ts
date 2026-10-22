import { Inject, Injectable } from "@nestjs/common";
import {
  createCipheriv,
  createDecipheriv,
  createHash,
  createHmac,
  hkdfSync,
  randomBytes,
  timingSafeEqual,
} from "node:crypto";
import type { Env } from "../config/env";
import { APP_ENV } from "../config/tokens";

const STEP_SECONDS = 30;
const DIGITS = 6;
const BASE32 = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";

/**
 * RFC 6238 time-based one-time passwords (HMAC-SHA1, 6 digits, 30 s steps) and
 * AES-256-GCM encryption of the shared secret at rest (port of lib/totp.ts).
 * No third-party code; the issuer and the key material come from the injected env.
 */
@Injectable()
export class TotpService {
  constructor(@Inject(APP_ENV) private readonly env: Env) {}

  base32Encode(buf: Buffer): string {
    let bits = 0;
    let value = 0;
    let out = "";
    for (const byte of buf) {
      value = (value << 8) | byte;
      bits += 8;
      while (bits >= 5) {
        out += BASE32[(value >>> (bits - 5)) & 31];
        bits -= 5;
      }
    }
    if (bits > 0) out += BASE32[(value << (5 - bits)) & 31];
    return out;
  }

  base32Decode(input: string): Buffer {
    let bits = 0;
    let value = 0;
    const bytes: number[] = [];
    for (const char of input.replace(/=+$/, "").toUpperCase()) {
      const index = BASE32.indexOf(char);
      if (index === -1) throw new Error("Invalid base32 character");
      value = (value << 5) | index;
      bits += 5;
      if (bits >= 8) {
        bytes.push((value >>> (bits - 8)) & 255);
        bits -= 8;
      }
    }
    return Buffer.from(bytes);
  }

  /** New random 160-bit secret, base32 encoded (what authenticator apps expect) */
  generateTotpSecret(): string {
    return this.base32Encode(randomBytes(20));
  }

  /** HOTP for a given counter (RFC 4226) */
  private hotp(secret: Buffer, counter: number): string {
    const msg = Buffer.alloc(8);
    msg.writeBigUInt64BE(BigInt(counter));
    const hmac = createHmac("sha1", secret).update(msg).digest();
    const offset = (hmac[hmac.length - 1] ?? 0) & 0xf;
    const code =
      (((hmac[offset] ?? 0) & 0x7f) << 24) |
      (((hmac[offset + 1] ?? 0) & 0xff) << 16) |
      (((hmac[offset + 2] ?? 0) & 0xff) << 8) |
      ((hmac[offset + 3] ?? 0) & 0xff);
    return (code % 10 ** DIGITS).toString().padStart(DIGITS, "0");
  }

  currentStep(nowMs: number = Date.now()): number {
    return Math.floor(nowMs / 1000 / STEP_SECONDS);
  }

  /** Code for a given time (exposed for tests and tooling) */
  totpCode(secretBase32: string, nowMs: number = Date.now()): string {
    return this.hotp(this.base32Decode(secretBase32), this.currentStep(nowMs));
  }

  /**
   * Checks a code allowing ±1 step of clock drift.
   * @param lastStep Last step already accepted for this user: that step and older ones are rejected
   *                 so a code (or an older one) can never be replayed.
   * @returns The matched step, or null when the code is wrong or replayed
   */
  verifyTotp(
    secretBase32: string,
    code: string,
    lastStep: number | null,
    nowMs: number = Date.now(),
  ): number | null {
    if (!/^\d{6}$/.test(code)) return null;
    const secret = this.base32Decode(secretBase32);
    const now = this.currentStep(nowMs);
    let matched: number | null = null;
    for (const step of [now - 1, now, now + 1]) {
      // No early return: every candidate is compared so timing does not leak which one matched
      const expected = Buffer.from(this.hotp(secret, step));
      if (
        timingSafeEqual(expected, Buffer.from(code)) &&
        (lastStep === null || step > lastStep)
      ) {
        matched = step;
      }
    }
    return matched;
  }

  /** otpauth:// URI that authenticator apps (and QR generators) understand */
  otpauthUrl(secretBase32: string, account: string): string {
    const issuer = encodeURIComponent(this.env.MFA_ISSUER);
    return `otpauth://totp/${issuer}:${encodeURIComponent(account)}?secret=${secretBase32}&issuer=${issuer}&algorithm=SHA1&digits=${DIGITS}&period=${STEP_SECONDS}`;
  }

  // --- Secret encryption at rest -----------------------------------------------------------

  private encryptionKey(): Buffer {
    const material = this.env.MFA_ENCRYPTION_KEY ?? this.env.JWT_SECRET;
    return Buffer.from(hkdfSync("sha256", material, "", "mfa-secret-encryption", 32));
  }

  /** Encrypts a secret as `v1.<iv>.<tag>.<ciphertext>` (base64url) */
  encryptSecret(plain: string): string {
    const iv = randomBytes(12);
    const cipher = createCipheriv("aes-256-gcm", this.encryptionKey(), iv);
    const data = Buffer.concat([cipher.update(plain, "utf8"), cipher.final()]);
    return ["v1", iv, cipher.getAuthTag(), data]
      .map((p) => (typeof p === "string" ? p : p.toString("base64url")))
      .join(".");
  }

  decryptSecret(stored: string): string {
    const [version, iv, tag, data] = stored.split(".");
    if (version !== "v1" || !iv || !tag || !data) throw new Error("Unsupported secret format");
    const decipher = createDecipheriv(
      "aes-256-gcm",
      this.encryptionKey(),
      Buffer.from(iv, "base64url"),
    );
    decipher.setAuthTag(Buffer.from(tag, "base64url"));
    return Buffer.concat([
      decipher.update(Buffer.from(data, "base64url")),
      decipher.final(),
    ]).toString("utf8");
  }

  // --- Recovery codes -----------------------------------------------------------------------

  /** 10 one-time codes like `abcd-efgh-ijkl-mnop`: 16 base32 characters, 80 random bits each */
  generateRecoveryCodes(count = 10): string[] {
    return Array.from({ length: count }, () => {
      const raw = this.base32Encode(randomBytes(10)).toLowerCase();
      return [0, 4, 8, 12].map((i) => raw.slice(i, i + 4)).join("-");
    });
  }

  hashRecoveryCode(code: string): string {
    return createHash("sha256").update(code.trim().toLowerCase()).digest("hex");
  }
}
