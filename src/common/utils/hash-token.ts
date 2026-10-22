import { createHash } from "node:crypto";

/** SHA-256 digest used to look up emailed tokens and refresh tokens without plaintext */
export function hashToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}
