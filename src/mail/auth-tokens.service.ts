import { Injectable } from "@nestjs/common";
import { randomBytes } from "node:crypto";
import { hashToken } from "../common/utils/hash-token";
import { PrismaService } from "../database/prisma.service";

export type AuthTokenType = "password_reset" | "email_verify";

/**
 * Single-use emailed tokens (password reset, email verification). Only the SHA-256 of a
 * token is stored; claiming one is a single atomic statement, so it works exactly once.
 * Each token is bound to the address it was emailed to and stops working if the account's
 * email changes; changing the email or the password also deletes every pending token.
 */
@Injectable()
export class AuthTokensService {
  constructor(private readonly prisma: PrismaService) {}

  /**
   * Issues a new token for a user, invalidating any earlier unused token of the same type.
   * @returns The raw token (shown only once, to be emailed)
   */
  async createAuthToken(
    user: { id: string; email: string },
    type: AuthTokenType,
    ttlMs: number,
  ): Promise<string> {
    const token = randomBytes(32).toString("base64url");
    await this.prisma.$transaction([
      this.prisma.authToken.deleteMany({ where: { userId: user.id, type, usedAt: null } }),
      this.prisma.authToken.create({
        data: {
          userId: user.id,
          type,
          email: user.email,
          tokenHash: hashToken(token),
          expiresAt: new Date(Date.now() + ttlMs),
        },
      }),
    ]);
    return token;
  }

  /**
   * Atomically claims a token. @returns The owner's id, or null if the token is unknown, of
   * another type, expired, already used, or was emailed to an address the account no longer has.
   */
  async consumeAuthToken(token: string, type: AuthTokenType): Promise<string | null> {
    const tokenHash = hashToken(token);
    const claimed = await this.prisma.authToken.updateMany({
      where: { tokenHash, type, usedAt: null, expiresAt: { gt: new Date() } },
      data: { usedAt: new Date() },
    });
    if (claimed.count !== 1) return null;
    const row = await this.prisma.authToken.findUnique({
      where: { tokenHash },
      select: { userId: true, email: true, user: { select: { email: true } } },
    });
    // A token sent to a previous address must not act on (or verify) the current one
    if (!row || row.email !== row.user.email) return null;
    return row.userId;
  }

  /**
   * Deletes every pending (unused) emailed token of a user. Meant to run inside the same
   * transaction as an email or password change, so no earlier link survives it.
   */
  deletePendingAuthTokensOp(userId: string) {
    return this.prisma.authToken.deleteMany({ where: { userId, usedAt: null } });
  }
}
